let mheTabId = null;
let aiTabId = null;
let aiType = null;
let lastActiveTabId = null;
let processingQuestion = false;
let mheWindowId = null;
let aiWindowId = null;

const AI_CONTENT_SCRIPT_FILES = {
  chatgpt: "content-scripts/chatgpt.js",
  gemini: "content-scripts/gemini.js",
  deepseek: "content-scripts/deepseek.js",
};

const DEEPSEEK_URL_PATTERNS = [
  "https://chat.deepseek.com/*",
  "https://deepseek.chat/*",
];

function isDeepSeekTabUrl(url = "") {
  return url.includes("chat.deepseek.com") || url.includes("deepseek.chat");
}

chrome.tabs.onActivated.addListener((activeInfo) => {
  lastActiveTabId = activeInfo.tabId;
});

function sendMessageWithRetry(tabId, message, maxAttempts = 3, delay = 1000) {
  return new Promise((resolve, reject) => {
    let attempts = 0;

    function attemptSend() {
      attempts++;
      chrome.tabs.sendMessage(tabId, message, (response) => {
        if (chrome.runtime.lastError) {
          if (attempts < maxAttempts) {
            setTimeout(attemptSend, delay);
          } else {
            reject(chrome.runtime.lastError);
          }
        } else {
          resolve(response);
        }
      });
    }

    attemptSend();
  });
}

function getErrorMessage(error) {
  return error?.message || String(error || "");
}

function isMissingReceiverError(error) {
  const message = getErrorMessage(error);
  return (
    message.includes("Receiving end does not exist") ||
    message.includes("Could not establish connection")
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pickPreferredTab(tabs, preferredHosts = []) {
  if (!tabs?.length) {
    return null;
  }

  if (aiTabId) {
    const existingTab = tabs.find((tab) => tab.id === aiTabId);
    if (existingTab) {
      return existingTab;
    }
  }

  const activeTab = tabs.find((tab) => tab.active);
  if (activeTab) {
    return activeTab;
  }

  for (const host of preferredHosts) {
    const hostMatch = tabs.find((tab) => tab.url && tab.url.includes(host));
    if (hostMatch) {
      return hostMatch;
    }
  }

  return tabs
    .slice()
    .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
}

async function injectAiContentScript(tabId) {
  const scriptFile = AI_CONTENT_SCRIPT_FILES[aiType];
  if (!scriptFile) {
    throw new Error(`No content script configured for "${aiType}".`);
  }

  await chrome.scripting.executeScript({
    target: { tabId },
    files: [scriptFile],
  });
}

async function sendQuestionToAiWithRetry(question, maxAttempts = 4, delay = 900) {
  let lastErrorMessage = "AI tab did not accept the question.";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await sendMessageWithRetry(
        aiTabId,
        {
          type: "receiveQuestion",
          question,
        },
        1,
        0
      );

      if (response && response.received) {
        return response;
      }

      if (response && response.error) {
        lastErrorMessage = response.error;
      } else if (!response) {
        lastErrorMessage = "AI tab did not return acknowledgement.";
      }
    } catch (error) {
      lastErrorMessage = getErrorMessage(error);

      if (isMissingReceiverError(error) && aiTabId) {
        try {
          await injectAiContentScript(aiTabId);
          await sleep(250);
        } catch (injectError) {
          lastErrorMessage = `Receiver missing and script injection failed: ${getErrorMessage(
            injectError
          )}`;
        }
      } else if (lastErrorMessage.includes("No tab with id")) {
        await findAndStoreTabs();
      }
    }

    if (attempt < maxAttempts) {
      await sleep(delay);
      await findAndStoreTabs();
    }
  }

  throw new Error(lastErrorMessage);
}

async function focusTab(tabId) {
  if (!tabId) return false;

  try {
    const tab = await chrome.tabs.get(tabId);

    if (tab.windowId === chrome.windows.WINDOW_ID_CURRENT) {
      await chrome.tabs.update(tabId, { active: true });
      return true;
    }

    await chrome.windows.update(tab.windowId, { focused: true });
    await chrome.tabs.update(tabId, { active: true });
    return true;
  } catch (error) {
    return false;
  }
}

