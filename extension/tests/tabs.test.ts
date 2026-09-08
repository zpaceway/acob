import assert from "node:assert/strict";
import test from "node:test";

const calls: Array<{ method: string; args: unknown[] }> = [];
const tab = {
  id: 12,
  windowId: 7,
  active: true,
  highlighted: true,
  incognito: false,
  index: 0,
  pinned: false,
  selected: true,
  discarded: false,
  autoDiscardable: true,
  groupId: -1,
};

Object.defineProperty(globalThis, "chrome", {
  configurable: true,
  value: {
    tabs: {
      update: async (...args: unknown[]) => {
        calls.push({ method: "tabs.update", args });
        return tab;
      },
    },
    windows: {
      update: async (...args: unknown[]) => {
        calls.push({ method: "windows.update", args });
        return { id: 7, focused: true };
      },
    },
  },
});

const { activateTab, focusTab } = await import("../src/tabs.js");

test("activates a tab before focus-sensitive input", async () => {
  calls.length = 0;
  assert.equal(await activateTab(12), tab);
  assert.deepEqual(calls, [
    { method: "tabs.update", args: [12, { active: true }] },
  ]);
});

test("focus activates the tab and raises its window", async () => {
  calls.length = 0;
  assert.equal(await focusTab(12), tab);
  assert.deepEqual(calls, [
    { method: "tabs.update", args: [12, { active: true }] },
    { method: "windows.update", args: [7, { focused: true }] },
  ]);
});
