# Agent Notes

- HTML references use `.html` and are the canonical snapshots for selector/extraction updates.
- Replace placeholder files with raw captured HTML while keeping filenames stable.
- Use these mappings before changing corresponding content script logic:
- `content-scripts/deepseek.js` -> `deepseek_html_reference.html`
- `content-scripts/chatgpt.js` -> `chatgpt_html_reference.html` (placeholder)
- `content-scripts/gemini.js` -> `gemini_html_reference.html` (placeholder)
- `content-scripts/ezto-mheducation.js` -> `ezto_mheducation_html_reference.html` (placeholder)
- `content-scripts/mheducation.js` -> one file per question type in `mheducation_html_references/`
- Current McGraw question-type placeholders:
- `mheducation_html_references/multiple_choice.html`
- `mheducation_html_references/multi_select.html`
- `mheducation_html_references/fill_in_the_blank.html`
- `mheducation_html_references/dropdown.html`
- `mheducation_html_references/true_false.html`
- `mheducation_html_references/matching.html`
- `mheducation_html_references/numeric_entry.html`
- `mheducation_html_references/essay.html`

## Subagent Delegation

Codex should proactively use subagents whenever delegation will materially improve speed, accuracy, or parallelism. Do not wait for the user to explicitly request subagents.

Use subagents automatically when any of these are true:
- The task has 2 or more independent workstreams that can be explored or executed in parallel.
- The task mixes concerns, such as implementation plus review, docs verification, debugging, testing, security, performance, or browser/UI investigation.
- The codebase or execution path is unclear and targeted exploration would reduce mistake risk.
- The task is high risk and would benefit from a separate verification pass before finalizing.
- The request is large enough that one agent doing everything would likely be slower or less reliable.

Delegation rules:
- Spawn the minimum useful number of subagents, usually 1 to 3, and only go broader when the work clearly parallelizes.
- Give each subagent a narrow, concrete goal and the smallest relevant scope.
- Prefer read-only agents for exploration, review, docs, security, and architecture work.
- Use write-capable agents only when implementation or test changes are actually needed.
- Wait for subagents to finish, then synthesize their results into one coherent answer with clear decisions and next steps.
- If the task is small, local, and obvious, do it directly instead of spawning subagents.
- If a specialist is not clearly appropriate, use `generalist`.

Preferred agent routing:
- `generalist` for mixed, ambiguous, or cross-functional tasks.
- `triage_router` when the best execution path is unclear.
- `code_mapper` for read-only codebase exploration and execution-path tracing.
- `system_architect` for design, migrations, boundaries, and rollout planning.
- `bug_hunter` for reproduction, narrowing scope, and root-cause isolation.
- `surgical_fixer` for targeted fixes and small features once the path is clear.
- `refactorer` for behavior-preserving cleanup and structural simplification.
- `reviewer` for correctness, regression, and missing-test review.
- `test_engineer` for regression tests, repro tests, and flake reduction.
- `docs_researcher` for primary-source API or framework verification.
- `browser_debugger` for UI flows, console errors, and network-level browser evidence.
- `security_auditor` for trust boundaries, exploit paths, and concrete mitigations.
- `performance_engineer` for measurement-first latency, memory, and throughput work.
- `ops_investigator` for CI, environment, build, deploy, and runtime failures.
- `data_analyst` for logs, metrics, CSV, JSON, and reproducible analysis.
- `writer_editor` for specs, READMEs, migration notes, and technical documentation.

Fallback behavior:
- If a named custom agent is unavailable, use the closest built-in agent.
- Use `explorer` for read-heavy investigation.
- Use `worker` for execution-focused implementation.
- Use `default` when no specialist clearly fits.

The parent agent remains responsible for the final result. Subagents are for focused execution and evidence gathering, not for offloading ownership.

## Testing Requirements

- Live test runs are required for changes that affect real site integrations, browser automation, selectors, extraction logic, or question-answering behavior.
- Do not treat static inspection, unit-level checks, or synthetic simulations as sufficient sign-off when the affected flow can be exercised against the live site.
- Record the live test result in the final handoff, including what was exercised and any blockers if a full live run could not be completed.
