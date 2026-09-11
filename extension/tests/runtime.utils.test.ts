import assert from "node:assert/strict";
import test from "node:test";

import {
  formatConsoleArg,
  truncateToBuffer,
} from "../src/consoleUtil.js";
import { describeKey } from "../src/keys.js";
import { loadConfiguration } from "../src/storage.js";
import {
  OperationTimeoutError,
  withTerminationOnTimeout,
} from "../src/timeouts.js";
import {
  generateBid,
  isBid,
  isKeyboardKey,
  isRuntimeMessage,
  keyboardCharacter,
} from "../src/types.js";

// ---- types.ts runtime guards ----

test("isKeyboardKey accepts named and single non-whitespace chars", () => {
  assert.equal(isKeyboardKey("Enter"), true);
  assert.equal(isKeyboardKey("Tab"), true);
  assert.equal(isKeyboardKey("a"), true);
  assert.equal(isKeyboardKey("Z"), true);
  assert.equal(isKeyboardKey("🐶"), true);
  assert.equal(isKeyboardKey("!"), true);
});

test("isKeyboardKey rejects multi-char, whitespace, and non-strings", () => {
  assert.equal(isKeyboardKey("Return"), false);
  assert.equal(isKeyboardKey(""), false);
  assert.equal(isKeyboardKey(" "), false);
  assert.equal(isKeyboardKey("\t"), false);
  assert.equal(isKeyboardKey("\n"), false);
  assert.equal(isKeyboardKey("ab"), false);
  assert.equal(isKeyboardKey(123), false);
  assert.equal(isKeyboardKey(null), false);
  assert.equal(isKeyboardKey(undefined), false);
  assert.equal(isKeyboardKey({}), false);
});

test("keyboardCharacter builds single chars and rejects the rest", () => {
  assert.equal(keyboardCharacter("a"), "a");
  assert.equal(keyboardCharacter("🐶"), "🐶");
  assert.equal(keyboardCharacter("!"), "!");
  assert.throws(() => keyboardCharacter("ab"), RangeError);
  assert.throws(() => keyboardCharacter(""), RangeError);
  assert.throws(() => keyboardCharacter(" "), RangeError);
  assert.throws(() => keyboardCharacter("\t"), RangeError);
  assert.throws(() => keyboardCharacter("Return"), RangeError);
});

test("isBid and generateBid round-trip 32-char hex", () => {
  const bid = generateBid();
  assert.equal(typeof bid, "string");
  assert.equal(bid.length, 32);
  assert.equal(isBid(bid), true);
  assert.match(bid, /^[0-9a-f]{32}$/);
  assert.ok(!bid.includes("-"));
  const other = generateBid();
  assert.notEqual(bid, other);
  assert.equal(isBid("0123456789abcdef0123456789abcdef"), true);
  assert.equal(isBid("0123456789ABCDEF0123456789ABCDEF"), false);
  assert.equal(isBid("short"), false);
  assert.equal(isBid(""), false);
  assert.equal(isBid(null), false);
  assert.equal(isBid(123), false);
});

test("isRuntimeMessage accepts getConfiguration and poll", () => {
  assert.equal(isRuntimeMessage({ type: "getConfiguration" }), true);
  assert.equal(isRuntimeMessage({ type: "poll" }), true);
  assert.equal(isRuntimeMessage(null), false);
  assert.equal(isRuntimeMessage(undefined), false);
  assert.equal(isRuntimeMessage("poll"), false);
  assert.equal(isRuntimeMessage([]), false);
  assert.equal(isRuntimeMessage({}), false);
  assert.equal(isRuntimeMessage({ type: "unknown-type" }), false);
});

test("isRuntimeMessage validates settingsUpdated", () => {
  assert.equal(
    isRuntimeMessage({ type: "settingsUpdated", pollIntervalMs: 1000 }),
    true,
  );
  assert.equal(isRuntimeMessage({ type: "settingsUpdated" }), false);
  assert.equal(
    isRuntimeMessage({ type: "settingsUpdated", pollIntervalMs: "1000" }),
    false,
  );
});

