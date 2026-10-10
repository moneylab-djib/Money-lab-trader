#!/usr/bin/env node
/**
 * Rollback guard (2026-10-10). The versions before step 0.3 round fills to the cent: below 1 EUR a fill drifts from
 * the market, below 0.005 EUR a buy gets an infinite quantity and a sale a price of 0, and those rows (trades and the
 * ledger are append-only) can never be corrected. Going back to such a version is only allowed when the owner's pause
 * is really recorded in Sonni's memory and nothing the old broker does on its own during the pause can damage the
 * history. During the pause the old versions run no paid cycle (the model places no order), but their broker timer
 * still fills pending orders and places stop sales (src/index.ts, "Sonni prix").
 *
 * Checks, each OK or ÉCHEC:
 *   1. the pause is recorded (kv money_lab.paused, set by /pause or `node dist/index.js --money-lab pause`);
 *   2. no buy order is pending: the old broker would fill it, which resumes buying with the old version;
 *   3. sales the old broker may make on its own, under 1 EUR: a pending sale or a stop on a position whose last price
 *      (or limit or stop level) is under 1 EUR would be recorded at a price rounded to the cent (up to 0.005 EUR off a
 *      unit, i.e. 0.005 / price of the value). Refused unless the owner's GO names the asset
 *      (`--accepter-arrondi BTC,USDC`); under 1 cent never (the sale could be recorded at 0);
 *   4. every open position has a stored price (otherwise the first price the old version collects could trigger a
 *      stop nobody checked);
 *   5. the gate's blocking checks (controle-predeploiement.mjs: invalid positions, ledger reconciliation, cash, orders
 *      and trades): no BLOQUANT. No version starts on data the gate refuses;
 *   6. with --en-marche (after the old version started; --depuis is then required): no buy placed or filled since
 *      that moment, no sale filled since under 1 EUR on an asset the GO did not name, and a pause recorded before
 *      that moment (a later one means it was lifted, then set again);
 *   7. with --copie: the copy is not older than Sonni's database (its file and -wal), so a daily backup or an earlier
 *      copy cannot stand in for a fresh one; the live database must be there (its modification time only is read).
 * On the live database every check reads inside one read transaction: a broker fill cannot fall between two of them.
 *
 * Safety: --copie reads a private copy of a copy (copie-privee.mjs, never the live file); --en-marche opens the live
 * database read-only while Sonni runs (refused when its -wal or -shm is missing, see controle-apres-demarrage.mjs).
 * It writes nothing.
 *
 * Exit codes: 0 every check OK (the rollback may go on); 1 at least one ÉCHEC (do not start the old version, or stop
 * it); 2 refused, too early or usage error (nothing read); 3 technical error. The last line of stdout is
 * `RÉSULTAT : code=<n> pause=<oui|non> achats_en_attente=<n> ventes_a_risque=<n> positions_sans_prix=<n>
 * bloquants=<n> achats_depuis=<n|non vérifié> ventes_depuis=<n|non vérifié>`.
 *
 * Usage:
 *   node sonni/vps/verifier-pause.mjs --copie <copie> [--accepter-arrondi <actif,…>]       (Sonni arrêté)
 *   node sonni/vps/verifier-pause.mjs --en-marche --depuis <ISO UTC> [--accepter-arrondi <actif,…>]  (Sonni en marche)
 *   [--base <state.db>] replaces ~/.automaton/state.db and [--config <automaton.json>] ~/.automaton/automaton.json.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { isMain, liveDatabasePath, openPrivateCopy, price, refusal } from "./copie-privee.mjs";
import { liveRefusal, openLive, parseSince, readConfig as readStartConfig, tooEarly, when } from "./controle-apres-demarrage.mjs";
import { controle, copyMoment, followedAssets, readConfig as readGateConfig } from "./controle-predeploiement.mjs";

/** Below this price, the old broker's cent rounding can record a sale at 0: never accepted. */
export const SUB_CENT_EUR = 0.01;
/** Below this price, the old broker's cent rounding is more than 0.5 % of the value. */
export const PRECISION_EUR = 1;

const USAGE = "Usage : node sonni/vps/verifier-pause.mjs --copie <copie> | --en-marche --depuis <date ISO UTC> [--accepter-arrondi <actif,…>] [--base <state.db>] [--config <automaton.json>]";
const ASSET = /^[A-Z0-9]{1,20}$/;

