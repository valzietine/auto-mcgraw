let hasResponded = false;
let messageCountAtQuestion = 0;
let observationStartTime = 0;
let observationTimeout = null;
let observer = null;
let activeQuestionId = null;
const LOG_PREFIX = "[Auto-McGraw][gemini]";
const PERF_LOGGING_ENABLED = true;
const INPUT_READY_TIMEOUT_MS = 10000;
const SEND_READY_TIMEOUT_MS = 10000;
const READINESS_POLL_INTERVAL_MS = 50;
const GEMINI_IDLE_TIMEOUT_MS = 120000;

function logPerf(message, ...args) {
  if (!PERF_LOGGING_ENABLED) return;
  console.info(LOG_PREFIX, "[perf]", message, ...args);
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

function isSendButtonReady(button) {
  if (!button) return false;
  if (button.disabled) return false;
  if (button.getAttribute("aria-disabled") === "true") return false;
  if (button.classList.contains("stop")) return false;
  return true;
}

function waitForIdle(timeout = GEMINI_IDLE_TIMEOUT_MS) {
  return waitForCondition(
    () => {
      const sendButton = document.querySelector(".send-button");
      if (!sendButton) return true;
      return sendButton.classList.contains("stop") ? null : true;
    },
    timeout,
    250
  );
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "receiveQuestion") {
    resetObservation();
    activeQuestionId = message.questionId || message.question?.questionId || null;
    console.info(LOG_PREFIX, "Received question", activeQuestionId);

    const messages = document.querySelectorAll("model-response");
    messageCountAtQuestion = messages.length;
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
  if (observer) {
    observer.disconnect();
    observer = null;
  }
}

async function insertQuestion(questionData) {
  const insertStartAt = Date.now();
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
      '\n\nPlease match each prompt with the correct choice. Set "answer" to an array of strings using the exact format \'Prompt -> Choice\'. Include one entry per prompt, use exact prompt and choice text, and use each choice at most once.';
  } else if (type === "fill_in_the_blank") {
    text +=
      "\n\nThis is a fill in the blank question. If there are multiple blanks, provide answers as an array in order of appearance. For a single blank, you can provide a string.";
  } else if (type === "ordering") {
    if (options && options.length > 0) {
      text +=
        "\nOptions:\n" + options.map((opt, i) => `${i + 1}. ${opt}`).join("\n");
    }
    text +=
      '\n\nThis is an ordering question. Set "answer" to an array containing the options in correct top-to-bottom order. Include each option exactly once and use the exact option text.';
  } else if (type === "click_and_drag") {
    const labels = Array.isArray(options?.labels) ? options.labels : [];
    const categories = Array.isArray(options?.categories) ? options.categories : [];
    if (labels.length > 0) {
      text += "\nLabels:\n" + labels.map((label, i) => `${i + 1}. ${label}`).join("\n");
    }
    if (categories.length > 0) {
      text +=
        "\nCategories:\n" +
        categories.map((category, i) => `${i + 1}. ${category}`).join("\n");
    }
    text +=
      '\n\nThis is a click-and-drag labeling question. Set "answer" to an array of strings where each array item is exactly one complete "Label -> Category" pair. Use exact label and category text including punctuation and apostrophes. Do not split a label across lines or array items. Do not include numbering, bullets, prefixes, or extra commentary. Include each label exactly once, and do not include labels or categories not listed.';
  } else if (options && options.length > 0) {
    text +=
      "\nOptions:\n" + options.map((opt, i) => `${i + 1}. ${opt}`).join("\n");
    text +=
      "\n\nIMPORTANT: Your answer must EXACTLY match one of the above options. Do not include numbers in your answer. If there are periods, include them.";
  }

  text +=
    '\n\nRespond with ONLY a valid JSON object with keys "answer" and "explanation". The "answer" field is required. Do not wrap the JSON in markdown or code fences. Escape any internal double quotes in strings (for example: \\"text\\"). Explanations should be no more than one sentence. DO NOT acknowledge corrections or format reminders; only answer the current question.';
  await waitForIdle();
  const inputArea = await waitForCondition(
    () => document.querySelector(".ql-editor"),
    INPUT_READY_TIMEOUT_MS
  );

  inputArea.focus();
  inputArea.innerHTML = `<p>${text}</p>`;
  inputArea.dispatchEvent(new Event("input", { bubbles: true }));

  const sendButton = await waitForCondition(
    () => {
      const button = document.querySelector(".send-button");
      return isSendButtonReady(button) ? button : null;
    },
    SEND_READY_TIMEOUT_MS
  );

  sendButton.click();
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

  observer = new MutationObserver((mutations) => {
    if (hasResponded) return;

    const messages = document.querySelectorAll("model-response");
    if (!messages.length) return;

    if (messages.length <= messageCountAtQuestion) return;

    const latestMessage = messages[messages.length - 1];

    const codeBlocks = latestMessage.querySelectorAll("pre code");
    let responseText = "";

    for (const block of codeBlocks) {
      if (block.className.includes("hljs-") || block.closest(".code-block")) {
        responseText = block.textContent.trim();
        break;
      }
    }

    if (!responseText) {
      responseText = latestMessage.textContent.trim();
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (jsonMatch) responseText = jsonMatch[0];
    }

    responseText = responseText
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .replace(/\n\s*/g, " ")
      .trim();

    try {
      const parsed = JSON.parse(responseText);
      const hasAnswerField =
        parsed &&
        Object.prototype.hasOwnProperty.call(parsed, "answer") &&
        parsed.answer !== undefined &&
        parsed.answer !== null;

      if (hasAnswerField && !hasResponded) {
        hasResponded = true;
        console.info(LOG_PREFIX, "Sending response", activeQuestionId);
        logPerf(`${activeQuestionId || "unknown"} responseDetected->forward 0ms`);
        chrome.runtime
          .sendMessage({
            type: "geminiResponse",
            response: responseText,
            questionId: activeQuestionId,
          })
          .then(() => {
            resetObservation();
          })
          .catch((error) => {
            console.error("Error sending response:", error);
          });
        return;
      }

      if (!hasResponded) {
        hasResponded = true;
        console.warn(LOG_PREFIX, "Response missing answer field", activeQuestionId);
        logPerf(`${activeQuestionId || "unknown"} forwarding_format_error`);
        chrome.runtime
          .sendMessage({
            type: "geminiResponse",
            response: JSON.stringify({
              formatError: "missing_answer_field",
              explanation:
                typeof parsed.explanation === "string"
                  ? parsed.explanation
                  : "",
            }),
            questionId: activeQuestionId,
          })
          .then(() => {
            resetObservation();
          })
          .catch((error) => {
            hasResponded = false;
            console.error("Error sending response:", error);
          });
      }
    } catch (e) {
      const isGenerating =
        latestMessage.querySelector(".cursor") ||
        latestMessage.classList.contains("generating");

      if (!isGenerating && Date.now() - observationStartTime > 30000) {
        const responseText = latestMessage.textContent.trim();
        try {
          const jsonPattern =
            /\{[\s\S]*?"answer"[\s\S]*?"explanation"[\s\S]*?\}/;
          const jsonMatch = responseText.match(jsonPattern);

          if (jsonMatch && !hasResponded) {
            hasResponded = true;
            chrome.runtime.sendMessage({
              type: "geminiResponse",
              response: jsonMatch[0],
              questionId: activeQuestionId,
            });
            resetObservation();
          }
        } catch (e) {}
      }
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });
}
