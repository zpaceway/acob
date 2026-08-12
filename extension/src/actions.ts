import type { Protocol } from "devtools-protocol";

import { sendCdpCommand, throwEvaluationException, withDebugger } from "./cdp.js";
import { describeKey, MODIFIER_BITS } from "./keys.js";
import { loadPageLibrariesScript } from "./libraries.js";
import { ensureOffscreenDocument } from "./lifecycle.js";
import { ACOBSettings } from "./settings.js";
import { state } from "./state.js";
import type { RecordingOutcome } from "./state.js";
import { reloadTab } from "./tabs.js";
import { withTerminationOnTimeout, withTimeout } from "./timeouts.js";
import type {
  ClickResult,
  Configuration,
  FinalizeRecordingMessage,
  FinalizeRecordingResponse,
  JsonValue,
  KeyboardKeyResult,
  KeyboardPayload,
  KeyboardTextResult,
  RecordStartResult,
  RecordStopUploadResult,
  RecordingFrameMessage,
  RecordingStopReason,
  ScreenshotUploadResult,
  ScrollResult,
  StartRecordingMessage,
  StartRecordingResponse,
  UnserializableJavaScriptResult,
} from "./types.js";

export async function executeJavaScript(
  tid: number,
  script: string,
  configuration: Configuration,
): Promise<JsonValue | UnserializableJavaScriptResult> {
  if (state.reinstallScheduled) {
    throw new Error("Extension reinstall is in progress");
  }
  const pageLibrariesScript = await loadPageLibrariesScript();
  if (state.reinstallScheduled) {
    throw new Error("Extension reinstall is in progress");
  }
  return withDebugger(tid, configuration.debuggerProtocolVersion, async (target) => {
    let stopPromise: Promise<void> | null = null;
    const stopExecution = (): Promise<void> => {
      stopPromise ??= withTimeout(
        sendCdpCommand(target, "Runtime.terminateExecution"),
        2000,
        "Timed out terminating Chromium execution",
      );
      return stopPromise;
    };
    const stopTimedOutExecution = async (): Promise<void> => {
      let terminationError: unknown;
      try {
        await stopExecution();
      } catch (error) {
        terminationError = error;
      }
      try {
        await reloadTab(
          tid,
          Math.min(configuration.tabLoadTimeoutMs, 7000),
        );
      } catch (reloadError) {
        if (terminationError !== undefined) {
          throw new AggregateError(
            [terminationError, reloadError],
            "Could not stop timed-out JavaScript or reload its tab",
          );
        }
        throw reloadError;
      }
    };
    let markFinished: () => void = () => undefined;
    const finished = new Promise<void>((resolve) => {
      markFinished = resolve;
    });
    const activeExecution = { tid, finished, stop: stopExecution };
    state.activeJavaScriptExecutions.add(activeExecution);
    let evaluation: Protocol.Runtime.EvaluateResponse;
    try {
      if (state.reinstallScheduled) {
        throw new Error("Extension reinstall is in progress");
      }
      const installation = await withTimeout(
        sendCdpCommand(target, "Runtime.evaluate", {
          expression: pageLibrariesScript,
          returnByValue: true,
        }),
        configuration.javascriptTimeoutMs,
        "Timed out loading page libraries",
      );
      throwEvaluationException(installation);
      if (state.reinstallScheduled) {
        throw new Error("Extension reinstall is in progress");
      }
      const evaluationPromise = sendCdpCommand(target, "Runtime.evaluate", {
        expression: script,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      });
      evaluation = await withTerminationOnTimeout(
        evaluationPromise,
        configuration.javascriptTimeoutMs,
        "Timed out waiting for JavaScript to finish",
        stopTimedOutExecution,
      );
      throwEvaluationException(evaluation);
    } finally {
      state.activeJavaScriptExecutions.delete(activeExecution);
      markFinished();
    }

    const result = evaluation.result;
    if (Object.hasOwn(result, "value")) {
      return result.value === undefined ? null : (result.value as JsonValue);
    }
    if (result.unserializableValue) {
      return result.unserializableValue;
    }
    return {
      type: result.type,
      description: result.description ?? null,
    };
  });
}

