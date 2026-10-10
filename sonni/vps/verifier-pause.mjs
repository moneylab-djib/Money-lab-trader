#!/usr/bin/env node
/**
 * Pause check before and after a code rollback (2026-10-10). The versions before step 0.3 fill orders with a price
 * rounded to the cent: below 1 EUR a fill drifts from the market, below 0.005 EUR a buy gets an infinite quantity
 * and a sale a price of 0, and those rows can never be corrected. Going back to such a version is only allowed when
 * the owner's pause is really recorded in Sonni's memory (the old versions honour it at start: no paid cycle, so the
 * model places no order) and when nothing the old broker would fill on its own can damage the history.
 *
 * Checks, each OK or ÉCHEC:
 *   1. the pause is recorded (kv money_lab.paused, set by /pause or `node dist/index.js --money-lab pause`);
 *   2. no buy order is pending (the broker fills pending orders even during the pause);
 *   3. no open position is on an asset whose last stored price is under 0.01 EUR (the old broker would sell it at a
 *      price rounded to 0, a stop included); positions under 1 EUR are listed, not blocking (a sale drifts by less
 *      than a cent a unit);
 *   4. no open position is invalid (a quantity or an average cost that is not a finite positive number, left by a
 *      pre-0.3 fill): the gate blocks such data (controle-predeploiement.mjs), and so does a rollback;
 *   5. with --depuis (after the old version started): no buy placed or filled since that moment.
 *
 * Safety: --copie reads a private copy of a copy (copie-privee.mjs, never the live file); --en-marche opens the live
 * database read-only while Sonni runs (refused when its -wal or -shm is missing, see controle-apres-demarrage.mjs).
 * It writes nothing.
 *
 * Exit codes: 0 every check OK (the rollback may go on); 1 at least one ÉCHEC (do not start the old version, or
 * stop it); 2 refused or usage error (nothing read); 3 technical error. The last line of stdout is
 * `RÉSULTAT : code=<n> pause=<oui|non> achats_en_attente=<n> positions_sous_1_centime=<n> positions_invalides=<n>
 * achats_depuis=<n|non vérifié>`.
 *
 * Usage:
 *   node sonni/vps/verifier-pause.mjs --copie <copie>                    (Sonni arrêté : sur une sauvegarde fraîche)
 *   node sonni/vps/verifier-pause.mjs --en-marche [--depuis <ISO UTC>]    (Sonni en marche : sa base, en lecture seule)
 *   [--base <state.db>] replaces ~/.automaton/state.db for --en-marche (as in controle-apres-demarrage.mjs).
 */

import path from "path";
import { isMain, liveDatabasePath, openPrivateCopy, price, refusal } from "./copie-privee.mjs";
import { liveRefusal, openLive, parseSince, when } from "./controle-apres-demarrage.mjs";

/** Below this last price, the old broker's cent rounding gives 0 or 0.01: a sale would be recorded at nothing. */
export const SUB_CENT_EUR = 0.01;
/** Below this, a fill of the old broker drifts from the market (rounded to the cent). */
export const PRECISION_EUR = 1;

const USAGE = "Usage : node sonni/vps/verifier-pause.mjs --copie <copie> | --en-marche [--depuis <date ISO UTC>] [--base <state.db>]";

class Refused extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function parseArgs(argv) {
  const out = { mode: null, copie: null, depuis: null, base: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[i + 1];
      if (!v || v.startsWith("--")) throw new Refused(2, `${a} attend une valeur. ${USAGE}`);
      i += 1;
      return v;
    };
    if (a === "--copie") {
      out.mode = out.mode && out.mode !== "copie" ? "both" : "copie";
      out.copie = value();
    } else if (a === "--en-marche") out.mode = out.mode && out.mode !== "live" ? "both" : "live";
    else if (a === "--depuis") out.depuis = parseSince(value());
    else if (a === "--base") out.base = value();
    else throw new Refused(2, `Option inconnue : ${a}. ${USAGE}`);
  }
  if (!out.mode) throw new Refused(2, `Choisis --copie <copie> (Sonni arrêté) ou --en-marche (Sonni en marche). ${USAGE}`);
  if (out.mode === "both") throw new Refused(2, `--copie et --en-marche ne vont pas ensemble. ${USAGE}`);
  if (out.mode !== "live" && (out.depuis || out.base)) throw new Refused(2, `--depuis et --base ne servent qu'avec --en-marche. ${USAGE}`);
  return out;
}

