/**
 * PostgreSQL normal-operation + fault-injection experiment (Phases 9-11).
 *
 * Boots a REAL PostgreSQL 18 server (embedded-postgres, no Docker) and drives the pg-backed
 * store (db/pg/pg-store.mjs) through normal operations and controlled failure scenarios,
 * including genuine PostgreSQL behaviours the SQLite prototype could not exercise:
 * real server stop/start, connection-pool exhaustion, deadlocks, serialization failures,
 * lock timeouts, constraint violations, and concurrent row-locked updates.
 *
 * Blockchain events are synthetic test fixtures (the workload); this experiment evaluates the
 * DATABASE layer's transaction, concurrency and recovery behaviour, not chain behaviour.
 * Output: results/postgres/raw/pg_faults_<ts>.json
 */
import EmbeddedPostgres from "embedded-postgres";
import { PgStore } from "../../db/pg/pg-store.mjs";
import fs from "fs"; import path from "path"; import os from "os";
import pg from "pg";

const PORT = 55433;
const CFG = { host: "127.0.0.1", port: PORT, user: "rs", password: "rs", database: "postgres" };
const OUT = path.join("results", "postgres", "raw");
const results = { experiment: "pg_normal_and_faults", timestamp: new Date().toISOString(),
  env: { pg: "PostgreSQL 18 (embedded-postgres)", os: `${os.type()} ${os.release()} ${os.arch()}`,
    cpu: os.cpus()[0].model, node: process.version, driver: "pg " + (pg.version || "8.x") }, scenarios: [] };
let n = 0;
let _t0 = Date.now();
const mark = () => { _t0 = Date.now(); };
const since = () => Date.now() - _t0;
function rec(o){ n++; results.scenarios.push({ no:n, ...o }); console.log(`  [${String(n).padStart(2,'0')}] ${o.pass?'PASS':'FAIL'}  ${o.name}${o.recoveryMs!=null?`  (rec=${o.recoveryMs}ms)`:''}`); }
const ev = (i, sig, pid, from, to, amt) => ({ txHash: `0x${i.toString(16).padStart(64,'0')}`, logIndex: 0, eventSig: sig, propertyId: pid, sender: from, receiver: to, amount: amt, blockNumber: i });
const A = "0xaaa", B = "0xbbb", C = "0xccc";

async function freshSchema(store){
  await store.query(`DROP TABLE IF EXISTS token_holdings, blockchain_events, sync_checkpoints, reconciliation_runs, dead_letter_queue, audit_log, properties, investors CASCADE`);
  await store.init();
}

