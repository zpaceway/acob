import {
  executeInstruction,
  sendResult,
} from "./execution.js";
import {
  acknowledgePendingReinstall,
  ensureOffscreenDocument,
  executeReinstallCommand,
  getConfiguration,
  nextInstructionsUrl,
} from "./lifecycle.js";
import { getOrCreateBid } from "./bid.js";
import { state } from "./state.js";
import { isRuntimeMessage } from "./types.js";
import {
  isClaimedInstruction,
  isReinstallCommand,
  reportError,
} from "./validation.js";

async function poll(): Promise<void> {
  if (state.pollInProgress || state.reinstallScheduled) {
    return;
  }

  const executions: Promise<void>[] = [];
  state.pollInProgress = true;
  try {
    const configuration = await getConfiguration();
    const bid = await getOrCreateBid();
    await acknowledgePendingReinstall(configuration);
    if (state.activeExecutions >= configuration.maxConcurrentExecutions) {
      return;
    }
    const availableExecutions =
      configuration.maxConcurrentExecutions - state.activeExecutions;
    const limit = Math.min(
      configuration.instructionsPerPoll,
      availableExecutions,
    );
    if (limit <= 0) {
      return;
    }
    const apiUrl = nextInstructionsUrl(configuration, bid, limit);
    const response = await fetch(apiUrl, {
      signal: AbortSignal.timeout(configuration.httpRequestTimeoutMs),
    });
    if (state.backendUnavailable) {
      console.info("ACOB server connected");
      state.backendUnavailable = false;
    }
    if (response.status === 204) {
      return;
    }
    if (!response.ok) {
      throw new Error(`Could not fetch instruction: HTTP ${response.status}`);
    }

    const instructions: unknown = await response.json();
    if (!Array.isArray(instructions)) {
      throw new Error("ACOB server returned an invalid instruction batch");
    }
    let scheduledExecutions = 0;
    for (const instruction of instructions) {
      if (isReinstallCommand(instruction)) {
        await executeReinstallCommand(
          configuration,
          instruction.payload.token,
        );
        return;
      }
      if (!isClaimedInstruction(instruction)) {
        reportError(new Error("ACOB server returned an invalid instruction"));
        continue;
      }
      if (
        instruction.bid !== undefined &&
        instruction.bid !== null &&
        instruction.bid !== bid
      ) {
        continue;
      }
      if (scheduledExecutions >= limit) {
        executions.push(
          sendResult(
            instruction.id,
            { error: "ACOB server returned more instructions than requested" },
            configuration,
            bid,
          ).catch(reportError),
        );
        continue;
      }
      scheduledExecutions += 1;
      state.activeExecutions++;
      executions.push(
        executeInstruction(instruction, configuration, bid)
          .catch(reportError)
          .finally(() => {
            state.activeExecutions--;
          }),
      );
    }
  } catch (error) {
    reportError(error);
  } finally {
    state.pollInProgress = false;
  }
  await Promise.allSettled(executions);
}

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (!isRuntimeMessage(message)) {
    return;
  }
  if (message.type === "poll") {
    poll().then(
      () => sendResponse({ ok: true }),
      (error) => {
        sendResponse({
          error: error instanceof Error ? error.message : String(error),
        });
      },
    );
    return true;
  }
  if (message.type === "recordingChunk") {
    const chunks = state.recordingChunks.get(message.tid) ?? [];
    chunks.push(message.data);
    state.recordingChunks.set(message.tid, chunks);
    sendResponse({ ok: true });
    return;
  }
  if (message.type === "getConfiguration") {
    getConfiguration().then(sendResponse, (error) => {
      sendResponse({
        error: error instanceof Error ? error.message : String(error),
      });
    });
    return true;
  }
});

chrome.runtime.onInstalled.addListener(() => {
  getOrCreateBid().catch(console.error);
  ensureOffscreenDocument().catch(console.error);
});
chrome.runtime.onStartup.addListener(() => {
  getOrCreateBid().catch(console.error);
  ensureOffscreenDocument().catch(console.error);
});
ensureOffscreenDocument(true).catch(console.error);
