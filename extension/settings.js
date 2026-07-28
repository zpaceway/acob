(() => {
  const MEBIBYTE_IN_BYTES = 1024 * 1024;
  const MAX_HTTP_REQUEST_TIMEOUT_MS = 30_000;
  const MAX_JAVASCRIPT_TIMEOUT_MS = 90_000;
  const MAX_RESULT_RETRY_ATTEMPTS = 3;
  const MAX_RESULT_RETRY_DELAY_MS = 30_000;
  const MAX_TAB_LOAD_TIMEOUT_MS = 90_000;
  const MAX_TIMER_DELAY_MS = 2_147_483_647;

  const definitions = {
    baseUrl: {
      defaultValue: "http://127.0.0.1:58347",
      valueType: "url",
      inputType: "url",
      label: "Server URL",
      hint: "The extension polls this server for instructions.",
      placeholder: "http://127.0.0.1:58347",
      editable: true,
      visible: true,
    },
    instructionsPerPoll: {
      defaultValue: 4,
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
      defaultValue: 8,
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
      defaultValue: 20,
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
      defaultValue: 1000,
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
      defaultValue: 30000,
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
    httpRequestTimeoutMs: {
      defaultValue: 30000,
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
      defaultValue: 60000,
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
      defaultValue: 30,
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
    resultRetryAttempts: {
      defaultValue: 3,
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
      defaultValue: 1000,
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
      defaultValue: 2500,
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
      defaultValue: "1.3",
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

  function generateBrowserId() {
    return crypto.randomUUID().replaceAll("-", "");
  }

  function isValidBrowserId(value) {
    return (
      typeof value === "string" &&
      /^[0-9a-f]{12}4[0-9a-f]{3}[89ab][0-9a-f]{15}$/.test(value)
    );
  }

  function isValidSetting(name, value) {
    const definition = definitions[name];
    if (!definition) {
      return false;
    }
    if (definition.valueType === "integer") {
      return (
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

  function normalizeSetting(name, value) {
    const definition = definitions[name];
    if (!definition || !isValidSetting(name, value)) {
      return definition?.defaultValue;
    }
    if (definition.valueType === "url") {
      return value.trim().replace(/\/+$/, "");
    }
    return typeof value === "string" ? value.trim() : value;
  }

  function normalizeConfiguration(values = {}) {
    const configuration = {
      bid: isValidBrowserId(values.bid) ? values.bid : generateBrowserId(),
    };
    for (const name of Object.keys(definitions)) {
      configuration[name] = normalizeSetting(name, values[name]);
    }
    return configuration;
  }

  globalThis.ACOBSettings = Object.freeze({
    definitions,
    generateBrowserId,
    isValidBrowserId,
    isValidSetting,
    mebibytesToBytes: (value) => value * MEBIBYTE_IN_BYTES,
    normalizeConfiguration,
    normalizeSetting,
    settingNames: Object.freeze(Object.keys(definitions)),
    storageKeys: Object.freeze(["bid", ...Object.keys(definitions)]),
  });
})();
