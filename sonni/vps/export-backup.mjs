#!/usr/bin/env node
/**
 * Puts the newest verified daily copy of Sonni's memory where the owner's PC fetches it each night
 * (sonni/GUIDE-PC.fr.md, plan of 2026-10-08 step 3). Run by sonni-backup-export.timer as the sonni user.
 *
 * The runtime already makes a daily copy of state.db in ~/.automaton/backups and checks it (guard G7).
 * This script copies the newest one into the export folder, opens that copy read-only, checks SQLite's
 * integrity and that Sonni's stores are in it, then publishes it with its SHA-256 for the PC, which
 * checks the hash after the transfer (sonni/pc/backup-pull.ps1). The export folder is read-only for the
 * PC's SFTP account and keeps only the newest copy; the PC keeps 30 days.
 *
 * Usage: node sonni/vps/export-backup.mjs [backups folder] [export folder]
 */

import crypto from "crypto";
import fs from "fs";
import path from "path";
import Database from "better-sqlite3";

const SOURCE = process.argv[2] ?? path.join(process.env.HOME || "/home/sonni", ".automaton", "backups");
const TARGET = process.argv[3] ?? "/srv/sonni-backup/files";
const NAME = /^state\.db\.backup-\d{4}-\d{2}-\d{2}$/;
const EXPORTED = /^state\.db\.backup-\d{4}-\d{2}-\d{2}(\.sha256)?$/;
/** Stores a copy of Sonni's memory must hold. */
const REQUIRED = ["trader_predictions", "trader_orders", "trader_reflections", "trader_lessons", "trader_dossiers"];

function sha256(file) {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(1 << 20);
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) hash.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

/**
 * A plain byte copy into a new file. Not fs.copyFileSync: it gives the copy the source's group, while a
 * new file must take the export folder's group (setgid sonni-backup) for the PC's account to read it.
 */
function copy(from, to) {
  const src = fs.openSync(from, "r");
  const dst = fs.openSync(to, "wx", 0o640);
  try {
    const buf = Buffer.alloc(1 << 20);
    let n;
    while ((n = fs.readSync(src, buf, 0, buf.length, null)) > 0) fs.writeSync(dst, buf, 0, n);
    fs.fsyncSync(dst);
  } finally {
    fs.closeSync(src);
    fs.closeSync(dst);
  }
}

/**
 * Null when the copy is a sound database holding Sonni's stores, else why not. The copy is ours, so it is
 * opened for writing and made self-contained (rollback journal): a WAL-mode copy (the runtime's before
 * 2026-10-08) opened read-only would leave -wal and -shm files in the export folder.
 */
function check(file) {
  let db = null;
  try {
    db = new Database(file, { fileMustExist: true });
    db.pragma("journal_mode = DELETE");
    const integrity = db.pragma("integrity_check", { simple: true });
    if (integrity !== "ok") return `integrity_check : ${String(integrity).slice(0, 120)}`;
    const missing = REQUIRED.filter((t) => !db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t));
    return missing.length ? `tables absentes : ${missing.join(", ")}` : null;
  } catch (err) {
    return String(err?.message ?? err).slice(0, 160);
  } finally {
    db?.close();
  }
}

const newest = fs.existsSync(SOURCE) ? fs.readdirSync(SOURCE).filter((f) => NAME.test(f)).sort().at(-1) : undefined;
if (!newest) {
  console.log(`Aucune copie quotidienne dans ${SOURCE} pour le moment.`);
  process.exit(0);
}
const final = path.join(TARGET, newest);
if (fs.existsSync(final) && fs.existsSync(`${final}.sha256`)) {
  console.log(`Déjà exportée : ${newest}.`);
  process.exit(0);
}

// Copy first, then check the copy itself: what the PC receives is what was checked.
const tmp = path.join(TARGET, `.${newest}.tmp`);
fs.rmSync(tmp, { force: true });
copy(path.join(SOURCE, newest), tmp);
const problem = check(tmp);
if (problem) {
  fs.rmSync(tmp, { force: true });
  console.error(`Copie ${newest} refusée : ${problem}. La précédente reste disponible pour le PC.`);
  process.exit(1);
}
const hash = sha256(tmp);
fs.chmodSync(tmp, 0o640);
fs.renameSync(tmp, final);
fs.writeFileSync(`${final}.sha256.tmp`, `${hash}  ${newest}\n`, { mode: 0o640 });
fs.renameSync(`${final}.sha256.tmp`, `${final}.sha256`);
// Only the newest copy stays in the export folder.
for (const f of fs.readdirSync(TARGET)) {
  if (EXPORTED.test(f) && !f.startsWith(newest)) fs.rmSync(path.join(TARGET, f), { force: true });
}
const mb = (fs.statSync(final).size / 1_048_576).toFixed(1);
console.log(`Exportée pour le PC : ${newest} (${mb} Mo, vérifiée, SHA-256 ${hash.slice(0, 12)}…).`);
