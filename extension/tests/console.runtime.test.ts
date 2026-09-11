import assert from "node:assert/strict";
import test from "node:test";

import {
  CONSOLE_READ_SCRIPT,
  CONSOLE_RESTORE_SCRIPT,
  formatConsoleArg,
  truncateToBuffer,
} from "../src/consoleUtil.js";
import type { ConsoleEntry } from "../src/consoleUtil.js";

// ---------------------------------------------------------------------------
// Chrome mock: installed BEFORE importing console.js because cdp.js touches
// chrome.debugger.onDetach at module top level.
// ---------------------------------------------------------------------------

let tabsShouldFail = false;
let readValue: unknown = { entries: [], truncated: false };
let readShouldThrow: Error | null = null;
let readExceptionDetails = false;
let installShouldThrow: Error | null = null;
let installExceptionDetails = false;
let restoreShouldThrow: Error | null = null;
const evaluatedExpressions: string[] = [];
let restoreCalls = 0;

Object.defineProperty(globalThis, "chrome", {
  configurable: true,
  value: {
    debugger: {
      onDetach: {
        addListener: () => undefined,
        removeListener: () => undefined,
      },
      attach: async () => undefined,
      detach: async () => undefined,
      sendCommand: async (
        _target: unknown,
        method: string,
        parameters: Record<string, unknown> | undefined,
      ) => {
        if (method !== "Runtime.evaluate") {
          return {};
        }
        const expression = parameters?.expression as string;
        evaluatedExpressions.push(expression);
        if (expression === CONSOLE_READ_SCRIPT) {
          if (readShouldThrow !== null) {
            throw readShouldThrow;
          }
          if (readExceptionDetails) {
            return { exceptionDetails: { text: "read boom" }, result: {} };
          }
          return { result: { type: "object", value: readValue } };
        }
        if (expression === CONSOLE_RESTORE_SCRIPT) {
          restoreCalls += 1;
          if (restoreShouldThrow !== null) {
            throw restoreShouldThrow;
          }
          return { result: { type: "boolean", value: true } };
        }
        // Install script (dynamic deadline/maxBytes expression).
        if (installShouldThrow !== null) {
          throw installShouldThrow;
        }
        if (installExceptionDetails) {
          return { exceptionDetails: { text: "install boom" }, result: {} };
        }
        return { result: { type: "boolean", value: true } };
      },
    },
    tabs: {
      get: async (tid: number) => {
        if (tabsShouldFail) {
          throw new Error("No tab with id");
        }
        return { id: tid };
      },
    },
  },
});

const {
  executeConsoleStart,
  executeConsoleCapture,
  executeConsoleStop,
  executeConsole,
} = await import("../src/console.js");
const { ACOBSettings } = await import("../src/settings.js");
const { state } = await import("../src/state.js");

const baseConfiguration = ACOBSettings.normalizeConfiguration();

function resetConsoleMocks(): void {
  tabsShouldFail = false;
  readValue = { entries: [], truncated: false };
  readShouldThrow = null;
  readExceptionDetails = false;
  installShouldThrow = null;
  installExceptionDetails = false;
  restoreShouldThrow = null;
  evaluatedExpressions.length = 0;
  restoreCalls = 0;
  state.consoleSessions.clear();
  state.reinstallScheduled = false;
}

function sampleEntries(): ConsoleEntry[] {
  return [
    { t: 1, level: "log", text: "hello" },
    { t: 2, level: "warn", text: "world" },
  ];
}

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------

test("console start succeeds and records a session", async () => {
  resetConsoleMocks();
  const result = await executeConsoleStart(11, baseConfiguration);
  assert.deepEqual(result, { started: true });
  assert.equal(state.consoleSessions.has(11), true);
});

test("console start rejects a duplicate session", async () => {
  resetConsoleMocks();
  await executeConsoleStart(12, baseConfiguration);
  await assert.rejects(executeConsoleStart(12, baseConfiguration), /already active/);
  assert.equal(state.consoleSessions.has(12), true);
});