test("isRuntimeMessage validates startRecording", () => {
  const valid = {
    type: "startRecording",
    tid: 12,
    fullPage: true,
    width: 1280,
    height: 720,
    maxRecordingDurationSec: 600,
    maxRecordingSizeMiB: 512,
  };
  assert.equal(isRuntimeMessage(valid), true);
  assert.equal(
    isRuntimeMessage({ ...valid, tid: "12" }),
    false,
  );
  assert.equal(
    isRuntimeMessage({ ...valid, fullPage: "yes" }),
    false,
  );
  assert.equal(
    isRuntimeMessage({ ...valid, width: "1280" }),
    false,
  );
  assert.equal(
    isRuntimeMessage({ ...valid, height: null }),
    false,
  );
  assert.equal(
    isRuntimeMessage({ ...valid, maxRecordingDurationSec: undefined }),
    false,
  );
  assert.equal(
    isRuntimeMessage({ ...valid, maxRecordingSizeMiB: "512" }),
    false,
  );
});

test("isRuntimeMessage validates frame, chunk, and finalize messages", () => {
  assert.equal(
    isRuntimeMessage({ type: "recordingFrame", tid: 12, data: "abc" }),
    true,
  );
  assert.equal(
    isRuntimeMessage({ type: "recordingFrame", tid: 12 }),
    false,
  );
  assert.equal(
    isRuntimeMessage({ type: "recordingFrame", tid: "12", data: "abc" }),
    false,
  );
  assert.equal(
    isRuntimeMessage({ type: "recordingChunk", tid: 12, data: "xyz" }),
    true,
  );
  assert.equal(
    isRuntimeMessage({ type: "recordingChunk", tid: 12, data: 123 }),
    false,
  );
  assert.equal(
    isRuntimeMessage({
      type: "finalizeRecording",
      tid: 12,
      maxRecordingSizeMiB: 512,
    }),
    true,
  );
  assert.equal(
    isRuntimeMessage({ type: "finalizeRecording", tid: 12 }),
    false,
  );
  assert.equal(
    isRuntimeMessage({
      type: "finalizeRecording",
      tid: "12",
      maxRecordingSizeMiB: 512,
    }),
    false,
  );
});

// ---- timeouts.ts ----

test("withTerminationOnTimeout passes through non-timeout rejections", async () => {
  let terminated = false;
  await assert.rejects(
    withTerminationOnTimeout(
      Promise.reject(new Error("plain failure")),
      50,
      "should not appear",
      async () => {
        terminated = true;
      },
    ),
    /plain failure/,
  );
  assert.equal(terminated, false);
});

test("withTerminationOnTimeout combines timeout and terminate failure", async () => {
  const hanging = new Promise<never>(() => undefined);
  await assert.rejects(
    withTerminationOnTimeout(hanging, 5, "op timed out", async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      throw new Error("terminate boom");
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /op timed out/);
      assert.match(error.message, /terminate boom/);
      assert.ok(error.cause instanceof Error);
      return true;
    },
  );
});

test("withTerminationOnTimeout stringifies non-Error terminate failures", async () => {
  const hanging = new Promise<never>(() => undefined);
  await assert.rejects(
    withTerminationOnTimeout(hanging, 5, "op timed out", async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      throw "string-terminate-failure";
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /op timed out/);
      assert.match(error.message, /string-terminate-failure/);
      assert.equal(error.cause, "string-terminate-failure");
      return true;
    },
  );
});

test("withTerminationOnTimeout still throws OperationTimeoutError on success", async () => {
  const hanging = new Promise<never>(() => undefined);
  await assert.rejects(
    withTerminationOnTimeout(hanging, 5, "still times out", async () => undefined),
    (error: unknown) =>
      error instanceof OperationTimeoutError &&
      error.message === "still times out",
  );
});

// ---- keys.ts top-up ----

