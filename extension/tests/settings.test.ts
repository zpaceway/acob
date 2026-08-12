import assert from "node:assert/strict";
import test from "node:test";

import { ACOBSettings as settings } from "../src/settings.js";
const BID = "0123456789ab4def8123456789abcdef";

test("normalizes a complete default configuration", () => {
  const configuration = settings.normalizeConfiguration({ bid: BID });

  assert.deepEqual(configuration, {
    bid: BID,
    baseUrl: "http://127.0.0.1:58347",
    instructionsPerPoll: 4,
    maxConcurrentExecutions: 8,
    maxTabs: 20,
    pollIntervalMs: 1000,
    tabLoadTimeoutMs: 30000,
    httpRequestTimeoutMs: 30000,
    javascriptTimeoutMs: 60000,
    maxScreenshotSizeMiB: 30,
    maxRecordingDurationMs: 300000,
    maxRecordingSizeMiB: 60,
    resultRetryAttempts: 3,
    resultRetryDelayMs: 1000,
    popupStatusDurationMs: 2500,
    debuggerProtocolVersion: "1.3",
  });
});

test("accepts valid custom settings and canonicalizes the server URL", () => {
  const configuration = settings.normalizeConfiguration({
    bid: BID,
    baseUrl: "https://acob.test/base/",
    instructionsPerPoll: 8,
    maxConcurrentExecutions: 40,
    maxTabs: 50,
    pollIntervalMs: 250,
    tabLoadTimeoutMs: 45000,
    httpRequestTimeoutMs: 10000,
    javascriptTimeoutMs: 45000,
    maxScreenshotSizeMiB: 12,
    maxRecordingDurationMs: 60000,
    maxRecordingSizeMiB: 12,
    resultRetryAttempts: 2,
    resultRetryDelayMs: 500,
    popupStatusDurationMs: 4000,
    debuggerProtocolVersion: "1.4",
  });

  assert.equal(configuration.baseUrl, "https://acob.test/base");
  assert.equal(configuration.instructionsPerPoll, 8);
  assert.equal(configuration.maxConcurrentExecutions, 40);
  assert.equal(configuration.tabLoadTimeoutMs, 45000);
  assert.equal(configuration.httpRequestTimeoutMs, 10000);
  assert.equal(configuration.javascriptTimeoutMs, 45000);
  assert.equal(configuration.maxRecordingDurationMs, 60000);
  assert.equal(configuration.maxRecordingSizeMiB, 12);
  assert.equal(configuration.resultRetryAttempts, 2);
  assert.equal(configuration.debuggerProtocolVersion, "1.4");
});

test("replaces invalid values with their centralized defaults", () => {
  const configuration = settings.normalizeConfiguration({
    bid: BID,
    baseUrl: "ftp://acob.test",
    instructionsPerPoll: 21,
    maxConcurrentExecutions: 0,
    maxTabs: -1,
    pollIntervalMs: 0,
    tabLoadTimeoutMs: 90001,
    httpRequestTimeoutMs: 30001,
    javascriptTimeoutMs: 90001,
    maxScreenshotSizeMiB: 31,
    maxRecordingDurationMs: 300001,
    maxRecordingSizeMiB: 61,
    resultRetryAttempts: 4,
    resultRetryDelayMs: 30001,
    popupStatusDurationMs: -1,
    debuggerProtocolVersion: "latest",
  });

  assert.equal(configuration.baseUrl, "http://127.0.0.1:58347");
  assert.equal(configuration.instructionsPerPoll, 4);
  assert.equal(configuration.maxConcurrentExecutions, 8);
  assert.equal(configuration.maxTabs, 20);
  assert.equal(configuration.pollIntervalMs, 1000);
  assert.equal(configuration.tabLoadTimeoutMs, 30000);
  assert.equal(configuration.httpRequestTimeoutMs, 30000);
  assert.equal(configuration.javascriptTimeoutMs, 60000);
  assert.equal(configuration.maxScreenshotSizeMiB, 30);
  assert.equal(configuration.maxRecordingDurationMs, 300000);
  assert.equal(configuration.maxRecordingSizeMiB, 60);
  assert.equal(configuration.resultRetryAttempts, 3);
  assert.equal(configuration.resultRetryDelayMs, 1000);
  assert.equal(configuration.popupStatusDurationMs, 2500);
  assert.equal(configuration.debuggerProtocolVersion, "1.3");
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

test("validates browser IDs and server URLs", () => {
  assert.equal(settings.isValidBrowserId(BID), true);
  assert.equal(settings.isValidBrowserId("browser-id"), false);
  assert.equal(settings.isValidSetting("baseUrl", "HTTP://acob.test"), true);
  assert.equal(settings.isValidSetting("baseUrl", "http://acob.test?"), false);
  assert.equal(settings.isValidSetting("baseUrl", "http://acob.test#"), false);
});
