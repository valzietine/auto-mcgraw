let hasResponded = false;
let messageCountAtQuestion = 0;
let observationStartTime = 0;
let observationTimeout = null;
let checkIntervalId = null;
let observer = null;
let baselineMessageSignatures = new Map();
let activeQuestionId = null;
const INPUT_WAIT_TIMEOUT_MS = 15000;
const SEND_BUTTON_WAIT_TIMEOUT_MS = 7000;
const LOG_PREFIX = "[Auto-McGraw][deepseek]";
const MESSAGE_SELECTORS = [
  "[data-testid='chat-message-assistant']",
  "[data-testid='message-content']",
  "model-response",
  ".ds-markdown",
  ".f9bf7997",
];
const CHAT_INPUT_SELECTORS = [
  "#chat-input",
  'textarea[data-testid="chat_input_input"]',
  "textarea",
  '[role="textbox"][contenteditable="true"]',
];
const SEND_BUTTON_SELECTORS = [
  '[data-testid="submit-button"]',
  '[data-testid="send-button"]',
  '[data-testid="chat_input_send_button"]',
  '[role="button"].f6d670',
  ".f6d670",
  'button[type="submit"]',
  '[aria-label="Send message"]',
  '[aria-label*="Send"]',
];

function isElementVisible(element) {
  if (!element || !element.isConnected) {
    return false;
  }

  const style = window.getComputedStyle(element);
  if (
    style.display === "none" ||
    style.visibility === "hidden" ||
    style.opacity === "0"
  ) {
    return false;
  }

  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function getMessageNodes() {
  for (const selector of MESSAGE_SELECTORS) {
    const nodes = Array.from(document.querySelectorAll(selector)).filter(
      (node) => isElementVisible(node)
    );
    if (nodes.length > 0) {
      return nodes;
    }
  }

  return [];
}

function findChatInput() {
  for (const selector of CHAT_INPUT_SELECTORS) {
    const candidates = Array.from(document.querySelectorAll(selector));
    for (const candidate of candidates) {
      if (!isElementVisible(candidate)) {
        continue;
      }

      if (
        "disabled" in candidate &&
        (candidate.disabled || candidate.getAttribute("aria-disabled") === "true")
      ) {
        continue;
      }

      return candidate;
    }
  }

  return null;
}

function isButtonUsable(button) {
  if (!button) return false;
  if (button.disabled) return false;
  if (button.getAttribute("aria-disabled") === "true") return false;
  return true;
}

function hasLikelySendIcon(button) {
  const pathData = Array.from(button.querySelectorAll("svg path"))
    .map((path) => path.getAttribute("d") || "")
    .join(" ");

  return (
    pathData.includes("M8.3125") ||
    pathData.includes("L14.707") ||
    pathData.includes("V15.0431")
  );
}

function findSendButtonCandidate() {
  for (const selector of SEND_BUTTON_SELECTORS) {
    try {
      const buttons = Array.from(document.querySelectorAll(selector));
      const button = buttons.find(
        (candidate) => isElementVisible(candidate) && isButtonUsable(candidate)
      );
      if (button) {
        return button;
      }
    } catch (e) {
      continue;
    }
  }

  const composerContainer = document.querySelector(".bf38813a");
  if (composerContainer) {
    const candidates = Array.from(
      composerContainer.querySelectorAll("button, [role='button']")
    ).filter((button) => isElementVisible(button));

    const sendByLabel = candidates.find((button) =>
      /send/i.test(button.getAttribute("aria-label") || "")
    );
    if (sendByLabel) {
      return sendByLabel;
    }

    const sendByClassName = candidates.find((button) =>
      /send/i.test(button.className || "")
    );
    if (sendByClassName) {
      return sendByClassName;
    }

    const sendByIcon = candidates.find((button) => hasLikelySendIcon(button));
    if (sendByIcon) {
      return sendByIcon;
    }

    const iconCandidates = candidates.filter((button) =>
      button.querySelector("svg")
    );
    if (iconCandidates.length > 0) {
      const rightMostButton = iconCandidates
        .slice()
        .sort(
          (a, b) =>
            a.getBoundingClientRect().left - b.getBoundingClientRect().left
        )[iconCandidates.length - 1];
      if (rightMostButton) {
        return rightMostButton;
      }
    }
  }

  return null;
}

function findSendButton() {
  const sendButton = findSendButtonCandidate();
  if (sendButton && isButtonUsable(sendButton)) {
    return sendButton;
  }
  return null;
}

function waitForChatInput(timeoutMs = INPUT_WAIT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();

    const attempt = () => {
      const chatInput = findChatInput();
      if (chatInput) {
        resolve(chatInput);
        return;
      }

      if (Date.now() - startTime >= timeoutMs) {
        reject(new Error("Input area not found"));
        return;
      }

      setTimeout(attempt, 150);
    };

    attempt();
  });
}