export async function executeClick(
  tid: number,
  selector: string,
  configuration: Configuration,
): Promise<ClickResult> {
  return withDebugger(tid, configuration.debuggerProtocolVersion, async (target) => {
    const { root } = await sendCdpCommand(
      target,
      "DOM.getDocument",
      { depth: 0 },
    );
    const { nodeId } = await sendCdpCommand(
      target,
      "DOM.querySelector",
      { nodeId: root.nodeId, selector },
    );

    if (!nodeId) {
      throw new Error(`No element matches selector: ${selector}`);
    }

    await sendCdpCommand(target, "DOM.scrollIntoViewIfNeeded", {
      nodeId,
    });
    const { model } = await sendCdpCommand(
      target,
      "DOM.getBoxModel",
      { nodeId },
    );
    const border = model.border;
    if (border.length < 8) {
      throw new Error(`Element has an invalid clickable box: ${selector}`);
    }
    const x = (border[0]! + border[2]! + border[4]! + border[6]!) / 4;
    const y = (border[1]! + border[3]! + border[5]! + border[7]!) / 4;

    if (
      model.width < 1 ||
      model.height < 1 ||
      !Number.isFinite(x) ||
      !Number.isFinite(y)
    ) {
      throw new Error(`Element has no clickable box: ${selector}`);
    }

    await sendCdpCommand(target, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y,
      pointerType: "mouse",
    });
    await sendCdpCommand(target, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      buttons: 1,
      clickCount: 1,
      pointerType: "mouse",
    });
    await sendCdpCommand(target, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      buttons: 0,
      clickCount: 1,
      pointerType: "mouse",
    });

    return { clicked: true, selector, x, y };
  });
}

export async function executeScreenshot(
  tid: number,
  fullPage: boolean,
  configuration: Configuration,
): Promise<ScreenshotUploadResult> {
  return withDebugger(tid, configuration.debuggerProtocolVersion, async (target) => {
    const { data } = await sendCdpCommand(
      target,
      "Page.captureScreenshot",
      {
        format: "png",
        fromSurface: true,
        captureBeyondViewport: fullPage,
      },
    );
    if (
      data.length >
      ACOBSettings.mebibytesToBytes(configuration.maxScreenshotSizeMiB)
    ) {
      throw new Error(
        `Screenshot exceeds the ${configuration.maxScreenshotSizeMiB} MiB encoded size limit`,
      );
    }
    return { data };
  });
}

export async function executeScroll(
  tid: number,
  y: number,
  configuration: Configuration,
): Promise<ScrollResult> {
  return withDebugger(tid, configuration.debuggerProtocolVersion, async (target) => {
    const evaluation = await sendCdpCommand(target, "Runtime.evaluate", {
      expression: `
        (() => {
          const distance = ${y};
          const canScroll = (el) => el.scrollHeight - el.clientHeight > 1;
          const doc = document.scrollingElement || document.documentElement;
          if (canScroll(doc)) {
            window.scrollBy({ left: 0, top: distance, behavior: "instant" });
            return;
          }
          const centerX = Math.floor(window.innerWidth / 2);
          const centerY = Math.floor(window.innerHeight / 2);
          let node = document.elementFromPoint(centerX, centerY);
          while (node) {
            if (canScroll(node)) {
              node.scrollTop += distance;
              return;
            }
            node = node.parentElement;
          }
          let best = null;
          let bestRoom = 0;
          for (const el of document.querySelectorAll("*")) {
            const room = el.scrollHeight - el.clientHeight;
            if (room > 1 && room > bestRoom) {
              bestRoom = room;
              best = el;
            }
          }
          if (best) {
            best.scrollTop += distance;
          }
        })()
      `,
      returnByValue: true,
      userGesture: true,
    });
    throwEvaluationException(evaluation);
    return { scrolled: true, y };
  });
}

export async function executeKeyboard(
  tid: number,
  payload: KeyboardPayload,
  configuration: Configuration,
): Promise<KeyboardTextResult | KeyboardKeyResult> {
  return withDebugger(tid, configuration.debuggerProtocolVersion, async (target) => {
    if ("text" in payload) {
      await sendCdpCommand(target, "Input.insertText", {
        text: payload.text,
      });
      return { inserted_characters: Array.from(payload.text).length };
    }

    const payloadModifiers = payload.modifiers ?? [];
    const modifiers = payloadModifiers.reduce(
      (mask, modifier) => mask | MODIFIER_BITS[modifier],
      0,
    );
    const definition = describeKey(
      payload.key,
      (modifiers & MODIFIER_BITS.shift) !== 0,
    );
    const commandModifiers =
      MODIFIER_BITS.alt | MODIFIER_BITS.ctrl | MODIFIER_BITS.meta;
    const hasCommandModifier = (modifiers & commandModifiers) !== 0;
    const keyEvent: Omit<Protocol.Input.DispatchKeyEventRequest, "type"> = {
      key: definition.key,
      modifiers,
    };
    if (definition.code !== undefined) {
      keyEvent.code = definition.code;
    }
    if (definition.keyCode !== undefined) {
      keyEvent.windowsVirtualKeyCode = definition.keyCode;
    }
    const keyDownEvent = { ...keyEvent };
    if (definition.text && !hasCommandModifier) {
      keyDownEvent.text = definition.text;
      keyDownEvent.unmodifiedText =
        definition.unmodifiedText ?? definition.text;
    }

    await sendCdpCommand(target, "Input.dispatchKeyEvent", {
      ...keyDownEvent,
      type: definition.text && !hasCommandModifier ? "keyDown" : "rawKeyDown",
    });
    await sendCdpCommand(target, "Input.dispatchKeyEvent", {
      ...keyEvent,
      type: "keyUp",
    });
    return { key: payload.key, modifiers: payloadModifiers };
  });
}

