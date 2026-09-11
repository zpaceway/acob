import type {
  Configuration,
  SettingDefinitions,
  SettingName,
  SettingsApi,
  SettingValue,
  SettingValues,
  StorageKey,
} from "./types.js";
import { defaultSettings } from "./settings.defaults.js";

const MEBIBYTE_IN_BYTES = 1024 * 1024;
const MAX_HTTP_REQUEST_TIMEOUT_MS = 30_000;
const MAX_JAVASCRIPT_TIMEOUT_MS = 90_000;
const MAX_RECORDING_DURATION_SECONDS = 600;
const MAX_CONSOLE_TIMEOUT_SEC = 300;
const MAX_CONSOLE_SIZE_MIB = 10;
const MAX_RESULT_RETRY_ATTEMPTS = 3;
const MAX_RESULT_RETRY_DELAY_MS = 30_000;
const MAX_TAB_LOAD_TIMEOUT_MS = 90_000;
const MAX_WAIT_TIMEOUT_MS = 90_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

const definitions: SettingDefinitions = {
  baseUrl: {
    defaultValue: defaultSettings.baseUrl,
    valueType: "url",
    inputType: "url",
    label: "Server URL",
    hint: "The extension polls this server for instructions.",
    placeholder: "http://127.0.0.1:58346",
    editable: true,
    visible: true,
  },
  allowCleanup: {
    defaultValue: defaultSettings.allowCleanup,
    valueType: "boolean",
    inputType: "checkbox",
    label: "Allow browser cleanup",
    hint: "When checked, the extension accepts cleanup instructions that wipe cookies, storage, history, and cache.",
    editable: true,
    visible: true,
  },
  instructionsPerPoll: {
    defaultValue: defaultSettings.instructionsPerPoll,
    valueType: "integer",
    inputType: "number",
    label: "Instructions per poll",
    hint: "Instructions claimed from the server in each poll.",
    min: 1,
    max: 20,
    step: 1,
    editable: true,
    visible: true,
  },
  maxConcurrentExecutions: {
    defaultValue: defaultSettings.maxConcurrentExecutions,
    valueType: "integer",
    inputType: "number",
    label: "Concurrent executions",
    hint: "Maximum instructions running at the same time.",
    min: 1,
    step: 1,
    editable: true,
    visible: true,
  },
  maxTabs: {
    defaultValue: defaultSettings.maxTabs,
    valueType: "integer",
    inputType: "number",
    label: "Maximum tabs",
    hint: "New tab requests fail when this limit is reached.",
    min: 1,
    step: 1,
    editable: true,
    visible: true,
  },
  pollIntervalMs: {
    defaultValue: defaultSettings.pollIntervalMs,
    valueType: "integer",
    inputType: "number",
    label: "Poll interval (ms)",
    hint: "Delay between instruction queue polls.",
    min: 1,
    max: MAX_TIMER_DELAY_MS,
    step: 1,
    editable: true,
    visible: true,
  },
  tabLoadTimeoutMs: {
    defaultValue: defaultSettings.tabLoadTimeoutMs,
    valueType: "integer",
    inputType: "number",
    label: "Tab load timeout (ms)",
    hint: "Maximum wait for a navigated tab to finish loading.",
    min: 1,
    max: MAX_TAB_LOAD_TIMEOUT_MS,
    step: 1,
    editable: true,
    visible: true,
  },
  waitTimeoutMs: {
    defaultValue: defaultSettings.waitTimeoutMs,
    valueType: "integer",
    inputType: "number",
    label: "Wait timeout (ms)",
    hint: "Default maximum wait for a selector to appear when wait omits timeout_ms.",
    min: 1,
    max: MAX_WAIT_TIMEOUT_MS,
    step: 1,
    editable: true,
    visible: true,
  },
  httpRequestTimeoutMs: {
    defaultValue: defaultSettings.httpRequestTimeoutMs,
    valueType: "integer",
    inputType: "number",
    label: "HTTP request timeout (ms)",
    hint: "Maximum wait for queue and result HTTP requests.",
    min: 1,
    max: MAX_HTTP_REQUEST_TIMEOUT_MS,
    step: 1,
    editable: true,
    visible: true,
  },
  javascriptTimeoutMs: {
    defaultValue: defaultSettings.javascriptTimeoutMs,
    valueType: "integer",
    inputType: "number",
    label: "JavaScript timeout (ms)",
    hint: "Maximum wait for an evaluated script or promise.",
    min: 1,
    max: MAX_JAVASCRIPT_TIMEOUT_MS,
    step: 1,
    editable: true,
    visible: true,
  },
  maxScreenshotSizeMiB: {
    defaultValue: defaultSettings.maxScreenshotSizeMiB,
    valueType: "integer",
    inputType: "number",
    label: "Screenshot limit (MiB)",
    hint: "Maximum encoded screenshot size accepted by the server.",
    min: 1,
    max: 30,
    step: 1,
    editable: true,
    visible: true,
  },
  maxRecordingDurationSec: {
    defaultValue: defaultSettings.maxRecordingDurationSec,
    valueType: "integer",
    inputType: "number",
    label: "Recording duration (s)",
    hint: "Maximum recording length in seconds; recordings stop automatically at this limit.",
    min: 1,
    max: MAX_RECORDING_DURATION_SECONDS,
    step: 1,
    editable: true,
    visible: true,
  },
  maxRecordingSizeMiB: {
    defaultValue: defaultSettings.maxRecordingSizeMiB,
    valueType: "integer",
    inputType: "number",
    label: "Recording limit (MiB)",
    hint: "Maximum encoded recording size accepted by the server.",
    min: 1,
    max: 512,
    step: 1,
    editable: true,
    visible: true,
  },
  consoleTimeoutSec: {
    defaultValue: defaultSettings.consoleTimeoutSec,
    valueType: "integer",
    inputType: "number",
    label: "Console timeout (s)",
    hint: "Maximum console capture length in seconds; captures stop collecting entries at this limit.",
    min: 10,
    max: MAX_CONSOLE_TIMEOUT_SEC,
    step: 1,
    editable: true,
    visible: true,
  },
  consoleMaxSizeMiB: {
    defaultValue: defaultSettings.consoleMaxSizeMiB,
    valueType: "integer",
    inputType: "number",
    label: "Console limit (MiB)",
    hint: "Maximum encoded console capture size accepted by the server.",
    min: 1,
    max: MAX_CONSOLE_SIZE_MIB,
    step: 1,
    editable: true,
    visible: true,
  },
  resultRetryAttempts: {
    defaultValue: defaultSettings.resultRetryAttempts,
    valueType: "integer",
    inputType: "number",
    label: "Result retry attempts",
    hint: "Maximum attempts to send an instruction result.",
    min: 1,
    max: MAX_RESULT_RETRY_ATTEMPTS,
    step: 1,
    editable: true,
    visible: true,
  },
  resultRetryDelayMs: {
    defaultValue: defaultSettings.resultRetryDelayMs,
    valueType: "integer",
    inputType: "number",
    label: "Result retry delay (ms)",
    hint: "Delay between result submission attempts.",
    min: 0,
    max: MAX_RESULT_RETRY_DELAY_MS,
    step: 1,
    editable: true,
    visible: true,
  },
  popupStatusDurationMs: {
    defaultValue: defaultSettings.popupStatusDurationMs,
    valueType: "integer",
    inputType: "number",
    label: "Popup status duration (ms)",
    hint: "How long popup confirmation messages remain visible.",
    min: 0,
    max: MAX_TIMER_DELAY_MS,
    step: 1,
    editable: false,
    visible: false,
  },
  debuggerProtocolVersion: {
    defaultValue: defaultSettings.debuggerProtocolVersion,
    valueType: "string",
    inputType: "text",
    label: "Debugger protocol version",
    hint: "Chromium DevTools protocol version used when attaching.",
    pattern: "[0-9]+\\.[0-9]+",
    editable: false,
    visible: false,
  },
};

