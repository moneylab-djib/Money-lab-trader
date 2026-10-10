#!/usr/bin/env node
/**
 * Post-start check of Sonni (controlled deployment of 2026-10-10, steps 0.1-0.3). The owner runs it on the VPS
 * as the sonni user, 10 to 15 minutes after `systemctl start sonni`, while Sonni runs. It reads the LIVE
 * database and says whether the new version is the one running and works: version and compiled program,
 * prices collected since the start, paid calls, incidents, rejected orders, positions code can value, Telegram
 * messages delivered, failures the runtime recorded, today's snapshot. Every ALERTE is a rollback trigger of
 * the guide (sonni/GUIDE-VPS.fr.md); the rollback itself stays the owner's decision. Two rules keep the alerts
 * to what the new version is responsible for:
 *   - a failure the runtime recorded is an ALERTE only when it repeats (HEALTH_REPEAT, the thresholds of
 *     src/money-lab/health.ts): one Telegram hiccup or one overloaded API call right after the start is INFO;
 *   - a rejection of an order placed before the start, which the pre-deployment check announced and the owner
 *     accepted, is INFO once the owner names the order with --ordres-acceptes (its "courtier virtuel" incident
 *     too); any other rejection stays an ALERTE, and its line says how to accept it.
 *
 * Safety: it never writes. The live database is opened read-only (readonly + query_only), and only while Sonni
 * runs: without the -wal and -shm files beside it, the database is refused before anything is opened, because a
 * read-only open of a stopped WAL database would create -wal and -shm files beside it, and the check must leave
 * nothing in Sonni's folder. (Ownership is not the reason: SQLite gives a -wal or -shm it creates the database
 * file's owner, even when root opens it.) Besides the database it only runs
 * `git -C <depot> rev-parse HEAD` and reads two compiled files. No network, no inference, no temporary file,
 * no runtime code.
 *
 * Exit codes: 0 no alert; 1 at least one ALERTE (the guide lists them as rollback triggers) or a damaged
 * database (the message then says that rolling back the code does not repair it: restoring the copy, step R1 of
 * the guide, is the owner's decision); 2 refused or usage error (too early, no -wal or -shm, unknown option,
 * unreadable --config; nothing opened);
 * 3 technical error (not SQLite, not Sonni's memory, unreadable file); 130 interrupted (nothing to clean: no
 * file is written; the check itself is synchronous, so a signal that arrives during it is handled once the
 * result is printed and keeps that result's code). The last line of stdout is `RÉSULTAT : code=<n> alertes=<a>`.
 * Times are shown as "10/10/2026 04:21 UTC", like the pre-deployment check.
 *
 * Usage: node sonni/vps/controle-apres-demarrage.mjs --depuis <ISO UTC> [--commit-attendu <sha>]
 *          [--config <automaton.json>] [--base <state.db>] [--depot <dossier du dépôt>]
 *          [--ordres-acceptes <id,id…>] [--resume]
 *   --depuis: the moment of `systemctl start sonni` (date -u +%Y-%m-%dT%H:%M:%SZ before starting)
 *   --ordres-acceptes: orders whose rejection at the first tick the pre-deployment check announced (À DÉCIDER)
 *   and the owner accepted; only orders placed before the start can be accepted.
 *   defaults: --base ~/.automaton/state.db, --config ~/.automaton/automaton.json, --depot the repository that
 *   holds this script (/opt/sonni); --resume prints a short report (at most 3,500 characters) for
 *   envoi-telegram.mjs.
 */

import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import Database from "better-sqlite3";
import { count, fr, isMain, liveDatabasePath, price } from "./copie-privee.mjs";
import { hasPortfolio } from "./audit-prix.mjs";

/** src/trader/config.ts: prices are collected every collectMinutes (the example config uses 5). */
export const DEFAULT_COLLECT_MINUTES = 5;
/** A message still unsent after this long means the Telegram channel does not deliver. */
export const OUTBOX_STUCK_MINUTES = 10;
/** Telegram allows 4,096 characters; envoi-telegram.mjs cuts at 4,000. */
export const RESUME_MAX = 3500;
/** src/money-lab/health.ts: failed agent turns and background tasks, a JSON list of {at, source, message}. */
export const HEALTH_EVENTS_KEY = "money_lab.health_events";
/**
 * How many failures of one source since the start make an ALERTE (fewer are INFO). src/money-lab/health.ts rates
 * the same events: five failed turns are a problem; three failed background tasks are worth a look; Telegram
 * network hiccups are normal, but 30 failures (five minutes of its 10-second tick) mean the channel is down.
 */
export const HEALTH_REPEAT = { turn: 5, Telegram: 30, other: 3 };
/** Incident kinds that are rollback triggers; the others are reported. */
export const ALERT_INCIDENTS = ["broker", "backup"];
/** Files of the compiled program that only the new version (step 0.3) holds, and what they must contain. */
export const FINGERPRINT = [
  { file: "dist/trader/portfolio.js", needle: "positionProblem" },
  { file: "dist/trader/incidents.js", needle: '"broker"' },
];
/** The repository this script belongs to: sonni/vps/ is two levels below it. */
export const DEFAULT_DEPOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** src/trader/incidents.ts INCIDENT_LABEL_FR. */
const INCIDENT_LABEL_FR = {
  pause: "pause automatique", cap: "plafond atteint", unknown_cost: "coût d'inférence inconnu", errors: "série d'erreurs",
  truncated: "réponse coupée", unknown_stop: "raison d'arrêt inconnue", no_progress: "cycles sans progrès",
  source_disabled: "source désactivée", reader_refused: "IA lectrice refusée", backup: "sauvegarde", loop: "boucle",
  brain_offline: "second cerveau injoignable", brain_recount: "compteur du second cerveau remis à zéro", broker: "courtier virtuel",
};