test("describeKey covers named, alpha, shifted, and fallback branches", () => {
  assert.deepEqual(describeKey("Enter", false), {
    key: "Enter",
    code: "Enter",
    keyCode: 13,
    text: "\r",
  });
  assert.deepEqual(describeKey("Escape", false).key, "Escape");
  assert.deepEqual(describeKey("a", false), {
    key: "a",
    code: "KeyA",
    keyCode: 65,
    text: "a",
  });
  assert.deepEqual(describeKey("a", true), {
    key: "A",
    code: "KeyA",
    keyCode: 65,
    text: "A",
  });
  assert.deepEqual(describeKey("Z", false).code, "KeyZ");
  assert.deepEqual(describeKey("1", false), {
    key: "1",
    code: "Digit1",
    keyCode: 49,
    text: "1",
  });
  assert.deepEqual(describeKey("1", true), {
    key: "!",
    code: "Digit1",
    keyCode: 49,
    text: "!",
  });
  // Shifted punctuation via the unshifted table.
  assert.deepEqual(describeKey("!", false).text, "!");
  assert.deepEqual(describeKey("!", true).text, "!");
  assert.deepEqual(describeKey("@", false).code, "Digit2");
  // Unknown multi-character keys fall back to a text key.
  assert.deepEqual(describeKey("F1", false), { key: "F1", text: "F1" });
  assert.deepEqual(describeKey("MyKey", true), { key: "MyKey", text: "MyKey" });
  // Single emoji falls back to text as well.
  assert.deepEqual(describeKey("🐶", false), { key: "🐶", text: "🐶" });
});

// ---- consoleUtil.ts top-up ----

test("formatConsoleArg maps top-level functions", () => {
  assert.equal(
    formatConsoleArg(() => 1),
    "[Function]",
  );
  assert.equal(
    formatConsoleArg(function named() {
      return undefined;
    }),
    "[Function]",
  );
});

test("truncateToBuffer returns empty when even [] does not fit", () => {
  const entries = [{ t: 1, level: "log", text: "hello" }];
  const zero = truncateToBuffer(entries, 0);
  assert.deepEqual(zero.entries, []);
  assert.equal(zero.truncated, true);
  assert.equal(
    zero.size_bytes,
    new TextEncoder().encode("[]").length,
  );
  const one = truncateToBuffer(entries, 1);
  assert.deepEqual(one.entries, []);
  assert.equal(one.truncated, true);
});

// ---- storage.ts top-up ----

type StoredSettings = Record<string, unknown>;

function installStorageMock(
  stored: StoredSettings,
  writes: StoredSettings[],
): void {
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: {
      runtime: {
        getURL: (path: string) => `chrome-extension://acob/${path}`,
      },
      storage: {
        local: {
          get: async () => ({ ...stored }),
          set: async (values: StoredSettings) => {
            writes.push(values);
            Object.assign(stored, values);
          },
        },
      },
    },
  });
}

test("loadConfiguration throws when bundled settings fetch fails", async () => {
  const stored: StoredSettings = {};
  const writes: StoredSettings[] = [];
  installStorageMock(stored, writes);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    ({ ok: false, status: 500 }) as unknown as Response;
  try {
    await assert.rejects(loadConfiguration(), /HTTP 500/);
  } finally {
    globalThis.fetch = originalFetch;
    Reflect.deleteProperty(globalThis, "chrome");
  }
});

test("loadConfiguration rejects non-object bundled JSON", async () => {
  for (const bundled of [[], null, "settings", 42]) {
    const stored: StoredSettings = {};
    const writes: StoredSettings[] = [];
    installStorageMock(stored, writes);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      ({
        ok: true,
        json: async () => bundled,
      }) as unknown as Response;
    try {
      await assert.rejects(
        loadConfiguration(),
        /Bundled settings must be a JSON object/,
      );
    } finally {
      globalThis.fetch = originalFetch;
      Reflect.deleteProperty(globalThis, "chrome");
    }
  }
});
