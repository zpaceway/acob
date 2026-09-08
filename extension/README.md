# ACOB Chromium Extension

This package contains the Manifest V3 extension that executes browser
instructions from an ACOB server. Runtime source is written in strict
TypeScript, and the popup is built with Tailwind CSS.

The extension requires Node.js 20 or newer for development and Chromium 116 or
newer at runtime. It polls the single global queue exposed by the
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
and `make build`. Unit tests cover settings, input command construction and
serialization, keyboard validation, and timeout cleanup; type-only contracts
are checked by TypeScript. Changes to the manifest,
service worker, offscreen polling, popup, Chrome APIs, or debugger behavior
require a manual unpacked-extension test against a running server.

For a complete isolated local installation, run this from the repository root:

```bash
make install PORT=58346 NAME=default
make install PORT=61554 NAME=alexandro
```

`PORT` defaults to `58346`, but `NAME` is required. The root installer uses
context and Compose project `acob-<port>-<name>` and builds a managed Chromium
image with this extension already loaded. Names allow lowercase letters, digits,
and internal hyphens and cannot start or end with a hyphen. Load `dist/` manually
only for native extension development.

The context prefixes Compose network, volume, container, and image resources
and is the default MCP registration name used by root `install-opencode` and
`install-claude`. Use the same `PORT` and `NAME` for lifecycle commands.
Different installations still require different ports because only one process
can bind a host port. Names label user or work contexts; they do not add
protocol routing or executor identity, and extensions sharing one stack still
consume its promiscuous queue.

## JavaScript Timeouts

Chromium's `Runtime.terminateExecution` is the hard execution stop. A timed-out
tab is then reloaded before the failure is reported, which stops asynchronous
work in the discarded page context without changing successful JavaScript
evaluation semantics.

## Browser Actions

Tab management actions are `list`, `navigate`, `focus`, `close`, and `reload`.
`focus` activates the tab and focuses its browser window. `reload` waits for the
target tab to finish loading. `scroll` leaves browser focus unchanged and dispatches
trusted wheel input at a visible scrollable surface by a finite `y` distance in
CSS pixels; positive values move down and negative values move up. It returns
the requested distance with a `scrolled` confirmation.

Instructions with a known target tab run in a per-tab queue. Work on different
tabs can still overlap, while reloads, navigation, input, screenshots, and
JavaScript on the same tab execute in claim order. Focus, click, keyboard, and
scroll also share a browser-global input queue so another tab cannot become
active between input targeting and dispatch. Click, keyboard, and scroll leave
focus unchanged and fail with a focus hint when their target tab is hidden; use
the separate `focus` action first when needed, or try `javascript` when browser
focus should remain unchanged.

## Batches

