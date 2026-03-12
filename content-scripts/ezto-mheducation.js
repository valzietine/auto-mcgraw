let messageListener = null;
let isAutomating = false;
let lastIncorrectQuestion = null;
let lastCorrectAnswer = null;
let buttonAdded = false;
let pendingQuestionId = null;
let questionSequence = 0;
const LOG_PREFIX = "[Auto-McGraw][ezto]";
const PERF_LOGGING_ENABLED = true;
const SOFT_GUARD_LOGGING_ENABLED = true;
const READINESS_POLL_INTERVAL_MS = 60;
const NEXT_STEP_RETRY_DELAY_MS = 220;
const QUIZ_TRANSITION_TIMEOUT_MS = 5000;
const QUIZ_TRANSITION_STABLE_WINDOW_MS = 650;
const DISPATCH_SIGNATURE_COOLDOWN_MS = 1800;
const ANSWER_COMMIT_TIMEOUT_MS = 3500;
const ANSWER_COMMIT_STABLE_WINDOW_MS = 220;
const SAME_PROGRESS_SIGNATURE_DRIFT_WARN_THRESHOLD = 3;
let scheduledNextStepTimeoutId = null;
let isCheckingNextStep = false;
const questionPerfMarks = new Map();
let pendingAdvancePerf = null;
let lastDispatchedQuestionSignature = "";
let lastDispatchedAt = 0;
let lastDispatchedProgressCurrent = null;
let consecutiveDispatchReadinessMisses = 0;
let sameProgressSignatureDriftCount = 0;
let sameProgressSignatureDriftProgress = null;
const sameProgressSignatureDriftSignatures = new Set();

function createQuestionId() {
  questionSequence += 1;
  return `ezto_${Date.now()}_${questionSequence}`;
}

function logPerf(message, ...args) {
  if (!PERF_LOGGING_ENABLED) return;
  console.info(LOG_PREFIX, "[perf]", message, ...args);
}

function logSoftGuard(message, details = null) {
  if (!SOFT_GUARD_LOGGING_ENABLED) return;
  if (details) {
    console.warn(LOG_PREFIX, "[soft-guard]", message, details);
    return;
  }
  console.warn(LOG_PREFIX, "[soft-guard]", message);
}

