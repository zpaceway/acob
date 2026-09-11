import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ACOBSettings } from "./src/settings.js";

const require = createRequire(import.meta.url);
const extensionDirectory = path.dirname(fileURLToPath(import.meta.url));
const configuredOutput = process.env.ACOB_EXTENSION_OUTPUT_DIR;
const outputDirectory = configuredOutput
  ? path.resolve(extensionDirectory, configuredOutput)
  : path.join(extensionDirectory, "dist");
const configuredSettingsJson = process.env.ACOB_EXTENSION_SETTINGS;
let configuredSettingsOverride: Record<string, unknown> | undefined;
if (configuredSettingsJson) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(configuredSettingsJson);
  } catch {
    throw new Error("ACOB_EXTENSION_SETTINGS must be a JSON object");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed)
  ) {
    throw new Error("ACOB_EXTENSION_SETTINGS must be a JSON object");
  }
  configuredSettingsOverride = parsed as Record<string, unknown>;
}
function readStringSettingEnv(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return undefined;
  }
  return raw;
}
function readBooleanSettingEnv(name: string): boolean | undefined {
  const raw = readStringSettingEnv(name);
  if (raw === undefined) {
    return undefined;
  }
  if (raw === "true") {
    return true;
  }
  if (raw === "false") {
    return false;
  }
  throw new Error(`${name} must be true or false`);
}
function readIntegerSettingEnv(name: string): number | undefined {
  const raw = readStringSettingEnv(name);
  if (raw === undefined) {
    return undefined;
  }
  const trimmed = raw.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    throw new Error(`${name} must be an integer`);
  }
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${name} must be an integer`);
  }
  return value;
}
// Per-setting overrides. Each ACOB_EXTENSION_<SETTING> wins over the
// ACOB_EXTENSION_SETTINGS JSON object. Empty means unset.
const extensionEnvOverride: Record<string, unknown> = {};
function applyStringEnv(envName: string, settingKey: string): void {
  const value = readStringSettingEnv(envName);
  if (value !== undefined) {
    extensionEnvOverride[settingKey] = value;
  }
}
function applyBooleanEnv(envName: string, settingKey: string): void {
  const value = readBooleanSettingEnv(envName);
  if (value !== undefined) {
    extensionEnvOverride[settingKey] = value;
  }
}
function applyIntegerEnv(envName: string, settingKey: string): void {
  const value = readIntegerSettingEnv(envName);
  if (value !== undefined) {
    extensionEnvOverride[settingKey] = value;
  }
}
applyStringEnv("ACOB_EXTENSION_BASE_URL", "baseUrl");
applyBooleanEnv("ACOB_EXTENSION_ALLOW_CLEANUP", "allowCleanup");
applyIntegerEnv(
  "ACOB_EXTENSION_INSTRUCTIONS_PER_POLL",
  "instructionsPerPoll",
);
applyIntegerEnv(
  "ACOB_EXTENSION_MAX_CONCURRENT_EXECUTIONS",
  "maxConcurrentExecutions",
);
applyIntegerEnv("ACOB_EXTENSION_MAX_TABS", "maxTabs");
applyIntegerEnv("ACOB_EXTENSION_POLL_INTERVAL_MS", "pollIntervalMs");
applyIntegerEnv("ACOB_EXTENSION_TAB_LOAD_TIMEOUT_MS", "tabLoadTimeoutMs");
applyIntegerEnv(
  "ACOB_EXTENSION_HTTP_REQUEST_TIMEOUT_MS",
  "httpRequestTimeoutMs",
);
applyIntegerEnv("ACOB_EXTENSION_JAVASCRIPT_TIMEOUT_MS", "javascriptTimeoutMs");
applyIntegerEnv(
  "ACOB_EXTENSION_MAX_SCREENSHOT_SIZE_MIB",
  "maxScreenshotSizeMiB",
);
applyIntegerEnv(
  "ACOB_EXTENSION_MAX_RECORDING_DURATION_SEC",
  "maxRecordingDurationSec",
);
applyIntegerEnv(
  "ACOB_EXTENSION_MAX_RECORDING_SIZE_MIB",
  "maxRecordingSizeMiB",
);
applyIntegerEnv("ACOB_EXTENSION_CONSOLE_TIMEOUT_SEC", "consoleTimeoutSec");
applyIntegerEnv("ACOB_EXTENSION_CONSOLE_MAX_SIZE_MIB", "consoleMaxSizeMiB");
applyIntegerEnv("ACOB_EXTENSION_RESULT_RETRY_ATTEMPTS", "resultRetryAttempts");
applyIntegerEnv("ACOB_EXTENSION_RESULT_RETRY_DELAY_MS", "resultRetryDelayMs");
applyIntegerEnv(
  "ACOB_EXTENSION_POPUP_STATUS_DURATION_MS",
  "popupStatusDurationMs",
);
applyStringEnv(
  "ACOB_EXTENSION_DEBUGGER_PROTOCOL_VERSION",
  "debuggerProtocolVersion",
);
if (typeof extensionEnvOverride.baseUrl === "string") {
  const rawBaseUrl = extensionEnvOverride.baseUrl;
  let parsedBaseUrl: URL;
  try {
    parsedBaseUrl = new URL(rawBaseUrl);
  } catch {
    throw new Error(
      "ACOB_EXTENSION_BASE_URL must be an HTTP(S) URL without a query or fragment",
    );
  }
  if (
    (parsedBaseUrl.protocol !== "http:" &&
      parsedBaseUrl.protocol !== "https:") ||
    parsedBaseUrl.search ||
    parsedBaseUrl.hash
  ) {
    throw new Error(
      "ACOB_EXTENSION_BASE_URL must be an HTTP(S) URL without a query or fragment",
    );
  }
  extensionEnvOverride.baseUrl = rawBaseUrl.replace(/\/+$/, "");
}
const packageExecutable = (
  packageName: string,
  executablePath: string,
): string =>
  path.join(
    path.dirname(require.resolve(`${packageName}/package.json`)),
    executablePath,
  );
const assets = [
  "icon-16.png",
  "icon-32.png",
  "icon-48.png",
  "icon-128.png",
  "offscreen.html",
  "popup.html",
];
const jqueryDistDirectory = path.dirname(require.resolve("jquery"));
const turndownDirectory = path.dirname(
  require.resolve("turndown/package.json"),
);

await rm(outputDirectory, { recursive: true, force: true });
execFileSync(
  process.execPath,
  [
    packageExecutable("typescript", "bin/tsc"),
    "--project",
    "tsconfig.build.json",
    "--outDir",
    outputDirectory,
  ],
  { cwd: extensionDirectory, stdio: "inherit" },
);
const workerHash = createHash("sha256");
const emittedJavaScript = (await readdir(outputDirectory, { recursive: true }))
  .filter((file) => file.endsWith(".js"))
  .sort();
for (const file of emittedJavaScript) {
  workerHash.update(file);
  workerHash.update(await readFile(path.join(outputDirectory, file)));
}
const backgroundPath = path.join(outputDirectory, "background.js");
const backgroundFilename = `background-${workerHash.digest("hex")}.js`;
await rename(
  backgroundPath,
  path.join(outputDirectory, backgroundFilename),
);
await mkdir(outputDirectory, { recursive: true });
// The bundled first-install settings come from the settings module, whose
// defaults live in src/settings.defaults.ts.
const bundledSettings: Record<string, unknown> = {
  ...ACOBSettings.normalizeConfiguration(),
};
if (configuredSettingsOverride) {
  Object.assign(bundledSettings, configuredSettingsOverride);
}
Object.assign(bundledSettings, extensionEnvOverride);
const manifest = JSON.parse(
  await readFile(path.join(extensionDirectory, "manifest.json"), "utf8"),
) as { background: { service_worker: string } };
manifest.background.service_worker = backgroundFilename;
await writeFile(
  path.join(outputDirectory, "manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
await writeFile(
  path.join(outputDirectory, "settings.json"),
  `${JSON.stringify(bundledSettings, null, 2)}\n`,
);
await Promise.all(
  [
    ...assets.map((asset) => ({
      source: path.join(extensionDirectory, asset),
      destination: asset,
    })),
    {
      source: path.join(jqueryDistDirectory, "jquery.min.js"),
      destination: "jquery.min.js",
    },
    {
      source: path.join(jqueryDistDirectory, "../LICENSE.txt"),
      destination: "jquery.LICENSE.txt",
    },
    {
      source: path.join(turndownDirectory, "dist/turndown.js"),
      destination: "turndown.js",
    },
    {
      source: path.join(turndownDirectory, "LICENSE"),
      destination: "turndown.LICENSE.txt",
    },
  ].map(({ source, destination }) =>
    copyFile(
      source,
      path.join(outputDirectory, destination),
    ),
  ),
);
execFileSync(
  process.execPath,
  [
    packageExecutable("@tailwindcss/cli", "dist/index.mjs"),
    "-i",
    "src/popup.css",
    "-o",
    path.join(outputDirectory, "popup.css"),
    "--minify",
  ],
  { cwd: extensionDirectory, stdio: "inherit" },
);