/** src/trader/portfolio.ts rejectionNoteFr: the note a rejection leaves, read in French. */
const REJECT_NOTE = /^rejected by code \((price|quantity|amount|position|nothing|suspended)\)(?:: [^[]*)?(?: \[(.*)\])?$/;
const REJECT_FR = {
  price: "prix d'exécution nul, négatif ou non fini",
  quantity: "quantité nulle, négative ou non finie",
  amount: "montant en euros non fini",
  position: "la position enregistrée a des chiffres invalides",
  nothing: "aucune position à vendre",
  suspended: "achats suspendus tant qu'une position enregistrée ne peut pas être évaluée (valeur du portefeuille et plafond inconnus)",
};
const POSITION_PROBLEM_FR = { quantity: "quantité non finie ou invalide", avg_cost: "coût moyen nul ou invalide", value: "valeur incalculable" };
const FIGURE_FR = {
  price: "prix du marché", fill_price: "prix d'exécution", quantity: "quantité", total_quantity: "quantité totale", avg_cost: "coût moyen",
  amount: "montant", fee: "frais", slippage: "glissement", proceeds: "produit de la vente", entry_fee: "frais d'achat", cost: "coût",
  pnl: "résultat", pnl_pct: "résultat en %", left: "reste", value: "valeur",
};
const VALUE_FR = (v) => (v === "Infinity" ? "infini" : v === "-Infinity" ? "moins l'infini" : v === "NaN" ? "indéfini" : v.replace(".", ","));

/** A refusal, usage error or verification with its exit code; any other error is technical (3). */
export class Failure extends Error {
  constructor(code, message) {
    super(message);
    this.exitCode = code;
  }
}

const USAGE = "Usage : node sonni/vps/controle-apres-demarrage.mjs --depuis <date ISO UTC> [--commit-attendu <commit>] [--config <automaton.json>] [--base <state.db>] [--depot <dossier>] [--ordres-acceptes <id,id…>] [--resume]";
const OPTIONS = {
  "--depuis": "depuis", "--commit-attendu": "commitAttendu", "--config": "config", "--base": "base", "--depot": "depot",
  "--ordres-acceptes": "ordresAcceptes",
};
/** An order id as src/trader/portfolio.ts writes it (o_<ulid>), or any short id of letters, digits, _ and -. */
const ORDER_ID = /^[A-Za-z0-9_-]{1,64}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})$/;

/** The start moment given with --depuis: ISO 8601 with an explicit offset (Z for UTC), never local time. */
export function parseSince(text) {
  const ms = ISO_UTC.test(text) ? Date.parse(text.replace(" ", "T")) : NaN;
  if (!Number.isFinite(ms)) {
    throw new Failure(2, `--depuis attend la date du démarrage en UTC, par exemple 2026-10-10T14:30:05Z (reçu : ${text.slice(0, 40)}). ${USAGE}`);
  }
  // Whole seconds: the start second counts as "since the start" (stored times have seconds or milliseconds).
  return new Date(Math.floor(ms / 1000) * 1000);
}

/** Parses the command line; throws a Failure(2) on a usage error. */
export function parseArgs(argv) {
  const out = { resume: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--resume") out.resume = true;
    else if (a in OPTIONS) {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) throw new Failure(2, `${a} attend une valeur. ${USAGE}`);
      out[OPTIONS[a]] = value;
      i += 1;
    } else throw new Failure(2, `Option inconnue : ${a}. ${USAGE}`);
  }
  if (!out.depuis) throw new Failure(2, `--depuis est obligatoire (date du démarrage de Sonni en UTC). ${USAGE}`);
  out.since = parseSince(out.depuis);
  if (out.commitAttendu !== undefined && !/^[0-9a-f]{7,64}$/i.test(out.commitAttendu)) {
    throw new Failure(2, `--commit-attendu attend un identifiant de commit (au moins 7 caractères hexadécimaux). ${USAGE}`);
  }
  if (out.ordresAcceptes !== undefined) {
    const ids = out.ordresAcceptes.split(/[\s,]+/).filter(Boolean);
    if (ids.length === 0 || !ids.every((id) => ORDER_ID.test(id))) {
      throw new Failure(2, `--ordres-acceptes attend des identifiants d'ordre séparés par des virgules, par exemple o_01ABC,o_01DEF. ${USAGE}`);
    }
    out.ordresAcceptes = ids;
  }
  return out;
}

const hasTable = (db, table) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
/** "2026-10-10T14:30:05": compares as "at or after" with every ISO form stored (…Z, ….123Z). */
const isoSecond = (d) => d.toISOString().slice(0, 19);
/** SQLite datetime('now') form, the one inference_costs.created_at uses. */
const sqlSecond = (d) => d.toISOString().replace("T", " ").slice(0, 19);
const minutesAgo = (from, now) => Math.max(0, Math.floor((now.getTime() - from.getTime()) / 60_000));
const pad = (n) => String(n).padStart(2, "0");
/** A stored time (or a Date) as "10/10/2026 04:21 UTC", the pre-deployment check's form; unreadable text as stored. */
export function when(ts) {
  const d = ts instanceof Date ? ts : new Date(ts ?? "");
  if (ts === null || ts === undefined || ts === "" || Number.isNaN(d.getTime())) return String(ts ?? "inconnue").slice(0, 40);
  return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}
/** A UTC day "2026-10-10" as "10/10/2026". */
const dayFr = (day) => day.split("-").reverse().join("/");

