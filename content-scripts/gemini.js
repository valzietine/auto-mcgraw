let hasResponded = false;
let messageCountAtQuestion = 0;
let observationStartTime = 0;
let observationTimeout = null;
let checkIntervalId = null;
let observer = null;
let baselineMessageSignatures = new Set();
let activeQuestionId = null;
let responseForwardingInProgress = false;
let responseCandidateKey = "";
let responseCandidateFirstSeenAt = 0;
let generationClearSince = 0;
const LOG_PREFIX = "[Auto-McGraw][gemini]";
const RESPONSE_MESSAGE_TYPE = "geminiResponse";
const PERF_LOGGING_ENABLED = true;
const INPUT_WAIT_TIMEOUT_MS = 15000;
const SEND_BUTTON_WAIT_TIMEOUT_MS = 7000;
const SEND_BUTTON_RETRY_WAIT_TIMEOUT_MS = 1200;
const PRE_SEND_IDLE_TIMEOUT_MS = 120000;
const INPUT_POLL_INTERVAL_MS = 80;
const SEND_BUTTON_POLL_INTERVAL_MS = 70;
const SEND_ACK_TIMEOUT_MS = 1800;
const SEND_ACK_POLL_INTERVAL_MS = 50;
const MAX_SEND_ATTEMPTS = 3;
const RESPONSE_STABILITY_WINDOW_IDLE_MS = 600;
const RESPONSE_STABILITY_WINDOW_GENERATING_MS = 1800;
const GENERATION_GUARD_MAX_WAIT_MS = 12000;
const GENERATION_CLEAR_STABILITY_MS = 350;
const GENERATING_COMPLETE_JSON_MIN_AGE_MS = 2600;
const RECOVERED_RESPONSE_EXTRA_STABILITY_MS = 1600;
const RECOVERED_RESPONSE_IDLE_STABILITY_MS = 900;
const RESPONSE_CHECK_INTERVAL_MS = 300;
const MESSAGE_SELECTORS = [
  "model-response",
  "[data-response-id]",
  "message-content model-response",
];
const CHAT_INPUT_SELECTORS = [
  ".ql-editor",
  '[contenteditable="true"].ql-editor',
  'div[contenteditable="true"][role="textbox"]',
  "rich-textarea .ql-editor",
  "textarea",
];
const COMPOSER_CONTAINER_SELECTORS = [
  "rich-textarea",
  "form",
  '[class*="composer"]',
  '[class*="input-area"]',
];
const SEND_BUTTON_SELECTORS = [
  ".send-button",
  "button.send-button",
  'button[aria-label*="Send message"]',
  'button[aria-label*="Send"]',
  'button[mattooltip*="Send"]',
  'button[type="submit"]',
];
const STOP_BUTTON_SELECTORS = [
  ".send-button.stop",
  "button.stop",
  'button[aria-label*="Stop response"]',
  'button[aria-label*="Stop"]',
];
const MESSAGE_GENERATING_SELECTORS = [
  ".cursor",
  ".loading-dots",
  ".response-loading",
  '[class*="generating"]',
];

function logPerf(message, ...args) {
  if (!PERF_LOGGING_ENABLED) return;
  console.info(LOG_PREFIX, "[perf]", message, ...args);
}

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

function normalizeTextForComparison(text) {
  return (text || "").replace(/\s+/g, " ").trim();
}

function createSafePromptNode(text) {
  const paragraph = document.createElement("p");
  String(text || "")
    .split("\n")
    .forEach((line, index) => {
      if (index > 0) {
        paragraph.appendChild(document.createElement("br"));
      }
      paragraph.appendChild(document.createTextNode(line));
    });
  return paragraph;
}

