#!/usr/bin/env node
/**
 * Restore drill and real restore of a copy of Sonni's memory (controlled deployment of 2026-10-10).
 *
 * Restoring the database is an OWNER DECISION: it discards everything Sonni wrote after the copy was made
 * (journal, predictions, orders, positions, the inference spend ledger). The drill proves a copy can be put
 * back and measures how long it takes, without touching anything.
 *
 * --essai <copie> (drill): never touches ~/.automaton. The copy's SHA-256 is checked against `<copie>.sha256`
 *   when that file exists; the copy is read through a private read-only copy (copie-privee.mjs: integrity,
 *   row counts), then restored into a new private temporary folder as state.db, opened writable as the
 *   runtime opens it, checked again (integrity, same counts, newest timestamps) and the folder is removed,
 *   also on Ctrl+C. It reports the restore time (RTO) and the copy's age (RPO: what a restore would lose).
 * --restaurer <copie> --confirmer [--cible <state.db>] [--sans-systemd] (real restore, Sonni stopped):
 *   refuses without --confirmer, without a matching `<copie>.sha256`, on a copy that fails integrity, and while
 *   `systemctl is-active sonni` says Sonni runs (the command is overridable by env SONNI_SYSTEMCTL, a path to
 *   an executable, for tests; without systemd it refuses unless --sans-systemd). Then it MOVES state.db and the
 *   -wal, -shm and -journal files beside it into `<dossier de la cible>/quarantaine-<horodatage UTC>/` (0700),
 *   never deleting them, copies the backup to `<cible>.restauration-partielle` (600), renames it to the
 *   target, and checks the target's SHA-256 and that no -wal or -shm is beside it. On a failure after the move
 *   it says exactly where every file is and how to put the previous ones back; the quarantine is never removed.
 *
 * Safety: neither mode writes to the copy. The drill writes only in its own temporary folder; the restore
 * writes only the target, its partial file (removed if the copy into it fails) and the quarantine folder.
 * No network, no secret printed.
 *
 * Exit codes: 0 drill passed / restore done; 1 verification failed (fingerprint, integrity, counts, restored
 * file); 2 refused or usage error (nothing moved); 3 technical error (not SQLite, disk, rights); 130
 * interrupted (temporary folders removed). The last line of stdout starts with `RÉSULTAT : code=<n>`.
 *
 * Usage:
 *   node sonni/vps/restauration.mjs --essai <copie>
 *   node sonni/vps/restauration.mjs --restaurer <copie> --confirmer [--cible <state.db>] [--sans-systemd]
 */

import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import Database from "better-sqlite3";
import { fr, isMain, liveDatabasePath, openPrivateCopy, refusal, sameFile, sha256File } from "./copie-privee.mjs";
import { Failure, SIDECARS, integrity, integrityBrief, newestTimes, pending, stamp, tableCounts, technicalFr } from "./sauvegarde.mjs";

/** `systemctl is-active` answers meaning Sonni's process exists or is about to. */
export const RUNNING = ["active", "activating", "reloading", "deactivating", "refreshing"];
/** Answers meaning Sonni is stopped. */
export const STOPPED = ["inactive", "failed"];

const say = (line = "") => process.stdout.write(`${line}\n`);
const warn = (line) => process.stderr.write(`${line}\n`);

/** The `<copie>.sha256` line (sha256sum format), null when there is none, `{ malformed: true }` when unreadable. */
export function readSha256(copie) {
  const file = `${copie}.sha256`;
  if (!fs.existsSync(file)) return null;
  const line = fs.readFileSync(file, "utf-8").split("\n")[0].trim();
  const m = /^([0-9a-fA-F]{64}) [ *](.+)$/.exec(line);
  return m ? { hash: m[1].toLowerCase(), name: m[2] } : { malformed: true };
}

/** Sonni's service state from `systemctl is-active sonni` (or SONNI_SYSTEMCTL). */
export function serviceState(env = process.env) {
  const command = env.SONNI_SYSTEMCTL || "systemctl";
  const r = spawnSync(command, ["is-active", "sonni"], { encoding: "utf-8", timeout: 15_000 });
  if (r.error) return { command, missing: r.error.code === "ENOENT", error: technicalFr(r.error) };
  return { command, state: String(r.stdout ?? "").trim().split("\n")[0].trim() };
}