const RECORDING_JPEG_QUALITY = 70;
const RECORDING_CAPTURE_INTERVAL_MS = 200;
const RECORDING_CAPTURE_TIMEOUT_MS = 10_000;
const RECORDING_FIRST_CAPTURE_TIMEOUT_MS = 3_000;
const RECORDING_KEEPALIVE_MS = 20_000;
const USER_STOP_MESSAGE = "Recording stopped by user request";
const MAX_DURATION_MESSAGE =
  "Recording stopped because the maximum duration was reached";

interface RecordingPipeline {
  ready: Promise<void>;
  finished: Promise<RecordingOutcome>;
  requestStop: () => void;
}

function startRecordingPipeline(
  recordingId: number,
  tid: number,
  fullPage: boolean,
  configuration: Configuration,
): RecordingPipeline {
  let requestStop: () => void = () => undefined;
  const stopRequested = new Promise<void>((resolve) => {
    requestStop = resolve;
  });
  let markReady: () => void = () => undefined;
  let failReady: (error: unknown) => void = () => undefined;
  let readyConfirmed = false;
  const ready = new Promise<void>((resolve, reject) => {
    markReady = resolve;
    failReady = reject;
  });
  let markFinished: (outcome: RecordingOutcome) => void = () => undefined;
  let failFinished: (error: unknown) => void = () => undefined;
  const finished = new Promise<RecordingOutcome>((resolve, reject) => {
    markFinished = resolve;
    failFinished = reject;
  });

  const pipeline = withDebugger(
    tid,
    configuration.debuggerProtocolVersion,
    async (target) => {
      const startedAt = Date.now();
      let stoppedByTimer = false;
      let detached = false;
      let stopped = false;
      let captures = 0;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const keepAlive = setInterval(() => undefined, RECORDING_KEEPALIVE_MS);
      const stopPromise = stopRequested.then(() => {
        stopped = true;
      });
      const onDetach = (source: chrome.debugger.Debuggee): void => {
        if (source.tabId !== tid) {
          return;
        }
        detached = true;
        requestStop();
      };

      const sendFrame = async (data: string): Promise<void> => {
        const message: RecordingFrameMessage = {
          type: "recordingFrame",
          recordingId,
          data,
        };
        await withTimeout(
          chrome.runtime
            .sendMessage<RecordingFrameMessage, void>(message)
            .catch(() => undefined),
          RECORDING_CAPTURE_TIMEOUT_MS,
          "Recording was interrupted: the media sink stopped responding",
        );
      };

      try {
        chrome.debugger.onDetach.addListener(onDetach);
        readyConfirmed = true;
        markReady();
        timer = setTimeout(() => {
          stoppedByTimer = true;
          requestStop();
        }, configuration.maxRecordingDurationSec * 1000);

        while (!stopped && !detached) {
          let data: string;
          const firstCapture = captures === 0;
          try {
            const capture = await withTimeout(
              (async () => {
                let clip: Protocol.Page.Viewport | undefined;
                if (fullPage) {
                  const { cssContentSize } = await sendCdpCommand(
                    target,
                    "Page.getLayoutMetrics",
                  );
                  clip = {
                    x: 0,
                    y: 0,
                    width: Math.max(1, Math.round(cssContentSize.width)),
                    height: Math.max(1, Math.round(cssContentSize.height)),
                    scale: 1,
                  };
                }
                return sendCdpCommand(target, "Page.captureScreenshot", {
                  format: "jpeg",
                  quality: RECORDING_JPEG_QUALITY,
                  fromSurface: true,
                  captureBeyondViewport: fullPage,
                  ...(clip === undefined ? {} : { clip }),
                });
              })(),
              firstCapture
                ? RECORDING_FIRST_CAPTURE_TIMEOUT_MS
                : RECORDING_CAPTURE_TIMEOUT_MS,
              firstCapture
                ? "Recording could not capture the tab; focus its window and try again"
                : "Recording was interrupted: could not capture the tab",
            );
            data = capture.data;
          } catch (error) {
            if (detached) {
              throw new Error(
                "Recording was interrupted: the tab or debugger was closed",
              );
            }
            throw error;
          }
          captures += 1;
          await sendFrame(data);
          await Promise.race([
            stopPromise,
            new Promise<void>((resolve) =>
              setTimeout(resolve, RECORDING_CAPTURE_INTERVAL_MS),
            ),
          ]);
        }
        if (detached) {
          throw new Error(
            "Recording was interrupted: the tab or debugger was closed",
          );
        }
        const message: FinalizeRecordingMessage = {
          type: "finalizeRecording",
          recordingId,
          maxRecordingSizeMiB: configuration.maxRecordingSizeMiB,
        };
        let response: FinalizeRecordingResponse;
        try {
          response = await withTimeout(
            chrome.runtime.sendMessage<
              FinalizeRecordingMessage,
              FinalizeRecordingResponse
            >(message),
            configuration.httpRequestTimeoutMs,
            "Timed out finalizing the recording",
          );
        } catch (error) {
          state.recordingChunks.delete(recordingId);
          throw error;
        }
        if ("error" in response) {
          state.recordingChunks.delete(recordingId);
          throw new Error(
            `${response.error} (${captures} screenshots captured)`,
          );
        }
        const chunks = state.recordingChunks.get(recordingId) ?? [];
        state.recordingChunks.delete(recordingId);
        const stoppedReason: RecordingStopReason = stoppedByTimer
          ? "max_duration"
          : "user";
        return {
          data: chunks.join(""),
          contentType: response.contentType,
          durationMs: stoppedByTimer
            ? configuration.maxRecordingDurationSec * 1000
            : Date.now() - startedAt,
          stoppedReason,
          message: stoppedByTimer ? MAX_DURATION_MESSAGE : USER_STOP_MESSAGE,
        };
      } finally {
        clearTimeout(timer);
        clearInterval(keepAlive);
        chrome.debugger.onDetach.removeListener(onDetach);
      }
    },
  );

  void pipeline.then(
    (outcome) => markFinished(outcome),
    (error: unknown) => {
      if (!readyConfirmed) {
        failReady(error);
      }
      failFinished(error);
    },
  );
  return { ready, finished, requestStop };
}

