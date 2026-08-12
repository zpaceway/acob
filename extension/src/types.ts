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
  | "click"
  | "close"
  | "focus"
  | "javascript"
  | "keyboard"
  | "list"
  | "navigate"
  | "record_start"
  | "record_stop"
  | "reload"
  | "screenshot"
  | "scroll";
export type InstructionStatus =
  | "pending"
  | "processing"
  | "completed"
  | "failed";
export type KeyboardModifier = "alt" | "ctrl" | "meta" | "shift";
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

export interface RecordStartPayload {
  tid: number;
  full_page?: boolean;
}

export interface RecordStopPayload {
  recording_id: number;
}

export interface InstructionPayloadMap {
  click: ClickPayload;
  close: CloseTabPayload;
  focus: FocusTabPayload;
  javascript: JavaScriptPayload;
  keyboard: KeyboardPayload;
  list: ListTabsPayload;
  navigate: NavigateTabPayload;
  record_start: RecordStartPayload;
  record_stop: RecordStopPayload;
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

export interface RecordStartInstructionRequest {
  action: "record_start";
  tid: number;
  full_page?: boolean;
}

export interface RecordStopInstructionRequest {
  action: "record_stop";
  recording_id: number;
}

export type InstructionRequest =
  | ClickInstructionRequest
  | CloseTabInstructionRequest
  | FocusTabInstructionRequest
  | JavaScriptInstructionRequest
  | KeyboardInstructionRequest
  | ListTabsInstructionRequest
  | NavigateTabInstructionRequest
  | RecordStartInstructionRequest
  | RecordStopInstructionRequest
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
  recording_id: number;
  started: true;
}

export type RecordingStopReason = "user" | "max_duration";

export type RecordingContentType = "video/mp4" | "video/webm";

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

export type InstructionResultFor<Request extends InstructionRequest> =
  Request extends { action: "click" }
    ? ClickResult
    : Request extends { action: "javascript" }
      ? JavaScriptResult
      : Request extends { action: "keyboard"; text: string }
        ? KeyboardTextResult
        : Request extends { action: "keyboard"; key: KeyboardKey }
          ? KeyboardKeyResult
          : Request extends { action: "screenshot" }
            ? ScreenshotResult
            : Request extends { action: "record_start" }
              ? RecordStartResult
              : Request extends { action: "record_stop" }
                ? RecordStopResult
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
  | UnserializableJavaScriptResult;

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
  recordingId: number;
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
  recordingId: number;
  data: string;
}

export interface RecordingChunkMessage {
  type: "recordingChunk";
  recordingId: number;
  data: string;
}

export interface FinalizeRecordingMessage {
  type: "finalizeRecording";
  recordingId: number;
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
      typeof message.recordingId === "number" &&
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
      typeof message.recordingId === "number" &&
      typeof message.data === "string"
    );
  }
  if (message.type === "recordingChunk") {
    return (
      typeof message.recordingId === "number" &&
      typeof message.data === "string"
    );
  }
  return (
    message.type === "finalizeRecording" &&
    typeof message.recordingId === "number" &&
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