function waitForSendButton(timeoutMs = SEND_BUTTON_WAIT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();

    const attempt = () => {
      const sendButton = findSendButton();
      if (sendButton) {
        resolve(sendButton);
        return;
      }

      if (Date.now() - startTime >= timeoutMs) {
        reject(new Error("Send button not found"));
        return;
      }

      setTimeout(attempt, 120);
    };

    attempt();
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function updateChatInputValue(chatInput, text) {
  chatInput.focus();

  if (
    chatInput instanceof HTMLTextAreaElement ||
    chatInput instanceof HTMLInputElement
  ) {
    const prototype = Object.getPrototypeOf(chatInput);
    const valueSetter = Object.getOwnPropertyDescriptor(
      prototype,
      "value"
    )?.set;

    if (valueSetter) {
      valueSetter.call(chatInput, text);
    } else {
      chatInput.value = text;
    }
  } else if (chatInput.isContentEditable) {
    chatInput.textContent = text;
  } else {
    return false;
  }

  chatInput.dispatchEvent(new Event("input", { bubbles: true }));
  chatInput.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "receiveQuestion") {
    resetObservation();
    activeQuestionId = message.questionId || message.question?.questionId || null;
    console.info(LOG_PREFIX, "Received question", activeQuestionId);

    const messages = getMessageNodes();
    messageCountAtQuestion = messages.length;
    baselineMessageSignatures = new Map(
      messages.map((messageNode) => [messageNode, getMessageSignature(messageNode)])
    );
    hasResponded = false;

    insertQuestion(message.question)
      .then(() => {
        sendResponse({ received: true, status: "processing" });
      })
      .catch((error) => {
        sendResponse({ received: false, error: error.message });
      });

    return true;
  }
});

function resetObservation() {
  hasResponded = false;
  if (observationTimeout) {
    clearTimeout(observationTimeout);
    observationTimeout = null;
  }
  if (checkIntervalId) {
    clearInterval(checkIntervalId);
    checkIntervalId = null;
  }
  if (observer) {
    observer.disconnect();
    observer = null;
  }
  baselineMessageSignatures = new Map();
}

async function insertQuestion(questionData) {
  const { type, question, options, previousCorrection } = questionData;
  let text = `Type: ${type}\nQuestion: ${question}`;

  if (
    previousCorrection &&
    previousCorrection.question &&
    previousCorrection.correctAnswer
  ) {
    text =
      `CORRECTION FROM PREVIOUS ANSWER: For the question "${
        previousCorrection.question
      }", your answer was incorrect. The correct answer was: ${JSON.stringify(
        previousCorrection.correctAnswer
      )}\n\nNow answer this new question:\n\n` + text;
  }

  if (type === "matching") {
    text +=
      "\nPrompts:\n" +
      options.prompts.map((prompt, i) => `${i + 1}. ${prompt}`).join("\n");
    text +=
      "\nChoices:\n" +
      options.choices.map((choice, i) => `${i + 1}. ${choice}`).join("\n");
    text +=
      "\n\nPlease match each prompt with the correct choice. Format your answer as an array where each element is 'Prompt -> Choice'.";
  } else if (type === "fill_in_the_blank") {
    text +=
      "\n\nThis is a fill in the blank question. If there are multiple blanks, provide answers as an array in order of appearance. For a single blank, you can provide a string.";
  } else if (options && options.length > 0) {
    text +=
      "\nOptions:\n" + options.map((opt, i) => `${i + 1}. ${opt}`).join("\n");
    text +=
      "\n\nIMPORTANT: Your answer must EXACTLY match one of the above options. Do not include numbers in your answer. If there are periods, include them.";
  }

  text +=
    '\n\nPlease provide your answer in JSON format with keys "answer" and "explanation". Explanations should be no more than one sentence. DO NOT acknowledge the correction in your response, only answer the new question.';

  const chatInput = await waitForChatInput();
  await delay(250);

  if (!updateChatInputValue(chatInput, text)) {
    throw new Error("Unable to fill input area");
  }

  const sendButton = await waitForSendButton();
  sendButton.click();
  startObserving();
}

