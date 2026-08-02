import { ACOBSettings } from "../src/settings.js";
import { keyboardCharacter } from "../src/types.js";
import type {
  ClosedTab,
  Configuration,
  InstructionRequest,
  InstructionResultFor,
  ListedTab,
  ScrollResult,
  SettingName,
  SupportedInstruction,
  TabDetails,
} from "../src/types.js";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends (<Value>() =>
    Value extends Right ? 1 : 2)
    ? true
    : false;
type Expect<Value extends true> = Value;
type ListTabsResultIsTyped = Expect<
  Equal<InstructionResultFor<{ action: "list" }>, ListedTab[]>
>;
type CloseTabResultIsTyped = Expect<
  Equal<
    InstructionResultFor<{
      action: "close";
      tid: number;
    }>,
    ClosedTab
  >
>;
type ReloadTabResultIsTyped = Expect<
  Equal<
    InstructionResultFor<{ action: "reload"; tid: number }>,
    TabDetails
  >
>;
type ScrollResultIsTyped = Expect<
  Equal<
    InstructionResultFor<{ action: "scroll"; tid: number; y: number }>,
    ScrollResult
  >
>;

const configuration: Configuration = ACOBSettings.normalizeConfiguration({
  baseUrl: "https://acob.example",
  instructionsPerPoll: 8,
});
const settingName: SettingName = ACOBSettings.settingNames[0]!;
const pollInterval: number = ACOBSettings.normalizeSetting(
  "pollIntervalMs",
  "invalid",
);
const baseUrl: string = ACOBSettings.normalizeSetting(
  "baseUrl",
  "https://acob.example/",
);

declare const instruction: SupportedInstruction;
if (instruction.action === "click") {
  const selector: string = instruction.payload.selector;
  void selector;
}

const request: InstructionRequest = {
  action: "keyboard",
  tid: 1,
  key: "Enter",
  modifiers: ["ctrl"],
};
const textRequest: InstructionRequest = {
  action: "keyboard",
  tid: 1,
  text: "ACOB",
  modifiers: [],
};
const characterRequest: InstructionRequest = {
  action: "keyboard",
  tid: 1,
  key: keyboardCharacter("a"),
};

// @ts-expect-error Settings metadata is immutable.
ACOBSettings.definitions.baseUrl.defaultValue = "https://other.example";
const invalidRequest: InstructionRequest = {
  action: "list",
  // @ts-expect-error A list request must not target a tab.
  tid: 1,
};
// @ts-expect-error The grouped tabs action was removed.
const legacyTabsRequest: InstructionRequest = { action: "tabs", operation: "list" };
const invalidKeyRequest: InstructionRequest = {
  action: "keyboard",
  tid: 1,
  // @ts-expect-error Multi-character keys must be supported named keys.
  key: "Return",
};

void configuration;
void settingName;
void pollInterval;
void baseUrl;
void request;
void textRequest;
void characterRequest;
void invalidRequest;
void legacyTabsRequest;
void invalidKeyRequest;
const listTabsResultIsTyped: ListTabsResultIsTyped = true;
void listTabsResultIsTyped;
const closeTabResultIsTyped: CloseTabResultIsTyped = true;
void closeTabResultIsTyped;
const reloadTabResultIsTyped: ReloadTabResultIsTyped = true;
void reloadTabResultIsTyped;
const scrollResultIsTyped: ScrollResultIsTyped = true;
void scrollResultIsTyped;
