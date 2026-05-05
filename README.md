# Athena Reddit Entity Detection — Portfolio Demo

This is a sanitized portfolio version of the Athena Overwatch Reddit entity detection service.

The production version processes Reddit threads for Athena, a knowledge system for the Overwatch game. This demo repo contains the core detection pipeline, example inputs and outputs, and public-facing documentation showing how the service classifies Reddit posts by detected game entity.

---

## What this project is

An HTTP service that receives Reddit post items — title, body, top comments, and upstream LLM annotations — and returns a structured detection result indicating which Overwatch game entities (heroes, abilities, perks, maps, ranks, modes) were detected and at what confidence tier.

---

## Why I built it

The original Reddit entity detection logic lived inside the main n8n workflow across several code/query nodes. That worked at first, but as the detection policy grew it became harder to test, evolve safely, and reason about edge cases.

I moved that logic into a dedicated Node.js service with explicit pipeline stages. The main n8n workflow can stay focused on orchestration, Reddit collection, upstream LLM annotation, telemetry, storage, and downstream branching, while this service owns entity detection and returns a stable contract.

The result is a cleaner service boundary: n8n orchestrates, the detector decides posture and routing, and downstream nodes consume a structured response instead of reinterpreting raw detection internals.

---

## What it demonstrates

- **Staged detection pipeline** — each stage has one job: normalize input, pack candidates, expand fuzzy matches, resolve identities, score and suppress, decide review, package output
- **Ownership boundaries** — `scoreSuppressLane` owns posture, `buildReviewDecision` owns review routing, `buildDownstreamContract` is packaging only, never a second decision engine
- **Posture-first contract** — output is structured around `posture` (`RAG_OK`, `CONTEXT_ONLY`, `RAW_ONLY`, `NO_DETECTION`), not raw entity arrays
- **DB-backed policy loading** — entity dictionaries, aliases, and metadata loaded from a PostgreSQL database with a 10-minute in-memory cache and stale-fallback on rebuild failure
- **Fuzzy matching and suppression** — fuzzy candidates are expanded conservatively and suppressed with explicit named reason codes
- **Thin HTTP adapter** — no business logic in the HTTP handler; just parse, route, and return the packaged contract

---

## Architecture overview

```
HTTP POST  (one item or a batch)
  └─► detectionHttpHandler        parse and route
        └─► runDetectionPipeline
              ├─ buildDetectionInput           normalize, derive intent
              ├─ loadPolicyBundle              load DB + static sources (cached)
              ├─ packCandidates                exact dictionary matching
              ├─ expandFuzzyCandidates         conservative fuzzy expansion
              ├─ normalizeAndResolveCandidates resolve canonical identity
              ├─ scoreSuppressLane             ← deterministic posture authority
              ├─ buildReviewDecision           ← review routing authority
              └─ buildDownstreamContract       packaging only
```

The key design rule: deterministic posture is decided once, in `scoreSuppressLane`. Nothing downstream re-derives or reinterprets it.

---

## Example files

The `/examples` folder contains sanitized, simplified examples derived from real workflow runs.

| File | What it shows |
|---|---|
| [`examples/detector-request.sanitized.json`](examples/detector-request.sanitized.json) | Input batch (5 posts, invented demo data) |
| [`examples/detector-response.trimmed.sanitized.json`](examples/detector-response.trimmed.sanitized.json) | Trimmed public-contract responses |
| [`examples/deterministic-evidence-payload.sanitized.json`](examples/deterministic-evidence-payload.sanitized.json) | Downstream entity forwarding payload |

Outcomes demonstrated across the five posts: `RAG_OK` (×2), `CONTEXT_ONLY`, `RAW_ONLY`, and `NO_DETECTION`.

---

## Docs

- [`docs/architecture.md`](docs/architecture.md) — stage responsibilities and ownership boundaries
- [`docs/public-contract.md`](docs/public-contract.md) — posture vocabulary and entity forwarding
- [`docs/sanitization.md`](docs/sanitization.md) — what is omitted from this demo repo and why

---

## Technical notes

The service uses Express and node-postgres (`pg`). Database connection config is read entirely from environment variables (`DB_USER`, `DB_PASSWORD`, `DB_NAME`; `DB_INSTANCE_NAME` for deployed mode; `DB_HOST`/`DB_PORT` for local mode). No values are hardcoded.

This demo includes the service and pipeline structure, but DB-backed policy loading expects an Athena-style PostgreSQL schema. The `/examples` folder is the easiest way to review the public request/response contract without a private database.

---

## What is intentionally omitted

See [`docs/sanitization.md`](docs/sanitization.md) for the full list. Short version:

- Production database credentials, connection strings, and instance names
- Cloud infrastructure configuration (runtime, IAM, secrets management)
- Real Reddit post IDs, usernames, and comment content
- Internal maintenance notes, deployment runbooks, and operational history
- n8n workflow exports and raw API response fixtures

---

## AI tooling note

I used AI-assisted tooling to help build and refine code, write documentation, and work through edge cases. My focus was on system design, detection policy logic, workflow behavior, testing and regression, and integration. The pipeline architecture, posture model, and suppression policy reflect my own design choices around how the system should behave.
