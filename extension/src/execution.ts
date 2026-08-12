import {
  executeClick,
  executeJavaScript,
  executeKeyboard,
  executeScreenshot,
  executeScroll,
} from "./actions.js";
import { instructionApiUrl } from "./lifecycle.js";
import { state } from "./state.js";
import {
  createTabWithinLimit,
  reloadTab,
  tabDetails,
  waitForTab,
} from "./tabs.js";
import { isSupportedInstruction } from "./validation.js";
import type {
  ClaimedInstruction,
  Configuration,
  ExtensionInstructionResult,
  InstructionResultRequest,
  SupportedInstruction,
} from "./types.js";

function runInTabExecutionQueue<Result>(
  tid: number,
  operation: () => Promise<Result>,
): Promise<Result> {
  const previous = state.tabExecutionQueues.get(tid) ?? Promise.resolve();
  const result = previous.then(operation);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  state.tabExecutionQueues.set(tid, tail);
  void tail.then(() => {
    if (state.tabExecutionQueues.get(tid) === tail) {
      state.tabExecutionQueues.delete(tid);
    }
  });
  return result;
}

async function runInstructionAction(
  instruction: SupportedInstruction,
  configuration: Configuration,
): Promise<ExtensionInstructionResult> {
  const { action, payload } = instruction;

  if (action === "list") {
    const [tabs, windows] = await Promise.all([
      chrome.tabs.query({}),
      chrome.windows.getAll(),
    ]);
    const focusedWindowIds = new Set(
      windows.filter((window) => window.focused).map((window) => window.id),
    );
    return tabs.map((tab) => ({
      ...tabDetails(tab),
      focused: tab.active && focusedWindowIds.has(tab.windowId),
    }));
  }

  if (action === "close") {
    const tab = await chrome.tabs.get(payload.tid);
    const details = tabDetails(tab);
    await chrome.tabs.remove(details.tid);
    return { closed: true, tab: details };
  }

  if (action === "focus") {
    const tab = await chrome.tabs.get(payload.tid);
    await chrome.windows.update(tab.windowId, { focused: true });
    const focusedTab = await chrome.tabs.update(payload.tid, { active: true });
    if (!focusedTab) {
      throw new Error(`Chromium did not return focused tab ${payload.tid}`);
    }
    return tabDetails(focusedTab);
  }

  if (action === "navigate") {
    const navigatedTab = payload.tid !== undefined
      ? await chrome.tabs.update(payload.tid, { url: payload.url })
      : await createTabWithinLimit(payload.url, configuration.maxTabs);
    if (!navigatedTab) {
      throw new Error("Chromium did not return the navigated tab");
    }
    const navigatedTabDetails = tabDetails(navigatedTab);
    const loadedTab = await waitForTab(
      navigatedTabDetails.tid,
      configuration.tabLoadTimeoutMs,
    );
    return tabDetails(loadedTab);
  }

  if (action === "reload") {
    await chrome.tabs.get(payload.tid);
    const loadedTab = await reloadTab(
      payload.tid,
      configuration.tabLoadTimeoutMs,
    );
    return tabDetails(loadedTab);
  }

  if (action === "scroll") {
    await chrome.tabs.get(payload.tid);
    return executeScroll(payload.tid, payload.y, configuration);
  }

  if (action === "javascript") {
    await chrome.tabs.get(payload.tid);
    return executeJavaScript(payload.tid, payload.script, configuration);
  }

  if (action === "click") {
    await chrome.tabs.get(payload.tid);
    return executeClick(payload.tid, payload.selector, configuration);
  }

  if (action === "keyboard") {
    await chrome.tabs.get(payload.tid);
    return executeKeyboard(payload.tid, payload, configuration);
  }

  if (action === "screenshot") {
    await chrome.tabs.get(payload.tid);
    return executeScreenshot(
      payload.tid,
      payload.full_page ?? false,
      configuration,
    );
  }

  throw new Error(`Unknown action: ${action}`);
}

function runInstruction(
  instruction: SupportedInstruction,
  configuration: Configuration,
): Promise<ExtensionInstructionResult> {
  const { payload } = instruction;
  const tid = "tid" in payload ? payload.tid : undefined;
  const operation = () => runInstructionAction(instruction, configuration);
  return tid === undefined
    ? operation()
    : runInTabExecutionQueue(tid, operation);
}

export async function sendResult(
  instructionId: number,
  body: InstructionResultRequest,
  configuration: Configuration,
): Promise<void> {
  const apiUrl = instructionApiUrl(configuration);
  for (
    let attempt = 1;
    attempt <= configuration.resultRetryAttempts;
    attempt += 1
  ) {
    if (state.reinstallScheduled) {
      return;
    }
    try {
      const response = await fetch(`${apiUrl}/${instructionId}/result/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(configuration.httpRequestTimeoutMs),
      });

      if (response.ok) {
        return;
      }
      if (attempt === configuration.resultRetryAttempts) {
        throw new Error(`Could not submit result: HTTP ${response.status}`);
      }
    } catch (error) {
      if (attempt === configuration.resultRetryAttempts) {
        throw error;
      }
    }

    await new Promise((resolve) =>
      setTimeout(resolve, configuration.resultRetryDelayMs),
    );
  }
}

export async function executeInstruction(
  instruction: ClaimedInstruction,
  configuration: Configuration,
): Promise<void> {
  if (state.reinstallScheduled) {
    return;
  }
  let body: InstructionResultRequest;
  try {
    if (!isSupportedInstruction(instruction)) {
      throw new Error(
        `Unsupported or invalid instruction: ${instruction.action}`,
      );
    }
    const result = await runInstruction(instruction, configuration);
    body = { result };
  } catch (error) {
    body = {
      error: error instanceof Error ? error.message : String(error),
    };
  }
  if (state.reinstallScheduled) {
    return;
  }
  await sendResult(instruction.id, body, configuration);
}
