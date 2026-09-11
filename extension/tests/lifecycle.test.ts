import assert from "node:assert/strict";
import test from "node:test";

type StoredMap = Record<string, unknown>;

const stored: StoredMap = {};
let storageGetCalls = 0;
let storageSetCalls: StoredMap[] = [];
let storageRemoveCalls: Array<string | string[]> = [];
let fetchCalls: string[] = [];
let fetchHandler: (url: string) => Promise<Response> = async (url: string) => {
  fetchCalls.push(url);
  return Response.json({ baseUrl: "http://example.com" });
};
let contextsResult: Array<{ documentUrl?: string }> = [];
let createDocumentCalls: unknown[] = [];
let closeDocumentCalls = 0;
let runtimeReloadCalls = 0;
type TabUpdateListener = (
  tid: number,
  info: { status?: string },
  tab: Record<string, unknown>,
) => void;
const tabListeners = new Set<TabUpdateListener>();
let tabsReloadHandler: (tid: number) => Promise<void> = async () => undefined;
let tabsReloadCalls: number[] = [];

Object.defineProperty(globalThis, "chrome", {
  configurable: true,
  value: {
    storage: {
      local: {
        get: async (key?: string | string[]) => {
          storageGetCalls += 1;
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
          storageSetCalls.push({ ...values });
          Object.assign(stored, values);
        },
        remove: async (key: string | string[]) => {
          storageRemoveCalls.push(key);
          for (const k of Array.isArray(key) ? key : [key]) {
            delete stored[k];
          }
        },
      },
    },
    runtime: {
      getURL: (path: string) => `chrome-extension://acob/${path}`,
      getContexts: async () => [...contextsResult],
      reload: () => {
        runtimeReloadCalls += 1;
      },
    },
    offscreen: {
      createDocument: async (options: unknown) => {
        createDocumentCalls.push(options);
      },
      closeDocument: async () => {
        closeDocumentCalls += 1;
      },
    },
    tabs: {
      get: async (tid: number) => ({ id: tid, windowId: 7, status: "complete" }),
      reload: (tid: number) => {
        tabsReloadCalls.push(tid);
        return tabsReloadHandler(tid);
      },
      onUpdated: {
        addListener: (listener: TabUpdateListener) => {
          tabListeners.add(listener);
        },
        removeListener: (listener: TabUpdateListener) => {
          tabListeners.delete(listener);
        },
      },
    },
  },
});

globalThis.fetch = ((input: unknown, _init?: unknown) => {
  const url = String(input);
  return fetchHandler(url);
}) as typeof fetch;

const lifecycle = await import("../src/lifecycle.js");
const { state } = await import("../src/state.js");
const { ACOBSettings } = await import("../src/settings.js");
import type { Bid, Configuration } from "../src/types.js";

function testConfiguration(): Configuration {
  return ACOBSettings.normalizeConfiguration({
    baseUrl: "http://127.0.0.1:58346",
    tabLoadTimeoutMs: 50,
    httpRequestTimeoutMs: 200,
  });
}

function resetLifecycleMocks(): void {
  for (const key of Object.keys(stored)) {
    delete stored[key];
  }
  storageGetCalls = 0;
  storageSetCalls = [];
  storageRemoveCalls = [];
  fetchCalls = [];
  contextsResult = [];
  createDocumentCalls = [];
  closeDocumentCalls = 0;
  runtimeReloadCalls = 0;
  tabListeners.clear();
  tabsReloadCalls = [];
  tabsReloadHandler = async () => undefined;
  state.reinstallScheduled = false;
  state.activeJavaScriptExecutions.clear();
  state.tabCreationQueue = Promise.resolve();
  state.tabExecutionQueues.clear();
}

function fireTabUpdate(tid: number, status: string): void {
  for (const listener of [...tabListeners]) {
    listener(tid, { status }, { id: tid, windowId: 7, status });
  }
}

// --- getConfiguration caching ---

test("getConfiguration concurrent failures share and reset the cached promise", async () => {
  resetLifecycleMocks();
  fetchHandler = async (url: string) => {
    fetchCalls.push(url);
    await new Promise((resolve) => setTimeout(resolve, 10));
    return new Response("oops", { status: 500 });
  };
  const first = lifecycle.getConfiguration();
  const second = lifecycle.getConfiguration();
  await assert.rejects(first, /Could not load initial settings/);
  await assert.rejects(second, /Could not load initial settings|oops|HTTP 500/);
  // Failure must reset so the next call retries.
  fetchHandler = async (url: string) => {
    fetchCalls.push(url);
    return Response.json({ baseUrl: "http://retry.example" });
  };
  const retry = await lifecycle.getConfiguration();
  assert.equal(retry.baseUrl, "http://retry.example");
});

