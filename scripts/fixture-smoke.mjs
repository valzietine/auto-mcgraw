import fs from "fs/promises";
import path from "path";
import process from "process";
import { chromium } from "playwright";
import {
  DEFAULT_CHROME_PATH,
  FIXTURE_SPECS,
  isPlaceholderHtml,
  resolveFixturePath,
} from "./reference-fixtures.mjs";

function parseOnlyFilter(argv) {
  const onlyArg = argv.find((arg) => arg.startsWith("--only="));
  if (!onlyArg) return null;
  return new Set(
    onlyArg
      .slice("--only=".length)
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  );
}

function buildSummary(document, specId) {
  const promptText =
    document.querySelector(".prompt")?.textContent?.replace(/\s+/g, " ").trim() ||
    document.querySelector(".question")?.textContent?.replace(/\s+/g, " ").trim() ||
    "";

  if (specId === "ezto") {
    const questionType = document.querySelector(".answers-wrap.multiple-choice")
      ? "multiple_choice"
      : document.querySelector(".answers-wrap.boolean")
        ? "true_false"
        : document.querySelector(".answers-wrap.input-response")
          ? "fill_in_the_blank"
          : document.querySelector("iframe")
            ? "click_and_drag"
            : "unknown";

    return {
      title: document.title || "",
      questionType,
      promptText,
      mcOptions: document.querySelectorAll(".answers--mc .answer__label--mc").length,
      blankInputs: document.querySelectorAll(".answer--input__input").length,
      iframeCount: document.querySelectorAll("iframe").length,
    };
  }

  return {
    title: document.title || "",
    promptText,
    choiceCount: document.querySelectorAll(".choiceText").length,
    blankCount: document.querySelectorAll("input.fitb-input").length,
    matchRowCount: document.querySelectorAll(".match-row").length,
  };
}

function summarizeLine(result) {
  if (result.status === "pending") {
    return `PENDING ${result.id} ${result.reason}`;
  }

  const details = [];
  if (result.summary.questionType) {
    details.push(`type=${result.summary.questionType}`);
  }
  if (result.summary.choiceCount) {
    details.push(`choices=${result.summary.choiceCount}`);
  }
  if (result.summary.mcOptions) {
    details.push(`choices=${result.summary.mcOptions}`);
  }
  if (result.summary.blankCount) {
    details.push(`blanks=${result.summary.blankCount}`);
  }
  if (result.summary.blankInputs) {
    details.push(`blanks=${result.summary.blankInputs}`);
  }
  if (result.summary.matchRowCount) {
    details.push(`rows=${result.summary.matchRowCount}`);
  }
  if (result.summary.iframeCount) {
    details.push(`iframes=${result.summary.iframeCount}`);
  }
  if (result.summary.promptText) {
    details.push(
      `prompt="${result.summary.promptText.slice(0, 80).replace(/"/g, "'")}"`
    );
  }

  if (result.status === "pass") {
    return `PASS ${result.id}${details.length ? ` ${details.join(" ")}` : ""}`;
  }

  return `FAIL ${result.id} missing=${result.missing.join(", ")}`;
}

async function probeFixture(page, spec) {
  const fixturePath = resolveFixturePath(spec);
  const html = await fs.readFile(fixturePath, "utf8");
  if (isPlaceholderHtml(html)) {
    return {
      id: spec.id,
      status: "pending",
      reason: spec.pendingReason || "Fixture is still a placeholder.",
    };
  }

  await page.setContent(html, { waitUntil: "domcontentloaded" });
  const probe = await page.evaluate(({ id, selectorChecks }) => {
    const checkResults = selectorChecks.map((check) => {
      const selectors = check.anyOf || [];
      const matches = selectors
        .map((selector) => ({
          selector,
          count: document.querySelectorAll(selector).length,
        }))
        .filter((entry) => entry.count > 0);

      return {
        name: check.name,
        passed: matches.length > 0,
        matches,
      };
    });

    return {
      checks: checkResults,
      summary: (() => {
        const promptText =
          document.querySelector(".prompt")?.textContent
            ?.replace(/\s+/g, " ")
            .trim() ||
          document.querySelector(".question")?.textContent
            ?.replace(/\s+/g, " ")
            .trim() ||
          "";

        if (id === "ezto") {
          const questionType = document.querySelector(".answers-wrap.multiple-choice")
            ? "multiple_choice"
            : document.querySelector(".answers-wrap.boolean")
              ? "true_false"
              : document.querySelector(".answers-wrap.input-response")
                ? "fill_in_the_blank"
                : document.querySelector("iframe")
                  ? "click_and_drag"
                  : "unknown";

          return {
            title: document.title || "",
            questionType,
            promptText,
            mcOptions: document.querySelectorAll(".answers--mc .answer__label--mc")
              .length,
            blankInputs: document.querySelectorAll(".answer--input__input").length,
            iframeCount: document.querySelectorAll("iframe").length,
          };
        }

        return {
          title: document.title || "",
          promptText,
          choiceCount: document.querySelectorAll(".choiceText").length,
          blankCount: document.querySelectorAll("input.fitb-input").length,
          matchRowCount: document.querySelectorAll(".match-row").length,
        };
      })(),
    };
  }, { id: spec.id, selectorChecks: spec.selectorChecks });

  const missing = probe.checks.filter((check) => !check.passed).map((check) => check.name);
  return {
    id: spec.id,
    status: missing.length === 0 ? "pass" : "fail",
    missing,
    summary: probe.summary,
  };
}

async function main() {
  const only = parseOnlyFilter(process.argv.slice(2));
  const strict = process.argv.includes("--strict");
  const selectedSpecs = only
    ? FIXTURE_SPECS.filter((spec) => only.has(spec.id))
    : FIXTURE_SPECS;

  if (selectedSpecs.length === 0) {
    throw new Error("No fixtures matched the requested filter.");
  }

  const chromePath = DEFAULT_CHROME_PATH;
  const browser = await chromium.launch({
    executablePath: chromePath,
    headless: true,
  });
  const context = await browser.newContext({ javaScriptEnabled: false });
  await context.route("**/*", async (route) => {
    await route.abort();
  });

  const results = [];
  try {
    for (const spec of selectedSpecs) {
      const page = await context.newPage();
      try {
        results.push(await probeFixture(page, spec));
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }

  const pendingCount = results.filter((result) => result.status === "pending").length;
  const failureCount = results.filter((result) => result.status === "fail").length;
  results.forEach((result) => {
    console.log(summarizeLine(result));
  });
  console.log(
    `SUMMARY pass=${results.filter((result) => result.status === "pass").length} pending=${pendingCount} fail=${failureCount}`
  );

  if (failureCount > 0 || (strict && pendingCount > 0)) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
