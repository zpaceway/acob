import { execFileSync } from "node:child_process";
import { copyFile, mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const extensionDirectory = path.dirname(fileURLToPath(import.meta.url));
const outputDirectory = path.join(extensionDirectory, "dist");
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

await rm(outputDirectory, { recursive: true, force: true });
execFileSync(
  process.execPath,
  [
    packageExecutable("typescript", "bin/tsc"),
    "--project",
    "tsconfig.build.json",
  ],
  { cwd: extensionDirectory, stdio: "inherit" },
);
await mkdir(outputDirectory, { recursive: true });
await Promise.all(
  assets.map((asset) =>
    copyFile(
      path.join(extensionDirectory, asset),
      path.join(outputDirectory, asset),
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
    "dist/popup.css",
    "--minify",
  ],
  { cwd: extensionDirectory, stdio: "inherit" },
);