class Refused extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function parseArgs(argv) {
  const out = { mode: null, copie: null, depuis: null, base: null, config: null, accepted: [] };
  const setMode = (m) => {
    if (out.mode && out.mode !== m) throw new Refused(2, `--copie et --en-marche ne vont pas ensemble. ${USAGE}`);
    out.mode = m;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[i + 1];
      if (!v || v.startsWith("--")) throw new Refused(2, `${a} attend une valeur. ${USAGE}`);
      i += 1;
      return v;
    };
    if (a === "--copie") {
      setMode("copie");
      out.copie = value();
    } else if (a === "--en-marche") setMode("live");
    else if (a === "--depuis") out.depuis = parseSince(value());
    else if (a === "--base") out.base = value();
    else if (a === "--config") out.config = value();
    else if (a === "--accepter-arrondi") {
      out.accepted = value().split(",").map((s) => s.trim()).filter(Boolean);
      const bad = out.accepted.find((s) => !ASSET.test(s));
      if (bad !== undefined || out.accepted.length === 0) throw new Refused(2, `--accepter-arrondi attend des actifs séparés par des virgules, par exemple USDC,ADA. ${USAGE}`);
    } else throw new Refused(2, `Option inconnue : ${a}. ${USAGE}`);
  }
  if (!out.mode) throw new Refused(2, `Choisis --copie <copie> (Sonni arrêté) ou --en-marche --depuis <date> (Sonni en marche). ${USAGE}`);
  if (out.mode === "live" && !out.depuis) throw new Refused(2, `--en-marche demande --depuis, le moment du démarrage de l'ancienne version (cat /root/sonni-retour.txt). ${USAGE}`);
  if (out.mode !== "live" && (out.depuis || out.base)) throw new Refused(2, `--depuis et --base ne servent qu'avec --en-marche. ${USAGE}`);
  return out;
}

const hasTable = (db, table) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
const pct = (v) => `${(v * 100).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} %`;
/** Largest share of a unit's value the cent rounding can take, at this price. */
const roundingShare = (p) => (p > 0 ? 0.005 / p : Infinity);

/**
 * Runs the checks on an open read-only database. `gateCtx` is the gate's context (now, staleMinutes, portfolio,
 * assets, notes) or null to skip the gate. Returns `{ lines, failures, counts }`.
 */
