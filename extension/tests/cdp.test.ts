import assert from "node:assert/strict";
import test from "node:test";

type DetachListener = (
  source: { tabId?: number },
  reason: string,
) => void;

const attachCalls: Array<{ target: unknown; version: string }> = [];
const detachCalls: Array<unknown> = [];
const sendCommandCalls: Array<{
  target: unknown;
  method: string;
  params: unknown;
}> = [];
let detachListener: DetachListener | null = null;
let sendCommandImpl: (
  target: unknown,
  method: string,
  params: unknown,
) => Promise<unknown> = async () => ({});

Object.defineProperty(globalThis, "chrome", {
  configurable: true,
  value: {
    debugger: {
      onDetach: {
        addListener: (listener: DetachListener) => {
          detachListener = listener;
        },
        removeListener: () => undefined,
      },
      attach: async (target: unknown, version: string) => {
        attachCalls.push({ target, version });
      },
      detach: async (target: unknown) => {
        detachCalls.push(target);
      },
      sendCommand: async (
        target: unknown,
        method: string,
        params: unknown,
      ) => {
        sendCommandCalls.push({ target, method, params });
        return sendCommandImpl(target, method, params);
      },
    },
    webRequest: {
      onAuthRequired: {
        addListener: () => undefined,
      },
    },
  },
});

const {
  acquireDebugger,
  releaseDebugger,
  sendCdpCommand,
  throwEvaluationException,
  withDebugger,
} = await import("../src/cdp.js");

function resetCalls(): void {
  attachCalls.length = 0;
  detachCalls.length = 0;
  sendCommandCalls.length = 0;
  sendCommandImpl = async () => ({});
}

function getDetachListener(): DetachListener {
  assert.ok(detachListener !== null, "onDetach listener must be registered");
  return detachListener;
}

test("acquireDebugger reuses an attached session and bumps refcount", async () => {
  resetCalls();
  const first = await acquireDebugger(101, "1.3");
  const second = await acquireDebugger(101, "1.3");
  assert.equal(attachCalls.length, 1);
  assert.equal(first, second);
  assert.deepEqual(first, { tabId: 101 });
  // One release keeps the session (refcount 2 -> 1), second release detaches.
  await releaseDebugger(101, first);
  assert.equal(detachCalls.length, 0);
  await releaseDebugger(101, second);
  assert.equal(detachCalls.length, 1);
});

test("acquireDebugger cleans up a detached session and re-attaches", async () => {
  resetCalls();
  const originalWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    const first = await acquireDebugger(102, "1.3");
    assert.equal(attachCalls.length, 1);
    getDetachListener()({ tabId: 102 }, "target_closed");
    // target_closed sets detached without warning.
    assert.equal(warnings.length, 0);
    const second = await acquireDebugger(102, "1.3");
    assert.equal(attachCalls.length, 2);
    assert.notEqual(first, second);
    assert.deepEqual(second, { tabId: 102 });
    await releaseDebugger(102, second);
    // Detached flag was cleared by re-attach, so normal detach runs.
    assert.equal(detachCalls.length, 1);
  } finally {
    console.warn = originalWarn;
  }
});

test("releaseDebugger ignores unknown targets and keeps sessions with refcount", async () => {
  resetCalls();
  await releaseDebugger(999, { tabId: 999 });
  assert.equal(detachCalls.length, 0);

  const first = await acquireDebugger(103, "1.3");
  const second = await acquireDebugger(103, "1.3");
  assert.equal(first, second);
  await releaseDebugger(103, first);
  assert.equal(detachCalls.length, 0);
  // Session still held; acquiring again reuses without a new attach.
  const third = await acquireDebugger(103, "1.3");
  assert.equal(attachCalls.length, 1);
  assert.equal(third, first);
  await releaseDebugger(103, second);
  await releaseDebugger(103, third);
  assert.equal(detachCalls.length, 1);
});

