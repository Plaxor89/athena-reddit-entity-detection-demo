# Public Contract

The service returns a packaged downstream contract with a posture-first structure.

This document describes the fields a downstream consumer is expected to branch on. It is
not a guaranteed exhaustive dump of every key the service emits — `contract_version` on the
live response is the authoritative version marker, and the packaged output of
`buildDownstreamContract` is the live contract.

## Response packaging

The shape depends on how many items the request produced.

**One resulting item** — a single per-post object, whether the request body was one item or
a one-element array:

```json
{ "contract_version": "detector.downstream.v3", "post_id": "...", "posture": "RAG_OK", "...": "..." }
```

**More than one resulting item** — a batch envelope:

```json
{
  "contract_version": "detector.downstream.v3",
  "meta": { "is_batch": true, "item_count": 5 },
  "items": [ /* per-post contracts, in request order */ ]
}
```

`meta.item_count` always equals `items.length`, and `meta.is_batch` is true only when more
than one item is present. Consumers should not assume a bare array.

## Top-level per-post fields

| Field | Type | Meaning |
|---|---|---|
| `contract_version` | string | Schema version of the packaged response |
| `post_id` | string | Item identifier (mirrors input) |
| `posture` | string\|null | Deterministic item posture (see below) |
| `storage_intent` | string\|null | Compatibility mirror of `posture`; new consumers should prefer `posture` |
| `deterministic_detection_outcome` | string\|null | `NO_DETECTION` when no candidates entered scoring; otherwise null |
| `deterministic_selected_count` | number | Count of promoted entities |
| `needs_lmm_review` | boolean | Canonical top-level review-routing signal |
| `should_route_review` | boolean | Whether review routing applies |
| `should_route_deterministic` | boolean | Whether deterministic follow-up applies |
| `downstream_action` | string | Next workflow step (see below) |
| `review_shortlist` | array | Per-candidate review-gating rows (`stable_key`, gate decision) |
| `deterministic_item_explanation` | object\|null | Read-only outcome summary: counts and top reason codes |
| `deterministic_policy_invariant_violation` | object\|null | Populated only on an invariant failure (see below) |
| `deterministic` | object | Full score-stage output, preserved for debugging and tuning |
| `review` | object | Full review-stage output, preserved for debugging and tuning |

The `deterministic` and `review` objects mirror their upstream authority stages verbatim.
They exist for transparency, replay and tuning, and are not required for ordinary
downstream policy use. They are large, and they are intentionally omitted from the trimmed
examples in [`/examples`](../examples/).

### `downstream_action`

Next workflow step, decided by the review stage. It is not a posture field.

| Value | When |
|---|---|
| `review` | `needs_lmm_review` is true |
| `deterministic_followup` | no review needed and `deterministic_selected_count > 0` |
| `no_further_action` | neither of the above |

### `should_route_deterministic`

```
should_route_deterministic = needs_lmm_review !== true && deterministic_selected_count > 0
```

Posture is not an input to this. A `CONTEXT_ONLY` item with promoted entities and no review
need routes exactly like a `RAG_OK` one — there is no posture-specific routing branch.

## Normal detection outcomes

There are four normal detection outcomes, and they are not all posture values.

- **Candidate-present posture values** — `RAG_OK`, `CONTEXT_ONLY`, `RAW_ONLY`. These are the
  values `posture` can take, and `deterministic_detection_outcome` is null.
- **`NO_DETECTION`** is not a posture value. It is represented by `posture: null` together
  with `deterministic_detection_outcome: "NO_DETECTION"`.

### `RAG_OK`
Strongest promoted posture. The item's primary detection surface (title or OP body) contains
a deterministic, unambiguous entity mention with sufficient supporting evidence. Entities at
this tier may be forwarded to retrieval text.

### `CONTEXT_ONLY`
Weaker-but-true promoted posture. The entity is genuinely detected but the evidence is less
central, less primary, or otherwise less defensible for retrieval use. Entities at this tier
are preserved in structured metadata but not rendered into retrieval text.

### `RAW_ONLY`
Candidates were found and scored, but none were promoted. The item is stored for diagnostics,
replay, and tuning.

### `NO_DETECTION`
No deterministic candidates entered the scoring stage at all. `posture` is `null` and
`deterministic_detection_outcome` is `"NO_DETECTION"`. This is distinct from `RAW_ONLY` —
there were no candidates to score, not candidates that failed promotion.

## Valid item-level outcome shapes

These four are the complete set of normal outcomes.

| posture | deterministic_detection_outcome | Meaning |
|---|---|---|
| `RAG_OK` | null | Strongest promoted posture |
| `CONTEXT_ONLY` | null | Weaker-but-true promoted posture |
| `RAW_ONLY` | null | Candidates present, none promoted |
| null | `NO_DETECTION` | No candidates entered scoring |

## Invariant violations — not a normal outcome

The score stage reports states it treats as impossible rather than emitting a
plausible-looking posture. This is an error shape, **not a fifth valid outcome**.

When it occurs:

```
posture:                                   null
deterministic_detection_outcome:           null
deterministic_policy_invariant_violation:  { "code": "...", "message": "...", "post_id": "..." }
```

Named codes include `DETERMINISTIC_POLICY_LANE_INVARIANT_FAILED` (selected rows present but
no policy lane could be derived) and `DETERMINISTIC_CANDIDATES_NOT_PARTITIONED` (candidates
present but placed in neither the selected nor the suppressed pool).

Consumers should treat this as **no usable normal outcome, plus a reported detector invariant
failure**. It is not `NO_DETECTION`: in `NO_DETECTION` the detector is telling you there was
nothing to detect, and here it is telling you it could not complete a decision it should have
been able to complete.

## What consumers must not do

- Re-derive posture from nested candidate arrays
- Treat `RAW_ONLY` as equivalent to `NO_DETECTION`
- Treat an invariant violation as `NO_DETECTION`, or as a normal posture
- Use review routing fields as a substitute for posture
- Invent new normal outcome states beyond the four defined above
- Assume a bare array for multi-item responses

## Example

See the [`/examples`](../examples/) folder for sanitized request and response examples
covering the four normal detection outcomes. Those examples are trimmed illustrations —
this document is authoritative for response packaging and field meaning.
