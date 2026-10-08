/**
 * PostgreSQL concurrency + isolation experiment (Phase 12).
 *
 * Drives concurrent event-application workers against a REAL PostgreSQL 18 server, at
 * concurrency levels 1/2/5/10/25 and across READ COMMITTED / REPEATABLE READ / SERIALIZABLE,
 * all crediting the SAME holding to force row-lock contention. Measures throughput, retries,
 * serialization/deadlock failures handled, and final-state consistency.
 *
 * Output: results/postgres/raw/pg_concurrency_<ts>.json
 */
import EmbeddedPostgres from "embedded-postgres";
import { PgStore } from "../../db/pg/pg-store.mjs";
import fs from "fs"; import path from "path"; import os from "os";

const PORT = 55434;
const CFG = { host: "127.0.0.1", port: PORT, user: "rs", password: "rs", database: "postgres" };
const OUT = path.join("results", "postgres", "raw");
const ISOLATIONS = ["READ COMMITTED", "REPEATABLE READ", "SERIALIZABLE"];
const LEVELS = [1, 2, 5, 10, 25];
const PER_WORKER = 20;          // credits per worker (each +1 to the same holding)
const REPS = parseInt(process.env.PG_CONC_REPS || "3", 10);

async function freshSchema(store) {
  await store.query(`DROP TABLE IF EXISTS token_holdings, blockchain_events, sync_checkpoints, reconciliation_runs, dead_letter_queue, audit_log, properties, investors CASCADE`);
  await store.init();
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  fs.rmSync("./db/pgdata_conc", { recursive: true, force: true });
  const epg = new EmbeddedPostgres({ databaseDir: "./db/pgdata_conc", user: "rs", password: "rs", port: PORT, persistent: true });
  await epg.initialise(); await epg.start();
  console.log("PostgreSQL started on", PORT);

  const results = { experiment: "pg_concurrency", timestamp: new Date().toISOString(),
    env: { pg: "PostgreSQL 18 (embedded-postgres)", cpu: os.cpus()[0].model, cores: os.cpus().length, node: process.version },
    perWorkerCredits: PER_WORKER, reps: REPS, matrix: [] };

  for (const iso of ISOLATIONS) {
    for (const W of LEVELS) {
      const tputRuns = [], retryRuns = [], serRuns = [], dlRuns = []; let consistentAll = true;
      let terminalFailures = 0;
      for (let r = 0; r < REPS; r++) {
        const store = new PgStore(CFG, { poolMax: Math.max(4, W + 2), isolation: iso, maxRetries: 30 });
        await freshSchema(store);
        // seed the single contended holding
        await store.applyEvent({ txHash: "0x" + "0".repeat(63) + "1", logIndex: 0, eventSig: "FractionsMinted", propertyId: 1, receiver: "0xhot", amount: 0, blockNumber: 0 });
        const total = W * PER_WORKER;
        // build all events (unique tx hashes), all crediting the same holding
        const evs = Array.from({ length: total }, (_, i) => ({ txHash: "0x" + (i + 100).toString(16).padStart(63, "0") + "a", logIndex: 0, eventSig: "FractionsMinted", propertyId: 1, receiver: "0xhot", amount: 1, blockNumber: i + 1 }));
        // launch W concurrent workers, each taking a slice
        const t0 = Date.now();
        const workers = [];
        for (let w = 0; w < W; w++) {
          workers.push((async () => { for (let i = w; i < total; i += W) { try { await store.applyEvent(evs[i]); } catch { terminalFailures++; } } })());
        }
        await Promise.all(workers);
        const elapsed = Date.now() - t0;
        const bal = await store.balanceOf(1, "0xhot");
        const consistent = bal === total;
        if (!consistent) consistentAll = false;
        tputRuns.push(+(total / (elapsed / 1000)).toFixed(1));
        retryRuns.push(store.stats.retries);
        serRuns.push(store.stats.serializationRetries);
        dlRuns.push(store.stats.deadlockRetries);
        await store.end();
      }
      const avg = a => +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(1);
      const row = { isolation: iso, workers: W, totalEvents: W * PER_WORKER,
        throughputMean: avg(tputRuns), retriesMean: avg(retryRuns), serializationRetriesMean: avg(serRuns),
        deadlockRetriesMean: avg(dlRuns), terminalFailures, consistent: consistentAll };
      results.matrix.push(row);
      console.log(`  ${iso.padEnd(16)} W=${String(W).padStart(2)}  tput=${row.throughputMean}/s  retries=${row.retriesMean} (ser=${row.serializationRetriesMean} dl=${row.deadlockRetriesMean})  termFail=${terminalFailures}  consistent=${row.consistent}`);
    }
  }

  await epg.stop();
  const out = path.join(OUT, `pg_concurrency_${Date.now()}.json`);
  fs.writeFileSync(out, JSON.stringify(results, null, 2));
  const allConsistent = results.matrix.every(r => r.consistent);
  console.log(`\nAll cells consistent: ${allConsistent}. Wrote ${out}`);
  if (!allConsistent) process.exitCode = 2;
}
main().catch(e => { console.error(e); process.exit(1); });
