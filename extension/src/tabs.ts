import { state } from "./state.js";
import type { TabDetails } from "./types.js";

export function tabDetails(tab: chrome.tabs.Tab): TabDetails {
  if (tab.id === undefined) {
    throw new Error("Chromium returned a tab without an ID");
  }
  const url = tab.url ?? null;
  let domain: string | null = null;
  if (url) {
    try {
      domain = new URL(url).hostname || null;
    } catch {
      domain = null;
    }
  }

  return {
    tid: tab.id,
    window_id: tab.windowId,
    active: tab.active,
    title: tab.title ?? null,
    url,
    domain,
  };
}

export function createTabWithinLimit(
  url: string,
  maxTabs: number,
): Promise<chrome.tabs.Tab> {
  const creation = state.tabCreationQueue.then(async () => {
    const tabs = await chrome.tabs.query({});
    if (tabs.length >= maxTabs) {
      throw new Error(
        `Cannot create new tab: browser tab limit of ${maxTabs} reached`,
      );
    }
    return chrome.tabs.create({ url, active: false });
  });
  state.tabCreationQueue = creation.then(
    () => undefined,
    () => undefined,
  );
  return creation;
}

export function waitForTab(tid: number, timeoutMs: number): Promise<chrome.tabs.Tab> {
  return new Promise<chrome.tabs.Tab>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for the page to load"));
    }, timeoutMs);

    function cleanup(): void {
      clearTimeout(timeoutId);
      chrome.tabs.onUpdated.removeListener(handleUpdate);
    }

    function handleUpdate(
      updatedTid: number,
      changeInfo: chrome.tabs.OnUpdatedInfo,
      tab: chrome.tabs.Tab,
    ): void {
      if (updatedTid === tid && changeInfo.status === "complete") {
        cleanup();
        resolve(tab);
      }
    }

    chrome.tabs.onUpdated.addListener(handleUpdate);
    chrome.tabs
      .get(tid)
      .then((tab) => {
        if (tab.status === "complete") {
          cleanup();
          resolve(tab);
        }
      })
      .catch((error) => {
        cleanup();
        reject(error);
      });
  });
}

export function reloadTab(tid: number, timeoutMs: number): Promise<chrome.tabs.Tab> {
  return new Promise<chrome.tabs.Tab>((resolve, reject) => {
    let loading = false;
    const timeoutId = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for the page to reload"));
    }, timeoutMs);

    function cleanup(): void {
      clearTimeout(timeoutId);
      chrome.tabs.onUpdated.removeListener(handleUpdate);
    }

    function handleUpdate(
      updatedTid: number,
      changeInfo: chrome.tabs.OnUpdatedInfo,
      tab: chrome.tabs.Tab,
    ): void {
      if (updatedTid !== tid) {
        return;
      }
      if (changeInfo.status === "loading") {
        loading = true;
      } else if (loading && changeInfo.status === "complete") {
        cleanup();
        resolve(tab);
      }
    }

    chrome.tabs.onUpdated.addListener(handleUpdate);
    chrome.tabs.reload(tid).catch((error) => {
      cleanup();
      reject(error);
    });
  });
}
