import assert from "node:assert/strict";
import test from "node:test";

type StoredMap = Record<string, unknown>;
const BID = "0123456789abcdef0123456789abcdef";

const stored: StoredMap = {
  bid: BID,
  baseUrl: "http://example.com",
  instructionsPerPoll: 2,
  maxConcurrentExecutions: 8,
};

let pollResponse: { status: number; body?: unknown } = { status: 204 };
let resultPosts: Array<{ url: string; body: Record<string, unknown> }> = [];
let runtimeReloadCalls = 0;
let createDocumentCalls = 0;
let failStorageGet = false;

type MessageListener = (
  message: unknown,
  sender: unknown,
  sendResponse: (response: unknown) => void,
) => boolean | undefined;

let onMessageListener: MessageListener | null = null;

Object.defineProperty(globalThis, "chrome", {
  configurable: true,
  value: {
    runtime: {
      onMessage: {
        addListener: (listener: MessageListener) => {
          onMessageListener = listener;
        },
        removeListener: () => undefined,
      },
      onInstalled: { addListener: () => undefined },
      onStartup: { addListener: () => undefined },
      getURL: (path: string) => `chrome-extension://acob/${path}`,
      getContexts: async () => [],
      reload: () => {
        runtimeReloadCalls += 1;
      },
    },
    storage: {
      local: {
        get: async (key?: string | string[]) => {
          if (failStorageGet) {
            throw new Error("storage unavailable");
          }
          if (typeof key === "string") {
            return key in stored ? { [key]: stored[key] } : {};
          }
          if (Array.isArray(key)) {
            const out: StoredMap = {};
            for (const k of key) {
              if (k in stored) {
                out[k] = stored[k];
              }
            }
            return out;
          }
          return { ...stored };
        },
        set: async (values: StoredMap) => {
          Object.assign(stored, values);
        },
        remove: async (key: string | string[]) => {
          for (const k of Array.isArray(key) ? key : [key]) {
            delete stored[k];
          }
        },
      },
    },
    offscreen: {
      createDocument: async () => {
        createDocumentCalls += 1;
      },
      closeDocument: async () => undefined,
    },
    tabs: {
      query: async () => [
        {
          id: 1,
          windowId: 1,
          active: true,
          title: "A",
          url: "https://a.example/",
        },
      ],
      get: async (tid: number) => ({
        id: tid,
        windowId: 1,
        active: true,
        title: "A",
        url: "https://a.example/",
        status: "complete",
      }),
      update: async (tid: number) => ({
        id: tid,
        windowId: 1,
        active: true,
        title: "A",
        url: "https://a.example/",
      }),
      create: async (options: Record<string, unknown>) => ({
        id: 50,
        windowId: 1,
        active: false,
        url: options.url,
      }),
      remove: async () => undefined,
      reload: async () => undefined,
      onUpdated: {
        addListener: () => undefined,
        removeListener: () => undefined,
      },
    },
    windows: {
      getAll: async () => [{ id: 1, focused: true }],
      get: async () => ({ focused: true }),
      update: async () => ({}),
    },
    debugger: {
      onDetach: { addListener: () => undefined, removeListener: () => undefined },
      attach: async () => undefined,
      detach: async () => undefined,
      sendCommand: async () => ({}),
    },
    proxy: {
      settings: { set: async () => undefined, clear: async () => undefined },
    },
    browsingData: { remove: async () => undefined },
  },
});

globalThis.fetch = (async (input: unknown, init?: unknown) => {
  const url = String(input);
  if (url.includes("settings.json")) {
    return Response.json({ baseUrl: "http://example.com" });
  }
  if (url.includes("/next/")) {
    if (pollResponse.status === 204) {
      return new Response(null, { status: 204 });
    }
    if (pollResponse.status !== 200) {
      return new Response("err", { status: pollResponse.status });
    }
    return Response.json(pollResponse.body);
  }
  if (url.includes("/result/")) {
    const body = JSON.parse(String((init as Record<string, unknown>).body));
    resultPosts.push({ url, body });
    return new Response("{}", { status: 200 });
  }
  if (url.includes("/acknowledge")) {
    return new Response("{}", { status: 200 });
  }
  if (url.includes("jquery.min.js") || url.includes("turndown.js")) {
    return new Response("/* lib */", { status: 200 });
  }
  return new Response("{}", { status: 200 });
}) as typeof fetch;

await import("../src/background.js");
const { state } = await import("../src/state.js");

function resetBackground(): void {
  pollResponse = { status: 204 };
  resultPosts = [];
  runtimeReloadCalls = 0;
  failStorageGet = false;
  state.pollInProgress = false;
  state.reinstallScheduled = false;
  state.activeExecutions = 0;
  state.backendUnavailable = false;
  state.recordingChunks.clear();
  state.recordings.clear();
  state.consoleSessions.clear();
  state.tabExecutionQueues.clear();
  state.browserInputQueue = Promise.resolve();
  state.proxyQueue = Promise.resolve();
  state.tabCreationQueue = Promise.resolve();
  state.activeJavaScriptExecutions.clear();
  delete stored.pendingReinstallToken;
  stored.bid = BID;
  stored.baseUrl = "http://example.com";
  stored.instructionsPerPoll = 2;
  stored.maxConcurrentExecutions = 8;
}

