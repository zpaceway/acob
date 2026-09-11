import assert from "node:assert/strict";
import test from "node:test";

import { ACOBSettings as settings } from "../src/settings.js";
import { defaultSettings } from "../src/settings.defaults.js";

test("normalizes a complete default configuration", () => {
  const configuration = settings.normalizeConfiguration();

  assert.deepEqual(configuration, defaultSettings);
});

test("accepts valid custom settings and canonicalizes the server URL", () => {
  const configuration = settings.normalizeConfiguration({
    baseUrl: "https://acob.test/base/",
    instructionsPerPoll: 8,
    maxConcurrentExecutions: 40,
    maxTabs: 50,
    pollIntervalMs: 250,
    tabLoadTimeoutMs: 45000,
    waitTimeoutMs: 15000,
    httpRequestTimeoutMs: 10000,
    javascriptTimeoutMs: 45000,
    maxScreenshotSizeMiB: 12,
    maxRecordingDurationSec: 60,
    maxRecordingSizeMiB: 12,
    consoleTimeoutSec: 60,
    consoleMaxSizeMiB: 5,
    resultRetryAttempts: 2,
    resultRetryDelayMs: 500,
    popupStatusDurationMs: 4000,
    debuggerProtocolVersion: "1.4",
  });

  assert.equal(configuration.baseUrl, "https://acob.test/base");
  assert.equal(configuration.instructionsPerPoll, 8);
  assert.equal(configuration.maxConcurrentExecutions, 40);
  assert.equal(configuration.tabLoadTimeoutMs, 45000);
  assert.equal(configuration.waitTimeoutMs, 15000);
  assert.equal(configuration.httpRequestTimeoutMs, 10000);
  assert.equal(configuration.javascriptTimeoutMs, 45000);
  assert.equal(configuration.maxRecordingDurationSec, 60);
  assert.equal(configuration.maxRecordingSizeMiB, 12);
  assert.equal(configuration.consoleTimeoutSec, 60);
  assert.equal(configuration.consoleMaxSizeMiB, 5);
  assert.equal(configuration.resultRetryAttempts, 2);
  assert.equal(configuration.resultRetryDelayMs, 500);
  assert.equal(configuration.popupStatusDurationMs, 4000);
  assert.equal(configuration.debuggerProtocolVersion, "1.4");
});

test("replaces invalid values with their centralized defaults", () => {
  const configuration = settings.normalizeConfiguration({
    baseUrl: "ftp://acob.test",
    instructionsPerPoll: 21,
    maxConcurrentExecutions: 0,
    maxTabs: -1,
    pollIntervalMs: 0,
    tabLoadTimeoutMs: 90001,
    waitTimeoutMs: 90001,
    httpRequestTimeoutMs: 30001,
    javascriptTimeoutMs: 90001,
    maxScreenshotSizeMiB: 31,
    maxRecordingDurationSec: 601,
    maxRecordingSizeMiB: 513,
    consoleTimeoutSec: 301,
    consoleMaxSizeMiB: 11,
    resultRetryAttempts: 4,
    resultRetryDelayMs: 30001,
    popupStatusDurationMs: -1,
    debuggerProtocolVersion: "latest",
  });

  assert.equal(configuration.baseUrl, defaultSettings.baseUrl);
  assert.equal(configuration.instructionsPerPoll, defaultSettings.instructionsPerPoll);
  assert.equal(configuration.maxConcurrentExecutions, defaultSettings.maxConcurrentExecutions);
  assert.equal(configuration.maxTabs, defaultSettings.maxTabs);
  assert.equal(configuration.pollIntervalMs, defaultSettings.pollIntervalMs);
  assert.equal(configuration.tabLoadTimeoutMs, defaultSettings.tabLoadTimeoutMs);
  assert.equal(configuration.waitTimeoutMs, defaultSettings.waitTimeoutMs);
  assert.equal(configuration.httpRequestTimeoutMs, defaultSettings.httpRequestTimeoutMs);
  assert.equal(configuration.javascriptTimeoutMs, defaultSettings.javascriptTimeoutMs);
  assert.equal(configuration.maxScreenshotSizeMiB, defaultSettings.maxScreenshotSizeMiB);
  assert.equal(configuration.maxRecordingDurationSec, defaultSettings.maxRecordingDurationSec);
  assert.equal(configuration.maxRecordingSizeMiB, defaultSettings.maxRecordingSizeMiB);
  assert.equal(configuration.consoleTimeoutSec, defaultSettings.consoleTimeoutSec);
  assert.equal(configuration.consoleMaxSizeMiB, defaultSettings.consoleMaxSizeMiB);
  assert.equal(configuration.resultRetryAttempts, defaultSettings.resultRetryAttempts);
  assert.equal(configuration.resultRetryDelayMs, defaultSettings.resultRetryDelayMs);
  assert.equal(configuration.popupStatusDurationMs, defaultSettings.popupStatusDurationMs);
  assert.equal(configuration.debuggerProtocolVersion, defaultSettings.debuggerProtocolVersion);
});

test("validates the cleanup toggle as a strict boolean", () => {
  assert.equal(settings.isValidSetting("allowCleanup", true), true);
  assert.equal(settings.isValidSetting("allowCleanup", false), true);
  assert.equal(settings.isValidSetting("allowCleanup", 1), false);
  assert.equal(settings.isValidSetting("allowCleanup", "true"), false);
  assert.equal(settings.isValidSetting("allowCleanup", undefined), false);
  assert.equal(
    settings.normalizeSetting("allowCleanup", true),
    true,
  );
  assert.equal(
    settings.normalizeSetting("allowCleanup", "yes"),
    false,
  );
  assert.equal(
    settings.normalizeConfiguration({ allowCleanup: true })
      .allowCleanup,
    true,
  );
});

test("converts the configured screenshot limit to bytes", () => {
  assert.equal(settings.mebibytesToBytes(30), 30 * 1024 * 1024);
});

test("marks fixed settings as read-only and hidden", () => {
  assert.equal(settings.definitions.debuggerProtocolVersion.editable, false);
  assert.equal(settings.definitions.debuggerProtocolVersion.visible, false);
  assert.equal(settings.definitions.popupStatusDurationMs.editable, false);
  assert.equal(settings.definitions.popupStatusDurationMs.visible, false);
  for (const [name, definition] of Object.entries(settings.definitions)) {
    if (!["debuggerProtocolVersion", "popupStatusDurationMs"].includes(name)) {
      assert.equal(definition.editable, true);
      assert.equal(definition.visible, true);
    }
  }
});

test("validates server URLs", () => {
  assert.equal(settings.isValidSetting("baseUrl", "HTTP://acob.test"), true);
  assert.equal(settings.isValidSetting("baseUrl", "http://acob.test?"), false);
  assert.equal(settings.isValidSetting("baseUrl", "http://acob.test#"), false);
});
