const DEFAULT_BASE_URL = "http://127.0.0.1:58347";

let polling = false;
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

async function executeJavaScript(tid, script) {
  const target = { tabId: tid };
  let attached = false;

  try {
    await chrome.debugger.attach(target, "1.3");
    attached = true;

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
  } finally {
    if (attached) {
      await chrome.debugger.detach(target);
    }
  }
}

async function runInstruction(instruction) {
  const { action, payload } = instruction;

  if (action === "tabs") {
    if (!payload.operation) {
      throw new Error("tabs operation is required");
    }
    const operation = payload.operation;

    if (operation === "list") {
      const tabs = await chrome.tabs.query({});
      return tabs.map(tabDetails);
    }

    if (operation === "close") {
      const tab = await chrome.tabs.get(payload.tid);
      await chrome.tabs.remove(tab.id);
      return { closed: true, tab: tabDetails(tab) };
    }

    if (operation === "new") {
      const createdTab = await chrome.tabs.create({ url: "about:blank" });
      const loadedTab = await waitForTab(createdTab.id);
      return tabDetails(loadedTab);
    }

    throw new Error(`Unknown tabs operation: ${operation}`);
  }

  if (action === "javascript") {
    await chrome.tabs.get(payload.tid);
    return executeJavaScript(payload.tid, payload.script);
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
  if (polling) {
    return;
  }

  polling = true;
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
    polling = false;
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
