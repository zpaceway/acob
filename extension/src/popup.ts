import { getOrCreateBid, rotateBid } from "./bid.js";
import { ACOBSettings } from "./settings.js";
import type {
  GetConfigurationMessage,
  GetConfigurationResponse,
  SettingName,
  SettingsUpdatedMessage,
  SettingValue,
} from "./types.js";

type ElementConstructor<ElementType extends Element> = new () => ElementType;

function requireElement<ElementType extends Element>(
  selector: string,
  constructor: ElementConstructor<ElementType>,
): ElementType {
  const element = document.querySelector(selector);
  if (!(element instanceof constructor)) {
    throw new Error(`Expected ${selector} to be a ${constructor.name}`);
  }
  return element;
}

const form = requireElement("#settings-form", HTMLFormElement);
const configurationFields = requireElement(
  "#configuration-fields",
  HTMLDivElement,
);
const status = requireElement("#status", HTMLParagraphElement);
const settingInputs = new Map<SettingName, HTMLInputElement>();
let bidInput: HTMLInputElement | null = null;
let currentBid = "";
let statusDurationMs =
  ACOBSettings.definitions.popupStatusDurationMs.defaultValue;

function inputId(name: SettingName): string {
  return name.replace(/[A-Z]/g, (character) => `-${character.toLowerCase()}`);
}

function buildConfigurationFields(): void {
  for (const name of ACOBSettings.settingNames) {
    const definition = ACOBSettings.definitions[name];
    if (!definition.visible) {
      continue;
    }
    if (definition.inputType === "checkbox") {
      buildCheckboxField(name);
      continue;
    }
    const id = inputId(name);
    const label = document.createElement("label");
    label.htmlFor = id;
    label.textContent = definition.label;
    label.className =
      "mb-[7px] block text-[13px] font-semibold text-label";

    const input = document.createElement("input");
    input.id = id;
    input.name = name;
    input.type = definition.inputType;
    input.required = true;
    input.readOnly = !definition.editable;
    input.className =
      "h-[42px] w-full rounded-[7px] border border-field-border bg-field px-[11px] text-white outline-none focus:border-acid focus:ring-3 focus:ring-acid/10 read-only:font-mono read-only:text-xs read-only:text-acid";
    const attributes = [
      "min",
      "max",
      "step",
      "pattern",
      "placeholder",
    ] as const;
    for (const attribute of attributes) {
      const value = definition[attribute];
      if (value !== undefined) {
        input.setAttribute(attribute, String(value));
      }
    }
    input.addEventListener("input", () => input.setCustomValidity(""));

    const hint = document.createElement("p");
    hint.className =
      "mt-1.5 mb-[18px] min-h-[18px] text-[11px] leading-normal text-muted";
    hint.textContent = definition.editable
      ? definition.hint
      : `${definition.hint} Read-only in the popup.`;

    configurationFields.append(label, input, hint);
    settingInputs.set(name, input);

  }
}

