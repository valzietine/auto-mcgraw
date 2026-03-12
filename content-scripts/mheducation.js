let messageListener = null;
let isAutomating = false;
let lastIncorrectQuestion = null;
let lastCorrectAnswer = null;
let matchingPauseIntervalId = null;
let pendingQuestionId = null;
let questionSequence = 0;
let lastResponseFormatIssue = null;
const LOG_PREFIX = "[Auto-McGraw][mhe]";

function createQuestionId() {
  questionSequence += 1;
  return `mhe_${Date.now()}_${questionSequence}`;
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
        setTimeout(() => {
          checkForNextStep();
        }, 500);
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

    setTimeout(() => {
      if (isAutomating) {
        checkForNextStep();
      }
    }, 1000);

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
  nextButton.click();

  setTimeout(() => {
    if (isAutomating) {
      checkForNextStep();
    }
  }, 1000);

  return true;
}

function getQuestionSignature(container) {
  if (!container) return "";

  const questionType = detectQuestionType(container);
  const promptText =
    container.querySelector(".prompt")?.textContent?.trim() || "";

  return `${questionType}::${normalizeChoiceText(promptText)}`;
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

      setTimeout(() => {
        if (isAutomating) {
          checkForNextStep();
        }
      }, 500);
    }
  }, 400);
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
          nextButton.click();
          if (isAutomating) {
            setTimeout(() => {
              checkForNextStep();
            }, 1000);
          }
        })
        .catch((error) => {
          console.error("Error in forced learning flow:", error);
          isAutomating = false;
          clearMatchingPauseWatcher();
        });
      return true;
    }
  }
  return false;
}

function checkForNextStep() {
  if (!isAutomating) return;
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
      console.info(LOG_PREFIX, "Dispatching question", questionId);

      chrome.runtime.sendMessage({
        type: "sendQuestionToChatGPT",
        question: qData,
        questionId,
      });
    } else {
      setTimeout(() => {
        if (isAutomating && !pendingQuestionId) {
          checkForNextStep();
        }
      }, 700);
    }
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

    if (pendingQuestionId) {
      console.info(LOG_PREFIX, "Processing response", pendingQuestionId);
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
      const questionSignature = getQuestionSignature(container);

      alert(
        "Matching Question Solution:\n\n" +
          answers.join("\n") +
          "\n\nPlease input these matches manually, then click high confidence and next. Automation will resume after you move to the next question."
      );

      if (isAutomating) {
        pauseForManualMatchingAndResume(questionSignature);
      }

      return;
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

    if (isAutomating) {
      waitForElement(
        '[data-automation-id="confidence-buttons--high_confidence"]:not([disabled])',
        10000
      )
        .then((button) => {
          button.click();

          setTimeout(() => {
            const incorrectMarker = container.querySelector(
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

            waitForElement(".next-button", 10000)
              .then((nextButton) => {
                nextButton.click();
                setTimeout(() => {
                  checkForNextStep();
                }, 1000);
              })
              .catch((error) => {
                console.error("Automation error:", error);
                isAutomating = false;
                clearMatchingPauseWatcher();
              });
          }, 1000);
        })
        .catch((error) => {
          console.error("Automation error:", error);
          isAutomating = false;
          clearMatchingPauseWatcher();
        });
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
      setTimeout(() => {
        checkForNextStep();
      }, 750);
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
          pendingQuestionId = null;
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
            clearMatchingPauseWatcher();
            btn.textContent = "Stop Automation";
            checkForNextStep();
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
    const prompts = Array.from(
      container.querySelectorAll(".match-prompt .content")
    )
      .map((el) => normalizeChoiceText(el.textContent))
      .filter(Boolean);
    const choices = Array.from(
      container.querySelectorAll(".choices-container .content")
    )
      .map((el) => normalizeChoiceText(el.textContent))
      .filter(Boolean);
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
    }, 100);
  });
}

setupMessageListener();
addAssistantButton();

if (isAutomating) {
  setTimeout(() => {
    checkForNextStep();
  }, 1000);
}
