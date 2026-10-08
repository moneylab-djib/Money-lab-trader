/**
 * Step 4 of the 2026-10-08 plan: memory v2. The full-text index over every store, its ranking (recency,
 * importance, current versions, retired lessons), the owner's /memoire and Claude's search_memory, lessons
 * scored by code when they are applied, market regimes and similar past days with an outcome embargo, and
 * a recall evaluation that compares the new search with the keyword recall Sonni used before. No network,
 * no inference.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createDatabase } from "../../state/database.js";
import { ensureMoneyLabSchema } from "../../money-lab/journal.js";
import type { AutomatonDatabase } from "../../types.js";
import { parseTraderConfig, type TraderConfig } from "../../trader/config.js";
import { ensureTraderSchema } from "../../trader/schema.js";
import { isoSeconds } from "../../trader/prices.js";
import { addHypothesis } from "../../trader/hypotheses.js";
import { addLesson, retireLesson, reviseIdentity, writeReflection } from "../../trader/soul.js";
import { addOwnerNote, updateDossier } from "../../trader/dossiers.js";
import { addTrap } from "../../trader/portfolio.js";
import { insertObservation } from "../../trader/readers.js";
import { storeOutput } from "../../trader/brain.js";
import { recordDecision } from "../../trader/decisions.js";
import { recordPrediction, resolveDuePredictions } from "../../trader/predictions.js";
import { formatMemoryHits, ftsQuery, indexMemory, searchMemory, type MemoryHit } from "../../trader/memory.js";
import { describeEvidence, describeEvidenceFr, lessonEvidence, lessonFlag, recordLessonUses } from "../../trader/lessonuse.js";
import { analogLine, describeRegime, describeRegimeFr, FORWARD_DAYS, regimeAt, similarSituations } from "../../trader/analogs.js";
import { formatMemoireFr } from "../../trader/cli.js";
import { buildMemoryPack } from "../../trader/pack.js";
import { buildSonniIdentityBlock } from "../../trader/prompt.js";
import { createTraderTools } from "../../trader/tools.js";
import { finishedPeriods, listSummaries, writeSummaries } from "../../trader/summaries.js";

const EXAMPLE = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "..", "sonni", "automaton.sonni.example.json"), "utf-8"));
const TRADER: TraderConfig = parseTraderConfig(EXAMPLE.trader)!; // the owner's six core assets: dossiers on gold, the dollar, Nvidia
const T = new Date("2026-10-08T09:00:00Z");
const day = (iso: string) => new Date(`${iso}T09:00:00Z`);

let tmpDirs: string[] = [];
function openDb(): AutomatonDatabase {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sonni-memory-"));
  tmpDirs.push(dir);
  const db = createDatabase(path.join(dir, "state.db"));
  ensureMoneyLabSchema(db.raw);
  ensureTraderSchema(db.raw);
  return db;
}
beforeEach(() => { tmpDirs = []; });
afterEach(() => { for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true }); });

function storePrice(db: AutomatonDatabase, asset: string, at: Date, price: number) {
  db.raw.prepare("INSERT OR REPLACE INTO trader_prices (asset, ts, price, source) VALUES (?, ?, ?, 'test')").run(asset, isoSeconds(at), price);
}

/** Daily candles from closes, ending the day before `end` (traded days only: volume > 0). */
function storeCloses(db: AutomatonDatabase, asset: string, closes: number[], end = "2026-10-08") {
  const insert = db.raw.prepare("INSERT OR REPLACE INTO trader_candles (asset, day, open, high, low, close, volume, source) VALUES (?, ?, ?, ?, ?, ?, 1, 'test')");
  const last = Date.parse(`${end}T00:00:00Z`) - 86_400_000;
  closes.forEach((c, i) => {
    const d = new Date(last - (closes.length - 1 - i) * 86_400_000).toISOString().slice(0, 10);
    insert.run(asset, d, c, c, c, c);
  });
}

