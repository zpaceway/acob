import assert from "node:assert/strict";
import test from "node:test";

type Tab = {
  id?: number;
  windowId: number;
  active: boolean;
  title?: string | null;
  url?: string | null;
  status?: string;
};

type UpdateListener = (
  tid: number,
  info: { status?: string },
  tab: Tab,
) => void;

let queryResult: Tab[] = [];
let getHandler: (tid: number) => Promise<Tab> = async (tid: number) => ({
  id: tid,
  windowId: 7,
  active: true,
  status: "complete",
  url: "https://example.com/",
});
let createHandler: (options: { url: string }) => Promise<Tab> = async (
  options,
) => ({
  id: 99,
  windowId: 7,
  active: false,
  url: options.url,
});
let updateHandler: (tid: number) => Promise<Tab | null> = async (
  tid: number,
) => ({
  id: tid,
  windowId: 7,
  active: true,
  url: "https://example.com/",
});
let reloadHandler: (tid: number) => Promise<void> = async () => undefined;
let updateWindowCalls: Array<{ id: number; info: unknown }> = [];
const listeners = new Set<UpdateListener>();

Object.defineProperty(globalThis, "chrome", {
  configurable: true,
  value: {
    tabs: {
      query: async () => [...queryResult],
      get: (tid: number) => getHandler(tid),
      create: (options: { url: string }) => createHandler(options),
      update: (tid: number, info: unknown) =>
        updateHandler(tid).then((tab) => {
          void info;
          return tab;
        }),
      remove: async () => undefined,
      reload: (tid: number) => reloadHandler(tid),
      onUpdated: {
        addListener: (listener: UpdateListener) => {
          listeners.add(listener);
        },
        removeListener: (listener: UpdateListener) => {
          listeners.delete(listener);
        },
      },
    },
    windows: {
      update: async (id: number, info: unknown) => {
        updateWindowCalls.push({ id, info });
        return { id, focused: true };
      },
    },
  },
});

const { activateTab, createTabWithinLimit, focusTab, reloadTab, tabDetails, waitForTab } =
  await import("../src/tabs.js");
const { state } = await import("../src/state.js");

function resetTabs(): void {
  queryResult = [];
  updateWindowCalls = [];
  listeners.clear();
  state.tabCreationQueue = Promise.resolve();
  state.tabExecutionQueues.clear();
  getHandler = async (tid: number) => ({
    id: tid,
    windowId: 7,
    active: true,
    status: "complete",
    url: "https://example.com/",
  });
  createHandler = async (options) => ({
    id: 99,
    windowId: 7,
    active: false,
    url: options.url,
  });
  updateHandler = async (tid: number) => ({
    id: tid,
    windowId: 7,
    active: true,
    url: "https://example.com/",
  });
  reloadHandler = async () => undefined;
}

function fireUpdate(tid: number, status: string, tab?: Tab): void {
  const payload: Tab = tab ?? {
    id: tid,
    windowId: 7,
    active: true,
    status,
    url: "https://example.com/",
  };
  for (const listener of [...listeners]) {
    listener(tid, { status }, payload);
  }
}

test("tabDetails throws when Chromium omits the id", () => {
  resetTabs();
  assert.throws(
    () =>
      tabDetails({
        windowId: 7,
        active: true,
      } as unknown as chrome.tabs.Tab),
    /without an ID/,
  );
});

test("tabDetails parses url and domain", () => {
  resetTabs();
  assert.deepEqual(
    tabDetails({
      id: 1,
      windowId: 7,
      active: true,
      title: "Example",
      url: "https://example.com/path?q=1",
    } as unknown as chrome.tabs.Tab),
    {
      tid: 1,
      window_id: 7,
      active: true,
      title: "Example",
      url: "https://example.com/path?q=1",
      domain: "example.com",
    },
  );
});

test("tabDetails falls back when url is missing or invalid", () => {
  resetTabs();
  assert.deepEqual(
    tabDetails({
      id: 2,
      windowId: 7,
      active: false,
    } as unknown as chrome.tabs.Tab),
    {
      tid: 2,
      window_id: 7,
      active: false,
      title: null,
      url: null,
      domain: null,
    },
  );
  assert.deepEqual(
    tabDetails({
      id: 3,
      windowId: 7,
      active: false,
      title: null,
      url: "not a url",
    } as unknown as chrome.tabs.Tab).domain,
    null,
  );
  assert.deepEqual(
    tabDetails({
      id: 4,
      windowId: 7,
      active: false,
      title: null,
      url: "about:blank",
    } as unknown as chrome.tabs.Tab).domain,
    null,
  );
});

