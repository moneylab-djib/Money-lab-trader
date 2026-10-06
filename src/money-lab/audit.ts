/**
 * Money Lab page audit (Lighthouse)
 *
 * Runs Lighthouse with the server's Chrome on a page and turns its report
 * into a short list the agent can act on: the four category scores, the
 * main speed metrics, the failing checks with the most weight first (with
 * an example element), and the biggest speed opportunities.
 */

import fs from "fs";
import path from "path";
import type { ExecResult } from "../types.js";
import { RUNTIME_ROOT } from "./guard.js";
import { shellQuote } from "./selfhosted.js";

export const AUDIT_TIMEOUT_MS = 180_000;
const KEEP_REPORTS = 10;
const CATEGORIES = ["performance", "accessibility", "best-practices", "seo"];
const METRICS: Array<[string, string]> = [
  ["first-contentful-paint", "FCP"],
  ["largest-contentful-paint", "LCP"],
  ["total-blocking-time", "TBT"],
  ["cumulative-layout-shift", "CLS"],
  ["speed-index", "Speed Index"],
];

interface LighthouseAudit {
  id: string;
  title: string;
  score: number | null;
  scoreDisplayMode?: string;
  displayValue?: string;
  details?: {
    type?: string;
    overallSavingsMs?: number;
    items?: Array<{ node?: { snippet?: string; selector?: string }; url?: string; source?: { url?: string } }>;
  };
}

export interface LighthouseReport {
  finalDisplayedUrl?: string;
  requestedUrl?: string;
  runtimeError?: { message?: string };
  configSettings?: { formFactor?: string };
  categories: Record<string, { id: string; title: string; score: number | null; auditRefs: Array<{ id: string; weight: number }> }>;
  audits: Record<string, LighthouseAudit>;
}

function example(audit: LighthouseAudit): string {
  const item = audit.details?.items?.find((i) => i.node?.snippet || i.url || i.source?.url);
  const text = item?.node?.snippet ?? item?.url ?? item?.source?.url;
  return text ? ` — e.g. ${text.replace(/\s+/g, " ").slice(0, 140)}` : "";
}

/** Short, actionable summary of a Lighthouse JSON report. */
export function summarizeLighthouse(report: LighthouseReport, reportFile?: string): string {
  if (report.runtimeError?.message) return `Lighthouse could not audit the page: ${report.runtimeError.message}`;
  const url = report.finalDisplayedUrl ?? report.requestedUrl ?? "page";
  const scores = CATEGORIES
    .filter((id) => report.categories[id])
    .map((id) => {
      const c = report.categories[id];
      return `${c.title} ${c.score === null ? "n/a" : Math.round(c.score * 100)}`;
    });
  const metrics = METRICS
    .filter(([id]) => report.audits[id]?.displayValue)
    .map(([id, label]) => `${label} ${report.audits[id].displayValue}`);

  const failing = new Map<string, { weight: number; category: string; audit: LighthouseAudit }>();
  for (const id of CATEGORIES) {
    const category = report.categories[id];
    if (!category) continue;
    for (const ref of category.auditRefs) {
      const audit = report.audits[ref.id];
      if (!audit || ref.weight <= 0 || audit.score === null || audit.score >= 0.9) continue;
      if (audit.scoreDisplayMode === "manual" || audit.scoreDisplayMode === "notApplicable") continue;
      const impact = ref.weight * (1 - audit.score);
      const seen = failing.get(audit.id);
      if (!seen || seen.weight < impact) failing.set(audit.id, { weight: impact, category: category.title, audit });
    }
  }
  const fixes = [...failing.values()]
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 12)
    .map(({ category, audit }) =>
      `- [${category}] ${audit.title}${audit.displayValue ? ` (${audit.displayValue})` : ""}${example(audit)}`);

  const opportunities = Object.values(report.audits)
    .filter((a) => (a.details?.overallSavingsMs ?? 0) >= 100)
    .sort((a, b) => (b.details!.overallSavingsMs ?? 0) - (a.details!.overallSavingsMs ?? 0))
    .slice(0, 5)
    .map((a) => `- ${a.title}: about ${Math.round(a.details!.overallSavingsMs!)} ms to save${example(a)}`);

  return [
    `Lighthouse (${report.configSettings?.formFactor ?? "mobile"}) ${url}: ${scores.join(", ")}.`,
    metrics.length ? `Speed: ${metrics.join(", ")}.` : "",
    fixes.length ? `To fix, most impact first:\n${fixes.join("\n")}` : "No failing checks: well done.",
    opportunities.length ? `Speed opportunities:\n${opportunities.join("\n")}` : "",
    reportFile ? `Full report: ${reportFile}` : "",
  ].filter(Boolean).join("\n");
}

/** Lighthouse CLI shipped with the runtime. */
export function lighthouseCli(): string {
  return path.join(RUNTIME_ROOT, "node_modules", "lighthouse", "cli", "index.js");
}

export async function auditPage(
  url: string,
  formFactor: "mobile" | "desktop",
  options: { exec: (command: string, timeoutMs: number) => Promise<ExecResult>; browser: string; home: string },
): Promise<string> {
  const dir = path.join(options.home, ".money-lab", "lighthouse");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${Date.now()}-${formFactor}.json`);
  const command = [
    `CHROME_PATH=${shellQuote(options.browser)}`,
    shellQuote(process.execPath),
    shellQuote(lighthouseCli()),
    shellQuote(url),
    "--output=json",
    `--output-path=${shellQuote(file)}`,
    "--quiet",
    `--only-categories=${CATEGORIES.join(",")}`,
    shellQuote("--chrome-flags=--headless=new --no-sandbox --disable-gpu"),
    ...(formFactor === "desktop" ? ["--preset=desktop"] : []),
  ].join(" ");
  const result = await options.exec(command, AUDIT_TIMEOUT_MS);
  if (!fs.existsSync(file)) {
    return `Lighthouse failed (exit ${result.exitCode}): ${(result.stderr || result.stdout).slice(-500)}`;
  }
  const old = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort().slice(0, -KEEP_REPORTS);
  for (const f of old) fs.rmSync(path.join(dir, f), { force: true });
  try {
    return summarizeLighthouse(JSON.parse(fs.readFileSync(file, "utf-8")) as LighthouseReport, file);
  } catch (err: any) {
    return `Lighthouse report unreadable: ${String(err?.message ?? err).slice(0, 200)}`;
  }
}
