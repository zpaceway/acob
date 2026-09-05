import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import {
  base64EncodeUtf8,
  buildConsoleInstallScript,
  buildConsoleUpload,
  CONSOLE_READ_SCRIPT,
  CONSOLE_RESTORE_SCRIPT,
  formatConsoleArg,
  formatConsoleArgs,
  truncateToBuffer,
  utf8ByteLength,
} from "../src/consoleUtil.js";
import type { ConsoleEntry } from "../src/consoleUtil.js";

test("formats top-level primitives", () => {
  assert.equal(formatConsoleArg(undefined), "undefined");
  assert.equal(formatConsoleArg("hello"), "hello");
  assert.equal(formatConsoleArg(123), "123");
  assert.equal(formatConsoleArg(true), "true");
  assert.equal(formatConsoleArg(null), "null");
  assert.equal(formatConsoleArg(123n), "123n");
  assert.equal(
    formatConsoleArg(() => undefined),
    "[Function]",
  );
});

test("formats objects with JSON and handles nested specials", () => {
  assert.equal(formatConsoleArg({ a: 1 }), JSON.stringify({ a: 1 }));
  assert.equal(
    formatConsoleArg({ fn: () => 1 } as unknown as Record<string, unknown>),
    JSON.stringify({ fn: "[Function]" }),
  );
  assert.equal(
    formatConsoleArg({ n: 5n } as unknown as Record<string, unknown>),
    JSON.stringify({ n: "5n" }),
  );
});

test("maps circular references to [Circular]", () => {
  const target: Record<string, unknown> = {};
  target.self = target;
  const formatted = formatConsoleArg(target);
  assert.ok(formatted.includes("[Circular]"));
});

test("falls back to String() then [Unserializable]", () => {
  const failing = {
    toJSON(): unknown {
      throw new Error("nope");
    },
    toString(): string {
      return "fallback-string";
    },
  };
  assert.equal(formatConsoleArg(failing), "fallback-string");

  const unserializable = {
    toJSON(): unknown {
      throw new Error("nope");
    },
    toString(): string {
      throw new Error("also nope");
    },
  };
  assert.equal(formatConsoleArg(unserializable), "[Unserializable]");
});

test("joins multiple args with spaces", () => {
  assert.equal(formatConsoleArgs(["a", 1, true]), "a 1 true");
  assert.equal(formatConsoleArgs([undefined, "x"]), "undefined x");
  assert.equal(formatConsoleArgs([]), "");
});

test("measures exact UTF-8 byte lengths", () => {
  assert.equal(utf8ByteLength("hello"), 5);
  assert.equal(utf8ByteLength("é"), 2);
  assert.equal(utf8ByteLength("😀"), 4);
  assert.equal(
    utf8ByteLength("a"),
    new TextEncoder().encode("a").length,
  );
});

test("keeps entries that fit without truncation", () => {
  const entries: ConsoleEntry[] = [
    { t: 1, level: "log", text: "hello" },
    { t: 2, level: "warn", text: "world" },
  ];
  const result = truncateToBuffer(entries, 10 * 1024 * 1024);
  assert.equal(result.truncated, false);
  assert.equal(result.entries.length, 2);
  assert.equal(
    result.size_bytes,
    new TextEncoder().encode(JSON.stringify(entries)).length,
  );
});

test("truncates to first-N that fit and reports size", () => {
  const entries: ConsoleEntry[] = [
    { t: 1, level: "log", text: "a".repeat(100) },
    { t: 2, level: "log", text: "b".repeat(100) },
    { t: 3, level: "log", text: "c".repeat(100) },
  ];
  const fullSize = new TextEncoder().encode(JSON.stringify(entries)).length;
  const oneSize = new TextEncoder().encode(
    JSON.stringify(entries.slice(0, 1)),
  ).length;
  // Allow exactly the first entry plus array overhead.
  const result = truncateToBuffer(entries, oneSize);
  assert.equal(result.truncated, true);
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0]?.text, "a".repeat(100));
  assert.equal(
    result.size_bytes,
    new TextEncoder().encode(JSON.stringify(result.entries)).length,
  );
  assert.ok(result.size_bytes <= oneSize);
  assert.ok(fullSize > oneSize);
});

test("base64 round-trips UTF-8 JSON", () => {
  const json = JSON.stringify([{ t: 1, level: "log", text: "héllo 😀" }]);
  const encoded = base64EncodeUtf8(json);
  const decoded = Buffer.from(encoded, "base64").toString("utf-8");
  assert.equal(decoded, json);
});

test("builds upload snapshots with counts and sizes", () => {
  const entries: ConsoleEntry[] = [
    { t: 10, level: "error", text: "boom" },
  ];
  const upload = buildConsoleUpload(entries, false);
  assert.equal(upload.content_type, "application/json");
  assert.equal(upload.entries, 1);
  assert.equal(upload.truncated, false);
  assert.equal(
    upload.size_bytes,
    new TextEncoder().encode(JSON.stringify(entries)).length,
  );
  assert.equal(
    Buffer.from(upload.data, "base64").toString("utf-8"),
    JSON.stringify(entries),
  );

  const truncated = buildConsoleUpload(entries, true);
  assert.equal(truncated.truncated, true);
});