function getMessageNodes() {
  for (const selector of MESSAGE_SELECTORS) {
    const nodes = Array.from(document.querySelectorAll(selector)).filter((node) =>
      isElementVisible(node)
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
  if (button.classList.contains("stop")) return false;
  return true;
}

function getComposerContainer(chatInput = null) {
  if (!chatInput || !chatInput.isConnected) {
    for (const selector of COMPOSER_CONTAINER_SELECTORS) {
      const composer = document.querySelector(selector);
      if (composer && composer.querySelector("button, [role='button']")) {
        return composer;
      }
    }
    return null;
  }

  const explicitContainer = chatInput.closest(COMPOSER_CONTAINER_SELECTORS.join(", "));
  if (explicitContainer) {
    return explicitContainer;
  }

  let current = chatInput.parentElement;
  while (current && current !== document.body) {
    if (
      current.querySelector("button, [role='button']") &&
      current.querySelector('.ql-editor, [contenteditable="true"], textarea')
    ) {
      return current;
    }
    current = current.parentElement;
  }

  return null;
}

function isLikelySendButton(button) {
  if (!button) {
    return false;
  }

  const dataTestId = (button.getAttribute("data-testid") || "").toLowerCase();
  const ariaLabel = (button.getAttribute("aria-label") || "").toLowerCase();
  const matTooltip = (button.getAttribute("mattooltip") || "").toLowerCase();
  const title = (button.getAttribute("title") || "").toLowerCase();
  const typeAttr = (button.getAttribute("type") || "").toLowerCase();
  const className = (button.className || "").toLowerCase();
  const buttonText = (button.textContent || "").toLowerCase();
  const combined =
    `${dataTestId} ${ariaLabel} ${matTooltip} ${title} ${className} ${buttonText}`;

  if (
    /\bstop\b/.test(combined) ||
    /\bvoice\b/.test(combined) ||
    /\bmicrophone\b/.test(combined) ||
    /\bmic\b/.test(combined)
  ) {
    return false;
  }

  if (
    typeAttr === "submit" ||
    /\bsend\b/.test(combined) ||
    /\bsubmit\b/.test(combined)
  ) {
    return true;
  }

  const svg = button.querySelector("svg");
  return Boolean(svg) && !buttonText.trim();
}

function pickClosestSendButton(candidates, chatInput = null) {
  if (!candidates.length) {
    return null;
  }

  if (!chatInput || !chatInput.isConnected) {
    return candidates[candidates.length - 1];
  }

  const inputRect = chatInput.getBoundingClientRect();
  const inputCenterX = inputRect.left + inputRect.width / 2;
  const inputCenterY = inputRect.top + inputRect.height / 2;
  const inputRightX = inputRect.right;

  return candidates
    .slice()
    .sort((a, b) => {
      const aRect = a.getBoundingClientRect();
      const bRect = b.getBoundingClientRect();
      const aCenterX = aRect.left + aRect.width / 2;
      const bCenterX = bRect.left + bRect.width / 2;
      const aCenterY = aRect.top + aRect.height / 2;
      const bCenterY = bRect.top + bRect.height / 2;
      const aIsOnRight = aCenterX >= inputCenterX;
      const bIsOnRight = bCenterX >= inputCenterX;

      if (aIsOnRight !== bIsOnRight) {
        return aIsOnRight ? -1 : 1;
      }

      const aVerticalOffset = Math.abs(aCenterY - inputCenterY);
      const bVerticalOffset = Math.abs(bCenterY - inputCenterY);
      if (aVerticalOffset !== bVerticalOffset) {
        return aVerticalOffset - bVerticalOffset;
      }

      const aDistanceToRightEdge = Math.abs(aCenterX - inputRightX);
      const bDistanceToRightEdge = Math.abs(bCenterX - inputRightX);
      if (aDistanceToRightEdge !== bDistanceToRightEdge) {
        return aDistanceToRightEdge - bDistanceToRightEdge;
      }

      const aDistance = Math.hypot(aCenterX - inputCenterX, aCenterY - inputCenterY);
      const bDistance = Math.hypot(bCenterX - inputCenterX, bCenterY - inputCenterY);
      return aDistance - bDistance;
    })[0];
}

function findSendButtonCandidate(chatInput = null) {
  const composerContainer = getComposerContainer(chatInput);
  if (composerContainer) {
    for (const selector of SEND_BUTTON_SELECTORS) {
      const buttons = Array.from(composerContainer.querySelectorAll(selector)).filter(
        (candidate) =>
          isElementVisible(candidate) &&
          isButtonUsable(candidate) &&
          isLikelySendButton(candidate)
      );
      if (buttons.length > 0) {
        return pickClosestSendButton(buttons, chatInput);
      }
    }

    const buttons = Array.from(
      composerContainer.querySelectorAll("button, [role='button']")
    ).filter(
      (candidate) =>
        isElementVisible(candidate) &&
        isButtonUsable(candidate) &&
        isLikelySendButton(candidate)
    );
    if (buttons.length > 0) {
      return pickClosestSendButton(buttons, chatInput);
    }
  }

  for (const selector of SEND_BUTTON_SELECTORS) {
    const buttons = Array.from(document.querySelectorAll(selector)).filter(
      (candidate) =>
        isElementVisible(candidate) &&
        isButtonUsable(candidate) &&
        isLikelySendButton(candidate)
    );
    if (buttons.length > 0) {
      return pickClosestSendButton(buttons, chatInput);
    }
  }

  return null;
}

function findSendButton(chatInput = null) {
  const sendButton = findSendButtonCandidate(chatInput);
  if (sendButton && isButtonUsable(sendButton)) {
    return sendButton;
  }
  return null;
}

function waitForCondition(predicate, timeout, pollIntervalMs) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();

    const attempt = () => {
      let result = null;
      try {
        result = predicate();
      } catch (error) {}

      if (result) {
        resolve(result);
        return;
      }

      if (Date.now() - startTime >= timeout) {
        reject(new Error("Timed out waiting for condition"));
        return;
      }

      setTimeout(attempt, pollIntervalMs);
    };

    attempt();
  });
}