function readFailure(err) {
  if (err instanceof SyntaxError) return "JSON invalide";
  if (err?.code === "ENOENT") return "fichier introuvable";
  if (err?.code === "EACCES") return "accès refusé";
  return err?.code ? `erreur ${err.code}` : "illisible";
}

/**
 * Reads the collection interval and the owner's assets from the configuration. An unreadable default file only
 * means defaults (said in the report); an unreadable file given with --config is a usage error.
 */
export function readConfig(file, explicit = false) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (err) {
    if (explicit) throw new Failure(2, `Configuration illisible : ${file} (${readFailure(err)}). Rien n'a été ouvert.`);
    return { file: null, collectMinutes: DEFAULT_COLLECT_MINUTES, assets: null, note: `configuration ${file} illisible (${readFailure(err)}) : relevé des prix supposé toutes les ${DEFAULT_COLLECT_MINUTES} min, actifs déduits des prix des 24 h avant le démarrage` };
  }
  const trader = raw?.trader;
  const minutes = trader?.collectMinutes;
  const valid = Number.isInteger(minutes) && minutes >= 1 && minutes <= 60;
  const symbols = Array.isArray(trader?.assets) ? trader.assets.map((a) => a?.symbol).filter((s) => typeof s === "string" && /^[A-Z0-9]{1,20}$/.test(s)) : [];
  return {
    file,
    collectMinutes: valid ? minutes : DEFAULT_COLLECT_MINUTES,
    assets: symbols.length ? symbols : null,
    note: valid ? null : `pas de trader.collectMinutes valable dans ${file} : relevé des prix supposé toutes les ${DEFAULT_COLLECT_MINUTES} min`,
  };
}

/** Why the live database must not be opened (French), or null: Sonni must be running. Nothing has been opened yet. */
export function liveRefusal(base) {
  let st;
  try {
    st = fs.statSync(base);
  } catch {
    return `Refusé : base introuvable (${base}).`;
  }
  if (!st.isFile()) return `Refusé : ${base} n'est pas un fichier ordinaire.`;
  if (!fs.existsSync(`${base}-wal`)) {
    return "Sonni ne semble pas tourner : la base n'a pas de journal WAL ; ce contrôle se lance pendant qu'il tourne (systemctl is-active sonni doit afficher active). Rien n'a été ouvert.";
  }
  // A running Sonni keeps both files. Without -shm, SQLite would create it beside the live database, and the check
  // writes nothing there (SQLite would give it the database's owner even as root: the point is not writing).
  if (!fs.existsSync(`${base}-shm`)) {
    return "Sonni ne semble pas tourner : la base a un journal WAL mais pas de fichier -shm ; ce contrôle se lance pendant qu'il tourne. Rien n'a été ouvert.";
  }
  return null;
}

/** Why it is too early (or the start date is wrong), or null: a whole price collection must fit after the start. */
export function tooEarly(since, now, collectMinutes) {
  if (since.getTime() - now.getTime() > 60_000) {
    return `Refusé : --depuis (${when(since)}) est dans le futur d'après l'horloge du serveur (${when(now)}).`;
  }
  const needed = (collectMinutes + 2) * 60_000;
  const elapsed = now.getTime() - since.getTime();
  if (elapsed >= needed) return null;
  return `Trop tôt : relance dans ${Math.max(1, Math.ceil((needed - elapsed) / 60_000))} min (Sonni a démarré il y a ${minutesAgo(since, now)} min ; ` +
    `le contrôle attend un relevé de prix complet, soit ${collectMinutes + 2} min après le démarrage).`;
}

/** The live database, read-only: readonly connection plus query_only, so no statement can write. */
export function openLive(base) {
  const db = new Database(base, { readonly: true, fileMustExist: true });
  db.pragma("query_only = ON");
  return db;
}

