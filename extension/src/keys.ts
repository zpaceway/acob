import type { KeyboardModifier } from "./types.js";

export interface KeyDefinition {
  key: string;
  code?: string;
  keyCode?: number;
  text?: string;
  unmodifiedText?: string;
}

export const MODIFIER_BITS: Record<KeyboardModifier, number> = {
  alt: 1,
  ctrl: 2,
  meta: 4,
  shift: 8,
};

const KEY_DEFINITIONS: Record<string, KeyDefinition> = {
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  Delete: { key: "Delete", code: "Delete", keyCode: 46 },
  End: { key: "End", code: "End", keyCode: 35 },
  Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  Escape: { key: "Escape", code: "Escape", keyCode: 27 },
  Home: { key: "Home", code: "Home", keyCode: 36 },
  PageDown: { key: "PageDown", code: "PageDown", keyCode: 34 },
  PageUp: { key: "PageUp", code: "PageUp", keyCode: 33 },
  Space: { key: " ", code: "Space", keyCode: 32, text: " " },
  Tab: { key: "Tab", code: "Tab", keyCode: 9 },
};

const SHIFTED_CHARACTERS: Record<string, string> = {
  "`": "~",
  1: "!",
  2: "@",
  3: "#",
  4: "$",
  5: "%",
  6: "^",
  7: "&",
  8: "*",
  9: "(",
  0: ")",
  "-": "_",
  "=": "+",
  "[": "{",
  "]": "}",
  "\\": "|",
  ";": ":",
  "'": '"',
  ",": "<",
  ".": ">",
  "/": "?",
};

const CHARACTER_DEFINITIONS: Record<
  string,
  Pick<KeyDefinition, "code" | "keyCode">
> = {
  "`": { code: "Backquote", keyCode: 192 },
  1: { code: "Digit1", keyCode: 49 },
  2: { code: "Digit2", keyCode: 50 },
  3: { code: "Digit3", keyCode: 51 },
  4: { code: "Digit4", keyCode: 52 },
  5: { code: "Digit5", keyCode: 53 },
  6: { code: "Digit6", keyCode: 54 },
  7: { code: "Digit7", keyCode: 55 },
  8: { code: "Digit8", keyCode: 56 },
  9: { code: "Digit9", keyCode: 57 },
  0: { code: "Digit0", keyCode: 48 },
  "-": { code: "Minus", keyCode: 189 },
  "=": { code: "Equal", keyCode: 187 },
  "[": { code: "BracketLeft", keyCode: 219 },
  "]": { code: "BracketRight", keyCode: 221 },
  "\\": { code: "Backslash", keyCode: 220 },
  ";": { code: "Semicolon", keyCode: 186 },
  "'": { code: "Quote", keyCode: 222 },
  ",": { code: "Comma", keyCode: 188 },
  ".": { code: "Period", keyCode: 190 },
  "/": { code: "Slash", keyCode: 191 },
};

const UNSHIFTED_CHARACTERS: Record<string, string> = Object.fromEntries(
  Object.entries(SHIFTED_CHARACTERS).map(([key, value]) => [value, key]),
);

export function describeKey(key: string, shiftPressed: boolean): KeyDefinition {
  const namedDefinition = KEY_DEFINITIONS[key];
  if (namedDefinition) {
    return namedDefinition;
  }

  const upperKey = key.toUpperCase();
  if (/^[A-Z]$/.test(upperKey)) {
    const unmodifiedText = key.toLowerCase();
    const text = shiftPressed ? upperKey : key;
    return {
      key: text,
      code: `Key${upperKey}`,
      keyCode: upperKey.charCodeAt(0),
      text,
      unmodifiedText,
    };
  }

  const unmodifiedText = UNSHIFTED_CHARACTERS[key] ?? key;
  const characterDefinition = CHARACTER_DEFINITIONS[unmodifiedText];
  if (characterDefinition) {
    const text = shiftPressed
      ? (SHIFTED_CHARACTERS[unmodifiedText] ?? key)
      : key;
    return {
      key: text,
      ...characterDefinition,
      text,
      unmodifiedText,
    };
  }
  return { key, text: key, unmodifiedText: key };
}
