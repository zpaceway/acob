import assert from "node:assert/strict";
import test from "node:test";

interface CommandCall {
  method: string;
  parameters: Record<string, unknown> | undefined;
}

const commands: CommandCall[] = [];
let responses = new Map<string, unknown>();
let updateTab = async (tid: number) => ({
  id: tid,
  windowId: 7,
  active: true,
  url: "https://example.com",
});

Object.defineProperty(globalThis, "chrome", {
  configurable: true,
  value: {
    debugger: {
      onDetach: {
        addListener: () => undefined,
        removeListener: () => undefined,
      },
      attach: async () => undefined,
      detach: async () => undefined,
      sendCommand: async (
        _target: unknown,
        method: string,
        parameters: Record<string, unknown> | undefined,
      ) => {
        commands.push({ method, parameters });
        return responses.get(method) ?? {};
      },
    },
    tabs: {
      get: async (tid: number) => updateTab(tid),
      update: async (tid: number) => updateTab(tid),
    },
    windows: {
      get: async () => ({ id: 7, focused: true }),
      update: async () => ({ id: 7, focused: true }),
    },
    runtime: {
      sendMessage: async () => undefined,
    },
  },
});

const { executeClick, executeKeyboard, executeScroll } = await import(
  "../src/actions.js"
);
const { ACOBSettings } = await import("../src/settings.js");
const { runInstruction } = await import("../src/execution.js");
const { runInBrowserInputQueue } = await import("../src/input.js");
const { state } = await import("../src/state.js");
const { keyboardCharacter } = await import("../src/types.js");
const configuration = ACOBSettings.normalizeConfiguration();

test("click uses the largest rendered fragment and dispatches native mouse input", async () => {
  commands.length = 0;
  responses = new Map([
    ["DOM.getDocument", { root: { nodeId: 1 } }],
    ["DOM.querySelector", { nodeId: 2 }],
    [
      "Page.getLayoutMetrics",
      {
        cssVisualViewport: {
          clientWidth: 1280,
          clientHeight: 720,
          offsetX: 0,
          offsetY: 0,
        },
      },
    ],
    [
      "DOM.getContentQuads",
      {
        quads: [
          [10, 10, 30, 10, 30, 20, 10, 20],
          [100, 100, 200, 100, 200, 160, 100, 160],
        ],
      },
    ],
  ]);

  assert.deepEqual(await executeClick(12, "button", configuration), {
    clicked: true,
    selector: "button",
    x: 150,
    y: 130,
  });
  assert.deepEqual(
    commands
      .filter(({ method }) => method === "Input.dispatchMouseEvent")
      .map(({ parameters }) => parameters),
    [
      { type: "mouseMoved", x: 150, y: 130, pointerType: "mouse" },
      {
        type: "mousePressed",
        x: 150,
        y: 130,
        button: "left",
        buttons: 1,
        clickCount: 1,
        pointerType: "mouse",
      },
      {
        type: "mouseReleased",
        x: 150,
        y: 130,
        button: "left",
        buttons: 0,
        clickCount: 1,
        pointerType: "mouse",
      },
    ],
  );
});

test("click clips rendered fragments to a panned visual viewport", async () => {
  commands.length = 0;
  responses = new Map([
    ["DOM.getDocument", { root: { nodeId: 1 } }],
    ["DOM.querySelector", { nodeId: 2 }],
    [
      "Page.getLayoutMetrics",
      {
        cssVisualViewport: {
          clientWidth: 100,
          clientHeight: 80,
          offsetX: 200,
          offsetY: 100,
        },
      },
    ],
    [
      "DOM.getContentQuads",
      { quads: [[150, 50, 350, 50, 350, 250, 150, 250]] },
    ],
  ]);

  assert.deepEqual(await executeClick(12, "button", configuration), {
    clicked: true,
    selector: "button",
    x: 250,
    y: 140,
  });
});