/** The commit checked out in `depot`, or why it cannot be read (git missing, not a repository…). */
export function gitHead(depot, run = spawnSync) {
  const r = run("git", ["-C", depot, "rev-parse", "HEAD"], { encoding: "utf-8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] });
  if (r.error) return { sha: null, why: r.error.code === "ENOENT" ? "git est introuvable sur ce serveur" : `git n'a pas répondu (${r.error.code ?? "erreur"})` };
  if (r.status !== 0) return { sha: null, why: `git n'a pas pu lire le commit de ${depot} (code ${r.status})` };
  const sha = String(r.stdout).trim().toLowerCase();
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(sha)) return { sha: null, why: "git a répondu sans identifiant de commit" };
  return { sha, why: null };
}

/** What is missing from the compiled program of `depot` for it to be the new version (empty when it is). */
export function distFingerprint(depot) {
  const missing = [];
  for (const f of FINGERPRINT) {
    let text;
    try {
      text = fs.readFileSync(path.join(depot, f.file), "utf-8");
    } catch {
      missing.push(`${f.file} absent`);
      continue;
    }
    if (!text.includes(f.needle)) missing.push(`${f.file} sans ${f.needle}`);
  }
  return missing;
}

/** src/trader/universe.ts activeAssets: the given assets, then the follow/unfollow log replayed in order. */
export function followedAssets(db, baseAssets) {
  const set = new Set(baseAssets);
  if (hasTable(db, "trader_universe")) {
    for (const r of db.prepare("SELECT asset, action FROM trader_universe ORDER BY recorded_at ASC, rowid ASC").all()) {
      if (r.action === "follow") set.add(r.asset);
      else set.delete(r.asset);
    }
  }
  return set.size > 0 ? [...set] : [...baseAssets];
}

/** The note of a rejected order in French (src/trader/portfolio.ts rejectionNoteFr). */
export function rejectionFr(note) {
  const m = REJECT_NOTE.exec(note ?? "");
  // Every rejection of the new version leaves a note of this form; anything else is not translated (the note is
  // in English): /portefeuille shows it.
  if (!m) return note ? "motif non reconnu (voir /portefeuille)" : "sans motif noté";
  const detail = m[2] ?? "";
  let d = "";
  if (detail) {
    if (m[1] === "position" && detail in POSITION_PROBLEM_FR) d = POSITION_PROBLEM_FR[detail];
    else {
      const f = /^(\w+)=(.*)$/.exec(detail);
      d = f ? `${FIGURE_FR[f[1]] ?? f[1]} = ${VALUE_FR(f[2])}` : detail;
    }
  }
  return `${REJECT_FR[m[1]]}${d ? ` (${d})` : ""}`;
}

/** One finding per line: a stored message never breaks the report's layout. */
const oneLine = (text) => String(text).replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
const ok = (text) => ({ level: "OK", text: oneLine(text) });
const info = (text) => ({ level: "INFO", text: oneLine(text) });
const alert = (text) => ({ level: "ALERTE", text: oneLine(text) });
const sideFr = (side) => (side === "buy" ? "achat" : "vente");

/** 1. The commit in place and the compiled program's fingerprint. */
export function checkVersion({ depot, expected, git = spawnSync }) {
  const findings = [];
  const head = gitHead(depot, git);
  if (head.sha && !expected) findings.push(info(`commit en place : ${head.sha} (aucun commit attendu donné avec --commit-attendu)`));
  else if (head.sha && head.sha.startsWith(expected.toLowerCase())) findings.push(ok(`commit en place : ${head.sha}, celui attendu`));
  else if (head.sha) findings.push(alert(`le commit en place (${head.sha}) n'est pas celui attendu (${expected})`));
  else findings.push(info(`${head.why} : la version est contrôlée par le programme compilé seulement${expected ? ` (commit attendu ${expected} non vérifié)` : ""}`));
  const missing = distFingerprint(depot);
  if (missing.length) findings.push(alert(`le programme compilé n'est pas la nouvelle version (${missing.join(" ; ")})`));
  else findings.push(ok("programme compilé : la nouvelle version (étape 0.3) est dans dist/"));
  const summary = `${head.sha ? `commit ${head.sha.slice(0, 12)}` : "commit non lu"}${missing.length ? "" : ", programme compilé à jour"}`;
  return { title: "Version", short: "Version", findings, summary, sha: head.sha };
}

/** 2. A price since the start for every followed asset (configuration, else the prices of the day before). */
export function checkPrices(db, { since, configAssets }) {
  const findings = [];
  const from = isoSecond(since);
  let assets;
  if (configAssets) assets = followedAssets(db, configAssets);
  else {
    const before = db.prepare("SELECT DISTINCT asset FROM trader_prices WHERE ts >= ? AND ts < ? ORDER BY asset")
      .all(isoSecond(new Date(since.getTime() - 86_400_000)), from).map((r) => r.asset);
    assets = followedAssets(db, before);
  }
  if (assets.length === 0) {
    const n = db.prepare("SELECT COUNT(*) AS n FROM trader_prices WHERE ts >= ?").get(from).n;
    findings.push(n > 0 ? ok(`${count(n, "prix enregistré", "prix enregistrés")} depuis le démarrage (aucun actif connu à comparer)`) : alert("aucun prix enregistré depuis le démarrage"));
    return { title: "Prix depuis le démarrage", short: "Prix", findings, summary: `${n} prix depuis le démarrage` };
  }
  let fresh = 0;
  for (const asset of assets) {
    const n = db.prepare("SELECT COUNT(*) AS n FROM trader_prices WHERE asset = ? AND ts >= ?").get(asset, from).n;
    if (n > 0) {
      const last = db.prepare("SELECT ts, price FROM trader_prices WHERE asset = ? ORDER BY ts DESC LIMIT 1").get(asset);
      findings.push(ok(`${asset} : ${count(n, "prix", "prix")} depuis le démarrage, dernier ${price(last.price)} le ${when(last.ts)}`));
      fresh += 1;
    } else {
      const last = db.prepare("SELECT ts FROM trader_prices WHERE asset = ? ORDER BY ts DESC LIMIT 1").get(asset);
      findings.push(alert(`aucun prix de ${asset} depuis le démarrage (dernier prix : ${last ? when(last.ts) : "aucun"})`));
    }
  }
  return { title: "Prix depuis le démarrage", short: "Prix", findings, summary: `${fresh} actif(s) sur ${assets.length} avec des prix depuis le démarrage` };
}

/** 3. Paid calls since the start (INFO: the restart cycle, an owner message or a due wake explain them). */
export function checkPaidCalls(db, { since }) {
  if (!hasTable(db, "inference_costs")) return { title: "Appels payés depuis le démarrage", short: "Appels payés", findings: [info("aucune table des appels payés dans cette base")], summary: "aucune table" };
  const r = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(cost_cents), 0) AS cents FROM inference_costs WHERE created_at >= ?").get(sqlSecond(since));
  const text = r.n === 0
    ? "aucun appel payé depuis le démarrage"
    : `${count(r.n, "appel payé", "appels payés")} depuis le démarrage, ${fr(r.cents / 100)} $ (attendus : le cycle du redémarrage s'il ne dormait pas, un message de ta part, un réveil prévu)`;
  return { title: "Appels payés depuis le démarrage", short: "Appels payés", findings: [info(text)], summary: r.n === 0 ? "aucun" : `${count(r.n, "appel", "appels")}, ${fr(r.cents / 100)} $` };
}

