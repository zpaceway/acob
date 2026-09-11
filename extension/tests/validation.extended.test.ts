import assert from "node:assert/strict";
import test from "node:test";

import { state } from "../src/state.js";
import {
  assertSupportedInstruction,
  isClaimedInstruction,
  isReinstallCommand,
  isSupportedInstruction,
  reportError,
} from "../src/validation.js";
import type { ClaimedInstruction } from "../src/types.js";

function claimed(
  action: string,
  payload: unknown,
  extra?: Record<string, unknown>,
): ClaimedInstruction {
  return { id: 7, action, payload, ...extra } as ClaimedInstruction;
}

function resetReportState(): void {
  state.backendUnavailable = false;
}

// reportError: TypeError first/second time + non-TypeError.
test("reportError maps TypeError to a one-time backend notice", () => {
  resetReportState();
  const infos: unknown[][] = [];
  const errors: unknown[][] = [];
  const originalInfo = console.info;
  const originalError = console.error;
  console.info = (...args: unknown[]) => {
    infos.push(args);
  };
  console.error = (...args: unknown[]) => {
    errors.push(args);
  };
  try {
    reportError(new TypeError("fetch failed"));
    assert.equal(state.backendUnavailable, true);
    assert.equal(infos.length, 1);
    reportError(new TypeError("still down"));
    assert.equal(infos.length, 1);
    assert.equal(errors.length, 0);
  } finally {
    console.info = originalInfo;
    console.error = originalError;
    resetReportState();
  }
});

test("reportError forwards non-TypeError to console.error", () => {
  resetReportState();
  const errors: unknown[][] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args);
  };
  try {
    const failure = new Error("plain boom");
    reportError(failure);
    assert.equal(errors.length, 1);
    assert.equal(errors[0]?.[0], failure);
    assert.equal(state.backendUnavailable, false);
  } finally {
    console.error = originalError;
  }
});

test("isReinstallCommand validates the reinstall shape", () => {
  assert.equal(
    isReinstallCommand({ action: "reinstall", payload: { token: "abc" } }),
    true,
  );
  assert.equal(isReinstallCommand(null), false);
  assert.equal(isReinstallCommand([]), false);
  assert.equal(
    isReinstallCommand({ action: "reinstall", payload: null }),
    false,
  );
  assert.equal(
    isReinstallCommand({ action: "reinstall", payload: {} }),
    false,
  );
  assert.equal(
    isReinstallCommand({
      action: "reinstall",
      payload: { token: 123 },
    }),
    false,
  );
  assert.equal(
    isReinstallCommand({ action: "list", payload: { token: "abc" } }),
    false,
  );
  assert.equal(isReinstallCommand({ action: "reinstall" }), false);
});

test("isClaimedInstruction rejects malformed envelopes", () => {
  assert.equal(isClaimedInstruction(null), false);
  assert.equal(isClaimedInstruction([]), false);
  assert.equal(isClaimedInstruction({}), false);
  assert.equal(
    isClaimedInstruction({ id: 0, action: "list", payload: {} }),
    false,
  );
  assert.equal(
    isClaimedInstruction({ id: 1.5, action: "list", payload: {} }),
    false,
  );
  assert.equal(
    isClaimedInstruction({ id: "1", action: "list", payload: {} }),
    false,
  );
  assert.equal(isClaimedInstruction({ id: 1, payload: {} }), false);
  assert.equal(
    isClaimedInstruction({ id: 1, action: 123, payload: {} }),
    false,
  );
  assert.equal(
    isClaimedInstruction({ id: 1, action: "list" }),
    false,
  );
  assert.equal(isClaimedInstruction({ id: 1, action: "list", payload: {} }), true);
});

test("proxy validation covers scheme, length, and key shape", () => {
  // Valid set with trailing slash path (allowed) and extra-key rejection.
  assert.equal(
    isSupportedInstruction(
      claimed("proxy", { method: "set", proxy: "http://127.0.0.1:8080/" }),
    ),
    true,
  );
  assert.equal(
    isSupportedInstruction(
      claimed("proxy", {
        method: "set",
        proxy: "http://127.0.0.1:8080",
        extra: 1,
      }),
    ),
    false,
  );
  // Over-long proxy strings are rejected without URL parsing.
  assert.equal(
    isSupportedInstruction(
      claimed("proxy", {
        method: "set",
        proxy: `http://127.0.0.1:8080/${"a".repeat(2048)}`,
      }),
    ),
    false,
  );
  assert.equal(
    isSupportedInstruction(claimed("proxy", { method: "set", proxy: "" })),
    false,
  );
  assert.equal(
    isSupportedInstruction(
      claimed("proxy", { method: "set", proxy: "http://127.0.0.1:8080?x=1" }),
    ),
    false,
  );
  assert.equal(
    isSupportedInstruction(
      claimed("proxy", { method: "set", proxy: "http://127.0.0.1:8080#frag" }),
    ),
    false,
  );
  assert.equal(
    isSupportedInstruction(
      claimed("proxy", { method: "set", proxy: "http://127.0.0.1:8080/a/b" }),
    ),
    false,
  );
  // Unset accepts missing, undefined, or null proxy and rejects strings.
  assert.equal(
    isSupportedInstruction(claimed("proxy", { method: "unset" })),
    true,
  );
  assert.equal(
    isSupportedInstruction(
      claimed("proxy", { method: "unset", proxy: null }),
    ),
    true,
  );
  assert.equal(
    isSupportedInstruction(
      claimed("proxy", { method: "unset", proxy: "http://127.0.0.1:8080" }),
    ),
    false,
  );
  assert.equal(
    isSupportedInstruction(claimed("proxy", { method: "toggle" })),
    false,
  );
});

