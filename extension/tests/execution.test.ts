import assert from "node:assert/strict";
import test from "node:test";

// ---------- Mutable mock state ----------

type MockTab = {
  id?: number | null;
  windowId: number;
  active: boolean;
  title?: string | null;
  url?: string | null;
  status?: string;
};

type TabListener = (
  tid: number,
  info: { status?: string },
  tab: MockTab,
) => void;

let tabsQueryResult: MockTab[] = [];
let tabsGetHandler: (tid: number) => Promise<MockTab> = async (tid) => ({
  id: tid,
  windowId: 1,
  active: true,
  title: "T",
  url: "https://example.com/",
  status: "complete",
});
let tabsUpdateHandler: (
  tid: number,
  update: Record<string, unknown>,
) => Promise<MockTab | null> = async (tid, update) => ({
  id: tid,
  windowId: 1,
  active: true,
  title: "T",
  url: (update.url as string | undefined) ?? "https://example.com/",
  status: "complete",
});
let tabsCreateHandler: (
  options: Record<string, unknown>,
) => Promise<MockTab | null> = async (options) => ({
  id: 50,
  windowId: 1,
  active: false,
  title: "New",
  url: options.url as string,
  status: "complete",
});
let tabsRemoveCalls: number[] = [];
let tabsReloadCalls: number[] = [];
let tabsReloadHandler: (tid: number) => Promise<void> = async (tid: number) => {
  tabsReloadCalls.push(tid);
  // Default: simulate loading -> complete for reloadTab.
  setTimeout(() => fireTabListeners(tid, "loading"), 1);
  setTimeout(() => fireTabListeners(tid, "complete"), 3);
};
const tabListeners = new Set<TabListener>();
function fireTabListeners(tid: number, status: string): void {
  for (const listener of [...tabListeners]) {
    listener(
      tid,
      { status },
      { id: tid, windowId: 1, active: true, status, url: "https://example.com/" },
    );
  }
}

let windowsGetAllResult: Array<{ id?: number; focused: boolean }> = [
  { id: 1, focused: true },
];
let windowsGetResult = { focused: true };

let debuggerSendHandler: (
  method: string,
  params: Record<string, unknown> | undefined,
) => Promise<unknown> = async (method, params) => {
  void params;
  return defaultCdpResponse(method, params);
};

function defaultCdpResponse(
  method: string,
  params: Record<string, unknown> | undefined,
): unknown {
  if (method === "Runtime.evaluate") {
    const expr = String((params?.expression as string | undefined) ?? "");
    if (expr.includes("cap.entries")) {
      return {
        result: {
          type: "object",
          value: {
            entries: [{ t: 1, level: "log", text: "hi" }],
            truncated: false,
          },
        },
      };
    }
    if (expr.includes("scrollingElement")) {
      return { result: { type: "object", value: { x: 10, y: 20 } } };
    }
    return { result: { type: "string", value: "ok" } };
  }
  if (method === "DOM.getDocument") {
    return { root: { nodeId: 1 } };
  }
  if (method === "DOM.querySelector") {
    return { nodeId: 2 };
  }
  if (method === "DOM.getContentQuads") {
    return { quads: [[0, 0, 10, 0, 10, 10, 0, 10]] };
  }
  if (method === "Page.getLayoutMetrics") {
    return {
      cssVisualViewport: {
        clientWidth: 1280,
        clientHeight: 720,
        offsetX: 0,
        offsetY: 0,
      },
      cssContentSize: { width: 1280, height: 720 },
    };
  }
  if (method === "Page.captureScreenshot") {
    return { data: "aGVsbG8=" };
  }
  return {};
}

let runtimeSendHandler: (message: Record<string, unknown>) => Promise<unknown> =
  async (message) => {
    if (message.type === "startRecording") {
      return { ok: true, started: true };
    }
    if (message.type === "recordingFrame") {
      return undefined;
    }
    if (message.type === "finalizeRecording") {
      return { ok: true, contentType: "video/mp4" };
    }
    return undefined;
  };

