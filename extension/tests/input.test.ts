import assert from "node:assert/strict";
import test from "node:test";

import { state } from "../src/state.js";

let tabActive = true;
let windowFocused = true;
Object.defineProperty(globalThis, "chrome", {
  configurable: true,
  value: {
    tabs: {
      get: async (tid: number) => ({
        id: tid,
        windowId: 7,
        active: tabActive,
      }),
    },
    windows: {
      get: async () => ({ id: 7, focused: windowFocused }),
    },
  },
});

const { assertTabFocusedForInput, runInBrowserInputQueue } = await import(
  "../src/input.js"
);

test("serializes focus-sensitive browser input across tabs", async () => {
  state.browserInputQueue = Promise.resolve();
  const events: string[] = [];
  let releaseFirst: () => void = () => undefined;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  const first = runInBrowserInputQueue(async () => {
    events.push("first:start");
    await firstGate;
    events.push("first:end");
  });
  const second = runInBrowserInputQueue(async () => {
    events.push("second:start");
  });

  await Promise.resolve();
  assert.deepEqual(events, ["first:start"]);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["first:start", "first:end", "second:start"]);
});

test("continues the browser input queue after a failed action", async () => {
  state.browserInputQueue = Promise.resolve();
  const first = runInBrowserInputQueue(async () => {
    throw new Error("input failed");
  });
  const second = runInBrowserInputQueue(async () => "completed");

  await assert.rejects(first, /input failed/);
  assert.equal(await second, "completed");
});

test("requires both an active tab and focused browser window", async () => {
  tabActive = true;
  windowFocused = true;
  await assert.doesNotReject(assertTabFocusedForInput(12));

  tabActive = false;
  await assert.rejects(assertTabFocusedForInput(12), /call focus first/);

  tabActive = true;
  windowFocused = false;
  await assert.rejects(assertTabFocusedForInput(12), /call focus first/);
});
