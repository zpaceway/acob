import assert from "node:assert/strict";
import test from "node:test";

type DebuggerTarget = { tabId: number };

let tabsGetHandler: (tid: number) => Promise<unknown> = async (tid) => ({
  id: tid,
  windowId: 1,
});
let debuggerSendHandler: (
  method: string,
  params: Record<string, unknown> | undefined,
) => Promise<unknown> = async () => ({});

Object.defineProperty(globalThis, "chrome", {
  configurable: true,
  value: {
    tabs: {
      get: (tid: number) => tabsGetHandler(tid),
    },
    debugger: {
      onDetach: { addListener: () => undefined, removeListener: () => undefined },
      attach: async () => undefined,
      detach: async () => undefined,
      sendCommand: (
        _target: DebuggerTarget,
        method: string,
        params: Record<string, unknown> | undefined,
      ) => debuggerSendHandler(method, params),
    },
  },
});

const { executeWait } = await import("../src/wait.js");
const { ACOBSettings } = await import("../src/settings.js");
const { state } = await import("../src/state.js");

function configuration(overrides: Record<string, unknown> = {}) {
  return ACOBSettings.normalizeConfiguration({
    waitTimeoutMs: 1000,
    ...overrides,
  });
}

function reset() {
  state.reinstallScheduled = false;
  tabsGetHandler = async (tid) => ({ id: tid, windowId: 1 });
  debuggerSendHandler = async () => ({});
}

test("returns immediately when the selector already exists", async () => {
  reset();
  debuggerSendHandler = async (method) => {
    if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
    if (method === "DOM.querySelector") return { nodeId: 7 };
    return {};
  };
  const result = await executeWait(12, "button", undefined, configuration());
  assert.deepEqual(result, { waited: true, selector: "button" });
});

test("polls across transient navigation errors until the selector appears", async () => {
  reset();
  let calls = 0;
  debuggerSendHandler = async (method) => {
    if (method === "DOM.getDocument") {
      calls += 1;
      if (calls <= 2) {
        throw new Error("No document with given id");
      }
      return { root: { nodeId: 1 } };
    }
    if (method === "DOM.querySelector") {
      if (calls <= 2) return { nodeId: 0 };
      return calls < 4 ? { nodeId: 0 } : { nodeId: 9 };
    }
    return {};
  };
  const result = await executeWait(
    12,
    "button",
    5000,
    configuration({ waitTimeoutMs: 5000 }),
  );
  assert.deepEqual(result, { waited: true, selector: "button" });
  assert.ok(calls >= 3);
});

test("uses the explicit timeout_ms over the configured default", async () => {
  reset();
  debuggerSendHandler = async (method) => {
    if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
    if (method === "DOM.querySelector") return { nodeId: 0 };
    return {};
  };
  await assert.rejects(
    executeWait(12, "button", 50, configuration({ waitTimeoutMs: 5000 })),
    /Timed out waiting for selector: button/,
  );
});

test("times out with the configured default when timeout_ms is omitted", async () => {
  reset();
  debuggerSendHandler = async (method) => {
    if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
    if (method === "DOM.querySelector") return { nodeId: 0 };
    return {};
  };
  await assert.rejects(
    executeWait(12, "button", undefined, configuration({ waitTimeoutMs: 50 })),
    /Timed out waiting for selector/,
  );
});

test("fails fast on a closed tab", async () => {
  reset();
  tabsGetHandler = async () => {
    throw new Error("No tab with id: 99");
  };
  await assert.rejects(
    executeWait(99, "button", 1000, configuration()),
    /tab may be closed/,
  );
});

test("fails fast on an invalid selector", async () => {
  reset();
  debuggerSendHandler = async (method) => {
    if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
    if (method === "DOM.querySelector") {
      throw new Error("DOM.querySelector: '??' is not a valid selector");
    }
    return {};
  };
  await assert.rejects(
    executeWait(12, "??", 5000, configuration()),
    /Invalid selector/,
  );
});

test("fails fast on Chromium's DOM query error shape", async () => {
  reset();
  debuggerSendHandler = async (method) => {
    if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
    if (method === "DOM.querySelector") {
      throw new Error('{"code":-32000,"message":"DOM Error while querying"}');
    }
    return {};
  };
  await assert.rejects(
    executeWait(12, "??", 5000, configuration()),
    /Invalid selector: \?\?/,
  );
});

test("rejects out-of-range timeouts without polling", async () => {
  reset();
  let queried = false;
  debuggerSendHandler = async () => {
    queried = true;
    return {};
  };
  await assert.rejects(
    executeWait(12, "button", 0, configuration()),
    /Invalid wait timeout/,
  );
  assert.equal(queried, false);
});
