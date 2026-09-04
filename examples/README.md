# Examples

These files are sanitized, simplified illustrations of the detector's public input and output
concepts, based on a real n8n → detector service workflow running against r/Overwatch posts.

Post IDs, usernames, comment text, author IDs, media URLs and workflow execution IDs have been
replaced with invented demo values and placeholder identifiers (`demo_post_N`, `demo_user_N`).
Titles and post bodies are invented demo text inspired by the general subject matter of the
originals.

Hero and game entity names (Hanzo, Zarya, Reinhardt, Widowmaker, etc.) are kept — they are the
point of the demo.

---

## What these files are, and what they are not

Four things are worth being explicit about, so the files are read for what they are:

1. **The request file is deliberately trimmed, and is not a replayable detector input.** The
   working service consumes a considerably larger item, including additional upstream
   annotation fields produced by the language-model step. Those are omitted here rather than
   publishing private workflow data. Running the trimmed request through the detector would
   not reproduce the outcomes shown.

2. **The response file contains a selected subset of response fields.** Every field present is
   a real field emitted by the service code published in this repository; many real fields are
   left out.

3. **The five response objects are shown without the outer batch envelope**, purely for
   readability. A real multi-item response wraps them:

   ```json
   {
     "contract_version": "detector.downstream.v3",
     "meta": { "is_batch": true, "item_count": 5 },
     "items": [ /* per-post contracts */ ]
   }
   ```

   [`docs/public-contract.md`](../docs/public-contract.md) is authoritative for response
   packaging.

4. **The large nested `deterministic` and `review` payloads are omitted.** A real response
   carries both — the full score-stage and review-stage outputs, preserved for debugging and
   tuning. They are not reproduced here, and nothing in these files stands in for them.

Taken together: these are illustrative examples of the public contract, not captured output of
a single current run.

---

## Files

### `detector-request.sanitized.json`

Five sanitized posts showing the general input shape submitted to the detector service, after
n8n pre-processing and language-model annotation and stripped of raw Reddit API boilerplate.
Fields shown: `post_id`, `title`, `body`, `top_comments`, `thread_type`, `topic_scope`.

### `detector-response.trimmed.sanitized.json`

A per-post response for each of the five posts, trimmed to a readable subset of the contract.

Included:
- `contract_version`, `post_id`
- `posture`, `storage_intent`, `deterministic_detection_outcome` — canonical outcome fields
- `deterministic_selected_count`
- `needs_lmm_review`, `should_route_review`, `should_route_deterministic`, `downstream_action`
  — routing signals
- `deterministic_item_explanation` — outcome summary, candidate counts, top reason codes

Omitted: the nested `deterministic` and `review` payloads, `review_shortlist`, internal
scoring telemetry, normalized source text, fuzzy shadow diagnostics, dictionary hit counts,
and policy snapshots.

---

## Detection outcomes shown

The five demo posts cover the four normal detection outcomes.

| Post            | Posture          | Promoted | Notes                                    |
|-----------------|------------------|----------|------------------------------------------|
| demo_post_001   | `RAG_OK`         | 1        | Title match, strongest promoted posture  |
| demo_post_002   | `RAG_OK`         | 2        | Both detected in OP body                 |
| demo_post_003   | `CONTEXT_ONLY`   | 1        | Fan art post — true but weaker posture   |
| demo_post_004   | `RAW_ONLY`       | 0        | Candidates found, all suppressed (comp/role context anchor hit) |
| demo_post_005   | `NO_DETECTION`   | 0        | No deterministic candidates entered scoring at all |

`RAW_ONLY` and `NO_DETECTION` are distinct outcomes. `RAW_ONLY` means candidates were found
and scored but none were promoted. `NO_DETECTION` means no candidates entered the scoring
stage.

Separately from these four, the score stage can report a named invariant violation instead of
a posture. That shape is documented in
[`docs/public-contract.md`](../docs/public-contract.md) and is not illustrated here.

---

## Workflow context

```
n8n  (Reddit fetch + language-model annotation)
  └─► detector service  (HTTP POST)
        └─► detection pipeline
              ├─ buildDetectionInput
              ├─ loadPolicyBundle
              ├─ packCandidates
              ├─ expandFuzzyCandidates
              ├─ normalizeAndResolveCandidates
              ├─ scoreSuppressLane          ← deterministic posture authority
              ├─ buildReviewDecision        ← review routing authority
              └─ buildDownstreamContract    ← packaging only
        └─► n8n stores the result and branches on it
```

`posture` is the canonical top-level field for routing and storage decisions. Internal
lane/scoring telemetry in the full response is implementation detail for tuning and
debugging — downstream consumers should branch on `posture` and
`deterministic_detection_outcome`, not on nested candidate arrays.
