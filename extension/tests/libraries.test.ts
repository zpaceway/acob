import assert from "node:assert/strict";
import test from "node:test";

const JQUERY_SOURCE = "/* jquery */\nvar jQuery = 1;";
const TURNDOWN_SOURCE = "/* turndown */\nvar TurndownService = 2;";

let fetchCalls: string[] = [];
let getUrlCalls: string[] = [];
let mode:
  | { kind: "success" }
  | { kind: "http-error" }
  | { kind: "empty" } = { kind: "success" };
let failNextFetch = false;

Object.defineProperty(globalThis, "chrome", {
  configurable: true,
  value: {
    runtime: {
      getURL: (file: string) => {
        getUrlCalls.push(file);
        return `chrome-extension://test-id/${file}`;
      },
    },
  },
});

const fetchMock = async (input: unknown) => {
  const url = String(input);
  fetchCalls.push(url);
  if (failNextFetch) {
    failNextFetch = false;
    throw new Error("network down");
  }
  if (mode.kind === "http-error") {
    return { ok: false, status: 500, text: async () => "" } as unknown as Response;
  }
  if (mode.kind === "empty") {
    return { ok: true, status: 200, text: async () => "   \n  " } as unknown as Response;
  }
  if (url.includes("jquery.min.js")) {
    return { ok: true, status: 200, text: async () => JQUERY_SOURCE } as unknown as Response;
  }
  if (url.includes("turndown.js")) {
    return { ok: true, status: 200, text: async () => TURNDOWN_SOURCE } as unknown as Response;
  }
  return { ok: true, status: 200, text: async () => "unexpected" } as unknown as Response;
};
Object.defineProperty(globalThis, "fetch", {
  configurable: true,
  value: fetchMock,
});

const { loadPageLibrariesScript } = await import("../src/libraries.js");

// NOTE: single module instance throughout (the loader caches the combined
// script on success and resets on failure). Failure tests run first while the
// cache is empty; the success test runs next and seeds the cache that the
// caching test then observes. No query-string re-imports: duplicate module
// instances split V8 coverage and lower the reported percentages.

test("fails on HTTP error", async () => {
  fetchCalls = [];
  getUrlCalls = [];
  mode = { kind: "http-error" };
  await assert.rejects(loadPageLibrariesScript(), /Could not load .*HTTP 500/);
});

test("fails on empty asset", async () => {
  fetchCalls = [];
  mode = { kind: "empty" };
  await assert.rejects(loadPageLibrariesScript(), /extension asset is empty/);
});

test("failure resets the cached promise so a retry can succeed", async () => {
  fetchCalls = [];
  mode = { kind: "success" };
  failNextFetch = true;
  await assert.rejects(loadPageLibrariesScript(), /network down/);
  const script = await loadPageLibrariesScript();
  assert.ok(script.includes(JQUERY_SOURCE));
  assert.ok(script.includes(TURNDOWN_SOURCE));
});

test("combines sources with sourceURL and calls getURL for the bundle name", async () => {
  // Cache is now seeded by the previous retry-success; the same instance
  // returns the combined script without extra fetches.
  const script = await loadPageLibrariesScript();
  assert.ok(script.includes(JQUERY_SOURCE));
  assert.ok(script.includes(TURNDOWN_SOURCE));
  assert.ok(script.includes("sourceURL"));
  assert.ok(
    getUrlCalls.includes("acob-page-libraries.js"),
    `expected acob-page-libraries.js in ${JSON.stringify(getUrlCalls)}`,
  );
  assert.ok(script.includes("chrome-extension://test-id/acob-page-libraries.js"));
});

test("caches the combined script (second call makes no extra fetch)", async () => {
  const first = await loadPageLibrariesScript();
  const callsAfterFirst = fetchCalls.length;
  assert.ok(callsAfterFirst >= 2);
  const second = await loadPageLibrariesScript();
  assert.equal(second, first);
  assert.equal(fetchCalls.length, callsAfterFirst);
});