test("getConfiguration concurrent successes share the in-flight promise then reload", async () => {
  // At this point the cached promise is resolved; fire two concurrent
  // callers that both await it and then reload.
  const beforeGets = storageGetCalls;
  const beforeFetches = fetchCalls.length;
  void beforeFetches;
  fetchHandler = async (url: string) => {
    fetchCalls.push(url);
    return Response.json({ baseUrl: "http://retry.example" });
  };
  // Seed stored config so reloads do not hit fetch.
  stored.baseUrl = "http://retry.example";
  const [first, second] = await Promise.all([
    lifecycle.getConfiguration(),
    lifecycle.getConfiguration(),
  ]);
  assert.deepEqual(first, second);
  assert.ok(storageGetCalls >= beforeGets + 2);
});

test("getConfiguration reloads after resolve", async () => {
  const before = storageGetCalls;
  stored.baseUrl = "http://reload.example";
  const config = await lifecycle.getConfiguration();
  assert.equal(config.baseUrl, "http://reload.example");
  assert.ok(storageGetCalls >= before + 1);
});

test("loadConfiguration rejects when bundled settings are not an object", async () => {
  for (const key of Object.keys(stored)) {
    delete stored[key];
  }
  fetchHandler = async (url: string) => {
    fetchCalls.push(url);
    return Response.json([1, 2, 3]);
  };
  await assert.rejects(
    lifecycle.getConfiguration(),
    /Bundled settings must be a JSON object/,
  );
  // Restore a valid fetch for later tests and re-seed stored config.
  fetchHandler = async (url: string) => {
    fetchCalls.push(url);
    return Response.json({ baseUrl: "http://retry.example" });
  };
  stored.baseUrl = "http://retry.example";
  const config = await lifecycle.getConfiguration();
  assert.equal(config.baseUrl, "http://retry.example");
});

// --- URL builders ---

test("instructionApiUrl trims trailing slashes", () => {
  const config = ACOBSettings.normalizeConfiguration({
    baseUrl: "http://example.com///",
  });
  // normalizeConfiguration already trims, so build via raw object.
  const raw = { ...config, baseUrl: "http://example.com///" };
  assert.equal(
    lifecycle.instructionApiUrl(raw),
    "http://example.com/api/instructions",
  );
  assert.equal(
    lifecycle.instructionApiUrl(config),
    "http://example.com/api/instructions",
  );
});

test("nextInstructionsUrl and instructionResultUrl encode bid and trim", () => {
  const raw = {
    ...testConfiguration(),
    baseUrl: "http://example.com///",
  };
  const bid = "0123456789abcdef0123456789abcdef" as unknown as Bid;
  assert.equal(
    lifecycle.nextInstructionsUrl(raw, bid, 4),
    "http://example.com/api/instructions/next/?bid=0123456789abcdef0123456789abcdef&limit=4",
  );
  assert.equal(
    lifecycle.instructionResultUrl(raw, 12),
    "http://example.com/api/instructions/12/result/",
  );
  const special = "a b+c/d" as unknown as Bid;
  assert.ok(
    lifecycle.nextInstructionsUrl(raw, special, 1).includes("bid=a%20b%2Bc%2Fd"),
  );
});

// --- acknowledgePendingReinstall ---

test("acknowledgePendingReinstall does nothing without a token", async () => {
  resetLifecycleMocks();
  let fetched = false;
  const priorHandler = fetchHandler;
  fetchHandler = async (url: string) => {
    fetched = true;
    return priorHandler(url);
  };
  try {
    await lifecycle.acknowledgePendingReinstall(testConfiguration());
    assert.equal(fetched, false);
    assert.deepEqual(storageRemoveCalls, []);
  } finally {
    fetchHandler = priorHandler;
  }
});

test("acknowledgePendingReinstall removes the key on ok", async () => {
  resetLifecycleMocks();
  stored.pendingReinstallToken = "tok-1";
  fetchHandler = async (url: string) => {
    fetchCalls.push(url);
    assert.ok(url.endsWith("/api/reinstall/acknowledge/"));
    return new Response("{}", { status: 200 });
  };
  await lifecycle.acknowledgePendingReinstall(testConfiguration());
  assert.deepEqual(storageRemoveCalls, ["pendingReinstallToken"]);
  assert.ok(!("pendingReinstallToken" in stored));
});

