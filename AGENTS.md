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

## Testing Requirements

- Live test runs are required for changes that affect real site integrations, browser automation, selectors, extraction logic, or question-answering behavior.
- Do not treat static inspection, unit-level checks, or synthetic simulations as sufficient sign-off when the affected flow can be exercised against the live site.
- Record the live test result in the final handoff, including what was exercised and any blockers if a full live run could not be completed.
