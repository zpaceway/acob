import { state } from "./state.js";
import { withTimeout } from "./timeouts.js";
import type { CleanupResult, Configuration } from "./types.js";

const CLEANUP_TIMEOUT_MS = 60_000;

export async function executeCleanup(
  configuration: Configuration,
): Promise<CleanupResult> {
  if (state.reinstallScheduled) {
    throw new Error("Extension reinstall is in progress");
  }
  if (configuration.allowCleanup !== true) {
    throw new Error(
      "Browser cleanup is disabled; enable it in the ACOB extension popup",
    );
  }
  if (state.recordings.size > 0) {
    throw new Error(
      "Cannot clean up while a recording is active; stop it first",
    );
  }
  const keepAlive = setInterval(() => undefined, 20_000);
  try {
    await withTimeout(
      chrome.browsingData.remove(
        {
          since: 0,
          originTypes: {
            unprotectedWeb: true,
            protectedWeb: true,
            extension: false,
          },
        },
        {
          cache: true,
          cacheStorage: true,
          cookies: true,
          downloads: true,
          fileSystems: true,
          formData: true,
          history: true,
          indexedDB: true,
          localStorage: true,
          serviceWorkers: true,
        },
      ),
      CLEANUP_TIMEOUT_MS,
      "Timed out clearing browser data",
    );
  } catch (error) {
    throw new Error(
      `Could not clear browser data: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    clearInterval(keepAlive);
  }
  return { cleaned: true };
}
