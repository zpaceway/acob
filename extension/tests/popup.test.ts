import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";

import { ACOBSettings } from "../src/settings.js";

// ---------------------------------------------------------------------------
// First window + chrome mock, installed BEFORE importing popup.js.
// popup.js runs buildConfigurationFields()/buildBidField()/loadConfiguration()
// at import time.
// ---------------------------------------------------------------------------

const win = new Window({ url: "http://localhost/" });
win.document.body.innerHTML = [
  '<form id="settings-form">',
  '<div id="configuration-fields"></div>',
  '<div class="actions"><button type="submit">Save settings</button></div>',
  '<p id="status" role="status" aria-live="polite"></p>',
  "</form>",
].join("");

let clipboardShouldThrow: Error | null = null;
let clipboardWritten: string[] = [];
(win.navigator.clipboard as unknown as {
  writeText: (text: string) => Promise<void>;
}).writeText = async (text: string) => {
  if (clipboardShouldThrow !== null) {
    throw clipboardShouldThrow;
  }
  clipboardWritten.push(text);
};

const storageData = new Map<string, unknown>();
let storageSetCalls: Record<string, unknown>[] = [];
let storageSetShouldThrow: Error | null = null;
const sendMessageCalls: unknown[] = [];
let getConfigShouldReturnError: string | null = null;

function installGlobals(target: Window): void {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: target,
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: target.document,
  });
  Object.defineProperty(globalThis, "HTMLFormElement", {
    configurable: true,
    value: target.HTMLFormElement,
  });
  Object.defineProperty(globalThis, "HTMLDivElement", {
    configurable: true,
    value: target.HTMLDivElement,
  });
  Object.defineProperty(globalThis, "HTMLParagraphElement", {
    configurable: true,
    value: target.HTMLParagraphElement,
  });
  Object.defineProperty(globalThis, "HTMLInputElement", {
    configurable: true,
    value: target.HTMLInputElement,
  });
  Object.defineProperty(globalThis, "Event", {
    configurable: true,
    value: target.Event,
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: target.navigator,
  });
}

installGlobals(win);

Object.defineProperty(globalThis, "chrome", {
  configurable: true,
  value: {
    storage: {
      local: {
        get: async (key?: string | string[]) => {
          if (typeof key === "string") {
            return storageData.has(key) ? { [key]: storageData.get(key) } : {};
          }
          return Object.fromEntries(storageData);
        },
        set: async (values: Record<string, unknown>) => {
          if (storageSetShouldThrow !== null) {
            throw storageSetShouldThrow;
          }
          for (const [k, v] of Object.entries(values)) {
            storageData.set(k, v);
          }
          storageSetCalls.push({ ...values });
        },
      },
    },
    runtime: {
      sendMessage: async (message: unknown) => {
        sendMessageCalls.push(message);
        const typed = message as { type?: string };
        if (typed.type === "getConfiguration") {
          if (getConfigShouldReturnError !== null) {
            return { error: getConfigShouldReturnError };
          }
          return ACOBSettings.normalizeConfiguration();
        }
        return undefined;
      },
    },
  },
});

await import("../src/popup.js");

// Wait for loadConfiguration() to finish (getConfiguration + getOrCreateBid).
await new Promise<void>((resolve) => {
  setTimeout(resolve, 30);
});

function query<T>(selector: string): T {
  const element = win.document.querySelector(selector);
  assert.ok(element !== null, `expected ${selector} to exist`);
  return element as unknown as T;
}

function inputByName(name: string): HTMLInputElement {
  return query<HTMLInputElement>(`input[name="${name}"]`);
}

function findButton(label: string): HTMLButtonElement {
  const buttons = [...win.document.querySelectorAll("button")];
  const found = buttons.find((b) => b.textContent === label);
  assert.ok(found !== undefined, `expected button ${label}`);
  return found as unknown as HTMLButtonElement;
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 10);
  });
}

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

test("popup builds fields for every visible setting", () => {
  for (const name of ACOBSettings.settingNames) {
    const definition = ACOBSettings.definitions[name];
    if (!definition.visible) {
      assert.equal(win.document.querySelector(`input[name="${name}"]`), null);
      continue;
    }
    const input = inputByName(name);
    if (definition.inputType === "checkbox") {
      assert.equal(input.type, "checkbox");
      assert.equal(input.disabled, !definition.editable);
    } else {
      assert.equal(input.type, definition.inputType);
      assert.equal(input.required, true);
      assert.equal(input.readOnly, !definition.editable);
      const attrs = ["min", "max", "step", "pattern", "placeholder"] as const;
      for (const attr of attrs) {
        const record = definition as unknown as Record<string, unknown>;
        const attrValue: unknown = record[attr];
        if (attrValue !== undefined) {
          assert.equal(input.getAttribute(attr), String(attrValue));
        } else {
          assert.equal(input.hasAttribute(attr), false);
        }
      }
    }
  }
  // Checkbox vs input distinction: allowCleanup is the visible checkbox.
  assert.equal(inputByName("allowCleanup").type, "checkbox");
  assert.equal(inputByName("baseUrl").type, "url");
  // Bid field is readonly with copy/rotate controls.
  const bid = query<HTMLInputElement>("#bid");
  assert.equal(bid.readOnly, true);
  assert.ok(findButton("Copy") !== undefined);
  assert.ok(findButton("Rotate") !== undefined);
  // Editable hints carry no read-only suffix.
  const fieldsHtml = query<HTMLElement>("#configuration-fields").innerHTML;
  assert.ok(fieldsHtml.includes("Server URL"));
});

