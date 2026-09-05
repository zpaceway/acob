import type { ConsoleUploadResult } from "./types.js";

export interface ConsoleEntry {
  t: number;
  level: string;
  text: string;
}

export interface TruncatedConsoleBuffer {
  entries: ConsoleEntry[];
  truncated: boolean;
  size_bytes: number;
}

export function formatConsoleArg(value: unknown): string {
  if (value === undefined) {
    return "undefined";
  }
  if (typeof value === "function") {
    return "[Function]";
  }
  if (typeof value === "bigint") {
    return `${value.toString()}n`;
  }
  if (typeof value === "string") {
    return value;
  }
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
  ) {
    try {
      return String(value);
    } catch {
      return "[Unserializable]";
    }
  }
  try {
    const seen = new WeakSet<object>();
    const json = JSON.stringify(value, (_key, nested: unknown) => {
      if (typeof nested === "function") {
        return "[Function]";
      }
      if (typeof nested === "bigint") {
        return `${(nested as bigint).toString()}n`;
      }
      if (typeof nested === "symbol") {
        return String(nested);
      }
      if (nested !== null && typeof nested === "object") {
        if (seen.has(nested as object)) {
          return "[Circular]";
        }
        try {
          seen.add(nested as object);
        } catch {
          // Ignore WeakSet failures for exotic objects.
        }
      }
      return nested;
    });
    if (json === undefined) {
      try {
        return String(value as object);
      } catch {
        return "[Unserializable]";
      }
    }
    return json;
  } catch (error) {
    try {
      if (/circular/i.test(String((error as Error)?.message ?? error))) {
        return "[Circular]";
      }
      return String(value as object);
    } catch {
      return "[Unserializable]";
    }
  }
}

export function formatConsoleArgs(args: unknown[]): string {
  return args.map((arg) => formatConsoleArg(arg)).join(" ");
}

export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function truncateToBuffer(
  entries: ConsoleEntry[],
  maxBytes: number,
): TruncatedConsoleBuffer {
  const encoder = new TextEncoder();
  const fullJson = JSON.stringify(entries);
  const fullSize = encoder.encode(fullJson).length;
  if (fullSize <= maxBytes) {
    return { entries: entries.slice(), truncated: false, size_bytes: fullSize };
  }
  const emptySize = encoder.encode("[]").length;
  if (emptySize > maxBytes) {
    return { entries: [], truncated: true, size_bytes: emptySize };
  }
  let lo = 0;
  let hi = entries.length;
  while (lo + 1 < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const size = encoder.encode(JSON.stringify(entries.slice(0, mid))).length;
    if (size <= maxBytes) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  const kept = entries.slice(0, lo);
  const size = encoder.encode(JSON.stringify(kept)).length;
  return { entries: kept, truncated: true, size_bytes: size };
}

export function base64EncodeUtf8(json: string): string {
  const bytes = new TextEncoder().encode(json);
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const sub = bytes.subarray(i, i + CHUNK);
    let chunkStr = "";
    for (let j = 0; j < sub.length; j += 1) {
      chunkStr += String.fromCharCode(sub[j] as number);
    }
    binary += chunkStr;
  }
  if (typeof btoa === "function") {
    return btoa(binary);
  }
  const bufferCtor = (
    globalThis as unknown as {
      Buffer?: { from(input: string, encoding: string): { toString(e: string): string } };
    }
  ).Buffer;
  if (bufferCtor !== undefined) {
    return bufferCtor.from(json, "utf-8").toString("base64");
  }
  throw new Error("No base64 encoder available");
}

export function buildConsoleUpload(
  entries: ConsoleEntry[],
  truncated: boolean,
): ConsoleUploadResult {
  const json = JSON.stringify(entries);
  const size_bytes = new TextEncoder().encode(json).length;
  const data = base64EncodeUtf8(json);
  return {
    data,
    content_type: "application/json",
    entries: entries.length,
    size_bytes,
    truncated,
  };
}