let proxySetCalls: unknown[] = [];
let proxyClearCalls = 0;
let browsingRemoveCalls = 0;
let contextsResult: unknown[] = [{ documentUrl: "chrome-extension://acob/offscreen.html" }];

let resultFetchCalls: Array<{ url: string; body: unknown }> = [];
let resultFetchHandler: (url: string, body: unknown) => Promise<Response> =
  async (url, body) => {
    resultFetchCalls.push({ url, body });
    return new Response("{}", { status: 200 });
  };

Object.defineProperty(globalThis, "chrome", {
  configurable: true,
  value: {
    tabs: {
      query: async () => [...tabsQueryResult],
      get: (tid: number) => tabsGetHandler(tid),
      update: (tid: number, update: Record<string, unknown>) =>
        tabsUpdateHandler(tid, update),
      create: (options: Record<string, unknown>) => tabsCreateHandler(options),
      remove: async (tid: number) => {
        tabsRemoveCalls.push(tid);
      },
      reload: (tid: number) => tabsReloadHandler(tid),
      onUpdated: {
        addListener: (listener: TabListener) => {
          tabListeners.add(listener);
        },
        removeListener: (listener: TabListener) => {
          tabListeners.delete(listener);
        },
      },
    },
    windows: {
      getAll: async () => [...windowsGetAllResult],
      get: async () => ({ ...windowsGetResult }),
      update: async () => ({}),
    },
    debugger: {
      onDetach: { addListener: () => undefined, removeListener: () => undefined },
      attach: async () => undefined,
      detach: async () => undefined,
      sendCommand: (
        _target: unknown,
        method: string,
        params: Record<string, unknown> | undefined,
      ) => debuggerSendHandler(method, params),
    },
    runtime: {
      getURL: (path: string) => `chrome-extension://acob/${path}`,
      getContexts: async () => [...contextsResult],
      sendMessage: (message: Record<string, unknown>) =>
        runtimeSendHandler(message),
    },
    offscreen: {
      createDocument: async () => undefined,
      closeDocument: async () => undefined,
    },
    proxy: {
      settings: {
        set: async (options: unknown) => {
          proxySetCalls.push(options);
        },
        clear: async () => {
          proxyClearCalls += 1;
        },
      },
    },
    browsingData: {
      remove: async () => {
        browsingRemoveCalls += 1;
      },
    },
    storage: {
      local: {
        get: async () => ({}),
        set: async () => undefined,
        remove: async () => undefined,
      },
    },
  },
});

globalThis.fetch = (async (input: unknown, init?: unknown) => {
  const url = String(input);
  if (url.includes("jquery.min.js") || url.includes("turndown.js")) {
    return new Response("/* lib */", { status: 200 });
  }
  if (url.includes("/result/")) {
    const body =
      init !== null &&
      typeof init === "object" &&
      "body" in (init as Record<string, unknown>)
        ? JSON.parse(String((init as Record<string, unknown>).body))
        : null;
    return resultFetchHandler(url, body);
  }
  return new Response("{}", { status: 200 });
}) as typeof fetch;

const { runInstruction, sendResult, executeInstruction } = await import(
  "../src/execution.js"
);
const { state } = await import("../src/state.js");
const { ACOBSettings } = await import("../src/settings.js");
import type { Bid, Configuration } from "../src/types.js";

const BID = "0123456789abcdef0123456789abcdef" as unknown as Bid;

function testConfiguration(overrides: Record<string, unknown> = {}): Configuration {
  return ACOBSettings.normalizeConfiguration({
    allowCleanup: true,
    maxTabs: 5,
    tabLoadTimeoutMs: 50,
    httpRequestTimeoutMs: 500,
    javascriptTimeoutMs: 500,
    maxScreenshotSizeMiB: 10,
    maxRecordingDurationSec: 1,
    maxRecordingSizeMiB: 1,
    consoleTimeoutSec: 10,
    consoleMaxSizeMiB: 1,
    resultRetryAttempts: 3,
    resultRetryDelayMs: 1,
    ...overrides,
  });
}