const hasTable = (db, table) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);

/** Runs the checks on an open read-only database. Returns `{ lines, failures, counts }`. */
export function verifier(db, { depuis = null } = {}) {
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
  const lastPrice = (asset) => (hasTable(db, "trader_prices")
    ? db.prepare("SELECT ts, price FROM trader_prices WHERE asset = ? ORDER BY ts DESC LIMIT 1").get(asset) : undefined);
  const priced = (asset) => {
    const p = lastPrice(asset);
    return p ? `dernier prix ${price(p.price)} (${when(p.ts)})` : "aucun prix enregistré";
  };

  // 1. The pause, as the runtime reads it (a record it cannot parse still counts as paused: fail closed).
  const raw = db.prepare("SELECT value FROM kv WHERE key = 'money_lab.paused'").get();
  let paused = false;
  if (!raw) fail("aucune pause enregistrée : l'ancienne version lancerait des cycles et pourrait acheter. Envoie /pause (ou la commande de pause du guide), puis relance ce contrôle.");
  else {
    paused = true;
    let detail = "enregistrement illisible, compté comme une pause";
    try {
      const state = JSON.parse(raw.value);
      detail = `depuis ${when(state.at)}${state.reason ? ` (${String(state.reason).slice(0, 120)})` : ""}`;
    } catch { /* fail closed, said above */ }
    ok(`pause enregistrée ${detail}`);
  }

  // 2. Pending buys: the broker fills them even during the pause, with the old rounding.
  const pendingBuys = db.prepare("SELECT id, asset, kind, amount_eur, limit_price, placed_at FROM trader_orders WHERE status = 'pending' AND side = 'buy' ORDER BY placed_at").all();
  if (pendingBuys.length === 0) ok("aucun ordre d'achat en attente");
  else {
    fail(`${pendingBuys.length} ordre(s) d'achat en attente : l'ancienne version les exécuterait sans la précision de l'étape 0.3. Ne reviens pas en arrière tant qu'ils attendent (la nouvelle version, en pause, les exécute correctement ou les fait expirer).`);
    for (const o of pendingBuys) info(`${o.id} : achat ${o.kind === "limit" ? `à cours limité (${price(o.limit_price)})` : "au marché"} de ${o.asset} pour ${o.amount_eur ?? "?"} € passé le ${when(o.placed_at)} ; ${priced(o.asset)}`);
  }

  // 3. Open positions the old broker could sell at a price rounded to 0 (a stop needs no paid cycle).
  const positions = db.prepare("SELECT asset, quantity, avg_cost, invalidation FROM trader_positions WHERE quantity > 0 ORDER BY asset").all();
  let subCent = 0;
  for (const p of positions) {
    const last = lastPrice(p.asset);
    if (!last) continue;
    if (last.price < SUB_CENT_EUR) {
      subCent += 1;
      fail(`position ${p.asset} : ${priced(p.asset)}, sous 1 centime : l'ancienne version la vendrait (stop compris) à un prix arrondi à 0. Ne reviens pas en arrière avec cette position ; garde Sonni arrêté et préviens-moi.`);
    } else if (last.price < PRECISION_EUR) {
      info(`position ${p.asset} : ${priced(p.asset)}, sous 1 € : une vente par l'ancienne version serait arrondie au centime (écart de moins d'un centime par unité).`);
    }
  }
  if (subCent === 0) ok(`aucune position sur un actif sous 1 centime (${positions.length} position(s) ouverte(s))`);

  // 4. Corrupt positions: never started on, by either version, without a separate repair.
  const invalid = positions.filter((p) => !Number.isFinite(p.quantity) || !Number.isFinite(p.avg_cost) || p.avg_cost <= 0);
  if (invalid.length === 0) ok("aucune position invalide");
  else fail(`${invalid.length} position(s) invalide(s) (${invalid.map((p) => p.asset).join(", ")}) : quantité ou coût moyen non valable. Garde Sonni arrêté et préviens-moi : il faut d'abord une réparation séparée.`);

  // 5. After the old version started: nothing bought since.
  let since = null;
  if (depuis) {
    const iso = depuis.toISOString().slice(0, 19);
    const placed = db.prepare("SELECT id, asset, placed_at FROM trader_orders WHERE side = 'buy' AND substr(placed_at, 1, 19) >= ? ORDER BY placed_at").all(iso);
    const filled = db.prepare("SELECT id, asset, settled_at, fill_price FROM trader_orders WHERE side = 'buy' AND status = 'filled' AND substr(settled_at, 1, 19) >= ? ORDER BY settled_at").all(iso);
    since = placed.length + filled.filter((f) => !placed.some((p) => p.id === f.id)).length;
    if (since === 0) ok(`aucun achat passé ni exécuté depuis le ${when(depuis)}`);
    else {
      fail(`${since} achat(s) depuis le ${when(depuis)} : arrête Sonni tout de suite (systemctl stop sonni) et envoie-moi ce rapport.`);
      for (const o of placed) info(`${o.id} : achat de ${o.asset} passé le ${when(o.placed_at)}`);
      for (const o of filled) info(`${o.id} : achat de ${o.asset} exécuté le ${when(o.settled_at)} à ${price(o.fill_price)}`);
    }
  }
  return { lines, failures, counts: { paused, pendingBuys: pendingBuys.length, subCent, invalid: invalid.length, since } };
}

