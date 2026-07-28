let pollIntervalMs = ACOBSettings.definitions.pollIntervalMs.defaultValue;
let pollTimeoutId = null;

function schedulePoll() {
  clearTimeout(pollTimeoutId);
  pollTimeoutId = setTimeout(requestInstructions, pollIntervalMs);
}

async function requestInstructions() {
  try {
    const configuration = await chrome.runtime.sendMessage({
      type: "getConfiguration",
    });
    if (configuration.error) {
      throw new Error(configuration.error);
    }
    pollIntervalMs = configuration.pollIntervalMs;
  } catch (error) {
    console.error(error);
  }
  chrome.runtime.sendMessage({ type: "poll" }).catch(console.error);
  schedulePoll();
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "settingsUpdated") {
    pollIntervalMs = ACOBSettings.normalizeSetting(
      "pollIntervalMs",
      message.pollIntervalMs,
    );
    schedulePoll();
  }
});

requestInstructions();
