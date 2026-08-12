import { loadConfiguration } from "./storage.js";
import { state } from "./state.js";
import { reloadTab } from "./tabs.js";
import { withTimeout } from "./timeouts.js";
import type { Configuration } from "./types.js";

const PENDING_REINSTALL_TOKEN_KEY = "pendingReinstallToken";

let configurationPromise: Promise<Configuration> | null = null;
let offscreenPromise: Promise<void> | null = null;

export async function getConfiguration(): Promise<Configuration> {
  if (!configurationPromise) {
    configurationPromise = loadConfiguration().catch((error) => {
      configurationPromise = null;
      throw error;
    });
    return configurationPromise;
  }

  await configurationPromise;
  return loadConfiguration();
}

export function instructionApiUrl(configuration: Configuration): string {
  const baseUrl = configuration.baseUrl.replace(/\/+$/, "");
  return `${baseUrl}/api/browsers/${configuration.bid}/instructions`;
}

export async function reportSettings(
  configuration: Configuration,
): Promise<void> {
  const baseUrl = configuration.baseUrl.replace(/\/+$/, "");
  const { bid: _bid, ...settings } = configuration;
  const response = await fetch(
    `${baseUrl}/api/browsers/${configuration.bid}/heartbeat/`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ settings }),
      signal: AbortSignal.timeout(configuration.httpRequestTimeoutMs),
    },
  );
  if (!response.ok) {
    throw new Error(`Could not report browser settings: HTTP ${response.status}`);
  }
}

function reinstallUrl(configuration: Configuration): string {
  const baseUrl = configuration.baseUrl.replace(/\/+$/, "");
  return `${baseUrl}/api/browsers/${configuration.bid}/reinstall`;
}

export async function acknowledgePendingReinstall(
  configuration: Configuration,
): Promise<void> {
  const stored = await chrome.storage.local.get<
    Record<typeof PENDING_REINSTALL_TOKEN_KEY, unknown>
  >(PENDING_REINSTALL_TOKEN_KEY);
  const pendingToken = stored[PENDING_REINSTALL_TOKEN_KEY];
  if (typeof pendingToken !== "string") {
    return;
  }

  const reinstallBaseUrl = reinstallUrl(configuration);
  const acknowledgement = await fetch(`${reinstallBaseUrl}/acknowledge/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: pendingToken }),
    signal: AbortSignal.timeout(configuration.httpRequestTimeoutMs),
  });
  if (!acknowledgement.ok && acknowledgement.status !== 409) {
    throw new Error(
      `Could not acknowledge extension reinstall: HTTP ${acknowledgement.status}`,
    );
  }
  await chrome.storage.local.remove(PENDING_REINSTALL_TOKEN_KEY);
}

export async function executeReinstallCommand(
  configuration: Configuration,
  token: string,
): Promise<void> {
  await chrome.storage.local.set({
    [PENDING_REINSTALL_TOKEN_KEY]: token,
  });
  state.reinstallScheduled = true;
  await stopActiveJavaScriptExecutions(configuration);
  chrome.runtime.reload();
}

export async function stopActiveJavaScriptExecutions(
  configuration: Configuration,
): Promise<void> {
  const executions = [...state.activeJavaScriptExecutions];
  await Promise.allSettled(
    executions.map((execution) =>
      withTimeout(
        execution.stop(),
        5000,
        `Timed out stopping JavaScript in tab ${execution.tid}`,
      ),
    ),
  );
  await Promise.allSettled(
    [...new Set(executions.map((execution) => execution.tid))].map(
      async (tid) => {
        await reloadTab(tid, configuration.tabLoadTimeoutMs);
      },
    ),
  );
  await Promise.allSettled(
    executions.map((execution) =>
      withTimeout(
        execution.finished,
        5000,
        `Timed out finalizing JavaScript in tab ${execution.tid}`,
      ),
    ),
  );
}

export function ensureOffscreenDocument(recreate = false): Promise<void> {
  const previous = offscreenPromise ?? Promise.resolve();
  const operation = previous
    .catch(() => undefined)
    .then(() => configureOffscreenDocument(recreate));
  const tracked = operation.finally(() => {
    if (offscreenPromise === tracked) {
      offscreenPromise = null;
    }
  });
  offscreenPromise = tracked;
  return tracked;
}

async function configureOffscreenDocument(recreate: boolean): Promise<void> {
  const documentUrl = chrome.runtime.getURL("offscreen.html");
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [documentUrl],
  });

  if (recreate && contexts.length > 0) {
    await chrome.offscreen.closeDocument();
  }
  if (recreate || contexts.length === 0) {
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["WORKERS", "USER_MEDIA"],
      justification:
        "Poll the ACOB server for browser instructions and encode tab recordings",
    });
  }
}
