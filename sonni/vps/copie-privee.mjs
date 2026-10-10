/**
 * Shared safety block of the read-only scripts that inspect a COPY of Sonni's memory (audit-prix.mjs,
 * controle-predeploiement.mjs, restauration.mjs --essai). Extracted unchanged from audit-prix.mjs (step 0.3)
 * for the controlled deployment of 2026-10-10.
 *
 * Nothing here ever opens the given file with SQLite: it is copied byte for byte into a new private
 * temporary folder, the copy is opened read-only (query_only), and the given file's SHA-256 is compared
 * before and after. Files that could be the live database are refused before anything is read.
 */

import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import Database from "better-sqlite3";

/** Above this, a stored REAL is the Infinity a pre-0.3 fill wrote (SQLite keeps it as 9e999). */
export const HUGE = 1e300;

export function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/** Same file on disk (also through a hard link or a symbolic link). */
export function sameFile(a, b) {
  try {
    const x = fs.statSync(a);
    const y = fs.statSync(b);
    return x.dev === y.dev && x.ino === y.ino;
  } catch {
    return false;
  }
}

/** The live database of the user running the script: ~/.automaton/state.db. */
export function liveDatabasePath(env = process.env) {
  return path.join(env.HOME || os.homedir(), ".automaton", "state.db");
}

/**
 * Why a file must not be read as a copy (French, for the owner), or null. A missing file, the live
 * database (by name or by inode) and a file with a -wal or -shm beside it are refused.
 */
export function refusal(file, env = process.env) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return `Fichier introuvable : ${file}`;
  if (path.basename(file) === "state.db" || sameFile(file, liveDatabasePath(env))) {
    return "Refusé : c'est la base active de Sonni. Donne une copie, par exemple la sauvegarde du jour dans ~/.automaton/backups/.";
  }
  if (fs.existsSync(`${file}-wal`) || fs.existsSync(`${file}-shm`)) {
    return "Refusé : un fichier -wal ou -shm est à côté, signe d'une base ouverte par un programme. Donne une copie fermée.";
  }
  return null;
}

/**
 * Copies `file` into a new private temporary folder and opens that copy read-only. The folder holds all of
 * Sonni's memory: it is removed by close(), and on Ctrl+C, a stop or a closed SSH session (exit 130).
 * Throws when the file is not an SQLite database (the folder is removed first).
 */
export function openPrivateCopy(file, prefix = "sonni-copie-") {
  const before = sha256File(file);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const copy = path.join(dir, "copie.db");
  let db;
  const close = () => {
    try { db?.close(); } catch { /* nothing */ }
    db = undefined;
    fs.rmSync(dir, { recursive: true, force: true });
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => {
      close();
      process.exit(130);
    });
  }
  try {
    fs.copyFileSync(file, copy);
    // A WAL-mode copy cannot be opened read-only without its -wal file: mark our private copy as a rollback
    // journal database (header bytes 18 and 19), without SQLite writing anything.
    const fd = fs.openSync(copy, "r+");
    const header = Buffer.alloc(20);
    fs.readSync(fd, header, 0, 20, 0);
    if (header.toString("latin1", 0, 15) !== "SQLite format 3") {
      fs.closeSync(fd);
      throw new Error("Ce fichier n'est pas une base SQLite.");
    }
    if (header[18] === 2 || header[19] === 2) fs.writeSync(fd, Buffer.from([1, 1]), 0, 2, 18);
    fs.closeSync(fd);
    db = new Database(copy, { readonly: true, fileMustExist: true });
    db.pragma("query_only = ON");
  } catch (err) {
    close();
    throw err;
  }
  return {
    db,
    dir,
    before,
    close,
    /** True when the given file still has the SHA-256 it had before the copy. */
    unchanged: () => sha256File(file) === before,
  };
}

/** French number; -0,00 never appears (a gap below half a cent is 0,00). */
export const fr = (v, digits = 2) => (Number.isFinite(v) ? (Math.abs(v) < 0.5 * 10 ** -digits ? 0 : v).toLocaleString("fr-FR", { minimumFractionDigits: digits, maximumFractionDigits: digits }) : "non fini");
export const count = (n, one, many) => `${n} ${n > 1 ? many : one}`;
export const price = (v) => (!Number.isFinite(v) ? "non fini" : Math.abs(v) >= 1 || v === 0 ? `${fr(v)} €` : `${v.toLocaleString("fr-FR", { maximumSignificantDigits: 8 })} €`);

/** True when the module is the script node was started with (and not imported by another script). */
export function isMain(metaUrl) {
  try {
    return !!process.argv[1] && fs.realpathSync(fileURLToPath(metaUrl)) === fs.realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}
