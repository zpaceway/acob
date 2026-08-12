# ACOB Chromium Extension

This package contains the Manifest V3 extension that executes browser
instructions from an ACOB server. Runtime source is written in strict
TypeScript, and the popup is built with Tailwind CSS.

The extension requires Node.js 20 or newer for development and Chromium 116 or
newer at runtime. It polls the browser-specific queue exposed by the
[Django server](../srv/README.md), executes claimed work through Chrome APIs
and the Chromium DevTools Protocol, and posts each result back to the server.
Before each JavaScript instruction, it exposes bundled jQuery and Turndown in a
frozen `window.__acob__` namespace. Conventional `window.$`, `window.jQuery`,
and `window.TurndownService` globals are also available.

## Development

From this directory:

```bash
npm ci
npm run typecheck
npm test
npm run build
```

Load `dist/` as an unpacked extension in Chromium 116 or newer. The build emits
the service worker, popup and offscreen modules, extension assets, source maps,
TypeScript declaration files, the jQuery and Turndown browser distributions,
and their licenses. Do not edit `dist/` directly.

The same tasks are available as `make install`, `make typecheck`, `make test`,
and `make build`. Unit tests cover settings, keyboard validation, and timeout
cleanup; type-only contracts are checked by TypeScript. Changes to the manifest,
service worker, offscreen polling, popup, Chrome APIs, or debugger behavior
require a manual unpacked-extension test against a running server.

## JavaScript Timeouts

Chromium's `Runtime.terminateExecution` is the hard execution stop. A timed-out
tab is then reloaded before the failure is reported, which stops asynchronous
work in the discarded page context without changing successful JavaScript
evaluation semantics.

## Browser Actions

Tab management actions are `list`, `navigate`, `focus`, `close`, and `reload`.
`reload` waits for the target tab to finish loading. `scroll` moves a target tab
vertically by a finite `y` distance in CSS pixels; positive values move down and
negative values move up. It returns the requested distance with a `scrolled`
confirmation.

Instructions with a known target tab run in a per-tab queue. Work on different
tabs can still overlap, while reloads, navigation, input, screenshots, and
JavaScript on the same tab execute in claim order.

## Recordings And Browser Settings

`record_start` (`{tid}`) starts a video recording of the tab's viewport and
completes immediately with `{recording_id, started}`; the recording continues
in the background until `record_stop` (`{recording_id}`) or
`maxRecordingDurationMs` (default 300000 ms, 5 minutes). A late `record_stop`
delivers the maximum-duration video with `stopped_reason: "max_duration"` and
a message instead of failing. Recordings are encoded in the offscreen document
(WebM/VP9, ~1 Mbps, ~2-5 fps) from `Page.captureScreenshot` frames relayed by
the service worker, so the tab's window should be focused: an unfocused or
hidden tab fails the first capture with a focus hint. A recording holds the
tab's debugger for its whole lifetime and does not survive extension reloads.

The extension reports its normalized configuration to the server's heartbeat
route from the poll loop (throttled to 30 s, immediate on setting changes) so
controllers can read the browser's configured limits before acting.

## Extension Recovery

The public `reinstall` operation calls
`POST /api/browsers/<bid>/reinstall/`. While the command is pending the
server claims no queue work, so the next `instructions/next/` poll returns a
`reinstall` command instead. The service worker persists its token, stops
active JavaScript, reloads affected tabs, and calls `chrome.runtime.reload()`.
Its next instance acknowledges the token and resumes polling. Because the
extension is unpacked, this restart also reads the latest files already built
into `dist/`. The service worker polls only the instruction route; the
`reload` action targets one tab through the instruction queue.

The service worker creates the offscreen polling document at startup, and that
document schedules subsequent polls. A disabled extension or a terminated
Chromium process requires an external browser supervisor or user action.

## Runtime Configuration

The popup displays the generated browser ID and controls defined centrally in
`src/settings.ts`. Defaults include the local server at
`http://127.0.0.1:58347`, one-second polling, a batch size of four, and up to
eight concurrent executions. The same settings module owns validation and the
remaining tab, timeout, screenshot, and retry limits.

Each installation uses a lowercase dashless UUIDv4 as its browser ID. The ID
selects a queue; it is not an authentication secret. Rotating it moves the
extension to a new queue and leaves work under the previous ID unclaimed.

## Permissions And Safety

The extension requests `debugger`, `offscreen`, `storage`, and `tabs`
permissions plus host access to all URLs. These capabilities are necessary for
real browser input, JavaScript evaluation, screenshots, and polling, but they
also grant broad access to the active browser profile. Use a dedicated profile
without unrelated sensitive sessions and do not connect it to an untrusted
server. See the repository [security policy](../SECURITY.md).

The frozen `window.__acob__` namespace protects library references from
accidental reassignment and name collisions. It is not an isolation boundary;
the libraries intentionally run in, and are accessible to, the page's main
JavaScript world.

## Typed API

The package entry point exports the immutable settings API and all shared
protocol contracts:

```typescript
import {
  ACOBSettings,
  keyboardCharacter,
  type Configuration,
  type Instruction,
  type InstructionRequest,
  type SettingName,
} from "@zpaceway/acob-extension";

const name: SettingName = "pollIntervalMs";
const pollInterval = ACOBSettings.normalizeSetting(name, 500);
const configuration: Configuration = ACOBSettings.normalizeConfiguration({
  baseUrl: "https://acob.example/",
  pollIntervalMs: pollInterval,
});

const request: InstructionRequest = {
  action: "keyboard",
  tid: 1,
  key: "Enter",
  modifiers: ["ctrl"],
};

const characterRequest: InstructionRequest = {
  action: "keyboard",
  tid: 1,
  key: keyboardCharacter("a"),
};
```

`ACOBSettings.normalizeSetting()` preserves the value type associated with its
setting name. Settings metadata and name arrays are exposed as readonly values.
Instruction requests are discriminated unions, so invalid action and payload
combinations fail during type checking.

Named keyboard keys can be used directly. Wrap a single Unicode character with
`keyboardCharacter()` so unsupported multi-character key names are rejected at
both compile time and runtime.

The settings runtime uses standard `crypto.randomUUID()` and `URL` APIs. Import
it only in environments that provide those APIs. The package is ESM-only;
CommonJS consumers must use dynamic `import()`.

Run `npm run build` before using a repository checkout as a local file
dependency. Published tarballs run the build automatically through `prepack`.

See the [root README](../README.md) for the monorepo layout and
[`PLAN.md`](../PLAN.md) for product direction and future milestones.
