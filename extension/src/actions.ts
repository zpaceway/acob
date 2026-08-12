import type { Protocol } from "devtools-protocol";

import { sendCdpCommand, throwEvaluationException, withDebugger } from "./cdp.js";
import { describeKey, MODIFIER_BITS } from "./keys.js";
import { loadPageLibrariesScript } from "./libraries.js";
import { ACOBSettings } from "./settings.js";
import { state } from "./state.js";
import { reloadTab } from "./tabs.js";
import { withTerminationOnTimeout, withTimeout } from "./timeouts.js";
import type {
  ClickResult,
  Configuration,
  JsonValue,
  KeyboardKeyResult,
  KeyboardPayload,
  KeyboardTextResult,
  ScreenshotUploadResult,
  ScrollResult,
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
  return withDebugger(tid, configuration, async (target) => {
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
  return withDebugger(tid, configuration, async (target) => {
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
  return withDebugger(tid, configuration, async (target) => {
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
  return withDebugger(tid, configuration, async (target) => {
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
  return withDebugger(tid, configuration, async (target) => {
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
