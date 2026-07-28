const form = document.querySelector("#settings-form");
const configurationFields = document.querySelector("#configuration-fields");
const bidInput = document.querySelector("#bid");
const copyButton = document.querySelector("#copy-bid");
const rotateButton = document.querySelector("#rotate-bid");
const status = document.querySelector("#status");
const settingInputs = new Map();
let statusDurationMs =
  ACOBSettings.definitions.popupStatusDurationMs.defaultValue;

function inputId(name) {
  return name.replace(/[A-Z]/g, (character) => `-${character.toLowerCase()}`);
}

function buildConfigurationFields() {
  for (const name of ACOBSettings.settingNames) {
    const definition = ACOBSettings.definitions[name];
    if (!definition.visible) {
      continue;
    }
    const id = inputId(name);
    const label = document.createElement("label");
    label.htmlFor = id;
    label.textContent = definition.label;

    const input = document.createElement("input");
    input.id = id;
    input.name = name;
    input.type = definition.inputType;
    input.required = true;
    input.readOnly = !definition.editable;
    for (const attribute of ["min", "max", "step", "pattern", "placeholder"]) {
      if (definition[attribute] !== undefined) {
        input.setAttribute(attribute, definition[attribute]);
      }
    }
    input.addEventListener("input", () => input.setCustomValidity(""));

    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent = definition.editable
      ? definition.hint
      : `${definition.hint} Read-only in the popup.`;

    configurationFields.append(label, input, hint);
    settingInputs.set(name, input);
  }
}

function inputValue(name, input) {
  return ACOBSettings.definitions[name].valueType === "integer"
    ? input.valueAsNumber
    : input.value;
}

function showStatus(message) {
  status.textContent = message;
  window.setTimeout(() => {
    if (status.textContent === message) {
      status.textContent = "";
    }
  }, statusDurationMs);
}

async function loadConfiguration() {
  const configuration = await chrome.runtime.sendMessage({
    type: "getConfiguration",
  });
  if (configuration.error) {
    throw new Error(configuration.error);
  }

  for (const [name, input] of settingInputs) {
    input.value = configuration[name];
  }
  statusDurationMs = configuration.popupStatusDurationMs;
  bidInput.value = configuration.bid;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!form.checkValidity()) {
    form.reportValidity();
    return;
  }

  const configuration = {};
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
    input.value = configuration[name];
  }
  showStatus("Settings saved");
  chrome.runtime
    .sendMessage({
      type: "settingsUpdated",
      pollIntervalMs: configuration.pollIntervalMs,
    })
    .catch(console.error);
});

copyButton.addEventListener("click", async () => {
  await navigator.clipboard.writeText(bidInput.value);
  showStatus("Browser ID copied");
});

rotateButton.addEventListener("click", async () => {
  const bid = ACOBSettings.generateBrowserId();
  await chrome.storage.local.set({ bid });
  bidInput.value = bid;
  showStatus("Browser ID rotated");
});

buildConfigurationFields();
loadConfiguration().catch((error) => {
  status.textContent = error instanceof Error ? error.message : String(error);
});