function buildCheckboxField(name: SettingName): void {
  const definition = ACOBSettings.definitions[name];
  const id = inputId(name);

  const row = document.createElement("div");
  row.className =
    "mb-[18px] flex cursor-pointer items-center justify-between gap-3 rounded-[7px] border border-field-border bg-field px-[11px] py-3";

  const text = document.createElement("div");
  const label = document.createElement("p");
  label.textContent = definition.label;
  label.className = "text-[13px] font-semibold text-label";
  const hint = document.createElement("p");
  hint.className = "mt-0.5 text-[11px] leading-normal text-muted";
  hint.textContent = definition.editable
    ? definition.hint
    : `${definition.hint} Read-only in the popup.`;
  text.append(label, hint);

  const input = document.createElement("input");
  input.id = id;
  input.name = name;
  input.type = "checkbox";
  input.disabled = !definition.editable;
  input.className =
    "h-[22px] w-[22px] shrink-0 cursor-pointer accent-acid disabled:cursor-default";
  input.addEventListener("input", () => input.setCustomValidity(""));

  row.append(text, input);
  row.addEventListener("click", (event) => {
    if (event.target !== input && !input.disabled) {
      input.checked = !input.checked;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });

  configurationFields.append(row);
  settingInputs.set(name, input);
}

function buildBidField(): void {
  const label = document.createElement("label");
  label.htmlFor = "bid";
  label.textContent = "Browser ID (bid)";
  label.className = "mb-[7px] block text-[13px] font-semibold text-label";

  const row = document.createElement("div");
  row.className = "flex gap-2";

  const input = document.createElement("input");
  input.id = "bid";
  input.name = "bid";
  input.type = "text";
  input.readOnly = true;
  input.spellcheck = false;
  input.className =
    "h-[42px] w-full rounded-[7px] border border-field-border bg-field px-[11px] text-white outline-none focus:border-acid focus:ring-3 focus:ring-acid/10 read-only:font-mono read-only:text-xs read-only:text-acid";

  const copyButton = document.createElement("button");
  copyButton.type = "button";
  copyButton.textContent = "Copy";
  copyButton.className =
    "h-[42px] shrink-0 cursor-pointer rounded-[7px] border border-secondary-border bg-secondary px-[12px] text-xs font-bold text-ink hover:brightness-125";

  const rotateButton = document.createElement("button");
  rotateButton.type = "button";
  rotateButton.textContent = "Rotate";
  rotateButton.className =
    "h-[42px] shrink-0 cursor-pointer rounded-[7px] border border-secondary-border bg-secondary px-[12px] text-xs font-bold text-ink hover:brightness-125";

  copyButton.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(currentBid);
      showStatus("Browser ID copied");
    } catch (error) {
      showStatus(error instanceof Error ? error.message : String(error));
    }
  });

  rotateButton.addEventListener("click", async () => {
    try {
      currentBid = await rotateBid();
      input.value = currentBid;
      showStatus("Browser ID rotated");
    } catch (error) {
      showStatus(error instanceof Error ? error.message : String(error));
    }
  });

  row.append(input, copyButton, rotateButton);

  const hint = document.createElement("p");
  hint.className =
    "mt-1.5 mb-[18px] min-h-[18px] text-[11px] leading-normal text-muted";
  hint.textContent =
    "Unique per-browser identity used for targeted instructions. Read-only; use Rotate to generate a new one.";

  configurationFields.append(label, row, hint);
  bidInput = input;
}

function inputValue(
  name: SettingName,
  input: HTMLInputElement,
): SettingValue {
  if (ACOBSettings.definitions[name].valueType === "boolean") {
    return input.checked;
  }
  return ACOBSettings.definitions[name].valueType === "integer"
    ? input.valueAsNumber
    : input.value;
}

function setInputValue(input: HTMLInputElement, value: SettingValue): void {
  if (input.type === "checkbox") {
    input.checked = value === true;
    return;
  }
  input.value = String(value);
}

function showStatus(message: string): void {
  status.textContent = message;
  window.setTimeout(() => {
    if (status.textContent === message) {
      status.textContent = "";
    }
  }, statusDurationMs);
}

async function loadConfiguration(): Promise<void> {
  const configuration = await chrome.runtime.sendMessage<
    GetConfigurationMessage,
    GetConfigurationResponse
  >({ type: "getConfiguration" });
  if ("error" in configuration) {
    throw new Error(configuration.error);
  }

  for (const [name, input] of settingInputs) {
    setInputValue(input, configuration[name]);
  }
  statusDurationMs = configuration.popupStatusDurationMs;
  currentBid = await getOrCreateBid();
  if (bidInput) {
    bidInput.value = currentBid;
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!form.checkValidity()) {
    form.reportValidity();
    return;
  }

  const configuration: Partial<Record<SettingName, SettingValue>> = {};
  for (const [name, input] of settingInputs) {
    const value = inputValue(name, input);
    if (!ACOBSettings.isValidSetting(name, value)) {
      input.setCustomValidity("Enter a valid setting value.");
      input.reportValidity();
      return;
    }
    configuration[name] = ACOBSettings.normalizeSetting(name, value);
  }

  await chrome.storage.local.set(configuration);
  for (const [name, input] of settingInputs) {
    const value = configuration[name];
    if (value !== undefined) {
      setInputValue(input, value);
    }
  }
  showStatus("Settings saved");
  if (typeof configuration.pollIntervalMs === "number") {
    chrome.runtime
      .sendMessage<SettingsUpdatedMessage, void>({
        type: "settingsUpdated",
        pollIntervalMs: configuration.pollIntervalMs,
      })
      .catch(console.error);
  }
});

buildConfigurationFields();
buildBidField();
loadConfiguration().catch((error) => {
  status.textContent = error instanceof Error ? error.message : String(error);
});
