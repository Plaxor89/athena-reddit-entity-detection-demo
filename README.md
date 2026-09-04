# Athena Reddit Entity Detection — Portfolio Demo

Athena is a live site about Overwatch. It reads several kinds of information — official game
data, hero statistics, patch notes, community discussion, and creator video metadata — and
turns a small part of that into reasons to look closer.

This repository is not that site. It is a sanitized portfolio copy of one service behind it:
the part that works out which parts of the game a Reddit discussion is actually about.

---

## What this service does

It is an HTTP service. It receives Reddit posts — title, body, top comments, and what a
language model already worked out about the thread — and returns a structured result saying
which Overwatch entities were detected (heroes, abilities, perks, maps, ranks, modes) and how
strongly the result should be treated downstream.

That result is not a list of every hero name that appeared. It is a judgement about what the
discussion is *about*.

---

## Why entity detection is difficult

People don't use the exact hero name. They use nicknames, abbreviations and ability names,
and some hero names are ordinary English words. A hero can also be mentioned once in a side
comment without being what the thread is really about.

A language model already reads these threads and interprets the conversation — what kind of
thread it is, whether the comments contain a useful answer, broadly what is being discussed.
This service does a different job: it decides which actual parts of the game the discussion
centers on, and it has to tell a passing mention apart from a subject.

---

## How it evolved

The detection logic started as a few hundred lines of JavaScript inside a single n8n workflow
step. As more cases had to be handled, it grew to several thousand lines — all still inside
that one step.

I tried the cheaper fix first: splitting the logic across around twenty n8n workflow steps.
That made the workflow easier to scan, but it did not solve the actual problem. The hardest
decisions — why one candidate was promoted and another suppressed — were still difficult to
trace when a result looked wrong.

So the detector moved into a dedicated Node.js service. The service separates the work into
stages, each stage has one job, and one stage owns the final decision.

---

## How the change was checked

Before the workflow was allowed to depend on the service, outputs from the existing
in-workflow version were saved as test cases and the same inputs were run through the new
one. The results had to match, stage by stage — not only at the final output — before
anything was switched over.

Because the service is split into stages, a wrong result afterwards is easier to trace back
to the stage that made the decision. That was the point of moving it: not that the logic got
simpler, but that a wrong answer became findable.

Those historical comparisons ran against private workflow data and are not what the
sanitized examples in this repository contain.

---

## What n8n does, and what this service does

n8n was not replaced. It still runs the surrounding workflow.

| | Responsibility |
|---|---|
| **n8n** | Collects and filters Reddit posts, runs the language-model step, stores results, handles telemetry and downstream branching |
| **Language model** | Interprets the conversation — what kind of thread it is, whether the comments answer anything |
| **This service** | Decides which Overwatch entities the discussion centers on, and returns the detector contract |

The workflow decides when to call the service and what to do with the result; the service
decides what was detected and how strongly it should be forwarded.

---

## Start here: the examples

The [`/examples`](examples/) folder is the fastest way to see what this service does. It
needs no database and no setup.

| File | What it shows |
|---|---|
| [`examples/detector-request.sanitized.json`](examples/detector-request.sanitized.json) | Input shape — 5 posts, invented demo data |
| [`examples/detector-response.trimmed.sanitized.json`](examples/detector-response.trimmed.sanitized.json) | A trimmed selection of real response fields |

The five demo posts cover the four normal detection outcomes:

| Post | Outcome | Why |
|---|---|---|
| 1 | `RAG_OK` | Hero named in the title |
| 2 | `RAG_OK` | Two heroes, both in the post body |
| 3 | `CONTEXT_ONLY` | Genuinely about a hero, but as fan art — true, weaker evidence |
| 4 | `RAW_ONLY` | Candidates found, all suppressed |
| 5 | `NO_DETECTION` | Nothing entered scoring at all |

These files are trimmed illustrations, not replayable fixtures — the working service consumes
more upstream annotation than the sanitized request carries, and returns more than the
trimmed response shows. See [`examples/README.md`](examples/README.md) for exactly what is
included and what is left out.

---

## The detector contract

The response is built around one field: `posture` — how strongly this post's detected
entities should be treated downstream. There are four normal outcomes, and the last two are
deliberately different from each other:

- **`RAG_OK`** — strongest. A clear, unambiguous entity in the title or body, with enough
  supporting evidence.
- **`CONTEXT_ONLY`** — true but weaker. The entity really is there, but the evidence is less
  central or less defensible.
