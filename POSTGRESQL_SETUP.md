# PostgreSQL Setup and Reproduction

The thesis PostgreSQL experiments (Exp 16–17) ran against a **real PostgreSQL 18 server** started
by `embedded-postgres` (a genuine PostgreSQL binary, no Docker or admin rights required). This
document explains how to reproduce the experiments and how to deploy the same schema on a
standalone PostgreSQL.

## Option A — reproduce exactly (embedded-postgres, no Docker)

```bash
npm install                       # installs embedded-postgres + pg
node scripts/experiments/exp_pg_faults.mjs         # normal ops + 19 fault scenarios
PG_CONC_REPS=2 node scripts/experiments/exp_pg_concurrency.mjs   # 15-cell isolation matrix
```

- `embedded-postgres` downloads and runs PostgreSQL 18.4 on `127.0.0.1:55433/55434`.
- Data dirs `db/pgdata_faults` / `db/pgdata_conc` are created fresh each run (`persistent: true`,
  cleaned at start) so the server stop/start test has durable state.
- Raw results: `results/postgres/raw/pg_faults_*.json`, `pg_concurrency_*.json`.

## Option B — standalone PostgreSQL (Docker Compose)

```bash
cp .env.example .env              # set PGPASSWORD, PGUSER, PGDATABASE (never commit .env)
docker compose up -d postgres     # PostgreSQL 18 with migrations auto-applied
psql "$DATABASE_URL" -f database/migrations/001_init.sql   # if not auto-applied
```

`docker-compose.yml` starts PostgreSQL 18 with `default_transaction_isolation=read committed`
(the isolation level the concurrency matrix identifies as optimal for the balance-update
workload) and mounts `database/migrations/`.

## Environment recorded in each raw file
PostgreSQL 18.4; `pg` driver; Node 18.14; Windows 11 x64; Intel i7-1165G7. Pool `max` set per
experiment; `connectionTimeoutMillis` and `statement_timeout` documented in `db/pg/pg-store.mjs`.

## Configuration used
- Pool: `max` = 10 (faults) / `workers+2` (concurrency); `connectionTimeoutMillis` 800–3000 ms;
  `statement_timeout` 8000 ms.
- Isolation: `READ COMMITTED` (default/recommended), also tested at `REPEATABLE READ` and
  `SERIALIZABLE`.
- Retry: up to 30 attempts with linear+jitter backoff on `40001`/`40P01`/`55P03`.

## Secrets
`.env` is gitignored; only `.env.example` is committed. No passwords, keys, or RPC secrets are in
the repository.

## Not covered (future work)
Streaming replication / high-availability cluster; `pg_basebackup` backup-and-restore of a live
cluster; PgBouncer external pooling; production monitoring.
