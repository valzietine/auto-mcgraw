let messageListener = null;
let isAutomating = false;
let lastIncorrectQuestion = null;
let lastCorrectAnswer = null;
let matchingPauseIntervalId = null;
let pendingQuestionId = null;
let questionSequence = 0;
let lastResponseFormatIssue = null;
const LOG_PREFIX = "[Auto-McGraw][mhe]";
const PERF_LOGGING_ENABLED = true;
const READINESS_POLL_INTERVAL_MS = 60;
const NEXT_STEP_RETRY_DELAY_MS = 240;
const QUESTION_TRANSITION_TIMEOUT_MS = 4500;
let scheduledNextStepTimeoutId = null;
let isCheckingNextStep = false;
const questionPerfMarks = new Map();
let pendingAdvancePerf = null;

function createQuestionId() {
  questionSequence += 1;
  return `mhe_${Date.now()}_${questionSequence}`;
}

function logPerf(message, ...args) {
  if (!PERF_LOGGING_ENABLED) return;
  console.info(LOG_PREFIX, "[perf]", message, ...args);
}

function ensureQuestionPerfEntry(questionId) {
  if (!questionId) return null;
  if (!questionPerfMarks.has(questionId)) {
    questionPerfMarks.set(questionId, { questionId });
  }
  return questionPerfMarks.get(questionId);
}

function markQuestionPerf(questionId, key, timestamp = Date.now()) {
  const perfEntry = ensureQuestionPerfEntry(questionId);
  if (!perfEntry) return null;
  perfEntry[key] = timestamp;
  return perfEntry;
}

function clearQuestionPerf(questionId) {
  if (!questionId) return;
  questionPerfMarks.delete(questionId);
}

function waitForCondition(
  predicate,
  timeout = 5000,
  pollIntervalMs = READINESS_POLL_INTERVAL_MS
) {
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

function waitForEnabledElement(selector, timeout = 5000) {
  return waitForCondition(() => {
    const element = document.querySelector(selector);
    return element && !isElementDisabled(element) ? element : null;
  }, timeout);
}

function scheduleCheckForNextStep(delayMs = 0, reason = "") {
  if (!isAutomating) return;

  if (scheduledNextStepTimeoutId !== null) {
    clearTimeout(scheduledNextStepTimeoutId);
  }

  scheduledNextStepTimeoutId = setTimeout(() => {
    scheduledNextStepTimeoutId = null;
    if (!isAutomating || isCheckingNextStep) return;
    checkForNextStep(reason);
  }, delayMs);
}

function setupMessageListener() {
  if (messageListener) {
    chrome.runtime.onMessage.removeListener(messageListener);
  }

  messageListener = (message, sender, sendResponse) => {
    if (message.type === "processChatGPTResponse") {
      const responseQuestionId = message.questionId || null;
      if (
        pendingQuestionId &&
        responseQuestionId &&
        responseQuestionId !== pendingQuestionId
      ) {
        console.warn(
          LOG_PREFIX,
          "Ignoring stale response",
          responseQuestionId,
          "pending",
          pendingQuestionId
        );
        sendResponse({ received: true, ignored: true });
        return true;
      }

      processChatGPTResponse(message.response, responseQuestionId);
      sendResponse({ received: true });
      return true;
    }

    if (message.type === "alertMessage") {
      alert(message.message);
      sendResponse({ received: true });
      return true;
    }

    if (message.type === "aiRequestTimeout") {
      const timeoutQuestionId = message.questionId || null;
      if (
        pendingQuestionId &&
        timeoutQuestionId &&
        timeoutQuestionId !== pendingQuestionId
      ) {
        sendResponse({ received: true, ignored: true });
        return true;
      }

      console.warn(
        LOG_PREFIX,
        "AI timeout received; clearing pending question",
        pendingQuestionId
      );
      pendingQuestionId = null;

      if (isAutomating) {
        scheduleCheckForNextStep(0, "ai_request_timeout");
      }

      sendResponse({ received: true });
      return true;
    }
  };

  chrome.runtime.onMessage.addListener(messageListener);
}

function handleTopicOverview() {
  const continueButton = document.querySelector(
    "awd-topic-overview-button-bar .next-button, .button-bar-wrapper .next-button"
  );

  if (
    continueButton &&
    continueButton.textContent.trim().toLowerCase().includes("continue")
  ) {
    continueButton.click();
    scheduleCheckForNextStep(NEXT_STEP_RETRY_DELAY_MS, "topic_overview_continue");

    return true;
  }
  return false;
}

function clearMatchingPauseWatcher() {
  if (matchingPauseIntervalId !== null) {
    clearInterval(matchingPauseIntervalId);
    matchingPauseIntervalId = null;
  }
}

function clearAutomationRuntimeState() {
  pendingQuestionId = null;
  pendingAdvancePerf = null;
  questionPerfMarks.clear();

  if (scheduledNextStepTimeoutId !== null) {
    clearTimeout(scheduledNextStepTimeoutId);
    scheduledNextStepTimeoutId = null;
  }
}

function isElementDisabled(element) {
  if (!element) return true;
  if (element.disabled) return true;
  if (element.getAttribute("aria-disabled") === "true") return true;
  return (
    element.classList.contains("disabled") ||
    element.classList.contains("is-disabled")
  );
}

function getNextButton() {
  return document.querySelector(".next-button");
}

function isQuestionCompleted(container) {
  if (!container) return false;

  if (
    container.querySelector(
      ".awd-probe-correctness.correct, .awd-probe-correctness.incorrect"
    )
  ) {
    return true;
  }

  if (container.querySelector(".correct-answer-container")) {
    return true;
  }

  const highConfidenceButton = document.querySelector(
    '[data-automation-id="confidence-buttons--high_confidence"]'
  );
  const nextButton = getNextButton();

  return (
    highConfidenceButton &&
    isElementDisabled(highConfidenceButton) &&
    nextButton &&
    !isElementDisabled(nextButton)
  );
}

function advanceCompletedQuestionIfNeeded(container) {
  if (!isQuestionCompleted(container)) return false;

  const nextButton = getNextButton();
  if (!nextButton || isElementDisabled(nextButton)) {
    console.info(LOG_PREFIX, "Question appears completed, waiting for next button");
    return false;
  }

  console.info(LOG_PREFIX, "Question already completed; advancing to next");
  const transitionSnapshot = getQuestionTransitionSnapshot(container);
  nextButton.click();

  waitForQuestionTransition(transitionSnapshot, QUESTION_TRANSITION_TIMEOUT_MS).finally(
    () => {
      scheduleCheckForNextStep(0, "advance_completed_question");
    }
  );

  return true;
}

function getQuestionSignature(container) {
  if (!container) return "";

  const questionType = detectQuestionType(container);
  const promptText =
    container.querySelector(".prompt")?.textContent?.trim() || "";

  return `${questionType}::${normalizeChoiceText(promptText)}`;
}

function getQuestionTransitionSnapshot(container) {
  if (!container) return null;

  return {
    signature: getQuestionSignature(container),
    promptText: normalizeChoiceText(
      container.querySelector(".prompt")?.textContent?.trim() || ""
    ),
    completed: isQuestionCompleted(container),
  };
}

function hasQuestionTransitioned(previousSnapshot) {
  if (!previousSnapshot) return false;

  const currentContainer = document.querySelector(".probe-container");
  if (!currentContainer) return false;

  const currentSignature = getQuestionSignature(currentContainer);
  if (
    previousSnapshot.signature &&
    currentSignature &&
    currentSignature !== previousSnapshot.signature
  ) {
    return true;
  }

  const currentPromptText = normalizeChoiceText(
    currentContainer.querySelector(".prompt")?.textContent?.trim() || ""
  );
  if (
    previousSnapshot.promptText &&
    currentPromptText &&
    currentPromptText !== previousSnapshot.promptText
  ) {
    return true;
  }

  const currentCompleted = isQuestionCompleted(currentContainer);
  if (previousSnapshot.completed && !currentCompleted) {
    return true;
  }

  return false;
}

async function waitForQuestionTransition(
  previousSnapshot,
  timeout = QUESTION_TRANSITION_TIMEOUT_MS
) {
  if (!previousSnapshot) return false;

  try {
    await waitForCondition(
      () => hasQuestionTransitioned(previousSnapshot),
      timeout,
      READINESS_POLL_INTERVAL_MS
    );
    return true;
  } catch (error) {
    return false;
  }
}

function pauseForManualMatchingAndResume(questionSignature) {
  if (!questionSignature) return;

  clearMatchingPauseWatcher();
  console.info(LOG_PREFIX, "Paused for manual intervention", questionSignature);

  matchingPauseIntervalId = setInterval(() => {
    if (!isAutomating) {
      clearMatchingPauseWatcher();
      return;
    }

    const currentContainer = document.querySelector(".probe-container");
    if (!currentContainer) return;

    const currentSignature = getQuestionSignature(currentContainer);
    if (currentSignature && currentSignature !== questionSignature) {
      console.info(
        LOG_PREFIX,
        "Detected question change after manual intervention",
        questionSignature,
        "->",
        currentSignature
      );
      clearMatchingPauseWatcher();

      scheduleCheckForNextStep(0, "manual_matching_resume");
    }
  }, 250);
}

function handleForcedLearning() {
  const forcedLearningAlert = document.querySelector(
    ".forced-learning .alert-error"
  );
  if (forcedLearningAlert) {
    const readButton = document.querySelector(
      '[data-automation-id="lr-tray_reading-button"]'
    );
    if (readButton) {
      readButton.click();

      waitForElement('[data-automation-id="reading-questions-button"]', 10000)
        .then((toQuestionsButton) => {
          toQuestionsButton.click();
          return waitForElement(".next-button", 10000);
        })
        .then((nextButton) => {
          const transitionSnapshot = getQuestionTransitionSnapshot(
            document.querySelector(".probe-container")
          );
          nextButton.click();
          if (isAutomating) {
            waitForQuestionTransition(
              transitionSnapshot,
              QUESTION_TRANSITION_TIMEOUT_MS
            ).finally(() => {
              scheduleCheckForNextStep(0, "forced_learning_advance");
            });
          }
        })
        .catch((error) => {
          console.error("Error in forced learning flow:", error);
          isAutomating = false;
          clearAutomationRuntimeState();
          clearMatchingPauseWatcher();
        });
      return true;
    }
  }
  return false;
}

function checkForNextStep(trigger = "direct") {
  if (!isAutomating) return;
  if (isCheckingNextStep) {
    scheduleCheckForNextStep(0, `${trigger}_dedupe`);
    return;
  }

  isCheckingNextStep = true;

  try {
    if (pendingQuestionId) {
      console.info(LOG_PREFIX, "Waiting for response", pendingQuestionId);
      return;
    }

    if (handleTopicOverview()) {
      return;
    }

    if (handleForcedLearning()) {
      return;
    }

    const container = document.querySelector(".probe-container");
    if (container && !container.querySelector(".forced-learning")) {
      if (advanceCompletedQuestionIfNeeded(container)) {
        return;
      }

      const qData = parseQuestion();
      if (qData) {
        const questionId = createQuestionId();
        qData.questionId = questionId;
        pendingQuestionId = questionId;
        markQuestionPerf(questionId, "dispatchedAt");
        console.info(LOG_PREFIX, "Dispatching question", questionId);

        if (pendingAdvancePerf?.nextClickedAt) {
          logPerf(
            `${pendingAdvancePerf.questionId || "unknown"} next->nextDispatch ${
              Date.now() - pendingAdvancePerf.nextClickedAt
            }ms`
          );
          clearQuestionPerf(pendingAdvancePerf.questionId);
          pendingAdvancePerf = null;
        }

        chrome.runtime.sendMessage({
          type: "sendQuestionToChatGPT",
          question: qData,
          questionId,
        });
      } else {
        scheduleCheckForNextStep(
          NEXT_STEP_RETRY_DELAY_MS,
          "question_not_ready_retry"
        );
      }
      return;
    }

    scheduleCheckForNextStep(NEXT_STEP_RETRY_DELAY_MS, "probe_container_absent");
  } finally {
    isCheckingNextStep = false;
  }
}

function detectQuestionType(container) {
  if (container.querySelector(".awd-probe-type-multiple_choice")) {
    return "multiple_choice";
  }
  if (container.querySelector(".awd-probe-type-true_false")) {
    return "true_false";
  }
  if (container.querySelector(".awd-probe-type-multiple_select")) {
    return "multiple_select";
  }
  if (container.querySelector(".awd-probe-type-fill_in_the_blank")) {
    return "fill_in_the_blank";
  }
  if (container.querySelector(".awd-probe-type-select_text")) {
    return "select_text";
  }
  if (
    container.querySelector(
      ".awd-probe-type-sortable, .sortable-component"
    )
  ) {
    return "ordering";
  }
  if (container.querySelector(".awd-probe-type-matching")) {
    return "matching";
  }
  return "";
}

function normalizeChoiceText(text) {
  if (typeof text !== "string") return "";

  return text
    .replace(/\u00a0/g, " ")
    .replace(/&amp;/gi, "&")
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.$/, "");
}

