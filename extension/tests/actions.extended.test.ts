import assert from "node:assert/strict";
import test from "node:test";

interface CommandCall {
  method: string;
  parameters: Record<string, unknown> | undefined;
}

const commands: CommandCall[] = [];
let responses = new Map<string, unknown>();
let runtimeEvaluateCount = 0;
let runtimeEvaluateImpl:
  | ((params: Record<string, unknown>, index: number) => Promise<unknown>)
  | null = null;
let sendCommandHook:
  | ((
      target: unknown,
      method: string,
      params: Record<string, unknown> | undefined,
    ) => Promise<unknown> | undefined)
  | null = null;
let attachImpl:
  | ((target: unknown, version: string) => Promise<void>)
  | null = null;
let detachImpl: ((target: unknown) => Promise<void>) | null = null;
let sendMessageImpl: (message: Record<string, unknown>) => Promise<unknown> =
  async () => undefined;
let reloadImpl: (tid: number) => Promise<unknown> = async (tid: number) => {
  queueMicrotask(() => {
    for (const listener of [...onUpdatedListeners]) {
      (listener as (a: number, b: unknown, c: unknown) => void)(
        tid,
        { status: "loading" },
        { id: tid, status: "loading" },
      );
    }
    for (const listener of [...onUpdatedListeners]) {
      (listener as (a: number, b: unknown, c: unknown) => void)(
        tid,
        { status: "complete" },
        { id: tid, status: "complete" },
      );
    }
  });
  return {};
};
let fetchImpl: (input: unknown) => Promise<unknown> = async () =>
  ({
    ok: true,
    text: async () => "/* fake jquery */\n/* fake turndown */",
  }) as unknown;

const onUpdatedListeners = new Set<(...args: never[]) => void>();
const detachListeners = new Set<(...args: never[]) => void>();

Object.defineProperty(globalThis, "chrome", {
  configurable: true,
  value: {
    debugger: {
      onDetach: {
        addListener: (listener: (...args: never[]) => void) => {
          detachListeners.add(listener);
        },
        removeListener: (listener: (...args: never[]) => void) => {
          detachListeners.delete(listener);
        },
      },
      attach: async (target: unknown, version: string) => {
        if (attachImpl) {
          return attachImpl(target, version);
        }
      },
      detach: async (target: unknown) => {
        if (detachImpl) {
          return detachImpl(target);
        }
      },
      sendCommand: async (
        target: unknown,
        method: string,
        parameters: Record<string, unknown> | undefined,
      ) => {
        commands.push({ method, parameters });
        if (sendCommandHook) {
          const hooked = await sendCommandHook(target, method, parameters);
          if (hooked !== undefined) {
            return hooked;
          }
        }
        if (method === "Runtime.evaluate" && runtimeEvaluateImpl) {
          const index = runtimeEvaluateCount;
          runtimeEvaluateCount += 1;
          return runtimeEvaluateImpl(parameters ?? {}, index);
        }
        if (responses.has(method)) {
          return responses.get(method);
        }
        return {};
      },
    },
    tabs: {
      get: async (tid: number) => ({ id: tid, windowId: 7, active: true }),
      reload: async (tid: number) => reloadImpl(tid),
      onUpdated: {
        addListener: (listener: (...args: never[]) => void) => {
          onUpdatedListeners.add(listener);
        },
        removeListener: (listener: (...args: never[]) => void) => {
          onUpdatedListeners.delete(listener);
        },
      },
    },
    windows: {
      get: async () => ({ id: 7, focused: true }),
      update: async () => ({ id: 7, focused: true }),
    },
    runtime: {
      getURL: (path: string) => `chrome-extension://acob/${path}`,
      getContexts: async () => [],
      sendMessage: async (message: Record<string, unknown>) =>
        sendMessageImpl(message),
    },
    offscreen: {
      createDocument: async () => undefined,
      closeDocument: async () => undefined,
    },
    webRequest: {
      onAuthRequired: {
        addListener: () => undefined,
      },
    },
  },
});

Object.defineProperty(globalThis, "fetch", {
  configurable: true,
  writable: true,
  value: (input: unknown) => fetchImpl(input),
});

const {
  executeClick,
  executeJavaScript,
  executeKeyboard,
  executeRecordStart,
  executeRecordStop,
  executeScreenshot,
  executeScroll,
} = await import("../src/actions.js");
const { ACOBSettings } = await import("../src/settings.js");
const { state } = await import("../src/state.js");

function baseConfig() {
  return ACOBSettings.normalizeConfiguration({
    httpRequestTimeoutMs: 500,
    javascriptTimeoutMs: 500,
    tabLoadTimeoutMs: 500,
  });
}