const NO_ACCEPTED = { ids: new Set(), unknown: [] };

/**
 * The rejections the owner accepted with --ordres-acceptes: orders placed before the start (the pre-deployment
 * check could only announce those) and rejected since it. `unknown` lists the names that match no such order.
 */
export function acceptedRejections(db, { since, accepted = [] }) {
  const from = isoSecond(since);
  const ids = new Set();
  const unknown = [];
  for (const id of accepted) {
    const o = db.prepare("SELECT status, placed_at, settled_at FROM trader_orders WHERE id = ?").get(id);
    if (o && o.status === "rejected" && o.placed_at < from && o.settled_at >= from) ids.add(id);
    else unknown.push(id);
  }
  return { ids, unknown };
}

/**
 * The order a rejection incident is about (src/trader/portfolio.ts rejectOrder: "ordre <id> (vente ETH) refusé par
 * le courtier virtuel : …"); null for any other broker incident (a technical failure stays an ALERTE).
 */
const incidentOrder = (message) => /^ordre (\S+) \([^)]*\) refusé par le courtier virtuel/.exec(String(message ?? ""))?.[1] ?? null;

/** 4. Incidents since the start: the virtual broker and backups are rollback triggers, except accepted rejections. */
export function checkIncidents(db, { since, accepted = NO_ACCEPTED }) {
  const rows = hasTable(db, "trader_incidents")
    ? db.prepare("SELECT at, kind, message FROM trader_incidents WHERE at >= ? ORDER BY at, rowid").all(isoSecond(since))
    : [];
  const findings = [];
  let acceptedN = 0;
  for (const r of rows) {
    const text = `${INCIDENT_LABEL_FR[r.kind] ?? r.kind} le ${when(r.at)} : ${r.message}`;
    if (r.kind === "broker" && accepted.ids.has(incidentOrder(r.message))) {
      findings.push(info(`${text} (refus accepté avec --ordres-acceptes)`));
      acceptedN += 1;
    } else findings.push(ALERT_INCIDENTS.includes(r.kind) ? alert(text) : info(text));
  }
  const none = `aucun incident « courtier virtuel » ni « sauvegarde »${acceptedN ? " en dehors des refus acceptés" : ""}`;
  if (!findings.some((f) => f.level === "ALERTE")) findings.unshift(ok(rows.length ? none : "aucun incident depuis le démarrage"));
  return { title: "Incidents depuis le démarrage", short: "Incidents", findings, summary: rows.length ? `${count(rows.length, "incident", "incidents")}, ${none.replace("aucun incident ", "aucun ")}` : "aucun" };
}

/**
 * 5. Orders settled since the start: a rejection is a rollback trigger unless the owner accepted it; fills,
 * expiries and cancellations are reported.
 */
export function checkOrders(db, { since, accepted = NO_ACCEPTED }) {
  const from = isoSecond(since);
  const rows = db.prepare(
    "SELECT id, asset, side, status, placed_at, settled_at, note, fill_price, origin FROM trader_orders WHERE status != 'pending' AND settled_at >= ? ORDER BY settled_at, rowid",
  ).all(from);
  const findings = [];
  const n = { filled: 0, expired: 0, cancelled: 0, accepted: 0 };
  for (const o of rows) {
    const what = `ordre ${o.id} (${sideFr(o.side)} ${o.asset}${o.origin === "stop" ? ", stop" : ""})`;
    if (o.status === "rejected") {
      const text = `${what} refusé le ${when(o.settled_at)} : ${rejectionFr(o.note)}`;
      if (accepted.ids.has(o.id)) {
        findings.push(info(`${text} ; refus annoncé par le contrôle avant déploiement et accepté (--ordres-acceptes)`));
        n.accepted += 1;
      } else if (o.placed_at < from) {
        // Placed before the start: the pre-deployment check may have announced it (À DÉCIDER).
        findings.push(alert(`${text}. Si le contrôle avant déploiement avait annoncé ce refus et que tu l'avais accepté, ce n'est pas un défaut de la nouvelle version : relance le contrôle avec --ordres-acceptes ${o.id}`));
      } else findings.push(alert(text));
    } else if (o.status === "filled") findings.push(info(`${what} exécuté à ${price(o.fill_price)} le ${when(o.settled_at)}`));
    else if (o.status === "expired") findings.push(info(`${what} expiré le ${when(o.settled_at)}`));
    else if (o.status === "cancelled") findings.push(info(`${what} annulé le ${when(o.settled_at)}`));
    if (o.status in n) n[o.status] += 1;
  }
  if (accepted.unknown.length) {
    findings.push(info(`sans effet, --ordres-acceptes ${accepted.unknown.join(",")} : aucun ordre de ce nom passé avant le démarrage et refusé depuis`));
  }
  const pending = db.prepare("SELECT COUNT(*) AS n FROM trader_orders WHERE status = 'pending'").get().n;
  if (pending) findings.push(info(`${count(pending, "ordre en attente", "ordres en attente")}`));
  const refusals = n.accepted ? count(n.accepted, "refus accepté", "refus acceptés") : "aucun refus";
  if (!findings.some((f) => f.level === "ALERTE")) findings.unshift(ok(n.accepted ? "aucun refus imprévu depuis le démarrage" : "aucun ordre refusé depuis le démarrage"));
  return { title: "Ordres réglés depuis le démarrage", short: "Ordres", findings, summary: `${refusals} ; ${n.filled} exécuté(s), ${n.expired} expiré(s), ${pending} en attente` };
}