test("console start surfaces install evaluation failures", async () => {
  resetConsoleMocks();
  installExceptionDetails = true;
  await assert.rejects(executeConsoleStart(13, baseConfiguration), /install boom/);
  assert.equal(state.consoleSessions.has(13), false);
});

// ---------------------------------------------------------------------------
// capture
// ---------------------------------------------------------------------------

test("console capture returns entries with truncated flags", async () => {
  resetConsoleMocks();
  await executeConsoleStart(21, baseConfiguration);
  readValue = { entries: sampleEntries(), truncated: false };
  const first = await executeConsoleCapture(21, baseConfiguration);
  assert.equal(first.entries, 2);
  assert.equal(first.truncated, false);
  assert.equal(first.content_type, "application/json");
  assert.equal(
    Buffer.from(first.data, "base64").toString("utf-8"),
    JSON.stringify(sampleEntries()),
  );

  readValue = { entries: sampleEntries(), truncated: true };
  const second = await executeConsoleCapture(21, baseConfiguration);
  assert.equal(second.truncated, true);
  assert.equal(second.entries, 2);
});

test("console capture rejects with no session", async () => {
  resetConsoleMocks();
  await assert.rejects(executeConsoleCapture(22, baseConfiguration), /No active console capture/);
});

test("console capture drops the session when the tab is closed", async () => {
  resetConsoleMocks();
  await executeConsoleStart(23, baseConfiguration);
  tabsShouldFail = true;
  await assert.rejects(executeConsoleCapture(23, baseConfiguration), /may be closed/);
  assert.equal(state.consoleSessions.has(23), false);
});

test("console capture drops the session on read rejection", async () => {
  resetConsoleMocks();
  await executeConsoleStart(24, baseConfiguration);
  readShouldThrow = new Error("detached");
  await assert.rejects(executeConsoleCapture(24, baseConfiguration), /detached/);
  assert.equal(state.consoleSessions.has(24), false);
});

test("console capture surfaces evaluation exceptions as tab-closed", async () => {
  resetConsoleMocks();
  await executeConsoleStart(25, baseConfiguration);
  readExceptionDetails = true;
  await assert.rejects(executeConsoleCapture(25, baseConfiguration), /may be closed/);
  assert.equal(state.consoleSessions.has(25), false);
});

test("console capture treats a navigated page as lost", async () => {
  resetConsoleMocks();
  await executeConsoleStart(26, baseConfiguration);
  readValue = { lost: true };
  await assert.rejects(executeConsoleCapture(26, baseConfiguration), /lost.*start again/);
  assert.equal(state.consoleSessions.has(26), false);
});

test("console capture treats non-object page values as lost", async () => {
  for (const bad of [null, 42, "nope", undefined]) {
    resetConsoleMocks();
    await executeConsoleStart(27, baseConfiguration);
    readValue = bad;
    await assert.rejects(
      executeConsoleCapture(27, baseConfiguration),
      /lost.*start again/,
    );
    assert.equal(state.consoleSessions.has(27), false);
  }
});

test("console capture treats missing entries as lost", async () => {
  resetConsoleMocks();
  await executeConsoleStart(28, baseConfiguration);
  readValue = { entries: "not-an-array", truncated: false };
  await assert.rejects(executeConsoleCapture(28, baseConfiguration), /lost/);
  assert.equal(state.consoleSessions.has(28), false);
});

test("console capture applies worker-side truncation for large buffers", async () => {
  resetConsoleMocks();
  const small = {
    ...baseConfiguration,
    consoleMaxSizeMiB: 1,
  };
  await executeConsoleStart(29, small);
  const big: ConsoleEntry[] = [];
  for (let i = 0; i < 30; i += 1) {
    big.push({ t: i, level: "log", text: `line ${i} ${"x".repeat(100_000)}` });
  }
  readValue = { entries: big, truncated: false };
  const result = await executeConsoleCapture(29, small);
  assert.equal(result.truncated, true);
  assert.ok(result.entries < big.length);
  assert.ok(result.size_bytes <= 1 * 1024 * 1024);
});

// ---------------------------------------------------------------------------
// stop
// ---------------------------------------------------------------------------

