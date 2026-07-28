const DEFAULT_BASE_URL = "http://127.0.0.1:58347";
const MAX_SCREENSHOT_BASE64_LENGTH = 30 * 1024 * 1024;

const KEY_DEFINITIONS = {
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  Delete: { key: "Delete", code: "Delete", keyCode: 46 },
  End: { key: "End", code: "End", keyCode: 35 },
  Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  Escape: { key: "Escape", code: "Escape", keyCode: 27 },
  Home: { key: "Home", code: "Home", keyCode: 36 },
  PageDown: { key: "PageDown", code: "PageDown", keyCode: 34 },
  PageUp: { key: "PageUp", code: "PageUp", keyCode: 33 },
  Space: { key: " ", code: "Space", keyCode: 32, text: " " },
  Tab: { key: "Tab", code: "Tab", keyCode: 9 },
};

const MODIFIER_BITS = { alt: 1, ctrl: 2, meta: 4, shift: 8 };

const SHIFTED_CHARACTERS = {
  "`": "~",
  1: "!",
  2: "@",
  3: "#",
  4: "$",
  5: "%",
  6: "^",
  7: "&",
  8: "*",
  9: "(",
  0: ")",
  "-": "_",
  "=": "+",
  "[": "{",
  "]": "}",
  "\\": "|",
  ";": ":",
  "'": '"',
  ",": "<",
  ".": ">",
  "/": "?",
};

const CHARACTER_DEFINITIONS = {
  "`": { code: "Backquote", keyCode: 192 },
  1: { code: "Digit1", keyCode: 49 },
  2: { code: "Digit2", keyCode: 50 },
  3: { code: "Digit3", keyCode: 51 },
  4: { code: "Digit4", keyCode: 52 },
  5: { code: "Digit5", keyCode: 53 },
  6: { code: "Digit6", keyCode: 54 },
  7: { code: "Digit7", keyCode: 55 },
  8: { code: "Digit8", keyCode: 56 },
  9: { code: "Digit9", keyCode: 57 },
  0: { code: "Digit0", keyCode: 48 },
  "-": { code: "Minus", keyCode: 189 },
  "=": { code: "Equal", keyCode: 187 },
  "[": { code: "BracketLeft", keyCode: 219 },
  "]": { code: "BracketRight", keyCode: 221 },
  "\\": { code: "Backslash", keyCode: 220 },
  ";": { code: "Semicolon", keyCode: 186 },
  "'": { code: "Quote", keyCode: 222 },
  ",": { code: "Comma", keyCode: 188 },
  ".": { code: "Period", keyCode: 190 },
  "/": { code: "Slash", keyCode: 191 },
};

const UNSHIFTED_CHARACTERS = Object.fromEntries(
  Object.entries(SHIFTED_CHARACTERS).map(([key, value]) => [value, key]),
);

let activeExecutions = 0;
const MAX_CONCURRENT_EXECUTIONS = 10;
let offscreenPromise = null;
let backendUnavailable = false;
let configurationPromise = null;

function generateBrowserId() {
  return crypto.randomUUID().replaceAll("-", "");
}

async function initializeConfiguration() {
  const stored = await chrome.storage.local.get(["baseUrl", "bid"]);
  const configuration = {
    baseUrl: stored.baseUrl || DEFAULT_BASE_URL,
    bid: stored.bid || generateBrowserId(),
  };

  if (!stored.baseUrl || !stored.bid) {
    await chrome.storage.local.set(configuration);
  }

  return configuration;
}

async function getConfiguration() {
  if (!configurationPromise) {
    configurationPromise = initializeConfiguration();
  }

  await configurationPromise;
  return chrome.storage.local.get(["baseUrl", "bid"]);
}

function instructionApiUrl(configuration) {
  const baseUrl = configuration.baseUrl.replace(/\/+$/, "");
  return `${baseUrl}/api/browsers/${configuration.bid}/instructions`;
}

async function createOffscreenDocument() {
  const documentUrl = chrome.runtime.getURL("offscreen.html");
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [documentUrl],
  });

  if (contexts.length === 0) {
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["WORKERS"],
      justification: "Poll the ACOB server once per second",
    });
  }
}

function ensureOffscreenDocument() {
  if (!offscreenPromise) {
    offscreenPromise = createOffscreenDocument().finally(() => {
      offscreenPromise = null;
    });
  }

  return offscreenPromise;
}

function tabDetails(tab) {
  let domain = null;
  try {
    domain = new URL(tab.url).hostname || null;
  } catch {
    domain = null;
  }

  return {
    tid: tab.id,
    window_id: tab.windowId,
    active: tab.active,
    title: tab.title,
    url: tab.url,
    domain,
  };
}

