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
const FINAL_POSITION_FALLBACK_NEXT_WAIT_TIMEOUT_MS = 2500;
const DISPATCH_SIGNATURE_COOLDOWN_MS = 1800;
const ANSWER_COMMIT_TIMEOUT_MS = 3500;
const ANSWER_COMMIT_STABLE_WINDOW_MS = 220;
const SAME_PROGRESS_SIGNATURE_DRIFT_WARN_THRESHOLD = 3;
const LAST_QUESTION_CUE_TEXT = "this is the last question in the assignment";
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
let isWaitingForManualRecovery = false;
let manualRecoveryIntervalId = null;
let manualRecoveryInFlight = false;
let manualRecoveryContext = null;
const CLICK_AND_DRAG_IFRAME_SELECTOR =
  "iframe.external[src*='clickanddrag'], iframe.external[src*='/ext/common/clickanddrag/'], iframe[title*='Assessment Tool'][src*='clickanddrag']";
const CLICK_AND_DRAG_CATEGORY_COUNT_SUFFIX_REGEX = /\s*\(\d+\s*\/\s*\d+\)\s*$/;
const CLICK_AND_DRAG_MOVE_MAX_PASSES = 3;
const CLICK_AND_DRAG_MOVE_MAX_KEYBOARD_STEPS = 8;
const MULTIPLE_CHOICE_MATCH_THRESHOLD = 0.78;
const MULTIPLE_CHOICE_MATCH_MARGIN = 0.08;
const CLICK_AND_DRAG_IFRAME_READY_TIMEOUT_MS = 12000;
const CLICK_AND_DRAG_FORMAT_RETRY_LIMIT = 1;
const ANSWER_DELAY_DEFAULTS = Object.freeze({
  enabled: true,
  averageSec: 12,
  jitterSec: 3,
});
const ANSWER_DELAY_LIMITS = Object.freeze({
  averageMin: 6,
  averageMax: 45,
  jitterMin: 0,
  jitterMax: 10,
});
const clickAndDragFormatRetryAttemptsBySignature = new Map();
const clickAndDragFormatIssueBySignature = new Map();
let answerDelayConfig = { ...ANSWER_DELAY_DEFAULTS };

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

function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function parseNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function sanitizeAnswerDelayConfig(rawConfig = {}) {
  const enabled =
    typeof rawConfig.answerDelayEnabled === "boolean"
      ? rawConfig.answerDelayEnabled
      : ANSWER_DELAY_DEFAULTS.enabled;
  const averageSec = clampNumber(
    Math.round(
      parseNumber(rawConfig.answerDelayAverageSec, ANSWER_DELAY_DEFAULTS.averageSec)
    ),
    ANSWER_DELAY_LIMITS.averageMin,
    ANSWER_DELAY_LIMITS.averageMax
  );
  const jitterSec = clampNumber(
    Math.round(
      parseNumber(rawConfig.answerDelayJitterSec, ANSWER_DELAY_DEFAULTS.jitterSec) * 10
    ) / 10,
    ANSWER_DELAY_LIMITS.jitterMin,
    ANSWER_DELAY_LIMITS.jitterMax
  );

  return {
    enabled,
    averageSec,
    jitterSec,
  };
}

function shouldNormalizeAnswerDelayConfig(rawConfig, sanitizedConfig) {
  return (
    rawConfig.answerDelayEnabled !== sanitizedConfig.enabled ||
    Number(rawConfig.answerDelayAverageSec) !== sanitizedConfig.averageSec ||
    Number(rawConfig.answerDelayJitterSec) !== sanitizedConfig.jitterSec
  );
}

function setAnswerDelayConfig(rawConfig = {}) {
  answerDelayConfig = sanitizeAnswerDelayConfig(rawConfig);
}

function setupAnswerDelayConfigSync() {
  chrome.storage.sync.get(
    ["answerDelayEnabled", "answerDelayAverageSec", "answerDelayJitterSec"],
    (data) => {
      const sanitizedConfig = sanitizeAnswerDelayConfig(data);
      answerDelayConfig = sanitizedConfig;

      if (shouldNormalizeAnswerDelayConfig(data, sanitizedConfig)) {
        chrome.storage.sync.set({
          answerDelayEnabled: sanitizedConfig.enabled,
          answerDelayAverageSec: sanitizedConfig.averageSec,
          answerDelayJitterSec: sanitizedConfig.jitterSec,
        });
      }
    }
  );

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName && areaName !== "sync") return;
    if (
      !changes.answerDelayEnabled &&
      !changes.answerDelayAverageSec &&
      !changes.answerDelayJitterSec
    ) {
      return;
    }

    setAnswerDelayConfig({
      answerDelayEnabled: changes.answerDelayEnabled
        ? changes.answerDelayEnabled.newValue
        : answerDelayConfig.enabled,
      answerDelayAverageSec: changes.answerDelayAverageSec
        ? changes.answerDelayAverageSec.newValue
        : answerDelayConfig.averageSec,
      answerDelayJitterSec: changes.answerDelayJitterSec
        ? changes.answerDelayJitterSec.newValue
        : answerDelayConfig.jitterSec,
    });
  });
}

function clearClickAndDragFormatRetryState(signature = "") {
  const normalizedSignature = normalizeQuizText(signature);
  if (normalizedSignature) {
    clickAndDragFormatRetryAttemptsBySignature.delete(normalizedSignature);
    clickAndDragFormatIssueBySignature.delete(normalizedSignature);
    return;
  }

  clickAndDragFormatRetryAttemptsBySignature.clear();
  clickAndDragFormatIssueBySignature.clear();
}

function getClickAndDragFormatRetryCount(signature = "") {
  const normalizedSignature = normalizeQuizText(signature);
  if (!normalizedSignature) return 0;
  return clickAndDragFormatRetryAttemptsBySignature.get(normalizedSignature) || 0;
}