export function buildConsoleInstallScript(
  deadlineMs: number,
  maxBytes: number,
): string {
  const deadlineLiteral = Number.isFinite(deadlineMs)
    ? Math.floor(deadlineMs)
    : Date.now();
  const maxBytesLiteral = Number.isFinite(maxBytes)
    ? Math.floor(maxBytes)
    : 2 * 1024 * 1024;
  return `(() => {
  // ACOB console capture: installs under window.__acob__.consoleCapture
  var deadlineMs = ${deadlineLiteral};
  var maxBytes = ${maxBytesLiteral};
  var root = window;
  var ns = window.__acob__;
  if (!ns || typeof ns !== "object") {
    ns = {};
    try { window.__acob__ = ns; } catch (e) {
      try { Object.defineProperty(window, "__acob__", { value: ns, writable: true, configurable: true, enumerable: false }); } catch (_) {}
    }
  }
  try {
    var prev = null;
    try { prev = window.__acob__.consoleCapture || window.__acobConsoleCapture || null; } catch (_) {}
    if (prev && prev.originals) {
      try {
        for (var k in prev.originals) {
          try { console[k] = prev.originals[k]; } catch (_) {}
        }
      } catch (_) {}
    }
  } catch (_) {}
  var originals = {
    debug: console.debug.bind(console),
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console)
  };
  var captureState = {
    entries: [],
    sumBytes: 0,
    count: 0,
    truncated: false,
    deadlineMs: deadlineMs,
    maxBytes: maxBytes,
    active: true,
    originals: originals,
    restore: function () {
      try { captureState.active = false; } catch (_) {}
      try {
        console.debug = originals.debug;
        console.log = originals.log;
        console.info = originals.info;
        console.warn = originals.warn;
        console.error = originals.error;
      } catch (_) {}
    }
  };
  function safeStringify(val, seen) {
    if (val === undefined) return "undefined";
    if (typeof val === "function") return "[Function]";
    if (typeof val === "bigint") return val.toString() + "n";
    if (typeof val === "string") return val;
    if (typeof val === "number" || typeof val === "boolean" || val === null) {
      try { return String(val); } catch (_) { return "[Unserializable]"; }
    }
    try {
      seen = seen || new WeakSet();
      var json = JSON.stringify(val, function (key, v) {
        if (typeof v === "function") return "[Function]";
        if (typeof v === "bigint") return v.toString() + "n";
        if (typeof v === "symbol") return String(v);
        if (v !== null && typeof v === "object") {
          if (seen.has(v)) return "[Circular]";
          try { seen.add(v); } catch (_) {}
        }
        return v;
      });
      if (json === undefined) {
        try { return String(val); } catch (_) { return "[Unserializable]"; }
      }
      return json;
    } catch (e) {
      try {
        var s = String(val);
        if (/circular/i.test(String((e && e.message) || e))) return "[Circular]";
        return s;
      } catch (_) { return "[Unserializable]"; }
    }
  }
  function append(level, args) {
    if (!captureState.active) return;
    try {
      if (Date.now() > captureState.deadlineMs) {
        captureState.truncated = true;
        return;
      }
      var text = args.map(function (a) { return safeStringify(a); }).join(" ");
      var entry = { t: Date.now(), level: level, text: text };
      // Incremental exact accounting: the final document is
      // "[" + entries.join(",") + "]", so its size is
      // sumBytes + count + 1. Appending is O(entry), never O(buffer).
      var entryJson = null;
      try { entryJson = JSON.stringify(entry); }
      catch (_) { captureState.truncated = true; return; }
      var entryBytes = 0;
      try { entryBytes = new TextEncoder().encode(entryJson).length; }
      catch (_) { return; }
      if (captureState.sumBytes + entryBytes + captureState.count + 2 > captureState.maxBytes) {
        captureState.truncated = true;
        return;
      }
      captureState.entries.push(entry);
      captureState.sumBytes += entryBytes;
      captureState.count += 1;
    } catch (_) {}
  }
  ["debug", "log", "info", "warn", "error"].forEach(function (level) {
    var orig = originals[level];
    console[level] = function () {
      var args = Array.prototype.slice.call(arguments);
      try { orig.apply(console, args); } catch (_) {}
      try { append(level, args); } catch (_) {}
    };
  });
  try {
    try { window.__acob__.consoleCapture = captureState; }
    catch (_) {
      try { Object.defineProperty(ns, "consoleCapture", { value: captureState, writable: true, configurable: true, enumerable: false }); }
      catch (_) {}
    }
  } catch (_) {}
  try { window.__acobConsoleCapture = captureState; } catch (_) {}
  return true;
})()`;
}

export const CONSOLE_READ_SCRIPT = `(() => {
  var cap = null;
  try { cap = (window.__acob__ && window.__acob__.consoleCapture) || window.__acobConsoleCapture || null; } catch (_) {}
  if (!cap || !cap.entries) return { lost: true };
  return { entries: cap.entries, truncated: !!cap.truncated };
})()`;

export const CONSOLE_RESTORE_SCRIPT = `(() => {
  try {
    var cap = null;
    try { cap = (window.__acob__ && window.__acob__.consoleCapture) || window.__acobConsoleCapture || null; } catch (_) {}
    if (cap && typeof cap.restore === "function") {
      try { cap.restore(); } catch (_) {}
    }
  } catch (_) {}
  try {
    if (window.__acob__ && window.__acob__.consoleCapture) {
      try { delete window.__acob__.consoleCapture; } catch (_) {}
    }
  } catch (_) {}
  try { delete window.__acobConsoleCapture; } catch (_) {}
  return true;
})()`;