test("record validation covers start/stop full_page edge cases", () => {
  assert.equal(
    isSupportedInstruction(
      claimed("record", { method: "start", tid: 7, full_page: false }),
    ),
    true,
  );
  assert.equal(
    isSupportedInstruction(
      claimed("record", { method: "start", tid: 7, full_page: null }),
    ),
    false,
  );
  assert.equal(
    isSupportedInstruction(claimed("record", { method: "start", tid: 0 })),
    false,
  );
  assert.equal(
    isSupportedInstruction(
      claimed("record", { method: "stop", tid: 7, full_page: false }),
    ),
    true,
  );
  assert.equal(
    isSupportedInstruction(
      claimed("record", { method: "stop", tid: 7, full_page: null }),
    ),
    true,
  );
  assert.equal(
    isSupportedInstruction(
      claimed("record", { method: "stop", tid: 7, full_page: 0 }),
    ),
    false,
  );
  assert.equal(
    isSupportedInstruction(claimed("record", { method: "pause", tid: 7 })),
    false,
  );
});

test("console validation rejects extra keys and bad tids", () => {
  assert.equal(
    isSupportedInstruction(claimed("console", { method: "start", tid: 7 })),
    true,
  );
  assert.equal(
    isSupportedInstruction(
      claimed("console", { method: "start", tid: 7, extra: "x" }),
    ),
    false,
  );
  assert.equal(
    isSupportedInstruction(claimed("console", { method: "start", tid: -1 })),
    false,
  );
  assert.equal(
    isSupportedInstruction(claimed("console", { method: "restart", tid: 7 })),
    false,
  );
});

test("click and javascript validation", () => {
  assert.equal(
    isSupportedInstruction(claimed("click", { tid: 7, selector: "a" })),
    true,
  );
  assert.equal(
    isSupportedInstruction(claimed("click", { tid: 0, selector: "a" })),
    false,
  );
  assert.equal(
    isSupportedInstruction(claimed("click", { tid: 7, selector: 123 })),
    false,
  );
  assert.equal(
    isSupportedInstruction(claimed("click", { tid: 7 })),
    false,
  );
  assert.equal(
    isSupportedInstruction(
      claimed("javascript", { tid: 7, script: "1+1" }),
    ),
    true,
  );
  assert.equal(
    isSupportedInstruction(claimed("javascript", { tid: 7, script: 123 })),
    false,
  );
  assert.equal(
    isSupportedInstruction(claimed("javascript", { tid: 0, script: "x" })),
    false,
  );
  assert.equal(
    isSupportedInstruction(claimed("javascript", { tid: 7 })),
    false,
  );
});

test("keyboard validation covers text/key and modifier branches", () => {
  // Text payloads must have no modifiers and no key.
  assert.equal(
    isSupportedInstruction(claimed("keyboard", { tid: 7, text: "hi" })),
    true,
  );
  assert.equal(
    isSupportedInstruction(
      claimed("keyboard", { tid: 7, text: "hi", modifiers: [] }),
    ),
    true,
  );
  assert.equal(
    isSupportedInstruction(
      claimed("keyboard", { tid: 7, text: "hi", modifiers: ["shift"] }),
    ),
    false,
  );
  assert.equal(
    isSupportedInstruction(
      claimed("keyboard", { tid: 7, text: "hi", key: "Enter" }),
    ),
    false,
  );
  // Key payloads require a valid key and no text.
  assert.equal(
    isSupportedInstruction(claimed("keyboard", { tid: 7, key: "Enter" })),
    true,
  );
  assert.equal(
    isSupportedInstruction(
      claimed("keyboard", { tid: 7, key: "a", modifiers: ["ctrl", "shift"] }),
    ),
    true,
  );
  assert.equal(
    isSupportedInstruction(
      claimed("keyboard", { tid: 7, key: "Return" }),
    ),
    false,
  );
  assert.equal(
    isSupportedInstruction(
      claimed("keyboard", { tid: 7, key: "Enter", text: "x" }),
    ),
    false,
  );
  assert.equal(
    isSupportedInstruction(claimed("keyboard", { tid: 7 })),
    false,
  );
  assert.equal(
    isSupportedInstruction(claimed("keyboard", { tid: 0, key: "Enter" })),
    false,
  );
  assert.equal(
    isSupportedInstruction(
      claimed("keyboard", { tid: 7, key: "Enter", modifiers: ["cmd"] }),
    ),
    false,
  );
  assert.equal(
    isSupportedInstruction(
      claimed("keyboard", { tid: 7, key: "Enter", modifiers: "ctrl" }),
    ),
    false,
  );
  assert.equal(
    isSupportedInstruction(
      claimed("keyboard", { tid: 7, key: "Enter", modifiers: [123] }),
    ),
    false,
  );
});

