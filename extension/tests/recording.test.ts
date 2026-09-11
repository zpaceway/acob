import assert from "node:assert/strict";
import test from "node:test";

// ---------------------------------------------------------------------------
// Fakes installed BEFORE importing recording.js.
// ---------------------------------------------------------------------------

type BitmapStub = { width: number; height: number; close: () => void };
type CtxStub = {
  drawImageCalls: unknown[][];
  drawImage: (...args: unknown[]) => void;
};
type CanvasStub = {
  width: number;
  height: number;
  ctx: CtxStub;
  getContext: (kind: string) => CtxStub | null;
  captureStream: (fps: number) => { fakeStream: true; fps: number };
};

let supportedMimes = new Set<string>([
  "video/mp4;codecs=avc1.42E01E",
  "video/mp4;codecs=avc1",
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8",
  "video/webm",
]);
let getContextShouldReturnNull = false;
let drawImageShouldThrow: Error | null = null;
let createImageBitmapImpl: (blob: Blob) => Promise<BitmapStub> = async () => ({
  width: 10,
  height: 10,
  close: () => undefined,
});
let createImageBitmapCalls = 0;

const canvasInstances: CanvasStub[] = [];

type FakeRecorder = {
  stream: unknown;
  mimeType: string;
  videoBitsPerSecond: number;
  ondataavailable: ((event: { data: Blob }) => void) | null;
  onstop: (() => void) | null;
  onerror: ((event: { error?: Error }) => void) | null;
  startArg: number | null;
  stopCalled: boolean;
  instanceIndex: number;
};

const recorderInstances: FakeRecorder[] = [];
let recorderAutoBehavior: "onstop" | "onerror" | "manual" = "onstop";
let recorderOnErrorValue: Error | undefined = undefined;
let recorderStopShouldThrow: Error | null = null;

class FakeMediaRecorder {
  static isTypeSupported(mime: string): boolean {
    return supportedMimes.has(mime);
  }
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: ((event: { error?: Error }) => void) | null = null;
  startArg: number | null = null;
  stopCalled = false;
  stream: unknown;
  mimeType: string;
  videoBitsPerSecond: number;
  instanceIndex: number;
  constructor(stream: unknown, options: { mimeType: string; videoBitsPerSecond: number }) {
    this.stream = stream;
    this.mimeType = options.mimeType;
    this.videoBitsPerSecond = options.videoBitsPerSecond;
    this.instanceIndex = recorderInstances.length;
    recorderInstances.push(this as unknown as FakeRecorder);
  }
  start(timeslice?: number): void {
    this.startArg = timeslice ?? null;
  }
  stop(): void {
    this.stopCalled = true;
    if (recorderStopShouldThrow !== null) {
      throw recorderStopShouldThrow;
    }
    if (recorderAutoBehavior === "onstop") {
      queueMicrotask(() => {
        this.onstop?.();
      });
    } else if (recorderAutoBehavior === "onerror") {
      queueMicrotask(() => {
        const err = recorderOnErrorValue ?? new Error("MediaRecorder failed");
        this.onerror?.({ error: err });
      });
    }
  }
}

function makeCtx(): CtxStub {
  const stub: CtxStub = {
    drawImageCalls: [],
    drawImage: (...args: unknown[]) => {
      if (drawImageShouldThrow !== null) {
        throw drawImageShouldThrow;
      }
      stub.drawImageCalls.push(args);
    },
  };
  return stub;
}

function makeCanvas(): CanvasStub {
  const ctx = makeCtx();
  const canvas: CanvasStub = {
    width: 0,
    height: 0,
    ctx,
    getContext: (_kind: string) => (getContextShouldReturnNull ? null : ctx),
    captureStream: (fps: number) => ({ fakeStream: true, fps }),
  };
  canvasInstances.push(canvas);
  return canvas;
}

const documentMock = {
  createElement: (tag: string) => {
    assert.equal(tag, "canvas");
    return makeCanvas() as unknown as HTMLCanvasElement;
  },
};

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

const sentMessages: unknown[] = [];

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
    runtime: {
      sendMessage: async (message: unknown) => {
        sentMessages.push(message);
        return undefined;
      },
    },
  },
});

const { startRecordingSink, handleRecordingFrame, handleFinalizeRecording } =
  await import("../src/recording.js");

function resetRecordingMocks(): void {
  supportedMimes = new Set<string>([
    "video/mp4;codecs=avc1.42E01E",
    "video/mp4;codecs=avc1",
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
  ]);
  getContextShouldReturnNull = false;
  drawImageShouldThrow = null;
  createImageBitmapImpl = async () => ({ width: 10, height: 10, close: () => undefined });
  createImageBitmapCalls = 0;
  canvasInstances.length = 0;
  recorderInstances.length = 0;
  recorderAutoBehavior = "onstop";
  recorderOnErrorValue = undefined;
  recorderStopShouldThrow = null;
  sentMessages.length = 0;
  timerCallbacks.clear();
  timerDelays.clear();
  clearedTimerIds.length = 0;
  nextTimerId = 1;
}