/** Age in French ("3 h 05 min"), from milliseconds. */
export function ageFr(ms) {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  if (h < 48) return `${h} h ${String(minutes % 60).padStart(2, "0")} min`;
  return `${Math.floor(h / 24)} j ${h % 24} h`;
}

/** The copy's fingerprint against its .sha256 file; throws Failure(1) on a mismatch. Returns the hash. */
function checkFingerprint(copie, required) {
  const expected = readSha256(copie);
  const actual = sha256File(copie);
  if (expected === null) {
    if (required) throw new Failure(1, `Refusé : pas de fichier ${path.basename(copie)}.sha256 à côté de la copie. Une copie dont l'empreinte ne peut pas être vérifiée ne remplace pas la mémoire de Sonni.`);
    say(`Empreinte : pas de fichier .sha256 : empreinte calculée, non vérifiée (${actual}).`);
    return actual;
  }
  if (expected.malformed) throw new Failure(1, `Le fichier ${copie}.sha256 est illisible (format attendu : <empreinte>  <nom>).`);
  if (expected.hash !== actual) throw new Failure(1, `Empreinte SHA-256 différente de celle du fichier .sha256 : la copie est abîmée ou a été modifiée (attendue ${expected.hash.slice(0, 12)}…, trouvée ${actual.slice(0, 12)}…).`);
  say(`Empreinte SHA-256 : conforme au fichier .sha256 (${actual.slice(0, 12)}…)${expected.name !== path.basename(copie) ? `, qui nomme ${expected.name}` : ""}.`);
  return actual;
}

/** Integrity and row counts of the copy, read through a private read-only copy (copie-privee.mjs). */
function readCopy(copie, prefix) {
  const copy = openPrivateCopy(copie, prefix);
  pending.add(copy.close);
  try {
    const ok = integrity(copy.db);
    if (ok !== "ok") throw new Failure(1, `Intégrité de la copie en défaut : ${integrityBrief(ok)}.`);
    const portfolio = ["trader_orders", "trader_ledger", "trader_positions"].every((t) => !!copy.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t));
    return { counts: tableCounts(copy.db), newest: newestTimes(copy.db), portfolio };
  } finally {
    copy.close();
    pending.delete(copy.close);
  }
}

/** Exit code and French message of an error thrown by a step. */
function classify(err) {
  if (err instanceof Failure) return { code: err.exitCode, message: err.message };
  if (/^SQLITE_CORRUPT/.test(err?.code ?? "")) return { code: 1, message: `Base abîmée : ${technicalFr(err)}.` };
  return { code: 3, message: `Erreur technique : ${technicalFr(err)}.` };
}

