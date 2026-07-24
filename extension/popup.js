const DEFAULT_BASE_URL = "http://127.0.0.1:58347";

const form = document.querySelector("#settings-form");
const baseUrlInput = document.querySelector("#base-url");
const bidInput = document.querySelector("#bid");
const copyButton = document.querySelector("#copy-bid");
const rotateButton = document.querySelector("#rotate-bid");
const status = document.querySelector("#status");

function generateBrowserId() {
  return crypto.randomUUID().replaceAll("-", "");
}

function showStatus(message) {
  status.textContent = message;
  window.setTimeout(() => {
    if (status.textContent === message) {
      status.textContent = "";
    }
  }, 2500);
}

async function loadConfiguration() {
  const configuration = await chrome.runtime.sendMessage({
    type: "getConfiguration",
  });
  if (configuration.error) {
    throw new Error(configuration.error);
  }

  baseUrlInput.value = configuration.baseUrl || DEFAULT_BASE_URL;
  bidInput.value = configuration.bid;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const baseUrl = baseUrlInput.value.trim().replace(/\/+$/, "");

  if (!baseUrlInput.checkValidity()) {
    baseUrlInput.reportValidity();
    return;
  }

  await chrome.storage.local.set({ baseUrl });
  baseUrlInput.value = baseUrl;
  showStatus("Server URL saved");
});

copyButton.addEventListener("click", async () => {
  await navigator.clipboard.writeText(bidInput.value);
  showStatus("Browser ID copied");
});

rotateButton.addEventListener("click", async () => {
  const bid = generateBrowserId();
  await chrome.storage.local.set({ bid });
  bidInput.value = bid;
  showStatus("Browser ID rotated");
});

loadConfiguration().catch((error) => {
  status.textContent = error instanceof Error ? error.message : String(error);
});