function waitForChatInput(timeoutMs = INPUT_WAIT_TIMEOUT_MS) {
  return waitForCondition(() => findChatInput(), timeoutMs, INPUT_POLL_INTERVAL_MS);
}

function waitForSendButton(chatInput = null, timeoutMs = SEND_BUTTON_WAIT_TIMEOUT_MS) {
  return waitForCondition(
    () => findSendButton(chatInput),
    timeoutMs,
    SEND_BUTTON_POLL_INTERVAL_MS
  );
}

function getChatInputValue(chatInput) {
  if (!chatInput || !chatInput.isConnected) {
    return "";
  }

  if (
    chatInput instanceof HTMLTextAreaElement ||
    chatInput instanceof HTMLInputElement
  ) {
    return chatInput.value || "";
  }

  if (chatInput.isContentEditable) {
    return chatInput.textContent || "";
  }

  return "";
}

function updateChatInputValue(chatInput, text) {
  chatInput.focus();

  if (
    chatInput instanceof HTMLTextAreaElement ||
    chatInput instanceof HTMLInputElement
  ) {
    const prototype = Object.getPrototypeOf(chatInput);
    const valueSetter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;

    if (valueSetter) {
      valueSetter.call(chatInput, text);
    } else {
      chatInput.value = text;
    }
  } else if (chatInput.isContentEditable) {
    chatInput.replaceChildren(createSafePromptNode(text));
  } else {
    return false;
  }

  chatInput.dispatchEvent(new Event("input", { bubbles: true }));
  chatInput.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}

function triggerEnterSubmit(chatInput) {
  if (!chatInput || !chatInput.isConnected) {
    return;
  }

  chatInput.focus();
  const keyEventOptions = {
    key: "Enter",
    code: "Enter",
    keyCode: 13,
    which: 13,
    bubbles: true,
    cancelable: true,
  };

  chatInput.dispatchEvent(new KeyboardEvent("keydown", keyEventOptions));
  chatInput.dispatchEvent(new KeyboardEvent("keypress", keyEventOptions));
  chatInput.dispatchEvent(new KeyboardEvent("keyup", keyEventOptions));
}

function isSendSubmissionAcknowledged(chatInput, submittedText) {
  if (isLikelyStillGenerating()) {
    return true;
  }

  const expected = normalizeTextForComparison(submittedText);
  const current = normalizeTextForComparison(getChatInputValue(chatInput));

  if (!expected) {
    return current.length === 0;
  }

  if (current.length === 0) {
    return true;
  }

  if (
    current !== expected &&
    current.length <= Math.max(12, Math.floor(expected.length * 0.35))
  ) {
    return true;
  }

  const sendButton = findSendButton(chatInput);
  if ((!sendButton || !isButtonUsable(sendButton)) && current !== expected) {
    return true;
  }

  return false;
}

function waitForSendAcknowledgement(chatInput, submittedText) {
  return new Promise((resolve) => {
    const startTime = Date.now();

    const attempt = () => {
      if (isSendSubmissionAcknowledged(chatInput, submittedText)) {
        resolve(true);
        return;
      }

      if (Date.now() - startTime >= SEND_ACK_TIMEOUT_MS) {
        resolve(false);
        return;
      }

      setTimeout(attempt, SEND_ACK_POLL_INTERVAL_MS);
    };

    attempt();
  });
}

