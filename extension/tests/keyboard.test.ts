import assert from "node:assert/strict";
import test from "node:test";

import {
  isKeyboardKey,
  keyboardCharacter,
  NAMED_KEYBOARD_KEYS,
} from "../src/types.js";
import { describeKey } from "../src/keys.js";

test("accepts named keys and single Unicode characters", () => {
  assert.equal(isKeyboardKey("Enter"), true);
  assert.equal(isKeyboardKey("a"), true);
  assert.equal(isKeyboardKey("🐶"), true);
  assert.equal(keyboardCharacter("🐶"), "🐶");
  assert.ok(NAMED_KEYBOARD_KEYS.includes("Tab"));
});

test("rejects unsupported multi-character keys", () => {
  assert.equal(isKeyboardKey("Return"), false);
  assert.equal(isKeyboardKey(" "), false);
  assert.equal(isKeyboardKey("\t"), false);
  assert.throws(
    () => keyboardCharacter("Return"),
    /exactly one non-whitespace character/,
  );
  assert.throws(() => keyboardCharacter(" "), /non-whitespace/);
});

test("describes shifted characters with native key metadata", () => {
  assert.deepEqual(describeKey("a", true), {
    key: "A",
    code: "KeyA",
    keyCode: 65,
    text: "A",
  });
  assert.deepEqual(describeKey("1", true), {
    key: "!",
    code: "Digit1",
    keyCode: 49,
    text: "!",
  });
});
