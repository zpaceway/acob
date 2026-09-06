import assert from "node:assert/strict";
import test from "node:test";

import { executeCleanup } from "../src/cleanup.js";
import { state } from "../src/state.js";
import type { Configuration } from "../src/types.js";

function configuration(allowCleanup: boolean): Configuration {
  return { allowCleanup } as Configuration;
}

function setChromeMock(remove: (...args: unknown[]) => Promise<void>): void {
  (globalThis as Record<string, unknown>).chrome = {
    browsingData: { remove },
  };
}

test("cleanup refuses while the setting is disabled", async () => {
  await assert.rejects(
    executeCleanup(configuration(false)),
    /cleanup is disabled/,
  );
});

test("cleanup refuses while a recording is active", async () => {
  state.recordings.set(12, {} as never);
  try {
    await assert.rejects(
      executeCleanup(configuration(true)),
      /recording is active/,
    );
  } finally {
    state.recordings.delete(12);
  }
});

test("cleanup refuses while a reinstall is scheduled", async () => {
  state.reinstallScheduled = true;
  try {
    await assert.rejects(
      executeCleanup(configuration(true)),
      /reinstall is in progress/,
    );
  } finally {
    state.reinstallScheduled = false;
  }
});

test("cleanup clears all site data except extensions", async () => {
  let seenOptions: unknown;
  let seenTypes: unknown;
  setChromeMock(async (options: unknown, types: unknown) => {
    seenOptions = options;
    seenTypes = types;
  });
  try {
    const result = await executeCleanup(configuration(true));
    assert.deepEqual(result, { cleaned: true });
    assert.deepEqual(seenOptions, {
      since: 0,
      originTypes: {
        unprotectedWeb: true,
        protectedWeb: true,
        extension: false,
      },
    });
    assert.deepEqual(seenTypes, {
      cache: true,
      cacheStorage: true,
      cookies: true,
      downloads: true,
      fileSystems: true,
      formData: true,
      history: true,
      indexedDB: true,
      localStorage: true,
      serviceWorkers: true,
    });
  } finally {
    delete (globalThis as Record<string, unknown>).chrome;
  }
});

test("cleanup wraps browser failures", async () => {
  setChromeMock(async () => {
    throw new Error("denied");
  });
  try {
    await assert.rejects(
      executeCleanup(configuration(true)),
      /Could not clear browser data: denied/,
    );
  } finally {
    delete (globalThis as Record<string, unknown>).chrome;
  }
});
