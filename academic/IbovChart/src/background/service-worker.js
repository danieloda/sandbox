// Runs when the extension is installed or updated
chrome.runtime.onInstalled.addListener(() => {
  console.log("B3 Ibovespa Extension installed.");
  chrome.storage.local.set({ ibov_installed_at: Date.now() });
});

// Listens for messages (e.g. from popup)
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "CHECK_IBOV") {
    sendResponse({ ok: true, checkedAt: new Date().toISOString() });
  }
});
