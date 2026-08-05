import { ACOBSettings } from "./settings.js";
import { loadConfiguration } from "./storage.js";
import { withTerminationOnTimeout, withTimeout } from "./timeouts.js";
import { isKeyboardKey, isRuntimeMessage } from "./types.js";
import type { Protocol } from "devtools-protocol";
import type { ProtocolMapping } from "devtools-protocol/types/protocol-mapping.js";
import type {
  ClaimedInstruction,
  ClickResult,
  Configuration,
  ExtensionInstructionResult,
  InstructionResultRequest,
  JsonValue,
  KeyboardKeyResult,
  KeyboardModifier,
  KeyboardPayload,
  KeyboardTextResult,
  ReinstallCommand,
  ScreenshotUploadResult,
  ScrollResult,
  SupportedInstruction,
  TabDetails,
  UnserializableJavaScriptResult,
} from "./types.js";

interface KeyDefinition {
  key: string;
  code?: string;
  keyCode?: number;
  text?: string;
  unmodifiedText?: string;
}

interface ActiveJavaScriptExecution {
  tid: number;
  finished: Promise<void>;
  stop: () => Promise<void>;
}

const KEY_DEFINITIONS: Record<string, KeyDefinition> = {
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

const MODIFIER_BITS: Record<KeyboardModifier, number> = {
  alt: 1,
  ctrl: 2,
  meta: 4,
  shift: 8,
};

const SHIFTED_CHARACTERS: Record<string, string> = {
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

const CHARACTER_DEFINITIONS: Record<
  string,
  Pick<KeyDefinition, "code" | "keyCode">
> = {
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

const UNSHIFTED_CHARACTERS: Record<string, string> = Object.fromEntries(
  Object.entries(SHIFTED_CHARACTERS).map(([key, value]) => [value, key]),
);

let activeExecutions = 0;
const activeJavaScriptExecutions = new Set<ActiveJavaScriptExecution>();
let offscreenPromise: Promise<void> | null = null;
let backendUnavailable = false;
let configurationPromise: Promise<Configuration> | null = null;
let pageLibrariesScriptPromise: Promise<string> | null = null;
let pollInProgress = false;
let reinstallScheduled = false;
let tabCreationQueue: Promise<void> = Promise.resolve();
const tabExecutionQueues = new Map<number, Promise<void>>();
const PENDING_REINSTALL_TOKEN_KEY = "pendingReinstallToken";

async function getConfiguration(): Promise<Configuration> {
  if (!configurationPromise) {
    configurationPromise = loadConfiguration().catch((error) => {
      configurationPromise = null;
      throw error;
    });
    return configurationPromise;
  }

  await configurationPromise;
  return loadConfiguration();
}

function instructionApiUrl(configuration: Configuration): string {
  const baseUrl = configuration.baseUrl.replace(/\/+$/, "");
  return `${baseUrl}/api/browsers/${configuration.bid}/instructions`;
}

function reinstallUrl(configuration: Configuration): string {
  const baseUrl = configuration.baseUrl.replace(/\/+$/, "");
  return `${baseUrl}/api/browsers/${configuration.bid}/reinstall`;
}

async function acknowledgePendingReinstall(
  configuration: Configuration,
): Promise<void> {
  const stored = await chrome.storage.local.get<
    Record<typeof PENDING_REINSTALL_TOKEN_KEY, unknown>
  >(PENDING_REINSTALL_TOKEN_KEY);
  const pendingToken = stored[PENDING_REINSTALL_TOKEN_KEY];
  if (typeof pendingToken !== "string") {
    return;
  }

  const reinstallBaseUrl = reinstallUrl(configuration);
  const acknowledgement = await fetch(`${reinstallBaseUrl}/acknowledge/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: pendingToken }),
    signal: AbortSignal.timeout(configuration.httpRequestTimeoutMs),
  });
  if (!acknowledgement.ok && acknowledgement.status !== 409) {
    throw new Error(
      `Could not acknowledge extension reinstall: HTTP ${acknowledgement.status}`,
    );
  }
  await chrome.storage.local.remove(PENDING_REINSTALL_TOKEN_KEY);
}

async function executeReinstallCommand(
  configuration: Configuration,
  token: string,
): Promise<void> {
  await chrome.storage.local.set({
    [PENDING_REINSTALL_TOKEN_KEY]: token,
  });
  reinstallScheduled = true;
  await stopActiveJavaScriptExecutions(configuration);
  chrome.runtime.reload();
}

async function stopActiveJavaScriptExecutions(
  configuration: Configuration,
): Promise<void> {
  const executions = [...activeJavaScriptExecutions];
  await Promise.allSettled(
    executions.map((execution) =>
      withTimeout(
        execution.stop(),
        5000,
        `Timed out stopping JavaScript in tab ${execution.tid}`,
      ),
    ),
  );
  await Promise.allSettled(
    [...new Set(executions.map((execution) => execution.tid))].map(
      async (tid) => {
        await reloadTab(tid, configuration.tabLoadTimeoutMs);
      },
    ),
  );
  await Promise.allSettled(
    executions.map((execution) =>
      withTimeout(
        execution.finished,
        5000,
        `Timed out finalizing JavaScript in tab ${execution.tid}`,
      ),
    ),
  );
}

async function configureOffscreenDocument(recreate: boolean): Promise<void> {
  const documentUrl = chrome.runtime.getURL("offscreen.html");
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [documentUrl],
  });

  if (recreate && contexts.length > 0) {
    await chrome.offscreen.closeDocument();
  }
  if (recreate || contexts.length === 0) {
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["WORKERS"],
      justification: "Poll the ACOB server for browser instructions",
    });
  }
}

function ensureOffscreenDocument(recreate = false): Promise<void> {
  const previous = offscreenPromise ?? Promise.resolve();
  const operation = previous
    .catch(() => undefined)
    .then(() => configureOffscreenDocument(recreate));
  const tracked = operation.finally(() => {
    if (offscreenPromise === tracked) {
      offscreenPromise = null;
    }
  });
  offscreenPromise = tracked;
  return tracked;
}

function tabDetails(tab: chrome.tabs.Tab): TabDetails {
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

function createTabWithinLimit(
  url: string,
  maxTabs: number,
): Promise<chrome.tabs.Tab> {
  const creation = tabCreationQueue.then(async () => {
    const tabs = await chrome.tabs.query({});
    if (tabs.length >= maxTabs) {
      throw new Error(
        `Cannot create new tab: browser tab limit of ${maxTabs} reached`,
      );
    }
    return chrome.tabs.create({ url, active: false });
  });
  tabCreationQueue = creation.then(
    () => undefined,
    () => undefined,
  );
  return creation;
}

function waitForTab(tid: number, timeoutMs: number): Promise<chrome.tabs.Tab> {
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

function reloadTab(tid: number, timeoutMs: number): Promise<chrome.tabs.Tab> {
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

async function loadPageLibrarySource(
  fileName: string,
  libraryName: string,
): Promise<string> {
  const response = await fetch(chrome.runtime.getURL(fileName));
  if (!response.ok) {
    throw new Error(`Could not load ${libraryName}: HTTP ${response.status}`);
  }
  const source = await response.text();
  if (!source.trim()) {
    throw new Error(`Could not load ${libraryName}: extension asset is empty`);
  }
  return source;
}

function loadPageLibrariesScript(): Promise<string> {
  if (!pageLibrariesScriptPromise) {
    pageLibrariesScriptPromise = Promise.all([
      loadPageLibrarySource("jquery.min.js", "jQuery"),
      loadPageLibrarySource("turndown.js", "Turndown"),
    ])
      .then(
        ([jquerySource, turndownSource]) =>
          `(function (module, exports, define) {
const existing = Object.getOwnPropertyDescriptor(window, "__acob__");
if (
  existing &&
  "value" in existing &&
  existing.configurable === false &&
  existing.writable === false &&
  typeof existing.value === "object" &&
  existing.value !== null &&
  Object.isFrozen(existing.value) &&
  existing.value.$ === existing.value.jQuery &&
  typeof existing.value.jQuery === "function" &&
  typeof existing.value.TurndownService === "function"
) {
  window.jQuery = window.$ = existing.value.jQuery;
  window.TurndownService = existing.value.TurndownService;
  return;
}
if (existing && existing.configurable === false) {
  throw new Error("window.__acob__ already exists and cannot be replaced");
}
${jquerySource}
${turndownSource}
window.TurndownService = TurndownService;
const namespace = Object.freeze({
  $: window.jQuery,
  jQuery: window.jQuery,
  TurndownService,
});
Object.defineProperty(window, "__acob__", {
  configurable: false,
  enumerable: false,
  value: namespace,
  writable: false,
});
}).call(window, undefined, undefined, undefined);
//# sourceURL=${chrome.runtime.getURL("acob-page-libraries.js")}`,
      )
      .catch((error) => {
        pageLibrariesScriptPromise = null;
        throw error;
      });
  }
  return pageLibrariesScriptPromise;
}

function throwEvaluationException(
  evaluation: Protocol.Runtime.EvaluateResponse,
): void {
  if (!evaluation.exceptionDetails) {
    return;
  }
  const message =
    evaluation.exceptionDetails.exception?.description ??
    evaluation.exceptionDetails.text;
  throw new Error(message);
}

async function withDebugger<Result>(
  tid: number,
  configuration: Configuration,
  callback: (target: chrome.debugger.DebuggerSession) => Promise<Result>,
): Promise<Result> {
  const target: chrome.debugger.DebuggerSession = { tabId: tid };
  let attached = false;

  try {
    await chrome.debugger.attach(
      target,
      configuration.debuggerProtocolVersion,
    );
    attached = true;

    return await callback(target);
  } finally {
    if (attached) {
      await chrome.debugger.detach(target);
    }
  }
}

type CdpCommand = keyof ProtocolMapping.Commands;

async function sendCdpCommand<Command extends CdpCommand>(
  target: chrome.debugger.DebuggerSession,
  method: Command,
  ...parameters: ProtocolMapping.Commands[Command]["paramsType"]
): Promise<ProtocolMapping.Commands[Command]["returnType"]> {
  const commandParameters = parameters[0] as
    | Record<string, unknown>
    | undefined;
  const result = await chrome.debugger.sendCommand(
    target,
    method,
    commandParameters,
  );
  return result as ProtocolMapping.Commands[Command]["returnType"];
}

async function executeJavaScript(
  tid: number,
  script: string,
  configuration: Configuration,
): Promise<JsonValue | UnserializableJavaScriptResult> {
  if (reinstallScheduled) {
    throw new Error("Extension reinstall is in progress");
  }
  const pageLibrariesScript = await loadPageLibrariesScript();
  if (reinstallScheduled) {
    throw new Error("Extension reinstall is in progress");
  }
  return withDebugger(tid, configuration, async (target) => {
    let stopPromise: Promise<void> | null = null;
    const stopExecution = (): Promise<void> => {
      stopPromise ??= withTimeout(
        sendCdpCommand(target, "Runtime.terminateExecution"),
        2000,
        "Timed out terminating Chromium execution",
      );
      return stopPromise;
    };
    const stopTimedOutExecution = async (): Promise<void> => {
      let terminationError: unknown;
      try {
        await stopExecution();
      } catch (error) {
        terminationError = error;
      }
      try {
        await reloadTab(
          tid,
          Math.min(configuration.tabLoadTimeoutMs, 7000),
        );
      } catch (reloadError) {
        if (terminationError !== undefined) {
          throw new AggregateError(
            [terminationError, reloadError],
            "Could not stop timed-out JavaScript or reload its tab",
          );
        }
        throw reloadError;
      }
    };
    let markFinished: () => void = () => undefined;
    const finished = new Promise<void>((resolve) => {
      markFinished = resolve;
    });
    const activeExecution = { tid, finished, stop: stopExecution };
    activeJavaScriptExecutions.add(activeExecution);
    let evaluation: Protocol.Runtime.EvaluateResponse;
    try {
      if (reinstallScheduled) {
        throw new Error("Extension reinstall is in progress");
      }
      const installation = await withTimeout(
        sendCdpCommand(target, "Runtime.evaluate", {
          expression: pageLibrariesScript,
          returnByValue: true,
        }),
        configuration.javascriptTimeoutMs,
        "Timed out loading page libraries",
      );
      throwEvaluationException(installation);
      if (reinstallScheduled) {
        throw new Error("Extension reinstall is in progress");
      }
      const evaluationPromise = sendCdpCommand(target, "Runtime.evaluate", {
        expression: script,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      });
      evaluation = await withTerminationOnTimeout(
        evaluationPromise,
        configuration.javascriptTimeoutMs,
        "Timed out waiting for JavaScript to finish",
        stopTimedOutExecution,
      );
      throwEvaluationException(evaluation);
    } finally {
      activeJavaScriptExecutions.delete(activeExecution);
      markFinished();
    }

    const result = evaluation.result;
    if (Object.hasOwn(result, "value")) {
      return result.value === undefined ? null : (result.value as JsonValue);
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

async function executeClick(
  tid: number,
  selector: string,
  configuration: Configuration,
): Promise<ClickResult> {
  return withDebugger(tid, configuration, async (target) => {
    const { root } = await sendCdpCommand(
      target,
      "DOM.getDocument",
      { depth: 0 },
    );
    const { nodeId } = await sendCdpCommand(
      target,
      "DOM.querySelector",
      { nodeId: root.nodeId, selector },
    );

    if (!nodeId) {
      throw new Error(`No element matches selector: ${selector}`);
    }

    await sendCdpCommand(target, "DOM.scrollIntoViewIfNeeded", {
      nodeId,
    });
    const { model } = await sendCdpCommand(
      target,
      "DOM.getBoxModel",
      { nodeId },
    );
    const border = model.border;
    if (border.length < 8) {
      throw new Error(`Element has an invalid clickable box: ${selector}`);
    }
    const x = (border[0]! + border[2]! + border[4]! + border[6]!) / 4;
    const y = (border[1]! + border[3]! + border[5]! + border[7]!) / 4;

    if (
      model.width < 1 ||
      model.height < 1 ||
      !Number.isFinite(x) ||
      !Number.isFinite(y)
    ) {
      throw new Error(`Element has no clickable box: ${selector}`);
    }

    await sendCdpCommand(target, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y,
      pointerType: "mouse",
    });
    await sendCdpCommand(target, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      buttons: 1,
      clickCount: 1,
      pointerType: "mouse",
    });
    await sendCdpCommand(target, "Input.dispatchMouseEvent", {
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

async function executeScreenshot(
  tid: number,
  fullPage: boolean,
  configuration: Configuration,
): Promise<ScreenshotUploadResult> {
  return withDebugger(tid, configuration, async (target) => {
    const { data } = await sendCdpCommand(
      target,
      "Page.captureScreenshot",
      {
        format: "png",
        fromSurface: true,
        captureBeyondViewport: fullPage,
      },
    );
    if (
      data.length >
      ACOBSettings.mebibytesToBytes(configuration.maxScreenshotSizeMiB)
    ) {
      throw new Error(
        `Screenshot exceeds the ${configuration.maxScreenshotSizeMiB} MiB encoded size limit`,
      );
    }
    return { data };
  });
}

async function executeScroll(
  tid: number,
  y: number,
  configuration: Configuration,
): Promise<ScrollResult> {
  return withDebugger(tid, configuration, async (target) => {
    const evaluation = await sendCdpCommand(target, "Runtime.evaluate", {
      expression: `
        (() => {
          const distance = ${y};
          const canScroll = (el) => el.scrollHeight - el.clientHeight > 1;
          const doc = document.scrollingElement || document.documentElement;
          if (canScroll(doc)) {
            window.scrollBy({ left: 0, top: distance, behavior: "instant" });
            return;
          }
          const centerX = Math.floor(window.innerWidth / 2);
          const centerY = Math.floor(window.innerHeight / 2);
          let node = document.elementFromPoint(centerX, centerY);
          while (node) {
            if (canScroll(node)) {
              node.scrollTop += distance;
              return;
            }
            node = node.parentElement;
          }
          let best = null;
          let bestRoom = 0;
          for (const el of document.querySelectorAll("*")) {
            const room = el.scrollHeight - el.clientHeight;
            if (room > 1 && room > bestRoom) {
              bestRoom = room;
              best = el;
            }
          }
          if (best) {
            best.scrollTop += distance;
          }
        })()
      `,
      returnByValue: true,
      userGesture: true,
    });
    throwEvaluationException(evaluation);
    return { scrolled: true, y };
  });
}

function describeKey(key: string, shiftPressed: boolean): KeyDefinition {
  const namedDefinition = KEY_DEFINITIONS[key];
  if (namedDefinition) {
    return namedDefinition;
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

async function executeKeyboard(
  tid: number,
  payload: KeyboardPayload,
  configuration: Configuration,
): Promise<KeyboardTextResult | KeyboardKeyResult> {
  return withDebugger(tid, configuration, async (target) => {
    if ("text" in payload) {
      await sendCdpCommand(target, "Input.insertText", {
        text: payload.text,
      });
      return { inserted_characters: Array.from(payload.text).length };
    }

    const payloadModifiers = payload.modifiers ?? [];
    const modifiers = payloadModifiers.reduce(
      (mask, modifier) => mask | MODIFIER_BITS[modifier],
      0,
    );
    const definition = describeKey(
      payload.key,
      (modifiers & MODIFIER_BITS.shift) !== 0,
    );
    const commandModifiers =
      MODIFIER_BITS.alt | MODIFIER_BITS.ctrl | MODIFIER_BITS.meta;
    const hasCommandModifier = (modifiers & commandModifiers) !== 0;
    const keyEvent: Omit<Protocol.Input.DispatchKeyEventRequest, "type"> = {
      key: definition.key,
      modifiers,
    };
    if (definition.code !== undefined) {
      keyEvent.code = definition.code;
    }
    if (definition.keyCode !== undefined) {
      keyEvent.windowsVirtualKeyCode = definition.keyCode;
    }
    const keyDownEvent = { ...keyEvent };
    if (definition.text && !hasCommandModifier) {
      keyDownEvent.text = definition.text;
      keyDownEvent.unmodifiedText =
        definition.unmodifiedText ?? definition.text;
    }

    await sendCdpCommand(target, "Input.dispatchKeyEvent", {
      ...keyDownEvent,
      type: definition.text && !hasCommandModifier ? "keyDown" : "rawKeyDown",
    });
    await sendCdpCommand(target, "Input.dispatchKeyEvent", {
      ...keyEvent,
      type: "keyUp",
    });
    return { key: payload.key, modifiers: payloadModifiers };
  });
}

function runInTabExecutionQueue<Result>(
  tid: number,
  operation: () => Promise<Result>,
): Promise<Result> {
  const previous = tabExecutionQueues.get(tid) ?? Promise.resolve();
  const result = previous.then(operation);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  tabExecutionQueues.set(tid, tail);
  void tail.then(() => {
    if (tabExecutionQueues.get(tid) === tail) {
      tabExecutionQueues.delete(tid);
    }
  });
  return result;
}

async function runInstructionAction(
  instruction: SupportedInstruction,
  configuration: Configuration,
): Promise<ExtensionInstructionResult> {
  const { action, payload } = instruction;

  if (action === "list") {
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

  if (action === "close") {
    const tab = await chrome.tabs.get(payload.tid);
    const details = tabDetails(tab);
    await chrome.tabs.remove(details.tid);
    return { closed: true, tab: details };
  }

  if (action === "focus") {
    const tab = await chrome.tabs.get(payload.tid);
    await chrome.windows.update(tab.windowId, { focused: true });
    const focusedTab = await chrome.tabs.update(payload.tid, { active: true });
    if (!focusedTab) {
      throw new Error(`Chromium did not return focused tab ${payload.tid}`);
    }
    return tabDetails(focusedTab);
  }

  if (action === "navigate") {
    const navigatedTab = payload.tid !== undefined
      ? await chrome.tabs.update(payload.tid, { url: payload.url })
      : await createTabWithinLimit(payload.url, configuration.maxTabs);
    if (!navigatedTab) {
      throw new Error("Chromium did not return the navigated tab");
    }
    const navigatedTabDetails = tabDetails(navigatedTab);
    const loadedTab = await waitForTab(
      navigatedTabDetails.tid,
      configuration.tabLoadTimeoutMs,
    );
    return tabDetails(loadedTab);
  }

  if (action === "reload") {
    await chrome.tabs.get(payload.tid);
    const loadedTab = await reloadTab(
      payload.tid,
      configuration.tabLoadTimeoutMs,
    );
    return tabDetails(loadedTab);
  }

  if (action === "scroll") {
    await chrome.tabs.get(payload.tid);
    return executeScroll(payload.tid, payload.y, configuration);
  }

  if (action === "javascript") {
    await chrome.tabs.get(payload.tid);
    return executeJavaScript(payload.tid, payload.script, configuration);
  }

  if (action === "click") {
    await chrome.tabs.get(payload.tid);
    return executeClick(payload.tid, payload.selector, configuration);
  }

  if (action === "keyboard") {
    await chrome.tabs.get(payload.tid);
    return executeKeyboard(payload.tid, payload, configuration);
  }

  if (action === "screenshot") {
    await chrome.tabs.get(payload.tid);
    return executeScreenshot(
      payload.tid,
      payload.full_page ?? false,
      configuration,
    );
  }

  throw new Error(`Unknown action: ${action}`);
}

function runInstruction(
  instruction: SupportedInstruction,
  configuration: Configuration,
): Promise<ExtensionInstructionResult> {
  const { payload } = instruction;
  const tid = "tid" in payload ? payload.tid : undefined;
  const operation = () => runInstructionAction(instruction, configuration);
  return tid === undefined
    ? operation()
    : runInTabExecutionQueue(tid, operation);
}

async function sendResult(
  instructionId: number,
  body: InstructionResultRequest,
  configuration: Configuration,
): Promise<void> {
  const apiUrl = instructionApiUrl(configuration);
  for (
    let attempt = 1;
    attempt <= configuration.resultRetryAttempts;
    attempt += 1
  ) {
    if (reinstallScheduled) {
      return;
    }
    try {
      const response = await fetch(`${apiUrl}/${instructionId}/result/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(configuration.httpRequestTimeoutMs),
      });

      if (response.ok) {
        return;
      }
      if (attempt === configuration.resultRetryAttempts) {
        throw new Error(`Could not submit result: HTTP ${response.status}`);
      }
    } catch (error) {
      if (attempt === configuration.resultRetryAttempts) {
        throw error;
      }
    }

    await new Promise((resolve) =>
      setTimeout(resolve, configuration.resultRetryDelayMs),
    );
  }
}

async function executeInstruction(
  instruction: ClaimedInstruction,
  configuration: Configuration,
): Promise<void> {
  if (reinstallScheduled) {
    return;
  }
  let body: InstructionResultRequest;
  try {
    if (!isSupportedInstruction(instruction)) {
      throw new Error(
        `Unsupported or invalid instruction: ${instruction.action}`,
      );
    }
    const result = await runInstruction(instruction, configuration);
    body = { result };
  } catch (error) {
    body = {
      error: error instanceof Error ? error.message : String(error),
    };
  }
  if (reinstallScheduled) {
    return;
  }
  await sendResult(instruction.id, body, configuration);
}

function reportError(error: unknown): void {
  if (error instanceof TypeError) {
    if (!backendUnavailable) {
      console.info("ACOB server unavailable; retrying");
      backendUnavailable = true;
    }
    return;
  }
  console.error(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isReinstallCommand(value: unknown): value is ReinstallCommand {
  return (
    isRecord(value) &&
    value.action === "reinstall" &&
    isRecord(value.payload) &&
    typeof value.payload.token === "string"
  );
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function hasValidModifiers(
  value: unknown,
): value is KeyboardModifier[] {
  return (
    Array.isArray(value) &&
    value.every(
      (modifier) =>
        typeof modifier === "string" &&
        Object.hasOwn(MODIFIER_BITS, modifier),
    )
  );
}

function isClaimedInstruction(value: unknown): value is ClaimedInstruction {
  return (
    isRecord(value) &&
    isPositiveInteger(value.id) &&
    typeof value.action === "string" &&
    Object.hasOwn(value, "payload")
  );
}

function isSupportedInstruction(
  value: ClaimedInstruction,
): value is SupportedInstruction {
  if (!isRecord(value.payload)) {
    return false;
  }

  const payload = value.payload;
  if (value.action === "click") {
    return (
      isPositiveInteger(payload.tid) && typeof payload.selector === "string"
    );
  }
  if (value.action === "javascript") {
    return isPositiveInteger(payload.tid) && typeof payload.script === "string";
  }
  if (value.action === "keyboard") {
    if (
      !isPositiveInteger(payload.tid) ||
      (payload.modifiers !== undefined &&
        !hasValidModifiers(payload.modifiers))
    ) {
      return false;
    }
    return typeof payload.text === "string"
      ? (payload.modifiers?.length ?? 0) === 0 && payload.key === undefined
      : isKeyboardKey(payload.key) && payload.text === undefined;
  }
  if (value.action === "screenshot") {
    return (
      isPositiveInteger(payload.tid) &&
      (payload.full_page === undefined ||
        typeof payload.full_page === "boolean")
    );
  }
  if (value.action === "list") {
    return true;
  }
  if (
    value.action === "close" ||
    value.action === "focus" ||
    value.action === "reload"
  ) {
    return isPositiveInteger(payload.tid);
  }
  if (value.action === "navigate") {
    return (
      typeof payload.url === "string" &&
      (payload.tid === undefined || isPositiveInteger(payload.tid))
    );
  }
  return (
    value.action === "scroll" &&
    isPositiveInteger(payload.tid) &&
    typeof payload.y === "number" &&
    Number.isFinite(payload.y)
  );
}

async function poll(): Promise<void> {
  if (pollInProgress || reinstallScheduled) {
    return;
  }

  const executions: Promise<void>[] = [];
  pollInProgress = true;
  try {
    const configuration = await getConfiguration();
    await acknowledgePendingReinstall(configuration);
    if (activeExecutions >= configuration.maxConcurrentExecutions) {
      return;
    }
    const availableExecutions =
      configuration.maxConcurrentExecutions - activeExecutions;
    const limit = Math.min(
      configuration.instructionsPerPoll,
      availableExecutions,
    );
    if (limit <= 0) {
      return;
    }
    const apiUrl = instructionApiUrl(configuration);
    const response = await fetch(`${apiUrl}/next/?limit=${limit}`, {
      signal: AbortSignal.timeout(configuration.httpRequestTimeoutMs),
    });
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

    const instructions: unknown = await response.json();
    if (!Array.isArray(instructions)) {
      throw new Error("ACOB server returned an invalid instruction batch");
    }
    let scheduledExecutions = 0;
    for (const instruction of instructions) {
      if (isReinstallCommand(instruction)) {
        await executeReinstallCommand(
          configuration,
          instruction.payload.token,
        );
        return;
      }
      if (!isClaimedInstruction(instruction)) {
        reportError(new Error("ACOB server returned an invalid instruction"));
        continue;
      }
      if (scheduledExecutions >= limit) {
        executions.push(
          sendResult(
            instruction.id,
            { error: "ACOB server returned more instructions than requested" },
            configuration,
          ).catch(reportError),
        );
        continue;
      }
      scheduledExecutions += 1;
      activeExecutions++;
      executions.push(
        executeInstruction(instruction, configuration)
          .catch(reportError)
          .finally(() => {
            activeExecutions--;
          }),
      );
    }
  } catch (error) {
    reportError(error);
  } finally {
    pollInProgress = false;
  }
  await Promise.allSettled(executions);
}

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (!isRuntimeMessage(message)) {
    return;
  }
  if (message.type === "poll") {
    poll().then(
      () => sendResponse({ ok: true }),
      (error) => {
        sendResponse({
          error: error instanceof Error ? error.message : String(error),
        });
      },
    );
    return true;
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
ensureOffscreenDocument(true).catch(console.error);