function resetSignatureDriftSoftGuard() {
  sameProgressSignatureDriftCount = 0;
  sameProgressSignatureDriftProgress = null;
  sameProgressSignatureDriftSignatures.clear();
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

async function waitForStableCondition(
  predicate,
  stableWindowMs = ANSWER_COMMIT_STABLE_WINDOW_MS,
  timeout = ANSWER_COMMIT_TIMEOUT_MS
) {
  let stableSinceAt = 0;

  await waitForCondition(() => {
    let ok = false;
    try {
      ok = Boolean(predicate());
    } catch (error) {
      ok = false;
    }

    if (!ok) {
      stableSinceAt = 0;
      return false;
    }

    if (!stableSinceAt) {
      stableSinceAt = Date.now();
      return false;
    }

    return Date.now() - stableSinceAt >= stableWindowMs;
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

function getQuizStateSnapshot() {
  const questionElement = document.querySelector(".question");
  const questionText =
    questionElement?.textContent?.replace(/\s+/g, " ").trim() || "";

  const progressText =
    document
      .querySelector(".footer__progress__heading")
      ?.textContent?.replace(/\s+/g, " ")
      .trim() || "";

  const progressMatch = progressText.match(/(\d+)\s+of\s+(\d+)/);
  const progressCurrent = progressMatch ? parseInt(progressMatch[1], 10) : null;
  const progressTotal = progressMatch ? parseInt(progressMatch[2], 10) : null;

  let questionType = "";
  let optionCount = 0;

  if (document.querySelector(".answers-wrap.multiple-choice")) {
    questionType = "multiple_choice";
    optionCount = document.querySelectorAll(".answers--mc .answer__label--mc").length;
  } else if (document.querySelector(".answers-wrap.boolean")) {
    questionType = "true_false";
    optionCount = document.querySelectorAll(".answer--boolean").length;
  } else if (document.querySelector(".answers-wrap.input-response")) {
    questionType = "fill_in_the_blank";
    optionCount = document.querySelectorAll(".answer--input__input").length;
  }

  return {
    questionText,
    progressText,
    progressCurrent,
    progressTotal,
    questionType,
    optionCount,
    signature: `${progressText}::${questionText}`,
  };
}

function isQuizStateDispatchReady(snapshot) {
  if (!snapshot) return false;
  if (!snapshot.questionText || !snapshot.questionType) return false;

  if (snapshot.questionType === "multiple_choice") {
    return snapshot.optionCount > 0;
  }

  if (snapshot.questionType === "true_false") {
    return snapshot.optionCount >= 2;
  }

  if (snapshot.questionType === "fill_in_the_blank") {
    return snapshot.optionCount > 0;
  }

  return false;
}

function clearAutomationAnswerMarkers() {
  document
    .querySelectorAll("[data-automcgraw-selected='true']")
    .forEach((node) => node.removeAttribute("data-automcgraw-selected"));
}

function getAnswerCommitFingerprint() {
  const checkedInputs = Array.from(
    document.querySelectorAll(
      ".answers-wrap input[type='radio']:checked, .answers-wrap input[type='checkbox']:checked"
    )
  )
    .map(
      (input, index) =>
        `${input.name || "name"}:${input.value || input.id || index}`
    )
    .join("|");

  const inputValues = Array.from(
    document.querySelectorAll(".answers-wrap.input-response input, .answers-wrap.input-response textarea")
  )
    .map((input, index) => `${index}:${String(input.value || "").trim()}`)
    .join("|");

  const pressedButtons = Array.from(
    document.querySelectorAll(
      ".answers-wrap.boolean [aria-pressed='true'], .answers-wrap.boolean .selected, .answers-wrap.boolean .is-selected, .answers-wrap.boolean .active, .answers-wrap.boolean .is-active"
    )
  )
    .map((button, index) => `${button.textContent?.trim() || "btn"}:${index}`)
    .join("|");

  const automationMarkers = Array.from(
    document.querySelectorAll("[data-automcgraw-selected='true']")
  )
    .map((node, index) => `${node.textContent?.trim() || node.id || "node"}:${index}`)
    .join("|");

  return `${checkedInputs}||${inputValues}||${pressedButtons}||${automationMarkers}`;
}

function getNextQuizButton() {
  return document.querySelector(".footer__link--next:not([hidden])");
}

function isNextQuizButtonEnabled() {
  const nextButton = getNextQuizButton();
  return Boolean(
    nextButton &&
      !nextButton.disabled &&
      !nextButton.classList.contains("is-disabled")
  );
}

function waitForNextQuizButton(timeout = 10000) {
  return waitForCondition(() => {
    const nextButton = getNextQuizButton();
    return isNextQuizButtonEnabled() ? nextButton : null;
  }, timeout);
}

async function waitForQuizTransition(
  previousSnapshot,
  timeout = QUIZ_TRANSITION_TIMEOUT_MS
) {
  if (!previousSnapshot?.signature) return false;

  try {
    let stableSinceAt = 0;
    let stableSignature = "";

    await waitForCondition(() => {
      if (checkForQuizEnd()) return true;

      const currentSnapshot = getQuizStateSnapshot();
      if (!isQuizStateDispatchReady(currentSnapshot)) {
        stableSinceAt = 0;
        stableSignature = "";
        return false;
      }

      const advanced =
        currentSnapshot.signature &&
        currentSnapshot.signature !== previousSnapshot.signature;
      if (!advanced) {
        stableSinceAt = 0;
        stableSignature = "";
        return false;
      }

      if (
        Number.isInteger(previousSnapshot.progressCurrent) &&
        Number.isInteger(currentSnapshot.progressCurrent) &&
        currentSnapshot.progressCurrent < previousSnapshot.progressCurrent
      ) {
        stableSinceAt = 0;
        stableSignature = "";
        return false;
      }

      if (stableSignature !== currentSnapshot.signature) {
        stableSignature = currentSnapshot.signature;
        stableSinceAt = Date.now();
        return false;
      }

      return Date.now() - stableSinceAt >= QUIZ_TRANSITION_STABLE_WINDOW_MS;
    }, timeout);
    return true;
  } catch (error) {
    return false;
  }
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

function isQuizPage() {
  return (
    document.querySelector(".question") &&
    (document.querySelector(".answers-wrap.multiple-choice") ||
      document.querySelector(".answers-wrap.boolean") ||
      document.querySelector(".answers-wrap.input-response"))
  );
}

function isLikelyQuizCompletedState() {
  const snapshot = getQuizStateSnapshot();

  if (
    Number.isInteger(snapshot.progressCurrent) &&
    Number.isInteger(snapshot.progressTotal)
  ) {
    if (snapshot.progressCurrent > snapshot.progressTotal) {
      return true;
    }

    if (
      snapshot.progressCurrent >= snapshot.progressTotal &&
      !isQuizStateDispatchReady(snapshot) &&
      !isNextQuizButtonEnabled()
    ) {
      return true;
    }
  }

  return false;
}

function checkForQuizAndAddButton() {
  if (buttonAdded) return;

  const helpLink = document.querySelector(".header__help");
  if (helpLink && isQuizPage()) {
    addAssistantButton();
    buttonAdded = true;
  }
}

function startPageObserver() {
  const observer = new MutationObserver(() => {
    if (!buttonAdded) {
      checkForQuizAndAddButton();
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });

  checkForQuizAndAddButton();
}

function checkForQuizEnd() {
  return isLikelyQuizCompletedState();
}

function stopAutomation(reason = "Quiz completed") {
  isAutomating = false;
  pendingQuestionId = null;
  pendingAdvancePerf = null;
  lastDispatchedQuestionSignature = "";
  lastDispatchedAt = 0;
  lastDispatchedProgressCurrent = null;
  consecutiveDispatchReadinessMisses = 0;
  resetSignatureDriftSoftGuard();
  questionPerfMarks.clear();

  if (scheduledNextStepTimeoutId !== null) {
    clearTimeout(scheduledNextStepTimeoutId);
    scheduledNextStepTimeoutId = null;
  }

  chrome.storage.sync.get("aiModel", function (data) {
    const currentModel = data.aiModel || "chatgpt";
    let currentModelName = "ChatGPT";

    if (currentModel === "gemini") {
      currentModelName = "Gemini";
    } else if (currentModel === "deepseek") {
      currentModelName = "DeepSeek";
    }

    const btn = document.querySelector(".header__automcgraw--main");
    if (btn) {
      btn.textContent = `Ask ${currentModelName}`;
    }
  });

  alert(`Automation stopped: ${reason}`);
  console.log(`Automation stopped: ${reason}`);
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

    if (checkForQuizEnd()) {
      stopAutomation("Quiz completed - all questions answered");
      return;
    }

    const snapshot = getQuizStateSnapshot();
    if (!isQuizStateDispatchReady(snapshot)) {
      consecutiveDispatchReadinessMisses += 1;
      if (consecutiveDispatchReadinessMisses >= 50) {
        stopAutomation("No stable question state found");
        return;
      }

      scheduleCheckForNextStep(
        NEXT_STEP_RETRY_DELAY_MS,
        "question_state_not_ready_retry"
      );
      return;
    }

    const now = Date.now();
    if (
      snapshot.signature &&
      snapshot.signature === lastDispatchedQuestionSignature &&
      now - lastDispatchedAt < DISPATCH_SIGNATURE_COOLDOWN_MS
    ) {
      logPerf(
        `holding unchanged quiz signature for ${now - lastDispatchedAt}ms before redispatch`
      );
      scheduleCheckForNextStep(120, "unchanged_signature_retry");
      return;
    }

    const questionData = parseQuestion();
    if (questionData) {
      consecutiveDispatchReadinessMisses = 0;

      if (
        Number.isInteger(snapshot.progressCurrent) &&
        Number.isInteger(lastDispatchedProgressCurrent)
      ) {
        const progressDelta =
          snapshot.progressCurrent - lastDispatchedProgressCurrent;

        if (progressDelta > 1) {
          logSoftGuard("Progress jumped by more than one before dispatch", {
            previous: lastDispatchedProgressCurrent,
            current: snapshot.progressCurrent,
            signature: snapshot.signature,
          });
          resetSignatureDriftSoftGuard();
        } else if (progressDelta < 0) {
          logSoftGuard("Progress moved backward before dispatch", {
            previous: lastDispatchedProgressCurrent,
            current: snapshot.progressCurrent,
            signature: snapshot.signature,
          });
          resetSignatureDriftSoftGuard();
        } else if (
          progressDelta === 0 &&
          snapshot.signature &&
          snapshot.signature !== lastDispatchedQuestionSignature
        ) {
          if (sameProgressSignatureDriftProgress !== snapshot.progressCurrent) {
            resetSignatureDriftSoftGuard();
            sameProgressSignatureDriftProgress = snapshot.progressCurrent;
          }

          if (lastDispatchedQuestionSignature) {
            sameProgressSignatureDriftSignatures.add(lastDispatchedQuestionSignature);
          }
          sameProgressSignatureDriftSignatures.add(snapshot.signature);

          sameProgressSignatureDriftCount += 1;
          if (
            sameProgressSignatureDriftCount >=
            SAME_PROGRESS_SIGNATURE_DRIFT_WARN_THRESHOLD
          ) {
            logSoftGuard(
              "Repeated signature changes without progress increment",
              {
                progress: snapshot.progressCurrent,
                driftCount: sameProgressSignatureDriftCount,
                recentSignatures: Array.from(
                  sameProgressSignatureDriftSignatures
                ).slice(-6),
              }
            );
          }
        } else {
          resetSignatureDriftSoftGuard();
        }
      } else {
        resetSignatureDriftSoftGuard();
      }

      const questionId = createQuestionId();
      questionData.questionId = questionId;
      pendingQuestionId = questionId;
      lastDispatchedQuestionSignature = snapshot.signature;
      lastDispatchedAt = now;
      lastDispatchedProgressCurrent = Number.isInteger(snapshot.progressCurrent)
        ? snapshot.progressCurrent
        : lastDispatchedProgressCurrent;
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
        question: questionData,
        questionId,
      });
    } else {
      consecutiveDispatchReadinessMisses += 1;
      if (consecutiveDispatchReadinessMisses >= 50) {
        stopAutomation("No question found or question type not supported");
        return;
      }
      scheduleCheckForNextStep(
        NEXT_STEP_RETRY_DELAY_MS,
        "parse_question_retry"
      );
    }
  } finally {
    isCheckingNextStep = false;
  }
}

function parseQuestion() {
  const questionElement = document.querySelector(".question");
  if (!questionElement) {
    return null;
  }

  let questionType = "";
  let options = [];

  if (document.querySelector(".answers-wrap.multiple-choice")) {
    questionType = "multiple_choice";
    const optionElements = document.querySelectorAll(
      ".answers--mc .answer__label--mc"
    );
    options = Array.from(optionElements).map((el) => {
      const textContent = el.textContent.trim();
      return textContent.replace(/^[a-z]\s+/, "");
    });
  } else if (document.querySelector(".answers-wrap.boolean")) {
    questionType = "true_false";
    options = ["True", "False"];
  } else if (document.querySelector(".answers-wrap.input-response")) {
    questionType = "fill_in_the_blank";
    options = [];
  } else {
    console.log("Unknown question type");
    return null;
  }

  let questionText = "";
  if (questionType === "fill_in_the_blank") {
    const questionClone = questionElement.cloneNode(true);

    const blankSpans = questionClone.querySelectorAll(
      'span[aria-hidden="true"]'
    );
    blankSpans.forEach((span) => {
      if (span.textContent.includes("_")) {
        span.textContent = "[BLANK]";
      }
    });

    const hiddenSpans = questionClone.querySelectorAll(
      'span[style*="position: absolute"]'
    );
    hiddenSpans.forEach((span) => span.remove());

    questionText = questionClone.textContent.trim();
  } else {
    questionText = questionElement.textContent.trim();
  }

  return {
    type: questionType,
    question: questionText,
    options: options,
    previousCorrection: lastIncorrectQuestion
      ? {
          question: lastIncorrectQuestion,
          correctAnswer: lastCorrectAnswer,
        }
      : null,
  };
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

    console.log("Quiz response received:", responseText);

    const response = JSON.parse(responseText);
    const answer = response.answer;
    clearAutomationAnswerMarkers();
    const preApplyNextEnabled = isNextQuizButtonEnabled();
    const preApplyFingerprint = getAnswerCommitFingerprint();

    let answerApplication = applyQuizAnswer(answer);

    if (!answerApplication.applied) {
      console.warn(LOG_PREFIX, "Unable to apply answer; refusing to advance", answer);
      if (isAutomating) {
        stopAutomation("Could not apply answer reliably. Paused to avoid skipping.");
      }
      return;
    }

    try {
      await waitForStableCondition(
        () => {
          if (isLikelyQuizCompletedState()) return true;

          const verified = answerApplication.verify();
          const nextEnabled = isNextQuizButtonEnabled();
          const fingerprintChanged =
            getAnswerCommitFingerprint() !== preApplyFingerprint;

          if (verified) return true;
          if (!preApplyNextEnabled && nextEnabled) return true;
          if (fingerprintChanged && nextEnabled) return true;
          return false;
        },
        ANSWER_COMMIT_STABLE_WINDOW_MS,
        ANSWER_COMMIT_TIMEOUT_MS
      );
    } catch (commitError) {
      // Retry one re-application pass before failing closed.
      clearAutomationAnswerMarkers();
      answerApplication = applyQuizAnswer(answer);
      if (!answerApplication.applied) {
        if (isAutomating) {
          stopAutomation("Could not re-apply answer reliably. Paused to avoid skipping.");
        }
        return;
      }

      try {
        await waitForStableCondition(
          () => {
            if (isLikelyQuizCompletedState()) return true;

            const verified = answerApplication.verify();
            const nextEnabled = isNextQuizButtonEnabled();
            const fingerprintChanged =
              getAnswerCommitFingerprint() !== preApplyFingerprint;

            if (verified) return true;
            if (!preApplyNextEnabled && nextEnabled) return true;
            if (fingerprintChanged && nextEnabled) return true;
            return false;
          },
          ANSWER_COMMIT_STABLE_WINDOW_MS,
          ANSWER_COMMIT_TIMEOUT_MS
        );
      } catch (secondCommitError) {
        if (isLikelyQuizCompletedState()) {
          stopAutomation("Quiz completed - all questions answered");
          return;
        }

        const commitDebug = {
          verified: answerApplication.verify(),
          nextEnabled: isNextQuizButtonEnabled(),
          fingerprintChanged: getAnswerCommitFingerprint() !== preApplyFingerprint,
          preApplyNextEnabled,
          snapshot: getQuizStateSnapshot(),
        };

        console.warn(
          LOG_PREFIX,
          "Answer commit did not stabilize; refusing to advance",
          secondCommitError,
          commitDebug
        );
        if (isAutomating) {
          stopAutomation(
            "Answer did not commit before next. Paused to prevent skipped questions."
          );
        }
        return;
      }
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
      const previousSnapshot = getQuizStateSnapshot();
      try {
        const nextButton = await waitForNextQuizButton(12000);
        nextButton.click();
        const nextClickedAt = Date.now();

        if (activeQuestionId) {
          const perfEntry = markQuestionPerf(
            activeQuestionId,
            "nextClickedAt",
            nextClickedAt
          );
          if (perfEntry?.answerAppliedAt) {
            logPerf(
              `${activeQuestionId} answerApplied->next ${
                nextClickedAt - perfEntry.answerAppliedAt
              }ms`
            );
          }
          pendingAdvancePerf = {
            questionId: activeQuestionId,
            nextClickedAt,
          };
        }

        await waitForQuizTransition(previousSnapshot, QUIZ_TRANSITION_TIMEOUT_MS);

        if (checkForQuizEnd()) {
          stopAutomation("Quiz completed - all questions answered");
          return;
        }

        scheduleCheckForNextStep(0, "post_answer_next");
      } catch (error) {
        if (isLikelyQuizCompletedState()) {
          stopAutomation("Quiz completed - all questions answered");
          return;
        }

        stopAutomation("Quiz completed - no next button available");
      }
    }
  } catch (e) {
    console.error("Error processing response:", e);
    pendingQuestionId = null;
    stopAutomation("Error processing AI response: " + e.message);
  }
}

function handleMultipleChoiceAnswer(answer) {
  const radioButtons = document.querySelectorAll(
    '.answers--mc input[type="radio"]'
  );
  const labels = document.querySelectorAll(".answers--mc .answer__label--mc");

  for (let i = 0; i < labels.length; i++) {
    const labelText = labels[i].textContent.trim().replace(/^[a-z]\s+/, "");

    if (
      labelText === answer ||
      labelText.replace(/\.$/, "") === answer.replace(/\.$/, "") ||
      labelText.includes(answer) ||
      answer.includes(labelText)
    ) {
      const targetInput = radioButtons[i];
      radioButtons.forEach((input) =>
        input.removeAttribute("data-automcgraw-selected")
      );
      targetInput.click();
      targetInput.setAttribute("data-automcgraw-selected", "true");
      console.log("Selected option:", labelText);
      return {
        applied: true,
        type: "multiple_choice",
        verify: () => Boolean(targetInput && targetInput.isConnected && targetInput.checked),
      };
    }
  }

  return {
    applied: false,
    type: "multiple_choice",
    verify: () => false,
  };
}

function handleTrueFalseAnswer(answer) {
  console.log("Handling true/false answer:", answer);
  const buttons = document.querySelectorAll(".answer--boolean");
  console.log("Found buttons:", buttons.length);

  for (const button of buttons) {
    const buttonSpan = button.querySelector(".answer__button--boolean");
    if (!buttonSpan) {
      console.log("No .answer__button--boolean found in button");
      continue;
    }
    
    const fullText = buttonSpan.textContent;
    console.log("Button full text:", JSON.stringify(fullText));
    
    const buttonText = fullText.trim().split(",")[0].trim();
    console.log("Parsed button text:", JSON.stringify(buttonText));

    if (
      (buttonText === "True" && (answer === "True" || answer === true)) ||
      (buttonText === "False" && (answer === "False" || answer === false))
    ) {
      console.log("Clicking button with text:", buttonText);
      document
        .querySelectorAll(".answers-wrap.boolean [data-automcgraw-selected='true']")
        .forEach((node) => node.removeAttribute("data-automcgraw-selected"));

      const directInput = button.querySelector(
        'input[type="radio"], input[type="checkbox"]'
      );
      if (directInput && !directInput.checked) {
        directInput.click();
      }

      button.click();
      button.setAttribute("data-automcgraw-selected", "true");
      const targetButton = button;
      return {
        applied: true,
        type: "true_false",
        verify: () => {
          if (!targetButton || !targetButton.isConnected) return false;

          const targetCheckedInput = targetButton.querySelector(
            'input[type="radio"], input[type="checkbox"]'
          );
          if (targetCheckedInput?.checked) {
            return true;
          }

          if (targetButton.getAttribute("aria-pressed") === "true") {
            return true;
          }

          const className = targetButton.className || "";
          if (/selected|active|checked|is-selected|is-active/i.test(className)) {
            return true;
          }

          const directCheckedInput = targetButton.querySelector(
            'input[type="radio"], input[type="checkbox"]'
          );
          if (directCheckedInput?.checked) {
            return true;
          }

          const anyChecked = document.querySelector(
            '.answers-wrap.boolean input[type="radio"]:checked, .answers-wrap.boolean input[type="checkbox"]:checked'
          );
          if (anyChecked) {
            return true;
          }

          if (targetButton.getAttribute("data-automcgraw-selected") === "true") {
            return true;
          }

          return false;
        },
      };
    }
  }
  
  console.error("No matching button found for answer:", answer);
  return {
    applied: false,
    type: "true_false",
    verify: () => false,
  };
}

function handleFillInTheBlankAnswer(answer) {
  const inputField = document.querySelector(".answer--input__input");

  if (inputField) {
    let answerText = "";

    if (Array.isArray(answer)) {
      answerText = answer[0];
    } else {
      answerText = answer;
    }

    inputField.value = answerText;
    inputField.dispatchEvent(new Event("input", { bubbles: true }));
    inputField.dispatchEvent(new Event("change", { bubbles: true }));
    inputField.setAttribute("data-automcgraw-selected", "true");

    console.log("Filled in blank with:", answerText);
    return {
      applied: true,
      type: "fill_in_the_blank",
      verify: () =>
        Boolean(
          inputField &&
            inputField.isConnected &&
            String(inputField.value || "").trim() === String(answerText || "").trim()
        ),
    };
  } else {
    console.error("Could not find input field for fill in the blank");
  }

  return {
    applied: false,
    type: "fill_in_the_blank",
    verify: () => false,
  };
}

function applyQuizAnswer(answer) {
  if (document.querySelector(".answers-wrap.multiple-choice")) {
    return handleMultipleChoiceAnswer(answer);
  }

  if (document.querySelector(".answers-wrap.boolean")) {
    return handleTrueFalseAnswer(answer);
  }

  if (document.querySelector(".answers-wrap.input-response")) {
    return handleFillInTheBlankAnswer(answer);
  }

  return {
    applied: false,
    type: "unknown",
    verify: () => false,
  };
}

function addAssistantButton() {
  const helpLink = document.querySelector(".header__help");
  if (!helpLink) return;

  const buttonContainer = document.createElement("div");
  buttonContainer.className = "header__automcgraw";
  buttonContainer.style.cssText = `
    display: inline-flex;
    margin-right: 20px;
    align-items: center;
  `;

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
    btn.type = "button";
    btn.className = "header__automcgraw--main";
    btn.style.cssText = `
      background: #fff;
      border: 1px solid #ccc;
      color: #333;
      padding: 8px 12px;
      font-size: 14px;
      font-family: inherit;
      cursor: pointer;
      border-radius: 4px 0 0 4px;
      border-right: none;
      height: 32px;
      line-height: 1;
      text-decoration: none;
      display: inline-flex;
      align-items: center;
      transition: background-color 0.2s ease;
    `;

    btn.addEventListener("mouseenter", () => {
      btn.style.backgroundColor = "#f5f5f5";
    });

    btn.addEventListener("mouseleave", () => {
      btn.style.backgroundColor = "#fff";
    });

    btn.addEventListener("click", () => {
      if (isAutomating) {
        stopAutomation("Manual stop");
      } else {
        const proceed = confirm(
          "Start quiz automation? The automation will stop automatically when the quiz ends.\n\nClick OK to begin, or Cancel to stop."
        );
        if (proceed) {
          isAutomating = true;
          pendingQuestionId = null;
          pendingAdvancePerf = null;
          lastDispatchedQuestionSignature = "";
          lastDispatchedAt = 0;
          lastDispatchedProgressCurrent = null;
          consecutiveDispatchReadinessMisses = 0;
          resetSignatureDriftSoftGuard();
          btn.textContent = "Stop Automation";
          scheduleCheckForNextStep(0, "manual_start");
        }
      }
    });

    const settingsBtn = document.createElement("button");
    settingsBtn.type = "button";
    settingsBtn.className = "header__automcgraw--settings";
    settingsBtn.title = "Auto-McGraw Settings";
    settingsBtn.setAttribute("aria-label", "Auto-McGraw Settings");
    settingsBtn.style.cssText = `
      background: #fff;
      border: 1px solid #ccc;
      color: #333;
      padding: 8px 10px;
      font-size: 14px;
      cursor: pointer;
      border-radius: 0 4px 4px 0;
      height: 32px;
      line-height: 1;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      transition: background-color 0.2s ease;
    `;

    settingsBtn.addEventListener("mouseenter", () => {
      settingsBtn.style.backgroundColor = "#f5f5f5";
    });

    settingsBtn.addEventListener("mouseleave", () => {
      settingsBtn.style.backgroundColor = "#fff";
    });

    settingsBtn.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="3"></circle>
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06-.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
      </svg>
    `;

    settingsBtn.addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "openSettings" });
    });

    buttonContainer.appendChild(btn);
    buttonContainer.appendChild(settingsBtn);
    helpLink.parentNode.insertBefore(buttonContainer, helpLink);

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
startPageObserver();

if (isAutomating) {
  scheduleCheckForNextStep(NEXT_STEP_RETRY_DELAY_MS, "script_bootstrap");
}