async function main(){
  fs.mkdirSync(OUT, { recursive: true });
  // Clean any prior data dir so initialise() starts fresh; persistent:true so state survives stop/start.
  fs.rmSync("./db/pgdata_faults", { recursive: true, force: true });
  const epg = new EmbeddedPostgres({ databaseDir: "./db/pgdata_faults", user: "rs", password: "rs", port: PORT, persistent: true });
  await epg.initialise(); await epg.start();
  console.log("PostgreSQL started on", PORT);

  let store = new PgStore(CFG, { poolMax: 10 });
  await store.init();

  // ---------------- PHASE 9: NORMAL OPERATION ----------------
  await freshSchema(store);
  {
    let idc = 1;
    await store.applyEvent(ev(idc++, "FractionsMinted", 1, null, A, 100));
    const bal = await store.balanceOf(1, A);
    rec({ name: "Normal: mint event updates balance", expected: 100, actual: bal, pass: bal === 100 }); mark();
  }
  {
    await store.applyEvent(ev(1001, "TransferSingle", 1, A, B, 30));
    const okA = await store.balanceOf(1, A) === 70, okB = await store.balanceOf(1, B) === 30;
    rec({ name: "Normal: transfer updates sender+recipient atomically", pass: okA && okB, actual: `A=${await store.balanceOf(1,A)} B=${await store.balanceOf(1,B)}` }); mark();
  }
  {
    const r = await store.applyEvent(ev(1001, "TransferSingle", 1, A, B, 30)); // same tx/log
    rec({ name: "Normal: duplicate event ignored (idempotent)", pass: r.duplicate === true, actual: `duplicate=${r.duplicate}` }); mark();
  }
  {
    await store.setCheckpoint(500); const cp = await store.getCheckpoint();
    rec({ name: "Normal: checkpoint persists and resumes", pass: cp === 500, actual: cp }); mark();
  }
  {
    const truth = new Map([["1:0xaaa", 70], ["1:0xbbb", 30]]);
    const r = await store.reconcile(truth);
    rec({ name: "Normal: reconciliation confirms agreement", pass: r.mismatches === 0, actual: `mismatches=${r.mismatches}` }); mark();
  }
  {
    const a = (await store.query(`SELECT count(*)::int c FROM audit_log`)).rows[0].c; // audit via applyEvent? we log elsewhere
    await store.audit("test", "x");
    const a2 = (await store.query(`SELECT count(*)::int c FROM audit_log`)).rows[0].c;
    rec({ name: "Normal: audit log records entries", pass: a2 > a, actual: `audit rows ${a2}` }); mark();
  }

  // ---------------- PHASE 10B: TRANSACTION / CONSISTENCY FAULTS ----------------
  // Failure after partial statements before commit -> rollback, no partial state
  {
    await freshSchema(store);
    await store.applyEvent(ev(1, "FractionsMinted", 2, null, A, 50));
    let threw = false;
    try {
      await store.applyEvent(ev(2, "FractionsMinted", 2, null, A, 10), { failHook: async () => { throw new Error("injected mid-transaction failure"); } });
    } catch { threw = true; }
    const bal = await store.balanceOf(2, A);
    rec({ name: "Fault: failure mid-transaction rolls back (no partial write)", pass: threw && bal === 50, actual: `threw=${threw} bal=${bal}` , recoveryMs: since() }); mark();
  }
  // Explicit rollback leaves no trace
  {
    const c = await store.pool.connect();
    await c.query("BEGIN"); await c.query(`INSERT INTO properties(property_id,total_fractions) VALUES (999,100)`); await c.query("ROLLBACK"); c.release();
    const r = await store.query(`SELECT count(*)::int c FROM properties WHERE property_id=999`);
    rec({ name: "Fault: explicit ROLLBACK discards changes", pass: r.rows[0].c === 0, actual: `rows=${r.rows[0].c}` , recoveryMs: since() }); mark();
  }
  // Unique-constraint violation on direct duplicate insert (bypassing ON CONFLICT) is caught
  {
    let caught = false;
    const e = ev(7777, "FractionsMinted", 3, null, A, 5);
    await store.applyEvent(e);
    try { await store.query(`INSERT INTO blockchain_events(chain_id,contract,tx_hash,block_number,log_index,event_sig) VALUES (1,'0x',$1,1,$2,'x')`, [e.txHash, e.logIndex]); }
    catch (err) { caught = err.code === "23505"; }
    rec({ name: "Fault: UNIQUE constraint violation raised (23505)", pass: caught, actual: `caught=${caught}` , recoveryMs: since() }); mark();
  }
  // Deadlock: two transactions lock rows in opposite order
  {
    await freshSchema(store);
    await store.applyEvent(ev(1, "FractionsMinted", 4, null, A, 100));
    await store.applyEvent(ev(2, "FractionsMinted", 4, null, B, 100));
    const c1 = await store.pool.connect(), c2 = await store.pool.connect();
    let deadlockSeen = false;
    try {
      await c1.query("BEGIN"); await c2.query("BEGIN");
      await c1.query(`SELECT balance FROM token_holdings WHERE property_id=4 AND wallet=$1 FOR UPDATE`, [A]);
      await c2.query(`SELECT balance FROM token_holdings WHERE property_id=4 AND wallet=$1 FOR UPDATE`, [B]);
      const p1 = c1.query(`SELECT balance FROM token_holdings WHERE property_id=4 AND wallet=$1 FOR UPDATE`, [B]).catch(e => { if (e.code === "40P01") deadlockSeen = true; });
      const p2 = c2.query(`SELECT balance FROM token_holdings WHERE property_id=4 AND wallet=$1 FOR UPDATE`, [A]).catch(e => { if (e.code === "40P01") deadlockSeen = true; });
      await Promise.allSettled([p1, p2]);
    } finally { try{await c1.query("ROLLBACK");}catch{} try{await c2.query("ROLLBACK");}catch{} c1.release(); c2.release(); }
    rec({ name: "Fault: deadlock detected by PostgreSQL (40P01)", pass: deadlockSeen, actual: `deadlock=${deadlockSeen}` , recoveryMs: since() }); mark();
  }
  // Lock timeout: hold a row lock, second txn with short lock_timeout fails
  {
    const c1 = await store.pool.connect(), c2 = await store.pool.connect();
    let timedOut = false;
    try {
      await c1.query("BEGIN"); await c1.query(`SELECT balance FROM token_holdings WHERE property_id=4 AND wallet=$1 FOR UPDATE`, [A]);
      await c2.query("BEGIN"); await c2.query("SET lock_timeout = '300ms'");
      try { await c2.query(`SELECT balance FROM token_holdings WHERE property_id=4 AND wallet=$1 FOR UPDATE`, [A]); }
      catch (e) { timedOut = e.code === "55P03"; }
    } finally { try{await c1.query("ROLLBACK");}catch{} try{await c2.query("ROLLBACK");}catch{} c1.release(); c2.release(); }
    rec({ name: "Fault: lock timeout raised (55P03)", pass: timedOut, actual: `timedOut=${timedOut}` , recoveryMs: since() }); mark();
  }
  // Concurrent updates to same holding under row locking -> correct final balance
  {
    await freshSchema(store);
    await store.applyEvent(ev(1, "FractionsMinted", 5, null, A, 0));
    const K = 50;
    const evs = Array.from({ length: K }, (_, i) => ev(2000 + i, "FractionsMinted", 5, null, A, 1));
    await Promise.all(evs.map(e => store.applyEvent(e)));
    const bal = await store.balanceOf(5, A);
    rec({ name: "Fault: 50 concurrent credits to one holding are serialised correctly", pass: bal === K, actual: `bal=${bal} (expect ${K})` , recoveryMs: since() }); mark();
  }
  // Worker crash AFTER commit but before ack -> retry sees duplicate, no double-apply
  {
    await freshSchema(store);
    const e = ev(3001, "FractionsMinted", 6, null, A, 40);
    await store.applyEvent(e);                 // committed
    const r = await store.applyEvent(e);       // "retry after crash" -> duplicate
    const bal = await store.balanceOf(6, A);
    rec({ name: "Fault: crash-after-commit retry does not double-apply", pass: r.duplicate && bal === 40, actual: `dup=${r.duplicate} bal=${bal}` }); mark();
  }

  // ---------------- PHASE 10A: CONNECTION / SERVER FAULTS (REAL) ----------------
  // Pool exhaustion: poolMax=2, hold both, third connect times out
  {
    const small = new PgStore(CFG, { poolMax: 2, connTimeoutMs: 800 });
    await small.init();
    const c1 = await small.pool.connect(), c2 = await small.pool.connect();
    let exhausted = false;
    try { await small.pool.connect(); } catch { exhausted = true; }
    c1.release(); c2.release(); await small.end();
    rec({ name: "Fault: connection-pool exhaustion (acquire times out)", pass: exhausted, actual: `exhausted=${exhausted}` , recoveryMs: since() }); mark();
  }
  // Connection timeout to a dead port
  {
    const dead = new pg.Pool({ host: "127.0.0.1", port: 59999, user: "rs", password: "rs", connectionTimeoutMillis: 800 });
    let failed = false;
    try { await dead.query("select 1"); } catch { failed = true; }
    await dead.end().catch(()=>{});
    rec({ name: "Fault: connection to unavailable server fails cleanly", pass: failed, actual: `failed=${failed}` }); mark();
  }
  // REAL server stop during processing -> error; restart -> recover from durable state
  {
    await freshSchema(store);
    await store.applyEvent(ev(1, "FractionsMinted", 7, null, A, 25));
    await store.end();                          // release pool before stopping server
    const t0 = Date.now();
    await epg.stop();                           // REAL PostgreSQL server stop
    // attempt during outage
    const down = new PgStore(CFG, { connTimeoutMs: 800 });
    let downErr = false;
    try { await down.query("select 1"); } catch { downErr = true; }
    await down.end().catch(()=>{});
    await epg.start();                          // REAL restart
    store = new PgStore(CFG, { poolMax: 10 }); await store.init();
    const bal = await store.balanceOf(7, A);    // durable state survived
    rec({ name: "Fault: REAL PostgreSQL server stop/start; state durable, resumes", emulated: false,
      pass: downErr && bal === 25, actual: `downErr=${downErr} balAfterRestart=${bal}`, recoveryMs: Date.now() - t0 }); mark();
  }

  // ---------------- PHASE 10D: RECOVERY ----------------
  // Dead-letter after permanent failure, then manual replay
  {
    await freshSchema(store);
    const e = ev(4001, "FractionsMinted", 8, null, A, 15);
    // simulate permanent failure: applyEvent with failHook that always throws, maxRetries small
    const s2 = new PgStore(CFG, { poolMax: 5, maxRetries: 2 });
    await s2.init();
    let failed = false;
    try { await s2.applyEvent(e, { failHook: async () => { const err = new Error("perm"); err.code = "XXXXX"; throw err; } }); } catch { failed = true; }
    if (failed) await s2.deadLetter(e, "permanent failure");
    const dlq = (await s2.query(`SELECT count(*)::int c FROM dead_letter_queue`)).rows[0].c;
    // manual replay
    const r = await s2.applyEvent(e);
    const bal = await s2.balanceOf(8, A);
    await s2.end();
    rec({ name: "Recovery: dead-letter then manual replay applies once", pass: dlq >= 1 && r.applied && bal === 15, actual: `dlq=${dlq} bal=${bal}` , recoveryMs: since() }); mark();
  }
  // Reconciliation detects and repairs an incorrect balance
  {
    await freshSchema(store);
    await store.applyEvent(ev(1, "FractionsMinted", 9, null, A, 100));
    await store.query(`UPDATE token_holdings SET balance=999 WHERE property_id=9 AND wallet=$1`, [A]); // corruption
    const truth = new Map([["9:0xaaa", 100]]);
    const before = await store.reconcile(truth, { repair: false });
    const after = await store.reconcile(truth, { repair: true });
    const post = await store.reconcile(truth, { repair: false });
    const bal = await store.balanceOf(9, A);
    rec({ name: "Recovery: reconciliation detects + repairs corruption", pass: before.mismatches === 1 && after.repaired === 1 && post.mismatches === 0 && bal === 100,
      actual: `detected=${before.mismatches} repaired=${after.repaired} residual=${post.mismatches} bal=${bal}` , recoveryMs: since() }); mark();
  }
  // Multiple listeners process same event -> idempotency (concurrent duplicate insert)
  {
    await freshSchema(store);
    const e = ev(5001, "FractionsMinted", 10, null, A, 60);
    const rs = await Promise.all([store.applyEvent(e), store.applyEvent(e), store.applyEvent(e)]);
    const applied = rs.filter(r => r.applied).length;
    const bal = await store.balanceOf(10, A);
    rec({ name: "Recovery: 3 concurrent listeners apply the event exactly once", pass: applied === 1 && bal === 60, actual: `applied=${applied} bal=${bal}` , recoveryMs: since() }); mark();
  }

  await store.end();
  await epg.stop();

  // ---------------- AGGREGATE ----------------
  const S = results.scenarios, pass = S.filter(s => s.pass).length;
  const recs = S.filter(s => typeof s.recoveryMs === "number").map(s => s.recoveryMs);
  results.metrics = { scenarios: S.length, passed: pass, failed: S.length - pass,
    processingSuccessRate: +(pass / S.length).toFixed(4),
    meanRecoveryMs: recs.length ? +(recs.reduce((a,b)=>a+b,0)/recs.length).toFixed(0) : null };
  const out = path.join(OUT, `pg_faults_${Date.now()}.json`);
  fs.writeFileSync(out, JSON.stringify(results, null, 2));
  console.log(`\n${pass}/${S.length} PostgreSQL scenarios passed. Wrote ${out}`);
  if (pass !== S.length) process.exitCode = 2;
}
main().catch(e => { console.error(e); process.exit(1); });