test("acknowledgePendingReinstall throws on non-ok non-409", async () => {
  resetLifecycleMocks();
  stored.pendingReinstallToken = "tok-2";
  fetchHandler = async () => new Response("err", { status: 500 });
  await assert.rejects(
    lifecycle.acknowledgePendingReinstall(testConfiguration()),
    /Could not acknowledge extension reinstall: HTTP 500/,
  );
  assert.deepEqual(storageRemoveCalls, []);
});

test("acknowledgePendingReinstall removes the key on 409", async () => {
  resetLifecycleMocks();
  stored.pendingReinstallToken = "tok-3";
  fetchHandler = async () => new Response("gone", { status: 409 });
  await lifecycle.acknowledgePendingReinstall(testConfiguration());
  assert.deepEqual(storageRemoveCalls, ["pendingReinstallToken"]);
});

// --- executeReinstallCommand ---

test("executeReinstallCommand stores token, schedules reinstall, reloads", async () => {
  resetLifecycleMocks();
  const config = testConfiguration();
  await lifecycle.executeReinstallCommand(config, "tok-xyz");
  assert.equal(stored.pendingReinstallToken, "tok-xyz");
  assert.equal(state.reinstallScheduled, true);
  assert.equal(runtimeReloadCalls, 1);
  state.reinstallScheduled = false;
});

// --- stopActiveJavaScriptExecutions ---

test("stopActiveJavaScriptExecutions stops, reloads distinct tids, waits", async () => {
  resetLifecycleMocks();
  const stops: number[] = [];
  const finishes: number[] = [];
  tabsReloadHandler = async (tid: number) => {
    if (tid === 20) {
      throw new Error("reload failed");
    }
    // Simulate loading -> complete for successful reloads.
    setTimeout(() => fireTabUpdate(tid, "loading"), 2);
    setTimeout(() => fireTabUpdate(tid, "complete"), 5);
  };
  state.activeJavaScriptExecutions.add({
    tid: 10,
    stop: async () => {
      stops.push(10);
    },
    finished: new Promise<void>((resolve) => {
      finishes.push(10);
      resolve();
    }),
  });
  state.activeJavaScriptExecutions.add({
    tid: 10,
    stop: async () => {
      stops.push(11);
      throw new Error("stop failed");
    },
    finished: Promise.resolve(),
  });
  state.activeJavaScriptExecutions.add({
    tid: 20,
    stop: async () => {
      stops.push(20);
    },
    finished: Promise.resolve(),
  });
  const config = testConfiguration();
  await lifecycle.stopActiveJavaScriptExecutions(config);
  assert.deepEqual([...stops].sort((a, b) => a - b), [10, 11, 20]);
  assert.deepEqual([...tabsReloadCalls].sort((a, b) => a - b), [10, 20]);
  assert.deepEqual(finishes, [10]);
  assert.equal(tabListeners.size, 0);
  state.activeJavaScriptExecutions.clear();
});

test("stopActiveJavaScriptExecutions with no executions does nothing", async () => {
  resetLifecycleMocks();
  await lifecycle.stopActiveJavaScriptExecutions(testConfiguration());
  assert.deepEqual(tabsReloadCalls, []);
});

// --- ensureOffscreenDocument ---

test("ensureOffscreenDocument creates when absent", async () => {
  resetLifecycleMocks();
  contextsResult = [];
  await lifecycle.ensureOffscreenDocument(false);
  assert.equal(createDocumentCalls.length, 1);
  assert.deepEqual(createDocumentCalls[0], {
    url: "offscreen.html",
    reasons: ["WORKERS", "USER_MEDIA"],
    justification:
      "Poll the ACOB server for browser instructions and encode tab recordings",
  });
  assert.equal(closeDocumentCalls, 0);
});

test("ensureOffscreenDocument skips when present", async () => {
  resetLifecycleMocks();
  contextsResult = [{ documentUrl: "chrome-extension://acob/offscreen.html" }];
  await lifecycle.ensureOffscreenDocument(false);
  assert.equal(createDocumentCalls.length, 0);
  assert.equal(closeDocumentCalls, 0);
});

test("ensureOffscreenDocument recreates when asked", async () => {
  resetLifecycleMocks();
  contextsResult = [{ documentUrl: "chrome-extension://acob/offscreen.html" }];
  await lifecycle.ensureOffscreenDocument(true);
  assert.equal(closeDocumentCalls, 1);
  assert.equal(createDocumentCalls.length, 1);
});

test("ensureOffscreenDocument creates when recreate requested but absent", async () => {
  resetLifecycleMocks();
  contextsResult = [];
  await lifecycle.ensureOffscreenDocument(true);
  assert.equal(closeDocumentCalls, 0);
  assert.equal(createDocumentCalls.length, 1);
});