function incrementClickAndDragFormatRetryCount(signature = "") {
  const normalizedSignature = normalizeQuizText(signature);
  if (!normalizedSignature) return 0;
  const nextCount = getClickAndDragFormatRetryCount(normalizedSignature) + 1;
  clickAndDragFormatRetryAttemptsBySignature.set(normalizedSignature, nextCount);
  return nextCount;
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

function normalizeQuizText(text) {
  return String(text || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripMultipleChoiceOptionPrefix(text) {
  return normalizeQuizText(text)
    .replace(/^option\s+\d+\s*[:.)-]\s*/i, "")
    .replace(/^(?:\(?[a-z]\)?|\d{1,2})\s*[:.)-]\s*/i, "")
    .trim();
}

function normalizeMultipleChoiceComparisonText(text) {
  return stripMultipleChoiceOptionPrefix(text)
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeComparisonText(text) {
  const normalized = normalizeMultipleChoiceComparisonText(text);
  if (!normalized) return [];
  return normalized.split(" ").filter(Boolean);
}

function scoreTextTokenOverlap(referenceText, candidateText) {
  const referenceTokens = tokenizeComparisonText(referenceText);
  const candidateTokens = tokenizeComparisonText(candidateText);
  if (!referenceTokens.length || !candidateTokens.length) {
    return 0;
  }

  const referenceSet = new Set(referenceTokens);
  const candidateSet = new Set(candidateTokens);
  let overlap = 0;
  referenceSet.forEach((token) => {
    if (candidateSet.has(token)) {
      overlap += 1;
    }
  });

  if (!overlap) {
    return 0;
  }

  const precision = overlap / candidateSet.size;
  const recall = overlap / referenceSet.size;
  return (2 * precision * recall) / (precision + recall);
}

function coerceMultipleChoiceAnswerText(answer) {
  if (typeof answer === "string") return answer;

  if (Array.isArray(answer)) {
    const firstString = answer.find(
      (entry) => typeof entry === "string" && normalizeQuizText(entry)
    );
    return firstString || "";
  }

  if (answer && typeof answer === "object") {
    const candidateFields = [
      "answer",
      "choice",
      "option",
      "text",
      "label",
      "value",
      "match",
    ];

    for (const field of candidateFields) {
      const value = answer[field];
      if (typeof value === "string" && normalizeQuizText(value)) {
        return value;
      }

      if (Array.isArray(value)) {
        const firstString = value.find(
          (entry) => typeof entry === "string" && normalizeQuizText(entry)
        );
        if (firstString) return firstString;
      }
    }
  }

  if (typeof answer === "number") return String(answer);
  return normalizeQuizText(answer);
}

function parseMultipleChoiceAnswerIndex(answerText, optionCount) {
  if (!answerText || optionCount <= 0) return -1;
  const normalized = normalizeQuizText(answerText);
  if (!normalized) return -1;

  const numericMatch = normalized.match(/^(?:option\s*)?(\d{1,2})$/i);
  if (numericMatch) {
    const index = Number(numericMatch[1]) - 1;
    if (index >= 0 && index < optionCount) {
      return index;
    }
  }

  const letterMatch = normalized.match(/^(?:option\s*)?([a-z])$/i);
  if (letterMatch) {
    const index = letterMatch[1].toLowerCase().charCodeAt(0) - 97;
    if (index >= 0 && index < optionCount) {
      return index;
    }
  }

  return -1;
}

function getMultipleChoiceOptionModels() {
  const labels = Array.from(
    document.querySelectorAll(".answers--mc .answer__label--mc")
  );
  const radioButtons = Array.from(
    document.querySelectorAll('.answers--mc input[type="radio"]')
  );

  return labels
    .map((label, index) => {
      const rawText = normalizeQuizText(label.textContent);
      const text = stripMultipleChoiceOptionPrefix(rawText);
      const input =
        label.querySelector('input[type="radio"]') || radioButtons[index] || null;

      return {
        index,
        label,
        input,
        rawText,
        text,
        comparisonText: normalizeMultipleChoiceComparisonText(text),
      };
    })
    .filter((option) => option.text);
}

function resolveMultipleChoiceAnswerOption(answer, optionModels) {
  if (!Array.isArray(optionModels) || optionModels.length === 0) {
    return null;
  }

  const answerText = coerceMultipleChoiceAnswerText(answer);
  if (!answerText) return null;

  const indexedMatch = parseMultipleChoiceAnswerIndex(
    answerText,
    optionModels.length
  );
  if (indexedMatch >= 0) {
    return optionModels[indexedMatch] || null;
  }

  const normalizedAnswer = normalizeMultipleChoiceComparisonText(answerText);
  if (!normalizedAnswer) return null;

  let best = null;
  let runnerUp = null;

  optionModels.forEach((option) => {
    const candidate = option.comparisonText;
    if (!candidate) return;

    let score = 0;

    if (candidate === normalizedAnswer) {
      score = 1;
    } else if (
      candidate.includes(normalizedAnswer) ||
      normalizedAnswer.includes(candidate)
    ) {
      const shorterLength = Math.min(candidate.length, normalizedAnswer.length);
      const longerLength = Math.max(candidate.length, normalizedAnswer.length);
      if (shorterLength >= 8 && longerLength > 0) {
        score = shorterLength / longerLength;
      }
    }

    score = Math.max(score, scoreTextTokenOverlap(candidate, normalizedAnswer));

    const scored = { option, score };
    if (!best || scored.score > best.score) {
      runnerUp = best;
      best = scored;
      return;
    }

    if (!runnerUp || scored.score > runnerUp.score) {
      runnerUp = scored;
    }
  });

  if (!best) return null;

  const margin = best.score - (runnerUp?.score || 0);
  if (
    best.score >= MULTIPLE_CHOICE_MATCH_THRESHOLD &&
    (margin >= MULTIPLE_CHOICE_MATCH_MARGIN || best.score >= 0.96)
  ) {
    return best.option;
  }

  return null;
}

function normalizeClickAndDragComparableText(text) {
  return normalizeQuizText(text)
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"');
}

function normalizeClickAndDragQuoteOmissionComparableText(text) {
  return normalizeClickAndDragComparableText(text)
    .replace(/"[^"]*"/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getClickAndDragIframeElement() {
  return document.querySelector(CLICK_AND_DRAG_IFRAME_SELECTOR);
}

function getClickAndDragDocument() {
  const iframe = getClickAndDragIframeElement();
  if (!iframe) return null;

  try {
    return iframe.contentDocument || iframe.contentWindow?.document || null;
  } catch (error) {
    return null;
  }
}

function isClickAndDragIframeStillLoading(doc = getClickAndDragDocument()) {
  const iframe = getClickAndDragIframeElement();
  if (!iframe) return false;

  const externalSpinner = document.querySelector("#goReactSpinner");
  if (externalSpinner && isElementLikelyVisible(externalSpinner)) {
    return true;
  }

  if (!doc) return true;

  const readyState = String(doc.readyState || "").toLowerCase();
  if (readyState === "loading" || readyState === "uninitialized") {
    return true;
  }

  const iframeLoader = doc.querySelector("#loader, .ahe-ui-loading-spinner");
  if (iframeLoader && isElementLikelyVisible(iframeLoader)) {
    return true;
  }

  const hasDropzones = Boolean(doc.querySelector(".drop-zone[dropzoneid]"));
  const hasLabels = Boolean(doc.querySelector(".label-box[labelid]"));
  return !(hasDropzones && hasLabels);
}

function isClickAndDragQuestionPendingLoad(snapshot = getQuizStateSnapshot()) {
  return (
    snapshot?.questionType === "click_and_drag" &&
    isClickAndDragIframeStillLoading()
  );
}

function getClickAndDragQuestionText() {
  const worksheetMain = document.querySelector(".worksheet__main");
  if (worksheetMain) {
    const textParts = Array.from(worksheetMain.querySelectorAll("h1, h2, h3, p"))
      .map((node) => normalizeQuizText(node.textContent))
      .filter(Boolean);
    if (textParts.length > 0) {
      return textParts.join("\n");
    }
  }

  const fallbackWrap = document.querySelector(".question-wrap");
  return normalizeQuizText(fallbackWrap?.textContent || "");
}

function normalizeClickAndDragCategoryText(text) {
  return normalizeClickAndDragComparableText(text).replace(
    CLICK_AND_DRAG_CATEGORY_COUNT_SUFFIX_REGEX,
    ""
  );
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getAnswerDelayPlan(questionId) {
  if (!answerDelayConfig.enabled) {
    return {
      enabled: false,
      targetMs: 0,
      elapsedMs: 0,
      holdMs: 0,
    };
  }

  const averageMs = answerDelayConfig.averageSec * 1000;
  const jitterMs = answerDelayConfig.jitterSec * 1000;
  const jitterFactor = Math.random() + Math.random() - 1;
  const targetMs = Math.max(0, Math.round(averageMs + jitterMs * jitterFactor));
  const perfEntry = questionId ? ensureQuestionPerfEntry(questionId) : null;
  const dispatchedAt = perfEntry?.dispatchedAt || Date.now();
  const elapsedMs = Math.max(0, Date.now() - dispatchedAt);
  const holdMs = Math.max(0, targetMs - elapsedMs);

  return {
    enabled: true,
    targetMs,
    elapsedMs,
    holdMs,
  };
}

async function applyHumanlikeAnswerDelay(activeQuestionId) {
  if (!isAutomating) return false;

  const delayPlan = getAnswerDelayPlan(activeQuestionId);
  if (!delayPlan.enabled) return true;

  logPerf(
    `${activeQuestionId || "unknown"} pacing target=${delayPlan.targetMs}ms elapsed=${delayPlan.elapsedMs}ms hold=${delayPlan.holdMs}ms`
  );

  if (delayPlan.holdMs <= 0) {
    return isAutomating;
  }

  await delay(delayPlan.holdMs);
  return isAutomating;
}

function createKeyboardEvent(
  type,
  key,
  code,
  keyCode,
  doc = document
) {
  const view = doc?.defaultView || window;

  let event = null;
  try {
    event = new view.KeyboardEvent(type, {
      key,
      code,
      bubbles: true,
      cancelable: true,
      composed: true,
      keyCode,
      which: keyCode,
      charCode: keyCode,
    });
  } catch (error) {
    event = new view.Event(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
    });
  }

  try {
    Object.defineProperty(event, "key", { get: () => key });
    Object.defineProperty(event, "code", { get: () => code });
    Object.defineProperty(event, "keyCode", { get: () => keyCode });
    Object.defineProperty(event, "which", { get: () => keyCode });
    Object.defineProperty(event, "charCode", { get: () => keyCode });
  } catch (error) {}

  return event;
}

function dispatchKeyboardSequence(
  target,
  key,
  code,
  keyCode,
  doc = target?.ownerDocument || document
) {
  if (!target) return;
  target.dispatchEvent(createKeyboardEvent("keydown", key, code, keyCode, doc));
  target.dispatchEvent(createKeyboardEvent("keypress", key, code, keyCode, doc));
  target.dispatchEvent(createKeyboardEvent("keyup", key, code, keyCode, doc));
}

function getClickAndDragCategoryModels(doc = getClickAndDragDocument()) {
  if (!doc) return [];

  const categories = [];
  const groups = Array.from(
    doc.querySelectorAll("#js-groupActivityContainer .groups")
  );

  groups.forEach((groupNode) => {
    const categoryText = normalizeClickAndDragCategoryText(
      groupNode.querySelector("h3")?.textContent || ""
    );
    const dropzoneNode = groupNode.querySelector(".drop-zone[dropzoneid]");
    const dropzoneId =
      dropzoneNode?.getAttribute("dropzoneid") || dropzoneNode?.id || "";

    if (!categoryText || !dropzoneId) return;
    if (categories.some((category) => category.dropzoneId === dropzoneId)) return;

    categories.push({
      index: categories.length,
      categoryText,
      normalizedText: normalizeClickAndDragComparableText(categoryText),
      normalizedLower: normalizeClickAndDragComparableText(categoryText).toLowerCase(),
      normalizedQuoteOmission: normalizeClickAndDragQuoteOmissionComparableText(
        categoryText
      ),
      dropzoneId,
    });
  });

  if (categories.length > 0) {
    return categories;
  }

  const fallbackTitles = Array.from(
    doc.querySelectorAll("#js-groupActivityContainer .groups h3")
  )
    .map((node) => normalizeClickAndDragCategoryText(node.textContent))
    .filter(Boolean);
  const fallbackDropzones = Array.from(doc.querySelectorAll(".drop-zone[dropzoneid]"));
  const fallbackCount = Math.min(fallbackTitles.length, fallbackDropzones.length);

  for (let index = 0; index < fallbackCount; index += 1) {
    const dropzoneNode = fallbackDropzones[index];
    const dropzoneId =
      dropzoneNode?.getAttribute("dropzoneid") || dropzoneNode?.id || "";
    if (!dropzoneId) continue;
    if (categories.some((category) => category.dropzoneId === dropzoneId)) continue;

    const categoryText = fallbackTitles[index];
    categories.push({
      index: categories.length,
      categoryText,
      normalizedText: normalizeClickAndDragComparableText(categoryText),
      normalizedLower: normalizeClickAndDragComparableText(categoryText).toLowerCase(),
      normalizedQuoteOmission: normalizeClickAndDragQuoteOmissionComparableText(
        categoryText
      ),
      dropzoneId,
    });
  }

  return categories;
}

function getClickAndDragLabelModels(doc = getClickAndDragDocument()) {
  if (!doc) return [];

  const labels = [];
  const seenLabelIds = new Set();
  const labelNodes = Array.from(doc.querySelectorAll(".label-box[labelid]"));

  labelNodes.forEach((labelNode) => {
    const labelId =
      labelNode.getAttribute("labelid") ||
      labelNode.getAttribute("id") ||
      labelNode.id ||
      "";
    if (!labelId || seenLabelIds.has(labelId)) return;

    const labelText = normalizeQuizText(
      labelNode.querySelector(".label-text")?.textContent || labelNode.textContent
    );
    if (!labelText) return;

    const dropzoneNode = labelNode.closest(".drop-zone[dropzoneid]");
    const dropzoneId =
      dropzoneNode?.getAttribute("dropzoneid") || dropzoneNode?.id || "";

    labels.push({
      index: labels.length,
      labelId,
      labelText,
      normalizedText: normalizeClickAndDragComparableText(labelText),
      normalizedLower: normalizeClickAndDragComparableText(labelText).toLowerCase(),
      normalizedQuoteOmission: normalizeClickAndDragQuoteOmissionComparableText(
        labelText
      ),
      dropzoneId,
      isInPool: Boolean(labelNode.closest("#label-list")),
    });

    seenLabelIds.add(labelId);
  });

  return labels;
}

function extractClickAndDragLabels(doc = getClickAndDragDocument()) {
  return getClickAndDragLabelModels(doc).map((label) => label.labelText);
}

function extractClickAndDragCategories(doc = getClickAndDragDocument()) {
  return getClickAndDragCategoryModels(doc).map((category) => category.categoryText);
}

function tryParseClickAndDragAnswerArrayString(value) {
  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : null;
  } catch (error) {}

  const entries = [];
  const itemRegex = /"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'/g;
  let match = null;
  while ((match = itemRegex.exec(trimmed)) !== null) {
    const raw = match[1] !== undefined ? match[1] : match[2];
    const normalized = normalizeQuizText(raw.replace(/\\"/g, '"'));
    if (normalized) {
      entries.push(normalized);
    }
  }

  return entries.length > 0 ? entries : null;
}

function splitClickAndDragAnswerSegments(value) {
  if (typeof value !== "string") return [];

  return value
    .split(/\n|;/)
    .map((segment) =>
      segment
        .trim()
        .replace(/^[-*•]\s+/, "")
        .replace(/^["'`]|["'`]$/g, "")
        .replace(/^\d+[\.)]\s+/, "")
        .trim()
    )
    .filter(Boolean);
}

function parseClickAndDragPairString(value) {
  if (typeof value !== "string") return null;

  const cleaned = value
    .trim()
    .replace(/^[-*•]\s+/, "")
    .replace(/^["'`]|["'`]$/g, "")
    .replace(/^\d+[\.)]\s+/, "")
    .trim();
  if (!cleaned) return null;

  const arrowMatch = cleaned.match(/^(.*?)\s*(?:->|=>)\s*(.+)$/);
  if (arrowMatch) {
    return {
      labelRef: arrowMatch[1].trim(),
      categoryRef: arrowMatch[2].trim(),
      raw: cleaned,
    };
  }

  const colonMatch = cleaned.match(/^(.*?)\s*:\s*(.+)$/);
  if (colonMatch) {
    return {
      labelRef: colonMatch[1].trim(),
      categoryRef: colonMatch[2].trim(),
      raw: cleaned,
    };
  }

  return null;
}

function collectClickAndDragAnswerEntries(rawAnswer, output) {
  if (!output || rawAnswer === null || rawAnswer === undefined) return;

  if (Array.isArray(rawAnswer)) {
    for (let index = 0; index < rawAnswer.length; index += 1) {
      const entry = rawAnswer[index];
      if (typeof entry !== "string") {
        collectClickAndDragAnswerEntries(entry, output);
        continue;
      }

      const normalizedEntry = normalizeQuizText(entry);
      if (!normalizedEntry) continue;

      const parsed = parseClickAndDragPairString(normalizedEntry);
      if (parsed?.labelRef && parsed?.categoryRef) {
        output.push(parsed);
        continue;
      }

      if (!parsed) {
        const nextEntry = rawAnswer[index + 1];
        if (typeof nextEntry === "string") {
          const parsedNext = parseClickAndDragPairString(nextEntry);
          if (parsedNext?.labelRef && parsedNext.categoryRef) {
            const mergedLabel = normalizeQuizText(
              `${normalizedEntry} ${parsedNext.labelRef}`
            );
            output.push({
              labelRef: mergedLabel,
              categoryRef: parsedNext.categoryRef,
              raw: `${mergedLabel} -> ${parsedNext.categoryRef}`,
            });
            index += 1;
            continue;
          }

          if (parsedNext && !parsedNext.labelRef && parsedNext.categoryRef) {
            output.push({
              labelRef: normalizedEntry,
              categoryRef: parsedNext.categoryRef,
              raw: `${normalizedEntry} -> ${parsedNext.categoryRef}`,
            });
            index += 1;
            continue;
          }
        }
      }

      if (parsed && parsed.labelRef && !parsed.categoryRef) {
        const nextEntry = rawAnswer[index + 1];
        if (typeof nextEntry === "string") {
          const normalizedNext = normalizeQuizText(nextEntry);
          if (normalizedNext && !parseClickAndDragPairString(normalizedNext)) {
            output.push({
              labelRef: parsed.labelRef,
              categoryRef: normalizedNext,
              raw: `${parsed.labelRef} -> ${normalizedNext}`,
            });
            index += 1;
          }
        }
      }
    }
    return;
  }

  if (typeof rawAnswer === "object") {
    const labelCandidate =
      rawAnswer.label ??
      rawAnswer.left ??
      rawAnswer.prompt ??
      rawAnswer.source ??
      rawAnswer.from ??
      rawAnswer.key;
    const categoryCandidate =
      rawAnswer.category ??
      rawAnswer.group ??
      rawAnswer.right ??
      rawAnswer.target ??
      rawAnswer.to ??
      rawAnswer.value ??
      rawAnswer.answer ??
      rawAnswer.match ??
      rawAnswer.choice;

    if (labelCandidate !== undefined && categoryCandidate !== undefined) {
      output.push({
        labelRef: String(labelCandidate),
        categoryRef: String(categoryCandidate),
        raw: `${String(labelCandidate)} -> ${String(categoryCandidate)}`,
      });
      return;
    }

    Object.entries(rawAnswer).forEach(([labelRef, categoryRef]) => {
      output.push({
        labelRef: String(labelRef),
        categoryRef: String(categoryRef),
        raw: `${String(labelRef)} -> ${String(categoryRef)}`,
      });
    });
    return;
  }

  if (typeof rawAnswer === "string") {
    const parsedArray = tryParseClickAndDragAnswerArrayString(rawAnswer);
    if (parsedArray) {
      collectClickAndDragAnswerEntries(parsedArray, output);
      return;
    }

    const segments = splitClickAndDragAnswerSegments(rawAnswer);
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      const parsed = parseClickAndDragPairString(segment);

      if (parsed?.labelRef && parsed?.categoryRef) {
        output.push(parsed);
        continue;
      }

      if (!parsed) {
        const parsedNext = parseClickAndDragPairString(segments[index + 1] || "");
        if (parsedNext?.labelRef && parsedNext.categoryRef) {
          const mergedLabel = normalizeQuizText(`${segment} ${parsedNext.labelRef}`);
          output.push({
            labelRef: mergedLabel,
            categoryRef: parsedNext.categoryRef,
            raw: `${mergedLabel} -> ${parsedNext.categoryRef}`,
          });
          index += 1;
          continue;
        }

        if (parsedNext && !parsedNext.labelRef && parsedNext.categoryRef) {
          output.push({
            labelRef: segment,
            categoryRef: parsedNext.categoryRef,
            raw: `${segment} -> ${parsedNext.categoryRef}`,
          });
          index += 1;
          continue;
        }
      }

      if (parsed && parsed.labelRef && !parsed.categoryRef) {
        const nextSegment = segments[index + 1];
        if (nextSegment && !parseClickAndDragPairString(nextSegment)) {
          output.push({
            labelRef: parsed.labelRef,
            categoryRef: nextSegment,
            raw: `${parsed.labelRef} -> ${nextSegment}`,
          });
          index += 1;
        }
      }
    }
    return;
  }
}

function normalizeClickAndDragAnswerEntries(rawAnswer) {
  const collected = [];
  collectClickAndDragAnswerEntries(rawAnswer, collected);
  return collected
    .map((entry) => ({
      labelRef: normalizeClickAndDragComparableText(entry.labelRef),
      categoryRef: normalizeClickAndDragComparableText(entry.categoryRef),
      raw: normalizeQuizText(entry.raw),
    }))
    .filter((entry) => entry.labelRef && entry.categoryRef);
}

function parseClickAndDragNumericReference(referenceText, kind, candidateCount) {
  const normalized = normalizeClickAndDragComparableText(referenceText);
  if (!normalized || candidateCount <= 0) return -1;

  const patterns = [/^#?(\d+)$/];
  if (kind === "label") {
    patterns.push(/^(?:label|item)\s*#?\s*(\d+)$/i);
  } else {
    patterns.push(/^(?:category|group)\s*#?\s*(\d+)$/i);
    patterns.push(/^drop\s*zone\s*#?\s*(\d+)$/i);
  }

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (!match) continue;

    const index = Number(match[1]) - 1;
    if (Number.isInteger(index) && index >= 0 && index < candidateCount) {
      return index;
    }
  }

  return -1;
}

function resolveClickAndDragReference(referenceText, candidates, kind) {
  const normalizedReference = normalizeClickAndDragComparableText(referenceText);
  if (!normalizedReference) {
    return {
      status: "unresolved",
      reason: "empty_reference",
      candidate: null,
    };
  }

  if (!Array.isArray(candidates) || candidates.length === 0) {
    return {
      status: "unresolved",
      reason: "no_candidates",
      candidate: null,
    };
  }

  const exactMatches = candidates.filter(
    (candidate) => candidate.normalizedText === normalizedReference
  );
  if (exactMatches.length === 1) {
    return {
      status: "resolved",
      reason: "exact",
      candidate: exactMatches[0],
    };
  }
  if (exactMatches.length > 1) {
    return {
      status: "ambiguous",
      reason: "ambiguous_exact",
      candidate: null,
    };
  }

  const normalizedLower = normalizedReference.toLowerCase();
  const caseInsensitiveMatches = candidates.filter(
    (candidate) => candidate.normalizedLower === normalizedLower
  );
  if (caseInsensitiveMatches.length === 1) {
    return {
      status: "resolved",
      reason: "case_insensitive_exact",
      candidate: caseInsensitiveMatches[0],
    };
  }
  if (caseInsensitiveMatches.length > 1) {
    return {
      status: "ambiguous",
      reason: "ambiguous_case_insensitive_exact",
      candidate: null,
    };
  }

  const partialMatches = candidates.filter(
    (candidate) =>
      candidate.normalizedLower.includes(normalizedLower) ||
      normalizedLower.includes(candidate.normalizedLower)
  );
  if (partialMatches.length === 1) {
    return {
      status: "resolved",
      reason: "unique_partial",
      candidate: partialMatches[0],
    };
  }
  if (partialMatches.length > 1) {
    return {
      status: "ambiguous",
      reason: "ambiguous_partial",
      candidate: null,
    };
  }

  const normalizedQuoteOmissionReference =
    normalizeClickAndDragQuoteOmissionComparableText(normalizedReference);
  if (normalizedQuoteOmissionReference) {
    const quoteOmissionExactMatches = candidates.filter((candidate) => {
      const candidateQuoteOmission =
        candidate.normalizedQuoteOmission ||
        normalizeClickAndDragQuoteOmissionComparableText(candidate.normalizedText);
      return candidateQuoteOmission === normalizedQuoteOmissionReference;
    });
    if (quoteOmissionExactMatches.length === 1) {
      return {
        status: "resolved",
        reason: "quote_omission_exact",
        candidate: quoteOmissionExactMatches[0],
      };
    }
    if (quoteOmissionExactMatches.length > 1) {
      return {
        status: "ambiguous",
        reason: "ambiguous_quote_omission_exact",
        candidate: null,
      };
    }

    const quoteOmissionPartialMatches = candidates.filter((candidate) => {
      const candidateQuoteOmission =
        candidate.normalizedQuoteOmission ||
        normalizeClickAndDragQuoteOmissionComparableText(candidate.normalizedText);
      return (
        candidateQuoteOmission.includes(normalizedQuoteOmissionReference) ||
        normalizedQuoteOmissionReference.includes(candidateQuoteOmission)
      );
    });
    if (quoteOmissionPartialMatches.length === 1) {
      return {
        status: "resolved",
        reason: "quote_omission_partial",
        candidate: quoteOmissionPartialMatches[0],
      };
    }
    if (quoteOmissionPartialMatches.length > 1) {
      return {
        status: "ambiguous",
        reason: "ambiguous_quote_omission_partial",
        candidate: null,
      };
    }
  }

  const numericIndex = parseClickAndDragNumericReference(
    normalizedReference,
    kind,
    candidates.length
  );
  if (numericIndex >= 0) {
    return {
      status: "resolved",
      reason: "numeric",
      candidate: candidates[numericIndex],
    };
  }

  return {
    status: "unresolved",
    reason: "no_match",
    candidate: null,
  };
}

function normalizeClickAndDragTargets(rawAnswer, doc = getClickAndDragDocument()) {
  const labelCandidates = getClickAndDragLabelModels(doc);
  const categoryCandidates = getClickAndDragCategoryModels(doc);
  const entries = normalizeClickAndDragAnswerEntries(rawAnswer);

  const resolvedMoves = [];
  const unresolved = [];
  const conflicts = [];
  const duplicates = [];
  const assignmentsByLabelId = new Map();
  const mentionedLabelIds = new Set();

  if (!labelCandidates.length || !categoryCandidates.length || !entries.length) {
    return {
      resolvedMoves,
      unresolved,
      conflicts,
      duplicates,
      entries,
      labelCandidates,
      categoryCandidates,
    };
  }

  entries.forEach((entry) => {
    const labelResolution = resolveClickAndDragReference(
      entry.labelRef,
      labelCandidates,
      "label"
    );
    const categoryResolution = resolveClickAndDragReference(
      entry.categoryRef,
      categoryCandidates,
      "category"
    );
    if (labelResolution.status === "resolved" && labelResolution.candidate?.labelId) {
      mentionedLabelIds.add(labelResolution.candidate.labelId);
    }

    if (labelResolution.status !== "resolved" || categoryResolution.status !== "resolved") {
      unresolved.push({
        raw: entry.raw,
        labelRef: entry.labelRef,
        categoryRef: entry.categoryRef,
        labelReason: labelResolution.reason,
        categoryReason: categoryResolution.reason,
      });
      return;
    }

    const labelCandidate = labelResolution.candidate;
    const categoryCandidate = categoryResolution.candidate;
    const existing = assignmentsByLabelId.get(labelCandidate.labelId);

    if (existing) {
      if (existing.targetDropzoneId === categoryCandidate.dropzoneId) {
        duplicates.push({
          labelId: labelCandidate.labelId,
          labelText: labelCandidate.labelText,
          categoryText: categoryCandidate.categoryText,
          raw: entry.raw,
        });
        return;
      }

      conflicts.push({
        labelId: labelCandidate.labelId,
        labelText: labelCandidate.labelText,
        existingCategoryText: existing.categoryText,
        requestedCategoryText: categoryCandidate.categoryText,
        raw: entry.raw,
      });
      return;
    }

    const move = {
      labelId: labelCandidate.labelId,
      labelText: labelCandidate.labelText,
      targetDropzoneId: categoryCandidate.dropzoneId,
      categoryText: categoryCandidate.categoryText,
    };

    assignmentsByLabelId.set(labelCandidate.labelId, move);
    resolvedMoves.push(move);
  });

  // EZTO click-and-drag expects every label to be placed; flag omissions explicitly.
  labelCandidates.forEach((labelCandidate) => {
    if (mentionedLabelIds.has(labelCandidate.labelId)) return;
    unresolved.push({
      raw: `Missing mapping for label: ${labelCandidate.labelText}`,
      labelRef: labelCandidate.labelText,
      categoryRef: "",
      labelReason: "missing_mapping",
      categoryReason: "missing_mapping",
    });
  });

  return {
    resolvedMoves,
    unresolved,
    conflicts,
    duplicates,
    entries,
    labelCandidates,
    categoryCandidates,
  };
}

function getClickAndDragLabelNodesById(
  labelId,
  doc = getClickAndDragDocument()
) {
  if (!doc || !labelId) return [];
  const escapedLabelId = String(labelId).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return Array.from(doc.querySelectorAll(`.label-box[labelid="${escapedLabelId}"]`));
}

function isElementLikelyVisible(element) {
  if (!element) return false;
  if (element.hidden) return false;

  const ownerDoc = element.ownerDocument || document;
  const view = ownerDoc.defaultView || window;
  const style = view.getComputedStyle ? view.getComputedStyle(element) : null;

  if (style) {
    if (style.display === "none") return false;
    if (style.visibility === "hidden") return false;
    if (style.opacity === "0") return false;
  }

  if (typeof element.getBoundingClientRect === "function") {
    const rect = element.getBoundingClientRect();
    if (!rect || (!rect.width && !rect.height)) return false;
  }

  return true;
}

function getClickAndDragLabelNodeById(
  labelId,
  doc = getClickAndDragDocument()
) {
  const candidates = getClickAndDragLabelNodesById(labelId, doc).filter(
    (node) => node && node.isConnected
  );
  if (candidates.length === 0) return null;

  const scored = candidates.map((node) => {
    let score = 0;
    if (node.getAttribute("aria-pressed") === "true") score += 8;
    if (node.closest(".drop-zone[dropzoneid]")) score += 4;
    if (node.closest("#label-list")) score += 1;
    if (isElementLikelyVisible(node)) score += 2;
    if (node.getAttribute("aria-disabled") === "true") score -= 6;
    return { node, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.node || null;
}

function getClickAndDragDropzoneById(
  dropzoneId,
  doc = getClickAndDragDocument()
) {
  if (!doc || !dropzoneId) return null;
  const escapedDropzoneId = String(dropzoneId)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
  return doc.querySelector(`.drop-zone[dropzoneid="${escapedDropzoneId}"]`);
}

function getClickAndDragDropTargetById(
  dropzoneId,
  doc = getClickAndDragDocument()
) {
  const dropzone = getClickAndDragDropzoneById(dropzoneId, doc);
  if (!dropzone) return null;
  return dropzone.querySelector(".single-drop-zone") || dropzone;
}

function getClickAndDragGroupContainerByDropzoneId(
  dropzoneId,
  doc = getClickAndDragDocument()
) {
  const dropzone = getClickAndDragDropzoneById(dropzoneId, doc);
  if (!dropzone) return null;
  return dropzone.closest(".groups");
}

function getClickAndDragGroupTitleByDropzoneId(
  dropzoneId,
  doc = getClickAndDragDocument()
) {
  const group = getClickAndDragGroupContainerByDropzoneId(dropzoneId, doc);
  if (!group) return null;
  return group.querySelector("h3");
}

function getClickAndDragLabelPlacement(
  labelId,
  doc = getClickAndDragDocument()
) {
  const labelNodes = getClickAndDragLabelNodesById(labelId, doc).filter(
    (node) => node && node.isConnected
  );
  if (labelNodes.length === 0) return "";

  let bestDropzoneId = "";
  let bestScore = -Infinity;

  labelNodes.forEach((node) => {
    const dropzoneNode = node.closest(".drop-zone[dropzoneid]");
    const dropzoneId = dropzoneNode?.getAttribute("dropzoneid") || "";
    if (!dropzoneId) return;

    let score = 0;
    if (isElementLikelyVisible(node)) score += 2;
    if (node.getAttribute("aria-disabled") !== "true") score += 1;
    if (node.getAttribute("aria-pressed") === "true") score += 1;

    if (score > bestScore) {
      bestScore = score;
      bestDropzoneId = dropzoneId;
    }
  });

  return bestDropzoneId;
}

function isClickAndDragLabelInDropzone(
  labelId,
  dropzoneId,
  doc = getClickAndDragDocument()
) {
  const placedDropzoneId = getClickAndDragLabelPlacement(labelId, doc);
  return Boolean(
    placedDropzoneId &&
      String(placedDropzoneId) === String(dropzoneId || "")
  );
}

function countClickAndDragAlignedMoves(
  moves,
  doc = getClickAndDragDocument()
) {
  if (!Array.isArray(moves) || moves.length === 0) return 0;
  return moves.filter((move) =>
    isClickAndDragLabelInDropzone(move.labelId, move.targetDropzoneId, doc)
  ).length;
}

function isClickAndDragAligned(moves, doc = getClickAndDragDocument()) {
  if (!Array.isArray(moves) || moves.length === 0) return false;
  return (
    countClickAndDragAlignedMoves(moves, doc) === moves.length
  );
}

function getElementCenterPoint(element) {
  if (!element || typeof element.getBoundingClientRect !== "function") return null;
  const rect = element.getBoundingClientRect();
  if (!rect || (!rect.width && !rect.height)) return null;
  return {
    clientX: rect.left + rect.width / 2,
    clientY: rect.top + rect.height / 2,
  };
}

function dispatchMouseEvent(target, type, point, buttons = 0, doc = document) {
  if (!target || !doc) return;
  const view = doc.defaultView || window;

  let event = null;
  try {
    event = new view.MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: point?.clientX || 0,
      clientY: point?.clientY || 0,
      button: buttons ? 0 : 0,
      buttons,
      detail: 1,
      view,
    });
  } catch (error) {
    event = new view.Event(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
    });
  }

  target.dispatchEvent(event);
}

function dispatchPointerEvent(target, type, point, buttons = 0, doc = document) {
  if (!target || !doc) return;
  const view = doc.defaultView || window;
  if (typeof view.PointerEvent !== "function") return;

  let event = null;
  try {
    event = new view.PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      pointerType: "mouse",
      pointerId: 1,
      isPrimary: true,
      clientX: point?.clientX || 0,
      clientY: point?.clientY || 0,
      button: buttons ? 0 : 0,
      buttons,
    });
  } catch (error) {
    return;
  }

  target.dispatchEvent(event);
}

function createFallbackDataTransfer() {
  const store = {};
  return {
    dropEffect: "move",
    effectAllowed: "all",
    files: [],
    items: [],
    types: [],
    setData(format, data) {
      store[format] = String(data);
      if (!this.types.includes(format)) {
        this.types.push(format);
      }
    },
    getData(format) {
      return store[format] || "";
    },
    clearData(format) {
      if (format) {
        delete store[format];
        this.types = this.types.filter((type) => type !== format);
        return;
      }

      Object.keys(store).forEach((key) => delete store[key]);
      this.types = [];
    },
    setDragImage() {},
  };
}

function dispatchDragEvent(target, type, dataTransfer, point, doc = document) {
  if (!target || !doc) return;
  const view = doc.defaultView || window;

  let event = null;
  try {
    event = new view.DragEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: point?.clientX || 0,
      clientY: point?.clientY || 0,
      dataTransfer,
    });
  } catch (error) {
    event = new view.Event(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
    });
    try {
      Object.defineProperty(event, "dataTransfer", {
        value: dataTransfer,
      });
    } catch (defineError) {}
  }

  target.dispatchEvent(event);
}

async function attemptClickAndDragPointerMove(
  labelId,
  targetDropzoneId,
  doc = getClickAndDragDocument()
) {
  const labelNode = getClickAndDragLabelNodeById(labelId, doc);
  const targetDropzone = getClickAndDragDropzoneById(targetDropzoneId, doc);
  const targetNode = getClickAndDragDropTargetById(targetDropzoneId, doc);
  if (!labelNode || !targetDropzone || !targetNode) return false;

  const sourcePoint = getElementCenterPoint(labelNode);
  const targetPoint = getElementCenterPoint(targetNode);
  if (!sourcePoint || !targetPoint) return false;

  const docTarget = doc.body || doc.documentElement;

  dispatchPointerEvent(labelNode, "pointerover", sourcePoint, 0, doc);
  dispatchMouseEvent(labelNode, "mouseover", sourcePoint, 0, doc);
  dispatchPointerEvent(labelNode, "pointermove", sourcePoint, 0, doc);
  dispatchMouseEvent(labelNode, "mousemove", sourcePoint, 0, doc);
  dispatchPointerEvent(labelNode, "pointerdown", sourcePoint, 1, doc);
  dispatchMouseEvent(labelNode, "mousedown", sourcePoint, 1, doc);

  await delay(30);

  const targetHoverNodes = [targetNode, targetDropzone];
  dispatchPointerEvent(labelNode, "pointermove", targetPoint, 1, doc);
  dispatchMouseEvent(labelNode, "mousemove", targetPoint, 1, doc);
  if (docTarget) {
    dispatchPointerEvent(docTarget, "pointermove", sourcePoint, 1, doc);
    dispatchMouseEvent(docTarget, "mousemove", sourcePoint, 1, doc);
    dispatchPointerEvent(docTarget, "pointermove", targetPoint, 1, doc);
    dispatchMouseEvent(docTarget, "mousemove", targetPoint, 1, doc);
  }
  targetHoverNodes.forEach((node) => {
    dispatchPointerEvent(node, "pointermove", targetPoint, 1, doc);
    dispatchMouseEvent(node, "mousemove", targetPoint, 1, doc);
    dispatchPointerEvent(node, "pointerover", targetPoint, 1, doc);
    dispatchMouseEvent(node, "mouseover", targetPoint, 1, doc);
    dispatchMouseEvent(node, "dragover", targetPoint, 1, doc);
  });

  await delay(25);

  const releaseNodes = [targetNode, targetDropzone];
  releaseNodes.forEach((node) => {
    dispatchPointerEvent(node, "pointerup", targetPoint, 0, doc);
    dispatchMouseEvent(node, "mouseup", targetPoint, 0, doc);
    dispatchMouseEvent(node, "drop", targetPoint, 0, doc);
  });

  if (docTarget) {
    dispatchPointerEvent(docTarget, "pointerup", targetPoint, 0, doc);
    dispatchMouseEvent(docTarget, "mouseup", targetPoint, 0, doc);
  }

  await delay(140);
  return isClickAndDragLabelInDropzone(labelId, targetDropzoneId, doc);
}

async function attemptClickAndDragHtml5Move(
  labelId,
  targetDropzoneId,
  doc = getClickAndDragDocument()
) {
  const labelNode = getClickAndDragLabelNodeById(labelId, doc);
  const targetDropzone = getClickAndDragDropzoneById(targetDropzoneId, doc);
  const targetNode = getClickAndDragDropTargetById(targetDropzoneId, doc);
  if (!labelNode || !targetDropzone || !targetNode) return false;

  const view = doc.defaultView || window;
  const dataTransfer =
    typeof view.DataTransfer === "function"
      ? new view.DataTransfer()
      : createFallbackDataTransfer();
  const sourcePoint = getElementCenterPoint(labelNode);
  const targetPoint = getElementCenterPoint(targetNode);

  dataTransfer.setData("text/plain", String(labelId || ""));
  dispatchDragEvent(labelNode, "dragstart", dataTransfer, sourcePoint, doc);
  await delay(10);

  [targetNode, targetDropzone].forEach((node) => {
    dispatchDragEvent(node, "dragenter", dataTransfer, targetPoint, doc);
    dispatchDragEvent(node, "dragover", dataTransfer, targetPoint, doc);
  });
  dispatchDragEvent(targetNode, "drop", dataTransfer, targetPoint, doc);
  dispatchDragEvent(targetDropzone, "drop", dataTransfer, targetPoint, doc);
  await delay(10);
  dispatchDragEvent(labelNode, "dragend", dataTransfer, targetPoint, doc);

  await delay(160);
  return isClickAndDragLabelInDropzone(labelId, targetDropzoneId, doc);
}

async function attemptClickAndDragClickMove(
  labelId,
  targetDropzoneId,
  doc = getClickAndDragDocument()
) {
  const labelNode = getClickAndDragLabelNodeById(labelId, doc);
  const targetDropzone = getClickAndDragDropzoneById(targetDropzoneId, doc);
  const targetNode = getClickAndDragDropTargetById(targetDropzoneId, doc);
  const targetGroup = getClickAndDragGroupContainerByDropzoneId(targetDropzoneId, doc);
  const targetTitle = getClickAndDragGroupTitleByDropzoneId(targetDropzoneId, doc);
  if (!labelNode || !targetDropzone || !targetNode) return false;

  try {
    labelNode.click();
  } catch (error) {
    return false;
  }
  dispatchKeyboardSequence(labelNode, " ", "Space", 32);
  await delay(70);

  const clickTargets = [targetNode, targetDropzone, targetTitle, targetGroup].filter(
    Boolean
  );
  for (const clickTarget of clickTargets) {
    try {
      clickTarget.click();
    } catch (error) {}
    await delay(60);

    if (isClickAndDragLabelInDropzone(labelId, targetDropzoneId, doc)) {
      return true;
    }
  }

  for (const clickTarget of clickTargets) {
    const point = getElementCenterPoint(clickTarget);
    if (!point) continue;

    dispatchMouseEvent(clickTarget, "mousedown", point, 1, doc);
    dispatchMouseEvent(clickTarget, "mouseup", point, 0, doc);
    await delay(60);

    if (isClickAndDragLabelInDropzone(labelId, targetDropzoneId, doc)) {
      return true;
    }
  }

  await delay(120);

  return isClickAndDragLabelInDropzone(labelId, targetDropzoneId, doc);
}

function getFocusedClickAndDragDropzoneId(doc = getClickAndDragDocument()) {
  if (!doc) return "";
  const active = doc.activeElement;
  if (!active || typeof active.closest !== "function") return "";

  const dropzoneNode = active.closest(".drop-zone[dropzoneid], [dropzoneid]");
  if (!dropzoneNode) return "";
  return (
    dropzoneNode.getAttribute("dropzoneid") ||
    dropzoneNode.id ||
    ""
  );
}

async function attemptClickAndDragKeyboardMove(
  labelId,
  targetDropzoneId,
  liftConfig = { key: " ", code: "Space", keyCode: 32 },
  doc = getClickAndDragDocument()
) {
  const labelNode = getClickAndDragLabelNodeById(labelId, doc);
  if (!labelNode) return false;

  const categories = getClickAndDragCategoryModels(doc);
  const targetIndex = categories.findIndex(
    (category) => category.dropzoneId === targetDropzoneId
  );
  if (targetIndex < 0) return false;

  if (typeof labelNode.focus === "function") {
    try {
      labelNode.focus({ preventScroll: true });
    } catch (error) {
      labelNode.focus();
    }
  }

  await delay(35);
  dispatchKeyboardSequence(labelNode, liftConfig.key, liftConfig.code, liftConfig.keyCode);
  await delay(80);

  const targetDropzone = getClickAndDragDropzoneById(targetDropzoneId, doc);
  const targetNode = getClickAndDragDropTargetById(targetDropzoneId, doc);
  const targetTitle = getClickAndDragGroupTitleByDropzoneId(targetDropzoneId, doc);

  const focusAndCommit = async (node) => {
    if (!node) return false;

    if (!node.hasAttribute("tabindex")) {
      node.setAttribute("tabindex", "-1");
    }

    if (typeof node.focus === "function") {
      try {
        node.focus({ preventScroll: true });
      } catch (error) {
        node.focus();
      }
    }

    await delay(30);
    dispatchKeyboardSequence(node, "Enter", "Enter", 13);
    await delay(45);
    if (isClickAndDragLabelInDropzone(labelId, targetDropzoneId, doc)) return true;

    dispatchKeyboardSequence(node, " ", "Space", 32);
    await delay(60);
    return isClickAndDragLabelInDropzone(labelId, targetDropzoneId, doc);
  };

  if (await focusAndCommit(targetNode)) return true;
  if (await focusAndCommit(targetDropzone)) return true;
  if (await focusAndCommit(targetTitle)) return true;

  const focusSearchMoves = [
    { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
    { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
    { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
    { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  ];

  let movedFocusToTarget = false;
  for (const move of focusSearchMoves) {
    for (let step = 0; step < CLICK_AND_DRAG_MOVE_MAX_KEYBOARD_STEPS; step += 1) {
      dispatchKeyboardSequence(labelNode, move.key, move.code, move.keyCode);
      await delay(45);

      const focusedDropzoneId = getFocusedClickAndDragDropzoneId(doc);
      if (
        focusedDropzoneId &&
        String(focusedDropzoneId) === String(targetDropzoneId)
      ) {
        movedFocusToTarget = true;
        break;
      }
    }
    if (movedFocusToTarget) break;
  }

  if (!movedFocusToTarget) {
    const sourceDropzoneId = getClickAndDragLabelPlacement(labelId, doc);
    const sourceIndex = categories.findIndex(
      (category) => category.dropzoneId === sourceDropzoneId
    );
    const delta = sourceIndex >= 0 ? targetIndex - sourceIndex : targetIndex;

    if (delta !== 0) {
      const movementKey = delta < 0 ? "ArrowUp" : "ArrowDown";
      const movementCode = movementKey;
      const movementKeyCode = delta < 0 ? 38 : 40;
      const steps = Math.min(
        Math.abs(delta),
        CLICK_AND_DRAG_MOVE_MAX_KEYBOARD_STEPS
      );

      for (let step = 0; step < steps; step += 1) {
        dispatchKeyboardSequence(labelNode, movementKey, movementCode, movementKeyCode);
        await delay(50);
      }
    }
  }

  dispatchKeyboardSequence(labelNode, liftConfig.key, liftConfig.code, liftConfig.keyCode);
  await delay(150);

  return isClickAndDragLabelInDropzone(labelId, targetDropzoneId, doc);
}

async function moveClickAndDragLabelToDropzone(
  labelId,
  targetDropzoneId,
  doc = getClickAndDragDocument()
) {
  if (!labelId || !targetDropzoneId || !doc) return false;
  if (isClickAndDragLabelInDropzone(labelId, targetDropzoneId, doc)) return true;

  const strategies = [
    () => attemptClickAndDragPointerMove(labelId, targetDropzoneId, doc),
    () => attemptClickAndDragHtml5Move(labelId, targetDropzoneId, doc),
    () => attemptClickAndDragClickMove(labelId, targetDropzoneId, doc),
    () =>
      attemptClickAndDragKeyboardMove(
        labelId,
        targetDropzoneId,
        { key: " ", code: "Space", keyCode: 32 },
        doc
      ),
    () =>
      attemptClickAndDragKeyboardMove(
        labelId,
        targetDropzoneId,
        { key: "Enter", code: "Enter", keyCode: 13 },
        doc
      ),
  ];

  for (const strategy of strategies) {
    let moved = false;
    try {
      moved = await strategy();
    } catch (error) {
      moved = false;
    }

    if (moved || isClickAndDragLabelInDropzone(labelId, targetDropzoneId, doc)) {
      return true;
    }
  }

  return isClickAndDragLabelInDropzone(labelId, targetDropzoneId, doc);
}

async function applyClickAndDragMoves(
  moves,
  doc = getClickAndDragDocument()
) {
  if (!Array.isArray(moves) || moves.length === 0 || !doc) {
    return {
      allApplied: false,
      unresolvedMoves: Array.isArray(moves) ? moves.slice() : [],
      alignedCount: 0,
      resolvedCount: Array.isArray(moves) ? moves.length : 0,
    };
  }

  const pendingMoves = new Map();
  moves.forEach((move) => {
    pendingMoves.set(move.labelId, move);
  });

  for (let pass = 1; pass <= CLICK_AND_DRAG_MOVE_MAX_PASSES; pass += 1) {
    if (pendingMoves.size === 0) break;

    let progressMade = false;
    const passMoves = Array.from(pendingMoves.values());

    for (const move of passMoves) {
      if (!pendingMoves.has(move.labelId)) continue;

      if (isClickAndDragLabelInDropzone(move.labelId, move.targetDropzoneId, doc)) {
        pendingMoves.delete(move.labelId);
        progressMade = true;
        continue;
      }

      const moved = await moveClickAndDragLabelToDropzone(
        move.labelId,
        move.targetDropzoneId,
        doc
      );
      if (moved) {
        pendingMoves.delete(move.labelId);
        progressMade = true;
      } else {
        console.info(LOG_PREFIX, "Click-and-drag move attempt failed", {
          label: move.labelText,
          target: move.categoryText,
          currentDropzoneId: getClickAndDragLabelPlacement(move.labelId, doc) || "pool",
          targetDropzoneId: move.targetDropzoneId,
          pass,
        });
      }
    }

    if (!progressMade) {
      break;
    }
  }

  return {
    allApplied: pendingMoves.size === 0,
    unresolvedMoves: Array.from(pendingMoves.values()),
    alignedCount: countClickAndDragAlignedMoves(moves, doc),
    resolvedCount: moves.length,
  };
}

function formatClickAndDragManualIssueLines(
  targetPlan,
  unresolvedMoves
) {
  const lines = [];

  if (Array.isArray(unresolvedMoves)) {
    unresolvedMoves.forEach((move) => {
      lines.push(`${move.labelText} -> ${move.categoryText}`);
    });
  }

  if (Array.isArray(targetPlan?.unresolved)) {
    targetPlan.unresolved.forEach((entry) => {
      const pairText =
        entry.raw ||
        `${entry.labelRef || "(unresolved label)"} -> ${
          entry.categoryRef || "(unresolved category)"
        }`;
      lines.push(`${pairText}`);
    });
  }

  if (Array.isArray(targetPlan?.conflicts)) {
    targetPlan.conflicts.forEach((entry) => {
      lines.push(
        `${entry.labelText} -> ${entry.requestedCategoryText} (conflicts with ${entry.existingCategoryText})`
      );
    });
  }

  const seen = new Set();
  return lines.filter((line) => {
    const key = normalizeQuizText(line).toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function summarizeClickAndDragFormatIssue(formatIssueDetails) {
  const unresolved = Array.isArray(formatIssueDetails?.unresolved)
    ? formatIssueDetails.unresolved
    : [];
  const conflicts = Array.isArray(formatIssueDetails?.conflicts)
    ? formatIssueDetails.conflicts
    : [];

  const unresolvedReasons = unresolved.reduce((acc, entry) => {
    const labelReason = entry?.labelReason || "unknown";
    const categoryReason = entry?.categoryReason || "unknown";
    const key = `${labelReason}|${categoryReason}`;
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  const examples = [];
  unresolved.slice(0, 3).forEach((entry) => {
    examples.push(
      `${entry?.labelRef || "(label)"} -> ${entry?.categoryRef || "(category)"}`
    );
  });
  conflicts.slice(0, 2).forEach((entry) => {
    examples.push(
      `${entry?.labelText || "(label)"} -> ${
        entry?.requestedCategoryText || "(category)"
      }`
    );
  });

  return {
    unresolvedCount: unresolved.length,
    conflictCount: conflicts.length,
    totalCount: unresolved.length + conflicts.length,
    unresolvedReasons,
    examples,
  };
}

function buildClickAndDragFormatIssueMessage(formatIssueDetails) {
  const summary = summarizeClickAndDragFormatIssue(formatIssueDetails);
  const detailsParts = [
    `Click-and-drag format issue: ${summary.totalCount} mapping${
      summary.totalCount === 1 ? "" : "s"
    } could not be resolved.`,
    'Return ONLY JSON with "answer" as an array.',
    'Each array item must be one complete "Label -> Category" pair.',
    "Use exact label/category text including punctuation and apostrophes.",
    "Do not split labels across lines/items and do not use numbering or bullets.",
  ];

  if (summary.examples.length > 0) {
    detailsParts.push(`Examples that failed: ${summary.examples.join(" | ")}`);
  }

  return detailsParts.join(" ");
}

function getClickAndDragPlacementFingerprint() {
  const doc = getClickAndDragDocument();
  if (!doc) return "click_and_drag_unavailable";

  const remainingLabelIds = Array.from(
    doc.querySelectorAll("#label-list .label-box[labelid]")
  )
    .map((node) => node.getAttribute("labelid"))
    .filter(Boolean)
    .sort((a, b) => Number(a) - Number(b));

  const dropZoneStates = Array.from(doc.querySelectorAll(".drop-zone[dropzoneid]"))
    .map((zone) => {
      const dropzoneId = zone.getAttribute("dropzoneid") || zone.id || "unknown";
      const placedLabelIds = Array.from(zone.querySelectorAll(".label-box[labelid]"))
        .map((label) => label.getAttribute("labelid"))
        .filter(Boolean)
        .sort((a, b) => Number(a) - Number(b));
      return `${dropzoneId}:${placedLabelIds.join(",")}`;
    })
    .sort();

  return `remaining:${remainingLabelIds.join(",")}||zones:${dropZoneStates.join(
    ";"
  )}`;
}

function getQuizQuestionType() {
  if (document.querySelector(".answers-wrap.multiple-choice")) {
    return "multiple_choice";
  }

  if (document.querySelector(".answers-wrap.boolean")) {
    return "true_false";
  }

  if (document.querySelector(".answers-wrap.input-response")) {
    return "fill_in_the_blank";
  }

  if (getClickAndDragIframeElement()) {
    return "click_and_drag";
  }

  return "";
}

function getQuestionTextForType(questionType) {
  if (!questionType) return "";

  if (questionType === "click_and_drag") {
    return getClickAndDragQuestionText();
  }

  const questionElement = document.querySelector(".question");
  if (!questionElement) return "";

  if (questionType === "fill_in_the_blank") {
    const questionClone = questionElement.cloneNode(true);
    const blankSpans = questionClone.querySelectorAll('span[aria-hidden="true"]');
    blankSpans.forEach((span) => {
      if (span.textContent.includes("_")) {
        span.textContent = "[BLANK]";
      }
    });

    const hiddenSpans = questionClone.querySelectorAll(
      'span[style*="position: absolute"]'
    );
    hiddenSpans.forEach((span) => span.remove());
    return normalizeQuizText(questionClone.textContent);
  }

  return normalizeQuizText(questionElement.textContent);
}

function getOptionCountForType(questionType) {
  if (questionType === "multiple_choice") {
    return document.querySelectorAll(".answers--mc .answer__label--mc").length;
  }

  if (questionType === "true_false") {
    return document.querySelectorAll(".answer--boolean").length;
  }

  if (questionType === "fill_in_the_blank") {
    return document.querySelectorAll(".answer--input__input").length;
  }

  if (questionType === "click_and_drag") {
    const doc = getClickAndDragDocument();
    const labels = extractClickAndDragLabels(doc);
    const categories = extractClickAndDragCategories(doc);
    return labels.length + categories.length;
  }

  return 0;
}

function getQuizStateSnapshot() {
  const progressText =
    document
      .querySelector(".footer__progress__heading")
      ?.textContent?.replace(/\s+/g, " ")
      .trim() || "";

  const progressMatch = progressText.match(/(\d+)\s+of\s+(\d+)/);
  const progressCurrent = progressMatch ? parseInt(progressMatch[1], 10) : null;
  const progressTotal = progressMatch ? parseInt(progressMatch[2], 10) : null;

  const questionType = getQuizQuestionType();
  const questionText = getQuestionTextForType(questionType);
  const optionCount = getOptionCountForType(questionType);

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

function isSubmissionModalActive() {
  return Boolean(
    document.querySelector(
      '#hand-in[aria-hidden="false"], #successful-submission[aria-hidden="false"]'
    )
  );
}

function isAtOrPastFinalQuestion(snapshot = getQuizStateSnapshot()) {
  return (
    Number.isInteger(snapshot?.progressCurrent) &&
    Number.isInteger(snapshot?.progressTotal) &&
    snapshot.progressCurrent >= snapshot.progressTotal
  );
}

function hasLastQuestionCueText() {
  return Array.from(document.querySelectorAll(".footer .t-hidden")).some((node) =>
    normalizeQuizText(node.textContent).toLowerCase().includes(LAST_QUESTION_CUE_TEXT)
  );
}

function isTerminalFinalQuestionState(snapshot = getQuizStateSnapshot()) {
  if (isClickAndDragQuestionPendingLoad(snapshot)) {
    return false;
  }

  return (
    isAtOrPastFinalQuestion(snapshot) &&
    !isNextQuizButtonEnabled() &&
    hasLastQuestionCueText()
  );
}

function isFinalPositionWithoutEnabledNext(snapshot = getQuizStateSnapshot()) {
  if (isClickAndDragQuestionPendingLoad(snapshot)) {
    return false;
  }

  return isAtOrPastFinalQuestion(snapshot) && !isNextQuizButtonEnabled();
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

  if (snapshot.questionType === "click_and_drag") {
    const doc = getClickAndDragDocument();
    if (isClickAndDragIframeStillLoading(doc)) {
      return false;
    }

    const labels = extractClickAndDragLabels(doc);
    const categories = extractClickAndDragCategories(doc);
    return labels.length > 0 && categories.length > 0;
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

  const clickAndDragState = getClickAndDragPlacementFingerprint();

  return `${checkedInputs}||${inputValues}||${pressedButtons}||${automationMarkers}||${clickAndDragState}`;
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

function clearManualRecoveryWatcher() {
  if (manualRecoveryIntervalId !== null) {
    clearInterval(manualRecoveryIntervalId);
    manualRecoveryIntervalId = null;
  }
}

function clearManualRecoveryState() {
  isWaitingForManualRecovery = false;
  manualRecoveryInFlight = false;
  manualRecoveryContext = null;
  clearManualRecoveryWatcher();
}

function formatAnswerForManualDisplay(answer) {
  if (answer === null || answer === undefined) {
    return "(no answer returned)";
  }

  if (Array.isArray(answer)) {
    if (!answer.length) {
      return "[]";
    }

    return answer
      .map((item, index) => `${index + 1}. ${formatAnswerForManualDisplay(item)}`)
      .join("\n");
  }

  if (typeof answer === "string") {
    const trimmed = answer.trim();
    return trimmed || "(empty string)";
  }

  if (typeof answer === "number" || typeof answer === "boolean") {
    return String(answer);
  }

  if (typeof answer === "object") {
    try {
      return JSON.stringify(answer, null, 2);
    } catch (error) {
      return String(answer);
    }
  }

  return String(answer);
}

function getManualRecoveryInstructions(questionType) {
  if (questionType === "multiple_choice") {
    return "Select the option whose text best matches the suggested answer.";
  }

  if (questionType === "true_false") {
    return "Choose True or False to match the suggested answer.";
  }

  if (questionType === "fill_in_the_blank") {
    return "Type the suggested answer into the blank exactly as shown.";
  }

  if (questionType === "click_and_drag") {
    return "Drag each label to the matching drop zone using the suggested 'Label -> Category' mapping, then complete the question. Auto-McGraw will advance after it detects your changes.";
  }

  return "Apply the suggested answer manually on the current question.";
}

function buildManualRecoveryMessage(context) {
  const reason = context?.reason || "Answer could not be applied reliably.";
  const formattedAnswer = formatAnswerForManualDisplay(context?.answer);
  const instructions = getManualRecoveryInstructions(context?.questionType);

  return (
    `Automation paused: ${reason}\n\n` +
    `Suggested answer from AI:\n${formattedAnswer}\n\n` +
    `How to answer manually:\n${instructions}\n\n` +
    "After you select or enter the answer, Auto-McGraw will click Next and resume automatically."
  );
}

function pauseForManualRecovery(context) {
  if (!isAutomating) return;

  clearManualRecoveryWatcher();
  isWaitingForManualRecovery = true;
  manualRecoveryInFlight = false;
  manualRecoveryContext = context;

  if (scheduledNextStepTimeoutId !== null) {
    clearTimeout(scheduledNextStepTimeoutId);
    scheduledNextStepTimeoutId = null;
  }

  alert(buildManualRecoveryMessage(context));

  manualRecoveryIntervalId = setInterval(() => {
    if (!isAutomating) {
      clearManualRecoveryState();
      return;
    }

    if (!isWaitingForManualRecovery || !manualRecoveryContext) {
      clearManualRecoveryWatcher();
      return;
    }

    if (manualRecoveryInFlight) {
      return;
    }

    if (checkForQuizEnd()) {
      stopAutomation("Quiz completed - all questions answered");
      return;
    }

    const currentSnapshot = getQuizStateSnapshot();
    if (
      manualRecoveryContext.questionSignature &&
      currentSnapshot.signature &&
      currentSnapshot.signature !== manualRecoveryContext.questionSignature
    ) {
      clearClickAndDragFormatRetryState(manualRecoveryContext.questionSignature);
      clearManualRecoveryState();
      if (checkForQuizEnd()) {
        stopAutomation("Quiz completed - all questions answered");
        return;
      }
      scheduleCheckForNextStep(0, "manual_recovery_user_advanced");
      return;
    }

    const fingerprintChanged =
      getAnswerCommitFingerprint() !== manualRecoveryContext.preApplyFingerprint;
    const nextEnabled = isNextQuizButtonEnabled();
    if (!fingerprintChanged) {
      return;
    }

    if (!nextEnabled) {
      if (
        isTerminalFinalQuestionState(currentSnapshot) ||
        isFinalPositionWithoutEnabledNext(currentSnapshot)
      ) {
        clearManualRecoveryState();
        stopAutomation("Quiz completed - all questions answered");
      }
      return;
    }

    manualRecoveryInFlight = true;
    const transitionSnapshot = getQuizStateSnapshot();

    (async () => {
      try {
        const nextButton = await waitForNextQuizButton(5000);
        if (!isAutomating || !isWaitingForManualRecovery) {
          manualRecoveryInFlight = false;
          return;
        }

        const latestSnapshot = getQuizStateSnapshot();
        if (
          manualRecoveryContext?.questionSignature &&
          latestSnapshot.signature &&
          latestSnapshot.signature !== manualRecoveryContext.questionSignature
        ) {
          clearClickAndDragFormatRetryState(
            manualRecoveryContext.questionSignature
          );
          clearManualRecoveryState();
          if (checkForQuizEnd()) {
            stopAutomation("Quiz completed - all questions answered");
            return;
          }
          scheduleCheckForNextStep(0, "manual_recovery_user_advanced");
          return;
        }

        nextButton.click();
        const transitioned = await waitForQuizTransition(
          transitionSnapshot,
          QUIZ_TRANSITION_TIMEOUT_MS
        );

        if (!isAutomating) {
          manualRecoveryInFlight = false;
          return;
        }

        if (checkForQuizEnd()) {
          stopAutomation("Quiz completed - all questions answered");
          return;
        }

        if (transitioned) {
          if (transitionSnapshot?.signature) {
            clearClickAndDragFormatRetryState(transitionSnapshot.signature);
          }
          clearManualRecoveryState();
          scheduleCheckForNextStep(0, "manual_recovery_auto_advanced");
          return;
        }
      } catch (error) {
        console.warn(LOG_PREFIX, "Manual recovery auto-advance failed", error);
      }

      manualRecoveryInFlight = false;
    })();
  }, READINESS_POLL_INTERVAL_MS);
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
  return Boolean(
    document.querySelector(".footer__progress__heading") && getQuizQuestionType()
  );
}

function isLikelyQuizCompletedState() {
  if (isSubmissionModalActive()) {
    return true;
  }

  const snapshot = getQuizStateSnapshot();
  if (isClickAndDragQuestionPendingLoad(snapshot)) {
    return false;
  }

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
  clearManualRecoveryState();
  clearClickAndDragFormatRetryState();
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
  if (isWaitingForManualRecovery) return;
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
      if (isClickAndDragQuestionPendingLoad(snapshot)) {
        consecutiveDispatchReadinessMisses = 0;
        scheduleCheckForNextStep(
          NEXT_STEP_RETRY_DELAY_MS,
          "click_and_drag_iframe_loading_retry"
        );
        return;
      }

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

    const questionData = parseQuestion(snapshot);
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

function parseQuestion(snapshot = getQuizStateSnapshot()) {
  const questionType = snapshot?.questionType || getQuizQuestionType();
  if (!questionType) {
    console.log("Unknown question type");
    return null;
  }

  let options = [];
  if (questionType === "multiple_choice") {
    options = getMultipleChoiceOptionModels().map((option) => option.text);
  } else if (questionType === "true_false") {
    options = ["True", "False"];
  } else if (questionType === "click_and_drag") {
    const iframeDoc = getClickAndDragDocument();
    options = {
      labels: extractClickAndDragLabels(iframeDoc),
      categories: extractClickAndDragCategories(iframeDoc),
    };
  }

  const questionText = getQuestionTextForType(questionType);
  if (!questionText) {
    return null;
  }

  const questionSignature = snapshot?.signature || "";
  const previousFormatIssue =
    questionType === "click_and_drag" && questionSignature
      ? clickAndDragFormatIssueBySignature.get(questionSignature) || null
      : null;

  return {
    type: questionType,
    question: questionText,
    options: options,
    previousFormatIssue,
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

    if (isAutomating) {
      const shouldProceedWithAnswer = await applyHumanlikeAnswerDelay(
        activeQuestionId
      );
      if (!shouldProceedWithAnswer) {
        return;
      }
    }

    clearAutomationAnswerMarkers();
    const preApplyNextEnabled = isNextQuizButtonEnabled();
    const preApplyFingerprint = getAnswerCommitFingerprint();

    let answerApplication = await applyQuizAnswer(answer);

    if (!answerApplication.applied) {
      const failureSnapshot = getQuizStateSnapshot();
      const failureSignature = failureSnapshot.signature || "";
      const isClickAndDragFormatIssue =
        answerApplication.type === "click_and_drag" &&
        answerApplication.retryableFormatIssue;

      if (isClickAndDragFormatIssue) {
        const formatIssueSummary = summarizeClickAndDragFormatIssue(
          answerApplication.formatIssueDetails
        );
        const retryCount = getClickAndDragFormatRetryCount(failureSignature);
        const canRetry =
          Boolean(failureSignature) &&
          retryCount < CLICK_AND_DRAG_FORMAT_RETRY_LIMIT;

        console.warn(LOG_PREFIX, "Click-and-drag format issue detected", {
          questionSignature: failureSignature || "(missing_signature)",
          retryCount,
          retryLimit: CLICK_AND_DRAG_FORMAT_RETRY_LIMIT,
          unresolvedCount: formatIssueSummary.unresolvedCount,
          conflictCount: formatIssueSummary.conflictCount,
          unresolvedReasons: formatIssueSummary.unresolvedReasons,
          examples: formatIssueSummary.examples,
          canRetry,
        });

        if (isAutomating && canRetry) {
          clickAndDragFormatIssueBySignature.set(
            failureSignature,
            buildClickAndDragFormatIssueMessage(answerApplication.formatIssueDetails)
          );
          const nextRetryCount =
            incrementClickAndDragFormatRetryCount(failureSignature);
          lastDispatchedAt = 0;
          scheduleCheckForNextStep(0, "click_and_drag_format_retry");
          console.warn(LOG_PREFIX, "Retrying click-and-drag format issue", {
            questionSignature: failureSignature,
            retryCount: nextRetryCount,
            retryLimit: CLICK_AND_DRAG_FORMAT_RETRY_LIMIT,
          });
          return;
        }
      }

      console.warn(LOG_PREFIX, "Unable to apply answer; refusing to advance", {
        answer,
        type: answerApplication.type || "unknown",
        retryableFormatIssue: Boolean(answerApplication.retryableFormatIssue),
      });

      if (isAutomating) {
        const manualRecoveryAnswer =
          answerApplication.manualRecoveryAnswer !== undefined
            ? answerApplication.manualRecoveryAnswer
            : answer;
        const manualRecoveryReason =
          answerApplication.manualRecoveryReason ||
          "Could not apply answer reliably. Paused to avoid skipping.";
        const manualRecoveryPreFingerprint =
          answerApplication.manualRecoveryPreFingerprint || preApplyFingerprint;
        pauseForManualRecovery({
          answer: manualRecoveryAnswer,
          reason: manualRecoveryReason,
          questionType:
            answerApplication.type || failureSnapshot.questionType || "unknown",
          preApplyFingerprint: manualRecoveryPreFingerprint,
          questionSignature: failureSnapshot.signature || "",
        });
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
      answerApplication = await applyQuizAnswer(answer);
      if (!answerApplication.applied) {
        if (isAutomating) {
          const failureSnapshot = getQuizStateSnapshot();
          const manualRecoveryAnswer =
            answerApplication.manualRecoveryAnswer !== undefined
              ? answerApplication.manualRecoveryAnswer
              : answer;
          const manualRecoveryReason =
            answerApplication.manualRecoveryReason ||
            "Could not re-apply answer reliably. Paused to avoid skipping.";
          const manualRecoveryPreFingerprint =
            answerApplication.manualRecoveryPreFingerprint || preApplyFingerprint;
          pauseForManualRecovery({
            answer: manualRecoveryAnswer,
            reason: manualRecoveryReason,
            questionType:
              answerApplication.type || failureSnapshot.questionType || "unknown",
            preApplyFingerprint: manualRecoveryPreFingerprint,
            questionSignature: failureSnapshot.signature || "",
          });
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
      const postCommitSnapshot = getQuizStateSnapshot();
      if (isTerminalFinalQuestionState(postCommitSnapshot)) {
        stopAutomation("Quiz completed - all questions answered");
        return;
      }

      const shouldUseFinalPositionFallbackWait =
        isFinalPositionWithoutEnabledNext(postCommitSnapshot);
      const nextButtonWaitTimeout = shouldUseFinalPositionFallbackWait
        ? FINAL_POSITION_FALLBACK_NEXT_WAIT_TIMEOUT_MS
        : 12000;
      const previousSnapshot = postCommitSnapshot;

      try {
        const nextButton = await waitForNextQuizButton(nextButtonWaitTimeout);
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

        const transitioned = await waitForQuizTransition(
          previousSnapshot,
          QUIZ_TRANSITION_TIMEOUT_MS
        );
        if (transitioned && previousSnapshot.signature) {
          clearClickAndDragFormatRetryState(previousSnapshot.signature);
        }

        if (checkForQuizEnd()) {
          stopAutomation("Quiz completed - all questions answered");
          return;
        }

        scheduleCheckForNextStep(0, "post_answer_next");
      } catch (error) {
        const latestSnapshot = getQuizStateSnapshot();
        if (
          isLikelyQuizCompletedState() ||
          isTerminalFinalQuestionState(latestSnapshot) ||
          (shouldUseFinalPositionFallbackWait &&
            isFinalPositionWithoutEnabledNext(latestSnapshot))
        ) {
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
  const optionModels = getMultipleChoiceOptionModels();
  const targetOption = resolveMultipleChoiceAnswerOption(answer, optionModels);
  const targetInput = targetOption?.input || null;
  const targetLabel = targetOption?.label || null;
  const markerNode = targetInput || targetLabel;

  if (!targetOption || !markerNode) {
    console.warn(LOG_PREFIX, "No multiple-choice match for answer", {
      answer,
      options: optionModels.map((option) => option.text),
    });
    return {
      applied: false,
      type: "multiple_choice",
      verify: () => false,
      manualRecoveryReason:
        "Could not match the AI response to a visible multiple-choice option. Paused to avoid skipping.",
      manualRecoveryAnswer: answer,
    };
  }

  const radioButtons = document.querySelectorAll(
    '.answers--mc input[type="radio"]'
  );
  radioButtons.forEach((input) =>
    input.removeAttribute("data-automcgraw-selected")
  );
  document
    .querySelectorAll(".answers--mc .answer__label--mc[data-automcgraw-selected='true']")
    .forEach((node) => node.removeAttribute("data-automcgraw-selected"));

  if (targetInput && !targetInput.checked) {
    targetInput.click();
  }
  if (targetLabel && (!targetInput || !targetInput.checked)) {
    targetLabel.click();
  }

  markerNode.setAttribute("data-automcgraw-selected", "true");
  console.log("Selected option:", targetOption.text);

  return {
    applied: true,
    type: "multiple_choice",
    verify: () => {
      if (targetInput && targetInput.isConnected && targetInput.checked) {
        return true;
      }

      if (
        markerNode &&
        markerNode.isConnected &&
        markerNode.getAttribute("data-automcgraw-selected") === "true"
      ) {
        return true;
      }

      if (targetLabel && targetLabel.isConnected) {
        const className = targetLabel.className || "";
        if (/selected|active|checked|is-selected|is-active/i.test(className)) {
          return true;
        }
      }

      const anyChecked = document.querySelector(
        '.answers--mc input[type="radio"]:checked'
      );
      return Boolean(anyChecked);
    },
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

async function handleClickAndDragAnswer(answer) {
  let doc = getClickAndDragDocument();

  if (isClickAndDragIframeStillLoading(doc)) {
    try {
      doc = await waitForCondition(() => {
        const nextDoc = getClickAndDragDocument();
        if (!nextDoc) return null;
        return isClickAndDragIframeStillLoading(nextDoc) ? null : nextDoc;
      }, CLICK_AND_DRAG_IFRAME_READY_TIMEOUT_MS);
    } catch (error) {
      doc = getClickAndDragDocument();
    }
  }

  if (!doc || isClickAndDragIframeStillLoading(doc)) {
    return {
      applied: false,
      type: "click_and_drag",
      verify: () => false,
      retryableFormatIssue: false,
      manualRecoveryReason:
        "Click-and-drag iframe is still loading. Paused to avoid skipping.",
      manualRecoveryAnswer: answer,
      manualRecoveryPreFingerprint: getAnswerCommitFingerprint(),
    };
  }

  const targetPlan = normalizeClickAndDragTargets(answer, doc);
  const verify = () =>
    isClickAndDragAligned(
      targetPlan.resolvedMoves,
      getClickAndDragDocument()
    );

  console.info(LOG_PREFIX, "Click-and-drag target plan", {
    resolved: targetPlan.resolvedMoves.length,
    unresolved: targetPlan.unresolved.length,
    conflicts: targetPlan.conflicts.length,
    duplicates: targetPlan.duplicates.length,
  });

  if (!targetPlan.entries.length) {
    return {
      applied: false,
      type: "click_and_drag",
      verify,
      retryableFormatIssue: true,
      formatIssueDetails: {
        unresolved: [],
        conflicts: [],
      },
      manualRecoveryReason:
        "AI response did not contain usable 'Label -> Category' mappings. Paused to avoid skipping.",
      manualRecoveryAnswer: answer,
      manualRecoveryPreFingerprint: getAnswerCommitFingerprint(),
    };
  }

  if (!targetPlan.labelCandidates.length || !targetPlan.categoryCandidates.length) {
    return {
      applied: false,
      type: "click_and_drag",
      verify,
      retryableFormatIssue: false,
      manualRecoveryReason:
        "Click-and-drag labels or categories were not ready. Paused to avoid skipping.",
      manualRecoveryAnswer: answer,
      manualRecoveryPreFingerprint: getAnswerCommitFingerprint(),
    };
  }

  let moveResult = {
    allApplied: false,
    unresolvedMoves: targetPlan.resolvedMoves.slice(),
    alignedCount: 0,
    resolvedCount: targetPlan.resolvedMoves.length,
  };

  if (targetPlan.resolvedMoves.length > 0) {
    moveResult = await applyClickAndDragMoves(targetPlan.resolvedMoves, doc);
    console.info(LOG_PREFIX, "Click-and-drag move result", {
      resolved: moveResult.resolvedCount,
      aligned: moveResult.alignedCount,
      unresolvedMoves: moveResult.unresolvedMoves.length,
    });
  }

  const blockingIssueCount =
    moveResult.unresolvedMoves.length +
    targetPlan.unresolved.length +
    targetPlan.conflicts.length;
  const hasFormatMappingIssues =
    targetPlan.unresolved.length > 0 || targetPlan.conflicts.length > 0;
  const alignedCount = countClickAndDragAlignedMoves(
    targetPlan.resolvedMoves,
    getClickAndDragDocument()
  );

  if (moveResult.allApplied && blockingIssueCount === 0 && verify()) {
    return {
      applied: true,
      type: "click_and_drag",
      verify,
    };
  }

  const issueLines = formatClickAndDragManualIssueLines(
    targetPlan,
    moveResult.unresolvedMoves
  );
  const issueCount = issueLines.length;
  const reasonParts = [];
  if (alignedCount > 0) {
    reasonParts.push(
      `Auto-placed ${alignedCount} label${alignedCount === 1 ? "" : "s"}.`
    );
  }
  if (issueCount > 0) {
    reasonParts.push(
      `${issueCount} mapping${issueCount === 1 ? "" : "s"} still need manual placement.`
    );
  } else {
    reasonParts.push(
      "Could not fully verify click-and-drag placement. Please confirm manually."
    );
  }

  if (targetPlan.conflicts.length > 0) {
    reasonParts.push(
      `Detected ${targetPlan.conflicts.length} conflicting mapping${
        targetPlan.conflicts.length === 1 ? "" : "s"
      }.`
    );
  }

  return {
    applied: false,
    type: "click_and_drag",
    verify,
    retryableFormatIssue: hasFormatMappingIssues,
    formatIssueDetails: {
      unresolved: targetPlan.unresolved,
      conflicts: targetPlan.conflicts,
    },
    manualRecoveryReason: reasonParts.join(" "),
    manualRecoveryAnswer: issueLines.length > 0 ? issueLines : answer,
    manualRecoveryPreFingerprint: getAnswerCommitFingerprint(),
  };
}

async function applyQuizAnswer(answer) {
  if (document.querySelector(".answers-wrap.multiple-choice")) {
    return handleMultipleChoiceAnswer(answer);
  }

  if (document.querySelector(".answers-wrap.boolean")) {
    return handleTrueFalseAnswer(answer);
  }

  if (document.querySelector(".answers-wrap.input-response")) {
    return handleFillInTheBlankAnswer(answer);
  }

  if (getQuizQuestionType() === "click_and_drag") {
    return handleClickAndDragAnswer(answer);
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
          clearClickAndDragFormatRetryState();
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

setupAnswerDelayConfigSync();
setupMessageListener();
startPageObserver();

if (isAutomating) {
  scheduleCheckForNextStep(NEXT_STEP_RETRY_DELAY_MS, "script_bootstrap");
}
