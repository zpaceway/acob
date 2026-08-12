import type { Protocol } from "devtools-protocol";
import type { ProtocolMapping } from "devtools-protocol/types/protocol-mapping.js";

// One Chromium debugger session can be attached per tab, so all debugger
// work (click, keyboard, screenshot, scroll, JavaScript, and recordings)
// shares a single refcounted session per tab instead of attach/detaching
// per action. A recording holds its tab's session for its whole lifetime;
// other actions acquire the same session while it runs.
interface SharedDebuggerSession {
  target: chrome.debugger.DebuggerSession;
  refCount: number;
  detached: boolean;
}

const sessions = new Map<number, SharedDebuggerSession>();

chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId === undefined) {
    return;
  }
  const session = sessions.get(source.tabId);
  if (session !== undefined) {
    session.detached = true;
  }
  if (reason !== "target_closed") {
    console.warn(`ACOB debugger detached from tab ${source.tabId}: ${reason}`);
  }
});

export async function acquireDebugger(
  tid: number,
  debuggerProtocolVersion: string,
): Promise<chrome.debugger.DebuggerSession> {
  const existing = sessions.get(tid);
  if (existing !== undefined && !existing.detached) {
    existing.refCount += 1;
    return existing.target;
  }
  if (existing !== undefined) {
    sessions.delete(tid);
  }
  const target: chrome.debugger.DebuggerSession = { tabId: tid };
  await chrome.debugger.attach(target, debuggerProtocolVersion);
  sessions.set(tid, {
    target,
    refCount: 1,
    detached: false,
  });
  return target;
}

export async function releaseDebugger(
  tid: number,
  target: chrome.debugger.DebuggerSession,
): Promise<void> {
  const session = sessions.get(tid);
  if (session === undefined || session.target !== target) {
    return;
  }
  session.refCount -= 1;
  if (session.refCount > 0) {
    return;
  }
  sessions.delete(tid);
  if (session.detached) {
    return;
  }
  await chrome.debugger.detach(target).catch(() => undefined);
}

export function throwEvaluationException(
  evaluation: Protocol.Runtime.EvaluateResponse,
): void {
  if (!evaluation.exceptionDetails) {
    return;
  }
  const message =
    evaluation.exceptionDetails.exception?.description ??
    evaluation.exceptionDetails.text;
  throw new Error(message);
}

export async function withDebugger<Result>(
  tid: number,
  debuggerProtocolVersion: string,
  callback: (target: chrome.debugger.DebuggerSession) => Promise<Result>,
): Promise<Result> {
  const target = await acquireDebugger(tid, debuggerProtocolVersion);
  try {
    return await callback(target);
  } finally {
    await releaseDebugger(tid, target);
  }
}

type CdpCommand = keyof ProtocolMapping.Commands;

export async function sendCdpCommand<Command extends CdpCommand>(
  target: chrome.debugger.DebuggerSession,
  method: Command,
  ...parameters: ProtocolMapping.Commands[Command]["paramsType"]
): Promise<ProtocolMapping.Commands[Command]["returnType"]> {
  const commandParameters = parameters[0] as
    | Record<string, unknown>
    | undefined;
  const result = await chrome.debugger.sendCommand(
    target,
    method,
    commandParameters,
  );
  return result as ProtocolMapping.Commands[Command]["returnType"];
}