function isAnswerMatch(choiceText, answerText) {
  if (!choiceText || answerText === null || answerText === undefined) {
    return false;
  }

  const choice = String(choiceText).trim();
  const answer = String(answerText).trim();
  if (!choice || !answer) return false;

  if (choice === answer) return true;

  const choiceWithoutPeriod = choice.replace(/\.$/, "");
  const answerWithoutPeriod = answer.replace(/\.$/, "");
  if (choiceWithoutPeriod === answerWithoutPeriod) return true;

  if (choice === answer + ".") return true;

  return normalizeChoiceText(choice) === normalizeChoiceText(answer);
}

function extractCorrectAnswer() {
  const container = document.querySelector(".probe-container");
  if (!container) return null;

  const incorrectMarker = container.querySelector(
    ".awd-probe-correctness.incorrect"
  );
  if (!incorrectMarker) return null;

  const questionType = detectQuestionType(container);

  let questionText = "";
  const promptEl = container.querySelector(".prompt");

  if (questionType === "fill_in_the_blank" && promptEl) {
    const promptClone = promptEl.cloneNode(true);

    const spans = promptClone.querySelectorAll(
      "span.response-container, span.fitb-span, span.blank-label, span.correctness, span._visuallyHidden"
    );
    spans.forEach((span) => span.remove());

    const inputs = promptClone.querySelectorAll("input.fitb-input");
    inputs.forEach((input) => {
      const blankMarker = document.createTextNode("[BLANK]");
      input.parentNode.replaceChild(blankMarker, input);
    });

    questionText = promptClone.textContent.trim();
  } else {
    questionText = promptEl ? promptEl.textContent.trim() : "";
  }

  let correctAnswer = null;

  if (questionType === "multiple_choice" || questionType === "true_false") {
    try {
      const answerContainer = container.querySelector(
        ".answer-container .choiceText"
      );
      if (answerContainer) {
        correctAnswer = answerContainer.textContent.trim();
      } else {
        const correctAnswerContainer = container.querySelector(
          ".correct-answer-container"
        );
        if (correctAnswerContainer) {
          const answerText =
            correctAnswerContainer.querySelector(".choiceText");
          if (answerText) {
            correctAnswer = answerText.textContent.trim();
          } else {
            const answerDiv = correctAnswerContainer.querySelector(".choice");
            if (answerDiv) {
              correctAnswer = answerDiv.textContent.trim();
            }
          }
        }
      }
    } catch (e) {
      console.error("Error extracting multiple choice answer:", e);
    }
  } else if (questionType === "multiple_select") {
    try {
      const correctAnswersList = container.querySelectorAll(
        ".correct-answer-container .choice"
      );
      if (correctAnswersList && correctAnswersList.length > 0) {
        correctAnswer = Array.from(correctAnswersList).map((el) => {
          const choiceText = el.querySelector(".choiceText");
          return choiceText
            ? choiceText.textContent.trim()
            : el.textContent.trim();
        });
      }
    } catch (e) {
      console.error("Error extracting multiple select answers:", e);
    }
  } else if (questionType === "fill_in_the_blank") {
    try {
      const correctAnswersList = container.querySelectorAll(".correct-answers");

      if (correctAnswersList && correctAnswersList.length > 0) {
        if (correctAnswersList.length === 1) {
          const correctAnswerEl =
            correctAnswersList[0].querySelector(".correct-answer");
          if (correctAnswerEl) {
            correctAnswer = correctAnswerEl.textContent.trim();
          } else {
            const answerText = correctAnswersList[0].textContent.trim();
            if (answerText) {
              const match = answerText.match(/:\s*(.+)$/);
              correctAnswer = match ? match[1].trim() : answerText;
            }
          }
        } else {
          correctAnswer = Array.from(correctAnswersList).map((field) => {
            const correctAnswerEl = field.querySelector(".correct-answer");
            if (correctAnswerEl) {
              return correctAnswerEl.textContent.trim();
            } else {
              const answerText = field.textContent.trim();
              const match = answerText.match(/:\s*(.+)$/);
              return match ? match[1].trim() : answerText;
            }
          });
        }
      }
    } catch (e) {
      console.error("Error extracting fill in the blank answers:", e);
    }
  } else if (questionType === "select_text") {
    try {
      const correctAnswersList = Array.from(
        container.querySelectorAll(
          ".correct-answer-container .choice.-interactive, .correct-answer-container .choiceText, .correct-answer-container .choice"
        )
      )
        .map((el) => el.textContent.trim())
        .filter(Boolean);

      if (correctAnswersList.length === 1) {
        correctAnswer = correctAnswersList[0];
      } else if (correctAnswersList.length > 1) {
        correctAnswer = correctAnswersList;
      }
    } catch (e) {
      console.error("Error extracting select text answers:", e);
    }
  }

  if (questionType === "matching" || questionType === "ordering") {
    return null;
  }

  if (correctAnswer === null) {
    console.error("Failed to extract correct answer for", questionType);
    return null;
  }

  return {
    question: questionText,
    answer: correctAnswer,
    type: questionType,
  };
}

