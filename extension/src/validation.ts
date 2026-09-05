import { MODIFIER_BITS } from "./keys.js";
import { state } from "./state.js";
import { isKeyboardKey, MAX_BATCH_ACTIONS } from "./types.js";
import type {
  ClaimedInstruction,
  KeyboardModifier,
  ReinstallCommand,
  SupportedInstruction,
} from "./types.js";

export function reportError(error: unknown): void {
  if (error instanceof TypeError) {
    if (!state.backendUnavailable) {
      console.info("ACOB server unavailable; retrying");
      state.backendUnavailable = true;
    }
    return;
  }
  console.error(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isReinstallCommand(value: unknown): value is ReinstallCommand {
  return (
    isRecord(value) &&
    value.action === "reinstall" &&
    isRecord(value.payload) &&
    typeof value.payload.token === "string"
  );
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function hasValidModifiers(
  value: unknown,
): value is KeyboardModifier[] {
  return (
    Array.isArray(value) &&
    value.every(
      (modifier) =>
        typeof modifier === "string" &&
        Object.hasOwn(MODIFIER_BITS, modifier),
    )
  );
}

export function isClaimedInstruction(value: unknown): value is ClaimedInstruction {
  return (
    isRecord(value) &&
    isPositiveInteger(value.id) &&
    typeof value.action === "string" &&
    Object.hasOwn(value, "payload")
  );
}

function isProxyString(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) {
    return false;
  }
  try {
    const parsed = new URL(value);
    const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();
    if (scheme !== "http" && scheme !== "https" && scheme !== "socks5") {
      return false;
    }
    if (!parsed.hostname) {
      return false;
    }
    const port = parsed.port ? Number(parsed.port) : NaN;
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
      return false;
    }
    if (parsed.search || parsed.hash) {
      return false;
    }
    if (parsed.pathname !== "" && parsed.pathname !== "/") {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function isSupportedActionPayload(
  action: string,
  payload: Record<string, unknown>,
): boolean {
  if (action === "proxy") {
    if (payload.method === "set") {
      return (
        isProxyString(payload.proxy) &&
        Object.keys(payload).every((key) => key === "method" || key === "proxy")
      );
    }
    if (payload.method === "unset") {
      return payload.proxy === undefined || payload.proxy === null;
    }
    return false;
  }
  if (action === "record") {
    if (payload.method === "start") {
      return (
        isPositiveInteger(payload.tid) &&
        (payload.full_page === undefined ||
          typeof payload.full_page === "boolean")
      );
    }
    if (payload.method === "stop") {
      return (
        isPositiveInteger(payload.tid) &&
        (payload.full_page === undefined ||
          payload.full_page === false ||
          payload.full_page === null)
      );
    }
    return false;
  }
  if (action === "click") {
    return (
      isPositiveInteger(payload.tid) && typeof payload.selector === "string"
    );
  }
  if (action === "javascript") {
    return isPositiveInteger(payload.tid) && typeof payload.script === "string";
  }
  if (action === "keyboard") {
    if (
      !isPositiveInteger(payload.tid) ||
      (payload.modifiers !== undefined &&
        !hasValidModifiers(payload.modifiers))
    ) {
      return false;
    }
    return typeof payload.text === "string"
      ? (payload.modifiers?.length ?? 0) === 0 && payload.key === undefined
      : isKeyboardKey(payload.key) && payload.text === undefined;
  }
  if (action === "screenshot") {
    return (
      isPositiveInteger(payload.tid) &&
      (payload.full_page === undefined ||
        typeof payload.full_page === "boolean")
    );
  }
  if (action === "list") {
    return true;
  }
  if (action === "close" || action === "focus" || action === "reload") {
    return isPositiveInteger(payload.tid);
  }
  if (action === "navigate") {
    return (
      typeof payload.url === "string" &&
      (payload.tid === undefined || isPositiveInteger(payload.tid))
    );
  }
  return (
    action === "scroll" &&
    isPositiveInteger(payload.tid) &&
    typeof payload.y === "number" &&
    Number.isFinite(payload.y)
  );
}

function instructionValidationError(
  value: ClaimedInstruction,
): string | null {
  if (!isRecord(value.payload)) {
    return `Unsupported or invalid instruction: ${value.action}: payload must be an object`;
  }
  if (value.action !== "batch") {
    return isSupportedActionPayload(value.action, value.payload)
      ? null
      : `Unsupported or invalid instruction: ${value.action}`;
  }
  if (!Array.isArray(value.payload.actions)) {
    return "Unsupported or invalid instruction: batch: actions must be an array";
  }
  if (
    value.payload.actions.length === 0 ||
    value.payload.actions.length > MAX_BATCH_ACTIONS
  ) {
    return `Unsupported or invalid instruction: batch: actions must contain 1-${MAX_BATCH_ACTIONS} entries`;
  }
  for (const [index, entry] of value.payload.actions.entries()) {
    if (!isRecord(entry) || typeof entry.action !== "string") {
      return `Unsupported or invalid instruction: batch action ${index} must be an object with a string action`;
    }
    const { action: entryAction, ...entryPayload } = entry;
    if (!isSupportedActionPayload(entryAction, entryPayload)) {
      return `Unsupported or invalid instruction: batch action ${index} (${entryAction})`;
    }
  }
  return null;
}

export function assertSupportedInstruction(
  value: ClaimedInstruction,
): asserts value is SupportedInstruction {
  const validationError = instructionValidationError(value);
  if (validationError !== null) {
    throw new Error(validationError);
  }
}

export function isSupportedInstruction(
  value: ClaimedInstruction,
): value is SupportedInstruction {
  return instructionValidationError(value) === null;
}