/** Drill: restores the copy into a private temporary folder, checks it, measures RTO and RPO. Returns the exit code. */
export function essai(copieArg, { env = process.env, now = () => new Date() } = {}) {
  const copie = path.resolve(copieArg);
  const result = (code, extra) => {
    say(`RÉSULTAT : code=${code} essai=${code === 0 ? "réussi" : "échoué"}${extra ? ` ${extra}` : ""}`);
    return code;
  };
  const refused = refusal(copie, env);
  if (refused) {
    warn(refused);
    return result(2);
  }
  say("Essai de restauration (rien n'est touché dans ~/.automaton)");
  say(`Copie : ${copie}`);
  try {
    const hash = checkFingerprint(copie, false);
    const source = readCopy(copie, "sonni-essai-source-");
    say(`Intégrité de la copie : ok (${Object.keys(source.counts).length} tables comptées)`);

    // The restore itself, timed: the copy becomes state.db in a new private folder, opened as the runtime would.
    const started = process.hrtime.bigint();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sonni-essai-restauration-"));
    const removeDir = () => fs.rmSync(dir, { recursive: true, force: true });
    pending.add(removeDir);
    let restored;
    let ok;
    let newest;
    let seconds;
    try {
      const target = path.join(dir, "state.db");
      fs.copyFileSync(copie, target);
      const db = new Database(target);
      try {
        ok = integrity(db);
        if (ok === "ok") {
          restored = tableCounts(db);
          newest = newestTimes(db);
        }
      } finally {
        db.close();
      }
      seconds = Number(process.hrtime.bigint() - started) / 1e9;
    } finally {
      removeDir();
      pending.delete(removeDir);
    }
    if (ok !== "ok") throw new Failure(1, `Intégrité de la base restaurée en défaut : ${integrityBrief(ok)}.`);

    const gaps = Object.keys({ ...source.counts, ...restored }).filter((t) => source.counts[t] !== restored[t]);
    say("Lignes par table (copie → base restaurée) :");
    for (const t of Object.keys(source.counts)) say(`  - ${t} : ${source.counts[t]} → ${restored[t] ?? "absente"}${source.counts[t] === restored[t] ? "" : "  ÉCART"}`);
    say("Derniers horodatages :");
    for (const n of newest) say(`  - ${n.label} : ${n.value ?? "aucun"}`);
    const times = newest.map((n) => Date.parse(n.value ?? "")).filter(Number.isFinite);
    const latest = times.length ? Math.max(...times) : null;
    const ageMs = latest === null ? null : now().getTime() - latest;
    say(`Durée de la remise en place (RTO) : ${fr(seconds, 2)} s (copie, ouverture, vérification ; sans le redémarrage de Sonni)`);
    say(latest === null
      ? "Âge des données (RPO) : inconnu (aucun prix, ordre ou ligne du registre dans la copie)"
      : `Âge des données (RPO) : ${ageFr(ageMs)} (dernière donnée le ${new Date(latest).toISOString().slice(0, 19)}Z) ; une restauration perdrait tout ce qui a été écrit depuis.`);
    if (!source.portfolio) say("Attention : cette copie ne contient pas le portefeuille virtuel de Sonni.");
    if (sha256File(copie) !== hash) throw new Failure(1, "La copie a changé pendant l'essai (un autre programme l'écrit ?).");
    const extra = `tables=${Object.keys(restored).length} rto_s=${seconds.toFixed(2)} rpo_min=${ageMs === null ? "inconnu" : Math.round(ageMs / 60_000)}`;
    if (gaps.length) {
      warn(`Écart de lignes entre la copie et la base restaurée : ${gaps.join(", ")}.`);
      return result(1, extra);
    }
    say("Essai réussi : cette copie se restaure et se relit comme la base de Sonni. Dossier temporaire supprimé.");
    return result(0, extra);
  } catch (err) {
    const { code, message } = classify(err);
    warn(message);
    return result(code);
  }
}