function resetExecution(): void {
  tabsQueryResult = [];
  tabsGetHandler = async (tid) => ({
    id: tid,
    windowId: 1,
    active: true,
    title: "T",
    url: "https://example.com/",
    status: "complete",
  });
  tabsUpdateHandler = async (tid, update) => ({
    id: tid,
    windowId: 1,
    active: true,
    title: "T",
    url: (update.url as string | undefined) ?? "https://example.com/",
    status: "complete",
  });
  tabsCreateHandler = async (options) => ({
    id: 50,
    windowId: 1,
    active: false,
    title: "New",
    url: options.url as string,
    status: "complete",
  });
  tabsRemoveCalls = [];
  tabsReloadCalls = [];
  tabsReloadHandler = async (tid: number) => {
    tabsReloadCalls.push(tid);
    setTimeout(() => fireTabListeners(tid, "loading"), 1);
    setTimeout(() => fireTabListeners(tid, "complete"), 3);
  };
  tabListeners.clear();
  windowsGetAllResult = [{ id: 1, focused: true }];
  windowsGetResult = { focused: true };
  debuggerSendHandler = async (method, params) =>
    defaultCdpResponse(method, params);
  runtimeSendHandler = async (message) => {
    if (message.type === "startRecording") {
      return { ok: true, started: true };
    }
    if (message.type === "recordingFrame") {
      return undefined;
    }
    if (message.type === "finalizeRecording") {
      return { ok: true, contentType: "video/mp4" };
    }
    return undefined;
  };
  proxySetCalls = [];
  proxyClearCalls = 0;
  browsingRemoveCalls = 0;
  contextsResult = [{ documentUrl: "chrome-extension://acob/offscreen.html" }];
  resultFetchCalls = [];
  resultFetchHandler = async (url, body) => {
    resultFetchCalls.push({ url, body });
    return new Response("{}", { status: 200 });
  };
  state.reinstallScheduled = false;
  state.tabExecutionQueues.clear();
  state.browserInputQueue = Promise.resolve();
  state.proxyQueue = Promise.resolve();
  state.tabCreationQueue = Promise.resolve();
  state.recordings.clear();
  state.recordingChunks.clear();
  state.consoleSessions.clear();
  state.activeJavaScriptExecutions.clear();
  state.activeExecutions = 0;
  state.pollInProgress = false;
}

// ---------- dispatch: every action ----------

test("runInstruction dispatches list with focused-window mapping", async () => {
  resetExecution();
  tabsQueryResult = [
    { id: 1, windowId: 1, active: true, title: "A", url: "https://a.example/" },
    { id: 2, windowId: 2, active: true, title: "B", url: "https://b.example/" },
  ];
  windowsGetAllResult = [
    { id: 1, focused: true },
    { id: 2, focused: false },
  ];
  const result = (await runInstruction(
    { id: 1, action: "list", payload: {} },
    testConfiguration(),
  )) as Array<{ tid: number; focused: boolean }>;
  assert.equal(result.length, 2);
  assert.equal(result[0]?.focused, true);
  assert.equal(result[1]?.focused, false);
});

test("runInstruction dispatches close", async () => {
  resetExecution();
  const result = (await runInstruction(
    { id: 1, action: "close", payload: { tid: 5 } },
    testConfiguration(),
  )) as { closed: boolean };
  assert.equal(result.closed, true);
  assert.deepEqual(tabsRemoveCalls, [5]);
});

test("runInstruction dispatches focus", async () => {
  resetExecution();
  const result = (await runInstruction(
    { id: 1, action: "focus", payload: { tid: 6 } },
    testConfiguration(),
  )) as { tid: number };
  assert.equal(result.tid, 6);
});