for (const definition of Object.values(definitions)) {
  Object.freeze(definition);
}
Object.freeze(definitions);

function isSettingName(name: string): name is SettingName {
  return Object.hasOwn(definitions, name);
}

function isValidSetting<Name extends SettingName>(
  name: Name,
  value: unknown,
): value is SettingValues[Name];
function isValidSetting(name: string, value: unknown): boolean;
function isValidSetting(name: string, value: unknown): boolean {
  if (!isSettingName(name)) {
    return false;
  }
  const definition = definitions[name];
  if (definition.valueType === "boolean") {
    return typeof value === "boolean";
  }
  if (definition.valueType === "integer") {
    return (
      typeof value === "number" &&
      Number.isSafeInteger(value) &&
      (definition.min === undefined || value >= definition.min) &&
      (definition.max === undefined || value <= definition.max)
    );
  }
  if (definition.valueType === "url") {
    if (
      typeof value !== "string" ||
      !value.trim() ||
      value.includes("?") ||
      value.includes("#")
    ) {
      return false;
    }
    try {
      const parsed = new URL(value.trim());
      return (
        ["http:", "https:"].includes(parsed.protocol) &&
        Boolean(parsed.hostname) &&
        !parsed.search &&
        !parsed.hash
      );
    } catch {
      return false;
    }
  }
  if (typeof value !== "string" || !value.trim()) {
    return false;
  }
  return (
    definition.pattern === undefined ||
    new RegExp(`^(?:${definition.pattern})$`).test(value.trim())
  );
}

function normalizeSetting<Name extends SettingName>(
  name: Name,
  value: unknown,
): SettingValues[Name];
function normalizeSetting(name: string, value: unknown): SettingValue | undefined;
function normalizeSetting(
  name: string,
  value: unknown,
): SettingValue | undefined {
  if (!isSettingName(name)) {
    return undefined;
  }
  const definition = definitions[name];
  if (!isValidSetting(name, value)) {
    return definition.defaultValue;
  }
  if (definition.valueType === "url") {
    return (value as string).trim().replace(/\/+$/, "");
  }
  return typeof value === "string" ? value.trim() : value;
}

const settingNames = Object.freeze(Object.keys(definitions) as SettingName[]);
const storageKeys = Object.freeze<StorageKey[]>([...settingNames]);

function normalizeConfiguration(
  values: Readonly<Partial<Record<StorageKey, unknown>>> = {},
): Configuration {
  const normalizedSettings = Object.fromEntries(
    settingNames.map((name) => [name, normalizeSetting(name, values[name])]),
  ) as unknown as SettingValues;
  return normalizedSettings;
}

export const ACOBSettings: Readonly<SettingsApi> = Object.freeze({
  definitions,
  isValidSetting,
  mebibytesToBytes: (value: number) => value * MEBIBYTE_IN_BYTES,
  normalizeConfiguration,
  normalizeSetting,
  settingNames,
  storageKeys,
});

export default ACOBSettings;
