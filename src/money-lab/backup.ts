/**
 * Money Lab daily state backup
 *
 * Once a day the runtime copies state.db (journal, ledger, memory) to
 * ~/.automaton/backups/state.db.backup-YYYY-MM-DD with SQLite's online backup
 * and keeps the last 7 copies. The directory is a protected runtime entry.
 */

import fs from "fs";
import path from "path";
import Database from "better-sqlite3";

const KEEP = 7;
const PREFIX = "state.db.backup-";

export async function backupStateDaily(
  db: Database.Database,
  home = process.env.HOME || "/root",
  now = new Date(),
): Promise<string | null> {
  const dir = path.join(home, ".automaton", "backups");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${PREFIX}${now.toISOString().slice(0, 10)}`);
  if (fs.existsSync(file)) return null;
  // Written under a temporary name: an interrupted backup (full disk) never
  // passes for the day's copy.
  const partial = `${file}.partial`;
  fs.rmSync(partial, { force: true });
  try {
    await db.backup(partial);
    fs.renameSync(partial, file);
  } finally {
    fs.rmSync(partial, { force: true });
  }
  const old = fs.readdirSync(dir).filter((f) => f.startsWith(PREFIX)).sort().slice(0, -KEEP);
  for (const f of old) fs.rmSync(path.join(dir, f), { force: true });
  return file;
}

/** Tables whose row counts a backup must carry (those that exist in the live database). */
const VERIFIED_TABLES = ["turns", "inbox_messages", "inference_costs", "trader_predictions", "trader_orders", "trader_trades", "trader_reflections", "trader_hypotheses"];

/** Row counts of the verified tables, taken from the live database right before a backup. */
export function tableCounts(live: Database.Database): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const t of VERIFIED_TABLES) {
    if (!live.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t)) continue;
    counts[t] = (live.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
  }
  return counts;
}

/**
 * Guard G7: opens a backup read-only and checks it is a restorable copy.
 * SQLite's integrity check must answer "ok" and each verified table must
 * hold at least the rows the live database had just before the copy
 * (rows added meanwhile are fine). A backup that fails is reported, never
 * silently kept as the day's copy.
 */
export function verifyBackup(file: string, expected: Record<string, number>): { ok: boolean; detail: string } {
  let copy: Database.Database | null = null;
  try {
    copy = new Database(file, { readonly: true, fileMustExist: true });
    const integrity = (copy.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check;
    if (integrity !== "ok") return { ok: false, detail: `integrity_check: ${String(integrity).slice(0, 120)}` };
    const counts: string[] = [];
    for (const [t, min] of Object.entries(expected)) {
      const inCopy = (copy.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
      if (inCopy < min) return { ok: false, detail: `${t}: ${inCopy} lignes dans la copie, ${min} attendues` };
      counts.push(`${t} ${inCopy}`);
    }
    return { ok: true, detail: counts.join(", ") };
  } catch (err: any) {
    return { ok: false, detail: String(err?.message ?? err).slice(0, 160) };
  } finally {
    copy?.close();
  }
}
