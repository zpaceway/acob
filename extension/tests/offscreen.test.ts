import assert from "node:assert/strict";
import test from "node:test";

// ---------------------------------------------------------------------------
// Fakes installed BEFORE importing offscreen.js (top-level runs
// getOrCreateBid() + requestInstructions()).
// ---------------------------------------------------------------------------

type BitmapStub = { width: number; height: number; close: () => void };

let supportedMimes = new Set<string>([
  "video/mp4;codecs=avc1.42E01E",
  "video/mp4;codecs=avc1",
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8",
  "video/webm",
]);
let createImageBitmapImpl: (blob: Blob) => Promise<BitmapStub> = async () => ({
  width: 320,
  height: 240,
  close: () => undefined,
});
let createImageBitmapCalls = 0;

type CtxStub = {
  drawImageCalls: unknown[][];
  drawImage: (...args: unknown[]) => void;
};
function makeCtx(): CtxStub {
  const stub: CtxStub = {
    drawImageCalls: [],
    drawImage: (...args: unknown[]) => {
      stub.drawImageCalls.push(args);
    },
  };
  return stub;
}
function makeCanvas() {
  const ctx = makeCtx();
  return {
    width: 0,
    height: 0,
    ctx,
    getContext: (_kind: string) => ctx,
    captureStream: (_fps: number) => ({ fakeStream: true }),
  };
}

const documentMock = {
  createElement: (tag: string) => {
    assert.equal(tag, "canvas");
    return makeCanvas() as unknown as HTMLCanvasElement;
  },
};

class FakeMediaRecorder {
  static isTypeSupported(mime: string): boolean {
    return supportedMimes.has(mime);
  }
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: ((event: { error?: Error }) => void) | null = null;
  constructor(
    _stream: unknown,
    _options: { mimeType: string; videoBitsPerSecond: number },
  ) {}
  start(_timeslice?: number): void {}
  stop(): void {
    queueMicrotask(() => {
      this.onstop?.();
    });
  }
}

let nextTimerId = 1;
const timerCallbacks = new Map<number, () => void>();
const timerDelays = new Map<number, number>();
const clearedTimerIds: number[] = [];

const windowMock = {
  setTimeout: (callback: () => void, delay: number) => {
    const id = nextTimerId;
    nextTimerId += 1;
    timerCallbacks.set(id, callback);
    timerDelays.set(id, delay);
    return id;
  },
  clearTimeout: (id: number) => {
    clearedTimerIds.push(id);
    timerCallbacks.delete(id);
    timerDelays.delete(id);
  },
};

type SendMessageCall = { message: unknown };
const sendMessageCalls: SendMessageCall[] = [];
let getConfigShouldReject: Error | null = null;
let getConfigShouldReturnError: string | null = null;
let pollCalls = 0;
const chunkMessages: unknown[] = [];

const storageData = new Map<string, unknown>();

type Listener = (
  message: unknown,
  sender: unknown,
  sendResponse: (response: unknown) => void,
) => unknown;
let capturedListener: Listener | null = null;

Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: windowMock,
});
Object.defineProperty(globalThis, "document", {
  configurable: true,
  value: documentMock,
});
Object.defineProperty(globalThis, "MediaRecorder", {
  configurable: true,
  value: FakeMediaRecorder,
});
Object.defineProperty(globalThis, "createImageBitmap", {
  configurable: true,
  value: async (blob: Blob) => {
    createImageBitmapCalls += 1;
    return createImageBitmapImpl(blob);
  },
});
Object.defineProperty(globalThis, "chrome", {
  configurable: true,
  value: {
    storage: {
      local: {
        get: async (key?: string | string[]) => {
          if (typeof key === "string") {
            return key in Object.fromEntries(storageData)
              ? { [key]: storageData.get(key) }
              : {};
          }
          return Object.fromEntries(storageData);
        },
        set: async (values: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(values)) {
            storageData.set(k, v);
          }
        },
      },
    },
    runtime: {
      sendMessage: async (message: unknown) => {
        sendMessageCalls.push({ message });
        const typed = message as { type?: string };
        if (typed.type === "getConfiguration") {
          if (getConfigShouldReject !== null) {
            throw getConfigShouldReject;
          }
          if (getConfigShouldReturnError !== null) {
            return { error: getConfigShouldReturnError };
          }
          const { ACOBSettings } = await import("../src/settings.js");
          return ACOBSettings.normalizeConfiguration();
        }
        if (typed.type === "poll") {
          pollCalls += 1;
          return { ok: true };
        }
        if (typed.type === "recordingChunk") {
          chunkMessages.push(message);
          return undefined;
        }
        return undefined;
      },
      onMessage: {
        addListener: (listener: Listener) => {
          capturedListener = listener;
        },
        removeListener: () => undefined,
      },
    },
  },
});

