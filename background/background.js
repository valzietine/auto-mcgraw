let mheTabId = null;
let aiTabId = null;
let aiType = null;
let lastActiveTabId = null;
let processingQuestion = false;
let mheWindowId = null;
let aiWindowId = null;
let pendingAiRequest = null;

const LOG_PREFIX = "[Auto-McGraw][bg]";
const AI_RESPONSE_TIMEOUT_MS = 45000;
const AI_TIMEOUT_RETRY_LIMIT = 1;
const COMPLETED_QUESTION_ID_LIMIT = 60;
const completedQuestionIds = [];

const AI_CONTENT_SCRIPT_FILES = {
  chatgpt: "content-scripts/chatgpt.js",
  gemini: "content-scripts/gemini.js",
  deepseek: "content-scripts/deepseek.js",
};

const DEEPSEEK_URL_PATTERNS = [
  "https://chat.deepseek.com/*",
  "https://deepseek.chat/*",
];

function logInfo(...args) {
  console.info(LOG_PREFIX, ...args);
}

function logWarn(...args) {
  console.warn(LOG_PREFIX, ...args);
}

function isDeepSeekTabUrl(url = "") {
  return url.includes("chat.deepseek.com") || url.includes("deepseek.chat");
}

chrome.tabs.onActivated.addListener((activeInfo) => {
  lastActiveTabId = activeInfo.tabId;
});