async function measurePageSize(
  tid: number,
  configuration: Configuration,
): Promise<{ width: number; height: number }> {
  return withDebugger(
    tid,
    configuration.debuggerProtocolVersion,
    async (target) => {
      const { cssContentSize } = await withTimeout(
        sendCdpCommand(target, "Page.getLayoutMetrics"),
        RECORDING_FIRST_CAPTURE_TIMEOUT_MS,
        "Recording could not measure the page; focus its window and try again",
      );
      return {
        width: Math.max(1, Math.round(cssContentSize.width)),
        height: Math.max(1, Math.round(cssContentSize.height)),
      };
    },
  );
}

export async function executeRecordStart(
  tid: number,
  recordingId: number,
  fullPage: boolean,
  configuration: Configuration,
): Promise<RecordStartResult> {
  await ensureOffscreenDocument();
  const size = fullPage ? await measurePageSize(tid, configuration) : null;
  const message: StartRecordingMessage = {
    type: "startRecording",
    recordingId,
    tid,
    fullPage,
    width: size?.width ?? 0,
    height: size?.height ?? 0,
    maxRecordingDurationSec: configuration.maxRecordingDurationSec,
    maxRecordingSizeMiB: configuration.maxRecordingSizeMiB,
  };
  const response = await withTimeout(
    chrome.runtime.sendMessage<StartRecordingMessage, StartRecordingResponse>(
      message,
    ),
    configuration.httpRequestTimeoutMs,
    "Timed out starting the recording",
  );
  if ("error" in response) {
    throw new Error(response.error);
  }

  const pipeline = startRecordingPipeline(
    recordingId,
    tid,
    fullPage,
    configuration,
  );
  const session = {
    tid,
    requestStop: pipeline.requestStop,
    finished: pipeline.finished,
  };
  state.recordings.set(recordingId, session);
  void pipeline.finished.catch(() => {
    state.recordings.delete(recordingId);
  });
  await withTimeout(
    pipeline.ready,
    configuration.httpRequestTimeoutMs,
    "Timed out starting the recording",
  );
  return { recording_id: recordingId, started: true };
}

export async function executeRecordStop(
  recordingId: number,
  configuration: Configuration,
): Promise<RecordStopUploadResult> {
  const session = state.recordings.get(recordingId);
  if (session === undefined) {
    throw new Error(`No active recording with id ${recordingId}`);
  }
  session.requestStop();
  let outcome: RecordingOutcome;
  try {
    outcome = await withTimeout(
      session.finished,
      configuration.httpRequestTimeoutMs,
      "Timed out stopping the recording",
    );
  } finally {
    state.recordings.delete(recordingId);
  }
  return {
    data: outcome.data,
    content_type: outcome.contentType,
    duration: outcome.durationMs / 1000,
    stopped_reason: outcome.stoppedReason,
    message: outcome.message,
  };
}