function resetShared(): void {
  commands.length = 0;
  responses = new Map();
  runtimeEvaluateCount = 0;
  runtimeEvaluateImpl = null;
  sendCommandHook = null;
  attachImpl = null;
  detachImpl = null;
  sendMessageImpl = async () => undefined;
  reloadImpl = async (tid: number) => {
    queueMicrotask(() => {
      for (const listener of [...onUpdatedListeners]) {
        (listener as (a: number, b: unknown, c: unknown) => void)(
          tid,
          { status: "loading" },
          { id: tid, status: "loading" },
        );
      }
      for (const listener of [...onUpdatedListeners]) {
        (listener as (a: number, b: unknown, c: unknown) => void)(
          tid,
          { status: "complete" },
          { id: tid, status: "complete" },
        );
      }
    });
    return {};
  };
  fetchImpl = async () =>
    ({
      ok: true,
      text: async () => "/* fake jquery */\n/* fake turndown */",
    }) as unknown;
  onUpdatedListeners.clear();
  // Keep detachListeners: cdp global listener must stay; pipeline listeners
  // are removed by the pipeline itself. Clearing here would drop the global.
  state.recordings.clear();
  state.recordingChunks.clear();
  state.reinstallScheduled = false;
  state.proxyCredentials = null;
  state.proxyQueue = Promise.resolve();
  state.activeJavaScriptExecutions.clear();
}

// ---- executeJavaScript reinstall guards + library failure (must run first) ----

test("javascript refuses when reinstall is scheduled before libraries", async () => {
  resetShared();
  state.reinstallScheduled = true;
  try {
    await assert.rejects(
      executeJavaScript(301, "1+1", baseConfig()),
      /reinstall is in progress/,
    );
    assert.equal(commands.length, 0);
  } finally {
    state.reinstallScheduled = false;
  }
});

test("javascript wraps library load failures", async () => {
  resetShared();
  fetchImpl = async () => ({ ok: false, status: 404 }) as unknown;
  await assert.rejects(executeJavaScript(302, "1+1", baseConfig()), /HTTP 404/);
  assert.equal(state.activeJavaScriptExecutions.size, 0);
});

test("javascript returns a value result", async () => {
  resetShared();
  runtimeEvaluateImpl = async (_params, index) => {
    if (index === 0) {
      return { result: { type: "string", value: "libs-ok" } };
    }
    return { result: { type: "number", value: 42 } };
  };
  assert.equal(await executeJavaScript(303, "6*7", baseConfig()), 42);
});

test("javascript maps undefined value to null", async () => {
  resetShared();
  runtimeEvaluateImpl = async (_params, index) => {
    if (index === 0) {
      return { result: { type: "string", value: "libs-ok" } };
    }
    return { result: { type: "undefined", value: undefined } };
  };
  assert.equal(await executeJavaScript(304, "void 0", baseConfig()), null);
});

test("javascript returns unserializable values directly", async () => {
  resetShared();
  runtimeEvaluateImpl = async (_params, index) => {
    if (index === 0) {
      return { result: { type: "string", value: "libs-ok" } };
    }
    return { result: { type: "number", unserializableValue: "NaN" } };
  };
  assert.equal(await executeJavaScript(305, "0/0", baseConfig()), "NaN");
});

test("javascript returns type-description for non-serializable objects", async () => {
  resetShared();
  runtimeEvaluateImpl = async (_params, index) => {
    if (index === 0) {
      return { result: { type: "string", value: "libs-ok" } };
    }
    return { result: { type: "object", description: "Object" } };
  };
  assert.deepEqual(await executeJavaScript(306, "({})", baseConfig()), {
    type: "object",
    description: "Object",
  });

  resetShared();
  runtimeEvaluateImpl = async (_params, index) => {
    if (index === 0) {
      return { result: { type: "string", value: "libs-ok" } };
    }
    return { result: { type: "function" } };
  };
  assert.deepEqual(await executeJavaScript(307, "function(){}", baseConfig()), {
    type: "function",
    description: null,
  });
});

test("javascript refuses when reinstall is scheduled after libraries", async () => {
  resetShared();
  // Libraries are cached from prior successes; setting the flag
  // synchronously after the call still lands before the post-load check.
  const pending = executeJavaScript(308, "1+1", baseConfig());
  state.reinstallScheduled = true;
  try {
    await assert.rejects(pending, /reinstall is in progress/);
  } finally {
    state.reinstallScheduled = false;
  }
});

