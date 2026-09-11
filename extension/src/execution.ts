import {
  executeClick,
  executeJavaScript,
  executeKeyboard,
  executeRecordStart,
  executeRecordStop,
  executeScreenshot,
  executeScroll,
} from "./actions.js";
import { executeWait } from "./wait.js";
import {
  executeConsoleCapture,
  executeConsoleStart,
  executeConsoleStop,
} from "./console.js";
import { executeCleanup } from "./cleanup.js";
import {
  assertTabFocusedForInput,
  runInBrowserInputQueue,
} from "./input.js";
import { executeProxy } from "./proxy.js";
import { instructionResultUrl } from "./lifecycle.js";
import { state } from "./state.js";
import {
  createTabWithinLimit,
  focusTab,
  reloadTab,
  tabDetails,
  waitForTab,
} from "./tabs.js";
import { assertSupportedInstruction } from "./validation.js";
import type {
  Bid,
  ClaimedInstruction,
  Configuration,
  ExtensionInstructionResult,
  InstructionAction,
  InstructionResultRequest,
  SupportedInstruction,
} from "./types.js";

type NonBatchAction = Exclude<InstructionAction, "batch">;
interface ExecutionQueuesHeld {
  browserInput: boolean;
  tabs: boolean;
}

const noExecutionQueuesHeld: ExecutionQueuesHeld = {
  browserInput: false,
  tabs: false,
};

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

function runInTabExecutionQueues<Result>(
  tids: number[],
  operation: () => Promise<Result>,
): Promise<Result> {
  return [...new Set(tids)]
    .sort((left, right) => left - right)
    .reduceRight<() => Promise<Result>>(
      (next, tid) => () => runInTabExecutionQueue(tid, next),
      operation,
    )();
}

function runBrowserInputOperation<Result>(
  queueHeld: boolean,
  operation: () => Promise<Result>,
): Promise<Result> {
  return queueHeld ? operation() : runInBrowserInputQueue(operation);
}

async function runInstructionAction(
  instruction: SupportedInstruction,
  configuration: Configuration,
  queuesHeld: ExecutionQueuesHeld,
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
    return runBrowserInputOperation(queuesHeld.browserInput, async () =>
      tabDetails(await focusTab(payload.tid))
    );
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
    return runBrowserInputOperation(queuesHeld.browserInput, async () => {
      await assertTabFocusedForInput(payload.tid);
      return executeScroll(payload.tid, payload.y, configuration);
    });
  }

  if (action === "javascript") {
    await chrome.tabs.get(payload.tid);
    return executeJavaScript(payload.tid, payload.script, configuration);
  }

  if (action === "click") {
    return runBrowserInputOperation(queuesHeld.browserInput, async () => {
      await assertTabFocusedForInput(payload.tid);
      return executeClick(payload.tid, payload.selector, configuration);
    });
  }

  if (action === "wait") {
    await chrome.tabs.get(payload.tid);
    return executeWait(
      payload.tid,
      payload.selector,
      payload.timeout_ms ?? undefined,
      configuration,
    );
  }

  if (action === "keyboard") {
    return runBrowserInputOperation(queuesHeld.browserInput, async () => {
      await assertTabFocusedForInput(payload.tid);
      return executeKeyboard(payload.tid, payload, configuration);
    });
  }

  if (action === "screenshot") {
    await chrome.tabs.get(payload.tid);
    return executeScreenshot(
      payload.tid,
      payload.full_page ?? true,
      configuration,
    );
  }

  if (action === "proxy") {
    return executeProxy(payload, configuration);
  }

  if (action === "cleanup") {
    return executeCleanup(configuration);
  }

  if (action === "record") {
    if (payload.method === "start") {
      await chrome.tabs.get(payload.tid);
      return executeRecordStart(
        payload.tid,
        payload.full_page ?? false,
        configuration,
      );
    }
    await chrome.tabs.get(payload.tid);
    return executeRecordStop(payload.tid, configuration);
  }

  if (action === "console") {
    if (payload.method === "start") {
      await chrome.tabs.get(payload.tid);
      return executeConsoleStart(payload.tid, configuration);
    }
    if (payload.method === "capture") {
      await chrome.tabs.get(payload.tid);
      return executeConsoleCapture(payload.tid, configuration);
    }
    await chrome.tabs.get(payload.tid);
    return executeConsoleStop(payload.tid, configuration);
  }

  if (action === "batch") {
    const executeBatch = async (
      subActionQueuesHeld: ExecutionQueuesHeld,
    ): Promise<InstructionResultRequest[]> => {
      const entries: InstructionResultRequest[] = [];
      const keepAlive = setInterval(() => undefined, 20_000);
      try {
        for (const subAction of payload.actions) {
          if (state.reinstallScheduled) {
            entries.push({ error: "Extension reinstall is in progress" });
            continue;
          }
          const { action: subActionName, ...subPayload } = subAction;
          const subInstruction = {
            id: instruction.id,
            action: subActionName,
            payload: subPayload,
          } as SupportedInstruction<NonBatchAction>;
          try {
            entries.push({
              result: await runInstruction(
                subInstruction,
                configuration,
                subActionQueuesHeld,
              ),
            });
          } catch (error) {
            entries.push({
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      } finally {
        clearInterval(keepAlive);
      }
      return entries;
    };
    const holdsBrowserInput = payload.actions.some(({ action }) =>
      ["focus", "scroll", "click", "keyboard"].includes(action)
    );
    if (!holdsBrowserInput) {
      return executeBatch(noExecutionQueuesHeld);
    }
    const tids = payload.actions.flatMap((subAction) =>
      "tid" in subAction ? [subAction.tid] : []
    );
    return runInTabExecutionQueues(tids, () =>
      runInBrowserInputQueue(() =>
        executeBatch({ browserInput: true, tabs: true })
      )
    );
  }

  throw new Error(`Unknown action: ${action}`);
}

export function runInstruction(
  instruction: SupportedInstruction,
  configuration: Configuration,
  queuesHeld: ExecutionQueuesHeld = noExecutionQueuesHeld,
): Promise<ExtensionInstructionResult> {
  const { payload } = instruction;
  const tid = "tid" in payload ? payload.tid : undefined;
  const operation = () =>
    runInstructionAction(instruction, configuration, queuesHeld);
  return tid === undefined || queuesHeld.tabs
    ? operation()
    : runInTabExecutionQueue(tid, operation);
}

export async function sendResult(
  instructionId: number,
  body: InstructionResultRequest,
  configuration: Configuration,
  bid: Bid,
): Promise<void> {
  const resultUrl = instructionResultUrl(configuration, instructionId);
  for (
    let attempt = 1;
    attempt <= configuration.resultRetryAttempts;
    attempt += 1
  ) {
    if (state.reinstallScheduled) {
      return;
    }
    try {
      const response = await fetch(resultUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, bid }),
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
  bid: Bid,
): Promise<void> {
  if (state.reinstallScheduled) {
    return;
  }
  if (
    instruction.bid !== undefined &&
    instruction.bid !== null &&
    instruction.bid !== bid
  ) {
    return;
  }
  let body: InstructionResultRequest;
  try {
    assertSupportedInstruction(instruction);
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
  await sendResult(instruction.id, body, configuration, bid);
}
