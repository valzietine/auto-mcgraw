let hasResponded = false;
let messageCountAtQuestion = 0;
let observationStartTime = 0;
let observationTimeout = null;
let checkIntervalId = null;
let observer = null;
let baselineMessageSignatures = new Map();
let activeQuestionId = null;
let responseForwardingInProgress = false;
let responseCandidateKey = "";
let responseCandidateFirstSeenAt = 0;
const INPUT_WAIT_TIMEOUT_MS = 15000;
const SEND_BUTTON_WAIT_TIMEOUT_MS = 7000;
const RESPONSE_STABILITY_WINDOW_MS = 2200;
const GENERATION_GUARD_MAX_WAIT_MS = 12000;
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
const STOP_BUTTON_SELECTORS = [
  '[data-testid="chat_input_stop_button"]',
  '[data-testid="stop-button"]',
  '[aria-label*="Stop generating"]',
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
  responseForwardingInProgress = false;
  responseCandidateKey = "";
  responseCandidateFirstSeenAt = 0;
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

function isLikelyStillGenerating(messageNode = null) {
  const messageIndicators = [
    ".result-streaming",
    ".cursor",
    '[data-testid*="stream"]',
  ];

  if (messageNode) {
    for (const selector of messageIndicators) {
      if (messageNode.querySelector(selector)) {
        return true;
      }
    }
  }

  for (const selector of STOP_BUTTON_SELECTORS) {
    const stopButton = document.querySelector(selector);
    if (
      stopButton &&
      isElementVisible(stopButton) &&
      !stopButton.disabled &&
      stopButton.getAttribute("aria-disabled") !== "true"
    ) {
      return true;
    }
  }

  return false;
}

async function insertQuestion(questionData) {
  const { type, question, options, previousCorrection, previousFormatIssue } =
    questionData;
  let text = `Type: ${type}\nQuestion: ${question}`;

  if (previousFormatIssue) {
    text =
      `FORMAT REQUIREMENT FROM PREVIOUS RESPONSE: ${previousFormatIssue}\n\nNow answer this same question again.\n\n` +
      text;
  }

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
    '\n\nRespond with ONLY a valid JSON object with keys "answer" and "explanation". The "answer" field is required. Do not wrap the JSON in markdown or code fences. Escape any internal double quotes in strings (for example: \\"text\\"). Explanations should be no more than one sentence. DO NOT acknowledge corrections or format reminders; only answer the current question.';

  const chatInput = await waitForChatInput();
  await delay(250);

  if (!updateChatInputValue(chatInput, text)) {
    throw new Error("Unable to fill input area");
  }

  const sendButton = await waitForSendButton();
  sendButton.click();
  startObserving();
}

function stripCodeFences(text) {
  if (typeof text !== "string") return "";
  return text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function extractAnswerFromArrayLiteral(arrayText) {
  if (typeof arrayText !== "string") return [];

  const answers = [];
  const itemRegex = /"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'/g;
  let match;

  while ((match = itemRegex.exec(arrayText)) !== null) {
    const value = match[1] !== undefined ? match[1] : match[2];
    const normalized = value.replace(/\\"/g, '"').trim();
    if (normalized) {
      answers.push(normalized);
    }
  }

  return answers;
}

function extractAnswerFromMalformedResponse(responseText) {
  if (typeof responseText !== "string") return null;

  const normalizedText = stripCodeFences(responseText);
  if (!normalizedText) return null;

  const quotedMatch = normalizedText.match(
    /["']answer["']\s*:\s*"((?:\\.|[^"\\])*)"|["']answer["']\s*:\s*'((?:\\.|[^'\\])*)'/i
  );
  if (quotedMatch) {
    const raw = quotedMatch[1] !== undefined ? quotedMatch[1] : quotedMatch[2];
    const answer = raw.replace(/\\"/g, '"').trim();
    return answer || null;
  }

  const arrayMatch = normalizedText.match(/["']answer["']\s*:\s*\[([\s\S]*?)\]/i);
  if (arrayMatch) {
    const answers = extractAnswerFromArrayLiteral(arrayMatch[1]);
    if (answers.length > 0) {
      return answers;
    }
  }

  const bareMatch = normalizedText.match(/["']answer["']\s*:\s*([^,\n}]+)/i);
  if (bareMatch) {
    const answer = bareMatch[1].replace(/^["']|["']$/g, "").trim();
    return answer || null;
  }

  return null;
}

function parseAiResponse(responseText) {
  const cleanedText = stripCodeFences(responseText)
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\n\s*/g, " ")
    .trim();

  if (!cleanedText) {
    return null;
  }

  try {
    const parsed = JSON.parse(cleanedText);
    if (
      parsed &&
      Object.prototype.hasOwnProperty.call(parsed, "answer") &&
      parsed.answer !== undefined &&
      parsed.answer !== null
    ) {
      return {
        answer: parsed.answer,
        explanation:
          typeof parsed.explanation === "string" ? parsed.explanation : "",
      };
    }

    return {
      formatError: "missing_answer_field",
      explanation: typeof parsed?.explanation === "string" ? parsed.explanation : "",
    };
  } catch (e) {}

  const extractedAnswer = extractAnswerFromMalformedResponse(cleanedText);
  if (extractedAnswer === null) {
    return null;
  }

  return {
    answer: extractedAnswer,
    explanation: "",
  };
}

function processResponse(responseText, sourceMessage = null) {
  if (hasResponded || responseForwardingInProgress) {
    return false;
  }

  const parsedResponse = parseAiResponse(responseText);
  if (!parsedResponse) return false;

  const candidateKey = JSON.stringify(parsedResponse);
  const now = Date.now();

  if (responseCandidateKey !== candidateKey) {
    responseCandidateKey = candidateKey;
    responseCandidateFirstSeenAt = now;
    console.info(LOG_PREFIX, "Captured response candidate", activeQuestionId);
    return false;
  }

  if (now - responseCandidateFirstSeenAt < RESPONSE_STABILITY_WINDOW_MS) {
    return false;
  }

  if (
    isLikelyStillGenerating(sourceMessage) &&
    now - responseCandidateFirstSeenAt < GENERATION_GUARD_MAX_WAIT_MS
  ) {
    return false;
  }

  responseForwardingInProgress = true;
  console.info(LOG_PREFIX, "Sending response", activeQuestionId);

  chrome.runtime
    .sendMessage({
      type: "deepseekResponse",
      response: JSON.stringify(parsedResponse),
      questionId: activeQuestionId,
    })
    .then(() => {
      hasResponded = true;
      resetObservation();
    })
    .catch((error) => {
      responseForwardingInProgress = false;
      hasResponded = false;
      console.warn(LOG_PREFIX, "Failed to forward response, retrying", error);
    });

  return true;
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
              if (processResponse(responseText, message)) return;
            }
          }
        }
      }
    }

    const messageText = message.textContent.trim();
    if (processResponse(messageText, message)) return;
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