/** 6. Every open position can be valued (src/trader/portfolio.ts positionProblem and valuation). */
export function checkPortfolio(db) {
  const findings = [];
  const positions = db.prepare("SELECT asset, quantity, avg_cost FROM trader_positions WHERE quantity > 0 ORDER BY asset").all();
  const positive = (v) => Number.isFinite(v) && v > 0;
  for (const p of positions) {
    let problem = !positive(p.quantity) ? "quantity" : !positive(p.avg_cost) ? "avg_cost" : null;
    if (!problem) {
      const last = db.prepare("SELECT price FROM trader_prices WHERE asset = ? ORDER BY ts DESC LIMIT 1").get(p.asset);
      if (!Number.isFinite(p.quantity * (last ? last.price : p.avg_cost))) problem = "value";
    }
    if (problem) {
      findings.push(alert(`valeur du portefeuille non fiable : position ${p.asset} invalide (${POSITION_PROBLEM_FR[problem]} ; quantité ${Number.isFinite(p.quantity) ? p.quantity : "non finie"}, coût moyen ${price(p.avg_cost)})`));
    }
  }
  const cash = db.prepare("SELECT COALESCE(SUM(amount_eur), 0) AS v FROM trader_ledger").get().v;
  if (!Number.isFinite(cash)) findings.push(alert("valeur du portefeuille non fiable : trésorerie non finie dans le registre"));
  const n = positions.length;
  const valued = n === 0 ? "aucune position ouverte" : n === 1 ? "1 position ouverte, évaluable" : `${n} positions ouvertes, toutes évaluables`;
  if (findings.length === 0) findings.push(ok(`${valued} ; trésorerie ${fr(cash)} €`));
  return { title: "Portefeuille", short: "Portefeuille", findings, summary: valued };
}

/** 7. Telegram delivers: no owner message left unsent for more than 10 minutes. */
export function checkTelegram(db, { since, now }) {
  if (!hasTable(db, "money_lab_outbox")) return { title: "Messages Telegram", short: "Telegram", findings: [info("pas de file de messages Telegram dans cette base")], summary: "pas de file" };
  const findings = [];
  const limit = new Date(now.getTime() - OUTBOX_STUCK_MINUTES * 60_000).toISOString();
  const stuck = db.prepare("SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM money_lab_outbox WHERE sent_at IS NULL AND created_at < ?").get(limit);
  const recent = db.prepare("SELECT COUNT(*) AS n FROM money_lab_outbox WHERE sent_at IS NULL AND created_at >= ?").get(limit).n;
  const sent = db.prepare("SELECT COUNT(*) AS n FROM money_lab_outbox WHERE sent_at >= ?").get(isoSecond(since)).n;
  if (stuck.n > 0) {
    findings.push(alert(`messages Telegram en attente : ${count(stuck.n, "message non envoyé", "messages non envoyés")} depuis plus de ${OUTBOX_STUCK_MINUTES} min (le plus ancien du ${when(stuck.oldest)})`));
  } else findings.push(ok(`aucun message en attente depuis plus de ${OUTBOX_STUCK_MINUTES} min${sent ? ` ; ${count(sent, "message envoyé", "messages envoyés")} depuis le démarrage` : ""}`));
  if (recent) findings.push(info(`${count(recent, "message de moins de 10 min pas encore envoyé", "messages de moins de 10 min pas encore envoyés")}`));
  return { title: "Messages Telegram", short: "Telegram", findings, summary: `aucun message en attente${sent ? `, ${sent} envoyé(s)` : ""}` };
}

/**
 * 8. Failures the runtime recorded since the start (failed agent turns, failed background tasks), one line per
 * source: an ALERTE when the source failed HEALTH_REPEAT times or more, else INFO (a passing failure).
 */
export function checkHealth(db, { since }) {
  let events = [];
  let unreadable = false;
  if (hasTable(db, "kv")) {
    const raw = db.prepare("SELECT value FROM kv WHERE key = ?").get(HEALTH_EVENTS_KEY)?.value;
    try {
      const parsed = JSON.parse(raw ?? "[]");
      events = Array.isArray(parsed) ? parsed : [];
    } catch {
      unreadable = true;
    }
  }
  // Per source, in the order of their first failure: how many since the start, and the latest.
  const groups = new Map();
  for (const e of events) {
    if (!e || typeof e.at !== "string" || !(Date.parse(e.at) >= since.getTime())) continue;
    const source = String(e.source ?? "inconnue");
    const g = groups.get(source) ?? { n: 0, last: e };
    g.n += 1;
    if (Date.parse(e.at) >= Date.parse(g.last.at)) g.last = e;
    groups.set(source, g);
  }
  const findings = [];
  let total = 0;
  for (const [source, g] of groups) {
    total += g.n;
    const limit = source === "turn" ? HEALTH_REPEAT.turn : source === "Telegram" ? HEALTH_REPEAT.Telegram : HEALTH_REPEAT.other;
    const who = source === "turn" ? "tour de l'agent en échec" : `tâche ${source.slice(0, 40)} en échec`;
    const text = `${who} ${g.n} fois depuis le démarrage (dernière fois le ${when(g.last.at)}) : « ${String(g.last.message ?? "").slice(0, 300)} »`;
    findings.push(g.n >= limit ? alert(text) : info(`${text} ; passager, alerte à partir de ${limit} échecs`));
  }
  if (unreadable) findings.push(info("journal de santé illisible (money_lab.health_events)"));
  if (!findings.some((f) => f.level === "ALERTE")) findings.unshift(ok(total ? "aucune panne répétée depuis le démarrage" : "aucune panne enregistrée depuis le démarrage"));
  const summary = total ? `${count(total, "échec passager", "échecs passagers")}, aucune panne répétée` : "aucune panne enregistrée";
  return { title: "Santé (pannes enregistrées)", short: "Santé", findings, summary };
}