test("createTabWithinLimit serializes creation through the queue", async () => {
  resetTabs();
  queryResult = [];
  let releaseFirst: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let firstCreate = true;
  createHandler = async (options) => {
    if (firstCreate) {
      firstCreate = false;
      await gate;
    }
    return {
      id: 101,
      windowId: 7,
      active: false,
      url: options.url,
    };
  };
  const first = createTabWithinLimit("https://a.example/", 5);
  const second = createTabWithinLimit("https://b.example/", 5);
  await new Promise((resolve) => setTimeout(resolve, 10));
  // Second creation must wait for the first gate.
  let secondSettled = false;
  void second.then(
    () => {
      secondSettled = true;
    },
    () => {
      secondSettled = true;
    },
  );
  assert.equal(secondSettled, false);
  releaseFirst();
  const [firstTab, secondTab] = await Promise.all([first, second]);
  assert.equal(firstTab.url, "https://a.example/");
  assert.equal(secondTab.url, "https://b.example/");
  assert.equal(listeners.size, 0);
});

test("createTabWithinLimit rejects at the limit without breaking the queue", async () => {
  resetTabs();
  queryResult = [
    { id: 1, windowId: 7, active: true },
    { id: 2, windowId: 7, active: false },
  ];
  await assert.rejects(createTabWithinLimit("https://x.example/", 2), /tab limit/);
  queryResult = [{ id: 1, windowId: 7, active: true }];
  const tab = await createTabWithinLimit("https://y.example/", 2);
  assert.equal(tab.url, "https://y.example/");
});

test("activateTab throws when Chromium returns no tab", async () => {
  resetTabs();
  updateHandler = async () => null;
  await assert.rejects(activateTab(55), /did not return activated tab/);
});

test("focusTab activates then focuses the window", async () => {
  resetTabs();
  updateHandler = async (tid: number) => ({
    id: tid,
    windowId: 9,
    active: true,
    url: "https://example.com/",
  });
  const tab = await focusTab(12);
  assert.equal((tab as Tab).windowId, 9);
  assert.deepEqual(updateWindowCalls, [{ id: 9, info: { focused: true } }]);
});

test("waitForTab resolves immediately for a complete tab", async () => {
  resetTabs();
  getHandler = async (tid: number) => ({
    id: tid,
    windowId: 7,
    active: true,
    status: "complete",
    url: "https://example.com/",
  });
  const tab = await waitForTab(1, 30);
  assert.equal(tab.id, 1);
  assert.equal(listeners.size, 0);
});

test("waitForTab resolves on a later complete event", async () => {
  resetTabs();
  getHandler = async (tid: number) => ({
    id: tid,
    windowId: 7,
    active: true,
    status: "loading",
    url: "https://example.com/",
  });
  const pending = waitForTab(5, 100);
  await new Promise((resolve) => setTimeout(resolve, 5));
  fireUpdate(5, "loading");
  fireUpdate(5, "complete");
  const tab = await pending;
  assert.equal(tab.id, 5);
  assert.equal(listeners.size, 0);
});

test("waitForTab ignores mismatched tids", async () => {
  resetTabs();
  getHandler = async (tid: number) => ({
    id: tid,
    windowId: 7,
    active: true,
    status: "loading",
    url: "https://example.com/",
  });
  const pending = waitForTab(6, 100);
  await new Promise((resolve) => setTimeout(resolve, 5));
  fireUpdate(999, "complete");
  assert.equal(listeners.size, 1);
  fireUpdate(6, "complete");
  const tab = await pending;
  assert.equal(tab.id, 6);
});

test("waitForTab times out", async () => {
  resetTabs();
  getHandler = async (tid: number) => ({
    id: tid,
    windowId: 7,
    active: true,
    status: "loading",
    url: "https://example.com/",
  });
  await assert.rejects(waitForTab(7, 10), /Timed out waiting for the page to load/);
  assert.equal(listeners.size, 0);
});

test("waitForTab rejects when get fails", async () => {
  resetTabs();
  getHandler = async () => {
    throw new Error("no such tab");
  };
  await assert.rejects(waitForTab(8, 50), /no such tab/);
  assert.equal(listeners.size, 0);
});

test("reloadTab resolves after loading then complete", async () => {
  resetTabs();
  const pending = reloadTab(11, 100);
  await new Promise((resolve) => setTimeout(resolve, 5));
  fireUpdate(11, "loading");
  fireUpdate(11, "complete");
  const tab = await pending;
  assert.equal(tab.id, 11);
  assert.equal(listeners.size, 0);
});

test("reloadTab ignores unrelated tids", async () => {
  resetTabs();
  const pending = reloadTab(12, 100);
  await new Promise((resolve) => setTimeout(resolve, 5));
  fireUpdate(999, "loading");
  fireUpdate(999, "complete");
  fireUpdate(12, "loading");
  fireUpdate(12, "complete");
  const tab = await pending;
  assert.equal(tab.id, 12);
  assert.equal(listeners.size, 0);
});

test("reloadTab times out without events", async () => {
  resetTabs();
  await assert.rejects(reloadTab(13, 10), /Timed out waiting for the page to reload/);
  assert.equal(listeners.size, 0);
});

test("reloadTab rejects when reload fails", async () => {
  resetTabs();
  reloadHandler = async () => {
    throw new Error("reload denied");
  };
  await assert.rejects(reloadTab(14, 50), /reload denied/);
  assert.equal(listeners.size, 0);
});