test("releaseDebugger skips detach for detached sessions", async () => {
  resetCalls();
  const originalWarn = console.warn;
  console.warn = () => undefined;
  try {
    const target = await acquireDebugger(104, "1.3");
    getDetachListener()({ tabId: 104 }, "target_closed");
    await releaseDebugger(104, target);
    assert.equal(detachCalls.length, 0);
  } finally {
    console.warn = originalWarn;
  }
});

test("releaseDebugger detaches a normal session", async () => {
  resetCalls();
  const target = await acquireDebugger(105, "1.3");
  await releaseDebugger(105, target);
  assert.equal(detachCalls.length, 1);
  assert.equal(detachCalls[0], target);
});

test("throwEvaluationException prefers description, then text, then passes", () => {
  assert.throws(
    () =>
      throwEvaluationException({
        exceptionDetails: {
          exception: { description: "boom-desc" },
          text: "boom-text",
        },
      } as never),
    /boom-desc/,
  );
  assert.throws(
    () =>
      throwEvaluationException({
        exceptionDetails: { text: "only-text" },
      } as never),
    /only-text/,
  );
  // No exception details: no throw.
  throwEvaluationException({} as never);
  throwEvaluationException({ result: { type: "string" } } as never);
});

test("withDebugger releases the session when the callback throws", async () => {
  resetCalls();
  await assert.rejects(
    withDebugger(106, "1.3", async () => {
      throw new Error("callback boom");
    }),
    /callback boom/,
  );
  assert.equal(detachCalls.length, 1);
  // Session was cleaned up; a fresh acquire attaches again.
  resetCalls();
  const target = await acquireDebugger(106, "1.3");
  assert.equal(attachCalls.length, 1);
  await releaseDebugger(106, target);
});

test("sendCdpCommand forwards target, method, and params", async () => {
  resetCalls();
  sendCommandImpl = async (_target, method, params) => {
    assert.equal(method, "DOM.getDocument");
    assert.deepEqual(params, { depth: 0 });
    return { root: { nodeId: 1 } };
  };
  const target = await acquireDebugger(107, "1.3");
  try {
    const result = await sendCdpCommand(target, "DOM.getDocument", {
      depth: 0,
    });
    assert.deepEqual(result, { root: { nodeId: 1 } });
    assert.equal(sendCommandCalls.length, 1);
    assert.equal(sendCommandCalls[0]?.method, "DOM.getDocument");
  } finally {
    await releaseDebugger(107, target);
  }
});

test("onDetach ignores missing tabId", async () => {
  resetCalls();
  const originalWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    const target = await acquireDebugger(108, "1.3");
    getDetachListener()({}, "some_reason");
    assert.equal(warnings.length, 0);
    // Session was not marked detached, so re-acquire reuses it.
    const again = await acquireDebugger(108, "1.3");
    assert.equal(attachCalls.length, 1);
    assert.equal(again, target);
    await releaseDebugger(108, target);
    await releaseDebugger(108, again);
    assert.equal(detachCalls.length, 1);
  } finally {
    console.warn = originalWarn;
  }
});

test("onDetach warns for non-target_closed reasons only", async () => {
  resetCalls();
  const originalWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    const closedTarget = await acquireDebugger(109, "1.3");
    getDetachListener()({ tabId: 109 }, "target_closed");
    assert.equal(warnings.length, 0);
    await releaseDebugger(109, closedTarget);
    assert.equal(detachCalls.length, 0);

    const replacedTarget = await acquireDebugger(110, "1.3");
    getDetachListener()({ tabId: 110 }, "replaced_with_devtools");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /110/);
    assert.match(warnings[0] ?? "", /replaced_with_devtools/);
    await releaseDebugger(110, replacedTarget);
    // Detached sessions skip detach even after a warning.
    assert.equal(detachCalls.length, 0);
  } finally {
    console.warn = originalWarn;
  }
});