function createQuestionId() {
  return `q_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function getQuestionIdFromMessage(message) {
  return message?.questionId || message?.question?.questionId || null;
}

function cacheCompletedQuestionId(questionId) {
  if (!questionId) return;
  completedQuestionIds.push(questionId);
  if (completedQuestionIds.length > COMPLETED_QUESTION_ID_LIMIT) {
    completedQuestionIds.splice(
      0,
      completedQuestionIds.length - COMPLETED_QUESTION_ID_LIMIT
    );
  }
}

function hasCompletedQuestionId(questionId) {
  return Boolean(questionId && completedQuestionIds.includes(questionId));
}

function clearPendingAiRequest(reason = "") {
  if (!pendingAiRequest) return;

  if (pendingAiRequest.timeoutId) {
    clearTimeout(pendingAiRequest.timeoutId);
  }

  logInfo(
    `Cleared pending request${reason ? ` (${reason})` : ""}:`,
    pendingAiRequest.questionId
  );
  pendingAiRequest = null;
}

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

async function sendQuestionToAiWithRetry(
  questionPayload,
  maxAttempts = 4,
  delay = 900
) {
  let lastErrorMessage = "AI tab did not accept the question.";
  const questionId = questionPayload?.questionId || "unknown";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      logInfo(`Sending question ${questionId} to ${aiType} (attempt ${attempt})`);
      const response = await sendMessageWithRetry(
        aiTabId,
        {
          type: "receiveQuestion",
          question: questionPayload,
          questionId,
        },
        1,
        0
      );

      if (response && response.received) {
        logInfo(`Question ${questionId} accepted by ${aiType}`);
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
          logWarn(
            `Missing receiver for ${questionId}; injecting ${aiType} script and retrying`
          );
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

async function notifyMhe(messageText) {
  if (!mheTabId) return;
  try {
    await sendMessageWithRetry(mheTabId, {
      type: "alertMessage",
      message: messageText,
    });
  } catch (error) {
    logWarn("Unable to notify MHE tab:", getErrorMessage(error));
  }
}

async function notifyMheTimeout(questionId, messageText) {
  if (!mheTabId) return;
  try {
    await sendMessageWithRetry(mheTabId, {
      type: "aiRequestTimeout",
      questionId,
      message: messageText,
    });
  } catch (error) {
    logWarn("Unable to send timeout signal to MHE tab:", getErrorMessage(error));
  }
}

async function triggerAiTimeoutRetry(expectedQuestionId) {
  if (
    !pendingAiRequest ||
    pendingAiRequest.questionId !== expectedQuestionId ||
    pendingAiRequest.retryCount >= AI_TIMEOUT_RETRY_LIMIT
  ) {
    return false;
  }

  pendingAiRequest.retryCount += 1;
  logWarn(
    `Timeout for ${expectedQuestionId}; retry ${pendingAiRequest.retryCount}/${AI_TIMEOUT_RETRY_LIMIT}`
  );

  try {
    await findAndStoreTabs();
    const sameWindow = await shouldFocusTabs();
    if (sameWindow) {
      await focusTab(aiTabId);
      await sleep(300);
    }

    await sendQuestionToAiWithRetry(pendingAiRequest.questionPayload);
    scheduleAiRequestWatchdog(expectedQuestionId);
    return true;
  } catch (error) {
    logWarn(`Retry failed for ${expectedQuestionId}:`, getErrorMessage(error));
    return false;
  }
}

function scheduleAiRequestWatchdog(questionId) {
  if (!pendingAiRequest || pendingAiRequest.questionId !== questionId) {
    return;
  }

  if (pendingAiRequest.timeoutId) {
    clearTimeout(pendingAiRequest.timeoutId);
  }

  pendingAiRequest.timeoutId = setTimeout(async () => {
    if (!pendingAiRequest || pendingAiRequest.questionId !== questionId) {
      return;
    }

    const retried = await triggerAiTimeoutRetry(questionId);
    if (retried) {
      return;
    }

    const timeoutMessage = `Timed out waiting for ${aiType} response. Retrying question flow.`;
    await notifyMheTimeout(questionId, timeoutMessage);
    clearPendingAiRequest("watchdog_timeout");
  }, AI_RESPONSE_TIMEOUT_MS);
}

async function processQuestion(message) {
  if (processingQuestion) return;
  processingQuestion = true;

  try {
    await findAndStoreTabs();

    if (!aiTabId) {
      await notifyMhe(`Please open ${aiType} in another tab before using automation.`);
      return;
    }

    if (!mheTabId) {
      mheTabId = message.sourceTabId;
    }

    const questionPayload = { ...(message.question || {}) };
    if (!questionPayload.questionId) {
      questionPayload.questionId = createQuestionId();
    }
    const questionId = questionPayload.questionId;

    if (hasCompletedQuestionId(questionId)) {
      logWarn(`Ignoring already-completed question id ${questionId}`);
      return;
    }

    if (pendingAiRequest && pendingAiRequest.questionId !== questionId) {
      clearPendingAiRequest("new_question_replaced_previous");
    }

    const sameWindow = await shouldFocusTabs();

    if (sameWindow) {
      await focusTab(aiTabId);
      await sleep(300);
    }

    await sendQuestionToAiWithRetry(questionPayload);

    pendingAiRequest = {
      questionId,
      questionPayload,
      mheTabId,
      aiType,
      retryCount: 0,
      createdAt: Date.now(),
      timeoutId: null,
    };
    scheduleAiRequestWatchdog(questionId);

    if (sameWindow && lastActiveTabId && lastActiveTabId !== aiTabId) {
      setTimeout(async () => {
        await focusTab(lastActiveTabId);
      }, 1000);
    }
  } catch (error) {
    await notifyMhe(`Error communicating with ${aiType}: ${getErrorMessage(error)}`);
    clearPendingAiRequest("process_question_error");
  } finally {
    processingQuestion = false;
  }
}

async function processResponse(message) {
  try {
    const responseQuestionId = message.questionId || null;

    if (responseQuestionId && hasCompletedQuestionId(responseQuestionId)) {
      logWarn(`Ignoring duplicate completed response for ${responseQuestionId}`);
      return;
    }

    if (pendingAiRequest) {
      if (!responseQuestionId) {
        logWarn("Response missing questionId; accepting for backward compatibility");
      } else if (responseQuestionId !== pendingAiRequest.questionId) {
        logWarn(
          `Ignoring stale response ${responseQuestionId}; pending is ${pendingAiRequest.questionId}`
        );
        return;
      }
    }

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
      questionId: responseQuestionId || pendingAiRequest?.questionId || null,
    });

    const completedId = responseQuestionId || pendingAiRequest?.questionId;
    cacheCompletedQuestionId(completedId);
    clearPendingAiRequest("response_processed");
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
    sendResponse({ received: true, questionId: getQuestionIdFromMessage(message) });
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