async function submitPromptWithVerification(chatInput, promptText) {
  for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS; attempt++) {
    if (attempt === 2) {
      triggerEnterSubmit(chatInput);
    } else {
      const timeoutMs =
        attempt === 1 ? SEND_BUTTON_WAIT_TIMEOUT_MS : SEND_BUTTON_RETRY_WAIT_TIMEOUT_MS;
      const sendButton = await waitForSendButton(chatInput, timeoutMs);
      sendButton.click();
    }

    const acknowledged = await waitForSendAcknowledgement(chatInput, promptText);
    if (acknowledged) {
      return;
    }

    console.warn(
      LOG_PREFIX,
      `Send action attempt ${attempt} was not acknowledged; retrying`,
      activeQuestionId
    );
  }

  throw new Error("Failed to submit prompt after retries");
}

function isComposerInStopMode() {
  const composer = getComposerContainer(findChatInput());
  if (!composer) {
    return false;
  }

  const buttons = Array.from(
    composer.querySelectorAll("button, [role='button']")
  ).filter((button) => isElementVisible(button));
  if (!buttons.length) {
    return false;
  }

  return buttons.some((button) => {
    const combined = [
      button.getAttribute("data-testid") || "",
      button.getAttribute("aria-label") || "",
      button.getAttribute("mattooltip") || "",
      button.getAttribute("title") || "",
      button.className || "",
      button.textContent || "",
    ]
      .join(" ")
      .toLowerCase();

    return /\bstop\b/.test(combined) && !button.disabled;
  });
}

function isLikelyStillGenerating(messageNode = null) {
  if (messageNode) {
    for (const selector of MESSAGE_GENERATING_SELECTORS) {
      if (messageNode.querySelector(selector)) {
        return true;
      }
    }
    if (messageNode.classList.contains("generating")) {
      return true;
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

  return isComposerInStopMode();
}

function waitForAssistantIdle(timeoutMs = PRE_SEND_IDLE_TIMEOUT_MS) {
  return waitForCondition(
    () => (!isLikelyStillGenerating() ? true : null),
    timeoutMs,
    250
  );
}

function buildPromptText(questionData) {
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
      options.prompts.map((prompt, index) => `${index + 1}. ${prompt}`).join("\n");
    text +=
      "\nChoices:\n" +
      options.choices.map((choice, index) => `${index + 1}. ${choice}`).join("\n");
    text +=
      '\n\nPlease match each prompt with the correct choice. Set "answer" to an array of strings using the exact format \'Prompt -> Choice\'. Include one entry per prompt, use exact prompt and choice text, and use each choice at most once.';
  } else if (type === "fill_in_the_blank") {
    text +=
      "\n\nThis is a fill in the blank question. If there are multiple blanks, provide answers as an array in order of appearance. For a single blank, you can provide a string.";
  } else if (type === "ordering") {
    if (options && options.length > 0) {
      text +=
        "\nOptions:\n" +
        options.map((option, index) => `${index + 1}. ${option}`).join("\n");
    }
    text +=
      '\n\nThis is an ordering question. Set "answer" to an array containing the options in correct top-to-bottom order. Include each option exactly once and use the exact option text.';
  } else if (type === "click_and_drag") {
    const labels = Array.isArray(options?.labels) ? options.labels : [];
    const categories = Array.isArray(options?.categories) ? options.categories : [];
    if (labels.length > 0) {
      text +=
        "\nLabels:\n" +
        labels.map((label, index) => `${index + 1}. ${label}`).join("\n");
    }
    if (categories.length > 0) {
      text +=
        "\nCategories:\n" +
        categories.map((category, index) => `${index + 1}. ${category}`).join("\n");
    }
    text +=
      '\n\nThis is a click-and-drag labeling question. Set "answer" to an array of strings where each array item is exactly one complete "Label -> Category" pair. Use exact label and category text including punctuation and apostrophes. Do not split a label across lines or array items. Do not include numbering, bullets, prefixes, or extra commentary. Include each label exactly once, and do not include labels or categories not listed.';
  } else if (options && options.length > 0) {
    text +=
      "\nOptions:\n" +
      options.map((option, index) => `${index + 1}. ${option}`).join("\n");
    text +=
      "\n\nIMPORTANT: Your answer must EXACTLY match one of the above options. Do not include numbers in your answer. If there are periods, include them.";
  }

  text +=
    '\n\nRespond with ONLY a valid JSON object with keys "answer" and "explanation". The "answer" field is required. Do not wrap the JSON in markdown or code fences. Escape any internal double quotes in strings (for example: \\"text\\"). Explanations should be no more than one sentence. DO NOT acknowledge corrections or format reminders; only answer the current question.';
  return text;
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

  const jsonBlockMatch = cleanedText.match(/\{[\s\S]*\}/);
  const candidateText = jsonBlockMatch ? jsonBlockMatch[0] : cleanedText;
  const hasCompleteJsonShape =
    candidateText.startsWith("{") &&
    candidateText.endsWith("}") &&
    candidateText.includes('"answer"');

  try {
    const parsed = JSON.parse(candidateText);
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
        parseMode: "json",
        hasCompleteJsonShape: true,
      };
    }

    return {
      formatError: "missing_answer_field",
      explanation: typeof parsed?.explanation === "string" ? parsed.explanation : "",
      parseMode: "json_missing_answer",
      hasCompleteJsonShape,
    };
  } catch (error) {}

  const extractedAnswer = extractAnswerFromMalformedResponse(candidateText);
  if (extractedAnswer === null) {
    return null;
  }

  return {
    answer: extractedAnswer,
    explanation: "",
    parseMode: "recovered",
    hasCompleteJsonShape,
  };
}

