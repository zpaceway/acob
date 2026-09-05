export type JsonPrimitive = boolean | null | number | string;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

export interface JsonObject {
  [key: string]: JsonValue;
}

export interface SettingValues {
  baseUrl: string;
  instructionsPerPoll: number;
  maxConcurrentExecutions: number;
  maxTabs: number;
  pollIntervalMs: number;
  tabLoadTimeoutMs: number;
  httpRequestTimeoutMs: number;
  javascriptTimeoutMs: number;
  maxScreenshotSizeMiB: number;
  maxRecordingDurationSec: number;
  maxRecordingSizeMiB: number;
  resultRetryAttempts: number;
  resultRetryDelayMs: number;
  popupStatusDurationMs: number;
  debuggerProtocolVersion: string;
}

export interface Configuration extends SettingValues {
  bid: string;
}

export type SettingName = keyof SettingValues;
export type StorageKey = keyof Configuration;
export type SettingValue = SettingValues[SettingName];
export type SettingValueType = "integer" | "string" | "url";

interface BaseSettingDefinition<
  Value extends SettingValue,
  ValueType extends SettingValueType,
> {
  readonly defaultValue: Value;
  readonly valueType: ValueType;
  readonly inputType: string;
  readonly label: string;
  readonly hint: string;
  readonly editable: boolean;
  readonly visible: boolean;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly pattern?: string;
  readonly placeholder?: string;
}

export interface IntegerSettingDefinition
  extends BaseSettingDefinition<number, "integer"> {
  readonly inputType: "number";
}

export interface StringSettingDefinition
  extends BaseSettingDefinition<string, "string"> {
  readonly inputType: "text";
}

export interface UrlSettingDefinition
  extends BaseSettingDefinition<string, "url"> {
  readonly inputType: "url";
}

export type SettingDefinition<Name extends SettingName = SettingName> =
  Name extends "baseUrl"
    ? UrlSettingDefinition
    : SettingValues[Name] extends number
      ? IntegerSettingDefinition
      : StringSettingDefinition;

export type SettingDefinitions = {
  readonly [Name in SettingName]: SettingDefinition<Name>;
};

export interface SettingsApi {
  readonly definitions: SettingDefinitions;
  readonly settingNames: readonly SettingName[];
  readonly storageKeys: readonly StorageKey[];
  generateBrowserId(): string;
  isValidBrowserId(value: unknown): value is string;
  isValidSetting<Name extends SettingName>(
    name: Name,
    value: unknown,
  ): value is SettingValues[Name];
  isValidSetting(name: string, value: unknown): boolean;
  mebibytesToBytes(value: number): number;
  normalizeConfiguration(
    values?: Readonly<Partial<Record<StorageKey, unknown>>>,
  ): Configuration;
  normalizeSetting<Name extends SettingName>(
    name: Name,
    value: unknown,
  ): SettingValues[Name];
  normalizeSetting(name: string, value: unknown): SettingValue | undefined;
}

export type InstructionAction =
  | "batch"
  | "click"
  | "close"
  | "focus"
  | "javascript"
  | "keyboard"
  | "list"
  | "navigate"
  | "proxy"
  | "record"
  | "reload"
  | "screenshot"
  | "scroll";
export type InstructionStatus =
  | "pending"
  | "processing"
  | "completed"
  | "failed";
export type KeyboardModifier = "alt" | "ctrl" | "meta" | "shift";
export const MAX_BATCH_ACTIONS = 20;
export const NAMED_KEYBOARD_KEYS = Object.freeze([
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "Backspace",
  "Delete",
  "End",
  "Enter",
  "Escape",
  "Home",
  "PageDown",
  "PageUp",
  "Space",
  "Tab",
] as const);

export type NamedKeyboardKey = (typeof NAMED_KEYBOARD_KEYS)[number];
declare const keyboardCharacterBrand: unique symbol;
export type KeyboardCharacter = string & {
  readonly [keyboardCharacterBrand]: true;
};
export type KeyboardKey = NamedKeyboardKey | KeyboardCharacter;