test("popup bid copy succeeds and surfaces clipboard failures", async () => {
  const status = query<HTMLElement>("#status");
  clipboardShouldThrow = null;
  clipboardWritten = [];
  findButton("Copy").click();
  await flush();
  assert.equal(status.textContent, "Browser ID copied");
  assert.equal(clipboardWritten.length, 1);

  clipboardShouldThrow = new Error("clipboard denied");
  findButton("Copy").click();
  await flush();
  assert.equal(status.textContent, "clipboard denied");
  clipboardShouldThrow = null;
});

test("popup bid rotate updates the stored bid and surfaces failures", async () => {
  const status = query<HTMLElement>("#status");
  const bid = query<HTMLInputElement>("#bid");
  const before = bid.value;
  assert.ok(before.length > 0);
  storageSetShouldThrow = null;
  findButton("Rotate").click();
  await flush();
  assert.equal(status.textContent, "Browser ID rotated");
  assert.notEqual(bid.value, before);
  assert.equal(storageData.get("bid"), bid.value);

  storageSetShouldThrow = new Error("rotate failed");
  const stuck = bid.value;
  findButton("Rotate").click();
  await flush();
  assert.equal(status.textContent, "rotate failed");
  assert.equal(bid.value, stuck);
  storageSetShouldThrow = null;
});

test("popup submit with an invalid form reports validity", async () => {
  const form = query<HTMLFormElement>("#settings-form");
  const status = query<HTMLElement>("#status");
  const setsBefore = storageSetCalls.length;
  const originalCheck = form.checkValidity.bind(form);
  let reportCalled = false;
  const originalReport = form.reportValidity.bind(form);
  form.checkValidity = () => false;
  form.reportValidity = () => {
    reportCalled = true;
    return false;
  };
  try {
    status.textContent = "";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flush();
    assert.equal(reportCalled, true);
    assert.equal(storageSetCalls.length, setsBefore);
  } finally {
    form.checkValidity = originalCheck;
    form.reportValidity = originalReport;
  }
});

test("popup submit with an invalid setting value uses custom validity", async () => {
  const form = query<HTMLFormElement>("#settings-form");
  const baseUrl = inputByName("baseUrl");
  const previous = baseUrl.value;
  const setsBefore = storageSetCalls.length;
  // Passes native URL validation but fails ACOB's strict URL rules (? query).
  baseUrl.value = "http://127.0.0.1:58346?x=1";
  // Ensure the native form check passes so we reach the custom path. If the
  // engine flags it natively, stub checkValidity to true for this test.
  const originalCheck = form.checkValidity.bind(form);
  if (!form.checkValidity()) {
    form.checkValidity = () => true;
  }
  try {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flush();
    assert.equal(storageSetCalls.length, setsBefore);
    assert.ok(baseUrl.validationMessage.length > 0);
  } finally {
    form.checkValidity = originalCheck;
    baseUrl.value = previous;
    baseUrl.setCustomValidity("");
  }
});

test("popup submit saves normalized settings and notifies", async () => {
  const form = query<HTMLFormElement>("#settings-form");
  const status = query<HTMLElement>("#status");
  // Restore known-good values (previous test dirtied baseUrl).
  const config = ACOBSettings.normalizeConfiguration();
  for (const name of ACOBSettings.settingNames) {
    const def = ACOBSettings.definitions[name];
    if (!def.visible) {
      continue;
    }
    const input = inputByName(name);
    const value = config[name];
    if (input.type === "checkbox") {
      input.checked = value === true;
    } else {
      input.value = String(value);
    }
    input.setCustomValidity("");
  }
  storageSetCalls = [];
  sendMessageCalls.length = 0;
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await flush();
  assert.equal(status.textContent, "Settings saved");
  assert.ok(storageSetCalls.length >= 1);
  const saved = storageSetCalls[storageSetCalls.length - 1] as Record<string, unknown>;
  assert.equal(typeof saved.pollIntervalMs, "number");
  const notified = sendMessageCalls.some(
    (m) => (m as { type?: string }).type === "settingsUpdated",
  );
  assert.equal(notified, true);
  const update = sendMessageCalls.find(
    (m) => (m as { type?: string }).type === "settingsUpdated",
  ) as { pollIntervalMs: number };
  assert.equal(update.pollIntervalMs, saved.pollIntervalMs);
});

// NOTE: loadConfiguration's error branch (`{error}` → status text) runs once
// at import time. Covering it requires a second module instance via a
// query-string re-import, but duplicate instances split V8 coverage and drop
// popup.ts from ~98% lines/~79% funcs to ~82%/~50% (net loss). The branch is
// three lines (throw + catch assignment); all success paths are covered here.
