import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
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

const require = createRequire(import.meta.url);
const extensionDirectory = path.dirname(fileURLToPath(import.meta.url));
const configuredOutput = process.env.ACOB_EXTENSION_OUTPUT_DIR;
const outputDirectory = configuredOutput
  ? path.resolve(extensionDirectory, configuredOutput)
  : path.join(extensionDirectory, "dist");
const configuredBaseUrl = process.env.ACOB_BASE_URL;
if (configuredBaseUrl) {
  const baseUrl = new URL(configuredBaseUrl);
  if (
    (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") ||
    baseUrl.search ||
    baseUrl.hash
  ) {
    throw new Error(
      "ACOB_BASE_URL must be an HTTP(S) URL without a query or fragment",
    );
  }
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
  "settings.example.json",
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
const localSettingsPath = path.join(extensionDirectory, "settings.json");
const settingsPath = existsSync(localSettingsPath)
  ? localSettingsPath
  : path.join(extensionDirectory, "settings.example.json");
const bundledSettings = JSON.parse(
  await readFile(settingsPath, "utf8"),
) as Record<string, unknown>;
if (configuredBaseUrl) {
  bundledSettings.baseUrl = configuredBaseUrl.replace(/\/+$/, "");
}
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
