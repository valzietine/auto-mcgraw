# SmartBook Matching Response ID Variant

Observed on `learning.mheducation.com/static/awd/*` SmartBook matching questions launched from Blackboard on March 15, 2026.

## DOM difference

- Pool choices render as `.choices-container .choice-item-wrapper[id^="choices:"]`
- Once a choice is dropped into a response row, SmartBook rewrites the id to `.match-single-response-wrapper .choice-item-wrapper[id^="response:"]`
- While a pool item is lifted with keyboard drag, the DOM does not expose intermediate row movement; the item stays in the pool until the final drop commits.

Example:

```html
<div
  class="choice-item-wrapper"
  id="response:b52964ba-9634-4340-bbb9-12403fe11e2f"
  data-react-beautiful-dnd-drag-handle="0"
  role="button"
>
```

## Automation impact

Matching automation cannot assume row items keep the `choices:` prefix after placement. Row lookup, snapshots, and item-location tracking need to accept both `choices:` and `response:` ids.

SmartBook keyboard drag does not expose intermediate movement in the DOM while an item is lifted. Matching automation should treat drag movement as deterministic:

- From the pool, `ArrowUp` traverses pool positions first and then response rows from bottom to top.
- From an occupied row, `ArrowUp` and `ArrowDown` move between rows by count, and the DOM only reflects the final position after drop.

That means matching automation should count movement steps up front instead of waiting for the DOM to update after each arrow key.