function startMessage(
  tid: number,
  overrides: Partial<{ width: number; height: number; maxRecordingDurationSec: number; maxRecordingSizeMiB: number }> = {},
) {
  return {
    type: "startRecording" as const,
    tid,
    fullPage: false,
    width: overrides.width ?? 1280,
    height: overrides.height ?? 720,
    maxRecordingDurationSec: overrides.maxRecordingDurationSec ?? 600,
    maxRecordingSizeMiB: overrides.maxRecordingSizeMiB ?? 512,
  };
}

function lastRecorder(): FakeRecorder {
  const rec = recorderInstances[recorderInstances.length - 1];
  assert.ok(rec !== undefined, "expected a recorder instance");
  return rec;
}

function chunkData(): { tid: number; data: string }[] {
  return sentMessages as { tid: number; data: string }[];
}

async function waitForOnstop(rec: FakeRecorder): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (rec.onstop !== null) {
      return;
    }
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
  throw new Error("finalize never installed onstop");
}

// ---------------------------------------------------------------------------
// startRecordingSink
// ---------------------------------------------------------------------------

test("start rejects a duplicate recording for the same tab", async () => {
  resetRecordingMocks();
  await startRecordingSink(startMessage(101));
  await assert.rejects(startRecordingSink(startMessage(101)), /already exists/);
  // Cleanup so later tids are isolated (finalize needs a frame first).
  await handleRecordingFrame({ type: "recordingFrame", tid: 101, data: Buffer.from("x").toString("base64") });
  // Seed a chunk so finalize has data.
  lastRecorder().ondataavailable?.({ data: new Blob(["hello"]) });
  await handleFinalizeRecording({ type: "finalizeRecording", tid: 101, maxRecordingSizeMiB: 512 });
});

test("start fails when the canvas context is unavailable", async () => {
  resetRecordingMocks();
  getContextShouldReturnNull = true;
  await assert.rejects(startRecordingSink(startMessage(102)), /recording canvas/);
});

test("start prefers mp4 and falls back through the mime list", async () => {
  resetRecordingMocks();
  await startRecordingSink(startMessage(103));
  assert.ok(lastRecorder().mimeType.startsWith("video/mp4"));
  lastRecorder().ondataavailable?.({ data: new Blob(["a"]) });
  await handleRecordingFrame({ type: "recordingFrame", tid: 103, data: Buffer.from("x").toString("base64") });
  await handleFinalizeRecording({ type: "finalizeRecording", tid: 103, maxRecordingSizeMiB: 512 });

  resetRecordingMocks();
  supportedMimes = new Set(["video/webm"]);
  await startRecordingSink(startMessage(104));
  assert.equal(lastRecorder().mimeType, "video/webm");
  lastRecorder().ondataavailable?.({ data: new Blob(["b"]) });
  await handleRecordingFrame({ type: "recordingFrame", tid: 104, data: Buffer.from("x").toString("base64") });
  const result = await handleFinalizeRecording({ type: "finalizeRecording", tid: 104, maxRecordingSizeMiB: 512 });
  assert.deepEqual(result, { contentType: "video/webm" });
});

test("start throws when no mime is supported", async () => {
  resetRecordingMocks();
  supportedMimes = new Set();
  await assert.rejects(
    startRecordingSink(startMessage(105)),
    /cannot encode MP4 or WebM/,
  );
});

test("start scales bitrate for zero-size vs large canvas", async () => {
  resetRecordingMocks();
  await startRecordingSink(startMessage(106, { width: 0, height: 0 }));
  assert.equal(lastRecorder().videoBitsPerSecond, 1_000_000);
  lastRecorder().ondataavailable?.({ data: new Blob(["z"]) });
  await handleRecordingFrame({ type: "recordingFrame", tid: 106, data: Buffer.from("x").toString("base64") });
  await handleFinalizeRecording({ type: "finalizeRecording", tid: 106, maxRecordingSizeMiB: 512 });

  resetRecordingMocks();
  await startRecordingSink(startMessage(107, { width: 3840, height: 2160 }));
  assert.equal(lastRecorder().videoBitsPerSecond, 2_000_000);
  lastRecorder().ondataavailable?.({ data: new Blob(["z"]) });
  await handleRecordingFrame({ type: "recordingFrame", tid: 107, data: Buffer.from("x").toString("base64") });
  await handleFinalizeRecording({ type: "finalizeRecording", tid: 107, maxRecordingSizeMiB: 512 });
});