A `batch` instruction (`{actions: [...]}`, 1 to 20 complete instruction
requests, delivered by the server's `/api/instructions/batch/` route) executes
its actions strictly in order, one at a time, awaiting each before the next. Each
sub-action still routes through the per-tab execution queue, so a batch keeps
its order relative to other instructions on the same tab while other tabs run
concurrently. The batch completes with one result or error entry per action;
a failed action does not stop the rest of the batch. The worker holds a
keep-alive timer for the whole batch. Recordings are keyed by tab, so a
batch can start and stop recordings on different tabs; starting twice on the
same tab fails the second entry with a clear error.

## Recordings, Proxy, And Browser Settings

`record` with `method: start` (`{tid}`, optional `full_page`) starts a video
recording of the tab and completes immediately with `{started}`; the recording
continues in the background until `record` with `method: stop` (`{tid}`) for
the same tab or `maxRecordingDurationSec` (default 300 s, 5 minutes). Only one
recording per tab is allowed. `full_page: true`
records the whole scrollable content instead of the viewport: the worker
measures the content size up front and re-measures it each frame so growing
pages stay covered, and the sink sizes its canvas and bitrate accordingly. A
late stop delivers the maximum-duration video with
`stopped_reason: "max_duration"` and a message instead of failing. Recordings
are encoded in the offscreen document (MP4/H.264 when `MediaRecorder` supports
it, falling back to WebM/VP9, ~1 Mbps scaled up for
full-page frames, ~2-5 fps) from `Page.captureScreenshot` frames relayed by
the service worker, so the tab's window should be focused: an unfocused or
hidden tab fails the first capture with a focus hint. The worker shares one
refcounted debugger session per tab (`src/cdp.ts`), so a recording holding
its tab's debugger does not block `click`, `keyboard`, `screenshot`, `scroll`,
or `javascript` on that tab. Recordings do not survive extension reloads.

`console` with `method: start` (`{tid}`) installs a page shim under
`window.__acob__.consoleCapture` that mirrors `debug/log/info/warn/error`
(always calling through to the originals first) into
`{t, level, text}` entries bounded by `consoleTimeoutSec` (default 180 s)
and `consoleMaxSizeMiB` (default 2 MiB, exact UTF-8 accounting via
`TextEncoder`, first-N kept with `truncated: true`). `console` with
`method: capture` (`{tid}`) returns the full cumulative snapshot without
clearing, and `method: stop` (`{tid}`) returns the final snapshot, restores
the originals, and ends the session. Snapshots are delivered as base64 JSON
(`content_type: "application/json"` with `entries`, `size_bytes`,
`truncated`); one session per tab. Console capture runs worker-only via
`debugger`, so no new manifest permissions were needed.

The `proxy` action (`method: set` with `proxy: "http://host:port"`,
`https://...`, or `socks5://...` including optional `user:pass@` auth;
`method: unset`) controls the browser-wide egress proxy via
`chrome.proxy.settings` (`fixed_servers` + `singleProxy`, bypassing
localhost). It is global to the whole profile, not per-tab, and runs through
a dedicated proxy queue. Auth credentials live only in worker memory and are
supplied via `webRequest.onAuthRequired`; results are redacted
(`{proxied, scheme, host, port, authenticated}` for set, `{proxied: false}`
for unset) and never echo secrets. Requires the `proxy`, `webRequest`, and
`webRequestAuthProvider` permissions.

The `cleanup` action (no payload fields) clears all browser data except the
ACOB extension itself via a single `chrome.browsingData.remove` call
(`since: 0`; `unprotectedWeb` and `protectedWeb`, never extension origins;
cache, cacheStorage, cookies, downloads list, fileSystems, formData,
history, indexedDB, localStorage, and service workers). Saved passwords are
not cleared (Chrome provides no extension API for them). The extension
accepts it only when its `allowCleanup` setting ("Allow browser cleanup",
default `false`) is enabled in the popup, so remote callers cannot authorize
a wipe on their own; otherwise it fails with a hint to enable it. It also
fails while a recording is active or a reinstall is scheduled, holds a
keep-alive across the call, and returns `{cleaned: true}`. Requires the
`browsingData` permission. `chrome.storage` settings are untouched because
extension origins are excluded.

## Extension Recovery

The public `reinstall` operation calls
`POST /api/reinstall/`. While the command is pending the server claims no queue
work, so the next `/api/instructions/next/` poll returns a
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

The popup displays controls defined centrally in `src/settings.ts`. On first
installation, the built `settings.json` seeds extension-local storage after
every value is normalized through that settings module. Later starts and
extension updates use the stored configuration and do not reread the file.
`src/settings.defaults.ts` is the single source of default values. Every
`src/settings.ts` definition default is imported from it, so normalization,
the popup, and storage seeding all take their defaults from that file. Edit
the values there and rebuild; `build.ts` writes them into the bundled
`settings.json` (plus any `ACOB_BASE_URL` / `ACOB_EXTENSION_SETTINGS`
overrides).
Set `ACOB_BASE_URL` during `npm run build` to replace the bundled initial server
URL, or set `ACOB_EXTENSION_SETTINGS` to a JSON object that is merged over the
defaults (it wins over `ACOB_BASE_URL` when both set a value). The root
installation workflow builds the extension with
`http://acob-proxy` before passing `extension/dist/` into the browser image,
while an ordinary native build defaults to `http://127.0.0.1:58346`. To change
the managed browser's defaults without rebuilding its image, set
`ACOB_EXTENSION_SETTINGS` on the `acob-browser` container
instead; the entrypoint merges it over the bundled `settings.json` at startup.
That still only seeds fresh profiles: a persisted `browser-data` volume keeps
its stored configuration until it is purged.

The defaults include one-second polling, a batch size of four, up to eight
concurrent executions, and `allowCleanup: false`. The same settings module owns
validation and the remaining tab, timeout, screenshot, recording, console, and
retry limits. These settings remain local to the extension; the server, Python
client, and MCP service do not expose a settings endpoint or method.

All extensions connected to one server consume its same global queue. Use the
root `make install PORT=... NAME=...` workflow when separate local installations
are needed; `NAME` is required, and each managed browser belongs to its own
distinct-port stack. Run one extension per stack when deterministic queue
ownership matters.

## Permissions And Safety

The extension requests `browsingData`, `debugger`, `offscreen`, `proxy`,
`storage`, `tabs`, `webRequest`, and `webRequestAuthProvider`
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

The settings runtime uses the standard `URL` API. Import it only in environments
that provide that API. The package is ESM-only; CommonJS consumers must use
dynamic `import()`.

Run `npm run build` before using a repository checkout as a local file
dependency. Published tarballs run the build automatically through `prepack`.

See the [root README](../README.md) for the monorepo layout and
[`PLAN.md`](../PLAN.md) for product direction and future milestones.
