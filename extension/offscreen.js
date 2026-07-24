function requestInstruction() {
  chrome.runtime.sendMessage({ type: "poll" });
}

requestInstruction();
setInterval(requestInstruction, 1000);
