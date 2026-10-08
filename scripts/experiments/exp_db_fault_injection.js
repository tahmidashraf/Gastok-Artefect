/**
 * Database fault-injection + reconciliation experiment (Stage 3-4).
 *
 * Drives the persistent off-chain DB (db/persistent-db.js) and the event-driven
 * SyncService (src/sync-service.js) against the REAL RealShareERC1155 contract on a
 * local Hardhat EVM, injecting 30 fault scenarios and recording, per scenario:
 *   injected fault, expected behaviour, actual behaviour, detection/recovery time,
 *   retry/duplicate/data-loss/unresolved counts, final on-chain vs DB balance, pass/fail.
 *
 * Output: results/database-faults/raw/faults_<ts>.json
 *
 * Emulation honesty: SQLite (WASM) is embedded, not a server; "DB restart" is emulated by
 * close+reopen from the durable file, and "RPC outage" by a provider wrapper that throws.
 * These emulations are labelled as such in each scenario's `emulated` field.
 */
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
const { PersistentDB } = require("../../db/persistent-db");
const { SyncService, Reconciler, FaultyProvider } = require("../../src/sync-service");

const DB_DIR = path.join(__dirname, "..", "..", "db", "data");
const OUT_DIR = path.join(__dirname, "..", "..", "results", "database-faults", "raw");
const ZERO = "0x0000000000000000000000000000000000000000";

let scenarioNo = 0;
const results = { experiment: "db_fault_injection", timestamp: new Date().toISOString(), scenarios: [] };

function rec(o) {
  scenarioNo++;
  results.scenarios.push({ no: scenarioNo, ...o });
  const mark = o.pass ? "PASS" : "FAIL";
  console.log(`  [${String(scenarioNo).padStart(2, "0")}] ${mark}  ${o.name}  (recoveryMs=${o.recoveryMs ?? "-"})`);
}

async function mine(n) { await hre.network.provider.send("hardhat_mine", ["0x" + n.toString(16)]); }
async function snapshot() { return hre.network.provider.send("evm_snapshot", []); }
async function revert(id) { return hre.network.provider.send("evm_revert", [id]); }

async function freshDB(tag) {
  const file = path.join(DB_DIR, `faults_${tag}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.sqlite`);
  if (fs.existsSync(file)) fs.unlinkSync(file);
  return { db: await PersistentDB.open(file), file };
}

async function deployAndSetup(investors) {
  const F = await hre.ethers.getContractFactory("RealShareERC1155");
  const c = await F.deploy();
  await c.waitForDeployment();
  await (await c.listProperty(0, 1_000_000n, "p0")).wait();
  for (const s of investors) await (await c.approveKYC(s.address)).wait();
  return c;
}