export function verifier(db, { depuis = null, accepted = [], gateCtx = null, freshness = null } = {}) {
  const lines = [];
  let failures = 0;
  const ok = (text) => lines.push(`- OK : ${text}`);
  const fail = (text) => {
    failures += 1;
    lines.push(`- ÉCHEC : ${text}`);
  };
  const info = (text) => lines.push(`  · ${text}`);
  if (!hasTable(db, "kv") || !hasTable(db, "trader_orders") || !hasTable(db, "trader_positions")) {
    throw new Refused(3, "Ce n'est pas la mémoire de Sonni (tables kv, trader_orders ou trader_positions absentes).");
  }
  const acceptedSet = new Set(accepted);
  // 7. The copy is not older than the live database (its own check, done by the caller from file times).
  if (freshness) {
    if (freshness.ok) ok(freshness.text);
    else fail(freshness.text);
  }
  const hasPrices = hasTable(db, "trader_prices");
  const lastPrice = (asset) => (hasPrices ? db.prepare("SELECT ts, price FROM trader_prices WHERE asset = ? ORDER BY ts DESC LIMIT 1").get(asset) : undefined);
  const priced = (asset) => {
    const p = lastPrice(asset);
    return p ? `dernier prix ${price(p.price)} (${when(p.ts)})` : "aucun prix enregistré";
  };

  // 1. The pause, as the runtime reads it (a record it cannot parse still counts as paused: fail closed).
  const raw = db.prepare("SELECT value FROM kv WHERE key = 'money_lab.paused'").get();
  if (!raw) fail("aucune pause enregistrée : l'ancienne version lancerait des cycles et pourrait acheter. Enregistre la pause (commande du guide), puis relance ce contrôle.");
  else {
    let detail = "enregistrement illisible, compté comme une pause";
    let at = NaN;
    try {
      const state = JSON.parse(raw.value);
      at = Date.parse(state.at);
      detail = `depuis ${when(state.at)}${state.reason ? ` (${String(state.reason).slice(0, 120)})` : ""}`;
    } catch { /* fail closed, said above */ }
    if (depuis && Number.isFinite(at) && at >= depuis.getTime()) {
      fail(`pause enregistrée ${detail}, après le démarrage du ${when(depuis)} : elle a été levée puis remise pendant que l'ancienne version tournait. Arrête Sonni (systemctl stop sonni) et envoie-moi ce rapport.`);
    } else ok(`pause enregistrée ${detail}`);
  }

  // 2. Pending buys: the broker fills them during the pause, which would be a buy by the old version.
  const pendingBuys = db.prepare("SELECT id, asset, kind, amount_eur, limit_price, placed_at, horizon_until FROM trader_orders WHERE status = 'pending' AND side = 'buy' ORDER BY placed_at").all();
  if (pendingBuys.length === 0) ok("aucun ordre d'achat en attente");
  else {
    fail(`${pendingBuys.length} ordre(s) d'achat en attente : l'ancienne version les exécuterait, même en pause. Ne reviens pas en arrière tant qu'ils attendent : garde la nouvelle version (en pause) jusqu'à leur exécution ou leur échéance, ou laisse Sonni arrêté et envoie-moi ce rapport.`);
    for (const o of pendingBuys) info(`${o.id} : achat ${o.kind === "limit" ? `à cours limité (${price(o.limit_price)})` : "au marché"} de ${o.asset} pour ${o.amount_eur ?? "?"} € passé le ${when(o.placed_at)}, échéance ${when(o.horizon_until)} ; ${priced(o.asset)}`);
  }

  // 3 and 4. Sales the old broker may make on its own (pending sales, stops), and positions without a price.
  const positions = db.prepare("SELECT asset, quantity, avg_cost, invalidation FROM trader_positions WHERE quantity > 0 ORDER BY asset").all();
  const pendingSells = db.prepare("SELECT id, asset, kind, limit_price, quantity FROM trader_orders WHERE status = 'pending' AND side = 'sell' ORDER BY placed_at").all();
  const assets = [...new Set([...positions.map((p) => p.asset), ...pendingSells.map((o) => o.asset)])].sort();
  let atRisk = 0;
  let noPrice = 0;
  for (const asset of assets) {
    const position = positions.find((p) => p.asset === asset);
    const sells = pendingSells.filter((o) => o.asset === asset);
    const last = lastPrice(asset);
    if (position && !last) {
      noPrice += 1;
      fail(`position ${asset} sans aucun prix enregistré : le premier prix que l'ancienne version relèverait pourrait déclencher un stop que personne n'a vérifié. Laisse Sonni arrêté et envoie-moi ce rapport.`);
      continue;
    }
    // The levels a sale could be filled at: the last price, each limit and the stop.
    const levels = [last?.price, ...sells.map((o) => o.limit_price), position?.invalidation].filter((v) => typeof v === "number" && Number.isFinite(v) && v > 0);
    if (levels.length === 0) continue;
    const low = Math.min(...levels);
    const hasStop = !!position && position.invalidation !== null && position.invalidation !== undefined;
    const what = [sells.length ? `${sells.length} vente(s) en attente` : null, hasStop ? `stop à ${price(position.invalidation)}` : null].filter(Boolean).join(" et ");
    if (low < SUB_CENT_EUR) {
      atRisk += 1;
      fail(`${asset} : ${priced(asset)}${what ? `, ${what}` : ""}, sous 1 centime : l'ancienne version pourrait enregistrer une vente à un prix arrondi à 0. Aucun GO ne lève ce point : laisse Sonni arrêté et envoie-moi ce rapport.`);
    } else if (low < PRECISION_EUR && (sells.length > 0 || hasStop)) {
      const text = `${asset} : ${priced(asset)}, ${what} : l'ancienne version vendrait au centime près, jusqu'à ${pct(roundingShare(low))} de la valeur d'une unité (clé vente-arrondie:${asset})`;
      if (acceptedSet.has(asset)) info(`${text} — accepté par ton GO (--accepter-arrondi).`);
      else {
        atRisk += 1;
        fail(`${text}. Ne reviens pas en arrière sans décision : ton GO peut l'accepter en nommant l'actif (--accepter-arrondi ${asset}).`);
      }
    } else if (low < PRECISION_EUR) {
      info(`${asset} : ${priced(asset)}, ni stop ni vente en attente : l'ancienne version ne la vendra pas seule (le modèle est en pause).`);
    }
  }
  if (atRisk === 0 && noPrice === 0) ok(`aucune vente à risque d'arrondi sans ton accord (${positions.length} position(s) ouverte(s), ${pendingSells.length} vente(s) en attente)`);

  // 5. The gate's blocking checks (BLOQUANT): no version starts on data the gate refuses.
  let blocking = null;
  if (gateCtx) {
    const { findings } = controle(db, gateCtx);
    const b = findings.filter((f) => f.level === "B");
    blocking = b.length;
    if (b.length === 0) ok("aucune anomalie BLOQUANT du contrôle avant déploiement (positions, registre, liquidités, ordres et opérations)");
    else {
      fail(`${b.length} anomalie(s) BLOQUANT du contrôle avant déploiement : aucune version ne redémarre sur ces données avant une réparation séparée, que tu décides. Laisse Sonni arrêté et envoie-moi ce rapport.`);
      for (const f of b) info(f.text);
    }
  }

  // 6. After the old version started: nothing bought since, no sale under 1 EUR the GO did not accept.
  let buysSince = null;
  let sellsSince = null;
  if (depuis) {
    const iso = depuis.toISOString().slice(0, 19);
    const placed = db.prepare("SELECT id, asset, placed_at FROM trader_orders WHERE side = 'buy' AND substr(placed_at, 1, 19) >= ? ORDER BY placed_at").all(iso);
    const filled = db.prepare("SELECT id, asset, settled_at, fill_price FROM trader_orders WHERE side = 'buy' AND status = 'filled' AND substr(settled_at, 1, 19) >= ? ORDER BY settled_at").all(iso);
    buysSince = new Set([...placed, ...filled].map((o) => o.id)).size;
    if (buysSince === 0) ok(`aucun achat passé ni exécuté depuis le ${when(depuis)}`);
    else {
      fail(`${buysSince} achat(s) depuis le ${when(depuis)} : arrête Sonni tout de suite (systemctl stop sonni) et envoie-moi ce rapport.`);
      for (const o of placed) info(`${o.id} : achat de ${o.asset} passé le ${when(o.placed_at)}`);
      for (const o of filled) info(`${o.id} : achat de ${o.asset} exécuté le ${when(o.settled_at)} à ${price(o.fill_price)}`);
    }
    const sold = db.prepare("SELECT id, asset, settled_at, fill_price, origin FROM trader_orders WHERE side = 'sell' AND status = 'filled' AND substr(settled_at, 1, 19) >= ? ORDER BY settled_at").all(iso);
    const risky = sold.filter((o) => !(Number.isFinite(o.fill_price) && o.fill_price >= PRECISION_EUR) && !(acceptedSet.has(o.asset) && o.fill_price >= SUB_CENT_EUR));
    sellsSince = risky.length;
    for (const o of sold.filter((s) => !risky.includes(s))) info(`${o.id} : vente${o.origin === "stop" ? " (stop)" : ""} de ${o.asset} exécutée le ${when(o.settled_at)} à ${price(o.fill_price)}`);
    if (risky.length === 0) ok(`aucune vente sous 1 € sans ton accord depuis le ${when(depuis)}`);
    else {
      fail(`${risky.length} vente(s) sous 1 € depuis le ${when(depuis)}, arrondie(s) au centime par l'ancienne version : arrête Sonni tout de suite (systemctl stop sonni) et envoie-moi ce rapport.`);
      for (const o of risky) info(`${o.id} : vente${o.origin === "stop" ? " (stop)" : ""} de ${o.asset} exécutée le ${when(o.settled_at)} à ${price(o.fill_price)}`);
    }
  }
  return { lines, failures, counts: { paused: !!raw, pendingBuys: pendingBuys.length, atRisk, noPrice, blocking, buysSince, sellsSince } };
}

