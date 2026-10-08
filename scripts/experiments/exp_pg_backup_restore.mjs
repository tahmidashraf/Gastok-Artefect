/**
 * PostgreSQL cold backup-and-restore recovery test (Phase 10 scenario 48).
 * Applies events, stops the server, takes a filesystem cold backup of the data dir,
 * simulates data-dir loss, restores from the backup, restarts, and verifies durable state.
 * Output: results/postgres/raw/pg_backup_restore_<ts>.json
 */
import EmbeddedPostgres from "embedded-postgres";
import { PgStore } from "../../db/pg/pg-store.mjs";
import fs from "fs"; import path from "path";

const PORT = 55435;
const DIR = "./db/pgdata_backup";
const BACKUP = "./db/pgdata_backup_copy";
const CFG = { host: "127.0.0.1", port: PORT, user: "rs", password: "rs", database: "postgres" };

function copyDir(src, dst){ fs.rmSync(dst,{recursive:true,force:true}); fs.cpSync(src,dst,{recursive:true}); }

async function main(){
  fs.rmSync(DIR,{recursive:true,force:true}); fs.rmSync(BACKUP,{recursive:true,force:true});
  const epg = new EmbeddedPostgres({ databaseDir: DIR, user:"rs", password:"rs", port:PORT, persistent:true });
  await epg.initialise(); await epg.start();
  let store = new PgStore(CFG,{poolMax:5}); await store.init();

  // apply known state
  for (let i=1;i<=5;i++) await store.applyEvent({ txHash:"0x"+i.toString(16).padStart(64,"0"), logIndex:0, eventSig:"FractionsMinted", propertyId:1, receiver:"0xabc", amount:10, blockNumber:i });
  const before = await store.balanceOf(1,"0xabc");
  await store.end();

  // COLD BACKUP: stop server, filesystem copy of the data dir
  const t0 = Date.now();
  await epg.stop();
  copyDir(DIR, BACKUP);

  // Simulate data-dir loss, then RESTORE from backup
  fs.rmSync(DIR,{recursive:true,force:true});
  copyDir(BACKUP, DIR);
  await epg.start();
  const recoveryMs = Date.now()-t0;

  store = new PgStore(CFG,{poolMax:5}); await store.init();
  const after = await store.balanceOf(1,"0xabc");
  // idempotency after restore: re-applying the same events must not double
  const r = await store.applyEvent({ txHash:"0x"+(1).toString(16).padStart(64,"0"), logIndex:0, eventSig:"FractionsMinted", propertyId:1, receiver:"0xabc", amount:10, blockNumber:1 });
  const afterReplay = await store.balanceOf(1,"0xabc");
  await store.end(); await epg.stop();

  const pass = before===50 && after===50 && r.duplicate===true && afterReplay===50;
  const out = { experiment:"pg_backup_restore", timestamp:new Date().toISOString(),
    beforeBackup:before, afterRestore:after, replayDuplicate:r.duplicate, afterReplay, recoveryMs, pass };
  fs.mkdirSync("results/postgres/raw",{recursive:true});
  const f = `results/postgres/raw/pg_backup_restore_${Date.now()}.json`;
  fs.writeFileSync(f, JSON.stringify(out,null,2));
  console.log(`Backup/restore: before=${before} afterRestore=${after} replayDup=${r.duplicate} -> ${pass?"PASS":"FAIL"} (recovery ${recoveryMs}ms). Wrote ${f}`);
  if(!pass) process.exitCode=2;
}
main().catch(e=>{console.error(e);process.exit(1);});