- **`RAW_ONLY`** — candidates were found and scored, but none were promoted.
- **`NO_DETECTION`** — no candidates entered scoring at all. Not the same as `RAW_ONLY`:
  nothing was there to score, rather than something that failed to qualify.

Review routing is a separate axis from posture. An item can have a strong posture and still
be flagged for further review, or a weak one and not be.

A single result is returned as a per-post object; multiple results are returned in a batch
envelope. Separately from the four normal outcomes, the score stage can report a named
invariant violation rather than emit a posture it does not trust.

Field meanings, packaging and the violation shape:
[`docs/public-contract.md`](docs/public-contract.md) — the public contract reference.

---

## How the pipeline is put together

```
HTTP POST  (one item or a batch)
  └─► detectionHttpHandler        parse and route
        └─► runDetectionPipeline
              ├─ buildDetectionInput           normalize, derive intent
              ├─ loadPolicyBundle              load DB + static sources (cached)
              ├─ packCandidates                exact dictionary matching
              ├─ expandFuzzyCandidates         conservative fuzzy expansion
              ├─ normalizeAndResolveCandidates resolve canonical identity
              ├─ scoreSuppressLane             ← decides posture
              ├─ buildReviewDecision           ← decides review routing
              └─ buildDownstreamContract       packaging only
```

The rule that holds the whole thing together: **posture is decided once, in
`scoreSuppressLane`, and nothing downstream re-derives or reinterprets it.**
`buildDownstreamContract` packages the result and is not allowed to become a second decision
engine.

---

## What the implementation demonstrates

- **Staged pipeline** — each stage has one job: normalize, pack candidates, expand fuzzy
  matches, resolve identity, score and suppress, decide review, package output.
- **Ownership boundaries** — `scoreSuppressLane` owns posture, `buildReviewDecision` owns
  review routing, `buildDownstreamContract` is packaging only.
- **Posture-first contract** — consumers branch on one top-level field, not on nested
  candidate arrays.
- **Named suppression reasons** — when a candidate is dropped, the response says which rule
  dropped it. This is what makes a wrong answer traceable.
- **Self-reported invariant breaks** — if the scoring stage reaches a state it treats as
  impossible, it reports a named violation instead of returning a plausible-looking result.
- **DB-backed policy loading** — entity dictionaries, aliases and metadata are loaded from
  PostgreSQL and cached in memory for 10 minutes. If a rebuild fails, the stale cache is
  served rather than failing the request: slightly old policy is a better answer than no
  answer.
- **Thin HTTP adapter** — no business logic in the handler; parse, run, return.

---

## Docs

- [`docs/architecture.md`](docs/architecture.md) — stage responsibilities and ownership boundaries
- [`docs/public-contract.md`](docs/public-contract.md) — public contract reference: posture vocabulary, response packaging, invariant violations
- [`docs/sanitization.md`](docs/sanitization.md) — what is omitted from this public copy, and why

---

## Running it

Node 22, Express, and node-postgres (`pg`). No build step.

```
npm install
npm start          # listens on $PORT, default 8080
```

Database connection config is read entirely from environment variables — `DB_USER`,
`DB_PASSWORD`, `DB_NAME`, plus `DB_INSTANCE_NAME` when deployed or `DB_HOST` / `DB_PORT`
locally. Nothing is hardcoded. The service exposes both an Express entry point
(`src/server.js`) and a function-style handler (`src/index.js`) for HTTP-triggered cloud
runtimes.

Policy loading expects an Athena-style PostgreSQL schema, so the service will not do useful
work against an empty database. **The `/examples` folder is the intended way to review the
public request and response concepts** — it needs neither a database nor a running service.

---

## What this repository is not

This is a sanitized portfolio copy, not the private working service and not the Athena
website. See [`docs/sanitization.md`](docs/sanitization.md) for the full list; in short, it
omits:

- Database credentials, connection strings and instance identifiers
- Cloud infrastructure and secrets configuration
- Real Reddit post IDs, usernames and comment content
- Internal operational documentation and n8n workflow exports

---

## How I worked on this

I used AI tools heavily while building this, but I didn't treat their output as the answer.
I decided what the detector should do, tested what came back, investigated why something
failed, and decided whether a change was good enough to keep. The old-versus-new comparison
above is the clearest example: the service only got to replace the original once its results
matched, stage by stage.

My background is in technical support, which is roughly how I approach this work — start from
what actually happened, trace it through the systems involved, and verify the fix rather than
assuming it worked.
