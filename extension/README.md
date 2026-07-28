# ACOB Chromium Extension

This package contains the Manifest V3 extension that executes browser
instructions from an ACOB server. Runtime source is written in strict
TypeScript, and the popup is built with Tailwind CSS.

## Development

```bash
npm ci
npm run typecheck
npm test
npm run build
```

Load `dist/` as an unpacked extension in Chromium 116 or newer. The build emits
the service worker, popup and offscreen modules, extension assets, source maps,
and TypeScript declaration files. Do not edit `dist/` directly.

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