test("runInstruction dispatches navigate with tid", async () => {
  resetExecution();
  tabsUpdateHandler = async (tid, update) => ({
    id: tid,
    windowId: 1,
    active: true,
    title: "Nav",
    url: update.url as string,
    status: "complete",
  });
  tabsGetHandler = async (tid) => ({
    id: tid,
    windowId: 1,
    active: true,
    title: "Nav",
    url: "https://n.example/",
    status: "complete",
  });
  const result = (await runInstruction(
    { id: 1, action: "navigate", payload: { tid: 7, url: "https://n.example/" } },
    testConfiguration(),
  )) as { tid: number; url: string | null };
  assert.equal(result.tid, 7);
  assert.equal(result.url, "https://n.example/");
});

test("runInstruction dispatches navigate without tid", async () => {
  resetExecution();
  tabsQueryResult = [];
  tabsCreateHandler = async (options) => ({
    id: 51,
    windowId: 1,
    active: false,
    title: "Created",
    url: options.url as string,
    status: "complete",
  });
  tabsGetHandler = async (tid) => ({
    id: tid,
    windowId: 1,
    active: false,
    title: "Created",
    url: "https://c.example/",
    status: "complete",
  });
  const result = (await runInstruction(
    { id: 1, action: "navigate", payload: { url: "https://c.example/" } },
    testConfiguration(),
  )) as { tid: number };
  assert.equal(result.tid, 51);
});

test("runInstruction navigate throws when Chromium returns no tab", async () => {
  resetExecution();
  tabsUpdateHandler = async () => null;
  await assert.rejects(
    runInstruction(
      { id: 1, action: "navigate", payload: { tid: 8, url: "https://x.example/" } },
      testConfiguration(),
    ),
    /did not return the navigated tab/,
  );
});

test("runInstruction dispatches reload", async () => {
  resetExecution();
  const result = (await runInstruction(
    { id: 1, action: "reload", payload: { tid: 9 } },
    testConfiguration(),
  )) as { tid: number };
  assert.equal(result.tid, 9);
});

test("runInstruction dispatches scroll", async () => {
  resetExecution();
  const result = (await runInstruction(
    { id: 1, action: "scroll", payload: { tid: 10, y: 100 } },
    testConfiguration(),
  )) as { scrolled: boolean; y: number };
  assert.equal(result.scrolled, true);
  assert.equal(result.y, 100);
});

test("runInstruction dispatches javascript", async () => {
  resetExecution();
  const result = await runInstruction(
    { id: 1, action: "javascript", payload: { tid: 11, script: "1+1" } },
    testConfiguration(),
  );
  assert.equal(result, "ok");
});

test("runInstruction dispatches click", async () => {
  resetExecution();
  const result = (await runInstruction(
    { id: 1, action: "click", payload: { tid: 12, selector: "button" } },
    testConfiguration(),
  )) as { clicked: boolean };
  assert.equal(result.clicked, true);
});

test("runInstruction dispatches wait", async () => {
  resetExecution();
  const result = (await runInstruction(
    { id: 1, action: "wait", payload: { tid: 12, selector: "button" } },
    testConfiguration(),
  )) as { waited: boolean; selector: string };
  assert.equal(result.waited, true);
  assert.equal(result.selector, "button");
});

test("runInstruction dispatches wait with timeout_ms", async () => {
  resetExecution();
  const result = (await runInstruction(
    {
      id: 1,
      action: "wait",
      payload: { tid: 12, selector: "button", timeout_ms: 5000 },
    },
    testConfiguration(),
  )) as { waited: boolean };
  assert.equal(result.waited, true);
});

test("runInstruction dispatches keyboard text", async () => {
  resetExecution();
  const result = (await runInstruction(
    { id: 1, action: "keyboard", payload: { tid: 13, text: "hi" } },
    testConfiguration(),
  )) as { inserted_characters: number };
  assert.equal(result.inserted_characters, 2);
});

test("runInstruction dispatches screenshot with default full_page", async () => {
  resetExecution();
  const result = (await runInstruction(
    { id: 1, action: "screenshot", payload: { tid: 14 } },
    testConfiguration(),
  )) as { data: string };
  assert.equal(result.data, "aGVsbG8=");
});