test("click biases a clipped fragment away from the viewport edge", async () => {
  commands.length = 0;
  responses = new Map([
    ["DOM.getDocument", { root: { nodeId: 1 } }],
    ["DOM.querySelector", { nodeId: 2 }],
    [
      "Page.getLayoutMetrics",
      {
        cssVisualViewport: {
          clientWidth: 300,
          clientHeight: 200,
          offsetX: 0,
          offsetY: 0,
        },
      },
    ],
    [
      "DOM.getContentQuads",
      { quads: [[250, 150, 450, 150, 450, 350, 250, 350]] },
    ],
  ]);

  assert.deepEqual(await executeClick(12, "button", configuration), {
    clicked: true,
    selector: "button",
    x: 256.25,
    y: 156.25,
  });
});

test("scroll dispatches trusted wheel input at the selected viewport point", async () => {
  commands.length = 0;
  responses = new Map([
    [
      "Runtime.evaluate",
      { result: { type: "object", value: { x: 320, y: 240 } } },
    ],
  ]);

  assert.deepEqual(await executeScroll(12, 80, configuration), {
    scrolled: true,
    y: 80,
  });
  assert.deepEqual(commands.slice(-2), [
    {
      method: "Input.dispatchMouseEvent",
      parameters: {
        type: "mouseMoved",
        x: 320,
        y: 240,
        pointerType: "mouse",
      },
    },
    {
      method: "Input.dispatchMouseEvent",
      parameters: {
        type: "mouseWheel",
        x: 320,
        y: 240,
        deltaX: 0,
        deltaY: 80,
        pointerType: "mouse",
      },
    },
  ]);
});

test("shifted key input sends correct CDP text metadata", async () => {
  commands.length = 0;
  responses = new Map();

  await executeKeyboard(
    12,
    { tid: 12, key: keyboardCharacter("a"), modifiers: ["shift"] },
    configuration,
  );
  assert.deepEqual(
    commands
      .filter(({ method }) => method === "Input.dispatchKeyEvent")
      .map(({ parameters }) => parameters),
    [
      {
        type: "keyDown",
        key: "A",
        code: "KeyA",
        windowsVirtualKeyCode: 65,
        modifiers: 8,
        text: "A",
        unmodifiedText: "A",
      },
      {
        type: "keyUp",
        key: "A",
        code: "KeyA",
        windowsVirtualKeyCode: 65,
        modifiers: 8,
      },
    ],
  );
});

test("batch holds browser input ownership from focus through later input", async () => {
  state.browserInputQueue = Promise.resolve();
  state.tabExecutionQueues.clear();
  const events: string[] = [];
  let releaseFirstFocus: () => void = () => undefined;
  let markFirstFocusStarted: () => void = () => undefined;
  const firstFocusGate = new Promise<void>((resolve) => {
    releaseFirstFocus = resolve;
  });
  const firstFocusStarted = new Promise<void>((resolve) => {
    markFirstFocusStarted = resolve;
  });
  updateTab = async (tid: number) => {
    events.push(`focus-${tid}:start`);
    if (tid === 1) {
      markFirstFocusStarted();
      await firstFocusGate;
    }
    events.push(`focus-${tid}:end`);
    return {
      id: tid,
      windowId: 7,
      active: true,
      url: "https://example.com",
    };
  };

  const batch = runInstruction(
    {
      id: 1,
      action: "batch",
      payload: {
        actions: [
          { action: "focus", tid: 1 },
          { action: "focus", tid: 2 },
        ],
      },
    },
    configuration,
  );

  await firstFocusStarted;
  const competingFocus = runInBrowserInputQueue(async () => {
    events.push("competing-focus");
  });
  releaseFirstFocus();
  await Promise.all([batch, competingFocus]);

  assert.deepEqual(events, [
    "focus-1:start",
    "focus-1:end",
    "focus-2:start",
    "focus-2:end",
    "competing-focus",
  ]);
});
