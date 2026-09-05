import assert from "node:assert/strict";
import test from "node:test";

import {
  assertSupportedInstruction,
  isSupportedInstruction,
} from "../src/validation.js";
import type { ClaimedInstruction } from "../src/types.js";

function instruction(action: string, payload: unknown): ClaimedInstruction {
  return { id: 1, action, payload };
}

test("accepts a supported batch of instructions", () => {
  const value = instruction("batch", {
    actions: [
      { action: "list" },
      { action: "scroll", tid: 12, y: 500 },
      { action: "keyboard", tid: 12, text: "ACOB" },
    ],
  });

  assert.equal(isSupportedInstruction(value), true);
});

test("rejects empty and oversized batches", () => {
  const empty = instruction("batch", { actions: [] });
  const oversized = instruction("batch", {
    actions: Array.from({ length: 21 }, () => ({ action: "list" })),
  });

  assert.equal(isSupportedInstruction(empty), false);
  assert.equal(isSupportedInstruction(oversized), false);
});

test("rejects batches with invalid sub-actions", () => {
  const missingTid = instruction("batch", {
    actions: [{ action: "click", selector: "button" }],
  });
  const unknownAction = instruction("batch", {
    actions: [{ action: "unknown" }],
  });
  const nestedBatch = instruction("batch", {
    actions: [{ action: "batch", actions: [{ action: "list" }] }],
  });
  const nonObject = instruction("batch", { actions: ["list"] });
  const invalidScroll = instruction("batch", {
    actions: [{ action: "scroll", tid: 12, y: Infinity }],
  });

  assert.equal(isSupportedInstruction(missingTid), false);
  assert.equal(isSupportedInstruction(unknownAction), false);
  assert.equal(isSupportedInstruction(nestedBatch), false);
  assert.equal(isSupportedInstruction(nonObject), false);
  assert.equal(isSupportedInstruction(invalidScroll), false);
});

test("reports the invalid batch action index and name", () => {
  const value = instruction("batch", {
    actions: [
      { action: "list" },
      { action: "click", selector: "button" },
    ],
  });

  assert.throws(
    () => assertSupportedInstruction(value),
    new Error("Unsupported or invalid instruction: batch action 1 (click)"),
  );
});

test("reports malformed batch entries", () => {
  const value = instruction("batch", {
    actions: [{ action: "list" }, "scroll"],
  });

  assert.throws(
    () => assertSupportedInstruction(value),
    new Error(
      "Unsupported or invalid instruction: batch action 1 must be an object with a string action",
    ),
  );
});

test("accepts proxy set and unset", () => {
  assert.equal(
    isSupportedInstruction(
      instruction("proxy", { method: "set", proxy: "http://127.0.0.1:8080" }),
    ),
    true,
  );
  assert.equal(
    isSupportedInstruction(
      instruction("proxy", {
        method: "set",
        proxy: "socks5://user:pass@127.0.0.1:1080",
      }),
    ),
    true,
  );
  assert.equal(
    isSupportedInstruction(instruction("proxy", { method: "unset" })),
    true,
  );
});

test("rejects invalid proxy payloads", () => {
  assert.equal(
    isSupportedInstruction(instruction("proxy", { method: "set" })),
    false,
  );
  assert.equal(
    isSupportedInstruction(
      instruction("proxy", { method: "set", proxy: "ftp://127.0.0.1:21" }),
    ),
    false,
  );
  assert.equal(
    isSupportedInstruction(
      instruction("proxy", { method: "set", proxy: "http://127.0.0.1" }),
    ),
    false,
  );
  assert.equal(
    isSupportedInstruction(
      instruction("proxy", {
        method: "unset",
        proxy: "http://127.0.0.1:8080",
      }),
    ),
    false,
  );
  assert.equal(isSupportedInstruction(instruction("proxy", {})), false);
});

test("accepts record start and stop by tab", () => {
  assert.equal(
    isSupportedInstruction(
      instruction("record", { method: "start", tid: 12 }),
    ),
    true,
  );
  assert.equal(
    isSupportedInstruction(
      instruction("record", { method: "start", tid: 12, full_page: true }),
    ),
    true,
  );
  assert.equal(
    isSupportedInstruction(instruction("record", { method: "stop", tid: 12 })),
    true,
  );
});

test("rejects invalid record payloads", () => {
  assert.equal(
    isSupportedInstruction(instruction("record", { tid: 12 })),
    false,
  );
  assert.equal(
    isSupportedInstruction(instruction("record", { method: "start" })),
    false,
  );
  assert.equal(
    isSupportedInstruction(
      instruction("record", { method: "stop", tid: 0 }),
    ),
    false,
  );
  assert.equal(
    isSupportedInstruction(
      instruction("record", { method: "stop", tid: 12, full_page: true }),
    ),
    false,
  );
  assert.equal(
    isSupportedInstruction(
      instruction("record", { method: "start", tid: 12, full_page: "yes" }),
    ),
    false,
  );
});

test("accepts record and proxy inside batches", () => {
  const value = instruction("batch", {
    actions: [
      { action: "record", method: "start", tid: 12 },
      { action: "record", method: "stop", tid: 12 },
      { action: "proxy", method: "set", proxy: "https://proxy.example:8443" },
      { action: "proxy", method: "unset" },
    ],
  });

  assert.equal(isSupportedInstruction(value), true);
});

test("accepts console start, capture, and stop by tab", () => {
  assert.equal(
    isSupportedInstruction(
      instruction("console", { method: "start", tid: 12 }),
    ),
    true,
  );
  assert.equal(
    isSupportedInstruction(
      instruction("console", { method: "capture", tid: 12 }),
    ),
    true,
  );
  assert.equal(
    isSupportedInstruction(
      instruction("console", { method: "stop", tid: 12 }),
    ),
    true,
  );
});

test("rejects invalid console payloads", () => {
  assert.equal(
    isSupportedInstruction(instruction("console", { tid: 12 })),
    false,
  );
  assert.equal(
    isSupportedInstruction(instruction("console", { method: "begin", tid: 12 })),
    false,
  );
  assert.equal(
    isSupportedInstruction(instruction("console", { method: "start" })),
    false,
  );
  assert.equal(
    isSupportedInstruction(instruction("console", { method: "capture", tid: 0 })),
    false,
  );
  assert.equal(
    isSupportedInstruction(instruction("console", { method: "stop", tid: 0 })),
    false,
  );
  assert.equal(
    isSupportedInstruction(
      instruction("console", { method: "start", tid: 12, full_page: true }),
    ),
    false,
  );
  assert.equal(
    isSupportedInstruction(
      instruction("console", { method: "capture", tid: 12, extra: 1 }),
    ),
    false,
  );
  assert.equal(
    isSupportedInstruction(
      instruction("console", { method: "stop", tid: 12, full_page: null }),
    ),
    false,
  );
});

test("accepts console inside batches", () => {
  const value = instruction("batch", {
    actions: [
      { action: "console", method: "start", tid: 12 },
      { action: "console", method: "capture", tid: 12 },
      { action: "console", method: "stop", tid: 12 },
    ],
  });

  assert.equal(isSupportedInstruction(value), true);
});