const ok = <V>(r: { ok: true; value: V } | { ok: false; error: string }): V => {
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

/**
 * A small but realistic memory: what Sonni wrote (lessons, journal, dossiers in two versions, intuitions, a
 * trap, decisions, its identity), the owner's notes, readers' observations and a second-brain note.
 * Returns each item's "kind|ref", the provenance every hit carries.
 */
function seedMemory(db: AutomatonDatabase): Record<string, string> {
  const raw = db.raw;
  const keys: Record<string, string> = {};
  const h1 = addHypothesis(raw, { statement: "Le CPI américain au-dessus des attentes fait baisser le bitcoin dans l'heure.", origin: "observation" }, day("2026-09-12"));
  const h2 = addHypothesis(raw, { statement: "Nvidia monte dans les jours qui précèdent ses résultats trimestriels.", origin: "observation" }, day("2026-09-14"));
  keys.H1 = `hypothesis|${h1.id}`;
  keys.H2 = `hypothesis|${h2.id}`;
  const lesson = (key: string, text: string, when: string) => {
    const l = ok(addLesson(raw, { text, evidenceIds: [h1.id] }, day(when)));
    keys[key] = `lesson|${l.id}`;
    return l.id;
  };
  const retired = lesson("L2", "Le bitcoin monte toujours après une baisse des taux de la Fed.", "2026-09-01");
  ok(retireLesson(raw, retired, "model", "contredit par trois post-mortems", day("2026-09-11")));
  lesson("L1", "Quand la Fed baisse ses taux, le bitcoin monte souvent avant l'annonce puis retombe le jour même.", "2026-09-10");
  lesson("L3", "Une liquidation massive sur les contrats perpétuels marque souvent un point bas à court terme.", "2026-09-20");
  lesson("L4", "ETH suit BTC à la hausse comme à la baisse : corrélation quotidienne d'environ 0,9 sur un an.", "2026-09-21");
  const reflection = (key: string, content: string, when: string) => {
    keys[key] = `reflection|${ok(writeReflection(raw, { kind: "session", content }, day(when))).id}`;
  };
  reflection("R1", "Mon stop sur ETH a été touché à 2 150 € : j'avais sous-estimé la volatilité du week-end.", "2026-10-02");
  reflection("R2", "Journée calme ; les flux des ETF bitcoin restent positifs, je garde ma position.", "2026-10-07");
  reflection("R3", "Semaine : trois paris sur l'or, deux justes ; l'or a servi de refuge pendant la baisse des actions.", "2026-09-28");
  const dossier = (key: string, asset: string, content: string, when: string) => {
    const d = ok(updateDossier(raw, TRADER, { asset, content, reason: "mise à jour" }, day(when), "owner"));
    keys[key] = `dossier|${asset} v${d.version}`;
  };
  dossier("D1", "BTC", "Thèse BTC : le halving et les ETF portent le prix ; niveau clé 52 000 €, invalidation sous 48 000 €.", "2026-09-15");
  dossier("D2", "BTC", "Thèse BTC : les flux des ETF et la politique de la Fed dominent ; niveau clé 55 000 €, invalidation sous 50 000 €.", "2026-10-05");
  dossier("D3", "NVDA", "Nvidia : résultats trimestriels le 19 novembre ; le cours dépend des dépenses des centres de données.", "2026-10-01");
  dossier("D4", "PAXG", "L'or (PAXG) : valeur refuge quand les actions baissent, suit les taux réels ; l'été, les volumes baissent.", "2026-09-20");
  dossier("D5", "USDC", "Le dollar contre l'euro : USDC/EUR suit l'écart de taux entre la Fed et la BCE ; peu de mouvement en général.", "2026-09-22");
  ok(addTrap(raw, { name: "FOMO", description: "Acheter après une hausse de 10 % en un jour parce que tout le monde achète.", warningSigns: "titres euphoriques, volume record" }, day("2026-09-18")));
  keys.T1 = "trap|FOMO";
  const note = (key: string, text: string, when: string) => {
    ok(addOwnerNote(raw, TRADER, text, day(when)));
    keys[key] = `note|note ${day(when).toISOString().slice(0, 16)}`;
  };
  note("N1", "Attention à la réunion de la BCE jeudi : le dollar pourrait bouger.", "2026-10-06");
  note("N2", "Je pense que l'or reste une bonne protection.", "2026-09-25");
  const observation = (key: string, summary: string, when: string, assets: string[], kind: string) => {
    const at = day(when);
    const id = insertObservation(raw, { publishedAt: at.toISOString(), source: "reader:gemini", url: null, assets, kind: kind as any, sentiment: 0.2, summary, eventDate: null }, at);
    keys[key] = `observation|${id}`;
  };
  observation("O1", "Bitcoin ETF outflows hit a monthly high as investors take profits", "2026-09-20", ["BTC"], "etf");
  observation("O2", "Spot bitcoin ETF inflows reach 1.2 billion dollars this week", "2026-10-07", ["BTC"], "etf");
  observation("O3", "US consumer prices rose 0.4% in September, above expectations (CPI)", "2026-10-07", [], "macro");
  storeOutput(raw, "j_test", "briefing", null, "Les flux ETF dominent ; la Fed parle mercredi ; les liquidations restent faibles.", day("2026-10-07"));
  keys.B1 = `brain|${(raw.prepare("SELECT id FROM trader_brain_outputs ORDER BY rowid DESC LIMIT 1").get() as { id: string }).id}`;
  const decision = (key: string, asset: string, price: number, reason: string, when: string) => {
    storePrice(db, asset, day(when), price);
    keys[key] = `decision|${ok(recordDecision(raw, TRADER, { asset, action: "stay_out", reason }, day(when))).id}`;
  };
  decision("DEC1", "BTC", 60_000, "Je reste dehors : les flux des ETF sont positifs mais la Fed reste patiente.", "2026-10-07");
  decision("DEC2", "NVDA", 150, "J'attends les résultats trimestriels de Nvidia avant d'acheter quoi que ce soit.", "2026-10-06");
  const identity = ok(reviseIdentity(raw, {
    content: "Je suis Sonni, apprenti courtier sur un portefeuille virtuel. J'apprends de mes erreurs et je me méfie de mes certitudes sur la Fed.",
    reason: "version du test", source: "owner",
  }, day("2026-09-30")));
  keys.I1 = `identity|identity v${identity.version}`;
  return keys;
}

const keyOf = (h: { kind: string; ref: string }) => `${h.kind}|${h.ref}`;

describe("The memory index", () => {
  it("indexes every store once, then only what is new", () => {
    const db = openDb();
    seedMemory(db);
    const first = indexMemory(db.raw);
    expect(first).toBeGreaterThanOrEqual(25);
    expect(indexMemory(db.raw)).toBe(0);
    addOwnerNote(db.raw, TRADER, "Regarde le rapport sur l'emploi vendredi.", T);
    expect(indexMemory(db.raw)).toBe(1);
    db.close();
  });

  it("turns free text into a safe query: accents and case folded, French and English filler dropped, plurals folded", () => {
    expect(ftsQuery("Que sait-il sur l'or ?")).toBe('"or"');
    expect(ftsQuery("Liquidations")).toBe('"liquidation"*');
    expect(ftsQuery("été")).toBe('"ete"');
    expect(ftsQuery("Baisse des taux de la Fed")).toBe('"baisse"* OR "taux"* OR "fed"');
    expect(ftsQuery("le la de du")).toBeNull();
    // FTS5 syntax in the owner's words is only words.
    const db = openDb();
    seedMemory(db);
    for (const q of ['"); DROP TABLE trader_memory; --', "NEAR(fed taux)", "bitcoin OR *", "-fed +taux ^ :"]) {
      expect(() => searchMemory(db.raw, q, { now: T })).not.toThrow();
    }
    expect(searchMemory(db.raw, '"); DROP TABLE trader_memory; --', { now: T })).toBeInstanceOf(Array);
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM trader_memory").get()).toMatchObject({ n: expect.any(Number) });
    db.close();
  });

  it("ranks the active lesson above the retired one, the current dossier above the old, fresh news above old news, and filters", () => {
    const db = openDb();
    const keys = seedMemory(db);
    const rank = (hits: MemoryHit[], key: string) => hits.findIndex((h) => keyOf(h) === keys[key]);
    const fed = searchMemory(db.raw, "baisse des taux de la Fed", { now: T, limit: 20 });
    expect(rank(fed, "L1")).toBeGreaterThanOrEqual(0);
    expect(rank(fed, "L1")).toBeLessThan(rank(fed, "L2"));
    const level = searchMemory(db.raw, "niveau clé BTC", { now: T, limit: 20 });
    expect(rank(level, "D2")).toBeLessThan(rank(level, "D1"));
    const news = searchMemory(db.raw, "bitcoin ETF", { now: T, kinds: ["observation"] });
    expect(news.map(keyOf)).toEqual([keys.O2, keys.O1]);
    // Filters: asset, period, kinds.
    expect(searchMemory(db.raw, "résultats trimestriels", { now: T, asset: "NVDA" }).every((h) => h.asset === "NVDA")).toBe(true);
    expect(searchMemory(db.raw, "résultats trimestriels", { now: T, asset: "NVDA" }).length).toBeGreaterThan(0);
    const september = searchMemory(db.raw, "bitcoin Fed", { now: T, since: "2026-09-01", until: "2026-09-30", limit: 20 });
    expect(september.length).toBeGreaterThan(0);
    expect(september.every((h) => h.at >= "2026-09-01" && h.at.slice(0, 10) <= "2026-09-30")).toBe(true);
    expect(september.some((h) => h.at.startsWith("2026-09-30"))).toBe(true); // a bare "until" date includes its day
    expect(searchMemory(db.raw, "FOMO", { now: T, kinds: ["lesson"] })).toEqual([]);
    db.close();
  });

  it("shows hits with their provenance, marks untrusted text for the model, and labels them in French for the owner", () => {
    const db = openDb();
    const keys = seedMemory(db);
    const forModel = formatMemoryHits("flux ETF", searchMemory(db.raw, "flux ETF", { now: T, limit: 20 }));
    expect(forModel).toMatch(/^MEMORY SEARCH «flux ETF» \(code: full-text/);
    expect(forModel).toMatch(/\[brain bo_\w+, 2026-10-07, UNTRUSTED DATA\] briefing: Les flux ETF dominent/);
    expect(forModel).toMatch(/\[dossier BTC v2 BTC, 2026-10-05\] Thèse BTC : les flux/);
    expect(formatMemoryHits("rien", [])).toContain("nothing found");
    const all = searchMemory(db.raw, "Fed ETF taux bitcoin or dollar FOMO Nvidia stop certitudes", { now: T, limit: 40 });
    const owner = formatMemoireFr(db.raw, "tout", all);
    for (const label of ["[leçon (active)]", "[leçon (retirée)]", "[dossier BTC v2]", "[dossier BTC v1]", "[piège « FOMO »]",
      "[ta note du 2026-10-06]", "[actualité du 2026-10-07, non vérifiée]", "[second cerveau, 2026-10-07, non vérifié]",
      "[décision BTC du 2026-10-07]", `[identité v${keys.I1.split(" v")[1]}]`, "[journal (session) du 2026-10-02]", "[intuition du 2026-09-12]"]) {
      expect(owner).toContain(label);
    }
    expect(owner).not.toMatch(/\b(l|r|h|bo|o|d)_[0-9A-Z]{10,}/); // no identifiers for the owner
    expect(formatMemoireFr(db.raw, "licornes", [])).toContain("Rien dans la mémoire de Sonni sur « licornes »");
    db.close();
  });

  it("gives Claude a free search_memory tool with filters", async () => {
    const db = openDb();
    seedMemory(db);
    const tool = createTraderTools().find((t) => t.name === "search_memory")!;
    const ctx = { db, config: { trader: TRADER } } as any;
    const out = await tool.execute({ query: "FOMO", kinds: ["trap", "nonsense"], limit: 99 }, ctx);
    expect(out).toContain("MEMORY SEARCH «FOMO»");
    expect(out).toContain("[trap FOMO, 2026-09-18] FOMO: Acheter après une hausse de 10 %");
    expect(await tool.execute({ query: "flux", asset: "NVDA", since: "pas une date" }, ctx)).toContain("nothing found");
    db.close();
  });
});

/** The keyword recall Sonni used before 2026-10-08 (src/money-lab/recall.ts at d835d33), for comparison. */
function oldRecall(db: AutomatonDatabase, query: string, limit: number): string[] {
  const normalize = (t: string) => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const wanted = [...new Set(normalize(query).split(/[^a-z0-9]+/).filter((t) => t.length >= 2))];
  const rows = db.raw.prepare(
    `SELECT 'identity' AS kind, 'identity v' || version AS ref, content AS text FROM trader_identity
     UNION ALL SELECT 'reflection', id, content FROM trader_reflections
     UNION ALL SELECT 'lesson', id, text FROM trader_lessons
     UNION ALL SELECT 'hypothesis', id, statement FROM trader_hypotheses
     UNION ALL SELECT 'dossier', asset || ' v' || version, content FROM trader_dossiers
     UNION ALL SELECT 'trap', name, description || ' Signs: ' || warning_signs FROM trader_traps
     UNION ALL SELECT 'note', 'note ' || substr(at, 1, 16), text FROM trader_owner_notes
     UNION ALL SELECT 'order', id, thesis FROM trader_orders`,
  ).all() as { kind: string; ref: string; text: string }[];
  const scored = rows.map((r) => {
    const norm = normalize(r.text);
    let score = 0;
    let matched = 0;
    for (const term of wanted) {
      const count = norm.split(term).length - 1;
      if (count > 0) { matched++; score += 1 + Math.log(count); }
    }
    return { key: `${r.kind}|${r.ref}`, score: matched === 0 ? 0 : score * (matched / wanted.length) ** 2 };
  }).filter((r) => r.score > 0);
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((r) => r.key);
}

/** Questions an owner or Claude would ask, with the memories that answer them. */
const EVAL: { q: string; expect: string[] }[] = [
  { q: "baisse des taux de la Fed", expect: ["L1"] },
  { q: "liquidations", expect: ["L3"] },
  { q: "volatilité en ete", expect: ["D4"] },
  { q: "résultats trimestriels Nvidia", expect: ["D3", "H2", "DEC2"] },
  { q: "piège FOMO", expect: ["T1"] },
  { q: "l'or comme refuge", expect: ["D4", "R3", "N2"] },
  { q: "que pense sonni du dollar", expect: ["D5", "N1"] },
  { q: "CPI", expect: ["H1", "O3"] },
  { q: "stop touché ETH", expect: ["R1"] },
  { q: "corrélation ETH BTC", expect: ["L4"] },
  { q: "BCE dollar", expect: ["N1", "D5"] },
  { q: "certitudes sur la Fed", expect: ["I1"] },
  { q: "volatilité du week-end", expect: ["R1"] },
  { q: "halving", expect: ["D1"] },
  { q: "niveau clé BTC", expect: ["D2"] },
  { q: "bitcoin ETF inflows", expect: ["O2"] },
];
/** Same meaning, other words or another language: what a keyword index cannot see (decision 0005's revisit trigger). */
const PARAPHRASES: { q: string; expect: string[] }[] = [
  { q: "hausse des prix à la consommation", expect: ["O3", "H1"] },
  { q: "argent qui entre dans les fonds indiciels", expect: ["O2"] },
  { q: "rate cut", expect: ["L1"] },
];

describe("Recall evaluation (step 4)", () => {
  it("finds the answer in the first three hits more often than the keyword recall it replaces", () => {
    const db = openDb();
    const keys = seedMemory(db);
    const score = (set: typeof EVAL, search: (q: string) => string[]) =>
      set.filter((c) => search(c.q).slice(0, 3).some((k) => c.expect.some((e) => keys[e] === k))).length;
    const fresh = (q: string) => searchMemory(db.raw, q, { now: T, limit: 3 }).map(keyOf);
    const before = (q: string) => oldRecall(db, q, 3);
    const misses = EVAL.filter((c) => !fresh(c.q).some((k) => c.expect.some((e) => keys[e] === k))).map((c) => c.q);
    expect(misses).toEqual([]);
    expect(score(EVAL, fresh)).toBe(EVAL.length);
    expect(score(EVAL, before)).toBe(11);
    // Measured, not hoped for: paraphrases stay out of reach of both (docs/MEMORY.md).
    expect(score(PARAPHRASES, fresh)).toBe(0);
    expect(score(PARAPHRASES, before)).toBe(0);
    db.close();
  });
});

describe("Lessons scored by code when applied", () => {
  it("keeps only active lessons a prediction or decision cites, and scores each use against the outcome", () => {
    const db = openDb();
    const raw = db.raw;
    const h = addHypothesis(raw, { statement: "Le BTC reste dans sa fourchette cette semaine.", origin: "observation" }, day("2026-09-01"));
    const lessonA = ok(addLesson(raw, { text: "Un seuil à moins d'un écart-type est atteint plus souvent qu'on ne croit.", evidenceIds: [h.id] }, day("2026-09-02"))).id;
    const lessonB = ok(addLesson(raw, { text: "Rester dehors avant la Fed évite les mauvaises surprises.", evidenceIds: [h.id] }, day("2026-09-03"))).id;
    const retired = ok(addLesson(raw, { text: "Toujours acheter le lundi matin, le marché remonte.", evidenceIds: [h.id] }, day("2026-09-04"))).id;
    ok(retireLesson(raw, retired, "owner", "aucune preuve", day("2026-09-05")));
    // Daily history for code's odds: closes alternating ±1 %.
    storeCloses(db, "BTC", Array.from({ length: 60 }, (_, i) => 60_000 * (i % 2 === 0 ? 1.01 : 1)), "2026-10-08");
    storePrice(db, "BTC", T, 60_000);
    const p = recordPrediction(raw, TRADER, { asset: "BTC", direction: "above", threshold: 60_300, horizonHours: 24, probability: 0.8, hypothesisId: h.id, statement: "s", rationale: "r" }, T);
    expect(p.ok).toBe(true);
    const pid = (p as any).prediction.id;
    expect(recordLessonUses(raw, [lessonA, lessonA, "l_unknown", retired, " "], "prediction", pid, T)).toEqual([lessonA]);
    expect(recordLessonUses(raw, "not a list", "prediction", pid, T)).toEqual([]);
    // A decision 2 hours later, citing lesson B; BTC rises 3 % over the next week: staying out was wrong.
    storePrice(db, "BTC", new Date(T.getTime() + 2 * 3_600_000), 60_000);
    const d = ok(recordDecision(raw, TRADER, { asset: "BTC", action: "stay_out", reason: "Je reste dehors avant la réunion de la Fed, comme d'habitude." }, new Date(T.getTime() + 2 * 3_600_000)));
    expect(recordLessonUses(raw, [lessonB], "decision", d.id, T)).toEqual([lessonB]);
    expect(lessonEvidence(raw).get(lessonA)).toEqual({ uses: 1, helped: 0, hurt: 0, pending: 1 });
    // The prediction resolves above the threshold: a confident right answer beats code's reference.
    storePrice(db, "BTC", new Date(T.getTime() + 24 * 3_600_000), 61_000);
    resolveDuePredictions(raw, TRADER, new Date(T.getTime() + 25 * 3_600_000));
    storePrice(db, "BTC", new Date(T.getTime() + (2 + 168) * 3_600_000), 61_800);
    const ev = lessonEvidence(raw);
    expect(ev.get(lessonA)).toEqual({ uses: 1, helped: 1, hurt: 0, pending: 0 });
    expect(ev.get(lessonB)).toEqual({ uses: 1, helped: 0, hurt: 1, pending: 0 });
    expect(ev.has(retired)).toBe(false);
    db.close();
  });

  it("flags a lesson the facts keep contradicting, in the cached prompt only then, and shows the counts in the pack", () => {
    expect(lessonFlag(undefined)).toBe("untested");
    expect(lessonFlag({ uses: 2, helped: 1, hurt: 1, pending: 0 })).toBe("untested");
    expect(lessonFlag({ uses: 4, helped: 3, hurt: 1, pending: 0 })).toBe("supported");
    expect(lessonFlag({ uses: 4, helped: 2, hurt: 2, pending: 0 })).toBe("mixed");
    expect(lessonFlag({ uses: 6, helped: 2, hurt: 4, pending: 0 })).toBe("against");
    expect(lessonFlag({ uses: 5, helped: 1, hurt: 4, pending: 0 })).toBe("mixed"); // under 6 scored uses: not yet
    expect(describeEvidence({ uses: 7, helped: 2, hurt: 4, pending: 1 })).toBe("(used 7: helped 2, hurt 4, 1 pending; EVIDENCE AGAINST: retire it with retire_lesson, or say in your next reflection why it still holds)");
    expect(describeEvidence(undefined)).toBe("(not used yet; untested)");
    expect(describeEvidenceFr({ uses: 7, helped: 2, hurt: 4, pending: 1 })).toBe("appliquée 7 fois : a aidé 2, a nui 4, 1 en attente ⚠ les faits la contredisent");
    expect(describeEvidenceFr(undefined)).toBe("jamais appliquée encore");

    const db = openDb();
    const raw = db.raw;
    const h = addHypothesis(raw, { statement: "Le BTC reste dans sa fourchette cette semaine.", origin: "observation" }, day("2026-09-01"));
    const bad = ok(addLesson(raw, { text: "Rester dehors avant la Fed évite les mauvaises surprises.", evidenceIds: [h.id] }, day("2026-09-02"))).id;
    const good = ok(addLesson(raw, { text: "Après trois jours de baisse, le BTC rebondit souvent le quatrième.", evidenceIds: [h.id] }, day("2026-09-02"))).id;
    // Six decisions citing the bad lesson, each followed by a 3 % rise within the week (staying out was wrong).
    // Prices arrive in time order, as they do from Kraken: the decisions first, then the week after them.
    const times = Array.from({ length: 6 }, (_, i) => new Date(T.getTime() - (30 - i * 2) * 86_400_000));
    for (const at of times) {
      storePrice(db, "BTC", at, 60_000);
      const d = ok(recordDecision(raw, TRADER, { asset: "BTC", action: "stay_out", reason: "Je reste dehors avant la réunion de la Fed, comme d'habitude." }, at));
      recordLessonUses(raw, [bad], "decision", d.id, at);
    }
    for (const at of times) storePrice(db, "BTC", new Date(at.getTime() + 168 * 3_600_000), 61_800);
    const block = buildSonniIdentityBlock(raw);
    expect(block).toContain(`- ${bad}: Rester dehors avant la Fed`);
    expect(block).toContain("EVIDENCE AGAINST");
    expect(block).not.toMatch(new RegExp(`${good}[^\\n]*used`)); // no counts in the cached block
    const pack = buildMemoryPack(raw, TRADER, T);
    expect(pack).toContain("Your lessons in use (code:");
    expect(pack).toContain(`- ${bad}: (used 6: helped 0, hurt 6; EVIDENCE AGAINST`);
    db.close();
  });
});

describe("Summaries of finished days, weeks and months (code)", () => {
  it("lists only finished periods: days, ISO weeks and whole months in the lookback", () => {
    const periods = finishedPeriods(T, 120);
    expect(periods.filter((p) => p.period === "day")).toHaveLength(120);
    expect(periods.find((p) => p.period === "day" && p.start === "2026-10-08")).toBeUndefined(); // today is not over
    expect(periods.filter((p) => p.period === "week")[0]).toEqual({ period: "week", start: "2026-09-28", end: "2026-10-05" });
    expect(periods.filter((p) => p.period === "month").map((p) => p.start)).toEqual(["2026-09-01", "2026-08-01", "2026-07-01"]);
  });

  it("writes each summary once, with code's facts and their sources, searchable and labelled for the owner", () => {
    const db = openDb();
    const keys = seedMemory(db);
    // A prediction made and resolved on 2026-10-01, with code's odds from the daily history.
    storeCloses(db, "BTC", Array.from({ length: 90 }, (_, i) => 60_000 * (i % 2 === 0 ? 1.01 : 1)), "2026-10-02");
    storePrice(db, "BTC", day("2026-10-01"), 60_000);
    const h = addHypothesis(db.raw, { statement: "Le BTC passe 60 300 € dans les six heures.", origin: "observation" }, day("2026-10-01"));
    const p = recordPrediction(db.raw, TRADER, { asset: "BTC", direction: "above", threshold: 60_300, horizonHours: 6, probability: 0.8, hypothesisId: h.id, statement: "s", rationale: "r" }, day("2026-10-01"));
    expect(p.ok).toBe(true);
    storePrice(db, "BTC", new Date(day("2026-10-01").getTime() + 6 * 3_600_000), 61_000);
    resolveDuePredictions(db.raw, TRADER, new Date(day("2026-10-01").getTime() + 7 * 3_600_000));
    const written = writeSummaries(db.raw, TRADER, T);
    expect(written).toBeGreaterThan(5);
    expect(writeSummaries(db.raw, TRADER, T)).toBe(0); // once
    const days = listSummaries(db.raw, "day", 200);
    expect(days.some((d) => d.start === "2026-10-08")).toBe(false);
    expect(days.some((d) => d.start === "2026-08-15")).toBe(false); // nothing happened: no summary
    const oct1 = days.find((d) => d.start === "2026-10-01")!;
    expect(oct1.content).toMatch(/^Journée du 2026-10-01 \(calculé par le code\) : marché BTC [+-]\d+,\d % ; prédictions : 1 faite\(s\) \(BTC 1\), 1 résolue\(s\), Brier moyen 0,040 contre 0,\d{3} pour la référence du code \(compétence \+\d+,\d %\)/);
    // A day without a traded candle shows no market move (no false 0 %).
    expect(days.find((d) => d.start === "2026-10-07")!.content).not.toContain("marché");
    expect(oct1.sources).toContain((p as any).prediction.id);
    const oct7 = days.find((d) => d.start === "2026-10-07")!;
    expect(oct7.content).toContain("décisions : 1 (dernière par actif : BTC rester dehors)");
    expect(oct7.content).toContain("journal : 1 note(s) (session 1)");
    expect(oct7.sources).toEqual(expect.arrayContaining([keys.DEC1.split("|")[1], keys.R2.split("|")[1]]));
    const september = listSummaries(db.raw, "month").find((m) => m.start === "2026-09-01")!;
    expect(september.content).toMatch(/^Mois de septembre 2026 \(calculé par le code\) : .*leçons : \+4, −1 ; journal : 1 note\(s\) \(session 1\) ; tes notes : 1\./);
    const week = listSummaries(db.raw, "week").find((w) => w.start === "2026-09-28")!;
    expect(week.content).toContain("Semaine du 2026-09-28 au 2026-10-04 (calculé par le code)");
    // Indexed with the rest of the memory; the owner sees no identifiers.
    const hits = searchMemory(db.raw, "semaine", { now: T, kinds: ["summary"] });
    expect(hits.map((x) => x.ref)).toContain("week 2026-09-28");
    const owner = formatMemoireFr(db.raw, "semaine", hits);
    expect(owner).toContain("[résumé calculé par le code] Semaine du 2026-09-28 au 2026-10-04 :");
    expect(owner).not.toContain("Sources");
    expect(formatMemoryHits("semaine", hits)).toMatch(/\[summary week 2026-09-28, 2026-09-28\] Semaine du .* Sources : /);
    db.close();
  });
});

describe("Market regimes and similar past situations", () => {
  const steady = (n: number, daily: number, start = 100) => Array.from({ length: n }, (_, i) => start * Math.pow(1 + daily, i));

  it("names the regime from closes: trend against the 50-day average, volatility against its own year", () => {
    const db = openDb();
    storeCloses(db, "BTC", steady(200, 0.004).map((c, i) => c * (i % 2 ? 1.002 : 0.998)));
    storeCloses(db, "ETH", steady(200, -0.004).map((c, i) => c * (i % 2 ? 1.002 : 0.998)));
    // Calm for most of a year, then a month of large swings.
    storeCloses(db, "PAXG", Array.from({ length: 301 }, (_, i) => 100 * (i % 2 ? (i > 270 ? 1.06 : 1.002) : 1)));
    expect(regimeAt(db.raw, "BTC", "2026-10-07")?.trend).toBe("up");
    expect(regimeAt(db.raw, "ETH", "2026-10-07")?.trend).toBe("down");
    expect(regimeAt(db.raw, "PAXG", "2026-10-07")).toEqual({ trend: "range", vol: "high" });
    expect(regimeAt(db.raw, "BTC", "2026-04-01")).toBeNull(); // not enough history before that day
    expect(describeRegime({ trend: "up", vol: "low" })).toBe("up-trend, low volatility");
    expect(describeRegimeFr({ trend: "range", vol: "high" })).toBe("sans tendance, volatilité forte");
    expect(describeRegime(null)).toBe("regime n/a");
    db.close();
  });

  it("finds the five most similar past days, a week apart, never one whose next week is unknown", () => {
    const db = openDb();
    expect(similarSituations(db.raw, "BTC")).toBeNull();
    // A noisy but repeatable walk over 300 days.
    let x = 1;
    const closes = Array.from({ length: 300 }, (_, i) => {
      x = (x * 48_271) % 2_147_483_647;
      return 60_000 * Math.exp(Math.sin(i / 9) * 0.08 + ((x / 2_147_483_647) - 0.5) * 0.02);
    });
    storeCloses(db, "BTC", closes);
    const s = similarSituations(db.raw, "BTC")!;
    expect(s.analogs).toHaveLength(5);
    const days = s.analogs.map((a) => Date.parse(a.day) / 86_400_000).sort((a, b) => a - b);
    for (let i = 1; i < days.length; i++) expect(days[i] - days[i - 1]).toBeGreaterThanOrEqual(7);
    // Embargo: every analog's next FORWARD_DAYS are already in the history.
    const lastDay = Date.parse(s.asOf) / 86_400_000;
    expect(days.every((d) => d + FORWARD_DAYS <= lastDay)).toBe(true);
    const byDay = new Map(closes.map((c, i) => [new Date(Date.parse("2026-10-07T00:00:00Z") - (299 - i) * 86_400_000).toISOString().slice(0, 10), c]));
    for (const a of s.analogs) {
      const later = new Date(Date.parse(a.day) + FORWARD_DAYS * 86_400_000).toISOString().slice(0, 10);
      expect(a.forwardPct).toBeCloseTo((byDay.get(later)! / byDay.get(a.day)! - 1) * 100, 6);
    }
    expect(s.up).toBe(s.analogs.filter((a) => a.forwardPct > 0).length);
    expect(analogLine(s)).toMatch(/^- BTC \(2026-10-07, .+\): of the 5 most similar past days, \d rose over the next 7 days, median [+-]\d/);
    expect(buildMemoryPack(db.raw, { ...TRADER, assets: TRADER.assets.filter((a) => a.symbol === "BTC") }, T)).toContain("Similar past situations (code:");
    db.close();
  });
});