test("console stop restores the shim and drops the session", async () => {
  resetConsoleMocks();
  await executeConsoleStart(31, baseConfiguration);
  readValue = { entries: sampleEntries(), truncated: false };
  const result = await executeConsoleStop(31, baseConfiguration);
  assert.equal(result.entries, 2);
  assert.equal(result.truncated, false);
  assert.equal(state.consoleSessions.has(31), false);
  assert.ok(
    evaluatedExpressions.includes(CONSOLE_RESTORE_SCRIPT),
    "expected CONSOLE_RESTORE_SCRIPT to be evaluated on stop",
  );
  assert.ok(restoreCalls >= 1);
});

test("console stop tolerates restore failures (best-effort)", async () => {
  resetConsoleMocks();
  await executeConsoleStart(32, baseConfiguration);
  readValue = { entries: sampleEntries(), truncated: false };
  restoreShouldThrow = new Error("restore detached");
  const result = await executeConsoleStop(32, baseConfiguration);
  assert.equal(result.entries, 2);
  assert.equal(state.consoleSessions.has(32), false);
});

test("console stop on a lost buffer restores and throws", async () => {
  resetConsoleMocks();
  await executeConsoleStart(33, baseConfiguration);
  readValue = { lost: true };
  await assert.rejects(executeConsoleStop(33, baseConfiguration), /lost.*start again/);
  assert.equal(state.consoleSessions.has(33), false);
  assert.ok(evaluatedExpressions.includes(CONSOLE_RESTORE_SCRIPT));
});

test("console stop drops the session when the tab is closed", async () => {
  resetConsoleMocks();
  await executeConsoleStart(34, baseConfiguration);
  tabsShouldFail = true;
  await assert.rejects(executeConsoleStop(34, baseConfiguration), /may be closed/);
  assert.equal(state.consoleSessions.has(34), false);
});

test("console stop rejects with no session", async () => {
  resetConsoleMocks();
  await assert.rejects(executeConsoleStop(35, baseConfiguration), /No active console capture/);
});

test("console stop drops the session on read rejection", async () => {
  resetConsoleMocks();
  await executeConsoleStart(36, baseConfiguration);
  readShouldThrow = new Error("gone");
  await assert.rejects(executeConsoleStop(36, baseConfiguration), /gone/);
  assert.equal(state.consoleSessions.has(36), false);
});

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------

test("executeConsole dispatches start/capture/stop", async () => {
  resetConsoleMocks();
  const started = await executeConsole({ method: "start", tid: 41 }, baseConfiguration);
  assert.deepEqual(started, { started: true });

  readValue = { entries: sampleEntries(), truncated: false };
  const captured = await executeConsole({ method: "capture", tid: 41 }, baseConfiguration);
  assert.equal((captured as { entries: number }).entries, 2);

  readValue = { entries: sampleEntries(), truncated: false };
  const stopped = await executeConsole({ method: "stop", tid: 41 }, baseConfiguration);
  assert.equal((stopped as { entries: number }).entries, 2);
  assert.equal(state.consoleSessions.has(41), false);
});

// ---------------------------------------------------------------------------
// consoleUtil top-ups (kept here; tests/console.test.ts is owned elsewhere)
// ---------------------------------------------------------------------------

test("consoleUtil formats function values", () => {
  assert.equal(formatConsoleArg(() => 1), "[Function]");
  assert.equal(
    formatConsoleArg({ fn: () => 1 } as unknown as Record<string, unknown>),
    JSON.stringify({ fn: "[Function]" }),
  );
});

test("consoleUtil truncateToBuffer reports empty over the cap", () => {
  const entries: ConsoleEntry[] = [{ t: 1, level: "log", text: "hi" }];
  const result = truncateToBuffer(entries, 0);
  assert.deepEqual(result.entries, []);
  assert.equal(result.truncated, true);
  assert.equal(result.size_bytes, new TextEncoder().encode("[]").length);

  const tiny = truncateToBuffer(entries, 1);
  assert.deepEqual(tiny.entries, []);
  assert.equal(tiny.truncated, true);
});