test("runInstruction dispatches proxy set and unset", async () => {
  resetExecution();
  const setResult = (await runInstruction(
    { id: 1, action: "proxy", payload: { method: "set", proxy: "http://127.0.0.1:8080" } },
    testConfiguration(),
  )) as { proxied: boolean };
  assert.equal(setResult.proxied, true);
  assert.equal(proxySetCalls.length, 1);
  const unsetResult = (await runInstruction(
    { id: 2, action: "proxy", payload: { method: "unset" } },
    testConfiguration(),
  )) as { proxied: boolean };
  assert.equal(unsetResult.proxied, false);
  assert.equal(proxyClearCalls, 1);
});

test("runInstruction dispatches cleanup", async () => {
  resetExecution();
  const result = (await runInstruction(
    { id: 1, action: "cleanup", payload: {} },
    testConfiguration(),
  )) as { cleaned: boolean };
  assert.equal(result.cleaned, true);
  assert.equal(browsingRemoveCalls, 1);
});

test("runInstruction dispatches record start and stop", async () => {
  resetExecution();
  const config = testConfiguration();
  const started = (await runInstruction(
    { id: 1, action: "record", payload: { method: "start", tid: 15 } },
    config,
  )) as { started: boolean };
  assert.equal(started.started, true);
  const stopped = (await runInstruction(
    { id: 2, action: "record", payload: { method: "stop", tid: 15 } },
    config,
  )) as { content_type: string; stopped_reason: string };
  assert.equal(stopped.content_type, "video/mp4");
  assert.equal(stopped.stopped_reason, "user");
});

test("runInstruction dispatches console start, capture, stop", async () => {
  resetExecution();
  const config = testConfiguration();
  const started = (await runInstruction(
    { id: 1, action: "console", payload: { method: "start", tid: 16 } },
    config,
  )) as { started: boolean };
  assert.equal(started.started, true);
  const captured = (await runInstruction(
    { id: 2, action: "console", payload: { method: "capture", tid: 16 } },
    config,
  )) as { entries: number };
  assert.equal(captured.entries, 1);
  const stopped = (await runInstruction(
    { id: 3, action: "console", payload: { method: "stop", tid: 16 } },
    config,
  )) as { entries: number };
  assert.equal(stopped.entries, 1);
});

test("runInstruction dispatches batch without input actions", async () => {
  resetExecution();
  tabsQueryResult = [
    { id: 1, windowId: 1, active: true, title: "A", url: "https://a.example/" },
  ];
  const result = (await runInstruction(
    {
      id: 1,
      action: "batch",
      payload: { actions: [{ action: "list" }, { action: "list" }] },
    },
    testConfiguration(),
  )) as Array<{ result?: unknown; error?: string }>;
  assert.equal(result.length, 2);
  assert.ok("result" in result[0]!);
  assert.ok("result" in result[1]!);
});

test("runInstruction dispatches batch with input actions held", async () => {
  resetExecution();
  tabsQueryResult = [
    { id: 1, windowId: 1, active: true, title: "A", url: "https://a.example/" },
  ];
  const result = (await runInstruction(
    {
      id: 1,
      action: "batch",
      payload: {
        actions: [
          { action: "focus", tid: 1 },
          { action: "list" },
        ],
      },
    },
    testConfiguration(),
  )) as Array<{ result?: unknown; error?: string }>;
  assert.equal(result.length, 2);
  assert.ok("result" in result[0]!);
  assert.ok("result" in result[1]!);
});

