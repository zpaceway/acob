import type { Protocol } from "devtools-protocol";
import type { ProtocolMapping } from "devtools-protocol/types/protocol-mapping.js";
import type { Configuration } from "./types.js";

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
  configuration: Configuration,
  callback: (target: chrome.debugger.DebuggerSession) => Promise<Result>,
): Promise<Result> {
  const target: chrome.debugger.DebuggerSession = { tabId: tid };
  let attached = false;

  try {
    await chrome.debugger.attach(
      target,
      configuration.debuggerProtocolVersion,
    );
    attached = true;

    return await callback(target);
  } finally {
    if (attached) {
      await chrome.debugger.detach(target);
    }
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
