import { ACOBSettings } from "./settings.js";
import type { Configuration } from "./types.js";

export async function loadConfiguration(): Promise<Configuration> {
  const stored = await chrome.storage.local.get<
    Partial<Record<keyof Configuration, unknown>>
  >([...ACOBSettings.storageKeys]);
  const hasStoredConfiguration = ACOBSettings.storageKeys.some((name) =>
    Object.hasOwn(stored, name),
  );
  let values: Readonly<Partial<Record<keyof Configuration, unknown>>> = stored;
  if (!hasStoredConfiguration) {
    const response = await fetch(chrome.runtime.getURL("settings.json"));
    if (!response.ok) {
      throw new Error(`Could not load initial settings: HTTP ${response.status}`);
    }
    const bundled: unknown = await response.json();
    if (
      typeof bundled !== "object" ||
      bundled === null ||
      Array.isArray(bundled)
    ) {
      throw new Error("Bundled settings must be a JSON object");
    }
    values = bundled as Partial<Record<keyof Configuration, unknown>>;
  }

  const configuration = ACOBSettings.normalizeConfiguration(values);
  if (
    !hasStoredConfiguration ||
    ACOBSettings.storageKeys.some(
      (name) => stored[name] !== configuration[name],
    )
  ) {
    await chrome.storage.local.set(configuration);
  }
  return configuration;
}
