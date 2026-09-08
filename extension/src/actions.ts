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

async function waitForPageInputReady(
  target: chrome.debugger.DebuggerSession,
  configuration: Configuration,
): Promise<void> {
  const evaluation = await withTimeout(
    sendCdpCommand(target, "Runtime.evaluate", {
      expression: `
        new Promise((resolve) => {
          const ready = () => setTimeout(
            () => requestAnimationFrame(() =>
              requestAnimationFrame(() => resolve(true))
            ),
            100,
          );
          if (document.visibilityState === "visible") {
            ready();
            return;
          }
          const onVisibilityChange = () => {
            if (document.visibilityState !== "visible") return;
            document.removeEventListener("visibilitychange", onVisibilityChange);
            ready();
          };
          document.addEventListener("visibilitychange", onVisibilityChange);
        })
      `,
      awaitPromise: true,
      returnByValue: true,
    }),
    Math.min(configuration.httpRequestTimeoutMs, 3000),
    "The focused tab did not become ready for input; try again or use javascript",
  );
  throwEvaluationException(evaluation);
}

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
    await waitForPageInputReady(target, configuration);
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
    const [{ quads }, { cssVisualViewport }] = await Promise.all([
      sendCdpCommand(target, "DOM.getContentQuads", { nodeId }),
      sendCdpCommand(target, "Page.getLayoutMetrics"),
    ]);
    const clipPolygon = (
      points: { x: number; y: number }[],
      inside: (point: { x: number; y: number }) => boolean,
      intersect: (
        start: { x: number; y: number },
        end: { x: number; y: number },
      ) => { x: number; y: number },
    ): { x: number; y: number }[] => {
      const clipped: { x: number; y: number }[] = [];
      for (let index = 0; index < points.length; index += 1) {
        const start = points[index]!;
        const end = points[(index + 1) % points.length]!;
        const startInside = inside(start);
        const endInside = inside(end);
        if (startInside && endInside) {
          clipped.push(end);
        } else if (startInside) {
          clipped.push(intersect(start, end));
        } else if (endInside) {
          clipped.push(intersect(start, end), end);
        }
      }
      return clipped;
    };
    const clipAtX = (
      points: { x: number; y: number }[],
      boundary: number,
      keepGreater: boolean,
    ) => clipPolygon(
      points,
      ({ x }) => keepGreater ? x >= boundary : x <= boundary,
      (start, end) => {
        const ratio = (boundary - start.x) / (end.x - start.x);
        return { x: boundary, y: start.y + ratio * (end.y - start.y) };
      },
    );
    const clipAtY = (
      points: { x: number; y: number }[],
      boundary: number,
      keepGreater: boolean,
    ) => clipPolygon(
      points,
      ({ y }) => keepGreater ? y >= boundary : y <= boundary,
      (start, end) => {
        const ratio = (boundary - start.y) / (end.y - start.y);
        return { x: start.x + ratio * (end.x - start.x), y: boundary };
      },
    );
    const candidates = quads
      .filter((quad) => quad.length >= 8)
      .map((quad) => {
        let points = [
          { x: quad[0]!, y: quad[1]! },
          { x: quad[2]!, y: quad[3]! },
          { x: quad[4]!, y: quad[5]! },
          { x: quad[6]!, y: quad[7]! },
        ];
        const originalArea = Math.abs(
          points.reduce((sum, point, index) => {
            const next = points[(index + 1) % points.length]!;
            return sum + point.x * next.y - point.y * next.x;
          }, 0),
        ) / 2;
        points = clipAtX(points, cssVisualViewport.offsetX, true);
        points = clipAtX(
          points,
          cssVisualViewport.offsetX + cssVisualViewport.clientWidth,
          false,
        );
        points = clipAtY(points, cssVisualViewport.offsetY, true);
        points = clipAtY(
          points,
          cssVisualViewport.offsetY + cssVisualViewport.clientHeight,
          false,
        );
        let x = points.reduce((sum, point) => sum + point.x, 0) / points.length;
        let y = points.reduce((sum, point) => sum + point.y, 0) / points.length;
        const area = Math.abs(
          points.reduce((sum, point, index) => {
            const next = points[(index + 1) % points.length]!;
            return sum + point.x * next.y - point.y * next.x;
          }, 0),
        ) / 2;
        const viewportCenter = {
          x: cssVisualViewport.offsetX + cssVisualViewport.clientWidth / 2,
          y: cssVisualViewport.offsetY + cssVisualViewport.clientHeight / 2,
        };
        const crossProducts = points.map((point, index) => {
          const next = points[(index + 1) % points.length]!;
          return (next.x - point.x) * (viewportCenter.y - point.y) -
            (next.y - point.y) * (viewportCenter.x - point.x);
        });
        const centerInside = crossProducts.every((cross) => cross >= 0) ||
          crossProducts.every((cross) => cross <= 0);
        if (area < originalArea - 0.001 && centerInside) {
          x = viewportCenter.x;
          y = viewportCenter.y;
        } else if (area < originalArea - 0.001 && points.length > 0) {
          let closest = points[0]!;
          let closestDistance = Number.POSITIVE_INFINITY;
          for (let index = 0; index < points.length; index += 1) {
            const start = points[index]!;
            const end = points[(index + 1) % points.length]!;
            const dx = end.x - start.x;
            const dy = end.y - start.y;
            const denominator = dx * dx + dy * dy;
            const ratio = denominator === 0
              ? 0
              : Math.max(0, Math.min(1,
                ((viewportCenter.x - start.x) * dx +
                  (viewportCenter.y - start.y) * dy) / denominator,
              ));
            const candidate = {
              x: start.x + ratio * dx,
              y: start.y + ratio * dy,
            };
            const distance = (candidate.x - viewportCenter.x) ** 2 +
              (candidate.y - viewportCenter.y) ** 2;
            if (distance < closestDistance) {
              closest = candidate;
              closestDistance = distance;
            }
          }
          x = closest.x * 0.75 + x * 0.25;
          y = closest.y * 0.75 + y * 0.25;
        }
        return { area, x, y };
      })
      .filter(
        ({ area, x, y }) =>
          area >= 1 &&
          Number.isFinite(x) &&
          Number.isFinite(y) &&
          x >= 0 &&
          y >= 0,
      )
      .sort((left, right) => right.area - left.area);
    const point = candidates[0];
    if (!point) {
      throw new Error(`Element has no clickable box: ${selector}`);
    }
    const { x, y } = point;

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
    const { data } = await withTimeout(
      sendCdpCommand(target, "Page.captureScreenshot", {
        format: "png",
        fromSurface: true,
        captureBeyondViewport: fullPage,
      }),
      configuration.httpRequestTimeoutMs,
      "Timed out capturing the screenshot",
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
    await waitForPageInputReady(target, configuration);
    const evaluation = await sendCdpCommand(target, "Runtime.evaluate", {
      expression: `
        (() => {
          const distance = ${y};
          const doc = document.scrollingElement || document.documentElement;
          const room = (el) => distance > 0
            ? el.scrollHeight - el.clientHeight - el.scrollTop
            : el.scrollTop;
          const canScroll = (el) => {
            const style = getComputedStyle(el);
            return (el === doc || ["auto", "scroll", "overlay"].includes(style.overflowY)) &&
              room(el) > 1;
          };
          const centerX = Math.floor(window.innerWidth / 2);
          const centerY = Math.floor(window.innerHeight / 2);
          let node = document.elementFromPoint(centerX, centerY);
          while (node) {
            if (canScroll(node)) {
              const rect = node.getBoundingClientRect();
              return {
                x: Math.max(0, Math.min(window.innerWidth - 1, rect.left + rect.width / 2)),
                y: Math.max(0, Math.min(window.innerHeight - 1, rect.top + rect.height / 2)),
              };
            }
            node = node.parentElement;
          }
          if (canScroll(doc)) {
            return { x: centerX, y: centerY };
          }
          let best = null;
          let bestRoom = 0;
          for (const el of document.querySelectorAll("*")) {
            const rect = el.getBoundingClientRect();
            const style = getComputedStyle(el);
            const visible = rect.width > 0 && rect.height > 0 &&
              rect.bottom > 0 && rect.right > 0 &&
              rect.top < window.innerHeight && rect.left < window.innerWidth &&
              style.display !== "none" && style.visibility !== "hidden";
            const remaining = room(el);
            if (visible && canScroll(el) && remaining > bestRoom) {
              bestRoom = remaining;
              best = el;
            }
          }
          if (best) {
            const rect = best.getBoundingClientRect();
            return {
              x: Math.max(0, Math.min(window.innerWidth - 1, rect.left + rect.width / 2)),
              y: Math.max(0, Math.min(window.innerHeight - 1, rect.top + rect.height / 2)),
            };
          }
          return { x: centerX, y: centerY };
        })()
      `,
      returnByValue: true,
      userGesture: true,
    });
    throwEvaluationException(evaluation);
    const point = evaluation.result.value as { x?: unknown; y?: unknown } | undefined;
    if (
      !point ||
      typeof point.x !== "number" ||
      typeof point.y !== "number" ||
      !Number.isFinite(point.x) ||
      !Number.isFinite(point.y)
    ) {
      throw new Error("Chromium could not determine a scroll target");
    }
    await sendCdpCommand(target, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: point.x,
      y: point.y,
      pointerType: "mouse",
    });
    await sendCdpCommand(target, "Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: point.x,
      y: point.y,
      deltaX: 0,
      deltaY: y,
      pointerType: "mouse",
    });
    return { scrolled: true, y };
  });
}