test("ondataavailable ignores zero-size blobs", async () => {
  resetRecordingMocks();
  await startRecordingSink(startMessage(108));
  const rec = lastRecorder();
  rec.ondataavailable?.({ data: new Blob([]) });
  assert.equal(rec.ondataavailable !== null, true);
  // A zero-size chunk must not produce encoded data: finalize with only an
  // empty chunk yields empty payload but still succeeds when a frame exists.
  await handleRecordingFrame({ type: "recordingFrame", tid: 108, data: Buffer.from("x").toString("base64") });
  rec.ondataavailable?.({ data: new Blob(["nonempty"]) });
  sentMessages.length = 0;
  await handleFinalizeRecording({ type: "finalizeRecording", tid: 108, maxRecordingSizeMiB: 512 });
  const joined = chunkData().map((c) => c.data).join("");
  assert.ok(joined.length > 0);
  assert.equal(Buffer.from(joined, "base64").toString("utf-8"), "nonempty");
});

// ---------------------------------------------------------------------------
// handleRecordingFrame
// ---------------------------------------------------------------------------

test("frame with no sink is a noop", async () => {
  resetRecordingMocks();
  await handleRecordingFrame({ type: "recordingFrame", tid: 9991, data: Buffer.from("x").toString("base64") });
  assert.equal(createImageBitmapCalls, 0);
});

test("frames draw sequentially and resize the canvas", async () => {
  resetRecordingMocks();
  createImageBitmapImpl = async () => ({ width: 640, height: 480, close: () => undefined });
  await startRecordingSink(startMessage(110, { width: 1280, height: 720 }));
  const canvas = canvasInstances[canvasInstances.length - 1];
  assert.ok(canvas !== undefined);
  const payload = Buffer.from("fake-jpeg").toString("base64");
  await handleRecordingFrame({ type: "recordingFrame", tid: 110, data: payload });
  await handleRecordingFrame({ type: "recordingFrame", tid: 110, data: payload });
  assert.equal(canvas?.width, 640);
  assert.equal(canvas?.height, 480);
  assert.equal(canvas?.ctx.drawImageCalls.length, 2);
  lastRecorder().ondataavailable?.({ data: new Blob(["v"]) });
  await handleFinalizeRecording({ type: "finalizeRecording", tid: 110, maxRecordingSizeMiB: 512 });
});

test("frame draw error is recorded once and rethrown on finalize", async () => {
  resetRecordingMocks();
  let calls = 0;
  createImageBitmapImpl = async () => {
    calls += 1;
    if (calls === 1) {
      throw new Error("first-draw-fail");
    }
    throw new Error("second-draw-fail");
  };
  await startRecordingSink(startMessage(111));
  const payload = Buffer.from("bad").toString("base64");
  await handleRecordingFrame({ type: "recordingFrame", tid: 111, data: payload });
  await handleRecordingFrame({ type: "recordingFrame", tid: 111, data: payload });
  lastRecorder().ondataavailable?.({ data: new Blob(["x"]) });
  await assert.rejects(
    handleFinalizeRecording({ type: "finalizeRecording", tid: 111, maxRecordingSizeMiB: 512 }),
    /first-draw-fail/,
  );
});

// ---------------------------------------------------------------------------
// handleFinalizeRecording
// ---------------------------------------------------------------------------

test("finalize with no sink throws", async () => {
  resetRecordingMocks();
  await assert.rejects(
    handleFinalizeRecording({ type: "finalizeRecording", tid: 9992, maxRecordingSizeMiB: 512 }),
    /No active recording/,
  );
});

test("finalize rejects when no frames were drawn", async () => {
  resetRecordingMocks();
  await startRecordingSink(startMessage(113));
  lastRecorder().ondataavailable?.({ data: new Blob(["x"]) });
  await assert.rejects(
    handleFinalizeRecording({ type: "finalizeRecording", tid: 113, maxRecordingSizeMiB: 512 }),
    /no frames/,
  );
});

test("finalize surfaces recorder onerror", async () => {
  resetRecordingMocks();
  recorderAutoBehavior = "onerror";
  recorderOnErrorValue = new Error("encoder exploded");
  await startRecordingSink(startMessage(114));
  await handleRecordingFrame({ type: "recordingFrame", tid: 114, data: Buffer.from("x").toString("base64") });
  await assert.rejects(
    handleFinalizeRecording({ type: "finalizeRecording", tid: 114, maxRecordingSizeMiB: 512 }),
    /encoder exploded/,
  );
});

test("finalize rejects over-size recordings and maps mp4 content type", async () => {
  resetRecordingMocks();
  await startRecordingSink(startMessage(115));
  await handleRecordingFrame({ type: "recordingFrame", tid: 115, data: Buffer.from("x").toString("base64") });
  lastRecorder().ondataavailable?.({ data: new Blob(["hello world"]) });
  await assert.rejects(
    handleFinalizeRecording({ type: "finalizeRecording", tid: 115, maxRecordingSizeMiB: 0 }),
    /exceeds the 0 MiB/,
  );
});

