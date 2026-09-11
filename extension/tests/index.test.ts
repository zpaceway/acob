import assert from "node:assert/strict";
import test from "node:test";

import { ACOBSettings, default as defaultSettings } from "../src/index.js";
import { keyboardCharacter } from "../src/index.js";

test("package entry re-exports the settings API", () => {
  assert.equal(defaultSettings, ACOBSettings);
  const configuration = ACOBSettings.normalizeConfiguration();
  assert.equal(typeof configuration.baseUrl, "string");
  assert.equal(keyboardCharacter("a"), "a");
});