function cleanAnswer(answer) {
  if (!answer) return answer;

  if (Array.isArray(answer)) {
    return answer.map((item) => cleanAnswer(item));
  }

  if (typeof answer === "string") {
    let cleanedAnswer = answer.trim();

    cleanedAnswer = cleanedAnswer.replace(/^Field \d+:\s*/, "");

    if (cleanedAnswer.includes(" or ")) {
      cleanedAnswer = cleanedAnswer.split(" or ")[0].trim();
    }

    return cleanedAnswer;
  }

  return answer;
}

function tryParseAnswerArrayString(value) {
  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  if (!(trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : null;
  } catch (e) {
    return null;
  }
}

function flattenAnswerValues(value, output = []) {
  if (value === null || value === undefined) {
    return output;
  }

  if (Array.isArray(value)) {
    value.forEach((item) => flattenAnswerValues(item, output));
    return output;
  }

  if (typeof value === "string") {
    const parsedArray = tryParseAnswerArrayString(value);
    if (parsedArray) {
      flattenAnswerValues(parsedArray, output);
      return output;
    }

    const trimmed = value.trim();
    if (trimmed) {
      output.push(trimmed);
    }
    return output;
  }

  output.push(String(value));
  return output;
}

function splitCompoundAnswer(answerText) {
  if (typeof answerText !== "string") return [];

  const trimmed = answerText.trim();
  if (!trimmed) return [];

  let parts = trimmed
    .split(/\n|;|,/)
    .map((part) =>
      part
        .trim()
        .replace(/^[-*•]\s*/, "")
        .replace(/^\d+[\).\-\s]+/, "")
        .replace(/^["'`]|["'`]$/g, "")
        .trim()
    )
    .filter(Boolean);

  if (parts.length <= 1 && /\band\b/i.test(trimmed)) {
    parts = trimmed
      .split(/\band\b/i)
      .map((part) =>
        part
          .trim()
          .replace(/^[-*•]\s*/, "")
          .replace(/^\d+[\).\-\s]+/, "")
          .replace(/^["'`]|["'`]$/g, "")
          .trim()
      )
      .filter(Boolean);
  }

  return parts;
}

function splitOrderingAnswer(answerText) {
  if (typeof answerText !== "string") return [];

  return answerText
    .split(/\n|;|,/)
    .map((part) =>
      part
        .trim()
        .replace(/^[-*•]\s*/, "")
        .replace(/^choice\s+\d+[\).\-\s]*/i, "")
        .replace(/^\d+[\).\-\s]+/, "")
        .replace(/^["'`]|["'`]$/g, "")
        .trim()
    )
    .filter(Boolean);
}

function dedupeAnswers(answers) {
  const seen = new Set();
  const deduped = [];

  answers.forEach((answer) => {
    const normalized = normalizeChoiceText(answer).toLowerCase();
    if (!normalized || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    deduped.push(answer);
  });

  return deduped;
}

function getQuestionChoices(container, questionType) {
  if (questionType === "select_text") {
    return Array.from(
      container.querySelectorAll(".select-text-component .choice.-interactive")
    )
      .map((el) => el.textContent.trim())
      .filter(Boolean);
  }

  return Array.from(container.querySelectorAll(".choiceText"))
    .map((el) => el.textContent.trim())
    .filter(Boolean);
}

function getOrderingChoiceItems(container) {
  if (!container) return [];

  return Array.from(
    container.querySelectorAll(
      ".sortable-component .responses-container .choice-item, .sortable-component .choice-item"
    )
  );
}

function getOrderingChoiceText(choiceItem) {
  if (!choiceItem) return "";

  const contentEl =
    choiceItem.querySelector(".content") || choiceItem.querySelector("p");
  const rawText = contentEl ? contentEl.textContent : choiceItem.textContent;
  return normalizeChoiceText(rawText || "");
}

function getOrderingDragHandle(choiceItem) {
  if (!choiceItem) return null;

  if (choiceItem.matches?.("[data-react-beautiful-dnd-drag-handle]")) {
    return choiceItem;
  }

  return (
    choiceItem.querySelector("[data-react-beautiful-dnd-drag-handle]") ||
    choiceItem
  );
}

function parseOrderingAnswerReference(answerText, choiceTexts) {
  const normalizedAnswer = normalizeChoiceText(answerText);
  if (!normalizedAnswer) return "";

  const numericMatch = normalizedAnswer.match(/^choice\s*(\d+)$/i);
  const simpleNumericMatch = numericMatch
    ? numericMatch
    : normalizedAnswer.match(/^(\d+)$/);
  if (simpleNumericMatch) {
    const index = Number(simpleNumericMatch[1]) - 1;
    if (Number.isInteger(index) && index >= 0 && index < choiceTexts.length) {
      return choiceTexts[index];
    }
  }

  return normalizedAnswer;
}

function createKeyboardEvent(type, key, code, keyCode) {
  const event = new KeyboardEvent(type, {
    key,
    code,
    bubbles: true,
    cancelable: true,
    composed: true,
    keyCode,
    which: keyCode,
    charCode: keyCode,
  });

  try {
    Object.defineProperty(event, "keyCode", {
      get: () => keyCode,
    });
    Object.defineProperty(event, "which", {
      get: () => keyCode,
    });
  } catch (e) {
    // Ignore readonly property overrides in environments that block it.
  }

  return event;
}

function dispatchKeyboardSequence(target, key, code, keyCode) {
  if (!target) return;

  const keyDown = createKeyboardEvent("keydown", key, code, keyCode);
  const keyUp = createKeyboardEvent("keyup", key, code, keyCode);
  target.dispatchEvent(keyDown);
  target.dispatchEvent(keyUp);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function findOrderingChoiceIndex(choiceItems, answerText, startIndex = 0) {
  for (let index = startIndex; index < choiceItems.length; index += 1) {
    const choiceText = getOrderingChoiceText(choiceItems[index]);
    if (isAnswerMatch(choiceText, answerText)) {
      return index;
    }
  }

  const normalizedAnswer = normalizeChoiceText(answerText).toLowerCase();
  if (!normalizedAnswer) return -1;

  for (let index = startIndex; index < choiceItems.length; index += 1) {
    const normalizedChoice = getOrderingChoiceText(choiceItems[index]).toLowerCase();
    if (
      normalizedChoice &&
      (normalizedChoice.includes(normalizedAnswer) ||
        normalizedAnswer.includes(normalizedChoice))
    ) {
      return index;
    }
  }

  return -1;
}

async function moveOrderingChoiceToIndex(
  container,
  choiceItem,
  targetIndex,
  liftConfig = { key: " ", code: "Space", keyCode: 32 }
) {
  if (!container || !choiceItem || !container.contains(choiceItem)) {
    return false;
  }

  const movingText = getOrderingChoiceText(choiceItem);
  if (!movingText) {
    return false;
  }

  const getCurrentIndex = () =>
    getOrderingChoiceItems(container).findIndex((item) =>
      isAnswerMatch(getOrderingChoiceText(item), movingText)
    );

  const focusCurrentHandle = () => {
    const currentItems = getOrderingChoiceItems(container);
    const currentIndex = currentItems.findIndex((item) =>
      isAnswerMatch(getOrderingChoiceText(item), movingText)
    );
    if (currentIndex < 0) return null;

    const handle = getOrderingDragHandle(currentItems[currentIndex]);
    if (!handle) return null;

    if (typeof handle.focus === "function") {
      try {
        handle.focus({ preventScroll: true });
      } catch (e) {
        handle.focus();
      }
    }

    return handle;
  };

  const initialHandle = focusCurrentHandle();
  if (!initialHandle) {
    return false;
  }
  await delay(40);

  dispatchKeyboardSequence(
    initialHandle,
    liftConfig.key,
    liftConfig.code,
    liftConfig.keyCode
  );
  await delay(80);

  const maxMoves = 60;
  let moveCount = 0;
  let stagnantMoves = 0;
  while (moveCount < maxMoves) {
    const currentIndex = getCurrentIndex();
    if (currentIndex < 0 || currentIndex === targetIndex) {
      break;
    }

    const handle = focusCurrentHandle();
    if (!handle) {
      break;
    }

    if (currentIndex > targetIndex) {
      dispatchKeyboardSequence(handle, "ArrowUp", "ArrowUp", 38);
    } else {
      dispatchKeyboardSequence(handle, "ArrowDown", "ArrowDown", 40);
    }

    moveCount += 1;
    await delay(60);

    const nextIndex = getCurrentIndex();
    if (nextIndex === currentIndex) {
      stagnantMoves += 1;
      if (stagnantMoves >= 3) {
        break;
      }
    } else {
      stagnantMoves = 0;
    }
  }

  const dropHandle = focusCurrentHandle() || initialHandle;
  dispatchKeyboardSequence(
    dropHandle,
    liftConfig.key,
    liftConfig.code,
    liftConfig.keyCode
  );
  await delay(80);

  return getCurrentIndex() === targetIndex;
}

function isOrderingAligned(container, targetAnswers) {
  if (!container || !Array.isArray(targetAnswers) || targetAnswers.length === 0) {
    return false;
  }

  const currentOrder = getOrderingChoiceItems(container).map((item) =>
    getOrderingChoiceText(item)
  );

  const compareCount = Math.min(targetAnswers.length, currentOrder.length);
  for (let index = 0; index < compareCount; index += 1) {
    if (!isAnswerMatch(currentOrder[index], targetAnswers[index])) {
      return false;
    }
  }

  return true;
}

function getOrderingSnapshot(container) {
  return getOrderingChoiceItems(container)
    .map((item) => getOrderingChoiceText(item))
    .filter(Boolean);
}

async function applyOrderingAnswer(container, rawAnswers) {
  const choiceItems = getOrderingChoiceItems(container);
  if (!choiceItems.length) {
    console.warn(LOG_PREFIX, "Ordering question detected but no sortable choices found");
    return false;
  }

  const choiceTexts = choiceItems.map((item) => getOrderingChoiceText(item));
  const targetAnswers = rawAnswers
    .map((answer) => parseOrderingAnswerReference(answer, choiceTexts))
    .filter(Boolean);

  if (!targetAnswers.length) {
    console.warn(LOG_PREFIX, "Ordering question had no usable answers from AI");
    return false;
  }

  const reorderCount = Math.min(targetAnswers.length, choiceItems.length);
  const expectedOrder = targetAnswers.slice(0, reorderCount);
  console.info(LOG_PREFIX, "Ordering target sequence", expectedOrder);
  const liftStrategies = [
    { key: " ", code: "Space", keyCode: 32, label: "space" },
    { key: "Enter", code: "Enter", keyCode: 13, label: "enter" },
  ];

  const maxPasses = 3;
  for (let pass = 1; pass <= maxPasses; pass += 1) {
    if (isOrderingAligned(container, expectedOrder)) {
      return true;
    }

    for (let targetIndex = 0; targetIndex < reorderCount; targetIndex += 1) {
      const currentItems = getOrderingChoiceItems(container);
      const answerText = expectedOrder[targetIndex];
      const sourceIndex = findOrderingChoiceIndex(
        currentItems,
        answerText,
        targetIndex
      );

      if (sourceIndex < 0) {
        console.warn(LOG_PREFIX, "Unable to match ordering answer:", answerText);
        continue;
      }

      if (sourceIndex === targetIndex) {
        continue;
      }

      let moved = false;
      for (const strategy of liftStrategies) {
        const strategyItems = getOrderingChoiceItems(container);
        const strategySourceIndex = findOrderingChoiceIndex(
          strategyItems,
          answerText,
          targetIndex
        );
        if (strategySourceIndex < 0) {
          break;
        }

        moved = await moveOrderingChoiceToIndex(
          container,
          strategyItems[strategySourceIndex],
          targetIndex,
          strategy
        );
        if (moved) {
          break;
        }
      }

      if (!moved) {
        console.warn(
          LOG_PREFIX,
          "Ordering move may not have completed:",
          answerText,
          "->",
          targetIndex + 1,
          "current order:",
          getOrderingSnapshot(container)
        );
      }
    }

    if (!isOrderingAligned(container, expectedOrder)) {
      console.info(
        LOG_PREFIX,
        `Ordering pass ${pass} incomplete`,
        getOrderingSnapshot(container)
      );
    }
  }

  return isOrderingAligned(container, expectedOrder);
}

function getMatchingComponent(container) {
  if (!container) return null;
  return container.querySelector(".matching-component");
}

function getMatchingRows(container) {
  const matchingComponent = getMatchingComponent(container);
  if (!matchingComponent) return [];

  return Array.from(
    matchingComponent.querySelectorAll(".responses-container .match-row")
  );
}

function getMatchingPromptText(matchRow) {
  if (!matchRow) return "";
  const promptContent =
    matchRow.querySelector(".match-prompt .content") ||
    matchRow.querySelector(".match-prompt");
  const rawText = promptContent ? promptContent.textContent : "";
  return normalizeChoiceText(rawText || "");
}

function getMatchingChoiceText(choiceItem) {
  if (!choiceItem) return "";

  const contentEl =
    choiceItem.querySelector(".content") || choiceItem.querySelector("p");
  const rawText = contentEl ? contentEl.textContent : choiceItem.textContent;
  return normalizeChoiceText(rawText || "");
}

function getMatchingChoiceItems(container) {
  const matchingComponent = getMatchingComponent(container);
  if (!matchingComponent) return [];

  return Array.from(
    matchingComponent.querySelectorAll(
      '.choice-item-wrapper[id^="choices:"]:not(.-placeholder)'
    )
  );
}

function getMatchingDragHandle(choiceItem) {
  if (!choiceItem) return null;

  if (choiceItem.matches?.("[data-react-beautiful-dnd-drag-handle]")) {
    return choiceItem;
  }

  return (
    choiceItem.querySelector("[data-react-beautiful-dnd-drag-handle]") ||
    choiceItem
  );
}

function getMatchingPoolChoiceItems(container) {
  const matchingComponent = getMatchingComponent(container);
  if (!matchingComponent) return [];

  return Array.from(
    matchingComponent.querySelectorAll(
      '.choices-container .choice-item-wrapper[id^="choices:"]:not(.-placeholder)'
    )
  );
}

function getMatchingRowChoiceItem(matchRow) {
  if (!matchRow) return null;

  return matchRow.querySelector(
    '.match-single-response-wrapper .choice-item-wrapper[id^="choices:"]:not(.-placeholder)'
  );
}

function getMatchingChoiceLocation(container, choiceText) {
  if (!container || !choiceText) {
    return null;
  }

  const rows = getMatchingRows(container);
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const rowChoiceItem = getMatchingRowChoiceItem(rows[rowIndex]);
    if (!rowChoiceItem) continue;

    const rowChoiceText = getMatchingChoiceText(rowChoiceItem);
    if (isAnswerMatch(rowChoiceText, choiceText)) {
      return {
        area: "row",
        rowIndex,
        poolIndex: -1,
        item: rowChoiceItem,
      };
    }
  }

  const poolItems = getMatchingPoolChoiceItems(container);
  for (let poolIndex = 0; poolIndex < poolItems.length; poolIndex += 1) {
    const poolChoiceText = getMatchingChoiceText(poolItems[poolIndex]);
    if (isAnswerMatch(poolChoiceText, choiceText)) {
      return {
        area: "pool",
        rowIndex: -1,
        poolIndex,
        item: poolItems[poolIndex],
      };
    }
  }

  return null;
}

function parseMatchingAnswerReference(referenceText, candidateTexts, label = "") {
  if (!candidateTexts || candidateTexts.length === 0) return "";

  const normalizedReference = normalizeChoiceText(String(referenceText || ""));
  if (!normalizedReference) return "";

  const parseNumericReference = (value) => {
    const match = value.match(/^#?(\d+)$/);
    if (!match) return "";

    const index = Number(match[1]) - 1;
    if (Number.isInteger(index) && index >= 0 && index < candidateTexts.length) {
      return candidateTexts[index];
    }

    return "";
  };

  let resolved = parseNumericReference(normalizedReference);
  if (resolved) return resolved;

  const promptPrefixes = /^(?:prompt|row|left)\s*#?\s*/i;
  const choicePrefixes = /^(?:choice|option|item|right|match)\s*#?\s*/i;
  const prefixRegex = label === "prompt" ? promptPrefixes : choicePrefixes;
  const strippedReference = normalizedReference.replace(prefixRegex, "").trim();

  resolved = parseNumericReference(strippedReference);
  if (resolved) return resolved;

  const exactMatch = candidateTexts.find((candidate) =>
    isAnswerMatch(candidate, strippedReference)
  );
  if (exactMatch) return exactMatch;

  const normalizedTarget = normalizeChoiceText(strippedReference).toLowerCase();
  if (!normalizedTarget) return "";

  const normalizedCandidateMatch = candidateTexts.find((candidate) => {
    return normalizeChoiceText(candidate).toLowerCase() === normalizedTarget;
  });
  if (normalizedCandidateMatch) return normalizedCandidateMatch;

  const partialMatch = candidateTexts.find((candidate) => {
    const normalizedCandidate = normalizeChoiceText(candidate).toLowerCase();
    return (
      normalizedCandidate &&
      (normalizedCandidate.includes(normalizedTarget) ||
        normalizedTarget.includes(normalizedCandidate))
    );
  });

  return partialMatch || "";
}

function splitMatchingAnswerSegments(answerText) {
  if (typeof answerText !== "string") return [];

  const initialSegments = answerText
    .split(/\n|;/)
    .map((segment) =>
      segment
        .trim()
        .replace(/^[-*•]\s*/, "")
        .replace(/^["'`]|["'`]$/g, "")
        .trim()
    )
    .filter(Boolean);

  const expandedSegments = [];
  initialSegments.forEach((segment) => {
    const delimiterCount = (segment.match(/->|=>|:/g) || []).length;
    if (segment.includes(",") && delimiterCount > 1) {
      segment
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean)
        .forEach((part) => expandedSegments.push(part));
      return;
    }

    expandedSegments.push(segment);
  });

  return expandedSegments;
}

function parseMatchingPairString(answerText) {
  if (typeof answerText !== "string") return null;

  let cleanedText = answerText
    .trim()
    .replace(/^[-*•]\s*/, "")
    .replace(/^["'`]|["'`]$/g, "")
    .trim();
  if (!/(?:->|=>|:)/.test(cleanedText)) {
    cleanedText = cleanedText.replace(/^\d+[\.)]\s+/, "").trim();
  }
  if (!cleanedText) return null;

  const arrowMatch = cleanedText.match(/^(.*?)\s*(?:->|=>)\s*(.+)$/);
  if (arrowMatch) {
    return {
      promptRef: arrowMatch[1].trim(),
      choiceRef: arrowMatch[2].trim(),
    };
  }

  const colonMatch = cleanedText.match(/^(.*?)\s*:\s*(.+)$/);
  if (colonMatch) {
    return {
      promptRef: colonMatch[1].trim(),
      choiceRef: colonMatch[2].trim(),
    };
  }

  return null;
}

function collectMatchingAnswerEntries(rawAnswer, output) {
  if (!output || rawAnswer === null || rawAnswer === undefined) {
    return;
  }

  if (Array.isArray(rawAnswer)) {
    rawAnswer.forEach((entry) => collectMatchingAnswerEntries(entry, output));
    return;
  }

  if (typeof rawAnswer === "object") {
    const promptCandidate =
      rawAnswer.prompt ??
      rawAnswer.left ??
      rawAnswer.source ??
      rawAnswer.from ??
      rawAnswer.key;
    const choiceCandidate =
      rawAnswer.choice ??
      rawAnswer.match ??
      rawAnswer.right ??
      rawAnswer.target ??
      rawAnswer.to ??
      rawAnswer.answer ??
      rawAnswer.value;

    if (promptCandidate !== undefined && choiceCandidate !== undefined) {
      output.pairs.push({
        promptRef: String(promptCandidate),
        choiceRef: String(choiceCandidate),
      });
      return;
    }

    Object.entries(rawAnswer).forEach(([promptRef, choiceRef]) => {
      output.pairs.push({
        promptRef: String(promptRef),
        choiceRef: String(choiceRef),
      });
    });
    return;
  }

  if (typeof rawAnswer === "string") {
    const parsedArray = tryParseAnswerArrayString(rawAnswer);
    if (parsedArray) {
      collectMatchingAnswerEntries(parsedArray, output);
      return;
    }

    const segments = splitMatchingAnswerSegments(rawAnswer);
    if (!segments.length) {
      const cleaned = normalizeChoiceText(rawAnswer);
      if (cleaned) {
        output.rawStrings.push(cleaned);
        output.sequentialChoices.push(cleaned);
      }
      return;
    }

    segments.forEach((segment) => {
      const pair = parseMatchingPairString(segment);
      if (pair) {
        output.pairs.push(pair);
      } else {
        const cleanedSegment = normalizeChoiceText(segment);
        if (cleanedSegment) {
          output.rawStrings.push(cleanedSegment);
          output.sequentialChoices.push(cleanedSegment);
        }
      }
    });
    return;
  }

  const normalizedPrimitive = normalizeChoiceText(String(rawAnswer));
  if (normalizedPrimitive) {
    output.rawStrings.push(normalizedPrimitive);
    output.sequentialChoices.push(normalizedPrimitive);
  }
}

function normalizeMatchingTargets(container, rawAnswer) {
  const rows = getMatchingRows(container);
  if (!rows.length) return [];

  const prompts = rows.map((row) => getMatchingPromptText(row));
  const choiceTexts = dedupeAnswers(
    getMatchingChoiceItems(container)
      .map((item) => getMatchingChoiceText(item))
      .filter(Boolean)
  );
  if (!prompts.length || !choiceTexts.length) return [];

  const collected = {
    pairs: [],
    sequentialChoices: [],
    rawStrings: [],
  };
  collectMatchingAnswerEntries(rawAnswer, collected);

  const targetByRow = new Map();
  collected.pairs.forEach((pair) => {
    const promptText = parseMatchingAnswerReference(
      pair.promptRef,
      prompts,
      "prompt"
    );
    const choiceText = parseMatchingAnswerReference(
      pair.choiceRef,
      choiceTexts,
      "choice"
    );
    if (!promptText || !choiceText) return;

    const rowIndex = prompts.findIndex((prompt) => isAnswerMatch(prompt, promptText));
    if (rowIndex < 0 || targetByRow.has(rowIndex)) return;

    targetByRow.set(rowIndex, {
      rowIndex,
      promptText: prompts[rowIndex],
      choiceText,
    });
  });

  if (targetByRow.size === 0 && collected.sequentialChoices.length === prompts.length) {
    const orderedChoices = collected.sequentialChoices
      .map((choiceRef) =>
        parseMatchingAnswerReference(choiceRef, choiceTexts, "choice")
      )
      .filter(Boolean);

    if (orderedChoices.length === prompts.length) {
      orderedChoices.forEach((choiceText, rowIndex) => {
        targetByRow.set(rowIndex, {
          rowIndex,
          promptText: prompts[rowIndex],
          choiceText,
        });
      });
    }
  }

  return prompts.map((promptText, rowIndex) => {
    const target = targetByRow.get(rowIndex);
    return {
      rowIndex,
      promptText,
      choiceText: target ? target.choiceText : "",
    };
  });
}

function getMatchingSnapshot(container) {
  return getMatchingRows(container).map((row, rowIndex) => {
    const rowChoiceItem = getMatchingRowChoiceItem(row);
    return {
      rowIndex,
      promptText: getMatchingPromptText(row),
      choiceText: rowChoiceItem ? getMatchingChoiceText(rowChoiceItem) : "",
    };
  });
}

function isMatchingAligned(container, targetsByRow) {
  if (!container || !Array.isArray(targetsByRow) || targetsByRow.length === 0) {
    return false;
  }

  const rows = getMatchingRows(container);
  if (rows.length !== targetsByRow.length) {
    return false;
  }

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const target = targetsByRow[rowIndex];
    if (!target || !target.choiceText) {
      return false;
    }

    const currentChoice = getMatchingChoiceText(getMatchingRowChoiceItem(rows[rowIndex]));
    if (!isAnswerMatch(currentChoice, target.choiceText)) {
      return false;
    }
  }

  return true;
}

function isSameMatchingLocation(beforeLocation, afterLocation) {
  if (!beforeLocation || !afterLocation) return false;

  return (
    beforeLocation.area === afterLocation.area &&
    beforeLocation.rowIndex === afterLocation.rowIndex &&
    beforeLocation.poolIndex === afterLocation.poolIndex
  );
}

async function moveMatchingChoiceToRow(
  container,
  choiceText,
  targetRowIndex,
  liftConfig = {
    key: " ",
    code: "Space",
    keyCode: 32,
    poolDirection: "ArrowUp",
    label: "space-up",
  }
) {
  if (!container || !choiceText || targetRowIndex < 0) {
    return false;
  }

  const getCurrentLocation = () => getMatchingChoiceLocation(container, choiceText);

  const focusCurrentHandle = () => {
    const currentLocation = getCurrentLocation();
    if (!currentLocation?.item) return null;

    const handle = getMatchingDragHandle(currentLocation.item);
    if (!handle) return null;

    if (typeof handle.focus === "function") {
      try {
        handle.focus({ preventScroll: true });
      } catch (e) {
        handle.focus();
      }
    }

    return handle;
  };

  const initialLocation = getCurrentLocation();
  if (!initialLocation) {
    return false;
  }
  if (initialLocation.rowIndex === targetRowIndex) {
    return true;
  }

  const initialHandle = focusCurrentHandle();
  if (!initialHandle) {
    return false;
  }
  await delay(40);

  dispatchKeyboardSequence(
    initialHandle,
    liftConfig.key,
    liftConfig.code,
    liftConfig.keyCode
  );
  await delay(80);

  const maxMoves = 90;
  let moveCount = 0;
  let stagnantMoves = 0;

  while (moveCount < maxMoves) {
    const currentLocation = getCurrentLocation();
    if (!currentLocation || currentLocation.rowIndex === targetRowIndex) {
      break;
    }

    const handle = focusCurrentHandle();
    if (!handle) {
      break;
    }

    let movementKey = "ArrowUp";
    let movementCode = "ArrowUp";
    let movementKeyCode = 38;
    if (currentLocation.area === "row") {
      if (currentLocation.rowIndex < targetRowIndex) {
        movementKey = "ArrowDown";
        movementCode = "ArrowDown";
        movementKeyCode = 40;
      }
    } else if (liftConfig.poolDirection === "ArrowDown") {
      movementKey = "ArrowDown";
      movementCode = "ArrowDown";
      movementKeyCode = 40;
    }

    dispatchKeyboardSequence(handle, movementKey, movementCode, movementKeyCode);
    moveCount += 1;
    await delay(70);

    const nextLocation = getCurrentLocation();
    if (nextLocation && isSameMatchingLocation(currentLocation, nextLocation)) {
      stagnantMoves += 1;
      if (stagnantMoves >= 4) {
        break;
      }
    } else {
      stagnantMoves = 0;
    }
  }

  const dropHandle = focusCurrentHandle() || initialHandle;
  dispatchKeyboardSequence(
    dropHandle,
    liftConfig.key,
    liftConfig.code,
    liftConfig.keyCode
  );
  await delay(90);

  const finalLocation = getCurrentLocation();
  return Boolean(finalLocation && finalLocation.rowIndex === targetRowIndex);
}

function formatMatchingTargetsForAlert(container, rawAnswer) {
  const resolvedTargets = normalizeMatchingTargets(container, rawAnswer);
  const resolvedLines = resolvedTargets
    .filter((target) => target.choiceText)
    .map((target) => `${target.promptText} -> ${target.choiceText}`);
  if (resolvedLines.length > 0) {
    return resolvedLines;
  }

  const collected = {
    pairs: [],
    sequentialChoices: [],
    rawStrings: [],
  };
  collectMatchingAnswerEntries(rawAnswer, collected);

  const pairLines = collected.pairs
    .map((pair) => {
      const promptRef = normalizeChoiceText(pair.promptRef);
      const choiceRef = normalizeChoiceText(pair.choiceRef);
      if (!promptRef || !choiceRef) return "";
      return `${promptRef} -> ${choiceRef}`;
    })
    .filter(Boolean);

  const fallbackLines = dedupeAnswers(
    pairLines.concat(collected.sequentialChoices, collected.rawStrings).filter(Boolean)
  );

  return fallbackLines;
}

async function applyMatchingAnswer(container, rawAnswer) {
  const rows = getMatchingRows(container);
  if (!rows.length) {
    console.warn(LOG_PREFIX, "Matching question detected but no response rows found");
    return false;
  }

  const targetsByRow = normalizeMatchingTargets(container, rawAnswer);
  if (!targetsByRow.length) {
    console.warn(LOG_PREFIX, "Matching question had no usable answers from AI");
    return false;
  }

  if (targetsByRow.some((target) => !target.choiceText)) {
    console.warn(LOG_PREFIX, "Matching targets were incomplete", targetsByRow);
    return false;
  }

  console.info(
    LOG_PREFIX,
    "Matching target sequence",
    targetsByRow.map((target) => `${target.promptText} -> ${target.choiceText}`)
  );

  const liftStrategies = [
    {
      key: " ",
      code: "Space",
      keyCode: 32,
      poolDirection: "ArrowUp",
      label: "space-up",
    },
    {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      poolDirection: "ArrowUp",
      label: "enter-up",
    },
    {
      key: " ",
      code: "Space",
      keyCode: 32,
      poolDirection: "ArrowDown",
      label: "space-down",
    },
    {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      poolDirection: "ArrowDown",
      label: "enter-down",
    },
  ];

  const maxPasses = 4;
  for (let pass = 1; pass <= maxPasses; pass += 1) {
    if (isMatchingAligned(container, targetsByRow)) {
      return true;
    }

    for (let rowIndex = 0; rowIndex < targetsByRow.length; rowIndex += 1) {
      const target = targetsByRow[rowIndex];
      if (!target.choiceText) {
        continue;
      }

      const currentLocation = getMatchingChoiceLocation(container, target.choiceText);
      if (!currentLocation) {
        console.warn(
          LOG_PREFIX,
          "Unable to locate matching choice:",
          target.choiceText,
          "snapshot:",
          getMatchingSnapshot(container)
        );
        continue;
      }

      if (currentLocation.rowIndex === rowIndex) {
        continue;
      }

      let moved = false;
      for (const strategy of liftStrategies) {
        const strategyLocation = getMatchingChoiceLocation(
          container,
          target.choiceText
        );
        if (!strategyLocation) {
          break;
        }
        if (strategyLocation.rowIndex === rowIndex) {
          moved = true;
          break;
        }

        moved = await moveMatchingChoiceToRow(
          container,
          target.choiceText,
          rowIndex,
          strategy
        );
        if (moved) {
          break;
        }
      }

      if (!moved) {
        console.warn(
          LOG_PREFIX,
          "Matching move may not have completed:",
          `${target.promptText} -> ${target.choiceText}`,
          "snapshot:",
          getMatchingSnapshot(container)
        );
      }
    }

    if (!isMatchingAligned(container, targetsByRow)) {
      console.info(
        LOG_PREFIX,
        `Matching pass ${pass} incomplete`,
        getMatchingSnapshot(container)
      );
    }
  }

  return isMatchingAligned(container, targetsByRow);
}

function extractChoicesFromCombinedAnswer(answerText, questionChoices) {
  if (typeof answerText !== "string" || questionChoices.length === 0) {
    return [];
  }

  const normalizedAnswer = normalizeChoiceText(answerText).toLowerCase();
  if (!normalizedAnswer) return [];

  return questionChoices.filter((choice) => {
    const normalizedChoice = normalizeChoiceText(choice).toLowerCase();
    return normalizedChoice && normalizedAnswer.includes(normalizedChoice);
  });
}

function normalizeResponseAnswers(rawAnswer, questionType, container) {
  if (questionType === "matching") {
    return formatMatchingTargetsForAlert(container, rawAnswer);
  }

  const flattenedAnswers = flattenAnswerValues(rawAnswer);
  if (flattenedAnswers.length === 0) return [];

  if (questionType === "ordering") {
    if (flattenedAnswers.length === 1) {
      const splitAnswers = splitOrderingAnswer(flattenedAnswers[0]);
      if (splitAnswers.length > 1) {
        return splitAnswers.map((answer) => String(answer).trim()).filter(Boolean);
      }
    }

    return flattenedAnswers
      .map((answer) => String(answer).trim())
      .filter(Boolean);
  }

  const isMultiChoiceType =
    questionType === "multiple_select" || questionType === "select_text";

  if (isMultiChoiceType && flattenedAnswers.length === 1) {
    const combinedAnswer = flattenedAnswers[0];
    const questionChoices = getQuestionChoices(container, questionType);
    const extractedChoices = extractChoicesFromCombinedAnswer(
      combinedAnswer,
      questionChoices
    );

    if (extractedChoices.length > 0) {
      return dedupeAnswers(extractedChoices);
    }

    const splitAnswers = splitCompoundAnswer(combinedAnswer);
    if (splitAnswers.length > 1) {
      return dedupeAnswers(splitAnswers);
    }
  }

  return dedupeAnswers(flattenedAnswers);
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
    const normalized = normalizeChoiceText(value.replace(/\\"/g, '"'));
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
    const answer = normalizeChoiceText(raw.replace(/\\"/g, '"'));
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
    const answer = normalizeChoiceText(bareMatch[1].replace(/^["']|["']$/g, ""));
    return answer || null;
  }

  return null;
}

function parseAiResponse(responseText) {
  const normalizedText = stripCodeFences(responseText);
  if (!normalizedText) {
    throw new Error("AI response was empty");
  }

  try {
    const parsed = JSON.parse(normalizedText);
    if (
      parsed &&
      Object.prototype.hasOwnProperty.call(parsed, "answer") &&
      parsed.answer !== undefined &&
      parsed.answer !== null
    ) {
      return parsed;
    }
  } catch (parseError) {
    const extractedAnswer = extractAnswerFromMalformedResponse(normalizedText);
    if (extractedAnswer === null) {
      throw parseError;
    }

    return {
      answer: extractedAnswer,
      explanation: "",
    };
  }

  const extractedAnswer = extractAnswerFromMalformedResponse(normalizedText);
  if (extractedAnswer !== null) {
    return {
      answer: extractedAnswer,
      explanation: "",
    };
  }

  throw new Error("AI response missing answer field");
}

async function processChatGPTResponse(responseText, responseQuestionId = null) {
  try {
    if (
      pendingQuestionId &&
      responseQuestionId &&
      responseQuestionId !== pendingQuestionId
    ) {
      console.warn(
        LOG_PREFIX,
        "Ignoring mismatched response",
        responseQuestionId,
        "pending",
        pendingQuestionId
      );
      return;
    }

    const activeQuestionId = responseQuestionId || pendingQuestionId || null;
    if (pendingQuestionId) {
      console.info(LOG_PREFIX, "Processing response", pendingQuestionId);
    }
    if (activeQuestionId) {
      markQuestionPerf(activeQuestionId, "responseReceivedAt");
    }
    pendingQuestionId = null;

    if (handleTopicOverview()) {
      return;
    }

    if (handleForcedLearning()) {
      return;
    }

    const container = document.querySelector(".probe-container");
    if (!container) return;
    const questionType = detectQuestionType(container);
    const response = parseAiResponse(responseText);
    const answers = normalizeResponseAnswers(
      response.answer,
      questionType,
      container
    );
    lastResponseFormatIssue = null;

    lastIncorrectQuestion = null;
    lastCorrectAnswer = null;

    if (questionType === "matching") {
      const applied = await applyMatchingAnswer(container, response.answer);
      if (!applied) {
        const questionSignature = getQuestionSignature(container);
        alert(
          "Matching Question Solution:\n\n" +
            (answers.length ? answers.join("\n") : "No confident matches parsed.") +
            "\n\nPlease input these matches manually, then click high confidence and next. Automation will resume after you move to the next question."
        );

        if (isAutomating) {
          pauseForManualMatchingAndResume(questionSignature);
        }

        return;
      }
    } else if (questionType === "fill_in_the_blank") {
      const inputs = container.querySelectorAll("input.fitb-input");
      inputs.forEach((input, index) => {
        if (answers[index]) {
          input.value = answers[index];
          input.dispatchEvent(new Event("input", { bubbles: true }));
        }
      });
    } else if (questionType === "select_text") {
      const choices = container.querySelectorAll(
        ".select-text-component .choice.-interactive"
      );

      choices.forEach((choice) => {
        const choiceText = choice.textContent.trim();
        if (!choiceText) return;

        const shouldBeSelected = answers.some((ans) =>
          isAnswerMatch(choiceText, ans)
        );

        if (shouldBeSelected) {
          choice.click();
        }
      });
    } else if (questionType === "ordering") {
      const applied = await applyOrderingAnswer(container, answers);
      if (!applied) {
        const questionSignature = getQuestionSignature(container);
        alert(
          "Ordering Question Solution:\n\n" +
            answers.map((answer, index) => `${index + 1}. ${answer}`).join("\n") +
            "\n\nPlease reorder these manually, then click high confidence and next. Automation will resume after you move to the next question."
        );

        if (isAutomating) {
          pauseForManualMatchingAndResume(questionSignature);
        }

        return;
      }
    } else {
      const choices = container.querySelectorAll(
        'input[type="radio"], input[type="checkbox"]'
      );

      choices.forEach((choice) => {
        const label = choice.closest("label");
        if (label) {
          const choiceText = label
            .querySelector(".choiceText")
            ?.textContent.trim();
          if (choiceText) {
            const shouldBeSelected = answers.some((ans) =>
              isAnswerMatch(choiceText, ans)
            );

            if (shouldBeSelected) {
              choice.click();
            }
          }
        }
      });
    }

    if (activeQuestionId) {
      const perfEntry = markQuestionPerf(activeQuestionId, "answerAppliedAt");
      if (perfEntry?.responseReceivedAt) {
        logPerf(
          `${activeQuestionId} aiResponse->answerApplied ${
            perfEntry.answerAppliedAt - perfEntry.responseReceivedAt
          }ms`
        );
      }
    }

    if (isAutomating) {
      try {
        const confidenceButton = await waitForEnabledElement(
          '[data-automation-id="confidence-buttons--high_confidence"]',
          10000
        );
        confidenceButton.click();
        const confidenceClickedAt = Date.now();

        if (activeQuestionId) {
          const perfEntry = markQuestionPerf(
            activeQuestionId,
            "confidenceClickedAt",
            confidenceClickedAt
          );
          if (perfEntry?.answerAppliedAt) {
            logPerf(
              `${activeQuestionId} answerApplied->confidence ${
                confidenceClickedAt - perfEntry.answerAppliedAt
              }ms`
            );
          }
        }

        try {
          await waitForCondition(() => {
            const liveContainer = document.querySelector(".probe-container");
            if (!liveContainer) return false;

            const hasCorrectness = Boolean(
              liveContainer.querySelector(
                ".awd-probe-correctness.correct, .awd-probe-correctness.incorrect, .correct-answer-container"
              )
            );
            const nextButton = getNextButton();
            if (hasCorrectness) return true;
            return nextButton && !isElementDisabled(nextButton);
          }, 6000);
        } catch (error) {}

        const latestContainer = document.querySelector(".probe-container") || container;
        const incorrectMarker = latestContainer.querySelector(
          ".awd-probe-correctness.incorrect"
        );
        if (incorrectMarker) {
          const correctionData = extractCorrectAnswer();
          if (correctionData && correctionData.answer) {
            lastIncorrectQuestion = correctionData.question;
            lastCorrectAnswer = cleanAnswer(correctionData.answer);
            console.log(
              "Found incorrect answer. Correct answer is:",
              lastCorrectAnswer
            );
          }
        }

        const transitionSnapshot = getQuestionTransitionSnapshot(latestContainer);
        const nextButton = await waitForEnabledElement(".next-button", 10000);
        nextButton.click();
        const nextClickedAt = Date.now();

        if (activeQuestionId) {
          const perfEntry = markQuestionPerf(
            activeQuestionId,
            "nextClickedAt",
            nextClickedAt
          );
          if (perfEntry?.confidenceClickedAt) {
            logPerf(
              `${activeQuestionId} confidence->next ${
                nextClickedAt - perfEntry.confidenceClickedAt
              }ms`
            );
          }
          pendingAdvancePerf = {
            questionId: activeQuestionId,
            nextClickedAt,
          };
        }

        await waitForQuestionTransition(
          transitionSnapshot,
          QUESTION_TRANSITION_TIMEOUT_MS
        );
        scheduleCheckForNextStep(0, "post_answer_next");
      } catch (error) {
        console.error("Automation error:", error);
        isAutomating = false;
        clearAutomationRuntimeState();
        clearMatchingPauseWatcher();
      }
    }
  } catch (e) {
    console.error("Error processing response:", e);
    pendingQuestionId = null;
    if (e?.message?.includes("answer field")) {
      lastResponseFormatIssue =
        'Your previous response did not include the required "answer" field. You must respond with a valid JSON object containing "answer" and "explanation".';
    } else {
      lastResponseFormatIssue =
        'Your previous response was not valid JSON. Respond with only a valid JSON object containing "answer" and "explanation".';
    }

    if (isAutomating) {
      scheduleCheckForNextStep(NEXT_STEP_RETRY_DELAY_MS, "response_parse_retry");
    }
  }
}

function addAssistantButton() {
  waitForElement("awd-header .header__navigation").then((headerNav) => {
    const buttonContainer = document.createElement("div");
    buttonContainer.style.display = "flex";
    buttonContainer.style.marginLeft = "10px";

    chrome.storage.sync.get("aiModel", function (data) {
      const aiModel = data.aiModel || "chatgpt";
      let modelName = "ChatGPT";

      if (aiModel === "gemini") {
        modelName = "Gemini";
      } else if (aiModel === "deepseek") {
        modelName = "DeepSeek";
      }

      const btn = document.createElement("button");
      btn.textContent = `Ask ${modelName}`;
      btn.classList.add("btn", "btn-secondary");
      btn.style.borderTopRightRadius = "0";
      btn.style.borderBottomRightRadius = "0";
      btn.addEventListener("click", () => {
        if (isAutomating) {
          isAutomating = false;
          clearAutomationRuntimeState();
          lastResponseFormatIssue = null;
          clearMatchingPauseWatcher();
          chrome.storage.sync.get("aiModel", function (data) {
            const currentModel = data.aiModel || "chatgpt";
            let currentModelName = "ChatGPT";

            if (currentModel === "gemini") {
              currentModelName = "Gemini";
            } else if (currentModel === "deepseek") {
              currentModelName = "DeepSeek";
            }

            btn.textContent = `Ask ${currentModelName}`;
          });
        } else {
          const proceed = confirm(
            "Start automated answering? Click OK to begin, or Cancel to stop."
          );
          if (proceed) {
            isAutomating = true;
            pendingQuestionId = null;
            lastResponseFormatIssue = null;
            pendingAdvancePerf = null;
            questionPerfMarks.clear();
            clearMatchingPauseWatcher();
            btn.textContent = "Stop Automation";
            scheduleCheckForNextStep(0, "manual_start");
          }
        }
      });

      const settingsBtn = document.createElement("button");
      settingsBtn.classList.add("btn", "btn-secondary");
      settingsBtn.style.borderTopLeftRadius = "0";
      settingsBtn.style.borderBottomLeftRadius = "0";
      settingsBtn.style.borderLeft = "1px solid rgba(0,0,0,0.2)";
      settingsBtn.style.padding = "6px 10px";
      settingsBtn.title = "Auto-McGraw Settings";
      settingsBtn.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="3"></circle>
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
        </svg>
      `;
      settingsBtn.addEventListener("click", () => {
        chrome.runtime.sendMessage({ type: "openSettings" });
      });

      buttonContainer.appendChild(btn);
      buttonContainer.appendChild(settingsBtn);
      headerNav.appendChild(buttonContainer);

      chrome.storage.onChanged.addListener((changes) => {
        if (changes.aiModel) {
          const newModel = changes.aiModel.newValue;
          let newModelName = "ChatGPT";

          if (newModel === "gemini") {
            newModelName = "Gemini";
          } else if (newModel === "deepseek") {
            newModelName = "DeepSeek";
          }

          if (!isAutomating) {
            btn.textContent = `Ask ${newModelName}`;
          }
        }
      });
    });
  });
}

function parseQuestion() {
  const container = document.querySelector(".probe-container");
  if (!container) {
    alert("No question found on the page.");
    return null;
  }

  const questionType = detectQuestionType(container);
  if (!questionType) {
    console.warn(LOG_PREFIX, "Unable to detect question type; waiting for next state");
    return null;
  }

  let questionText = "";
  const promptEl = container.querySelector(".prompt");

  if (questionType === "fill_in_the_blank" && promptEl) {
    const promptClone = promptEl.cloneNode(true);

    const uiSpans = promptClone.querySelectorAll(
      "span.fitb-span, span.blank-label, span.correctness, span._visuallyHidden"
    );
    uiSpans.forEach((span) => span.remove());

    const inputs = promptClone.querySelectorAll("input.fitb-input");
    inputs.forEach((input) => {
      const blankMarker = document.createTextNode("[BLANK]");
      if (input.parentNode) {
        input.parentNode.replaceChild(blankMarker, input);
      }
    });

    questionText = promptClone.textContent.trim();
  } else {
    questionText = promptEl ? promptEl.textContent.trim() : "";
  }

  let options = [];
  if (questionType === "matching") {
    const prompts = getMatchingRows(container)
      .map((row) => getMatchingPromptText(row))
      .filter(Boolean);
    const choices = dedupeAnswers(
      getMatchingChoiceItems(container)
        .map((item) => getMatchingChoiceText(item))
        .filter(Boolean)
    );
    options = { prompts, choices };
  } else if (questionType === "select_text") {
    options = Array.from(
      container.querySelectorAll(".select-text-component .choice.-interactive")
    )
      .map((el) => el.textContent.trim())
      .filter(Boolean);
  } else if (questionType === "ordering") {
    options = getOrderingChoiceItems(container)
      .map((item) => getOrderingChoiceText(item))
      .filter(Boolean);
  } else if (questionType !== "fill_in_the_blank") {
    container.querySelectorAll(".choiceText").forEach((el) => {
      options.push(el.textContent.trim());
    });
  }

  return {
    type: questionType,
    question: questionText,
    options: options,
    previousFormatIssue: lastResponseFormatIssue,
    previousCorrection: lastIncorrectQuestion
      ? {
          question: lastIncorrectQuestion,
          correctAnswer: lastCorrectAnswer,
        }
      : null,
  };
}

function waitForElement(selector, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    const interval = setInterval(() => {
      const el = document.querySelector(selector);
      if (el) {
        clearInterval(interval);
        resolve(el);
      } else if (Date.now() - startTime > timeout) {
        clearInterval(interval);
        reject(new Error("Element not found: " + selector));
      }
    }, READINESS_POLL_INTERVAL_MS);
  });
}

setupMessageListener();
addAssistantButton();

if (isAutomating) {
  scheduleCheckForNextStep(NEXT_STEP_RETRY_DELAY_MS, "script_bootstrap");
}
