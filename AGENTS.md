# Agent Notes

## Reference Assets

- HTML references use `.html` and are the canonical snapshots for selector/extraction updates.
- Replace placeholder files with raw captured HTML while keeping filenames stable.

### Content Script Mapping

- `content-scripts/deepseek.js` -> `deepseek_html_reference.html`
- `content-scripts/chatgpt.js` -> `chatgpt_html_reference.html` (placeholder)
- `content-scripts/gemini.js` -> `gemini_html_reference.html` (placeholder)
- `content-scripts/ezto-mheducation.js` -> `ezto_mheducation_html_reference.html`
- `content-scripts/mheducation.js` -> one file per question type in `mheducation_html_references/`

### Current McGraw Placeholders

- `mheducation_html_references/multi_select.html`
- `mheducation_html_references/fill_in_the_blank.html`
- `mheducation_html_references/dropdown.html`
- `mheducation_html_references/true_false.html`
- `mheducation_html_references/matching.html`
- `mheducation_html_references/numeric_entry.html`
- `mheducation_html_references/essay.html`

## Live Validation Requirements

- Live test runs are required for changes that affect real site integrations, browser automation, selectors, extraction logic, or question-answering behavior.
- Do not treat static inspection, unit-level checks, or synthetic simulations as sufficient sign-off when the affected flow can be exercised against the live site.
- Record the live test result in the final handoff, including what was exercised and any blockers if a full live run could not be completed.
- McGraw Hill live setup/testing may need to launch through `learn.luzerne.edu`, especially for Recharge flows observed through the LMS.

## Verified Environment Availability

- GitHub CLI is available at `C:\Program Files\GitHub CLI\gh.exe`.
- GitHub auth was verified in this environment with `gh auth status`; the active authenticated account is `valzietine`, which matches the `origin` repo `https://github.com/valzietine/auto-mcgraw.git`.
- `node`, `npm`, and `npx` are installed from `C:\Program Files\nodejs\`.
- Google Chrome is available at `C:\Program Files\Google\Chrome\Application\chrome.exe`.
- Playwright CLI is available through the skill wrapper and `npx`.
- Local `node` scripts can use `playwright` after `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --no-save --no-package-lock playwright`, which avoids re-downloading browsers.
- Chrome CDP attachment is available when Chrome is launched with `--remote-debugging-port=9222`; attach from Node with `chromium.connectOverCDP("http://127.0.0.1:9222")`.

## Operational Workflow

- Playwright live verification used `output/playwright/issue-6-live` with a persistent Chrome profile.
- For a reusable live Chrome session, launch Chrome detached with `--remote-debugging-port=9222`, `--user-data-dir=<repo>\output\playwright\issue-6-live\chrome-profile`, `--disable-extensions-except=<repo>`, and `--load-extension=<repo>`.
- The `issue-6-live` profile already contained useful state for `learn.luzerne.edu`, `learning.mheducation.com`, and `chat.deepseek.com`; prefer reusing that profile for LMS/McGraw diagnostics before creating a fresh one.
- Save live-test artifacts under `output/playwright/issue-6-live/` so screenshots and diagnostics stay grouped with the profile that produced them.
- Repo-local non-live smoke scripts now live in `scripts/`: use `npm run smoke:fixtures` for offline HTML-reference checks and `npm run smoke:live` later for opt-in CDP selector smoke checks against an already-running Chrome session.

## Maintenance And Troubleshooting

- Keep commits feature-based: group changes by a single fix, feature, or operational concern, and do not bundle unrelated work into the same commit.
- If a run uncovers reproducibility tips such as Playwright commands, profile paths, launch flags, auth/state setup, or other operational shortcuts, append them here so future agents can re-create the exact flow without rediscovering the steps.
- If an existing reproducibility note is outdated or no longer works, revise or replace it instead of leaving stale operational guidance behind.
- If this file says a tool or path should be available and the current run is hanging or failing, do not treat that as final immediately. Persist through basic troubleshooting first: verify the binary/path, confirm auth, check for process/session conflicts, check ports and profile locks, try the documented alternate launch or attach path, and only report a blocker after those checks still fail.
- After live-browser or tooling runs, check `git status` before handoff and clean up or ignore generated artifacts so huge browser profiles, copied session data, temp installs, and similar runtime output do not appear as accidental source changes.
- March 17, 2026 live validation note: Chrome launched correctly with quoted `--remote-debugging-port=9222`, `--user-data-dir`, `--disable-extensions-except`, and `--load-extension` flags, but the unpacked extension still did not surface in `chrome://extensions/` or as an automation-visible extension worker. When that happens, a workable fallback for DOM-level live validation is to attach over CDP to the same Chrome session and inject the target content-script source into the live assistant page with a stubbed `chrome.runtime`.
