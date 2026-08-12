import type { RecordingContentType, RecordingStopReason } from "./types.js";

export interface ActiveJavaScriptExecution {
  tid: number;
  finished: Promise<void>;
  stop: () => Promise<void>;
}

export interface RecordingOutcome {
  data: string;
  contentType: RecordingContentType;
  durationMs: number;
  stoppedReason: RecordingStopReason;
  message: string;
}

export interface ActiveRecording {
  tid: number;
  requestStop: () => void;
  finished: Promise<RecordingOutcome>;
}

export const state = {
  activeExecutions: 0,
  activeJavaScriptExecutions: new Set<ActiveJavaScriptExecution>(),
  backendUnavailable: false,
  lastSettingsReportAt: 0,
  pollInProgress: false,
  recordings: new Map<number, ActiveRecording>(),
  recordingChunks: new Map<number, string[]>(),
  reinstallScheduled: false,
  tabCreationQueue: Promise.resolve() as Promise<void>,
  tabExecutionQueues: new Map<number, Promise<void>>(),
};
