/**
 * Money Lab recall: search the agent's own memory
 *
 * Searches the notes, library and lessons the agent keeps in its home
 * directory, plus its experiment journal, and returns the best matching
 * passages with their location. Local and free: no inference, no network.
 */

import fs from "fs";
import path from "path";
import type Database from "better-sqlite3";
import { listExperiments } from "./journal.js";

const ROOTS = ["research", "library", "skills", "notes", path.join(".automaton", "skills")];
const ROOT_FILES = ["LESSONS.md", "WORKLOG.md", "SOUL.md"];
const TEXT_EXT = /\.(md|txt|json|csv|html?|css|js|mjs|ts|py|sh|ya?ml|xml|svg)$/i;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".cache"]);
const MAX_FILES = 2000;
const MAX_FILE_BYTES = 300_000;
/** Total read per search, so a huge library cannot stall the runtime. */
const MAX_TOTAL_BYTES = 20_000_000;
const CHUNK_LINES = 12;

export interface RecallHit {
  source: string;
  line: number;
  score: number;
  text: string;
}

/** Lowercase, without accents, so "facturé" matches "facture". */
function normalize(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

function terms(query: string): string[] {
  return [...new Set(normalize(query).split(/[^a-z0-9]+/).filter((t) => t.length >= 2))];
}

function walk(dir: string, out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= MAX_FILES) return;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(full, out);
    } else if (entry.isFile() && TEXT_EXT.test(entry.name)) {
      out.push(full);
    }
  }
}

/** Files searched: ~/research, ~/library, ~/skills, ~/notes, installed skills and the root notes. */
export function recallFiles(home: string): string[] {
  const files: string[] = [];
  for (const name of ROOT_FILES) {
    const file = path.join(home, name);
    try {
      if (fs.lstatSync(file).isFile()) files.push(file);
    } catch {
      // absent
    }
  }
  for (const root of ROOTS) walk(path.join(home, root), files);
  return files;
}

function scoreChunk(text: string, wanted: string[]): number {
  const norm = normalize(text);
  let score = 0;
  let matched = 0;
  for (const term of wanted) {
    const count = norm.split(term).length - 1;
    if (count > 0) {
      matched++;
      score += 1 + Math.log(count);
    }
  }
  // Passages that contain every term rank first.
  return matched === 0 ? 0 : score * (matched / wanted.length) ** 2;
}

export function recall(query: string, options: { home: string; db?: Database.Database; limit?: number }): RecallHit[] {
  const wanted = terms(query);
  if (wanted.length === 0) return [];
  const hits: RecallHit[] = [];
  const consider = (source: string, lines: string[]) => {
    for (let start = 0; start < lines.length; start += CHUNK_LINES / 2) {
      const text = lines.slice(start, start + CHUNK_LINES).join("\n").trim();
      if (!text) continue;
      const score = scoreChunk(text, wanted);
      if (score > 0) hits.push({ source, line: start + 1, score, text });
    }
  };
  let total = 0;
  for (const file of recallFiles(options.home)) {
    try {
      const size = fs.statSync(file).size;
      if (size > MAX_FILE_BYTES || total + size > MAX_TOTAL_BYTES) continue;
      total += size;
      consider(`~/${path.relative(options.home, file)}`, fs.readFileSync(file, "utf-8").split("\n"));
    } catch {
      // unreadable file: skip
    }
  }
  if (options.db) {
    for (const exp of listExperiments(options.db)) {
      consider(`experiment ${exp.id}`, JSON.stringify(exp, null, 1).split("\n"));
    }
  }
  hits.sort((a, b) => b.score - a.score);
  // One passage per overlapping window of the same source.
  const picked: RecallHit[] = [];
  for (const hit of hits) {
    if (picked.some((p) => p.source === hit.source && Math.abs(p.line - hit.line) < CHUNK_LINES)) continue;
    picked.push(hit);
    if (picked.length >= (options.limit ?? 8)) break;
  }
  return picked;
}

export function formatRecall(query: string, hits: RecallHit[]): string {
  if (hits.length === 0) {
    return `Nothing found for "${query}" in ~/research, ~/library, ~/notes, your skills, LESSONS.md or the experiment journal.`;
  }
  return [
    `Best matches for "${query}":`,
    ...hits.map((h) => `--- ${h.source}:${h.line}\n${h.text.slice(0, 800)}`),
  ].join("\n");
}