export function isKeyboardKey(value: unknown): value is KeyboardKey {
  return (
    typeof value === "string" &&
    (NAMED_KEYBOARD_KEYS.some((key) => key === value) ||
      (Array.from(value).length === 1 && value.trim().length > 0))
  );
}

export function keyboardCharacter(value: string): KeyboardCharacter {
  if (Array.from(value).length !== 1 || value.trim().length === 0) {
    throw new RangeError(
      "Keyboard characters must contain exactly one non-whitespace character",
    );
  }
  return value as KeyboardCharacter;
}

export type ListTabsPayload = Record<string, never>;

export interface CloseTabPayload {
  tid: number;
}

export interface FocusTabPayload {
  tid: number;
}

export interface NavigateTabPayload {
  tid?: number;
  url: string;
}

export interface ReloadTabPayload {
  tid: number;
}

export interface ScrollPayload {
  tid: number;
  y: number;
}

export interface ClickPayload {
  tid: number;
  selector: string;
}

export interface JavaScriptPayload {
  tid: number;
  script: string;
}

export interface KeyboardTextPayload {
  tid: number;
  text: string;
  modifiers?: [];
}

export interface KeyboardKeyPayload {
  tid: number;
  key: KeyboardKey;
  modifiers?: KeyboardModifier[];
}

export type KeyboardPayload = KeyboardTextPayload | KeyboardKeyPayload;

export interface ScreenshotPayload {
  tid: number;
  full_page?: boolean;
}

export type ProxyMethod = "set" | "unset";
export type ProxyScheme = "http" | "https" | "socks5";

export interface ProxySetPayload {
  method: "set";
  proxy: string;
}

export interface ProxyUnsetPayload {
  method: "unset";
}

export type ProxyPayload = ProxySetPayload | ProxyUnsetPayload;

export type RecordMethod = "start" | "stop";

export interface RecordStartPayload {
  method: "start";
  tid: number;
  full_page?: boolean;
}

export interface RecordStopPayload {
  method: "stop";
  tid: number;
}

export type RecordPayload = RecordStartPayload | RecordStopPayload;

export interface BatchPayload {
  actions: InstructionRequest[];
}

export interface InstructionPayloadMap {
  batch: BatchPayload;
  click: ClickPayload;
  close: CloseTabPayload;
  focus: FocusTabPayload;
  javascript: JavaScriptPayload;
  keyboard: KeyboardPayload;
  list: ListTabsPayload;
  navigate: NavigateTabPayload;
  proxy: ProxyPayload;
  record: RecordPayload;
  reload: ReloadTabPayload;
  screenshot: ScreenshotPayload;
  scroll: ScrollPayload;
}

export type SupportedInstruction<
  Action extends InstructionAction = InstructionAction,
> = {
  [CurrentAction in Action]: {
    id: number;
    action: CurrentAction;
    payload: InstructionPayloadMap[CurrentAction];
  };
}[Action];

export interface ClaimedInstruction {
  id: number;
  action: string;
  payload: unknown;
}

// Delivered by the claim route in place of queued work, so it carries no
// instruction id and is never completed through the result route.
export interface ReinstallCommand {
  action: "reinstall";
  payload: { token: string };
}