test("screenshot, list, cleanup, and tab actions", () => {
  assert.equal(
    isSupportedInstruction(claimed("screenshot", { tid: 7 })),
    true,
  );
  assert.equal(
    isSupportedInstruction(
      claimed("screenshot", { tid: 7, full_page: true }),
    ),
    true,
  );
  assert.equal(
    isSupportedInstruction(
      claimed("screenshot", { tid: 7, full_page: "yes" }),
    ),
    false,
  );
  assert.equal(
    isSupportedInstruction(claimed("screenshot", { tid: 0 })),
    false,
  );
  assert.equal(isSupportedInstruction(claimed("list", {})), true);
  assert.equal(isSupportedInstruction(claimed("list", { extra: 1 })), true);
  assert.equal(isSupportedInstruction(claimed("cleanup", {})), true);
  assert.equal(isSupportedInstruction(claimed("cleanup", { tid: 7 })), false);
  for (const action of ["close", "focus", "reload"]) {
    assert.equal(isSupportedInstruction(claimed(action, { tid: 7 })), true);
    assert.equal(isSupportedInstruction(claimed(action, { tid: 0 })), false);
    assert.equal(isSupportedInstruction(claimed(action, {})), false);
  }
});

test("navigate and scroll validation", () => {
  assert.equal(
    isSupportedInstruction(
      claimed("navigate", { url: "https://example.com" }),
    ),
    true,
  );
  assert.equal(
    isSupportedInstruction(
      claimed("navigate", { tid: 7, url: "https://example.com" }),
    ),
    true,
  );
  assert.equal(
    isSupportedInstruction(claimed("navigate", { tid: 0, url: "https://x" })),
    false,
  );
  assert.equal(isSupportedInstruction(claimed("navigate", { tid: 7 })), false);
  assert.equal(
    isSupportedInstruction(claimed("navigate", { url: 123 })),
    false,
  );
  assert.equal(
    isSupportedInstruction(claimed("scroll", { tid: 7, y: 100 })),
    true,
  );
  assert.equal(
    isSupportedInstruction(claimed("scroll", { tid: 7, y: Number.NaN })),
    false,
  );
  assert.equal(
    isSupportedInstruction(claimed("scroll", { tid: 7, y: "100" })),
    false,
  );
  assert.equal(isSupportedInstruction(claimed("scroll", { tid: 0, y: 5 })), false);
  assert.equal(
    isSupportedInstruction(claimed("unknown-action", { tid: 7 })),
    false,
  );
});

test("instructionValidationError reports bid, payload, and batch problems", () => {
  assert.throws(
    () =>
      assertSupportedInstruction(
        claimed("list", {}, { bid: "bad" }),
      ),
    /bid must be a 32-character/,
  );
  assert.throws(
    () => assertSupportedInstruction({ id: 7, action: "list", payload: null } as unknown as ClaimedInstruction),
    /payload must be an object/,
  );
  assert.throws(
    () => assertSupportedInstruction(claimed("click", { tid: 7 })),
    /Unsupported or invalid instruction: click/,
  );
  assert.throws(
    () =>
      assertSupportedInstruction(claimed("batch", { actions: "nope" })),
    /actions must be an array/,
  );
  assert.throws(
    () =>
      assertSupportedInstruction(
        claimed("batch", { actions: [{ action: 123 }] }),
      ),
    /must be an object with a string action/,
  );
  assert.throws(
    () =>
      assertSupportedInstruction(
        claimed("batch", { actions: [{ action: "list", bid: "nope" }] }),
      ),
    /bid must be a 32-character/,
  );
  assert.throws(
    () =>
      assertSupportedInstruction(
        claimed("batch", { actions: [{ action: "click", tid: 7 }] }),
      ),
    /batch action 0 \(click\)/,
  );
  // Valid batch passes without throwing.
  assertSupportedInstruction(
    claimed("batch", { actions: [{ action: "list" }] }),
  );
});
