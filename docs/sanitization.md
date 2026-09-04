# Sanitization Notes

This is a sanitized portfolio version of a private working service used inside the Athena project. The sections below describe what has been omitted or replaced and what remains.

---

## Omitted from this repo

### Infrastructure and credentials

- Database connection strings, instance names, and credentials
- Cloud Run service name and region
- Cloud SQL instance identifier
- Secrets management configuration
- IAM service account names and roles
- GCP project ID

### Operational documentation

- Deployment runbook and revision configuration model
- Secrets and database wiring details
- Runtime auth model and invocation flow
- Live testing procedures
- Operational gotchas and hardening notes

### Private workflow and project state

- Internal maintenance notes and tactical planning docs
- Checkpoint log and accepted change history
- n8n workflow exports and raw API response fixtures
- Legacy n8n entity-detection workflow export
- Real Reddit post IDs, usernames, and comment content

### Legacy n8n detection export

The original entity detection implementation lived inside the main n8n Reddit workflow before being moved into this dedicated service. That legacy workflow export is intentionally omitted from the public demo.

It contains internal workflow structure, code/query node details, SQL/query context, and operational project history that are not needed to understand the public service boundary. The public repo instead documents the before/after architecture at a high level and includes sanitized request/response examples.

---

## What is included

### Source code (`src/`)

The full detection pipeline, HTTP adapter, DB client, and config helpers. No hardcoded credentials, project IDs, or service account names. Database connection config is read entirely from environment variables:

| Variable | Used for |
|---|---|
| `DB_USER` | Database username |
| `DB_PASSWORD` | Database password |
| `DB_NAME` | Database name |
| `DB_INSTANCE_NAME` | Cloud SQL socket path (deployed mode only) |
| `DB_HOST` | Host override (local mode, default `127.0.0.1`) |
| `DB_PORT` | Port override (local mode, default `5432`) |

The SQL in `src/pipeline/policy/loadDbPolicySources.js` references PostgreSQL table names (`heroes`, `maps`, `hero_ability`, `hero_perks`, `hero_perk_versions`, `alias_registry`, `alias_registry_policy`). These are game-data schema names for an Overwatch knowledge system, not sensitive infrastructure identifiers.

### References to private policy documents

Comments in `src/` refer to two internal policy documents that this source snapshot was taken alongside and that are intentionally not published here: `LANE_AND_STORAGE_POLICY.md` and `CONTRACTS.md`.

They hold internal policy history, invariant derivations and tuning rationale that are not needed to understand the public service boundary. The comments were retained so that this sanitized snapshot was not rewritten solely to remove private-document references, and so it reads as a genuine extract rather than an edited one. The behaviour those documents govern is described publicly in [`architecture.md`](architecture.md) and [`public-contract.md`](public-contract.md).

### Example files (`examples/`)

Two sanitized JSON files — a request example and a trimmed response example — plus a README explaining them. Post IDs, usernames, and comment text have been replaced with invented demo values and placeholder identifiers (`demo_post_N`, `demo_user_N`). Titles and bodies are invented demo text inspired by the general subject matter of the originals. Hero and entity names (Hanzo, Zarya, Reinhardt, Widowmaker) are kept — they are the point of the demo.

These are illustrations of the public contract, not captured output of a single run: the request is trimmed below what the working service actually consumes, the response shows a subset of real fields without the outer batch envelope, and the large nested `deterministic` and `review` payloads are omitted. [`examples/README.md`](../examples/README.md) states this in full.

A downstream entity-forwarding payload example was previously included and has been retired. The component that builds it sits outside this repository, and the example's vocabulary was not grounded in the detector source published here. The public demo now ends at the detector's own packaged contract.

### Documentation (`docs/`)

Public-facing architecture, contract, and sanitization notes only. Internal operational docs, deployment runbooks, checkpoint logs, and maintenance notes have been removed.
