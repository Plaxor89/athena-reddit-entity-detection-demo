# Public Contract

The service returns a packaged downstream contract with a posture-first structure.

## Canonical top-level fields

| Field | Type | Meaning |
|---|---|---|
| `contract_version` | string | Schema version of the packaged response |
| `post_id` | string | Item identifier (mirrors input) |
| `posture` | string\|null | Deterministic item posture (see below) |
| `storage_intent` | string\|null | Mirrors `posture` for compatibility |
| `deterministic_detection_outcome` | string\|null | `NO_DETECTION` when posture is null; otherwise null |
| `deterministic_selected_count` | number | Count of promoted entities |
| `needs_lmm_review` | boolean | Top-level review routing signal |
| `should_route_review` | boolean | Whether review routing applies |
| `should_route_deterministic` | boolean | Whether entity forwarding applies |
| `downstream_action` | string | Suggested next action (`deterministic_followup`, `context_only_forward`, `no_further_action`) |

## Posture vocabulary

### `RAG_OK`
Strongest promoted posture. The item's primary detection surface (title or OP body) contains a deterministic, unambiguous entity mention with sufficient supporting evidence. Entities at this tier may be forwarded to retrieval text.

### `CONTEXT_ONLY`
Weaker-but-true promoted posture. The entity is genuinely detected but the evidence is less central, less primary, or otherwise less defensible for retrieval use. Entities at this tier are preserved in structured metadata but not rendered into retrieval text.

### `RAW_ONLY`
Candidates were found and scored, but none were promoted. The item is stored for diagnostics, replay, and tuning. No entities are forwarded downstream.

### `NO_DETECTION`
No deterministic candidates entered the scoring stage at all. `posture` is `null` and `deterministic_detection_outcome` is `"NO_DETECTION"`. This is distinct from `RAW_ONLY` — there were no candidates to score, not candidates that failed promotion.

## Valid item-level outcome shapes

| posture | deterministic_detection_outcome | Meaning |
|---|---|---|
| `RAG_OK` | null | Strongest promoted posture |
| `CONTEXT_ONLY` | null | Weaker-but-true promoted posture |
| `RAW_ONLY` | null | Candidates present, none promoted |
| null | `NO_DETECTION` | No candidates entered scoring |

## Entity forwarding

After detection, a downstream payload builder constructs a per-item forwarding package:

```json
{
  "post_id": "...",
  "storage_intent": "RAG_OK",
  "has_forwardable_entities": true,
  "forwarding_reason": "forwarded",
  "rag_ok_entities": [
    { "stable_key": "hero||hanzo||HERO", "canonical_slug": "hanzo", "display_name": "Hanzo", "category": "hero" }
  ],
  "context_only_entities": []
}
```

Forwarding rules:

- `RAG_OK` posts → entities appear in `rag_ok_entities`; may be rendered into retrieval text
- `CONTEXT_ONLY` posts → entities appear in `context_only_entities`; preserved in structured metadata
- `RAW_ONLY` posts → `has_forwardable_entities: false`, `forwarding_reason: "raw_only_not_forwarded"`
- `NO_DETECTION` posts → `has_forwardable_entities: false`, `forwarding_reason: "no_detection"`

## What consumers must not do

- Re-derive posture from nested candidate arrays
- Treat `RAW_ONLY` as equivalent to `NO_DETECTION`
- Use review routing fields as a substitute for posture
- Invent new posture states beyond the four defined above

## Example

See the [`/examples`](../examples/) folder for sanitized request/response pairs covering all four posture outcomes.