test("javascript refuses inside the debugger before installing libraries", async () => {
  resetShared();
  attachImpl = async () => {
    state.reinstallScheduled = true;
  };
  try {
    await assert.rejects(
      executeJavaScript(309, "1+1", baseConfig()),
      /reinstall is in progress/,
    );
  } finally {
    state.reinstallScheduled = false;
  }
});

test("javascript refuses inside the debugger after installing libraries", async () => {
  resetShared();
  runtimeEvaluateImpl = async (_params, index) => {
    if (index === 0) {
      state.reinstallScheduled = true;
      return { result: { type: "string", value: "libs-ok" } };
    }
    return { result: { type: "number", value: 1 } };
  };
  try {
    await assert.rejects(
      executeJavaScript(310, "1+1", baseConfig()),
      /reinstall is in progress/,
    );
  } finally {
    state.reinstallScheduled = false;
  }
});

test("javascript timeout terminates and reloads, then rethrows the timeout", async () => {
  resetShared();
  const config = {
    ...baseConfig(),
    javascriptTimeoutMs: 20,
    tabLoadTimeoutMs: 200,
  };
  runtimeEvaluateImpl = async (_params, index) => {
    if (index === 0) {
      return { result: { type: "string", value: "libs-ok" } };
    }
    return new Promise<never>(() => undefined);
  };
  await assert.rejects(
    executeJavaScript(311, "while(true){}", config),
    /Timed out waiting for JavaScript to finish/,
  );
  assert.equal(state.activeJavaScriptExecutions.size, 0);
});

test("javascript timeout with failed terminate and reload reports both", async () => {
  resetShared();
  const config = {
    ...baseConfig(),
    javascriptTimeoutMs: 20,
    tabLoadTimeoutMs: 200,
  };
  runtimeEvaluateImpl = async (_params, index) => {
    if (index === 0) {
      return { result: { type: "string", value: "libs-ok" } };
    }
    return new Promise<never>(() => undefined);
  };
  sendCommandHook = async (_target, method, _params) => {
    if (method === "Runtime.terminateExecution") {
      throw new Error("terminate failed");
    }
    return undefined;
  };
  reloadImpl = async () => {
    throw new Error("reload failed");
  };
  const error = await executeJavaScript(312, "while(true){}", config).then(
    () => null,
    (err: unknown) => err as Error,
  );
  assert.ok(error instanceof Error);
  assert.match(error.message, /Could not stop timed-out JavaScript|Timed out/);
  assert.equal(state.activeJavaScriptExecutions.size, 0);
});

// ---- screenshot ----

test("screenshot returns small captures", async () => {
  resetShared();
  responses = new Map([["Page.captureScreenshot", { data: "tiny" }]]);
  const result = await executeScreenshot(320, false, baseConfig());
  assert.deepEqual(result, { data: "tiny" });
});

test("screenshot rejects captures over the size limit", async () => {
  resetShared();
  const config = ACOBSettings.normalizeConfiguration({
    httpRequestTimeoutMs: 500,
    maxScreenshotSizeMiB: 1,
  });
  responses = new Map([
    ["Page.captureScreenshot", { data: "a".repeat(2 * 1024 * 1024) }],
  ]);
  await assert.rejects(
    executeScreenshot(321, false, config),
    /exceeds the 1 MiB/,
  );
});

// ---- click ----

test("click times out waiting for page input readiness", async () => {
  resetShared();
  const config = ACOBSettings.normalizeConfiguration({
    httpRequestTimeoutMs: 10,
    javascriptTimeoutMs: 500,
    tabLoadTimeoutMs: 500,
  });
  runtimeEvaluateImpl = async () => new Promise<never>(() => undefined);
  await assert.rejects(
    executeClick(330, "button", config),
    /did not become ready for input/,
  );
});

test("click reports no matching element", async () => {
  resetShared();
  responses = new Map([
    ["Runtime.evaluate", { result: { type: "boolean", value: true } }],
    ["DOM.getDocument", { root: { nodeId: 1 } }],
    ["DOM.querySelector", { nodeId: 0 }],
  ]);
  await assert.rejects(
    executeClick(331, ".missing", baseConfig()),
    /No element matches selector: \.missing/,
  );
});

test("click reports an element with no clickable box", async () => {
  resetShared();
  responses = new Map([
    ["Runtime.evaluate", { result: { type: "boolean", value: true } }],
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
    ["DOM.getContentQuads", { quads: [] }],
  ]);
  // scrollIntoViewIfNeeded and mouse events fall back to {}.
  await assert.rejects(
    executeClick(332, "button", baseConfig()),
    /has no clickable box/,
  );
});

// ---- keyboard ----

