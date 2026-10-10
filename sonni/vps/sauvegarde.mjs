#!/usr/bin/env node
/**
 * Consistent copy of Sonni's LIVE memory before a deployment (controlled deployment of 2026-10-10, steps
 * 0.1-0.3). The owner runs it on the VPS as the sonni user, Sonni running or stopped. The copy is what the
 * pre-deployment check reads (controle-predeploiement.mjs) and what a restore puts back (restauration.mjs).
 *
 * Safety: it never writes to the live database and never opens it writable.
 * - Sonni running (a -wal file beside the database, also after an unclean stop): the database is opened
 *   read-only (query_only), the row counts of the key tables are read, then SQLite's online backup API copies
 *   it in ONE step, so the copy is a single consistent snapshot even while Sonni writes. The copy must hold
 *   at least the rows counted before.
 * - Sonni stopped cleanly (no -wal): the database is not opened with SQLite at all (a read-only open of a WAL
 *   database leaves -wal and -shm beside it). It is copied byte for byte, and its SHA-256 must be the same
 *   before the copy, after it and in the copy.
 * Only the COPY is then opened for writing: rollback journal (a self-contained file), integrity check, counts.
 * It is written under a temporary name, never overwrites a file, and is kept with 600 permissions next to a
 * `.sha256` file that `sha256sum -c` checks from the folder. The default folder ~/.automaton/predeploiement
 * is outside ~/.automaton/backups, whose 7-day rotation would delete the copy (that folder is refused, as is
 * the database's own folder). A failed or interrupted run removes only the files it created.
 *
 * Exit codes: 0 copy made and verified; 1 verification failed (copy removed); 2 refused or usage error
 * (nothing read or written); 3 technical error (disk space, not SQLite, unreadable file; copy removed);
 * 130 interrupted (temporary files removed, no copy kept). The last line of stdout is
 * `RÉSULTAT : code=<n> copie=<chemin|aucune>`.
 * Interruption (Ctrl+C, a stop, a closed SSH session): Node handles a signal between two steps, never inside
 * one. Before the snapshot of a hot copy starts (opening, counting), the run stops, removes its files and
 * exits 130. Once the copy is under way (the snapshot, a cold byte copy, the checks), the run finishes it and
 * ends with its own result and exit code: a half-made copy is never kept.
 *
 * Usage: node sonni/vps/sauvegarde.mjs [--source <state.db>] [--dossier <dossier>]
 *   defaults: --source ~/.automaton/state.db, --dossier ~/.automaton/predeploiement (created 0700)
 */

import fs from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3";
import { fr, isMain, liveDatabasePath, sameFile, sha256File } from "./copie-privee.mjs";

/** Tables whose row counts are compared between the live database and the copy (those present). */
export const KEY_TABLES = [
  "trader_orders", "trader_ledger", "trader_positions", "trader_trades", "trader_prices", "trader_predictions",
  "trader_decisions", "trader_incidents", "trader_reflections", "turns", "inference_costs", "inbox_messages",
];

/** The newest moments a copy carries: its age (what a restore would lose) is measured from them. */
export const NEWEST = [
  { table: "trader_prices", column: "ts", label: "dernier prix enregistré" },
  { table: "trader_orders", column: "placed_at", label: "dernier ordre passé" },
  { table: "trader_ledger", column: "at", label: "dernière ligne du registre" },
];

/** Files SQLite may create beside a database it opens. */
export const SIDECARS = ["-wal", "-shm", "-journal"];

/** Callbacks that remove this run's temporary files; main() runs them on a signal. */
export const pending = new Set();

/** A verification or refusal with its exit code (1 or 2); any other error is technical (3). */
export class Failure extends Error {
  constructor(code, message) {
    super(message);
    this.exitCode = code;
  }
}

const hasTable = (db, table) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);

/** Row counts of the key tables present in `db`. */
export function tableCounts(db) {
  const counts = {};
  for (const t of KEY_TABLES) if (hasTable(db, t)) counts[t] = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
  return counts;
}

/** Newest price, order and ledger timestamps of `db` (value null when the table is empty). */
export function newestTimes(db) {
  return NEWEST.filter((n) => hasTable(db, n.table)).map((n) => ({ ...n, value: db.prepare(`SELECT MAX(${n.column}) AS v FROM ${n.table}`).get().v ?? null }));
}

