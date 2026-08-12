import {
  handleFinalizeRecording,
  handleRecordingFrame,
  startRecordingSink,
} from "./recording.js";
import { ACOBSettings } from "./settings.js";
import { isRuntimeMessage } from "./types.js";
import type {
  GetConfigurationMessage,
  GetConfigurationResponse,
  PollMessage,
  PollResponse,
} from "./types.js";

let pollIntervalMs = ACOBSettings.definitions.pollIntervalMs.defaultValue;
let pollTimeoutId: number | undefined;

function schedulePoll(): void {
  if (pollTimeoutId !== undefined) {
    window.clearTimeout(pollTimeoutId);
  }
  pollTimeoutId = window.setTimeout(requestInstructions, pollIntervalMs);
}

async function requestInstructions(): Promise<void> {
  try {
    const configuration = await chrome.runtime.sendMessage<
      GetConfigurationMessage,
      GetConfigurationResponse
    >({ type: "getConfiguration" });
    if ("error" in configuration) {
      throw new Error(configuration.error);
    }
    pollIntervalMs = configuration.pollIntervalMs;
  } catch (error) {
    console.error(error);
  }
  chrome.runtime
    .sendMessage<PollMessage, PollResponse>({ type: "poll" })
    .catch(console.error);
  schedulePoll();
}

chrome.runtime.onMessage.addListener(
  (message: unknown, _sender, sendResponse) => {
    if (!isRuntimeMessage(message)) {
      return;
    }
    if (message.type === "settingsUpdated") {
      pollIntervalMs = ACOBSettings.normalizeSetting(
        "pollIntervalMs",
        message.pollIntervalMs,
      );
      schedulePoll();
      return;
    }
    if (message.type === "startRecording") {
      startRecordingSink(message)
        .then(
          () => sendResponse({ ok: true, started: true }),
          (error: unknown) => sendResponse({ error: errorMessage(error) }),
        );
      return true;
    }
    if (message.type === "recordingFrame") {
      handleRecordingFrame(message).then(
        () => sendResponse({ ok: true }),
        () => sendResponse({ ok: true }),
      );
      return true;
    }
    if (message.type === "finalizeRecording") {
      handleFinalizeRecording(message).then(
        ({ data, contentType }) =>
          sendResponse({ ok: true, data, contentType }),
        (error: unknown) => sendResponse({ error: errorMessage(error) }),
      );
      return true;
    }
  },
);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

requestInstructions();
