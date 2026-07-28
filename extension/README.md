# ACOB Chromium Extension

This package contains the Manifest V3 extension that executes browser
instructions from an ACOB server. Runtime source is written in strict
TypeScript, and the popup is built with Tailwind CSS.

The extension requires Node.js 20 or newer for development and Chromium 116 or
newer at runtime. It polls the browser-specific queue exposed by the
[Django server](../srv/README.md), executes claimed work through Chrome APIs
and the Chromium DevTools Protocol, and posts each result back to the server.

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
and TypeScript declaration files. Do not edit `dist/` directly.

The same tasks are available as `make install`, `make typecheck`, `make test`,
and `make build`. Unit tests cover settings and keyboard validation; type-only
contracts are checked by TypeScript. Changes to the manifest, service worker,
offscreen polling, popup, Chrome APIs, or debugger behavior still require a
manual unpacked-extension test against a running server.

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
[`docs/SKILL.md`](../docs/SKILL.md) for agent usage.
