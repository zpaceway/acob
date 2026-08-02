import { ACOBSettings } from "./settings.js";
import type { Configuration } from "./types.js";

export async function loadConfiguration(): Promise<Configuration> {
  const stored = await chrome.storage.local.get<
    Partial<Record<keyof Configuration, unknown>>
  >([...ACOBSettings.storageKeys]);
  const configuration = ACOBSettings.normalizeConfiguration(stored);
  if (
    ACOBSettings.storageKeys.some(
      (name) => stored[name] !== configuration[name],
    )
  ) {
    await chrome.storage.local.set(configuration);
  }
  return configuration;
}
