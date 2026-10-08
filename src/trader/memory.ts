/**
 * Memory v2, the archive level (plan of 2026-10-08 step 4, docs/RESEARCH.md 5.1).
 *
 * Everything Sonni and its readers wrote is indexed in one SQLite FTS5 table
 * (accents folded, so "fed" finds "Fed" and "été" finds "ete"), fed
 * incrementally from the append-only stores by rowid high-water marks.
 * A search ranks by BM25, then weighs recency (each kind of memory fades
 * at its own rate: news in days, journal entries in months, lessons never)
 * and importance (active lessons and the owner's notes count more, the
 * untrusted words of readers and of the second brain less), and can be
 * filtered by asset, period and kind. Every hit carries its provenance
 * (kind, id, date, asset) so Claude can tell what it is reading. No
 * embedding, no vector store: a semantic index waits for the recall
 * evaluation to show it is needed (decision 0005).
 */

import type Database from "better-sqlite3";
import { getKV, setKV } from "../money-lab/journal.js";

type DB = Database.Database;

export const MEMORY_KINDS = ["lesson", "reflection", "dossier", "hypothesis", "trap", "note", "order", "decision", "observation", "brain", "identity", "summary"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

/** Half-life in days per kind (Infinity: never fades). */
const HALF_LIFE: Record<MemoryKind, number> = {
  observation: 3, brain: 7, decision: 30, note: 30, order: 60, reflection: 90, summary: 180, hypothesis: 365,
  lesson: Infinity, trap: Infinity, dossier: Infinity, identity: Infinity,
};
/** Weight per kind; untrusted text counts less than Sonni's own records and the owner's notes. */
const IMPORTANCE: Record<MemoryKind, number> = {
  lesson: 1.5, note: 1.3, trap: 1.3, dossier: 1.2, summary: 1.1, reflection: 1, hypothesis: 1, decision: 1, order: 1, identity: 0.8,
  observation: 0.7, brain: 0.6,
};

interface Source {
  kind: MemoryKind;
  table: string;
  /** Rows after a rowid, with the fields the index needs. */
  sql: string;
}

const SOURCES: Source[] = [
  { kind: "lesson", table: "trader_lessons", sql: "SELECT rowid AS rid, id AS ref, NULL AS asset, recorded_at AS at, text FROM trader_lessons WHERE rowid > ? ORDER BY rowid LIMIT 500" },
  { kind: "reflection", table: "trader_reflections", sql: "SELECT rowid AS rid, id AS ref, NULL AS asset, recorded_at AS at, kind || ': ' || content AS text FROM trader_reflections WHERE rowid > ? ORDER BY rowid LIMIT 500" },
  { kind: "dossier", table: "trader_dossiers", sql: "SELECT rowid AS rid, asset || ' v' || version AS ref, asset, recorded_at AS at, content AS text FROM trader_dossiers WHERE rowid > ? ORDER BY rowid LIMIT 500" },
  { kind: "hypothesis", table: "trader_hypotheses", sql: "SELECT rowid AS rid, id AS ref, NULL AS asset, recorded_at AS at, statement || COALESCE(' / ' || statement_fr, '') AS text FROM trader_hypotheses WHERE rowid > ? ORDER BY rowid LIMIT 500" },
  { kind: "trap", table: "trader_traps", sql: "SELECT rowid AS rid, name AS ref, NULL AS asset, recorded_at AS at, name || ': ' || description || ' Signs: ' || warning_signs AS text FROM trader_traps WHERE rowid > ? ORDER BY rowid LIMIT 500" },
  { kind: "note", table: "trader_owner_notes", sql: "SELECT rowid AS rid, 'note ' || substr(at, 1, 16) AS ref, NULLIF(assets, '') AS asset, at, text FROM trader_owner_notes WHERE rowid > ? ORDER BY rowid LIMIT 500" },
  { kind: "order", table: "trader_orders", sql: "SELECT rowid AS rid, id AS ref, asset, placed_at AS at, side || ' ' || asset || ': ' || thesis AS text FROM trader_orders WHERE rowid > ? AND origin = 'model' ORDER BY rowid LIMIT 500" },
  { kind: "decision", table: "trader_decisions", sql: "SELECT rowid AS rid, id AS ref, asset, made_at AS at, action || ' ' || asset || ': ' || reason AS text FROM trader_decisions WHERE rowid > ? ORDER BY rowid LIMIT 500" },
  { kind: "observation", table: "trader_observations", sql: "SELECT rowid AS rid, id AS ref, NULLIF(assets, '') AS asset, published_at AS at, kind || ': ' || summary AS text FROM trader_observations WHERE rowid > ? ORDER BY rowid LIMIT 500" },
  { kind: "brain", table: "trader_brain_outputs", sql: "SELECT rowid AS rid, id AS ref, subject AS asset, at, kind || ': ' || content AS text FROM trader_brain_outputs WHERE rowid > ? ORDER BY rowid LIMIT 500" },
  { kind: "identity", table: "trader_identity", sql: "SELECT rowid AS rid, 'identity v' || version AS ref, NULL AS asset, recorded_at AS at, content AS text FROM trader_identity WHERE rowid > ? ORDER BY rowid LIMIT 500" },
  { kind: "summary", table: "trader_summaries", sql: "SELECT rowid AS rid, period || ' ' || start_day AS ref, NULL AS asset, start_day || 'T00:00:00.000Z' AS at, content AS text FROM trader_summaries WHERE rowid > ? ORDER BY rowid LIMIT 500" },
];

function hasTable(db: DB, table: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(table);
}

export function ensureMemoryIndex(db: DB): void {
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS trader_memory USING fts5(
    kind UNINDEXED, ref UNINDEXED, asset UNINDEXED, at UNINDEXED, text,
    tokenize = 'unicode61 remove_diacritics 2'
  )`);
}

/** Adds the rows written since the last call; returns how many. Cheap enough to run before every search. */
export function indexMemory(db: DB): number {
  ensureMemoryIndex(db);
  const insert = db.prepare("INSERT INTO trader_memory (kind, ref, asset, at, text) VALUES (?, ?, ?, ?, ?)");
  let added = 0;
  for (const src of SOURCES) {
    if (!hasTable(db, src.table)) continue;
    const key = `sonni.memory_hw.${src.kind}`;
    let hw = Number(getKV(db, key) ?? 0);
    for (;;) {
      let rows: { rid: number; ref: string; asset: string | null; at: string; text: string }[];
      try {
        rows = db.prepare(src.sql).all(hw) as any[];
      } catch {
        break; // a store from an older schema without a column: skip it
      }
      if (rows.length === 0) break;
      db.transaction(() => {
        for (const r of rows) {
          if (r.text) insert.run(src.kind, String(r.ref), r.asset ? String(r.asset).toUpperCase() : null, r.at, String(r.text));
          hw = r.rid;
          added++;
        }
      })();
      setKV(db, key, String(hw));
      if (rows.length < 500) break;
    }
  }
  return added;
}

const STOP = new Set([
  "le", "la", "les", "de", "des", "du", "un", "une", "et", "ou", "en", "au", "aux", "sur", "pour", "par", "que", "qui", "quoi",
  "est", "sont", "a", "il", "elle", "ce", "ca", "se", "sa", "son", "ses", "pas", "plus", "dans", "avec", "sait", "pense",
  // Not "or": in French it is gold ("que sait-il sur l'or ?").
  "the", "of", "and", "to", "in", "on", "for", "is", "are", "what", "does", "do", "about", "with", "it", "its", "sonni",
]);

/** A light plural fold: "liquidations" becomes "liquidation", which the prefix match extends to both forms. */
function singular(word: string): string {
  return word.length >= 5 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word;
}

/** An FTS5 query from free text: words without accents, quoted, prefix-matched from 4 letters, joined by OR. */
export function ftsQuery(text: string): string | null {
  const words = text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const terms = [...new Set(words.filter((w) => w.length >= 2 && !STOP.has(w)).map(singular))].slice(0, 12);
  if (terms.length === 0) return null;
  return terms.map((t) => (t.length >= 4 ? `"${t}"*` : `"${t}"`)).join(" OR ");
}

export interface MemoryHit {
  kind: MemoryKind;
  ref: string;
  asset: string | null;
  at: string;
  text: string;
  score: number;
}

export interface SearchOptions {
  asset?: string;
  since?: string;
  until?: string;
  kinds?: MemoryKind[];
  limit?: number;
  now?: Date;
}

export function searchMemory(db: DB, query: string, opts: SearchOptions = {}): MemoryHit[] {
  const match = ftsQuery(query);
  if (!match) return [];
  indexMemory(db);
  const where = ["trader_memory MATCH @match"];
  const params: Record<string, unknown> = { match };
  if (opts.asset) { where.push("(asset = @asset OR asset LIKE '%' || @asset || '%')"); params.asset = opts.asset.toUpperCase(); }
  if (opts.since) { where.push("at >= @since"); params.since = opts.since; }
  // A bare date includes its whole day.
  if (opts.until) { where.push("at <= @until"); params.until = /^\d{4}-\d{2}-\d{2}$/.test(opts.until) ? `${opts.until}T23:59:59.999Z` : opts.until; }
  if (opts.kinds?.length) {
    where.push(`kind IN (${opts.kinds.map((_, i) => `@k${i}`).join(", ")})`);
    opts.kinds.forEach((k, i) => { params[`k${i}`] = k; });
  }
  const rows = db.prepare(
    `SELECT kind, ref, asset, at, text, bm25(trader_memory) AS rank FROM trader_memory WHERE ${where.join(" AND ")} ORDER BY rank LIMIT 300`,
  ).all(params) as { kind: MemoryKind; ref: string; asset: string | null; at: string; text: string; rank: number }[];
  const now = (opts.now ?? new Date()).getTime();
  // The latest dossier of an asset and the latest identity are the current ones; older versions count less.
  const latestDossier = new Map<string, string>();
  const latestIdentity = rows.filter((r) => r.kind === "identity").sort((a, b) => b.at.localeCompare(a.at))[0]?.ref;
  for (const r of rows.filter((x) => x.kind === "dossier").sort((a, b) => a.at.localeCompare(b.at))) latestDossier.set(String(r.asset), r.ref);
  const retired = new Set((hasTable(db, "trader_lessons") ? db.prepare("SELECT id FROM trader_lessons WHERE status = 'retired'").all() : []).map((r: any) => r.id));
  const hits = rows.map((r) => {
    const ageDays = Math.max(0, (now - Date.parse(r.at)) / 86_400_000);
    const half = HALF_LIFE[r.kind] ?? 30;
    let weight = IMPORTANCE[r.kind] ?? 1;
    if (Number.isFinite(half)) weight *= Math.pow(0.5, ageDays / half);
    if (r.kind === "dossier" && latestDossier.get(String(r.asset)) !== r.ref) weight *= 0.3;
    if (r.kind === "identity" && r.ref !== latestIdentity) weight *= 0.3;
    if (r.kind === "lesson" && retired.has(r.ref)) weight *= 0.4;
    return { kind: r.kind, ref: r.ref, asset: r.asset, at: r.at, text: r.text, score: -r.rank * weight };
  });
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, opts.limit ?? 8);
}

const UNTRUSTED: ReadonlySet<MemoryKind> = new Set(["observation", "brain"]);

/** For the model (English labels): provenance first, untrusted text marked. */
export function formatMemoryHits(query: string, hits: MemoryHit[]): string {
  if (hits.length === 0) return `MEMORY SEARCH «${query}»: nothing found. Try other words, or sonni_memory for the sections.`;
  return [`MEMORY SEARCH «${query}» (code: full-text, weighted by recency and importance; ${hits.length} hit(s)):`,
    ...hits.map((h) => `- [${h.kind} ${h.ref}${h.asset ? ` ${h.asset}` : ""}, ${h.at.slice(0, 10)}${UNTRUSTED.has(h.kind) ? ", UNTRUSTED DATA" : ""}] ` +
      `${h.text.replace(/\s+/g, " ").slice(0, 400)}`)].join("\n");
}