const originalConsoleError = console.error;
const consoleErrorCalls: unknown[][] = [];
console.error = (...args: unknown[]) => {
  consoleErrorCalls.push(args);
};

await import("../src/offscreen.js");
const { ACOBSettings } = await import("../src/settings.js");

// Allow top-level getOrCreateBid() + requestInstructions() to settle.
await new Promise<void>((resolve) => {
  setTimeout(resolve, 20);
});

function resetOffscreenMocks(): void {
  // Note: timerCallbacks intentionally preserved across tests because the
  // poll loop is module-global; tests only assert new scheduling happened.
  sendMessageCalls.length = 0;
  getConfigShouldReject = null;
  getConfigShouldReturnError = null;
  consoleErrorCalls.length = 0;
  createImageBitmapCalls = 0;
  createImageBitmapImpl = async () => ({
    width: 320,
    height: 240,
    close: () => undefined,
  });
  supportedMimes = new Set([
    "video/mp4;codecs=avc1.42E01E",
    "video/mp4;codecs=avc1",
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
  ]);
}

function invokeAsync(message: unknown): Promise<unknown> {
  assert.ok(capturedListener !== null, "onMessage listener not captured");
  return new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`sendResponse never called for ${JSON.stringify(message)}`));
    }, 2000);
    const sendResponse = (response: unknown) => {
      clearTimeout(timer);
      resolve(response);
    };
    const returned = (capturedListener as Listener)(message, {}, sendResponse);
    assert.equal(returned, true);
  });
}

test("offscreen schedules an initial poll from configuration", async () => {
  assert.ok(capturedListener !== null);
  const hasGetConfig = sendMessageCalls.some(
    (c) => (c.message as { type?: string }).type === "getConfiguration",
  );
  const hasPoll = sendMessageCalls.some(
    (c) => (c.message as { type?: string }).type === "poll",
  );
  assert.equal(hasGetConfig, true);
  assert.equal(hasPoll, true);
  assert.ok(timerCallbacks.size >= 1);
});

test("offscreen ignores non-runtime messages", async () => {
  resetOffscreenMocks();
  assert.ok(capturedListener !== null);
  let responded = false;
  const sendResponse = (_response: unknown) => {
    responded = true;
  };
  const r1 = (capturedListener as Listener)({ type: "nope" }, {}, sendResponse);
  assert.notEqual(r1, true);
  const r2 = (capturedListener as Listener)(null, {}, sendResponse);
  assert.notEqual(r2, true);
  const r3 = (capturedListener as Listener)("string", {}, sendResponse);
  assert.notEqual(r3, true);
  assert.equal(responded, false);
});

test("settingsUpdated normalizes and reschedules polling", async () => {
  resetOffscreenMocks();
  assert.ok(capturedListener !== null);
  const timersBefore = timerCallbacks.size;
  const r = (capturedListener as Listener)(
    { type: "settingsUpdated", pollIntervalMs: 4321 },
    {},
    () => undefined,
  );
  assert.equal(r, undefined);
  assert.ok(timerCallbacks.size >= timersBefore);
  const delays = [...timerDelays.values()];
  assert.ok(delays.includes(4321));

  // Invalid values normalize to the centralized default.
  (capturedListener as Listener)(
    { type: "settingsUpdated", pollIntervalMs: -5 },
    {},
    () => undefined,
  );
  const expectedDefault = ACOBSettings.definitions.pollIntervalMs.defaultValue;
  assert.ok([...timerDelays.values()].includes(expectedDefault));
});

test("startRecording succeeds and reports duplicates", async () => {
  resetOffscreenMocks();
  const ok = (await invokeAsync({
    type: "startRecording",
    tid: 201,
    fullPage: false,
    width: 640,
    height: 480,
    maxRecordingDurationSec: 600,
    maxRecordingSizeMiB: 512,
  })) as { ok?: boolean; started?: boolean; error?: string };
  assert.equal(ok.ok, true);
  assert.equal(ok.started, true);

  const dup = (await invokeAsync({
    type: "startRecording",
    tid: 201,
    fullPage: false,
    width: 640,
    height: 480,
    maxRecordingDurationSec: 600,
    maxRecordingSizeMiB: 512,
  })) as { error?: string };
  assert.ok(typeof dup.error === "string" && dup.error.includes("already exists"));
});