export interface Instruction {
  id: number;
  bid: string;
  action: string;
  payload: JsonObject;
  status: InstructionStatus;
  result: JsonValue;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface ListTabsInstructionRequest {
  action: "list";
}

export interface CloseTabInstructionRequest extends CloseTabPayload {
  action: "close";
}

export interface FocusTabInstructionRequest extends FocusTabPayload {
  action: "focus";
}

export interface NavigateTabInstructionRequest extends NavigateTabPayload {
  action: "navigate";
}

export interface ReloadTabInstructionRequest extends ReloadTabPayload {
  action: "reload";
}

export interface ScrollInstructionRequest extends ScrollPayload {
  action: "scroll";
}

export interface ClickInstructionRequest extends ClickPayload {
  action: "click";
}

export interface JavaScriptInstructionRequest extends JavaScriptPayload {
  action: "javascript";
}

export type KeyboardInstructionRequest =
  | {
      action: "keyboard";
      tid: number;
      text: string;
      key?: never;
      modifiers?: [];
    }
  | {
      action: "keyboard";
      tid: number;
      text?: never;
      key: KeyboardKey;
      modifiers?: KeyboardModifier[];
    };

export interface ScreenshotInstructionRequest {
  action: "screenshot";
  tid: number;
  full_page?: boolean;
}

export type ProxyInstructionRequest =
  | {
      action: "proxy";
      method: "set";
      proxy: string;
    }
  | {
      action: "proxy";
      method: "unset";
    };

export type RecordInstructionRequest =
  | {
      action: "record";
      method: "start";
      tid: number;
      full_page?: boolean;
    }
  | {
      action: "record";
      method: "stop";
      tid: number;
    };

export interface BatchInstructionRequest {
  action: "batch";
  actions: InstructionRequest[];
}

export type InstructionRequest =
  | ClickInstructionRequest
  | CloseTabInstructionRequest
  | FocusTabInstructionRequest
  | JavaScriptInstructionRequest
  | KeyboardInstructionRequest
  | ListTabsInstructionRequest
  | NavigateTabInstructionRequest
  | ProxyInstructionRequest
  | RecordInstructionRequest
  | ReloadTabInstructionRequest
  | ScreenshotInstructionRequest
  | ScrollInstructionRequest;

export interface TabDetails {
  tid: number;
  window_id: number;
  active: boolean;
  title: string | null;
  url: string | null;
  domain: string | null;
}

export interface ListedTab extends TabDetails {
  focused: boolean;
}

export interface ClosedTab {
  closed: true;
  tab: TabDetails;
}

export interface ScrollResult {
  scrolled: true;
  y: number;
}

export interface ClickResult {
  clicked: true;
  selector: string;
  x: number;
  y: number;
}

export interface KeyboardTextResult {
  inserted_characters: number;
}

export interface KeyboardKeyResult {
  key: KeyboardKey;
  modifiers: KeyboardModifier[];
}

export interface ScreenshotUploadResult {
  data: string;
}

export interface RecordStartResult {
  started: true;
}

export type RecordingStopReason = "user" | "max_duration";

export type RecordingContentType = "video/mp4" | "video/webm";

export interface ProxySetResult {
  proxied: true;
  scheme: ProxyScheme;
  host: string;
  port: number;
  authenticated: boolean;
}

export interface ProxyUnsetResult {
  proxied: false;
}

export type ProxyResult = ProxySetResult | ProxyUnsetResult;

export interface RecordStopUploadResult {
  data: string;
  content_type: RecordingContentType;
  duration: number;
  stopped_reason: RecordingStopReason;
  message: string;
}

export interface ScreenshotResult {
  url: string;
  content_type: "image/png";
  full_page: boolean;
}

export interface RecordStopResult {
  url: string;
  content_type: RecordingContentType;
  duration: number;
  stopped_reason: RecordingStopReason;
  message: string;
}

export interface UnserializableJavaScriptResult {
  type: string;
  description: string | null;
}

export type JavaScriptResult = JsonValue | UnserializableJavaScriptResult;

export type InstructionResultFor<
  Request extends InstructionRequest | BatchInstructionRequest,
> = Request extends { action: "batch" }
    ? BatchResult
    : Request extends { action: "click" }
      ? ClickResult
      : Request extends { action: "javascript" }
        ? JavaScriptResult
        : Request extends { action: "keyboard"; text: string }
          ? KeyboardTextResult
          : Request extends { action: "keyboard"; key: KeyboardKey }
            ? KeyboardKeyResult
            : Request extends { action: "screenshot" }
              ? ScreenshotResult
              : Request extends { action: "record"; method: "start" }
                ? RecordStartResult
                : Request extends { action: "record"; method: "stop" }
                  ? RecordStopResult
                  : Request extends { action: "record" }
                    ? RecordStartResult | RecordStopResult
                    : Request extends { action: "proxy"; method: "set" }
                      ? ProxySetResult
                      : Request extends { action: "proxy"; method: "unset" }
                        ? ProxyUnsetResult
                        : Request extends { action: "proxy" }
                          ? ProxyResult
                          : Request extends { action: "list" }
                ? ListedTab[]
                : Request extends { action: "close" }
                  ? ClosedTab
                  : Request extends { action: "focus" | "navigate" | "reload" }
                    ? TabDetails
                    : Request extends { action: "scroll" }
                      ? ScrollResult
                      : never;

export type InstructionResult = InstructionResultFor<InstructionRequest>;

// A batch instruction's submitted and completed results are one entry per
// action, in order; an entry carries either a result or an error.
export type BatchResultEntry = InstructionResultRequest;
export type BatchResult = BatchResultEntry[];
export type BatchSubmissionResult = BatchResultEntry[];

export type ExtensionInstructionResult =
  | JsonValue
  | ListedTab[]
  | TabDetails
  | ClosedTab
  | ScrollResult
  | ClickResult
  | KeyboardTextResult
  | KeyboardKeyResult
  | ScreenshotUploadResult
  | RecordStartResult
  | RecordStopUploadResult
  | ProxySetResult
  | ProxyUnsetResult
  | UnserializableJavaScriptResult
  | BatchSubmissionResult;

export type InstructionResultRequest =
  | { result: ExtensionInstructionResult; error?: never }
  | { result?: null; error: string };

export interface GetConfigurationMessage {
  type: "getConfiguration";
}

export interface PollMessage {
  type: "poll";
}

export interface StartRecordingMessage {
  type: "startRecording";
  tid: number;
  fullPage: boolean;
  // Full-page recordings carry the measured content size so the sink can
  // size its canvas and bitrate before the first frame; viewport
  // recordings pass zero and derive both from the first frame.
  width: number;
  height: number;
  maxRecordingDurationSec: number;
  maxRecordingSizeMiB: number;
}

export interface RecordingFrameMessage {
  type: "recordingFrame";
  tid: number;
  data: string;
}

export interface RecordingChunkMessage {
  type: "recordingChunk";
  tid: number;
  data: string;
}

export interface FinalizeRecordingMessage {
  type: "finalizeRecording";
  tid: number;
  maxRecordingSizeMiB: number;
}

export interface SettingsUpdatedMessage {
  type: "settingsUpdated";
  pollIntervalMs: number;
}

export type RuntimeMessage =
  | GetConfigurationMessage
  | PollMessage
  | StartRecordingMessage
  | RecordingFrameMessage
  | RecordingChunkMessage
  | FinalizeRecordingMessage
  | SettingsUpdatedMessage;

export function isRuntimeMessage(value: unknown): value is RuntimeMessage {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const message = value as Record<string, unknown>;
  if (message.type === "getConfiguration" || message.type === "poll") {
    return true;
  }
  if (message.type === "settingsUpdated") {
    return typeof message.pollIntervalMs === "number";
  }
  if (message.type === "startRecording") {
    return (
      typeof message.tid === "number" &&
      typeof message.fullPage === "boolean" &&
      typeof message.width === "number" &&
      typeof message.height === "number" &&
      typeof message.maxRecordingDurationSec === "number" &&
      typeof message.maxRecordingSizeMiB === "number"
    );
  }
  if (message.type === "recordingFrame") {
    return (
      typeof message.tid === "number" && typeof message.data === "string"
    );
  }
  if (message.type === "recordingChunk") {
    return (
      typeof message.tid === "number" && typeof message.data === "string"
    );
  }
  return (
    message.type === "finalizeRecording" &&
    typeof message.tid === "number" &&
    typeof message.maxRecordingSizeMiB === "number"
  );
}

export interface ErrorResponse {
  error: string;
}

export type GetConfigurationResponse = Configuration | ErrorResponse;
export type PollResponse = { ok: true } | ErrorResponse;
export type StartRecordingResponse =
  | { ok: true; started: true }
  | ErrorResponse;
export interface FinalizeRecordingSuccess {
  ok: true;
  // The encoded video is delivered separately as recordingChunk messages
  // because a single runtime message is limited to ~64 MiB.
  contentType: RecordingContentType;
}
export type FinalizeRecordingResponse = FinalizeRecordingSuccess | ErrorResponse;