/** 9. Today's portfolio snapshot (UTC day): written at the first broker pass of the day when the portfolio can be valued. */
export function checkSnapshot(db, { now }) {
  const day = now.toISOString().slice(0, 10);
  const row = hasTable(db, "trader_portfolio_days") ? db.prepare("SELECT at, equity_eur FROM trader_portfolio_days WHERE day = ?").get(day) : undefined;
  const text = row
    ? `instantané du ${dayFr(day)} présent (valeur ${fr(row.equity_eur)} €, pris le ${when(row.at)})`
    : `pas encore d'instantané pour le ${dayFr(day)} : il est pris au premier passage du courtier du jour, si le portefeuille est évaluable`;
  return { title: "Instantané du jour", short: "Instantané du jour", findings: [info(text)], summary: row ? "présent" : "absent pour l'instant" };
}

/** The nine checks, in order. `accepted`: the order ids given with --ordres-acceptes. */
export function runChecks(db, { since, now, configAssets, depot, expected, git = spawnSync, accepted = [] }) {
  const acc = acceptedRejections(db, { since, accepted });
  return [
    checkVersion({ depot, expected, git }),
    checkPrices(db, { since, configAssets }),
    checkPaidCalls(db, { since }),
    checkIncidents(db, { since, accepted: acc }),
    checkOrders(db, { since, accepted: acc }),
    checkPortfolio(db),
    checkTelegram(db, { since, now }),
    checkHealth(db, { since }),
    checkSnapshot(db, { now }),
  ];
}

export const statusOf = (check) => (check.findings.some((f) => f.level === "ALERTE") ? "ALERTE" : check.findings.some((f) => f.level === "OK") ? "OK" : "INFO");
export const alertCount = (checks) => checks.reduce((n, c) => n + c.findings.filter((f) => f.level === "ALERTE").length, 0);