test("startRecording maps thrown errors via errorMessage", async () => {
  resetOffscreenMocks();
  supportedMimes = new Set();
  const resp = (await invokeAsync({
    type: "startRecording",
    tid: 202,
    fullPage: false,
    width: 100,
    height: 100,
    maxRecordingDurationSec: 600,
    maxRecordingSizeMiB: 512,
  })) as { error?: string };
  assert.ok(typeof resp.error === "string" && resp.error.length > 0);
});

test("recordingFrame always responds ok even on draw failure", async () => {
  resetOffscreenMocks();
  // Unknown tid: noop but still ok.
  const unknown = (await invokeAsync({
    type: "recordingFrame",
    tid: 9993,
    data: Buffer.from("x").toString("base64"),
  })) as { ok?: boolean };
  assert.equal(unknown.ok, true);

  // Known sink with failing draw: still ok (failures surface on finalize).
  createImageBitmapImpl = async () => {
    throw new Error("bitmap fail");
  };
  const known = (await invokeAsync({
    type: "recordingFrame",
    tid: 201,
    data: Buffer.from("y").toString("base64"),
  })) as { ok?: boolean };
  assert.equal(known.ok, true);
  createImageBitmapImpl = async () => ({
    width: 320,
    height: 240,
    close: () => undefined,
  });
});

test("finalizeRecording succeeds and maps errors", async () => {
  resetOffscreenMocks();
  // tid 201 has a sink from the earlier start test (module-global sinks).
  // Draw one good frame first so finalize has frames (earlier failure frame
  // recorded a draw error; start a fresh tid instead for the success path).
  const startOk = (await invokeAsync({
    type: "startRecording",
    tid: 203,
    fullPage: false,
    width: 320,
    height: 240,
    maxRecordingDurationSec: 600,
    maxRecordingSizeMiB: 512,
  })) as { ok?: boolean };
  assert.equal(startOk.ok, true);
  const frameOk = (await invokeAsync({
    type: "recordingFrame",
    tid: 203,
    data: Buffer.from("jpeg-bytes").toString("base64"),
  })) as { ok?: boolean };
  assert.equal(frameOk.ok, true);
  const done = (await invokeAsync({
    type: "finalizeRecording",
    tid: 203,
    maxRecordingSizeMiB: 512,
  })) as { ok?: boolean; contentType?: string; error?: string };
  assert.equal(done.ok, true);
  assert.ok(done.contentType === "video/mp4" || done.contentType === "video/webm");

  const missing = (await invokeAsync({
    type: "finalizeRecording",
    tid: 9994,
    maxRecordingSizeMiB: 512,
  })) as { error?: string };
  assert.ok(typeof missing.error === "string");
});

test("finalizeRecording maps non-Error throws via String()", async () => {
  resetOffscreenMocks();
  const startOk = (await invokeAsync({
    type: "startRecording",
    tid: 204,
    fullPage: false,
    width: 320,
    height: 240,
    maxRecordingDurationSec: 600,
    maxRecordingSizeMiB: 512,
  })) as { ok?: boolean };
  assert.equal(startOk.ok, true);
  createImageBitmapImpl = async () => {
    throw "oops-string" as unknown as Error;
  };
  const frameOk = (await invokeAsync({
    type: "recordingFrame",
    tid: 204,
    data: Buffer.from("z").toString("base64"),
  })) as { ok?: boolean };
  assert.equal(frameOk.ok, true);
  const failed = (await invokeAsync({
    type: "finalizeRecording",
    tid: 204,
    maxRecordingSizeMiB: 512,
  })) as { error?: string };
  assert.equal(failed.error, "oops-string");
  createImageBitmapImpl = async () => ({
    width: 320,
    height: 240,
    close: () => undefined,
  });
});

test("requestInstructions config error still polls and reschedules", async () => {
  resetOffscreenMocks();
  getConfigShouldReject = new Error("config down");
  pollCalls = 0;
  const timersBefore = timerCallbacks.size;
  // Poll timers use small delays (pollIntervalMs); recording discard timers
  // use maxRecordingDurationSec*1000+30000 (630000). Pick a poll timer.
  const pollEntry = [...timerCallbacks.entries()].find(
    ([_id, _cb]) => (timerDelays.get(_id) ?? 0) < 100_000,
  );
  assert.ok(pollEntry !== undefined, "expected a poll timer");
  const [, pollCallback] = pollEntry;
  await pollCallback();
  assert.ok(consoleErrorCalls.length >= 1);
  assert.ok(pollCalls >= 1);
  assert.ok(timerCallbacks.size >= timersBefore);
  getConfigShouldReject = null;
});

// Keep the process honest: restore the real console.error for any later work
// in this process (each test file runs in its own process).
test("restores console.error", () => {
  console.error = originalConsoleError;
  assert.equal(typeof console.error, "function");
});