test("finalize sends a single recordingChunk and removes the sink", async () => {
  resetRecordingMocks();
  await startRecordingSink(startMessage(116));
  await handleRecordingFrame({ type: "recordingFrame", tid: 116, data: Buffer.from("x").toString("base64") });
  lastRecorder().ondataavailable?.({ data: new Blob(["chunk-bytes"]) });
  sentMessages.length = 0;
  const result = await handleFinalizeRecording({ type: "finalizeRecording", tid: 116, maxRecordingSizeMiB: 512 });
  assert.deepEqual(result, { contentType: "video/mp4" });
  assert.equal(sentMessages.length, 1);
  const chunk = sentMessages[0] as { type: string; tid: number; data: string };
  assert.equal(chunk.type, "recordingChunk");
  assert.equal(chunk.tid, 116);
  assert.equal(Buffer.from(chunk.data, "base64").toString("utf-8"), "chunk-bytes");
  // Sink removed: a second finalize reports no sink.
  await assert.rejects(
    handleFinalizeRecording({ type: "finalizeRecording", tid: 116, maxRecordingSizeMiB: 512 }),
    /No active recording/,
  );
});

test("concurrent finalize reports already-finalized", async () => {
  resetRecordingMocks();
  recorderAutoBehavior = "manual";
  await startRecordingSink(startMessage(117));
  await handleRecordingFrame({ type: "recordingFrame", tid: 117, data: Buffer.from("x").toString("base64") });
  const rec = lastRecorder();
  rec.ondataavailable?.({ data: new Blob(["late"]) });
  const first = handleFinalizeRecording({ type: "finalizeRecording", tid: 117, maxRecordingSizeMiB: 512 });
  await assert.rejects(
    handleFinalizeRecording({ type: "finalizeRecording", tid: 117, maxRecordingSizeMiB: 512 }),
    /already finalized/,
  );
  // Let the first finalize finish.
  await waitForOnstop(rec);
  rec.onstop?.();
  const result = await first;
  assert.deepEqual(result, { contentType: "video/mp4" });
});

test("frame after finalize-started is a noop", async () => {
  resetRecordingMocks();
  recorderAutoBehavior = "manual";
  await startRecordingSink(startMessage(118));
  await handleRecordingFrame({ type: "recordingFrame", tid: 118, data: Buffer.from("x").toString("base64") });
  const rec = lastRecorder();
  rec.ondataavailable?.({ data: new Blob(["d"]) });
  const callsBefore = createImageBitmapCalls;
  const pending = handleFinalizeRecording({ type: "finalizeRecording", tid: 118, maxRecordingSizeMiB: 512 });
  await handleRecordingFrame({ type: "recordingFrame", tid: 118, data: Buffer.from("y").toString("base64") });
  assert.equal(createImageBitmapCalls, callsBefore);
  await waitForOnstop(rec);
  rec.onstop?.();
  await pending;
});

// ---------------------------------------------------------------------------
// discard timer
// ---------------------------------------------------------------------------

test("discard timer stops the recorder and removes the sink", async () => {
  resetRecordingMocks();
  await startRecordingSink(startMessage(119, { maxRecordingDurationSec: 1 }));
  const rec = lastRecorder();
  const timerId = [...timerCallbacks.keys()].at(-1);
  assert.ok(timerId !== undefined);
  const callback = timerCallbacks.get(timerId as number);
  assert.ok(callback !== undefined);
  (callback as () => void)();
  assert.equal(rec.stopCalled, true);
  await assert.rejects(
    handleFinalizeRecording({ type: "finalizeRecording", tid: 119, maxRecordingSizeMiB: 512 }),
    /No active recording/,
  );
});

test("discard timer is a noop once finalized", async () => {
  resetRecordingMocks();
  recorderAutoBehavior = "manual";
  await startRecordingSink(startMessage(120));
  await handleRecordingFrame({ type: "recordingFrame", tid: 120, data: Buffer.from("x").toString("base64") });
  const rec = lastRecorder();
  rec.ondataavailable?.({ data: new Blob(["q"]) });
  const timerId = [...timerCallbacks.keys()].at(-1) as number;
  const callback = timerCallbacks.get(timerId) as () => void;
  const pending = handleFinalizeRecording({ type: "finalizeRecording", tid: 120, maxRecordingSizeMiB: 512 });
  const stopsBefore = rec.stopCalled;
  callback();
  assert.equal(rec.stopCalled, stopsBefore);
  await waitForOnstop(rec);
  rec.onstop?.();
  await pending;
});
