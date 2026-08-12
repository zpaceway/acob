import { MODIFIER_BITS } from "./keys.js";
import { state } from "./state.js";
import { isKeyboardKey } from "./types.js";
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

export function isSupportedInstruction(
  value: ClaimedInstruction,
): value is SupportedInstruction {
  if (!isRecord(value.payload)) {
    return false;
  }

  const payload = value.payload;
  if (value.action === "click") {
    return (
      isPositiveInteger(payload.tid) && typeof payload.selector === "string"
    );
  }
  if (value.action === "javascript") {
    return isPositiveInteger(payload.tid) && typeof payload.script === "string";
  }
  if (value.action === "keyboard") {
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
  if (value.action === "screenshot") {
    return (
      isPositiveInteger(payload.tid) &&
      (payload.full_page === undefined ||
        typeof payload.full_page === "boolean")
    );
  }
  if (value.action === "list") {
    return true;
  }
  if (
    value.action === "close" ||
    value.action === "focus" ||
    value.action === "reload"
  ) {
    return isPositiveInteger(payload.tid);
  }
  if (value.action === "navigate") {
    return (
      typeof payload.url === "string" &&
      (payload.tid === undefined || isPositiveInteger(payload.tid))
    );
  }
  return (
    value.action === "scroll" &&
    isPositiveInteger(payload.tid) &&
    typeof payload.y === "number" &&
    Number.isFinite(payload.y)
  );
}