test("keyboard sends rawKeyDown for command-modified keys", async () => {
  resetShared();
  responses = new Map([
    ["Runtime.evaluate", { result: { type: "boolean", value: true } }],
  ]);
  const result = await executeKeyboard(
    340,
    { tid: 340, key: "Enter", modifiers: ["ctrl"] },
    baseConfig(),
  );
  assert.deepEqual(result, { key: "Enter", modifiers: ["ctrl"] });
  const keyEvents = commands.filter(
    ({ method }) => method === "Input.dispatchKeyEvent",
  );
  assert.equal(keyEvents.length, 2);
  assert.equal(keyEvents[0]?.parameters?.type, "rawKeyDown");
  assert.equal(keyEvents[0]?.parameters?.key, "Enter");
  assert.equal(keyEvents[0]?.parameters?.modifiers, 2);
  assert.equal(keyEvents[0]?.parameters?.unmodifiedText, "\r");
  assert.ok(!Object.hasOwn(keyEvents[0]?.parameters ?? {}, "text"));
  assert.equal(keyEvents[1]?.parameters?.type, "keyUp");
});

test("keyboard inserts text and counts characters", async () => {
  resetShared();
  responses = new Map([
    ["Runtime.evaluate", { result: { type: "boolean", value: true } }],
  ]);
  const result = await executeKeyboard(
    341,
    { tid: 341, text: "hi 👋" },
    baseConfig(),
  );
  // Array.from counts the emoji as one character: h, i, space, 👋.
  assert.deepEqual(result, { inserted_characters: 4 });
  const inserts = commands.filter(
    ({ method }) => method === "Input.insertText",
  );
  assert.equal(inserts.length, 1);
  assert.deepEqual(inserts[0]?.parameters, { text: "hi 👋" });
});

test("keyboard sends rawKeyDown without text metadata for textless keys", async () => {
  resetShared();
  responses = new Map([
    ["Runtime.evaluate", { result: { type: "boolean", value: true } }],
  ]);
  await executeKeyboard(342, { tid: 342, key: "Escape" }, baseConfig());
  const keyEvents = commands.filter(
    ({ method }) => method === "Input.dispatchKeyEvent",
  );
  assert.equal(keyEvents[0]?.parameters?.type, "rawKeyDown");
  assert.ok(!Object.hasOwn(keyEvents[0]?.parameters ?? {}, "text"));
  assert.ok(!Object.hasOwn(keyEvents[0]?.parameters ?? {}, "unmodifiedText"));
});

// ---- scroll ----

test("scroll rejects an undeterminable scroll target", async () => {
  resetShared();
  responses = new Map([
    ["Runtime.evaluate", { result: { type: "object", value: { x: "bad" } } }],
  ]);
  await assert.rejects(
    executeScroll(350, 100, baseConfig()),
    /could not determine a scroll target/,
  );
});

test("scroll rejects missing, non-finite, and mistyped points", async () => {
  for (const [tid, value] of [
    [351, undefined],
    [352, null],
    [353, { x: 10, y: "bad" }],
    [354, { x: Number.POSITIVE_INFINITY, y: 0 }],
    [355, { x: 0, y: Number.NaN }],
  ] as Array<[number, unknown]>) {
    resetShared();
    responses = new Map([
      ["Runtime.evaluate", { result: { type: "object", value } }],
    ]);
    await assert.rejects(
      executeScroll(tid, 100, baseConfig()),
      /could not determine a scroll target/,
    );
  }
});

// ---- recording ----

test("record start refuses duplicate sessions", async () => {
  resetShared();
  state.recordings.set(360, {} as never);
  try {
    await assert.rejects(
      executeRecordStart(360, false, baseConfig()),
      /already active/,
    );
  } finally {
    state.recordings.delete(360);
  }
});

test("record start surfaces offscreen start errors", async () => {
  resetShared();
  sendMessageImpl = async (message) => {
    if (message.type === "startRecording") {
      return { error: "offscreen boom" };
    }
    return undefined as unknown as never;
  };
  await assert.rejects(
    executeRecordStart(361, false, baseConfig()),
    /offscreen boom/,
  );
  assert.equal(state.recordings.has(361), false);
});

test("record start times out waiting for the pipeline to be ready", async () => {
  resetShared();
  const config = ACOBSettings.normalizeConfiguration({
    httpRequestTimeoutMs: 20,
    javascriptTimeoutMs: 500,
    tabLoadTimeoutMs: 500,
  });
  attachImpl = async () => new Promise<never>(() => undefined);
  sendMessageImpl = async (message) => {
    if (message.type === "startRecording") {
      return { ok: true, started: true };
    }
    return undefined as unknown as never;
  };
  try {
    await assert.rejects(
      executeRecordStart(362, false, config),
      /Timed out starting the recording/,
    );
  } finally {
    state.recordings.delete(362);
    attachImpl = null;
  }
});

