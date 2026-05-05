# Examples

These files are sanitized, simplified examples derived from a real n8n → Cloud Run entity detection workflow running against r/Overwatch posts.

Post IDs, usernames, comment text, author IDs, media URLs, bearer tokens, and workflow execution IDs have been replaced with invented demo values and placeholder identifiers (`demo_post_N`, `demo_user_N`). Titles and post bodies are invented demo text inspired by the general subject matter of the originals.

Hero and game entity names (Hanzo, Zarya, Reinhardt, Widowmaker, etc.) are kept — they are the point of the demo.

---

## Files

### `detector-request.sanitized.json`

A batch of five sanitized posts as they would be submitted to the Cloud Run detector service. Represents the input shape after n8n pre-processing and LLM annotation, stripped of raw Reddit API boilerplate. Relevant fields: `post_id`, `title`, `body`, `top_comments`, `thread_type`, `topic_scope`.

### `detector-response.trimmed.sanitized.json`

The detector's response for each post, trimmed to the public contract fields. Omits internal scoring telemetry, normalized source text, fuzzy shadow diagnostics, dictionary hit counts, and policy snapshots.

Included:
- `posture`, `storage_intent`, `deterministic_detection_outcome` — canonical outcome fields
- `needs_lmm_review`, `should_route_review`, `should_route_deterministic`, `downstream_action` — routing signals
- `deterministic_item_explanation` — outcome summary, candidate counts, top reason codes
- `deterministic.selected` — promoted entities with source surface and posture
- `deterministic.non_promoted_summary` — suppressed entity count and top suppression reason

### `deterministic-evidence-payload.sanitized.json`

The downstream evidence forwarding payload built after detection. Shows which entities are forwarded per post and at what posture tier (`rag_ok_entities` vs `context_only_entities`). Posts with `RAW_ONLY` or `NO_DETECTION` outcomes are not forwarded.

---

## Posture outcomes shown

| Post            | Posture          | Entities forwarded                       | Notes                                    |
|-----------------|------------------|------------------------------------------|------------------------------------------|
| demo_post_001   | `RAG_OK`         | Hanzo                                    | Title match, strongest promoted posture  |
| demo_post_002   | `RAG_OK`         | Zarya, Reinhardt                         | Both detected in OP body                 |
| demo_post_003   | `CONTEXT_ONLY`   | Widowmaker                               | Fan art post — true but weaker posture   |
| demo_post_004   | `RAW_ONLY`       | none                                     | Candidates found, all suppressed (comp/role context anchor hit) |
| demo_post_005   | `NO_DETECTION`   | none                                     | No deterministic candidates entered scoring at all |

`RAW_ONLY` and `NO_DETECTION` are distinct outcomes. `RAW_ONLY` means candidates were found and scored but none were promoted. `NO_DETECTION` means no candidates entered the scoring stage.

---

## Workflow context

```
n8n  (Reddit fetch + LLM annotation)
  └─► Cloud Run detector  (HTTP POST, authenticated)
        └─► detection pipeline
              ├─ buildDetectionInput
              ├─ loadPolicyBundle
              ├─ packCandidates
              ├─ expandFuzzyCandidates
              ├─ normalizeAndResolveCandidates
              ├─ scoreSuppressLane          ← deterministic posture authority
              ├─ buildReviewDecision        ← review routing authority
              └─ buildDownstreamContract   ← packaging only
        └─► downstream evidence payload builder
              └─► storage / RAG routing
```

`posture` is the canonical top-level field for routing and storage decisions. Internal lane/scoring telemetry in the full response is implementation detail for tuning and debugging — downstream consumers should branch on `posture` and `deterministic_detection_outcome`, not on nested candidate arrays.