function waitForTab(tid) {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for the page to load"));
    }, 30000);

    function cleanup() {
      clearTimeout(timeoutId);
      chrome.tabs.onUpdated.removeListener(handleUpdate);
    }

    function handleUpdate(updatedTid, changeInfo, tab) {
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

async function withDebugger(tid, callback) {
  const target = { tabId: tid };
  let attached = false;

  try {
    await chrome.debugger.attach(target, "1.3");
    attached = true;

    return await callback(target);
  } finally {
    if (attached) {
      await chrome.debugger.detach(target);
    }
  }
}

async function executeJavaScript(tid, script) {
  return withDebugger(tid, async (target) => {
    const evaluation = await chrome.debugger.sendCommand(
      target,
      "Runtime.evaluate",
      {
        expression: script,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      },
    );

    if (evaluation.exceptionDetails) {
      const message =
        evaluation.exceptionDetails.exception?.description ??
        evaluation.exceptionDetails.text;
      throw new Error(message);
    }

    const result = evaluation.result;
    if (Object.hasOwn(result, "value")) {
      return result.value;
    }
    if (result.unserializableValue) {
      return result.unserializableValue;
    }
    return {
      type: result.type,
      description: result.description ?? null,
    };
  });
}

async function executeClick(tid, selector) {
  return withDebugger(tid, async (target) => {
    const { root } = await chrome.debugger.sendCommand(
      target,
      "DOM.getDocument",
      { depth: 0 },
    );
    const { nodeId } = await chrome.debugger.sendCommand(
      target,
      "DOM.querySelector",
      { nodeId: root.nodeId, selector },
    );

    if (!nodeId) {
      throw new Error(`No element matches selector: ${selector}`);
    }

    await chrome.debugger.sendCommand(target, "DOM.scrollIntoViewIfNeeded", {
      nodeId,
    });
    const { model } = await chrome.debugger.sendCommand(
      target,
      "DOM.getBoxModel",
      { nodeId },
    );
    const border = model.border;
    const x = (border[0] + border[2] + border[4] + border[6]) / 4;
    const y = (border[1] + border[3] + border[5] + border[7]) / 4;

    if (
      model.width < 1 ||
      model.height < 1 ||
      !Number.isFinite(x) ||
      !Number.isFinite(y)
    ) {
      throw new Error(`Element has no clickable box: ${selector}`);
    }

    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y,
      pointerType: "mouse",
    });
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      buttons: 1,
      clickCount: 1,
      pointerType: "mouse",
    });
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      buttons: 0,
      clickCount: 1,
      pointerType: "mouse",
    });

    return { clicked: true, selector, x, y };
  });
}

async function executeScreenshot(tid, fullPage) {
  return withDebugger(tid, async (target) => {
    const { data } = await chrome.debugger.sendCommand(
      target,
      "Page.captureScreenshot",
      {
        format: "png",
        fromSurface: true,
        captureBeyondViewport: fullPage,
      },
    );
    if (data.length > MAX_SCREENSHOT_BASE64_LENGTH) {
      throw new Error("Screenshot exceeds the 30 MiB encoded size limit");
    }
    return { data };
  });
}

function describeKey(key, shiftPressed) {
  if (Object.hasOwn(KEY_DEFINITIONS, key)) {
    return KEY_DEFINITIONS[key];
  }

  const upperKey = key.toUpperCase();
  if (/^[A-Z]$/.test(upperKey)) {
    const unmodifiedText = key.toLowerCase();
    const text = shiftPressed ? upperKey : key;
    return {
      key: text,
      code: `Key${upperKey}`,
      keyCode: upperKey.charCodeAt(0),
      text,
      unmodifiedText,
    };
  }

  const unmodifiedText = UNSHIFTED_CHARACTERS[key] ?? key;
  const characterDefinition = CHARACTER_DEFINITIONS[unmodifiedText];
  if (characterDefinition) {
    const text = shiftPressed
      ? (SHIFTED_CHARACTERS[unmodifiedText] ?? key)
      : key;
    return {
      key: text,
      ...characterDefinition,
      text,
      unmodifiedText,
    };
  }
  return { key, text: key, unmodifiedText: key };
}

async function executeKeyboard(tid, payload) {
  return withDebugger(tid, async (target) => {
    if (payload.text !== undefined) {
      await chrome.debugger.sendCommand(target, "Input.insertText", {
        text: payload.text,
      });
      return { inserted_characters: Array.from(payload.text).length };
    }

    const modifiers = payload.modifiers.reduce(
      (mask, modifier) => mask | MODIFIER_BITS[modifier],
      0,
    );
    const definition = describeKey(payload.key, (modifiers & 8) !== 0);
    const hasCommandModifier = (modifiers & 7) !== 0;
    const keyEvent = {
      key: definition.key,
      modifiers,
    };
    if (definition.code) {
      keyEvent.code = definition.code;
    }
    if (definition.keyCode) {
      keyEvent.windowsVirtualKeyCode = definition.keyCode;
    }
    const keyDownEvent = { ...keyEvent };
    if (definition.text && !hasCommandModifier) {
      keyDownEvent.text = definition.text;
      keyDownEvent.unmodifiedText =
        definition.unmodifiedText ?? definition.text;
    }

    await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
      ...keyDownEvent,
      type: definition.text && !hasCommandModifier ? "keyDown" : "rawKeyDown",
    });
    await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
      ...keyEvent,
      type: "keyUp",
    });
    return { key: payload.key, modifiers: payload.modifiers };
  });
}