test("runInstruction batch captures sub-action errors", async () => {
  resetExecution();
  tabsQueryResult = [];
  tabsGetHandler = async (tid) => {
    if (tid === 999) {
      throw new Error("no such tab 999");
    }
    return {
      id: tid,
      windowId: 1,
      active: true,
      title: "T",
      url: "https://example.com/",
      status: "complete",
    };
  };
  const result = (await runInstruction(
    {
      id: 1,
      action: "batch",
      payload: {
        actions: [{ action: "list" }, { action: "close", tid: 999 }],
      },
    },
    testConfiguration(),
  )) as Array<{ result?: unknown; error?: string }>;
  assert.equal(result.length, 2);
  assert.ok("result" in result[0]!);
  assert.ok("error" in result[1]!);
  assert.match(String(result[1]?.error ?? ""), /no such tab 999/);
});

test("runInstruction batch short-circuits on reinstall", async () => {
  resetExecution();
  state.reinstallScheduled = true;
  try {
    const result = (await runInstruction(
      {
        id: 1,
        action: "batch",
        payload: { actions: [{ action: "list" }, { action: "list" }] },
      },
      testConfiguration(),
    )) as Array<{ error?: string }>;
    assert.equal(result.length, 2);
    assert.equal(result[0]?.error, "Extension reinstall is in progress");
    assert.equal(result[1]?.error, "Extension reinstall is in progress");
  } finally {
    state.reinstallScheduled = false;
  }
});

test("runInstruction throws on unknown action", async () => {
  resetExecution();
  await assert.rejects(
    runInstruction(
      { id: 1, action: "bogus", payload: {} } as unknown as Parameters<
        typeof runInstruction
      >[0],
      testConfiguration(),
    ),
    /Unknown action/,
  );
});

// ---------- queue routing ----------

test("runInstruction serializes same-tid work", async () => {
  resetExecution();
  const events: string[] = [];
  tabsGetHandler = async (tid) => {
    events.push(`start-${tid}`);
    await new Promise((resolve) => setTimeout(resolve, 15));
    events.push(`end-${tid}`);
    return {
      id: tid,
      windowId: 1,
      active: true,
      title: "T",
      url: "https://example.com/",
      status: "complete",
    };
  };
  await Promise.all([
    runInstruction({ id: 1, action: "close", payload: { tid: 21 } }, testConfiguration()),
    runInstruction({ id: 2, action: "close", payload: { tid: 21 } }, testConfiguration()),
  ]);
  assert.deepEqual(events, ["start-21", "end-21", "start-21", "end-21"]);
});

test("runInstruction runs different tids in parallel", async () => {
  resetExecution();
  const events: string[] = [];
  tabsGetHandler = async (tid) => {
    events.push(`start-${tid}`);
    await new Promise((resolve) => setTimeout(resolve, 15));
    events.push(`end-${tid}`);
    return {
      id: tid,
      windowId: 1,
      active: true,
      title: "T",
      url: "https://example.com/",
      status: "complete",
    };
  };
  await Promise.all([
    runInstruction({ id: 1, action: "close", payload: { tid: 22 } }, testConfiguration()),
    runInstruction({ id: 2, action: "close", payload: { tid: 23 } }, testConfiguration()),
  ]);
  assert.equal(events[0], "start-22");
  assert.equal(events[1], "start-23");
  assert.ok(events.includes("end-22"));
  assert.ok(events.includes("end-23"));
});

test("runInstruction bypasses the tab queue when held", async () => {
  resetExecution();
  const events: string[] = [];
  tabsGetHandler = async (tid) => {
    events.push(`start-${tid}`);
    await new Promise((resolve) => setTimeout(resolve, 15));
    events.push(`end-${tid}`);
    return {
      id: tid,
      windowId: 1,
      active: true,
      title: "T",
      url: "https://example.com/",
      status: "complete",
    };
  };
  const config = testConfiguration();
  await Promise.all([
    runInstruction({ id: 1, action: "close", payload: { tid: 24 } }, config, {
      browserInput: false,
      tabs: true,
    }),
    runInstruction({ id: 2, action: "close", payload: { tid: 24 } }, config, {
      browserInput: false,
      tabs: true,
    }),
  ]);
  assert.equal(events[0], "start-24");
  assert.equal(events[1], "start-24");
});

// ---------- sendResult ----------

