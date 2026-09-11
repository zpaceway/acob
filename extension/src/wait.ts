import { sendCdpCommand, withDebugger } from "./cdp.js";
import { state } from "./state.js";
import type { Configuration, WaitResult } from "./types.js";

export const WAIT_POLL_INTERVAL_MS = 200;
export const MAX_WAIT_TIMEOUT_MS = 90_000;

function isInvalidSelectorError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  // Chromium reports selector syntax problems from DOM.querySelector as
  // "DOM Error while querying" (e.g. {"code":-32000,"message":"DOM Error
  // while querying"}), raised after DOM.getDocument succeeded, so the
  // document exists and a retry would not help.
  return /not a valid selector|invalid selector|syntax|DOMException|DOM Error while querying/i.test(
    message,
  );
}

function isMissingTabError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no tab with id|tab.*(closed|not found|does not exist)|cannot find.*tab/i.test(
    message,
  );
}

async function selectorExists(
  tid: number,
  selector: string,
  debuggerProtocolVersion: string,
): Promise<boolean> {
  return withDebugger(tid, debuggerProtocolVersion, async (target) => {
    const { root } = await sendCdpCommand(target, "DOM.getDocument", {
      depth: 0,
    });
    const { nodeId } = await sendCdpCommand(target, "DOM.querySelector", {
      nodeId: root.nodeId,
      selector,
    });
    return Boolean(nodeId);
  });
}

export async function executeWait(
  tid: number,
  selector: string,
  timeoutMs: number | undefined,
  configuration: Configuration,
): Promise<WaitResult> {
  if (state.reinstallScheduled) {
    throw new Error("Extension reinstall is in progress");
  }
  const effectiveTimeoutMs = timeoutMs ?? configuration.waitTimeoutMs;
  if (
    !Number.isSafeInteger(effectiveTimeoutMs) ||
    effectiveTimeoutMs < 1 ||
    effectiveTimeoutMs > MAX_WAIT_TIMEOUT_MS
  ) {
    throw new Error(
      `Invalid wait timeout: ${String(effectiveTimeoutMs)}; must be 1-${MAX_WAIT_TIMEOUT_MS} ms`,
    );
  }
  const deadline = Date.now() + effectiveTimeoutMs;
  // Keep the service worker alive across navigations and long polls.
  const keepAlive = setInterval(() => undefined, 20_000);
  try {
    try {
      await chrome.tabs.get(tid);
    } catch {
      throw new Error(`Wait for tab ${tid} failed: the tab may be closed`);
    }
    for (;;) {
      if (state.reinstallScheduled) {
        throw new Error("Extension reinstall is in progress");
      }
      try {
        if (
          await selectorExists(
            tid,
            selector,
            configuration.debuggerProtocolVersion,
          )
        ) {
          return { waited: true, selector };
        }
      } catch (error) {
        if (isMissingTabError(error)) {
          throw new Error(
            `Wait for tab ${tid} failed: the tab may be closed`,
          );
        }
        if (isInvalidSelectorError(error)) {
          throw new Error(`Invalid selector: ${selector}`);
        }
        // Transient debugger/document errors (navigation, loading, detach)
        // fall through to the deadline check and retry.
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(`Timed out waiting for selector: ${selector}`);
      }
      try {
        await chrome.tabs.get(tid);
      } catch {
        throw new Error(`Wait for tab ${tid} failed: the tab may be closed`);
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, Math.min(WAIT_POLL_INTERVAL_MS, remaining));
      });
    }
  } finally {
    clearInterval(keepAlive);
  }
}