/** Real restore (Sonni stopped, owner's decision). Returns the exit code. */
export function restaurer(copieArg, { confirmed = false, cible, sansSystemd = false, env = process.env, now = () => new Date() } = {}) {
  let quarantine = null;
  const moved = [];
  let partialMine = false;
  let placed = false;
  const result = (code, target) => {
    const state = code === 0 ? target : moved.length || placed ? "modifiée" : "inchangée";
    say(`RÉSULTAT : code=${code} cible=${state} quarantaine=${quarantine ?? "aucune"}`);
    return code;
  };
  if (!confirmed) {
    warn("Refusé : restaurer remplace la mémoire actuelle de Sonni par la copie et perd tout ce qu'il a écrit depuis "
      + "(journal, prédictions, ordres, dépenses d'inférence). C'est ta décision : relance avec --confirmer, Sonni arrêté. "
      + "Pour vérifier une copie sans rien toucher : --essai <copie>.");
    return result(2);
  }
  const copie = path.resolve(copieArg);
  const target = path.resolve(cible ?? liveDatabasePath(env));
  const targetDir = path.dirname(target);
  const partial = `${target}.restauration-partielle`;
  try {
    // Refusals first: nothing is moved before every check has passed.
    if (!fs.existsSync(copie) || !fs.statSync(copie).isFile()) throw new Failure(2, `Refusé : copie introuvable (${copie}).`);
    if (copie === target || sameFile(copie, target)) throw new Failure(2, "Refusé : la copie et la cible sont le même fichier.");
    const refused = refusal(copie, env);
    if (refused) throw new Failure(2, refused);
    if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) throw new Failure(2, `Refusé : le dossier de la cible n'existe pas (${targetDir}).`);
    if (fs.existsSync(partial)) throw new Failure(2, `Refusé : ${partial} existe déjà (reste d'une restauration interrompue ?). Examine-le puis déplace-le.`);

    say("Restauration de la mémoire de Sonni (décision du propriétaire)");
    say(`Copie : ${copie}`);
    say(`Cible : ${target}`);
    const hash = checkFingerprint(copie, true);
    const copy = readCopy(copie, "sonni-restauration-verif-");
    if (!copy.portfolio) throw new Failure(1, "Refusé : cette copie ne contient pas le portefeuille virtuel de Sonni.");
    say(`Intégrité de la copie : ok (${Object.keys(copy.counts).length} tables comptées)`);

    const service = serviceState(env);
    if (service.missing) {
      if (!sansSystemd) throw new Failure(2, `Refusé : la commande ${service.command} est introuvable, impossible de savoir si Sonni tourne. Arrête Sonni, vérifie-le, puis relance avec --sans-systemd.`);
      say("Pas de systemd : tu as indiqué que Sonni est arrêté (--sans-systemd).");
    } else if (service.error) {
      throw new Failure(2, `Refusé : impossible de savoir si Sonni tourne (${service.error}).`);
    } else if (RUNNING.includes(service.state)) {
      throw new Failure(2, "Sonni tourne : arrête-le d'abord (systemctl stop sonni).");
    } else if (!STOPPED.includes(service.state)) {
      throw new Failure(2, `Refusé : état de Sonni inattendu (« ${service.state || "vide"} »). Vérifie avec systemctl status sonni.`);
    } else say(`Sonni est arrêté (${service.state}).`);

    // The previous files go to a quarantine folder beside the target: moved, never deleted.
    const present = ["", ...SIDECARS].map((s) => `${target}${s}`).filter((f) => fs.existsSync(f));
    const previous = fs.existsSync(target) ? fs.statSync(target) : null;
    if (present.length) {
      const folder = path.join(targetDir, `quarantaine-${stamp(now())}`);
      if (fs.existsSync(folder)) throw new Failure(2, `Refusé : ${folder} existe déjà. Relance dans une seconde.`);
      fs.mkdirSync(folder, { mode: 0o700 });
      quarantine = folder;
      fs.chmodSync(quarantine, 0o700);
      for (const f of present) {
        const to = path.join(quarantine, path.basename(f));
        fs.renameSync(f, to);
        moved.push({ from: f, to });
      }
    }

    // Checked absent above: unless another program created it meanwhile, the partial file is this run's own
    // byte copy of the backup.
    try {
      fs.copyFileSync(copie, partial, fs.constants.COPYFILE_EXCL);
    } catch (err) {
      partialMine = err?.code !== "EEXIST";
      throw err;
    }
    partialMine = true;
    fs.chmodSync(partial, 0o600);
    // Run as root, the restored file keeps the previous owner, so that Sonni can open it.
    if (previous && typeof process.getuid === "function" && process.getuid() === 0) fs.chownSync(partial, previous.uid, previous.gid);
    const fd = fs.openSync(partial, "r+");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(partial, target);
    placed = true;
    try {
      const dfd = fs.openSync(targetDir, "r");
      try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
    } catch { /* a folder that cannot be synced is not an error */ }

    if (sha256File(target) !== hash) throw new Failure(1, "La base restaurée n'a pas l'empreinte de la copie.");
    const beside = SIDECARS.filter((s) => fs.existsSync(`${target}${s}`));
    if (beside.length) throw new Failure(1, `Un fichier ${beside.join(", ")} est apparu à côté de la base restaurée (un programme l'a ouverte ?).`);

    say(`Base restaurée : ${target} (empreinte vérifiée, aucun fichier -wal ni -shm à côté).`);
    if (moved.length) {
      say(`Ancienne mémoire mise de côté dans ${quarantine} (rien n'a été supprimé) :`);
      for (const m of moved) say(`  - ${m.to}`);
    } else say("Aucune base n'était en place : rien à mettre de côté.");
    say("Étapes suivantes :");
    say("  1. sudo systemctl start sonni");
    say("  2. note l'heure du démarrage (UTC), attends quelques minutes, puis lance le contrôle après démarrage :");
    say("     node sonni/vps/controle-apres-demarrage.mjs --depuis <heure UTC du démarrage>");
    if (moved.length) {
      say("Pour revenir à l'ancienne mémoire : arrête Sonni (sudo systemctl stop sonni), puis :");
      say(`  mv -f '${target}' '${target}.restauree'`);
      for (const m of moved) say(`  mv '${m.to}' '${m.from}'`);
    }
    return result(0, target);
  } catch (err) {
    const { code, message } = classify(err);
    warn(message);
    // Only this run's partial copy is ever removed (a duplicate of the backup); the quarantine never is.
    if (partialMine && !placed) {
      try {
        fs.rmSync(partial, { force: true });
      } catch { /* reported below */ }
    }
    if (moved.length || quarantine || placed) {
      warn(`ÉCHEC après ${moved.length || quarantine ? "la mise de côté de l'ancienne base" : "la mise en place de la copie"}. Où sont les fichiers :`);
      for (const m of moved) warn(`  - ${m.from} est maintenant ${m.to} (intact)`);
      if (fs.existsSync(target)) warn(`  - ${target} : base restaurée NON conforme, à déplacer${moved.length ? " avant de remettre l'ancienne" : ""}`);
      if (fs.existsSync(partial)) warn(`  - ${partial} : copie partielle, à déplacer`);
      if (moved.length) warn("Pour remettre l'ancienne mémoire (Sonni arrêté) :");
      if (fs.existsSync(target)) warn(`  mv -f '${target}' '${target}.echec'`);
      for (const m of moved) warn(`  mv '${m.to}' '${m.from}'`);
      if (quarantine) warn(`Le dossier ${quarantine} n'a pas été supprimé.`);
    }
    return result(code);
  }
}