function buildForwardDescriptor(parsedResponse) {
  if (!parsedResponse) {
    return null;
  }

  if (
    Object.prototype.hasOwnProperty.call(parsedResponse, "answer") &&
    parsedResponse.answer !== undefined &&
    parsedResponse.answer !== null
  ) {
    const payload = {
      answer: parsedResponse.answer,
      explanation:
        typeof parsedResponse.explanation === "string"
          ? parsedResponse.explanation
          : "",
    };

    return {
      kind: "answer",
      responseText: JSON.stringify(payload),
      candidateKey: JSON.stringify(payload),
      parseMode: parsedResponse.parseMode || "json",
      hasCompleteJsonShape: Boolean(parsedResponse.hasCompleteJsonShape),
    };
  }

  if (parsedResponse.formatError) {
    const payload = {
      formatError: parsedResponse.formatError,
      explanation:
        typeof parsedResponse.explanation === "string"
          ? parsedResponse.explanation
          : "",
    };

    return {
      kind: "format_error",
      responseText: JSON.stringify(payload),
      candidateKey: JSON.stringify(payload),
      parseMode: parsedResponse.parseMode || "json_missing_answer",
      hasCompleteJsonShape: Boolean(parsedResponse.hasCompleteJsonShape),
    };
  }

  return null;
}

