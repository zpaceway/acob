import { execFileSync } from "node:child_process";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const extensionDirectory = path.dirname(fileURLToPath(import.meta.url));
const configuredOutput = process.env.ACOB_EXTENSION_OUTPUT_DIR;
const outputDirectory = configuredOutput
  ? path.resolve(extensionDirectory, configuredOutput)
  : path.join(extensionDirectory, "dist");
const proxyPort = process.env.ACOB_PROXY_PORT ?? "58346";
if (!/^\d+$/.test(proxyPort) || Number(proxyPort) < 1 || Number(proxyPort) > 65535) {
  throw new Error("ACOB_PROXY_PORT must be an integer from 1 to 65535");
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
  "manifest.json",
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
await mkdir(outputDirectory, { recursive: true });
if (proxyPort !== "58346") {
  const settingsPath = path.join(outputDirectory, "settings.js");
  const settingsSource = await readFile(settingsPath, "utf8");
  await writeFile(
    settingsPath,
    settingsSource.replaceAll("127.0.0.1:58346", `127.0.0.1:${proxyPort}`),
  );
}
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