function processResponse(responseText) {
  const cleanedText = responseText
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\n\s*/g, " ")
    .trim();

  try {
    const parsed = JSON.parse(cleanedText);

    const hasAnswerField =
      parsed &&
      Object.prototype.hasOwnProperty.call(parsed, "answer") &&
      parsed.answer !== undefined &&
      parsed.answer !== null;

    if (hasAnswerField && !hasResponded) {
      hasResponded = true;
      console.info(LOG_PREFIX, "Sending response", activeQuestionId);
      chrome.runtime
        .sendMessage({
          type: "deepseekResponse",
          response: cleanedText,
          questionId: activeQuestionId,
        })
        .then(() => {
          resetObservation();
          return true;
        })
        .catch((error) => {
          return false;
        });

      return true;
    }
  } catch (e) {
    return false;
  }

  return false;
}

function getMessageSignature(message) {
  const listItemKey =
    message
      .closest("[data-virtual-list-item-key]")
      ?.getAttribute("data-virtual-list-item-key") || "";
  const normalizedText = (message.textContent || "")
    .replace(/\s+/g, " ")
    .trim();

  return `${listItemKey}::${normalizedText}`;
}

function getNewOrUpdatedMessages(messages) {
  let changedMessages = messages.filter((message) => {
    const baselineSignature = baselineMessageSignatures.get(message);
    if (!baselineSignature) {
      return true;
    }

    return baselineSignature !== getMessageSignature(message);
  });

  if (!changedMessages.length && messages.length > messageCountAtQuestion) {
    changedMessages = Array.from(messages).slice(messageCountAtQuestion);
  }

  return changedMessages;
}

function checkForResponse() {
  if (hasResponded) {
    return;
  }

  const messages = getMessageNodes();
  if (!messages.length) {
    return;
  }

  const newMessages = getNewOrUpdatedMessages(messages);
  if (!newMessages.length) {
    return;
  }

  for (const message of newMessages) {
    const codeBlockSelectors = [
      ".md-code-block pre",
      "pre code",
      "pre",
      ".code-block pre",
      ".ds-markdown pre",
    ];

    for (const selector of codeBlockSelectors) {
      const codeBlocks = message.querySelectorAll(selector);

      for (const block of codeBlocks) {
        const parent = block.closest(
          ".md-code-block, .code-block, .ds-markdown"
        );

        if (parent) {
          const infoElements = parent.querySelectorAll(
            '.d813de27, .md-code-block-infostring, [class*="json"], [class*="language"]'
          );
          const hasJsonInfo = Array.from(infoElements).some((el) =>
            el.textContent.toLowerCase().includes("json")
          );

          if (hasJsonInfo || !infoElements.length) {
            const responseText = block.textContent.trim();
            if (
              responseText.includes("{") &&
              responseText.includes('"answer"')
            ) {
              if (processResponse(responseText)) return;
            }
          }
        }
      }
    }

    const messageText = message.textContent.trim();
    const jsonMatch = messageText.match(/\{[\s\S]*?"answer"[\s\S]*?\}/);
    if (jsonMatch) {
      const responseText = jsonMatch[0];
      if (processResponse(responseText)) return;
    }

    if (Date.now() - observationStartTime > 30000) {
      try {
        const jsonPattern = /\{[\s\S]*?"answer"[\s\S]*?"explanation"[\s\S]*?\}/;
        const jsonMatch = messageText.match(jsonPattern);

        if (jsonMatch && !hasResponded) {
          hasResponded = true;
          chrome.runtime.sendMessage({
            type: "deepseekResponse",
            response: jsonMatch[0],
            questionId: activeQuestionId,
          });
          resetObservation();
          return true;
        }
      } catch (e) {}
    }
  }
}

function startObserving() {
  observationStartTime = Date.now();
  observationTimeout = setTimeout(() => {
    if (!hasResponded) {
      console.warn(LOG_PREFIX, "Response timeout", activeQuestionId);
      resetObservation();
    }
  }, 180000);

  observer = new MutationObserver(() => {
    checkForResponse();
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
  });

  checkIntervalId = setInterval(checkForResponse, 1000);
}