const USAGE = "Usage : node sonni/vps/restauration.mjs --essai <copie>\n"
  + "        node sonni/vps/restauration.mjs --restaurer <copie> --confirmer [--cible <state.db>] [--sans-systemd]";

/** Parses the command line; throws a Failure(2) on a usage error. */
export function parseArgs(argv) {
  const out = { confirmed: false, sansSystemd: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--essai" || a === "--restaurer" || a === "--cible") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) throw new Failure(2, `${a} attend un chemin.\n${USAGE}`);
      out[a.slice(2)] = value;
      i += 1;
    } else if (a === "--confirmer") out.confirmed = true;
    else if (a === "--sans-systemd") out.sansSystemd = true;
    else throw new Failure(2, `Option inconnue : ${a}\n${USAGE}`);
  }
  if (!!out.essai === !!out.restaurer) throw new Failure(2, `Choisis --essai ou --restaurer.\n${USAGE}`);
  if (out.essai && (out.confirmed || out.cible || out.sansSystemd)) throw new Failure(2, `--confirmer, --cible et --sans-systemd ne servent qu'avec --restaurer.\n${USAGE}`);
  return out;
}

function main() {
  // Registered before any private copy: on Ctrl+C, a stop or a closed SSH session, every temporary folder goes.
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => {
      // The work is synchronous apart from awaits: a signal handled once the run is over (result printed)
      // keeps the run's own exit code.
      if (pending.size === 0 && process.exitCode !== undefined) process.exit(process.exitCode);
      for (const clean of pending) clean();
      process.stdout.write("Interrompu : dossiers temporaires supprimés.\nRÉSULTAT : code=130\n");
      process.exit(130);
    });
  }
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    warn(err.message);
    say("RÉSULTAT : code=2");
    process.exitCode = 2;
    return;
  }
  process.exitCode = args.essai
    ? essai(args.essai)
    : restaurer(args.restaurer, { confirmed: args.confirmed, cible: args.cible, sansSystemd: args.sansSystemd });
}

if (isMain(import.meta.url)) main();