/**
 * Whether the copy is at least as recent as Sonni's database: none of the live file and its -wal was modified after
 * the copy was written. Only modification times are read; the live database is never opened.
 */
export function copyFreshness(copyFile, liveFile) {
  let copyTime;
  try {
    copyTime = fs.statSync(copyFile).mtimeMs;
  } catch {
    return { ok: false, text: `copie illisible : ${copyFile}` };
  }
  const times = [];
  for (const f of [liveFile, `${liveFile}-wal`]) {
    try {
      times.push({ f, t: fs.statSync(f).mtimeMs });
    } catch { /* absent */ }
  }
  if (!times.some((x) => x.f === liveFile)) {
    return { ok: false, text: `base de Sonni introuvable (${liveFile}) : impossible de savoir si la copie est à jour. Lance la vérification en sonni (sudo -u sonni -H) sur la copie que la sauvegarde vient de faire.` };
  }
  const newer = times.filter((x) => x.t > copyTime);
  if (newer.length === 0) return { ok: true, text: "copie à jour : la base de Sonni n'a pas changé depuis qu'elle a été faite" };
  return { ok: false, text: `copie plus ancienne que la base de Sonni (${newer.map((x) => path.basename(x.f)).join(", ")} modifié après la copie) : elle ne dit pas l'état actuel. Refais la sauvegarde (étape R4) et vérifie la nouvelle copie (COPIE_RETOUR).` };
}