function sendMessage(message: unknown): Promise<unknown> {
  assert.ok(onMessageListener !== null);
  const listener = onMessageListener as MessageListener;
  return new Promise<unknown>((resolve) => {
    const returned = listener(message, {}, (response: unknown) => {
      resolve(response);
    });
    // Non-runtime messages never call sendResponse.
    if (returned === undefined) {
      setTimeout(() => resolve(undefined), 10);
    }
  });
}

test("background import ensures the offscreen document", async () => {
  assert.ok(createDocumentCalls >= 1);
  assert.ok(onMessageListener !== null);
});

test("poll with no instructions returns ok", async () => {
  resetBackground();
  pollResponse = { status: 204 };
  const response = (await sendMessage({ type: "poll" })) as { ok?: boolean };
  assert.equal(response.ok, true);
  assert.equal(resultPosts.length, 0);
});

test("poll executes one valid list instruction and posts bid", async () => {
  resetBackground();
  pollResponse = {
    status: 200,
    body: [{ id: 1, action: "list", payload: {} }],
  };
  const response = (await sendMessage({ type: "poll" })) as { ok?: boolean };
  assert.equal(response.ok, true);
  assert.equal(resultPosts.length, 1);
  assert.ok(resultPosts[0]?.url.includes("/1/result/"));
  assert.equal((resultPosts[0]?.body as Record<string, unknown>).bid, BID);
  assert.ok("result" in (resultPosts[0]?.body as Record<string, unknown>));
});

test("poll with invalid instruction still returns ok", async () => {
  resetBackground();
  const originalError = console.error;
  console.error = () => undefined;
  try {
    pollResponse = {
      status: 200,
      body: [{ id: "bad", action: "list" }],
    };
    const response = (await sendMessage({ type: "poll" })) as { ok?: boolean };
    assert.equal(response.ok, true);
    assert.equal(resultPosts.length, 0);
  } finally {
    console.error = originalError;
  }
});

test("poll handles a reinstall command via runtime reload", async () => {
  resetBackground();
  pollResponse = {
    status: 200,
    body: [{ action: "reinstall", payload: { token: "tok-1" } }],
  };
  const response = (await sendMessage({ type: "poll" })) as { ok?: boolean };
  assert.equal(response.ok, true);
  assert.equal(runtimeReloadCalls, 1);
  assert.equal(stored.pendingReinstallToken, "tok-1");
  // Reset for later tests (reinstall flag blocks polling).
  state.reinstallScheduled = false;
  delete stored.pendingReinstallToken;
});

test("poll skips bid-mismatched instructions", async () => {
  resetBackground();
  pollResponse = {
    status: 200,
    body: [
      {
        id: 2,
        action: "list",
        payload: {},
        bid: "ffffffffffffffffffffffffffffffff",
      },
    ],
  };
  const response = (await sendMessage({ type: "poll" })) as { ok?: boolean };
  assert.equal(response.ok, true);
  assert.equal(resultPosts.length, 0);
});

test("poll sends over-limit error results", async () => {
  resetBackground();
  // Limit is min(instructionsPerPoll=2, available=8) = 2.
  pollResponse = {
    status: 200,
    body: [
      { id: 10, action: "list", payload: {} },
      { id: 11, action: "list", payload: {} },
      { id: 12, action: "list", payload: {} },
      { id: 13, action: "list", payload: {} },
    ],
  };
  const response = (await sendMessage({ type: "poll" })) as { ok?: boolean };
  assert.equal(response.ok, true);
  assert.equal(resultPosts.length, 4);
  const errors = resultPosts.filter((post) =>
    String((post.body as Record<string, unknown>).error ?? "").includes(
      "more instructions than requested",
    ),
  );
  assert.equal(errors.length, 2);
});

test("recordingChunk appends to state", async () => {
  resetBackground();
  const first = (await sendMessage({
    type: "recordingChunk",
    tid: 5,
    data: "aaa",
  })) as { ok?: boolean };
  assert.equal(first.ok, true);
  const second = (await sendMessage({
    type: "recordingChunk",
    tid: 5,
    data: "bbb",
  })) as { ok?: boolean };
  assert.equal(second.ok, true);
  assert.deepEqual(state.recordingChunks.get(5), ["aaa", "bbb"]);
});

test("getConfiguration message returns configuration", async () => {
  resetBackground();
  const response = (await sendMessage({ type: "getConfiguration" })) as {
    baseUrl?: string;
  };
  assert.equal(response.baseUrl, "http://example.com");
});

test("getConfiguration message reports load errors", async () => {
  resetBackground();
  failStorageGet = true;
  try {
    const response = (await sendMessage({ type: "getConfiguration" })) as {
      error?: string;
    };
    assert.match(response.error ?? "", /storage unavailable/);
  } finally {
    failStorageGet = false;
  }
});

test("non-runtime messages are ignored", async () => {
  resetBackground();
  const response = await sendMessage({ type: "not-a-runtime-message" });
  assert.equal(response, undefined);
  const nonObject = await sendMessage("hello");
  assert.equal(nonObject, undefined);
});
