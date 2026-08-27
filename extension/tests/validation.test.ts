import assert from "node:assert/strict";
import test from "node:test";

import { isSupportedInstruction } from "../src/validation.js";
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