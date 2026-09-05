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
const bidInput = requireElement("#bid", HTMLInputElement);
const copyButton = requireElement("#copy-bid", HTMLButtonElement);
const rotateButton = requireElement("#rotate-bid", HTMLButtonElement);
const status = requireElement("#status", HTMLParagraphElement);
const settingInputs = new Map<SettingName, HTMLInputElement>();
let statusDurationMs =
  ACOBSettings.definitions.popupStatusDurationMs.defaultValue;

let mcpInput: HTMLInputElement | null = null;

function inputId(name: SettingName): string {
  return name.replace(/[A-Z]/g, (character) => `-${character.toLowerCase()}`);
}

function mcpUrlFromValues(baseUrl: string, bid: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, "") || String(ACOBSettings.definitions.baseUrl.defaultValue);
  return `${normalized}/mcp/${bid}`;
}

function updateMcpUrl(): void {
  if (!mcpInput) {
    return;
  }
  const baseUrlInput = settingInputs.get("baseUrl");
  const baseUrl = baseUrlInput?.value.trim() || String(ACOBSettings.definitions.baseUrl.defaultValue);
  const bid = bidInput.value.trim();
  mcpInput.value = mcpUrlFromValues(baseUrl, bid);
}

function buildConfigurationFields(): void {
  for (const name of ACOBSettings.settingNames) {
    const definition = ACOBSettings.definitions[name];
    if (!definition.visible) {
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

    if (name === "baseUrl") {
      const mcpLabel = document.createElement("label");
      mcpLabel.htmlFor = "mcp-url";
      mcpLabel.textContent = "MCP URL";
      mcpLabel.className =
        "mb-[7px] block text-[13px] font-semibold text-label";

      const mcpRow = document.createElement("div");
      mcpRow.className = "grid grid-cols-[1fr_auto] gap-2";

      const inputEl = document.createElement("input");
      inputEl.id = "mcp-url";
      inputEl.type = "text";
      inputEl.readOnly = true;
      inputEl.className =
        "h-[42px] w-full rounded-[7px] border border-field-border bg-field px-[11px] font-mono text-xs text-acid outline-none focus:border-acid focus:ring-3 focus:ring-acid/10";
      mcpInput = inputEl;

      const copyMcpButton = document.createElement("button");
      copyMcpButton.id = "copy-mcp-url";
      copyMcpButton.type = "button";
      copyMcpButton.textContent = "Copy";
      copyMcpButton.className =
        "min-h-[38px] cursor-pointer rounded-[7px] border border-secondary-border bg-secondary px-[15px] text-xs font-bold text-label hover:brightness-110";
      copyMcpButton.addEventListener("click", async () => {
        if (mcpInput) {
          await navigator.clipboard.writeText(mcpInput.value);
          showStatus("MCP URL copied");
        }
      });

      mcpRow.append(inputEl, copyMcpButton);

      const mcpHint = document.createElement("p");
      mcpHint.className =
        "mt-1.5 mb-[18px] min-h-[18px] text-[11px] leading-normal text-muted";
      mcpHint.textContent = "MCP endpoint for this browser (via the proxy).";

      configurationFields.append(mcpLabel, mcpRow, mcpHint);

      input.addEventListener("input", updateMcpUrl);
    }
  }
}

function inputValue(
  name: SettingName,
  input: HTMLInputElement,
): SettingValue {
  return ACOBSettings.definitions[name].valueType === "integer"
    ? input.valueAsNumber
    : input.value;
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
    input.value = String(configuration[name]);
  }
  statusDurationMs = configuration.popupStatusDurationMs;
  bidInput.value = configuration.bid;
  updateMcpUrl();
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
      input.value = String(value);
    }
  }
  updateMcpUrl();
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

copyButton.addEventListener("click", async () => {
  await navigator.clipboard.writeText(bidInput.value);
  showStatus("Browser ID copied");
});

rotateButton.addEventListener("click", async () => {
  const bid = ACOBSettings.generateBrowserId();
  await chrome.storage.local.set({ bid });
  bidInput.value = bid;
  updateMcpUrl();
  showStatus("Browser ID rotated");
});

bidInput.addEventListener("input", updateMcpUrl);

buildConfigurationFields();
loadConfiguration().catch((error) => {
  status.textContent = error instanceof Error ? error.message : String(error);
});