async function findAndStoreTabs() {
  const mheTabs = await chrome.tabs.query({
    url: [
      "https://learning.mheducation.com/*",
      "https://ezto.mheducation.com/*",
    ],
  });

  if (mheTabs.length > 0) {
    const preferredMheTab =
      mheTabs.find((tab) => tab.id === mheTabId) ||
      mheTabs.find((tab) => tab.active) ||
      mheTabs[0];
    mheTabId = preferredMheTab.id;
    mheWindowId = preferredMheTab.windowId;
  } else {
    mheTabId = null;
    mheWindowId = null;
  }

  const data = await chrome.storage.sync.get("aiModel");
  const aiModel = data.aiModel || "chatgpt";
  aiType = aiModel;

  if (aiModel === "chatgpt") {
    const tabs = await chrome.tabs.query({ url: "https://chatgpt.com/*" });
    if (tabs.length > 0) {
      const preferredTab = pickPreferredTab(tabs, ["chatgpt.com"]);
      aiTabId = preferredTab.id;
      aiWindowId = preferredTab.windowId;
    } else {
      aiTabId = null;
      aiWindowId = null;
    }
  } else if (aiModel === "gemini") {
    const tabs = await chrome.tabs.query({
      url: "https://gemini.google.com/*",
    });
    if (tabs.length > 0) {
      const preferredTab = pickPreferredTab(tabs, ["gemini.google.com"]);
      aiTabId = preferredTab.id;
      aiWindowId = preferredTab.windowId;
    } else {
      aiTabId = null;
      aiWindowId = null;
    }
  } else if (aiModel === "deepseek") {
    const tabs = await chrome.tabs.query({
      url: DEEPSEEK_URL_PATTERNS,
    });
    if (tabs.length > 0) {
      const preferredTab = pickPreferredTab(tabs, [
        "chat.deepseek.com",
        "deepseek.chat",
      ]);
      aiTabId = preferredTab.id;
      aiWindowId = preferredTab.windowId;
    } else {
      aiTabId = null;
      aiWindowId = null;
    }
  }
}

async function shouldFocusTabs() {
  await findAndStoreTabs();
  return mheWindowId === aiWindowId;
}

async function processQuestion(message) {
  if (processingQuestion) return;
  processingQuestion = true;

  try {
    await findAndStoreTabs();

    if (!aiTabId) {
      await sendMessageWithRetry(mheTabId, {
        type: "alertMessage",
        message: `Please open ${aiType} in another tab before using automation.`,
      });
      return;
    }

    if (!mheTabId) {
      mheTabId = message.sourceTabId;
    }

    const sameWindow = await shouldFocusTabs();

    if (sameWindow) {
      await focusTab(aiTabId);
      await sleep(300);
    }

    await sendQuestionToAiWithRetry(message.question);

    if (sameWindow && lastActiveTabId && lastActiveTabId !== aiTabId) {
      setTimeout(async () => {
        await focusTab(lastActiveTabId);
      }, 1000);
    }
  } catch (error) {
    if (mheTabId) {
      await sendMessageWithRetry(mheTabId, {
        type: "alertMessage",
        message: `Error communicating with ${aiType}: ${getErrorMessage(error)}`,
      });
    }
  } finally {
    processingQuestion = false;
  }
}

async function processResponse(message) {
  try {
    if (!mheTabId) {
      const mheTabs = await chrome.tabs.query({
        url: [
          "https://learning.mheducation.com/*",
          "https://ezto.mheducation.com/*",
        ],
      });
      if (mheTabs.length > 0) {
        const preferredMheTab =
          mheTabs.find((tab) => tab.id === mheTabId) ||
          mheTabs.find((tab) => tab.active) ||
          mheTabs[0];
        mheTabId = preferredMheTab.id;
        mheWindowId = preferredMheTab.windowId;
      } else {
        return;
      }
    }

    const sameWindow = await shouldFocusTabs();

    if (sameWindow) {
      await focusTab(mheTabId);
      await sleep(300);
    }

    await sendMessageWithRetry(mheTabId, {
      type: "processChatGPTResponse",
      response: message.response,
    });
  } catch (error) {
    console.error("Error processing AI response:", error);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.tab) {
    message.sourceTabId = sender.tab.id;

    if (
      sender.tab.url.includes("learning.mheducation.com") ||
      sender.tab.url.includes("ezto.mheducation.com")
    ) {
      mheTabId = sender.tab.id;
      mheWindowId = sender.tab.windowId;
    } else if (sender.tab.url.includes("chatgpt.com")) {
      aiTabId = sender.tab.id;
      aiWindowId = sender.tab.windowId;
      aiType = "chatgpt";
    } else if (sender.tab.url.includes("gemini.google.com")) {
      aiTabId = sender.tab.id;
      aiWindowId = sender.tab.windowId;
      aiType = "gemini";
    } else if (isDeepSeekTabUrl(sender.tab.url || "")) {
      aiTabId = sender.tab.id;
      aiWindowId = sender.tab.windowId;
      aiType = "deepseek";
    }
  }

  if (message.type === "sendQuestionToChatGPT") {
    processQuestion(message);
    sendResponse({ received: true });
    return true;
  }

  if (
    message.type === "chatGPTResponse" ||
    message.type === "geminiResponse" ||
    message.type === "deepseekResponse"
  ) {
    processResponse(message);
    sendResponse({ received: true });
    return true;
  }

  if (message.type === "openSettings") {
    chrome.windows.create({
      url: chrome.runtime.getURL("popup/settings.html"),
      type: "popup",
      width: 500,
      height: 520,
    });
    sendResponse({ received: true });
    return true;
  }

  sendResponse({ received: false });
  return false;
});

findAndStoreTabs();

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === mheTabId) mheTabId = null;
  if (tabId === aiTabId) aiTabId = null;
});