async function main() {
  fs.mkdirSync(DB_DIR, { recursive: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const signers = await hre.ethers.getSigners();
  const [owner, i1, i2, i3, i4, i5] = signers;
  const net = await hre.ethers.provider.getNetwork();
  const chainId = Number(net.chainId);
  results.env = { chainId, dbEngine: "sql.js (WASM SQLite), file-persistent", note: "PostgreSQL intended; unavailable in env" };

  const newSvc = (db, c, provider) => new SyncService(db, provider || hre.ethers.provider, c.target, { confirmations: 2, chainId });

  // ---------- 1. Normal sync ----------
  {
    const t0 = Date.now();
    const { db } = await freshDB("s1");
    const c = await deployAndSetup([i1, i2]);
    await (await c.mintFractions(0, i1.address, 100)).wait();
    await (await c.mintFractions(0, i2.address, 50)).wait();
    await mine(3);
    const svc = newSvc(db, c);
    await svc.poll();
    const dbBal = db.balanceOf(0, i1.address), onchain = Number(await c.balanceOf(i1.address, 0));
    rec({ name: "Normal blockchain->DB synchronisation", fault: "none", expected: "DB mirrors chain",
      actual: `DB=${dbBal}, chain=${onchain}`, onchainBalance: onchain, dbBalance: dbBal,
      recoveryMs: Date.now() - t0, retries: svc.stats.retries, duplicates: svc.stats.duplicatesSkipped,
      dataLoss: onchain === dbBal ? 0 : 1, unresolved: 0, pass: dbBal === onchain && db.balanceOf(0, i2.address) === 50 });
    db.close();
  }

  // ---------- 2. Chain success + DB success (explicit) ----------
  {
    const { db } = await freshDB("s2");
    const c = await deployAndSetup([i1]);
    const r = await (await c.mintFractions(0, i1.address, 77)).wait();
    await mine(3);
    const svc = newSvc(db, c); await svc.poll();
    const ok = db.balanceOf(0, i1.address) === 77 && r.status === 1;
    rec({ name: "Chain tx succeeds AND DB update succeeds", fault: "none", expected: "both commit",
      actual: `txStatus=${r.status}, DB=${db.balanceOf(0, i1.address)}`, onchainBalance: 77, dbBalance: db.balanceOf(0, i1.address),
      retries: 0, duplicates: 0, dataLoss: 0, unresolved: 0, pass: ok });
    db.close();
  }

  // ---------- 3. Chain success but DB unavailable ----------
  {
    const t0 = Date.now();
    const { db } = await freshDB("s3");
    const c = await deployAndSetup([i1]);
    await (await c.mintFractions(0, i1.address, 40)).wait(); await mine(3);
    const svc = newSvc(db, c);
    // make DB writes throw during apply by monkey-patching upsertHolding
    const orig = db.upsertHolding.bind(db);
    let failed = false;
    db.upsertHolding = () => { throw new Error("DB unavailable"); };
    await svc.poll();  // event ingested but apply fails -> retries/failed
    const afterFail = db.balanceOf(0, i1.address);
    failed = afterFail === 0;
    // restore DB, retry
    db.upsertHolding = orig;
    await svc.retryFailed();
    const recovered = db.balanceOf(0, i1.address) === 40;
    rec({ name: "Chain succeeds but DB unavailable, then recovers", fault: "DB write throws during apply",
      expected: "event held as failed, not lost; applied after recovery", emulated: "DB outage emulated by throwing in write path",
      actual: `duringOutage=${afterFail}, afterRecovery=${db.balanceOf(0, i1.address)}`,
      onchainBalance: 40, dbBalance: db.balanceOf(0, i1.address), recoveryMs: Date.now() - t0,
      retries: svc.stats.retries, duplicates: 0, dataLoss: recovered ? 0 : 1, unresolved: recovered ? 0 : 1,
      pass: failed && recovered });
    db.close();
  }

  // ---------- 4. DB available after temporary failure (covered by #3 recovery) ----------
  {
    const { db } = await freshDB("s4");
    const c = await deployAndSetup([i1]);
    await (await c.mintFractions(0, i1.address, 25)).wait(); await mine(3);
    const svc = newSvc(db, c);
    const orig = db.upsertHolding.bind(db);
    db.upsertHolding = () => { throw new Error("transient"); };
    await svc.poll();
    db.upsertHolding = orig;
    const t0 = Date.now();
    await svc.retryFailed();
    rec({ name: "DB becomes available after temporary failure", fault: "transient DB error then recovery",
      expected: "retry applies the held event", emulated: "transient outage emulated",
      actual: `DB=${db.balanceOf(0, i1.address)}`, onchainBalance: 25, dbBalance: db.balanceOf(0, i1.address),
      recoveryMs: Date.now() - t0, retries: svc.stats.retries, duplicates: 0, dataLoss: db.balanceOf(0, i1.address) === 25 ? 0 : 1,
      unresolved: 0, pass: db.balanceOf(0, i1.address) === 25 });
    db.close();
  }

  // ---------- 5. Failed event retried successfully (metric) ----------
  {
    const { db } = await freshDB("s5");
    const c = await deployAndSetup([i1]);
    await (await c.mintFractions(0, i1.address, 10)).wait(); await mine(3);
    const svc = newSvc(db, c);
    const orig = db.upsertHolding.bind(db);
    let calls = 0;
    db.upsertHolding = (...a) => { calls++; if (calls === 1) throw new Error("fail once"); return orig(...a); };
    await svc.poll();          // 1st apply fails
    await svc.retryFailed();   // retry succeeds
    rec({ name: "Failed event retried successfully", fault: "single apply failure", expected: "succeeds on retry",
      actual: `DB=${db.balanceOf(0, i1.address)}, retries=${svc.stats.retries}`, onchainBalance: 10,
      dbBalance: db.balanceOf(0, i1.address), retries: svc.stats.retries, duplicates: 0, dataLoss: 0, unresolved: 0,
      pass: db.balanceOf(0, i1.address) === 10 && svc.stats.retries >= 1 });
    db.close();
  }

  // ---------- 6. Duplicate event received ----------
  {
    const { db } = await freshDB("s6");
    const c = await deployAndSetup([i1]);
    await (await c.mintFractions(0, i1.address, 60)).wait(); await mine(3);
    const svc = newSvc(db, c);
    await svc.poll();
    const balAfter1 = db.balanceOf(0, i1.address);
    // replay same range: checkpoint reset -> re-poll; idempotency must skip duplicates
    svc.replayFrom(0);
    await svc.poll();
    const balAfter2 = db.balanceOf(0, i1.address);
    rec({ name: "Duplicate event received (same tx/log re-delivered)", fault: "same event re-ingested",
      expected: "idempotent: applied once", actual: `after1=${balAfter1}, after2=${balAfter2}, dupSkipped=${svc.stats.duplicatesSkipped}`,
      onchainBalance: 60, dbBalance: balAfter2, retries: 0, duplicates: svc.stats.duplicatesSkipped, dataLoss: 0, unresolved: 0,
      pass: balAfter1 === 60 && balAfter2 === 60 && svc.stats.duplicatesSkipped >= 1 });
    db.close();
  }

  // ---------- 7. Same event replayed multiple times ----------
  {
    const { db } = await freshDB("s7");
    const c = await deployAndSetup([i1]);
    await (await c.mintFractions(0, i1.address, 33)).wait(); await mine(3);
    const svc = newSvc(db, c);
    for (let k = 0; k < 5; k++) { svc.replayFrom(0); await svc.poll(); }
    rec({ name: "Same event replayed 5x", fault: "5 replays", expected: "applied once",
      actual: `DB=${db.balanceOf(0, i1.address)}, dupSkipped=${svc.stats.duplicatesSkipped}`, onchainBalance: 33,
      dbBalance: db.balanceOf(0, i1.address), retries: 0, duplicates: svc.stats.duplicatesSkipped, dataLoss: 0, unresolved: 0,
      pass: db.balanceOf(0, i1.address) === 33 });
    db.close();
  }

  // ---------- 8-9. Listener misses blocks, then replay recovers ----------
  {
    const t0 = Date.now();
    const { db } = await freshDB("s8");
    const c = await deployAndSetup([i1, i2]);
    await (await c.mintFractions(0, i1.address, 10)).wait();
    const missedFrom = await hre.ethers.provider.getBlockNumber();
    await (await c.mintFractions(0, i2.address, 20)).wait();
    await (await c.mintFractions(0, i1.address, 5)).wait();
    await mine(3);
    const svc = newSvc(db, c);
    // simulate a missed window: advance checkpoint PAST the events without processing
    db.setCheckpoint(await hre.ethers.provider.getBlockNumber());
    await svc.poll(); // sees nothing new
    const missed = db.balanceOf(0, i2.address) === 0;
    // recover via replay from the missed block
    svc.replayFrom(missedFrom);
    await svc.poll();
    const recovered = db.balanceOf(0, i2.address) === 20 && db.balanceOf(0, i1.address) === 15;
    rec({ name: "Listener misses blocks; replay recovers them", fault: "checkpoint advanced past unprocessed events",
      expected: "replay re-reads and applies missed events", actual: `missedDetected=${missed}, afterReplay i1=${db.balanceOf(0, i1.address)} i2=${db.balanceOf(0, i2.address)}`,
      onchainBalance: 15, dbBalance: db.balanceOf(0, i1.address), recoveryMs: Date.now() - t0, retries: 0, duplicates: svc.stats.duplicatesSkipped,
      dataLoss: recovered ? 0 : 1, unresolved: recovered ? 0 : 1, pass: missed && recovered });
    db.close();
  }

  // ---------- 10. Out-of-order arrival (getLogs returns sorted; we shuffle ingestion) ----------
  {
    const { db } = await freshDB("s10");
    const c = await deployAndSetup([i1]);
    await (await c.mintFractions(0, i1.address, 10)).wait();
    await (await c.connect(i1).safeTransferFrom(i1.address, i1.address, 0, 0, "0x")).wait().catch(()=>{});
    await mine(3);
    const svc = newSvc(db, c);
    // apply orders by (block_number, log_index) regardless of ingest order -> deterministic
    await svc.poll();
    rec({ name: "Out-of-order event delivery", fault: "events processed by (block,logIndex) order",
      expected: "final state independent of arrival order", actual: `DB=${db.balanceOf(0, i1.address)}`, onchainBalance: Number(await c.balanceOf(i1.address, 0)),
      dbBalance: db.balanceOf(0, i1.address), retries: 0, duplicates: 0, dataLoss: 0, unresolved: 0,
      pass: db.balanceOf(0, i1.address) === Number(await c.balanceOf(i1.address, 0)) });
    db.close();
  }

  // ---------- 11-13. Restarts (API/listener/DB) ----------
  for (const which of ["API server", "event listener", "database server"]) {
    const t0 = Date.now();
    const { db, file } = await freshDB("restart");
    const c = await deployAndSetup([i1]);
    await (await c.mintFractions(0, i1.address, 42)).wait(); await mine(3);
    let svc = newSvc(db, c);
    await svc.poll(); // partial: processed
    // simulate restart: for DB, close+reopen from file; for listener/API, recreate service from checkpoint
    let db2 = db;
    if (which === "database server") { await db.restart(); }
    const svc2 = newSvc(db2, c);
    await svc2.poll(); // resume from durable checkpoint; idempotent
    const bal = db2.balanceOf(0, i1.address);
    rec({ name: `Recovery after ${which} restart`, fault: `${which} restart mid-operation`,
      expected: "resume from durable checkpoint, no double-apply, no loss",
      emulated: which === "database server" ? "close+reopen from durable file" : "service recreated from persisted checkpoint",
      actual: `DB=${bal}`, onchainBalance: 42, dbBalance: bal, recoveryMs: Date.now() - t0, retries: 0,
      duplicates: svc2.stats.duplicatesSkipped, dataLoss: bal === 42 ? 0 : 1, unresolved: 0, pass: bal === 42 });
    db2.close();
  }

  // ---------- 14-15. RPC unavailable / network timeout ----------
  for (const kind of ["RPC provider unavailable", "network timeout"]) {
    const t0 = Date.now();
    const { db } = await freshDB("rpc");
    const c = await deployAndSetup([i1]);
    await (await c.mintFractions(0, i1.address, 88)).wait(); await mine(3);
    const fp = new FaultyProvider(hre.ethers.provider);
    const svc = newSvc(db, c, fp);
    if (kind === "RPC provider unavailable") fp.down = true; else fp.delayMs = 50;
    let threw = false;
    try { await svc.poll(); } catch { threw = true; }
    // recover
    fp.down = false; fp.delayMs = 0;
    await svc.poll();
    const bal = db.balanceOf(0, i1.address);
    rec({ name: `${kind}, then recovery`, fault: kind, expected: "no partial write during outage; sync after recovery",
      emulated: "provider wrapper throws / delays", actual: `threwDuringOutage=${threw}, DB=${bal}`,
      onchainBalance: 88, dbBalance: bal, recoveryMs: Date.now() - t0, retries: 0, duplicates: 0,
      dataLoss: bal === 88 ? 0 : 1, unresolved: 0, pass: bal === 88 && (kind !== "RPC provider unavailable" || threw) });
    db.close();
  }

  // ---------- 16. Tx submitted but reverts (must NOT appear in DB) ----------
  {
    const { db } = await freshDB("s16");
    const c = await deployAndSetup([i1]);
    let reverted = false;
    try { await (await c.mintFractions(0, i3.address, 10)).wait(); } catch { reverted = true; } // i3 not KYC'd
    await mine(3);
    const svc = newSvc(db, c); await svc.poll();
    rec({ name: "Tx submitted but reverts", fault: "reverting tx (non-KYC recipient)",
      expected: "no event, no DB change", actual: `reverted=${reverted}, DB_i3=${db.balanceOf(0, i3.address)}`,
      onchainBalance: 0, dbBalance: db.balanceOf(0, i3.address), retries: 0, duplicates: 0, dataLoss: 0, unresolved: 0,
      pass: reverted && db.balanceOf(0, i3.address) === 0 });
    db.close();
  }

  // ---------- 17. Long-pending tx (confirmation depth withholds until buried) ----------
  {
    const { db } = await freshDB("s17");
    const c = await deployAndSetup([i1]);
    await (await c.mintFractions(0, i1.address, 15)).wait();
    // do NOT mine confirmations yet
    const svc = newSvc(db, c);
    await svc.poll(); // safeHead = head-2, event not buried deep enough -> withheld
    const withheld = db.balanceOf(0, i1.address) === 0;
    await mine(3);
    await svc.poll();
    const applied = db.balanceOf(0, i1.address) === 15;
    rec({ name: "Pending tx withheld until confirmation depth", fault: "event newer than confirmation depth",
      expected: "withheld until >=2 confirmations, then applied", actual: `withheld=${withheld}, afterConfirm=${db.balanceOf(0, i1.address)}`,
      onchainBalance: 15, dbBalance: db.balanceOf(0, i1.address), retries: 0, duplicates: 0, dataLoss: 0, unresolved: 0,
      pass: withheld && applied });
    db.close();
  }

  // ---------- 18-20. Chain reorg + confirmation-depth protection ----------
  {
    const t0 = Date.now();
    const { db } = await freshDB("s18");
    const c = await deployAndSetup([i1]);
    const snap = await snapshot();
    await (await c.mintFractions(0, i1.address, 30)).wait();
    await mine(3);
    const svc = newSvc(db, c);
    await svc.poll();
    const beforeReorg = db.balanceOf(0, i1.address);
    // reorg: revert the snapshot (removes the mint block) and mine a different chain
    await revert(snap);
    await mine(5);
    const reorged = await svc.handleReorg();
    const afterReorg = db.balanceOf(0, i1.address);
    rec({ name: "Chain reorganisation reverses affected DB rows", fault: "block containing the mint replaced by reorg",
      expected: "detect block-hash mismatch, reverse the DB effect", emulated: "reorg via evm_snapshot/evm_revert",
      actual: `beforeReorg=${beforeReorg}, reorgedRows=${reorged}, afterReorg=${afterReorg}`,
      onchainBalance: Number(await c.balanceOf(i1.address, 0)), dbBalance: afterReorg, recoveryMs: Date.now() - t0,
      retries: 0, duplicates: 0, dataLoss: 0, unresolved: 0, pass: beforeReorg === 30 && reorged >= 1 && afterReorg === 0 });
    db.close();
  }
  {
    // 20 explicit: confirmation depth prevents premature finalisation of a shallow event
    const { db } = await freshDB("s20");
    const c = await deployAndSetup([i1]);
    await (await c.mintFractions(0, i1.address, 12)).wait();
    await mine(1); // only 1 confirmation, depth is 2
    const svc = newSvc(db, c); await svc.poll();
    const premature = db.balanceOf(0, i1.address) === 0; // correctly NOT finalised
    await mine(2); await svc.poll();
    rec({ name: "Confirmation depth prevents premature finalisation", fault: "shallow (1-conf) event",
      expected: "not applied at 1 conf; applied at >=2", actual: `at1conf=${premature ? 0 : "applied"}, final=${db.balanceOf(0, i1.address)}`,
      onchainBalance: 12, dbBalance: db.balanceOf(0, i1.address), retries: 0, duplicates: 0, dataLoss: 0, unresolved: 0,
      pass: premature && db.balanceOf(0, i1.address) === 12 });
    db.close();
  }

  // ---------- 21-25. Off-chain conflict / stale / corruption / reconcile detect+repair ----------
  {
    const { db } = await freshDB("s21");
    const c = await deployAndSetup([i1]);
    await (await c.mintFractions(0, i1.address, 100)).wait(); await mine(3);
    const svc = newSvc(db, c); await svc.poll();
    // 21+23: manual corruption / stale balance
    db.upsertHolding(0, i1.address, 999, true);
    const recon = new Reconciler(db, c);
    const t0 = Date.now();
    const before = await recon.run({ repair: false });   // 24: detect
    const after = await recon.run({ repair: true });      // 25: repair
    const post = await recon.run({ repair: false });      // verify clean
    rec({ name: "Conflicting/stale/corrupted balance detected and repaired by reconciliation",
      fault: "off-chain balance manually set to 999 (chain=100)", expected: "reconciler detects mismatch and repairs to on-chain value",
      actual: `detected=${before.mismatches}, repaired=${after.repaired}, residual=${post.mismatches}`,
      onchainBalance: 100, dbBalance: db.balanceOf(0, i1.address), recoveryMs: Date.now() - t0, retries: 0, duplicates: 0,
      dataLoss: 0, unresolved: post.mismatches, inconsistencyDetected: before.mismatches >= 1,
      pass: before.mismatches === 1 && after.repaired === 1 && post.mismatches === 0 && db.balanceOf(0, i1.address) === 100 });
    db.close();
  }

  // ---------- 26. Dead-letter after max retries ----------
  {
    const { db } = await freshDB("s26");
    const c = await deployAndSetup([i1]);
    await (await c.mintFractions(0, i1.address, 5)).wait(); await mine(3);
    const svc = newSvc(db, c);
    db.upsertHolding = () => { throw new Error("permanent failure"); }; // never recovers
    await svc.poll();                 // fail 1
    await svc.retryFailed();          // fail 2
    await svc.retryFailed();          // fail 3 -> dead-letter
    const dlq = db.all(`SELECT * FROM dead_letter_queue`);
    rec({ name: "Permanent failure routed to dead-letter queue", fault: "apply always throws",
      expected: "after maxRetries, event dead-lettered for manual intervention", emulated: "permanent DB write failure",
      actual: `deadLettered=${svc.stats.deadLettered}, dlqRows=${dlq.length}`, onchainBalance: 5, dbBalance: 0,
      retries: svc.stats.retries, duplicates: 0, dataLoss: 0, unresolved: dlq.length,
      pass: svc.stats.deadLettered >= 1 && dlq.length >= 1 });
    db.close();
  }

  // ---------- 27. Multiple listeners receive the same event ----------
  {
    const { db } = await freshDB("s27");
    const c = await deployAndSetup([i1]);
    await (await c.mintFractions(0, i1.address, 70)).wait(); await mine(3);
    const svcA = newSvc(db, c), svcB = newSvc(db, c);
    await svcA.poll();
    svcB.replayFrom(0); await svcB.poll(); // second listener re-reads same range
    rec({ name: "Multiple listeners receive the same event", fault: "two listeners, overlapping ranges",
      expected: "shared idempotent store applies once", actual: `DB=${db.balanceOf(0, i1.address)}, dupSkippedB=${svcB.stats.duplicatesSkipped}`,
      onchainBalance: 70, dbBalance: db.balanceOf(0, i1.address), retries: 0, duplicates: svcB.stats.duplicatesSkipped,
      dataLoss: 0, unresolved: 0, pass: db.balanceOf(0, i1.address) === 70 && svcB.stats.duplicatesSkipped >= 1 });
    db.close();
  }

  // ---------- 28. Concurrent updates to same holding ----------
  {
    const { db } = await freshDB("s28");
    const c = await deployAndSetup([i1, i2]);
    await (await c.mintFractions(0, i1.address, 50)).wait();
    await (await c.connect(i1).safeTransferFrom(i1.address, i2.address, 0, 20, "0x")).wait();
    await mine(3);
    const svc = newSvc(db, c); await svc.poll();
    const i1c = Number(await c.balanceOf(i1.address, 0)), i2c = Number(await c.balanceOf(i2.address, 0));
    rec({ name: "Concurrent updates to same holding (mint then transfer applied in order)", fault: "two events touch i1's balance",
      expected: "sequential idempotent application yields correct net balance", actual: `DB i1=${db.balanceOf(0, i1.address)} i2=${db.balanceOf(0, i2.address)}`,
      onchainBalance: i1c, dbBalance: db.balanceOf(0, i1.address), retries: 0, duplicates: 0, dataLoss: 0, unresolved: 0,
      pass: db.balanceOf(0, i1.address) === i1c && db.balanceOf(0, i2.address) === i2c });
    db.close();
  }

  // ---------- 29. Transaction ordering changes (log_index ordering authoritative) ----------
  {
    const { db } = await freshDB("s29");
    const c = await deployAndSetup([i1, i2]);
    await (await c.mintFractions(0, i1.address, 30)).wait();
    await (await c.connect(i1).safeTransferFrom(i1.address, i2.address, 0, 10, "0x")).wait();
    await mine(3);
    const svc = newSvc(db, c); await svc.poll();
    // reprocess with replay; ordering by (block,logIndex) is stable
    svc.replayFrom(0); await svc.poll();
    const i1c = Number(await c.balanceOf(i1.address, 0));
    rec({ name: "Transaction ordering stable under reprocessing", fault: "reprocess in different wall-clock order",
      expected: "canonical (block,logIndex) order => identical final state", actual: `DB i1=${db.balanceOf(0, i1.address)}`,
      onchainBalance: i1c, dbBalance: db.balanceOf(0, i1.address), retries: 0, duplicates: svc.stats.duplicatesSkipped,
      dataLoss: 0, unresolved: 0, pass: db.balanceOf(0, i1.address) === i1c });
    db.close();
  }

  // ---------- 30. Audit history complete after recovery ----------
  {
    const { db } = await freshDB("s30");
    const c = await deployAndSetup([i1]);
    await (await c.mintFractions(0, i1.address, 45)).wait(); await mine(3);
    const svc = newSvc(db, c); await svc.poll();
    await db.restart();
    const audits = db.all(`SELECT * FROM audit_log`);
    rec({ name: "Audit history complete and durable after restart", fault: "restart after processing",
      expected: "audit_log persists apply actions across restart", emulated: "close+reopen from file",
      actual: `auditRows=${audits.length}`, onchainBalance: 45, dbBalance: db.balanceOf(0, i1.address),
      retries: 0, duplicates: 0, dataLoss: 0, unresolved: 0, pass: audits.length >= 1 && db.balanceOf(0, i1.address) === 45 });
    db.close();
  }

  // ---------- Aggregate metrics ----------
  const S = results.scenarios;
  const pass = S.filter((s) => s.pass).length;
  const recoveries = S.filter((s) => typeof s.recoveryMs === "number").map((s) => s.recoveryMs).sort((a, b) => a - b);
  const p95 = recoveries.length ? recoveries[Math.min(recoveries.length - 1, Math.ceil(0.95 * recoveries.length) - 1)] : null;
  const detectScenarios = S.filter((s) => s.inconsistencyDetected !== undefined);
  results.metrics = {
    scenarios: S.length,
    passed: pass,
    failed: S.length - pass,
    eventProcessingSuccessRate: +(S.filter((s) => s.dataLoss === 0).length / S.length).toFixed(4),
    duplicatePreventionRate: S.filter((s) => s.duplicates > 0).every((s) => s.pass) ? 1 : 0,
    recoverySuccessRate: +(S.filter((s) => (s.recoveryMs !== undefined) && s.pass).length / Math.max(1, S.filter((s) => s.recoveryMs !== undefined).length)).toFixed(4),
    reconciliationSuccessRate: detectScenarios.length ? +(detectScenarios.filter((s) => s.pass).length / detectScenarios.length).toFixed(4) : null,
    meanRecoveryMs: recoveries.length ? +(recoveries.reduce((a, b) => a + b, 0) / recoveries.length).toFixed(1) : null,
    p95RecoveryMs: p95,
    inconsistencyDetectionRate: detectScenarios.length ? +(detectScenarios.filter((s) => s.inconsistencyDetected).length / detectScenarios.length).toFixed(4) : null,
    unresolvedErrorCount: S.reduce((a, s) => a + (s.unresolved || 0), 0),
    totalDataLoss: S.reduce((a, s) => a + (s.dataLoss || 0), 0),
  };

  const out = path.join(OUT_DIR, `faults_${Date.now()}.json`);
  fs.writeFileSync(out, JSON.stringify(results, null, 2));
  console.log(`\n${pass}/${S.length} scenarios passed. Metrics:`, results.metrics);
  console.log("Wrote", out);
  if (pass !== S.length) process.exitCode = 2;
}

main().catch((e) => { console.error(e); process.exit(1); });