export async function executeKeyboard(
  tid: number,
  payload: KeyboardPayload,
  configuration: Configuration,
): Promise<KeyboardTextResult | KeyboardKeyResult> {
  return withDebugger(tid, configuration.debuggerProtocolVersion, async (target) => {
    await waitForPageInputReady(target, configuration);
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
    if (definition.text) {
      keyDownEvent.unmodifiedText = definition.text;
    }
    if (definition.text && !hasCommandModifier) {
      keyDownEvent.text = definition.text;
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
          tid,
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
          tid,
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
          state.recordingChunks.delete(tid);
          throw error;
        }
        if ("error" in response) {
          state.recordingChunks.delete(tid);
          throw new Error(
            `${response.error} (${captures} screenshots captured)`,
          );
        }
        const chunks = state.recordingChunks.get(tid) ?? [];
        state.recordingChunks.delete(tid);
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
  fullPage: boolean,
  configuration: Configuration,
): Promise<RecordStartResult> {
  if (state.recordings.has(tid)) {
    throw new Error(`A recording for tab ${tid} is already active`);
  }
  await ensureOffscreenDocument();
  const size = fullPage ? await measurePageSize(tid, configuration) : null;
  const message: StartRecordingMessage = {
    type: "startRecording",
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

  const pipeline = startRecordingPipeline(tid, fullPage, configuration);
  const session = {
    tid,
    requestStop: pipeline.requestStop,
    finished: pipeline.finished,
  };
  state.recordings.set(tid, session);
  void pipeline.finished.catch(() => {
    state.recordings.delete(tid);
  });
  await withTimeout(
    pipeline.ready,
    configuration.httpRequestTimeoutMs,
    "Timed out starting the recording",
  );
  return { started: true };
}

export async function executeRecordStop(
  tid: number,
  configuration: Configuration,
): Promise<RecordStopUploadResult> {
  const session = state.recordings.get(tid);
  if (session === undefined) {
    throw new Error(`No active recording for tab ${tid}`);
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
    state.recordings.delete(tid);
  }
  return {
    data: outcome.data,
    content_type: outcome.contentType,
    duration: outcome.durationMs / 1000,
    stopped_reason: outcome.stoppedReason,
    message: outcome.message,
  };
}