async function runInstruction(instruction) {
  const { action, payload } = instruction;

  if (action === "tabs") {
    if (!payload.operation) {
      throw new Error("tabs operation is required");
    }
    const operation = payload.operation;

    if (operation === "list") {
      const [tabs, windows] = await Promise.all([
        chrome.tabs.query({}),
        chrome.windows.getAll(),
      ]);
      const focusedWindowIds = new Set(
        windows.filter((window) => window.focused).map((window) => window.id),
      );
      return tabs.map((tab) => ({
        ...tabDetails(tab),
        focused: tab.active && focusedWindowIds.has(tab.windowId),
      }));
    }

    if (operation === "close") {
      const tab = await chrome.tabs.get(payload.tid);
      await chrome.tabs.remove(tab.id);
      return { closed: true, tab: tabDetails(tab) };
    }

    if (operation === "focus") {
      const tab = await chrome.tabs.get(payload.tid);
      await chrome.windows.update(tab.windowId, { focused: true });
      const focusedTab = await chrome.tabs.update(tab.id, { active: true });
      return tabDetails(focusedTab);
    }

    if (operation === "navigate") {
      const navigatedTab = payload.tid
        ? await chrome.tabs.update(payload.tid, { url: payload.url })
        : await chrome.tabs.create({ url: payload.url, active: false });
      const loadedTab = await waitForTab(navigatedTab.id);
      return tabDetails(loadedTab);
    }

    throw new Error(`Unknown tabs operation: ${operation}`);
  }

  if (action === "javascript") {
    await chrome.tabs.get(payload.tid);
    return executeJavaScript(payload.tid, payload.script);
  }

  if (action === "click") {
    await chrome.tabs.get(payload.tid);
    return executeClick(payload.tid, payload.selector);
  }

  if (action === "keyboard") {
    await chrome.tabs.get(payload.tid);
    return executeKeyboard(payload.tid, payload);
  }

  if (action === "screenshot") {
    await chrome.tabs.get(payload.tid);
    return executeScreenshot(payload.tid, payload.full_page);
  }

  throw new Error(`Unknown action: ${action}`);
}

async function sendResult(instructionId, body, configuration) {
  const apiUrl = instructionApiUrl(configuration);
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(`${apiUrl}/${instructionId}/result/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (response.ok) {
        return;
      }
      if (attempt === 3) {
        throw new Error(`Could not submit result: HTTP ${response.status}`);
      }
    } catch (error) {
      if (attempt === 3) {
        throw error;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

async function poll() {
  if (activeExecutions >= MAX_CONCURRENT_EXECUTIONS) {
    return;
  }

  activeExecutions++;
  try {
    const configuration = await getConfiguration();
    const apiUrl = instructionApiUrl(configuration);
    const response = await fetch(`${apiUrl}/next/`);
    if (backendUnavailable) {
      console.info("ACOB server connected");
      backendUnavailable = false;
    }
    if (response.status === 204) {
      return;
    }
    if (!response.ok) {
      throw new Error(`Could not fetch instruction: HTTP ${response.status}`);
    }

    const instruction = await response.json();
    let body;
    try {
      const result = await runInstruction(instruction);
      body = { result };
    } catch (error) {
      body = {
        error: error instanceof Error ? error.message : String(error),
      };
    }
    await sendResult(instruction.id, body, configuration);
  } catch (error) {
    if (error instanceof TypeError) {
      if (!backendUnavailable) {
        console.info("ACOB server unavailable; retrying");
        backendUnavailable = true;
      }
      return;
    }
    console.error(error);
  } finally {
    activeExecutions--;
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "poll") {
    poll();
  }
  if (message.type === "getConfiguration") {
    getConfiguration().then(sendResponse, (error) => {
      sendResponse({
        error: error instanceof Error ? error.message : String(error),
      });
    });
    return true;
  }
});

chrome.runtime.onInstalled.addListener(() => {
  ensureOffscreenDocument().catch(console.error);
});
chrome.runtime.onStartup.addListener(() => {
  ensureOffscreenDocument().catch(console.error);
});
ensureOffscreenDocument().catch(console.error);