export function resultLine(code, counts) {
  const n = (v) => (v === null || v === undefined ? "non vérifié" : v);
  if (!counts) return `RÉSULTAT : code=${code} pause=inconnue achats_en_attente=inconnu ventes_a_risque=inconnu positions_sans_prix=inconnu bloquants=inconnu achats_depuis=non vérifié ventes_depuis=non vérifié`;
  return `RÉSULTAT : code=${code} pause=${counts.paused ? "oui" : "non"} achats_en_attente=${counts.pendingBuys} ventes_a_risque=${counts.atRisk} `
    + `positions_sans_prix=${counts.noPrice} bloquants=${n(counts.blocking)} achats_depuis=${n(counts.buysSince)} ventes_depuis=${n(counts.sellsSince)}`;
}

/** Runs the whole check; returns the exit code and never exits. `clock` is the real time (tests may fix it). */
export function verifierPause(argv, { env = process.env, clock = () => new Date(), say = (l = "") => process.stdout.write(`${l}\n`), warn = (l) => process.stderr.write(`${l}\n`) } = {}) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    const code = err.code ?? err.exitCode ?? 2; // parseSince throws the post-start check's Failure (exitCode 2)
    warn(err.message);
    say(resultLine(code, null));
    return code;
  }
  let copy = null;
  let db = null;
  try {
    const configFile = path.resolve(args.config ?? path.join(env.HOME || os.homedir(), ".automaton", "automaton.json"));
    const gateCfg = readGateConfig(configFile, !!args.config);
    say(`Vérification avant et après un retour arrière (${args.mode === "copie" ? "sur une copie" : "sur la base de Sonni en marche, en lecture seule"})`);
    let freshness = null;
    if (args.mode === "copie") {
      const file = path.resolve(args.copie);
      if (path.basename(file) === "state.db") throw new Refused(2, "Refusé : c'est la base active de Sonni. Donne la copie que la sauvegarde vient de faire (COPIE_RETOUR, dans ~/.automaton/predeploiement/).");
      const refused = refusal(file, env);
      if (refused) throw new Refused(2, refused);
      say(`Copie : ${file}`);
      freshness = copyFreshness(file, liveDatabasePath(env));
      copy = openPrivateCopy(file, "sonni-verifier-pause-");
      db = copy.db;
    } else {
      const early = tooEarly(args.depuis, clock(), readStartConfig(configFile, false).collectMinutes);
      if (early) throw new Refused(2, early);
      const base = path.resolve(args.base ?? liveDatabasePath(env));
      const refused = liveRefusal(base);
      if (refused) throw new Refused(2, refused);
      say(`Base : ${base}`);
      db = openLive(base);
    }
    if (args.accepted.length) say(`Arrondi accepté par ton GO pour : ${args.accepted.join(", ")}`);
    const now = args.mode === "copie" ? (copyMoment(db)?.now ?? clock()) : clock();
    const gateCtx = { now, clock: clock(), staleMinutes: gateCfg.staleMinutes, portfolio: gateCfg.portfolio, assets: followedAssets(db, gateCfg.assets), notes: [] };
    // One read transaction: on the live database, a broker fill cannot land between two checks.
    const { lines, failures, counts } = db.transaction(() => verifier(db, { depuis: args.depuis, accepted: args.accepted, gateCtx, freshness }))();
    for (const l of lines) say(l);
    const code = failures > 0 ? 1 : 0;
    say(code === 0
      ? (args.depuis ? "Conclusion : la pause tient et l'ancienne version n'a rien acheté ni vendu à risque depuis son démarrage." : "Conclusion : la pause est enregistrée et rien ne peut acheter ni vendre à risque : le retour arrière peut continuer.")
      : "Conclusion : ne démarre pas l'ancienne version (ou arrête-la) ; envoie-moi ce rapport.");
    if (copy && !copy.unchanged()) {
      say("ATTENTION : la copie a changé pendant la vérification (un autre programme l'écrit ?).");
      say(resultLine(3, counts));
      return 3;
    }
    say(resultLine(code, counts));
    return code;
  } catch (err) {
    const code = err instanceof Refused ? err.code : err?.exitCode === 2 ? 2 : 3;
    warn(err instanceof Refused || err?.exitCode === 2 ? err.message : `Vérification impossible : ${String(err?.message ?? err).replace(/\.$/, "")}.`);
    say(resultLine(code, null));
    return code;
  } finally {
    if (copy) copy.close();
    else if (db) {
      try { db.close(); } catch { /* nothing */ }
    }
  }
}

if (isMain(import.meta.url)) process.exitCode = verifierPause(process.argv.slice(2));
