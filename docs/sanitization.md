# Sanitization Notes

This is a sanitized portfolio version of a private production service. The sections below describe what has been omitted or replaced and what remains.

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

### Example files (`examples/`)

Four sanitized JSON files derived from real workflow runs. Post IDs, usernames, and comment text have been replaced with invented demo values and placeholder identifiers (`demo_post_N`, `demo_user_N`). Titles and bodies are invented demo text inspired by the general subject matter of the originals. Hero and entity names (Hanzo, Zarya, Reinhardt, Widowmaker) are kept — they are the point of the demo.

### Documentation (`docs/`)

Public-facing architecture, contract, and sanitization notes only. Internal operational docs, deployment runbooks, checkpoint logs, and maintenance notes have been removed.