async function startViewportRecording(
  tid: number,
  config: ReturnType<typeof baseConfig>,
): Promise<void> {
  responses = new Map([
    ["Page.captureScreenshot", { data: "amVmZ2RhdGE=" }],
  ]);
  sendMessageImpl = async (message) => {
    if (message.type === "startRecording") {
      return { ok: true, started: true };
    }
    if (message.type === "recordingFrame") {
      return undefined as unknown as never;
    }
    if (message.type === "finalizeRecording") {
      return { ok: true, contentType: "video/mp4" };
    }
    return undefined as unknown as never;
  };
  const started = await executeRecordStart(tid, false, config);
  assert.deepEqual(started, { started: true });
}

test("record stop delivers the finalized video for viewport captures", async () => {
  resetShared();
  const tid = 363;
  const config = baseConfig();
  await startViewportRecording(tid, config);
  try {
    state.recordingChunks.set(tid, ["aaa", "bbb"]);
    const stopped = await executeRecordStop(tid, config);
    assert.equal(stopped.data, "aaabbb");
    assert.equal(stopped.content_type, "video/mp4");
    assert.equal(stopped.stopped_reason, "user");
    assert.match(stopped.message, /user request/);
    assert.ok(Number.isFinite(stopped.duration));
  } finally {
    state.recordings.delete(tid);
    state.recordingChunks.delete(tid);
  }
});

test("record full-page pipeline measures layout and stops", async () => {
  resetShared();
  const tid = 364;
  const config = baseConfig();
  responses = new Map([
    [
      "Page.getLayoutMetrics",
      { cssContentSize: { width: 800.4, height: 600.6 } },
    ],
    ["Page.captureScreenshot", { data: "ZnVsbHBhZ2VqcGVn" }],
  ]);
  sendMessageImpl = async (message) => {
    if (message.type === "startRecording") {
      assert.equal(message.fullPage, true);
      assert.equal(message.width, 800);
      assert.equal(message.height, 601);
      return { ok: true, started: true };
    }
    if (message.type === "recordingFrame") {
      return undefined as unknown as never;
    }
    if (message.type === "finalizeRecording") {
      return { ok: true, contentType: "video/mp4" };
    }
    return undefined as unknown as never;
  };
  const started = await executeRecordStart(tid, true, config);
  assert.deepEqual(started, { started: true });
  try {
    state.recordingChunks.set(tid, ["full", "page"]);
    const stopped = await executeRecordStop(tid, config);
    assert.equal(stopped.data, "fullpage");
    assert.equal(stopped.content_type, "video/mp4");
    assert.equal(stopped.stopped_reason, "user");
  } finally {
    state.recordings.delete(tid);
    state.recordingChunks.delete(tid);
  }
});

test("record stop reports max_duration when the timer fires first", async () => {
  resetShared();
  const tid = 365;
  const config = {
    ...baseConfig(),
    maxRecordingDurationSec: 0.05,
  };
  await startViewportRecording(tid, config);
  try {
    state.recordingChunks.set(tid, ["late"]);
    // Wait for the 50ms max-duration timer to request a stop.
    await new Promise((resolve) => setTimeout(resolve, 150));
    const stopped = await executeRecordStop(tid, config);
    assert.equal(stopped.stopped_reason, "max_duration");
    assert.match(stopped.message, /maximum duration/);
    assert.equal(stopped.data, "late");
  } finally {
    state.recordings.delete(tid);
    state.recordingChunks.delete(tid);
  }
});

test("record stop without a session fails", async () => {
  resetShared();
  await assert.rejects(
    executeRecordStop(366, baseConfig()),
    /No active recording for tab 366/,
  );
});

test(
  "record start surfaces page-measure timeouts for full-page",
  { timeout: 10000 },
  async () => {
  resetShared();
  // measurePageSize waits up to 3s for layout metrics; hang it once.
  sendCommandHook = async (_target, method, _params) => {
    if (method === "Page.getLayoutMetrics") {
      return new Promise<never>(() => undefined);
    }
    return undefined;
  };
  sendMessageImpl = async (message) => {
    if (message.type === "startRecording") {
      return { ok: true, started: true };
    }
    return undefined as unknown as never;
  };
  await assert.rejects(
    executeRecordStart(367, true, baseConfig()),
    /could not measure the page/,
  );
  assert.equal(state.recordings.has(367), false);
  },
);
