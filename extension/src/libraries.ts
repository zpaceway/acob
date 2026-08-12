async function loadPageLibrarySource(
  fileName: string,
  libraryName: string,
): Promise<string> {
  const response = await fetch(chrome.runtime.getURL(fileName));
  if (!response.ok) {
    throw new Error(`Could not load ${libraryName}: HTTP ${response.status}`);
  }
  const source = await response.text();
  if (!source.trim()) {
    throw new Error(`Could not load ${libraryName}: extension asset is empty`);
  }
  return source;
}

let pageLibrariesScriptPromise: Promise<string> | null = null;

export function loadPageLibrariesScript(): Promise<string> {
  if (!pageLibrariesScriptPromise) {
    pageLibrariesScriptPromise = Promise.all([
      loadPageLibrarySource("jquery.min.js", "jQuery"),
      loadPageLibrarySource("turndown.js", "Turndown"),
    ])
      .then(
        ([jquerySource, turndownSource]) =>
          `(function (module, exports, define) {
const existing = Object.getOwnPropertyDescriptor(window, "__acob__");
if (
  existing &&
  "value" in existing &&
  existing.configurable === false &&
  existing.writable === false &&
  typeof existing.value === "object" &&
  existing.value !== null &&
  Object.isFrozen(existing.value) &&
  existing.value.$ === existing.value.jQuery &&
  typeof existing.value.jQuery === "function" &&
  typeof existing.value.TurndownService === "function"
) {
  window.jQuery = window.$ = existing.value.jQuery;
  window.TurndownService = existing.value.TurndownService;
  return;
}
if (existing && existing.configurable === false) {
  throw new Error("window.__acob__ already exists and cannot be replaced");
}
${jquerySource}
${turndownSource}
window.TurndownService = TurndownService;
const namespace = Object.freeze({
  $: window.jQuery,
  jQuery: window.jQuery,
  TurndownService,
});
Object.defineProperty(window, "__acob__", {
  configurable: false,
  enumerable: false,
  value: namespace,
  writable: false,
});
}).call(window, undefined, undefined, undefined);
//# sourceURL=${chrome.runtime.getURL("acob-page-libraries.js")}`,
      )
      .catch((error) => {
        pageLibrariesScriptPromise = null;
        throw error;
      });
  }
  return pageLibrariesScriptPromise;
}
