import path from "path";
import { fileURLToPath } from "url";

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(SCRIPTS_DIR, "..");
export const DEFAULT_CHROME_PATH =
  process.env.CHROME_PATH ||
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
export const DEFAULT_CDP_URL =
  process.env.CDP_URL || "http://127.0.0.1:9222";

const COMMON_PLACEHOLDER_MARKERS = [
  "placeholder only",
  "replace with a raw",
  "html reference placeholder",
];

export const FIXTURE_SPECS = [
  {
    id: "chatgpt",
    label: "ChatGPT assistant",
    file: "chatgpt_html_reference.html",
    category: "assistant",
    mode: "assistant",
    urlMatchers: ["chatgpt.com"],
    pendingReason:
      "No offline raw ChatGPT capture exists in this repo or its git history yet.",
    selectorChecks: [
      {
        name: "composer",
        anyOf: ["#prompt-textarea", '[data-testid="composer"]'],
      },
      {
        name: "send button",
        anyOf: ['[data-testid="send-button"]', 'button[aria-label*="Send"]'],
      },
      {
        name: "assistant messages",
        anyOf: ['[data-message-author-role="assistant"]'],
      },
    ],
  },
  {
    id: "gemini",
    label: "Gemini assistant",
    file: "gemini_html_reference.html",
    category: "assistant",
    mode: "assistant",
    urlMatchers: ["gemini.google.com"],
    pendingReason:
      "No offline raw Gemini capture exists in this repo or its git history yet.",
    selectorChecks: [
      {
        name: "composer",
        anyOf: [".ql-editor", "rich-textarea .ql-editor"],
      },
      {
        name: "send button",
        anyOf: [".send-button", 'button[aria-label*="Send"]'],
      },
      {
        name: "model responses",
        anyOf: ["model-response", ".model-response-text"],
      },
    ],
  },
  {
    id: "ezto",
    label: "EZTO question page",
    file: "ezto_mheducation_html_reference.html",
    category: "mhe",
    mode: "ezto",
    urlMatchers: ["ezto.mheducation.com"],
    selectorChecks: [
      {
        name: "question text",
        anyOf: [".question", ".question__stem", ".question--button_row"],
      },
      {
        name: "progress heading",
        anyOf: [".footer__progress__heading"],
      },
      {
        name: "answer area or click-and-drag frame",
        anyOf: [
          ".answers-wrap.multiple-choice",
          ".answers-wrap.boolean",
          ".answers-wrap.input-response",
          "iframe",
        ],
      },
    ],
  },
  {
    id: "mhe-multiple-choice",
    label: "SmartBook multiple choice",
    file: "mheducation_html_references/multiple_choice.html",
    category: "mhe",
    mode: "mhe",
    urlMatchers: ["learning.mheducation.com", "learn.luzerne.edu"],
    selectorChecks: [
      { name: "probe container", anyOf: [".probe-container"] },
      {
        name: "question type marker",
        anyOf: [".awd-probe-type-multiple_choice"],
      },
      { name: "prompt", anyOf: [".prompt"] },
      { name: "answer choices", anyOf: [".choiceText"] },
      { name: "next button", anyOf: [".next-button"] },
    ],
  },
  {
    id: "mhe-multi-select",
    label: "SmartBook multi-select",
    file: "mheducation_html_references/multi_select.html",
    category: "mhe",
    mode: "mhe",
    urlMatchers: ["learning.mheducation.com", "learn.luzerne.edu"],
    pendingReason:
      "No offline raw multi-select SmartBook capture exists in this repo or its git history yet.",
    selectorChecks: [
      { name: "probe container", anyOf: [".probe-container"] },
      {
        name: "question type marker",
        anyOf: [".awd-probe-type-multiple_select"],
      },
      { name: "prompt", anyOf: [".prompt"] },
      { name: "answer choices", anyOf: [".choiceText"] },
    ],
  },
  {
    id: "mhe-fill-in-the-blank",
    label: "SmartBook fill in the blank",
    file: "mheducation_html_references/fill_in_the_blank.html",
    category: "mhe",
    mode: "mhe",
    urlMatchers: ["learning.mheducation.com", "learn.luzerne.edu"],
    pendingReason:
      "No offline raw fill-in-the-blank SmartBook capture exists in this repo or its git history yet.",
    selectorChecks: [
      { name: "probe container", anyOf: [".probe-container"] },
      {
        name: "question type marker",
        anyOf: [".awd-probe-type-fill_in_the_blank"],
      },
      { name: "prompt", anyOf: [".prompt"] },
      { name: "blank inputs", anyOf: ["input.fitb-input"] },
    ],
  },
  {
    id: "mhe-true-false",
    label: "SmartBook true false",
    file: "mheducation_html_references/true_false.html",
    category: "mhe",
    mode: "mhe",
    urlMatchers: ["learning.mheducation.com", "learn.luzerne.edu"],
    pendingReason:
      "No offline raw true-false SmartBook capture exists in this repo or its git history yet.",
    selectorChecks: [
      { name: "probe container", anyOf: [".probe-container"] },
      {
        name: "question type marker",
        anyOf: [".awd-probe-type-true_false"],
      },
      { name: "prompt", anyOf: [".prompt"] },
      { name: "answer choices", anyOf: [".choiceText"] },
    ],
  },
  {
    id: "mhe-matching",
    label: "SmartBook matching",
    file: "mheducation_html_references/matching.html",
    category: "mhe",
    mode: "mhe",
    urlMatchers: ["learning.mheducation.com", "learn.luzerne.edu"],
    pendingReason:
      "No offline raw matching SmartBook capture exists in this repo or its git history yet.",
    selectorChecks: [
      { name: "probe container", anyOf: [".probe-container"] },
      {
        name: "question type marker",
        anyOf: [".awd-probe-type-matching"],
      },
      { name: "prompt", anyOf: [".prompt"] },
      { name: "match rows", anyOf: [".match-row"] },
    ],
  },
  {
    id: "mhe-dropdown",
    label: "SmartBook dropdown",
    file: "mheducation_html_references/dropdown.html",
    category: "backlog",
    mode: "mhe",
    urlMatchers: ["learning.mheducation.com", "learn.luzerne.edu"],
    pendingReason:
      "Dropdown remains a backlog placeholder and does not map to an active parser path yet.",
    selectorChecks: [],
  },
  {
    id: "mhe-numeric-entry",
    label: "SmartBook numeric entry",
    file: "mheducation_html_references/numeric_entry.html",
    category: "backlog",
    mode: "mhe",
    urlMatchers: ["learning.mheducation.com", "learn.luzerne.edu"],
    pendingReason:
      "Numeric entry remains a backlog placeholder and does not map to an active parser path yet.",
    selectorChecks: [],
  },
  {
    id: "mhe-essay",
    label: "SmartBook essay",
    file: "mheducation_html_references/essay.html",
    category: "backlog",
    mode: "mhe",
    urlMatchers: ["learning.mheducation.com", "learn.luzerne.edu"],
    pendingReason:
      "Essay remains a backlog placeholder and does not map to an active parser path yet.",
    selectorChecks: [],
  },
];

export function getFixtureSpec(id) {
  return FIXTURE_SPECS.find((spec) => spec.id === id) || null;
}

export function resolveFixturePath(spec) {
  return path.join(REPO_ROOT, spec.file);
}

export function isPlaceholderHtml(html) {
  const normalized = String(html || "").toLowerCase();
  return COMMON_PLACEHOLDER_MARKERS.some((marker) =>
    normalized.includes(marker)
  );
}

export function matchesSpecUrl(spec, url) {
  const normalizedUrl = String(url || "").toLowerCase();
  return spec.urlMatchers.some((matcher) =>
    normalizedUrl.includes(matcher.toLowerCase())
  );
}