test("sendResult posts bid on success", async () => {
  resetExecution();
  const config = testConfiguration();
  await sendResult(7, { result: [1] }, config, BID);
  assert.equal(resultFetchCalls.length, 1);
  assert.ok(resultFetchCalls[0]?.url.includes("/7/result/"));
  assert.deepEqual(
    (resultFetchCalls[0]?.body as Record<string, unknown>).bid,
    BID,
  );
});

test("sendResult retries then succeeds", async () => {
  resetExecution();
  let attempts = 0;
  resultFetchHandler = async (url, body) => {
    attempts += 1;
    resultFetchCalls.push({ url, body });
    if (attempts === 1) {
      return new Response("err", { status: 500 });
    }
    return new Response("{}", { status: 200 });
  };
  await sendResult(8, { result: null, error: "x" }, testConfiguration(), BID);
  assert.equal(attempts, 2);
});

test("sendResult throws after final HTTP error", async () => {
  resetExecution();
  resultFetchHandler = async (url, body) => {
    resultFetchCalls.push({ url, body });
    return new Response("err", { status: 500 });
  };
  await assert.rejects(
    sendResult(9, { result: 1 }, testConfiguration(), BID),
    /Could not submit result: HTTP 500/,
  );
  assert.equal(resultFetchCalls.length, 3);
});

test("sendResult short-circuits when reinstall is scheduled", async () => {
  resetExecution();
  state.reinstallScheduled = true;
  try {
    await sendResult(10, { result: 1 }, testConfiguration(), BID);
    assert.equal(resultFetchCalls.length, 0);
  } finally {
    state.reinstallScheduled = false;
  }
});

test("sendResult recovers from a network throw", async () => {
  resetExecution();
  let attempts = 0;
  resultFetchHandler = async (url, body) => {
    attempts += 1;
    resultFetchCalls.push({ url, body });
    if (attempts === 1) {
      throw new Error("network down");
    }
    return new Response("{}", { status: 200 });
  };
  await sendResult(11, { result: 1 }, testConfiguration(), BID);
  assert.equal(attempts, 2);
});

test("sendResult throws after final network error", async () => {
  resetExecution();
  resultFetchHandler = async (url, body) => {
    resultFetchCalls.push({ url, body });
    throw new Error("always down");
  };
  await assert.rejects(
    sendResult(12, { result: 1 }, testConfiguration(), BID),
    /always down/,
  );
  assert.equal(resultFetchCalls.length, 3);
});

// ---------- executeInstruction ----------

test("executeInstruction skips bid-mismatched instructions silently", async () => {
  resetExecution();
  await executeInstruction(
    { id: 1, action: "list", payload: {}, bid: "ffffffffffffffffffffffffffffffff" as unknown as Bid },
    testConfiguration(),
    BID,
  );
  assert.equal(resultFetchCalls.length, 0);
});

test("executeInstruction skips when reinstall is scheduled", async () => {
  resetExecution();
  state.reinstallScheduled = true;
  try {
    await executeInstruction(
      { id: 1, action: "list", payload: {} },
      testConfiguration(),
      BID,
    );
    assert.equal(resultFetchCalls.length, 0);
  } finally {
    state.reinstallScheduled = false;
  }
});

test("executeInstruction reports unsupported actions as error results", async () => {
  resetExecution();
  await executeInstruction(
    { id: 3, action: "click", payload: {} },
    testConfiguration(),
    BID,
  );
  assert.equal(resultFetchCalls.length, 1);
  const body = resultFetchCalls[0]?.body as { error?: string };
  assert.match(body.error ?? "", /Unsupported or invalid instruction/);
});

test("executeInstruction submits success bodies", async () => {
  resetExecution();
  tabsQueryResult = [];
  await executeInstruction(
    { id: 4, action: "list", payload: {} },
    testConfiguration(),
    BID,
  );
  assert.equal(resultFetchCalls.length, 1);
  const body = resultFetchCalls[0]?.body as { result?: unknown };
  assert.ok("result" in body);
});