test("installer script installs under __acob__.consoleCapture with guards", () => {
  const script = buildConsoleInstallScript(Date.now() + 1000, 1024);
  assert.ok(script.includes("window.__acob__"));
  assert.ok(script.includes("consoleCapture"));
  assert.ok(script.includes("restore"));
  for (const level of ["debug", "log", "info", "warn", "error"]) {
    assert.ok(script.includes(level));
  }
  // Always calls through to originals first: within the override, original
  // apply appears before the append call.
  const overrideIndex = script.indexOf("console[level] = function");
  assert.ok(overrideIndex !== -1);
  const overrideBlock = script.slice(overrideIndex);
  const applyIndex = overrideBlock.indexOf("orig.apply");
  const appendCallIndex = overrideBlock.indexOf("append(level, args)");
  assert.ok(applyIndex !== -1 && appendCallIndex !== -1 && applyIndex < appendCallIndex);
  assert.ok(script.includes("TextEncoder"));
  assert.ok(script.includes("deadlineMs"));
  assert.ok(script.includes("maxBytes"));
  assert.ok(script.includes("truncated"));
});

test("read and restore scripts reference the capture namespace", () => {
  assert.ok(CONSOLE_READ_SCRIPT.includes("consoleCapture"));
  assert.ok(CONSOLE_READ_SCRIPT.includes("lost"));
  assert.ok(CONSOLE_RESTORE_SCRIPT.includes("restore"));
  assert.ok(CONSOLE_RESTORE_SCRIPT.includes("consoleCapture"));
});

interface ShimHarness {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sandbox: any;
  calls: Array<[string, unknown[]]>;
}

function installShim(deadlineMs: number, maxBytes: number): ShimHarness {
  const calls: Array<[string, unknown[]]> = [];
  const sandbox: Record<string, unknown> = {
    window: {},
    console: {},
    TextEncoder,
    Date,
    JSON,
    WeakSet,
  };
  const fakeConsole = sandbox.console as Record<string, (...args: unknown[]) => void>;
  for (const level of ["debug", "log", "info", "warn", "error"]) {
    fakeConsole[level] = (...args: unknown[]) => {
      calls.push([level, args]);
    };
  }
  vm.createContext(sandbox);
  const installed = vm.runInContext(
    buildConsoleInstallScript(deadlineMs, maxBytes),
    sandbox,
  );
  assert.equal(installed, true);
  return { sandbox, calls };
}


function emit(harness: ShimHarness, level: string, ...args: unknown[]): void {
  const fakeConsole = harness.sandbox.console as Record<
    string,
    (...a: unknown[]) => void
  >;
  const fn = fakeConsole[level];
  assert.ok(typeof fn === "function");
  fn(...args);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function captureStateOf(harness: ShimHarness): any {
  const window = harness.sandbox.window as Record<string, unknown>;
  const ns = window.__acob__ as Record<string, unknown>;
  return ns.consoleCapture;
}

test("shim calls through and buffers with exact byte accounting", () => {
  const harness = installShim(Date.now() + 60_000, 1_000_000);
  emit(harness, "log", "hello", { n: 1 });
  emit(harness, "error", "boom");
  const cap = captureStateOf(harness);
  assert.equal(harness.calls.length, 2);
  assert.equal(cap.entries.length, 2);
  assert.equal(cap.entries[0].level, "log");
  assert.ok(cap.entries[0].text.includes("hello"));
  assert.equal(cap.truncated, false);
  const docBytes = Buffer.byteLength(JSON.stringify(cap.entries), "utf8");
  assert.equal(docBytes, cap.sumBytes + cap.count + 1);
  assert.ok(docBytes <= 1_000_000);
});

test("shim truncates first-N at the byte cap", () => {
  const harness = installShim(Date.now() + 60_000, 500);
  for (let i = 0; i < 200; i += 1) {
    emit(harness, "log", `line ${i} ${"x".repeat(20)}`);
  }
  const cap = captureStateOf(harness);
  assert.ok(cap.entries.length > 0 && cap.entries.length < 200);
  assert.equal(cap.truncated, true);
  const docBytes = Buffer.byteLength(JSON.stringify(cap.entries), "utf8");
  assert.equal(docBytes, cap.sumBytes + cap.count + 1);
  assert.ok(docBytes <= 500);
  // Call-through keeps working past the cap.
  assert.equal(harness.calls.length, 200);
});

test("shim stops collecting after the deadline and restores", () => {
  const harness = installShim(Date.now() - 1, 1_000_000);
  emit(harness, "log", "too late");
  const cap = captureStateOf(harness);
  assert.equal(cap.entries.length, 0);
  assert.equal(cap.truncated, true);
  assert.equal(harness.calls.length, 1);
  cap.restore();
  emit(harness, "log", "after restore");
  assert.equal(cap.entries.length, 0);
  assert.equal(harness.calls.length, 2);
});
