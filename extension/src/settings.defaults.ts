// Single source of default setting values. Edit the values here and rebuild;
// src/settings.ts imports them for every definition default, and build.ts
// writes them into the bundled dist/settings.json.
import type { SettingValues } from "./types.js";

export const defaultSettings: SettingValues = {
  "baseUrl": "http://127.0.0.1:58346",
  "allowCleanup": false,
  "instructionsPerPoll": 4,
  "maxConcurrentExecutions": 8,
  "maxTabs": 20,
  "pollIntervalMs": 1000,
  "tabLoadTimeoutMs": 30000,
  "waitTimeoutMs": 30000,
  "httpRequestTimeoutMs": 30000,
  "javascriptTimeoutMs": 60000,
  "maxScreenshotSizeMiB": 30,
  "maxRecordingDurationSec": 600,
  "maxRecordingSizeMiB": 512,
  "consoleTimeoutSec": 180,
  "consoleMaxSizeMiB": 2,
  "resultRetryAttempts": 3,
  "resultRetryDelayMs": 1000,
  "popupStatusDurationMs": 2500,
  "debuggerProtocolVersion": "1.3"
};
