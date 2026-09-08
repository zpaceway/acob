import { state } from "./state.js";

export async function assertTabFocusedForInput(tid: number): Promise<void> {
  const tab = await chrome.tabs.get(tid);
  const window = await chrome.windows.get(tab.windowId);
  if (!tab.active || !window.focused) {
    throw new Error(
      `Tab ${tid} is not focused; call focus first or try javascript`,
    );
  }
}

export function runInBrowserInputQueue<Result>(
  operation: () => Promise<Result>,
): Promise<Result> {
  const result = state.browserInputQueue.then(operation);
  state.browserInputQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}