/** First answer of SQLite's integrity check: "ok" for a sound file. */
export function integrity(db) {
  return String(db.pragma("integrity_check", { simple: true }));
}

/** SQLite's integrity report on one line, shortened for the owner (SQLite writes it in English). */
export function integrityBrief(report) {
  return `SQLite signale des pages abîmées (détail : ${report.replace(/\s*\n\s*/g, " ; ").slice(0, 160)})`;
}

/** UTC stamp used in file and folder names: 20261010T143005Z. */
export function stamp(now = new Date()) {
  return `${now.toISOString().slice(0, 19).replace(/[-:]/g, "")}Z`;
}

/** Bytes a copy needs: twice the database and its -wal (the copy, plus SQLite's journal while it is converted). */
export function spaceNeeded(source) {
  const size = (file) => {
    try {
      return fs.statSync(file).size;
    } catch {
      return 0;
    }
  };
  return 2 * (size(source) + size(`${source}-wal`));
}

/** Bytes an unprivileged user may still write in `dir`. */
export function freeSpace(dir) {
  const s = fs.statfsSync(dir);
  return Number(s.bavail) * Number(s.bsize);
}

export const mo = (bytes) => `${fr(bytes / 1_048_576, 1)} Mo`;

/** French description of a technical error: SQLite and file system codes, never a secret. */
export function technicalFr(err) {
  const code = typeof err?.code === "string" ? err.code : "";
  const known = {
    SQLITE_NOTADB: "ce fichier n'est pas une base SQLite",
    SQLITE_CORRUPT: "base abîmée (SQLite la dit corrompue)",
    SQLITE_BUSY: "base occupée par un autre programme",
    SQLITE_CANTOPEN: "impossible d'ouvrir le fichier",
    SQLITE_FULL: "disque plein",
    SQLITE_IOERR: "erreur de lecture ou d'écriture sur le disque",
    SQLITE_READONLY: "écriture refusée",
    ENOSPC: "disque plein",
    EDQUOT: "quota disque dépassé",
    EACCES: "accès refusé (droits du fichier ou du dossier)",
    EPERM: "opération non permise",
    ENOENT: "fichier ou dossier introuvable",
    EEXIST: "un fichier du même nom existe déjà",
    EROFS: "système de fichiers en lecture seule",
    EIO: "erreur d'entrée-sortie du disque",
  };
  const base = Object.keys(known).find((k) => code === k || code.startsWith(`${k}_`));
  if (base) return `${known[base]} (${code})`;
  if (code) return `erreur système (${code})`;
  // No code: the only French message thrown without one is copie-privee.mjs's; anything else is unexpected
  // and keeps its raw text as a detail (lower-case start, no final period: it ends inside a sentence).
  const message = String(err?.message ?? err).trim().replace(/[.\s]+$/, "");
  if (/n'est pas une base SQLite/i.test(message)) return "ce fichier n'est pas une base SQLite";
  return `cas imprévu (détail : ${message || "aucun"})`;
}

/** Why the backup must not start (French), or null: nothing has been read or written yet. */
export function backupRefusal(source, dossier, env = process.env) {
  let st;
  try {
    st = fs.lstatSync(source);
  } catch {
    return `Refusé : base introuvable (${source}).`;
  }
  if (st.isSymbolicLink()) return `Refusé : ${source} est un lien symbolique. Donne le chemin réel de la base.`;
  if (!st.isFile()) return `Refusé : ${source} n'est pas un fichier ordinaire.`;
  const backups = path.join(env.HOME || os.homedir(), ".automaton", "backups");
  const same = (a, b) => path.resolve(a) === path.resolve(b) || sameFile(a, b);
  if (same(dossier, backups)) {
    return "Refusé : Sonni efface les copies de ~/.automaton/backups au bout de 7 jours. Choisis un autre dossier (par défaut ~/.automaton/predeploiement).";
  }
  if (same(dossier, path.dirname(source))) {
    return "Refusé : la copie ne doit pas être rangée dans le dossier de la base. Choisis un autre dossier (par défaut ~/.automaton/predeploiement).";
  }
  if (fs.existsSync(dossier) && !fs.statSync(dossier).isDirectory()) return `Refusé : ${dossier} existe et n'est pas un dossier.`;
  return null;
}

/** Flushes a file (or a folder entry) to the disk; a folder that cannot be synced is not an error. */
function flush(file, isDir = false) {
  let fd;
  try {
    fd = fs.openSync(file, isDir ? "r" : "r+");
    fs.fsyncSync(fd);
  } catch (err) {
    if (!isDir) throw err;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Makes and verifies the copy, writing the French report with `say` (stdout) and problems with `warn`
 * (stderr). Returns `{ code, copy }`; never exits, so tests can call it with an injected `freeSpace`.
 */
export async function sauvegarde(options = {}) {
  const env = options.env ?? process.env;
  const say = options.say ?? ((line = "") => process.stdout.write(`${line}\n`));
  const warn = options.warn ?? ((line) => process.stderr.write(`${line}\n`));
  const now = options.now ?? new Date();
  const free = options.freeSpace ?? freeSpace;
  const home = env.HOME || os.homedir();
  const source = path.resolve(options.source ?? liveDatabasePath(env));
  const dossier = path.resolve(options.dossier ?? path.join(home, ".automaton", "predeploiement"));
  const done = (code, message, copy) => {
    if (message) (code === 0 ? say : warn)(message);
    say(`RÉSULTAT : code=${code} copie=${copy ?? "aucune"}`);
    return { code, copy: copy ?? null };
  };

  const refused = backupRefusal(source, dossier, env);
  if (refused) return done(2, refused);
  const name = `state.db.predeploiement-${stamp(now)}`;
  const final = path.join(dossier, name);
  const partial = `${final}.partial`;
  const shaFile = `${final}.sha256`;
  if ([final, partial, shaFile, ...SIDECARS.map((s) => `${partial}${s}`)].some((f) => fs.existsSync(f))) {
    return done(2, `Refusé : ${final} existe déjà (jamais écrasé). Relance dans une seconde.`);
  }

  try {
    fs.mkdirSync(dossier, { recursive: true, mode: 0o700 });
  } catch (err) {
    return done(3, `Impossible de créer le dossier ${dossier} : ${technicalFr(err)}.`);
  }
  const needed = spaceNeeded(source);
  let available;
  try {
    available = free(dossier);
  } catch (err) {
    return done(3, `Impossible de mesurer l'espace libre de ${dossier} : ${technicalFr(err)}.`);
  }
  if (available < needed) {
    return done(3, `Espace disque insuffisant dans ${dossier} : ${mo(available)} libres, ${mo(needed)} nécessaires (deux fois la base et son journal). Rien n'a été copié.`);
  }

  // Only files this run created are ever removed: the partial copy and SQLite's files beside it, then the
  // final copy and its .sha256 once they exist.
  const mine = [partial, ...SIDECARS.map((s) => `${partial}${s}`)];
  const cleanup = () => {
    for (const f of mine) fs.rmSync(f, { force: true });
  };
  pending.add(cleanup);
  const hot = fs.existsSync(`${source}-wal`);
  say("Sauvegarde de la mémoire de Sonni avant déploiement");
  say(`Mode : ${hot ? "à chaud (Sonni en marche)" : "à froid (Sonni arrêté)"}`);
  say(`Source : ${source}`);
  try {
    let live = null;
    if (hot) {
      // Read-only, query_only: the counts first, then the whole database in one backup step (a snapshot).
      let src;
      try {
        src = new Database(source, { readonly: true, fileMustExist: true });
        src.pragma("query_only = ON");
        live = tableCounts(src);
        await src.backup(partial, { progress: () => 1_000_000_000 });
      } finally {
        src?.close();
      }
    } else {
      // Never opened with SQLite: a byte copy, the same before, after and in the copy.
      const before = sha256File(source);
      fs.copyFileSync(source, partial, fs.constants.COPYFILE_EXCL);
      const copied = sha256File(partial);
      const after = sha256File(source);
      if (fs.existsSync(`${source}-wal`)) throw new Failure(1, "Sonni a démarré pendant la copie : copie supprimée. Relance la sauvegarde (elle se fera à chaud).");
      if (before !== after || copied !== before) throw new Failure(1, "La base a changé pendant la copie (un programme l'écrit ?) : copie supprimée. Relance la sauvegarde.");
    }

    const header = Buffer.alloc(16);
    const fd = fs.openSync(partial, "r");
    fs.readSync(fd, header, 0, 16, 0);
    fs.closeSync(fd);
    if (header.toString("latin1", 0, 15) !== "SQLite format 3") throw new Failure(3, "Ce fichier n'est pas une base SQLite : rien n'a été gardé.");

    // The COPY only, writable: a self-contained file (rollback journal), then the checks.
    let ok;
    let counts = {};
    let newest = [];
    const copyDb = new Database(partial, { fileMustExist: true });
    try {
      copyDb.pragma("journal_mode = DELETE");
      ok = integrity(copyDb);
      if (ok === "ok") {
        counts = tableCounts(copyDb);
        newest = newestTimes(copyDb);
      }
    } finally {
      copyDb.close();
    }
    if (ok !== "ok") throw new Failure(1, `Intégrité de la copie en défaut : ${integrityBrief(ok)}. Copie supprimée.`);
    const left = SIDECARS.filter((s) => fs.existsSync(`${partial}${s}`));
    if (left.length) throw new Failure(1, `La copie n'est pas autonome (fichier ${left.join(", ")} à côté). Copie supprimée.`);
    if (live) {
      for (const [t, n] of Object.entries(live)) {
        if (!(t in counts) || counts[t] < n) throw new Failure(1, `Copie incomplète : ${t} a ${counts[t] ?? 0} lignes dans la copie contre ${n} dans la base active. Copie supprimée ; relance la sauvegarde.`);
      }
    }

    fs.chmodSync(partial, 0o600);
    flush(partial);
    if (fs.existsSync(final)) throw new Failure(3, `${final} est apparu pendant la sauvegarde : rien n'a été écrasé.`);
    fs.renameSync(partial, final);
    mine.push(final);
    const hash = sha256File(final);
    const shaFd = fs.openSync(shaFile, "wx", 0o600);
    mine.push(shaFile);
    try {
      fs.writeSync(shaFd, `${hash}  ${name}\n`);
      fs.fsyncSync(shaFd);
    } finally {
      fs.closeSync(shaFd);
    }
    fs.chmodSync(shaFile, 0o600);
    flush(dossier, true);
    pending.delete(cleanup);

    say(`Copie : ${final}`);
    say(`Taille : ${mo(fs.statSync(final).size)}`);
    say(`SHA-256 : ${hash}`);
    say("Intégrité : ok");
    say("Lignes par table :");
    for (const [t, n] of Object.entries(counts)) say(`  - ${t} : ${n}${live ? ` (base active juste avant : ${live[t] ?? 0})` : ""}`);
    say("Derniers horodatages :");
    for (const n of newest) say(`  - ${n.label} : ${n.value ?? "aucun"}`);
    say(`Empreinte : ${shaFile} (vérification : cd ${dossier} && sha256sum -c ${name}.sha256)`);
    say("Copie faite et vérifiée. Garde-la jusqu'à la fin du déploiement : le contrôle avant déploiement la lit et une restauration la remettrait en place.");
    return done(0, null, final);
  } catch (err) {
    cleanup();
    pending.delete(cleanup);
    if (err instanceof Failure) return done(err.exitCode, err.message);
    const code = /^SQLITE_CORRUPT/.test(err?.code ?? "") ? 1 : 3;
    return done(code, `Sauvegarde impossible : ${technicalFr(err)}. Aucune copie n'a été gardée.`);
  }
}

const USAGE = "Usage : node sonni/vps/sauvegarde.mjs [--source <state.db>] [--dossier <dossier>]";

/** Parses the command line; throws a Failure(2) on a usage error. */
export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--source" || a === "--dossier") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) throw new Failure(2, `${a} attend un chemin. ${USAGE}`);
      out[a.slice(2)] = value;
      i += 1;
    } else throw new Failure(2, `Option inconnue : ${a}. ${USAGE}`);
  }
  return out;
}

async function main() {
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => {
      // The work is synchronous apart from awaits: a signal handled once the run is over (result printed)
      // keeps the run's own exit code.
      if (pending.size === 0 && process.exitCode !== undefined) process.exit(process.exitCode);
      for (const clean of pending) clean();
      process.stdout.write("Interrompu : fichiers temporaires supprimés, aucune copie gardée.\nRÉSULTAT : code=130 copie=aucune\n");
      process.exit(130);
    });
  }
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.stdout.write("RÉSULTAT : code=2 copie=aucune\n");
    process.exitCode = 2;
    return;
  }
  const { code } = await sauvegarde({ source: args.source, dossier: args.dossier });
  process.exitCode = code;
}

if (isMain(import.meta.url)) await main();
