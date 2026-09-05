import { sendCdpCommand, throwEvaluationException, withDebugger } from "./cdp.js";
import {
  buildConsoleInstallScript,
  buildConsoleUpload,
  CONSOLE_READ_SCRIPT,
  CONSOLE_RESTORE_SCRIPT,
  truncateToBuffer,
} from "./consoleUtil.js";
import type { ConsoleEntry } from "./consoleUtil.js";
import { state } from "./state.js";
import type {
  Configuration,
  ConsolePayload,
  ConsoleStartResult,
  ConsoleUploadResult,
} from "./types.js";

interface ConsoleReadSuccess {
  entries: ConsoleEntry[];
  truncated: boolean;
}

interface ConsoleReadLost {
  lost: true;
}

type ConsoleReadResult = ConsoleReadSuccess | ConsoleReadLost;

function isConsoleReadLost(value: unknown): value is ConsoleReadLost {
  if (typeof value !== "object" || value === null) {
    return true;
  }
  return (value as Record<string, unknown>).lost === true;
}

async function readConsoleEntries(
  tid: number,
  debuggerProtocolVersion: string,
): Promise<ConsoleReadResult> {
  return withDebugger(tid, debuggerProtocolVersion, async (target) => {
    const evaluation = await sendCdpCommand(target, "Runtime.evaluate", {
      expression: CONSOLE_READ_SCRIPT,
      returnByValue: true,
    });
    throwEvaluationException(evaluation);
    const value = evaluation.result.value as unknown;
    if (typeof value !== "object" || value === null) {
      return { lost: true };
    }
    if ((value as Record<string, unknown>).lost === true) {
      return { lost: true };
    }
    const record = value as Record<string, unknown>;
    if (!Array.isArray(record.entries)) {
      return { lost: true };
    }
    return {
      entries: record.entries as ConsoleEntry[],
      truncated: (record.truncated as boolean) === true,
    };
  });
}

async function restoreConsoleShim(
  tid: number,
  debuggerProtocolVersion: string,
): Promise<void> {
  try {
    await withDebugger(tid, debuggerProtocolVersion, async (target) => {
      try {
        await sendCdpCommand(target, "Runtime.evaluate", {
          expression: CONSOLE_RESTORE_SCRIPT,
          returnByValue: true,
        });
      } catch {
        // Best-effort restore: ignore failures (tab may be gone).
      }
    });
  } catch {
    // Best-effort restore: ignore debugger failures.
  }
}

export async function executeConsoleStart(
  tid: number,
  configuration: Configuration,
): Promise<ConsoleStartResult> {
  await chrome.tabs.get(tid);
  if (state.consoleSessions.has(tid)) {
    throw new Error(`A console capture for tab ${tid} is already active`);
  }
  const deadlineMs = Date.now() + configuration.consoleTimeoutSec * 1000;
  const maxBytes = configuration.consoleMaxSizeMiB * 1024 * 1024;
  const expression = buildConsoleInstallScript(deadlineMs, maxBytes);
  await withDebugger(
    tid,
    configuration.debuggerProtocolVersion,
    async (target) => {
      const evaluation = await sendCdpCommand(target, "Runtime.evaluate", {
        expression,
        returnByValue: true,
      });
      throwEvaluationException(evaluation);
    },
  );
  state.consoleSessions.set(tid, { tid, deadlineMs });
  return { started: true };
}

export async function executeConsoleCapture(
  tid: number,
  configuration: Configuration,
): Promise<ConsoleUploadResult> {
  if (!state.consoleSessions.has(tid)) {
    throw new Error(`No active console capture for tab ${tid}`);
  }
  try {
    await chrome.tabs.get(tid);
  } catch {
    state.consoleSessions.delete(tid);
    throw new Error(
      `Console capture for tab ${tid} failed: the tab may be closed`,
    );
  }
  let read: ConsoleReadResult;
  try {
    read = await readConsoleEntries(tid, configuration.debuggerProtocolVersion);
  } catch (error) {
    state.consoleSessions.delete(tid);
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Console capture for tab ${tid} failed: the tab may be closed (${detail})`,
    );
  }
  if (isConsoleReadLost(read)) {
    state.consoleSessions.delete(tid);
    throw new Error(
      "Console capture was lost (the page may have navigated); start again",
    );
  }
  const maxBytes = configuration.consoleMaxSizeMiB * 1024 * 1024;
  const buffer = truncateToBuffer(read.entries, maxBytes);
  return buildConsoleUpload(buffer.entries, read.truncated || buffer.truncated);
}

export async function executeConsoleStop(
  tid: number,
  configuration: Configuration,
): Promise<ConsoleUploadResult> {
  if (!state.consoleSessions.has(tid)) {
    throw new Error(`No active console capture for tab ${tid}`);
  }
  try {
    await chrome.tabs.get(tid);
  } catch {
    state.consoleSessions.delete(tid);
    throw new Error(
      `Console capture for tab ${tid} failed: the tab may be closed`,
    );
  }
  let read: ConsoleReadResult;
  try {
    read = await readConsoleEntries(tid, configuration.debuggerProtocolVersion);
  } catch (error) {
    state.consoleSessions.delete(tid);
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Console capture for tab ${tid} failed: the tab may be closed (${detail})`,
    );
  }
  if (isConsoleReadLost(read)) {
    state.consoleSessions.delete(tid);
    await restoreConsoleShim(tid, configuration.debuggerProtocolVersion);
    throw new Error(
      "Console capture was lost (the page may have navigated); start again",
    );
  }
  await restoreConsoleShim(tid, configuration.debuggerProtocolVersion);
  state.consoleSessions.delete(tid);
  const maxBytes = configuration.consoleMaxSizeMiB * 1024 * 1024;
  const buffer = truncateToBuffer(read.entries, maxBytes);
  return buildConsoleUpload(buffer.entries, read.truncated || buffer.truncated);
}

export async function executeConsole(
  payload: ConsolePayload,
  configuration: Configuration,
): Promise<ConsoleStartResult | ConsoleUploadResult> {
  if (payload.method === "start") {
    return executeConsoleStart(payload.tid, configuration);
  }
  if (payload.method === "capture") {
    return executeConsoleCapture(payload.tid, configuration);
  }
  return executeConsoleStop(payload.tid, configuration);
}
