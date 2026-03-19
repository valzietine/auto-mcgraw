import process from "process";
import { chromium } from "playwright";
import {
  DEFAULT_CDP_URL,
  FIXTURE_SPECS,
  matchesSpecUrl,
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

function formatResult(result) {
  if (result.status === "missing-page") {
    return `MISS ${result.id} no open tab matched ${result.expected.join(", ")}`;
  }
  if (result.status === "fail") {
    return `FAIL ${result.id} ${result.url} missing=${result.missing.join(", ")}`;
  }
  return `PASS ${result.id} ${result.url} title="${result.title.replace(/"/g, "'")}"`;
}

async function evaluatePage(page, spec) {
  const result = await page.evaluate(({ selectorChecks }) => {
    const checks = selectorChecks.map((check) => {
      const matched = (check.anyOf || []).some(
        (selector) => document.querySelector(selector)
      );
      return {
        name: check.name,
        matched,
      };
    });

    return {
      title: document.title || "",
      missing: checks.filter((check) => !check.matched).map((check) => check.name),
    };
  }, { selectorChecks: spec.selectorChecks });

  return {
    id: spec.id,
    status: result.missing.length === 0 ? "pass" : "fail",
    url: page.url(),
    title: result.title,
    missing: result.missing,
  };
}

async function main() {
  const only = parseOnlyFilter(process.argv.slice(2));
  const selectedSpecs = (only
    ? FIXTURE_SPECS.filter((spec) => only.has(spec.id))
    : FIXTURE_SPECS
  ).filter((spec) => spec.category !== "backlog");

  if (selectedSpecs.length === 0) {
    throw new Error("No live-smoke targets matched the requested filter.");
  }

  let browser = null;
  try {
    browser = await chromium.connectOverCDP(DEFAULT_CDP_URL);
  } catch (error) {
    throw new Error(
      `Unable to attach to Chrome CDP at ${DEFAULT_CDP_URL}. Launch Chrome with --remote-debugging-port=9222 and the repo's documented issue-6-live profile flags first.`
    );
  }

  try {
    const pages = browser.contexts().flatMap((context) => context.pages());
    const results = [];

    for (const spec of selectedSpecs) {
      const page = pages.find((candidate) => matchesSpecUrl(spec, candidate.url()));
      if (!page) {
        results.push({
          id: spec.id,
          status: "missing-page",
          expected: spec.urlMatchers,
        });
        continue;
      }

      results.push(await evaluatePage(page, spec));
    }

    results.forEach((result) => {
      console.log(formatResult(result));
    });
    console.log(
      `SUMMARY pass=${results.filter((result) => result.status === "pass").length} fail=${results.filter((result) => result.status !== "pass").length}`
    );

    if (results.some((result) => result.status !== "pass")) {
      process.exitCode = 1;
    }
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