export function resultLine(code, counts) {
  if (!counts) return `RÉSULTAT : code=${code} pause=inconnue achats_en_attente=inconnu positions_sous_1_centime=inconnu positions_invalides=inconnu achats_depuis=non vérifié`;
  return `RÉSULTAT : code=${code} pause=${counts.paused ? "oui" : "non"} achats_en_attente=${counts.pendingBuys} `
    + `positions_sous_1_centime=${counts.subCent} positions_invalides=${counts.invalid} achats_depuis=${counts.since === null ? "non vérifié" : counts.since}`;
}

/** Runs the whole check; returns the exit code and never exits. */
export function verifierPause(argv, { env = process.env, say = (l = "") => process.stdout.write(`${l}\n`), warn = (l) => process.stderr.write(`${l}\n`) } = {}) {
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
    say(`Vérification de la pause avant un retour arrière (${args.mode === "copie" ? "sur une copie" : "sur la base de Sonni en marche, en lecture seule"})`);
    if (args.mode === "copie") {
      const file = path.resolve(args.copie);
      const refused = refusal(file, env);
      if (refused) throw new Refused(2, refused);
      say(`Copie : ${file}`);
      copy = openPrivateCopy(file, "sonni-verifier-pause-");
      db = copy.db;
    } else {
      const base = path.resolve(args.base ?? liveDatabasePath(env));
      const refused = liveRefusal(base);
      if (refused) throw new Refused(2, refused);
      say(`Base : ${base}`);
      db = openLive(base);
    }
    const { lines, failures, counts } = verifier(db, { depuis: args.depuis });
    for (const l of lines) say(l);
    const code = failures > 0 ? 1 : 0;
    say(code === 0
      ? (args.depuis ? "Conclusion : la pause tient et rien n'a été acheté depuis le démarrage." : "Conclusion : la pause est enregistrée et rien ne peut acheter : le retour arrière peut continuer.")
      : "Conclusion : ne démarre pas l'ancienne version (ou arrête-la) ; envoie-moi ce rapport.");
    if (copy && !copy.unchanged()) {
      say("ATTENTION : la copie a changé pendant la vérification (un autre programme l'écrit ?).");
      say(resultLine(3, counts));
      return 3;
    }
    say(resultLine(code, counts));
    return code;
  } catch (err) {
    const code = err instanceof Refused ? err.code : 3;
    warn(err instanceof Refused ? err.message : `Vérification impossible : ${String(err?.message ?? err).replace(/\.$/, "")}.`);
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
