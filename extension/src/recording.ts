import { ACOBSettings } from "./settings.js";
import type {
  FinalizeRecordingMessage,
  RecordingContentType,
  RecordingFrameMessage,
  StartRecordingMessage,
} from "./types.js";

const RECORDING_BITRATE = 1_000_000;
const RECORDING_BITRATE_CAP = 2_000_000;
const RECORDING_REFERENCE_PIXELS = 1920 * 1080;
const RECORDING_FRAMERATE = 30;
const RECORDING_DISCARD_GRACE_MS = 30_000;
interface RecordingSink {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  recorder: MediaRecorder;
  mimeType: string;
  chunks: Blob[];
  drawing: Promise<void>;
  drawError: unknown;
  framesDrawn: number;
  finalized: boolean;
  discardTimer: number | undefined;
}

const sinks = new Map<number, RecordingSink>();

function chooseMimeType(): string {
  const candidates = [
    "video/mp4;codecs=avc1.42E01E",
    "video/mp4;codecs=avc1",
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
  ];
  const mimeType = candidates.find((candidate) =>
    MediaRecorder.isTypeSupported(candidate),
  );
  if (mimeType === undefined) {
    throw new Error("This Chromium cannot encode MP4 or WebM recordings");
  }
  return mimeType;
}

function containerTypeForMime(mimeType: string): RecordingContentType {
  return mimeType.startsWith("video/mp4") ? "video/mp4" : "video/webm";
}

function base64FromBytes(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]!);
  }
  return btoa(binary);
}

async function drawFrame(
  sink: RecordingSink,
  data: string,
): Promise<void> {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  const bitmap = await createImageBitmap(
    new Blob([bytes], { type: "image/jpeg" }),
  );
  if (
    sink.canvas.width !== bitmap.width ||
    sink.canvas.height !== bitmap.height
  ) {
    sink.canvas.width = bitmap.width;
    sink.canvas.height = bitmap.height;
  }
  sink.context.drawImage(bitmap, 0, 0, sink.canvas.width, sink.canvas.height);
  bitmap.close();
  sink.framesDrawn += 1;
}

function discardSink(recordingId: number): void {
  const sink = sinks.get(recordingId);
  if (sink === undefined || sink.finalized) {
    return;
  }
  sink.finalized = true;
  try {
    sink.recorder.stop();
  } catch {
    // The recorder may already be stopped.
  }
  sinks.delete(recordingId);
}

export async function startRecordingSink(
  message: StartRecordingMessage,
): Promise<void> {
  if (sinks.has(message.recordingId)) {
    throw new Error(`A recording with id ${message.recordingId} already exists`);
  }
  const canvas = document.createElement("canvas");
  canvas.width = message.width > 0 ? message.width : 0;
  canvas.height = message.height > 0 ? message.height : 0;
  const context = canvas.getContext("2d");
  if (context === null) {
    throw new Error("Could not create the recording canvas");
  }
  const mimeType = chooseMimeType();
  const pixels = canvas.width * canvas.height;
  const videoBitsPerSecond =
    pixels > 0
      ? Math.min(
          RECORDING_BITRATE_CAP,
          Math.max(
            RECORDING_BITRATE,
            Math.round(
              (RECORDING_BITRATE * pixels) / RECORDING_REFERENCE_PIXELS,
            ),
          ),
        )
      : RECORDING_BITRATE;
  const recorder = new MediaRecorder(canvas.captureStream(RECORDING_FRAMERATE), {
    mimeType,
    videoBitsPerSecond,
  });
  const sink: RecordingSink = {
    canvas,
    context,
    recorder,
    mimeType,
    chunks: [],
    drawing: Promise.resolve(),
    drawError: null,
    framesDrawn: 0,
    finalized: false,
    discardTimer: window.setTimeout(
      () => discardSink(message.recordingId),
      message.maxRecordingDurationMs + RECORDING_DISCARD_GRACE_MS,
    ),
  };
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) {
      sink.chunks.push(event.data);
    }
  };
  recorder.start(1000);
  sinks.set(message.recordingId, sink);
}

export async function handleRecordingFrame(
  message: RecordingFrameMessage,
): Promise<void> {
  const sink = sinks.get(message.recordingId);
  if (sink === undefined || sink.finalized) {
    return;
  }
  await sink.drawing.catch(() => undefined);
  const drawing = drawFrame(sink, message.data).catch((error: unknown) => {
    if (sink.drawError === null) {
      sink.drawError = error;
    }
  });
  sink.drawing = drawing.then(
    () => undefined,
    () => undefined,
  );
  await drawing;
}

export async function handleFinalizeRecording(
  message: FinalizeRecordingMessage,
): Promise<{ data: string; contentType: RecordingContentType }> {
  const sink = sinks.get(message.recordingId);
  if (sink === undefined) {
    throw new Error(`No active recording with id ${message.recordingId}`);
  }
  if (sink.finalized) {
    throw new Error(`Recording ${message.recordingId} was already finalized`);
  }
  sink.finalized = true;
  if (sink.discardTimer !== undefined) {
    window.clearTimeout(sink.discardTimer);
  }
  try {
    await sink.drawing.catch(() => undefined);
    if (sink.drawError !== null) {
      throw sink.drawError;
    }
    if (sink.framesDrawn === 0) {
      throw new Error(
        "Recording captured no frames; the tab may not be rendering",
      );
    }
    const stopped = new Promise<void>((resolve, reject) => {
      sink.recorder.onstop = () => resolve();
      sink.recorder.onerror = (event) => {
        reject(event.error ?? new Error("MediaRecorder failed"));
      };
    });
    sink.recorder.stop();
    await stopped;
    const blob = new Blob(sink.chunks, { type: sink.mimeType });
    const data = base64FromBytes(new Uint8Array(await blob.arrayBuffer()));
    if (
      data.length >
      ACOBSettings.mebibytesToBytes(message.maxRecordingSizeMiB)
    ) {
      throw new Error(
        `Recording exceeds the ${message.maxRecordingSizeMiB} MiB encoded size limit`,
      );
    }
    return { data, contentType: containerTypeForMime(sink.mimeType) };
  } finally {
    sinks.delete(message.recordingId);
  }
}
