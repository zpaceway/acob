import assert from "node:assert/strict";
import test from "node:test";

import { loadConfiguration } from "../src/storage.js";

type StoredSettings = Record<string, unknown>;

function installChromeMock(
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

test("seeds bundled settings when extension storage is empty", async () => {
  const stored: StoredSettings = {};
  const writes: StoredSettings[] = [];
  installChromeMock(stored, writes);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    assert.equal(String(input), "chrome-extension://acob/settings.json");
    return Response.json({
      baseUrl: "http://acob-proxy",
      allowCleanup: false,
      pollIntervalMs: 250,
    });
  };

  try {
    const configuration = await loadConfiguration();
    assert.equal(configuration.baseUrl, "http://acob-proxy");
    assert.equal(configuration.allowCleanup, false);
    assert.equal(configuration.pollIntervalMs, 250);
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0], configuration);
  } finally {
    globalThis.fetch = originalFetch;
    Reflect.deleteProperty(globalThis, "chrome");
  }
});

test("does not read bundled settings after configuration is stored", async () => {
  const stored: StoredSettings = { baseUrl: "https://stored.acob.test" };
  const writes: StoredSettings[] = [];
  installChromeMock(stored, writes);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("bundled settings should not be fetched");
  };

  try {
    const configuration = await loadConfiguration();
    assert.equal(configuration.baseUrl, "https://stored.acob.test");
    assert.equal(configuration.allowCleanup, false);
    assert.equal(writes.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
    Reflect.deleteProperty(globalThis, "chrome");
  }
});