const SHOWN_PER_CHECK = 12;
const clip = (text, max) => (text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`);

/** The full French report (one line per finding, at most 12 per check). */
export function fullReport(checks, { base, since, now, expected, config, accepted = [] }) {
  const alerts = alertCount(checks);
  const lines = [
    "Contrôle après démarrage de Sonni — base active lue sans rien écrire",
    `Base : ${base}`,
    `Démarrage : ${when(since)} (il y a ${minutesAgo(since, now)} min)`,
    `Commit attendu : ${expected ?? "non donné"}`,
    `Configuration : ${config.file ? `${config.file} (relevé des prix toutes les ${config.collectMinutes} min)` : "valeurs par défaut"}`,
  ];
  if (accepted.length) lines.push(`Refus acceptés (--ordres-acceptes) : ${accepted.join(", ")}`);
  if (config.note) lines.push(`INFO : ${config.note}`);
  lines.push("");
  checks.forEach((c, i) => {
    lines.push(`${i + 1}. ${c.title} : ${statusOf(c)}`);
    // Alerts first, so a long list never hides one.
    const ordered = [...c.findings.filter((f) => f.level === "ALERTE"), ...c.findings.filter((f) => f.level !== "ALERTE")];
    for (const f of ordered.slice(0, SHOWN_PER_CHECK)) lines.push(`   - ${f.level} : ${f.text}`);
    if (ordered.length > SHOWN_PER_CHECK) {
      const hidden = ordered.slice(SHOWN_PER_CHECK);
      const hiddenAlerts = hidden.filter((f) => f.level === "ALERTE").length;
      lines.push(`   - … et ${hidden.length} autre(s)${hiddenAlerts ? `, dont ${count(hiddenAlerts, "alerte", "alertes")}` : ""}`);
    }
  });
  lines.push("");
  lines.push(alerts === 0
    ? "Conclusion : aucune alerte. Continue l'observation de 24 heures du guide."
    : `Conclusion : ${count(alerts, "alerte", "alertes")}. Ce sont des déclencheurs de retour arrière (guide, « Retour arrière ») : décide avant de laisser Sonni continuer.`);
  lines.push("Rien n'a été écrit : la base active a été ouverte en lecture seule.");
  return lines;
}

/** The short French report for Telegram: verdict, commit, start time, one line per check, at most 3,500 characters. */
export function shortReport(checks, { since, now, expected, code }) {
  const alerts = alertCount(checks);
  const sha = checks[0]?.sha;
  const head = [
    `Sonni — contrôle après démarrage : ${alerts === 0 ? "aucune alerte" : `${count(alerts, "alerte", "alertes")}, retour arrière à décider`}`,
    `Commit : ${sha ? sha.slice(0, 12) : "non lu"}${expected ? ` (attendu ${expected})` : ""}`,
    `Démarrage : ${when(since)} (il y a ${minutesAgo(since, now)} min)`,
  ];
  const tail = `RÉSULTAT : code=${code} alertes=${alerts}`;
  // Every line ends with a newline once printed: the whole output, RÉSULTAT line included, stays within the limit.
  const fixed = head.join("\n").length + tail.length + checks.length + 3;
  const per = Math.max(40, Math.floor((RESUME_MAX - fixed) / Math.max(1, checks.length)));
  const body = checks.map((c, i) => {
    const firstAlert = c.findings.find((f) => f.level === "ALERTE");
    const more = c.findings.filter((f) => f.level === "ALERTE").length - 1;
    const text = firstAlert ? `${firstAlert.text}${more > 0 ? ` (+${count(more, "autre alerte", "autres alertes")})` : ""}` : c.summary;
    return clip(`${i + 1}. ${c.short} : ${statusOf(c)} — ${text}`, per);
  });
  const lines = [...head, ...body, tail];
  return lines.join("\n").length < RESUME_MAX ? lines : [...head, ...body.map((l) => clip(l, 40)), tail];
}

/** Technical errors in French: SQLite and file system codes, never a secret. */
export function technicalFr(err) {
  const code = typeof err?.code === "string" ? err.code : "";
  const known = {
    SQLITE_NOTADB: "ce fichier n'est pas une base SQLite",
    SQLITE_CORRUPT: "base abîmée (SQLite la dit corrompue)",
    SQLITE_CANTOPEN: "impossible d'ouvrir la base",
    SQLITE_BUSY: "base occupée par un autre programme",
    SQLITE_IOERR: "erreur de lecture sur le disque",
    EACCES: "accès refusé (droits du fichier : lance le contrôle avec sudo -u sonni -H)",
    ENOENT: "fichier introuvable",
  };
  const k = Object.keys(known).find((c) => code === c || code.startsWith(`${c}_`));
  if (k) return `${known[k]} (${code})`;
  // Never the error's own text: it is in English.
  return code ? `erreur technique (${code})` : `erreur technique inattendue${err?.name ? ` (${String(err.name).slice(0, 40)})` : ""}`;
}

/**
 * Runs the check and writes the report with `say` (stdout), refusals and errors with `warn` (stderr). Returns
 * `{ code, alerts }`; never exits, so tests can call it with an injected clock and git.
 */
export function controleApresDemarrage(options = {}) {
  const env = options.env ?? process.env;
  const say = options.say ?? ((line = "") => process.stdout.write(`${line}\n`));
  const warn = options.warn ?? ((line) => process.stderr.write(`${line}\n`));
  const now = options.now ?? new Date();
  const resume = !!options.resume;
  const done = (code, alerts, message) => {
    if (message) {
      warn(message);
      // The short report goes to Telegram: it must say why there is no check. A damaged database is an alert
      // of the report itself.
      if (resume) say(`Sonni — contrôle après démarrage impossible : ${message}`);
      else if (alerts > 0) say(`ALERTE : ${message}`);
    }
    say(`RÉSULTAT : code=${code} alertes=${alerts}`);
    return { code, alerts };
  };
  if (!(options.since instanceof Date)) return done(2, 0, `--depuis est obligatoire. ${USAGE}`);
  const since = options.since;
  const home = env.HOME || os.homedir();
  const base = path.resolve(options.base ?? liveDatabasePath(env));
  const depot = path.resolve(options.depot ?? DEFAULT_DEPOT);

  const refused = liveRefusal(base);
  if (refused) return done(2, 0, refused);
  let config;
  try {
    config = readConfig(options.config ? path.resolve(options.config) : path.join(home, ".automaton", "automaton.json"), !!options.config);
  } catch (err) {
    if (err instanceof Failure) return done(err.exitCode, 0, err.message);
    throw err;
  }
  const early = tooEarly(since, now, config.collectMinutes);
  if (early) return done(2, 0, early);

  let db;
  try {
    db = openLive(base);
    if (!hasPortfolio(db) || !hasTable(db, "trader_prices")) {
      return done(3, 0, "Cette base ne contient pas la mémoire de Sonni (tables du portefeuille absentes) : rien n'a été contrôlé.");
    }
    const accepted = options.ordresAcceptes ?? [];
    const checks = runChecks(db, { since, now, configAssets: config.assets, depot, expected: options.commitAttendu, git: options.git, accepted });
    const alerts = alertCount(checks);
    const code = alerts > 0 ? 1 : 0;
    const lines = resume
      ? shortReport(checks, { since, now, expected: options.commitAttendu, code }).slice(0, -1)
      : fullReport(checks, { base, since, now, expected: options.commitAttendu, config, accepted });
    for (const line of lines) say(line);
    return done(code, alerts);
  } catch (err) {
    // A damaged live database is an alert (1), and rolling back the code does not repair it; anything else is
    // technical (3).
    const corrupt = /^SQLITE_CORRUPT/.test(err?.code ?? "");
    const remedy = corrupt
      ? " Le retour arrière du code ne répare pas la base : la remettre en état, c'est restaurer la copie d'avant le déploiement" +
        " (guide, « Retour arrière », étape R1 : restauration.mjs --restaurer COPIE --confirmer), sur ta décision."
      : "";
    return done(corrupt ? 1 : 3, corrupt ? 1 : 0, `Contrôle impossible : ${technicalFr(err)}. Rien n'a été écrit.${remedy}`);
  } finally {
    try { db?.close(); } catch { /* nothing */ }
  }
}

function main() {
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => {
      // The check is synchronous: a signal handled after the result was printed keeps the run's exit code.
      if (process.exitCode !== undefined) process.exit(process.exitCode);
      process.stdout.write("Interrompu : rien n'a été écrit.\nRÉSULTAT : code=130 alertes=0\n");
      process.exit(130);
    });
  }
  // A closed pipe (the reader stopped) is not an error of the check.
  process.stdout.on("error", () => {});
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    // As in controleApresDemarrage: a short report piped to Telegram says why there is no check.
    if (process.argv.includes("--resume")) process.stdout.write(`Sonni — contrôle après démarrage impossible : ${err.message}\n`);
    process.stdout.write("RÉSULTAT : code=2 alertes=0\n");
    process.exitCode = 2;
    return;
  }
  const { code } = controleApresDemarrage(args);
  process.exitCode = code;
}

if (isMain(import.meta.url)) main();
