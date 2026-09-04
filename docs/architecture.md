# Architecture

This service processes Reddit post items through a deterministic pipeline and returns a packaged downstream contract.

## Workflow context

An upstream workflow (n8n) fetches Reddit posts from r/Overwatch and runs an LLM annotation pass that produces thread-level metadata: `thread_type`, `topic_scope`, `user_goal`, sentiment signals, and related fields. Those annotated items are sent as an HTTP POST to this service.

The service processes each item through the detection pipeline and returns the packaged detection result.

### Scope note

This service is scoped to the Reddit pipeline. Other Athena workflows handle official core game data, patch notes, hero statistics, and creator video metadata. Those other workflows are intentionally omitted from this demo so the repo stays focused on one clean service boundary.

## Before / after

### Before

The detection logic began as a few hundred lines of JavaScript inside a single n8n code step, and grew to several thousand lines as more cases had to be handled.

The first attempt at a fix kept the work inside n8n: it was split across around twenty workflow nodes, covering detection input shaping, static dictionary/policy preparation, database-backed entity loading, candidate generation, scoring/suppression, and downstream entity forwarding.

That made the workflow easier to scan, but it did not solve the underlying problem. The hardest decisions — why one candidate was promoted and another suppressed — were still difficult to trace when a result looked wrong.

### After

The current architecture replaces that detection section with a dedicated Node.js service called from n8n through a single HTTP Request node.

n8n remains responsible for:

- Reddit collection and filtering
- upstream LLM annotation
- telemetry
- storage
- downstream workflow branching

This service is responsible for:

- detection input normalization
- policy and dictionary loading
- exact and fuzzy candidate generation
- canonical identity resolution
- scoring and suppression
- deterministic posture decisions
- review routing
- downstream contract packaging

This keeps orchestration and detection policy separate. The workflow decides when to call the service and what to do with the result; the service decides what was detected and how strongly it should be forwarded.

### Equivalence check before cutover

Before the workflow was switched to the service, outputs from the in-workflow version were saved as test cases and the same inputs were run through the new service. Results had to match **stage by stage**, not only at the final output, before the workflow was allowed to depend on it.

The stage separation is what makes that check meaningful in both directions: it is also what lets a wrong result afterwards be traced back to the stage that made the decision.

Those comparisons ran against private workflow data. The sanitized examples in this repository are illustrations of the public contract, not those historical test cases.

## Pipeline stages

### 1. `buildDetectionInput`

Normalizes title, OP body, and top comments into detection surfaces. Derives intent signals: whether the post is asking a question, what entity categories are targeted, thread policy classification (broad-general vs subject-favoring vs news-like), and upstream prior state. No entity dictionary or policy loading happens here.

### 2. `loadPolicyBundle`

Loads entity dictionaries and metadata from the database and merges them with static sources. Result is cached in memory for 10 minutes; on rebuild failure, the stale cache is served rather than throwing. The bundle contains:

- alias rows (canonical names, slugs, derived community aliases, and their promotion risk tiers)
- entity metadata (hero role, map game mode, ability kind, perk tier)
- static anchor groups, negative anchor patterns, and answer-slot detection patterns

### 3. `packCandidates`

Scans detection surfaces (title, OP body, top comments) against the entity dictionary. Generates exact-match candidate proposals with provenance (source surface, comment rank/score), `score_base`, and noise flags. This stage proposes; it does not decide.

### 4. `expandFuzzyCandidates`

Optionally expands candidates using fuzzy similarity when the policy allows. Conservative by design. Fuzzy proposals carry similarity and ambiguity telemetry and go through the same suppression logic as exact candidates.

### 5. `normalizeAndResolveCandidates`

Merges exact and fuzzy candidate sources. Resolves canonical identity (owner scope, alias-tier deduplication, equivalence). Enriches candidate rows with subjecthood, centrality, and contradiction context. Produces normalized candidate rows for the score stage.

### 6. `scoreSuppressLane` ← deterministic posture authority

The authoritative deterministic policy stage. Scores candidates, applies suppression rules, and decides the final item-level posture. This stage owns:

- candidate scoring and suppression decisions
- selected vs non-promoted candidate shaping
- item-level posture (`RAG_OK`, `CONTEXT_ONLY`, `RAW_ONLY`)
- explicit `NO_DETECTION` when no candidates enter scoring
- suppression reason codes and score-stage telemetry

Nothing downstream may re-derive or override posture.

### 7. `buildReviewDecision` ← review routing authority

Decides whether an item needs additional review or downstream interpretation. Review is a separate axis from deterministic posture — the same post can have a strong posture and still need review, or a weak posture and not need it. This stage owns review-need, route blockers, route reasons, and the review shortlist.

### 8. `buildDownstreamContract` — packaging only

Assembles the consumer-facing response envelope from `scoreSuppressLane` and `buildReviewDecision` outputs. Mirrors deterministic and review truth into stable top-level fields. May include nested payloads for debugging and tuning. Must not reinterpret candidate arrays or invent new policy states.

## Ownership boundaries

```
scoreSuppressLane       → deterministic posture and detection outcome
buildReviewDecision     → review routing
buildDownstreamContract → packaging only
```

Downstream consumers should branch on top-level `posture` and `deterministic_detection_outcome`. They must not re-derive posture from nested candidate arrays.

## HTTP interface

`POST /` with a JSON body: one item object or an array of items.

Response: the packaged downstream contract.

- **One resulting item** — a single per-post object, whether the request body was one item or a one-element array.
- **More than one resulting item** — a batch envelope: `{ contract_version, meta: { is_batch: true, item_count }, items: [ ... ] }`, with items in request order.

For the contract structure, see [public-contract.md](public-contract.md).