function forwardResponseToBackground(descriptor, meta) {
  responseForwardingInProgress = true;
  console.info(LOG_PREFIX, "Sending response", activeQuestionId);
  logPerf(
    `${activeQuestionId || "unknown"} responseStable->forward ${meta.candidateAgeMs}ms`,
    meta
  );

  chrome.runtime
    .sendMessage({
      type: RESPONSE_MESSAGE_TYPE,
      response: descriptor.responseText,
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
}

function processResponse(responseText, sourceMessage = null) {
  if (hasResponded || responseForwardingInProgress) {
    return false;
  }

  const parsedResponse = parseAiResponse(responseText);
  const descriptor = buildForwardDescriptor(parsedResponse);
  if (!descriptor) {
    return false;
  }

  const now = Date.now();
  if (responseCandidateKey !== descriptor.candidateKey) {
    responseCandidateKey = descriptor.candidateKey;
    responseCandidateFirstSeenAt = now;
    console.info(LOG_PREFIX, "Captured response candidate", activeQuestionId);
    return false;
  }

  const candidateAgeMs = now - responseCandidateFirstSeenAt;
  const stillGenerating = isLikelyStillGenerating(sourceMessage);
  if (stillGenerating) {
    generationClearSince = 0;
  } else if (!generationClearSince) {
    generationClearSince = now;
  }

  const generationIdleMs = generationClearSince ? now - generationClearSince : 0;
  const stabilityWindowMs = stillGenerating
    ? RESPONSE_STABILITY_WINDOW_GENERATING_MS
    : RESPONSE_STABILITY_WINDOW_IDLE_MS;

  if (candidateAgeMs < stabilityWindowMs) {
    return false;
  }

  if (!stillGenerating && generationIdleMs < GENERATION_CLEAR_STABILITY_MS) {
    return false;
  }

  if (descriptor.kind === "format_error") {
    if (stillGenerating) {
      return false;
    }
    if (candidateAgeMs < RESPONSE_STABILITY_WINDOW_IDLE_MS + 700) {
      return false;
    }
  } else if (
    descriptor.parseMode === "recovered" ||
    !descriptor.hasCompleteJsonShape
  ) {
    if (stillGenerating) {
      return false;
    }
    if (
      candidateAgeMs <
      RESPONSE_STABILITY_WINDOW_IDLE_MS + RECOVERED_RESPONSE_EXTRA_STABILITY_MS
    ) {
      return false;
    }
    if (generationIdleMs < RECOVERED_RESPONSE_IDLE_STABILITY_MS) {
      return false;
    }
  }

  let forcedByGenerationGuardTimeout = false;
  if (descriptor.kind === "answer" && stillGenerating) {
    if (descriptor.hasCompleteJsonShape) {
      if (candidateAgeMs < GENERATING_COMPLETE_JSON_MIN_AGE_MS) {
        return false;
      }
    } else {
      if (candidateAgeMs < GENERATION_GUARD_MAX_WAIT_MS) {
        return false;
      }
      forcedByGenerationGuardTimeout = true;
    }
  }

  forwardResponseToBackground(descriptor, {
    candidateAgeMs,
    stillGenerating,
    generationIdleMs,
    forcedByGenerationGuardTimeout,
    parseMode: descriptor.parseMode,
    hasCompleteJsonShape: descriptor.hasCompleteJsonShape,
    kind: descriptor.kind,
  });
  return true;
}

function getMessageSignature(message) {
  const container =
    message.closest("[data-response-id]") ||
    message.closest("model-response") ||
    message;
  const key = [
    container.getAttribute?.("data-response-id") || "",
    container.getAttribute?.("id") || "",
  ]
    .filter(Boolean)
    .join("::");
  const normalizedText = normalizeTextForComparison(message.textContent || "");
  return `${key}::${normalizedText}`;
}

function getMessageSortKey(message) {
  const container =
    message.closest("[data-response-id]") ||
    message.closest("model-response") ||
    message;
  return container.getBoundingClientRect().top;
}

function getNewOrUpdatedMessages(messages) {
  let changedMessages = messages.filter((message) => {
    const signature = getMessageSignature(message);
    if (!signature) {
      return false;
    }

    return !baselineMessageSignatures.has(signature);
  });

  if (!changedMessages.length && messages.length > messageCountAtQuestion) {
    changedMessages = Array.from(messages).slice(messageCountAtQuestion);
  }

  return changedMessages
    .slice()
    .sort((a, b) => getMessageSortKey(b) - getMessageSortKey(a));
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
    const codeBlocks = message.querySelectorAll("pre code, pre, code");
    for (const block of codeBlocks) {
      const responseText = block.textContent.trim();
      if (responseText.includes("{") && processResponse(responseText, message)) {
        return;
      }
    }

    const messageText = message.textContent.trim();
    if (processResponse(messageText, message)) {
      return;
    }
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== "receiveQuestion") {
    return undefined;
  }

  resetObservation();
  activeQuestionId = message.questionId || message.question?.questionId || null;
  console.info(LOG_PREFIX, "Received question", activeQuestionId);

  const messages = getMessageNodes();
  messageCountAtQuestion = messages.length;
  baselineMessageSignatures = new Set(
    messages.map((messageNode) => getMessageSignature(messageNode)).filter(Boolean)
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
});

function resetObservation() {
  hasResponded = false;
  responseForwardingInProgress = false;
  responseCandidateKey = "";
  responseCandidateFirstSeenAt = 0;
  generationClearSince = 0;
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
}

async function insertQuestion(questionData) {
  const insertStartAt = Date.now();
  const promptText = buildPromptText(questionData);

  await waitForAssistantIdle();
  const chatInput = await waitForChatInput();
  if (!updateChatInputValue(chatInput, promptText)) {
    throw new Error("Unable to fill input area");
  }

  await submitPromptWithVerification(chatInput, promptText);
  logPerf(
    `${activeQuestionId || "unknown"} promptReady->sendClicked ${
      Date.now() - insertStartAt
    }ms`
  );
  startObserving();
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

  checkIntervalId = setInterval(checkForResponse, RESPONSE_CHECK_INTERVAL_MS);
}
