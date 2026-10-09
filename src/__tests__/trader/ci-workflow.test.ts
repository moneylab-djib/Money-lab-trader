/**
 * GitHub CI tells the truth (step 0, 2026-10-09). Until then CI ran `pnpm test` under a time limit and
 * counted the limit as a success: the suite never finished, two failing tests stayed hidden and every
 * run was green. Now .github/workflows/ci.yml runs each check of likma.project.json exactly as the
 * project runs it locally, each under its own time limit, and no step may turn a failure into a success.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { BROWSER_NAMES } from "../../money-lab/selfhosted.js";

const ROOT = path.join(__dirname, "..", "..", "..");
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), "utf-8");

interface Check { argv: string[]; timeout_seconds?: number; requires?: string[] }
interface Step { name?: string; run?: string; uses?: string; if?: unknown; shell?: unknown; "continue-on-error"?: unknown }
interface Job { if?: unknown; defaults?: unknown; "timeout-minutes"?: number; "continue-on-error"?: unknown; steps?: Step[] }

const PROJECT = JSON.parse(read("likma.project.json"));
const CHECKS: Record<string, Check> = PROJECT.commands.check;
const CI = parse(read(".github/workflows/ci.yml"));
const JOBS: Record<string, Job> = CI.jobs;
const TOOLS_STEP = "Tools the conditional tests need";

/** The argv as a bash line: plain words stay bare, anything else (globs) is single-quoted. */
const shellLine = (argv: string[]) => argv.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(" ");
const expectedRun = (check: Check) => `timeout -k 30 ${check.timeout_seconds ?? PROJECT.check_timeout_seconds} ${shellLine(check.argv)}`;
/** Ways a shell line hides a failure: `|| true`, `|| :`, `|| echo`, errexit switched off, a forced exit 0, a status test. */
const masked = (run: string) => /\|\|\s*(true|:)(?=\s|;|$)|\|\|\s*echo\b|set \+e|set \+o\s+errexit|\bexit 0\b|\$\?/m.test(run);

describe("GitHub CI runs every check and hides no failure", () => {
  it("runs on every pull request and every push to main, unfiltered, and a version tag reuses it", () => {
    expect(CI.on.pull_request).toBeNull();
    expect(CI.on.push).toEqual({ branches: ["main"] });
    expect(parse(read(".github/workflows/release.yml")).jobs.checks.uses).toBe("./.github/workflows/ci.yml");
  });

  it("runs each likma.project.json check exactly as configured, under its time limit, after what it requires", () => {
    expect(Object.keys(CHECKS).length).toBeGreaterThanOrEqual(7);
    for (const [name, check] of Object.entries(CHECKS)) {
      const homes = Object.entries(JOBS).filter(([, job]) => (job.steps ?? []).some((s) => s.name === `check: ${name}`));
      expect(homes.length, `no CI step "check: ${name}"`).toBeGreaterThan(0);
      for (const [jobName, job] of homes) {
        const steps = job.steps!;
        const at = steps.findIndex((s) => s.name === `check: ${name}`);
        expect(steps[at].run?.trim(), `${jobName} / check: ${name}`).toBe(expectedRun(check));
        for (const needed of check.requires ?? []) {
          const before = steps.findIndex((s) => s.name === `check: ${needed}`);
          expect(before, `${jobName}: "${needed}" must run before "${name}"`).toBeGreaterThanOrEqual(0);
          expect(before).toBeLessThan(at);
        }
      }
    }
    // Every CI check step is a Likma check: nothing runs in CI that the project does not run locally.
    for (const job of Object.values(JOBS)) {
      for (const step of job.steps ?? []) {
        if (step.name?.startsWith("check: ")) expect(Object.keys(CHECKS)).toContain(step.name.slice("check: ".length));
      }
    }
  });

  it("the test checks together cover the whole suite", () => {
    const suites = Object.values(CHECKS).filter((c) => c.argv.slice(0, 4).join(" ") === "pnpm exec vitest run");
    const dirs = suites.filter((c) => c.argv.length === 5).map((c) => c.argv[4]).sort();
    expect(dirs).toEqual(["src/__tests__/money-lab", "src/__tests__/trader"]);
    // One check runs the rest: everything except exactly the directories the others run, and nothing else.
    const rest = suites.filter((c) => c.argv.length !== 5);
    expect(rest).toHaveLength(1);
    const [head, pairs] = [rest[0].argv.slice(0, 4), rest[0].argv.slice(4)];
    expect(head).toEqual(["pnpm", "exec", "vitest", "run"]);
    expect(pairs.filter((_, i) => i % 2 === 0).every((flag) => flag === "--exclude")).toBe(true);
    expect(pairs.filter((_, i) => i % 2 === 1).sort()).toEqual(dirs.map((d) => `${d}/**`));
    expect(read("vitest.config.ts")).toContain(`include: ["src/__tests__/**/*.test.ts"]`);
  });

  it("no job or step can turn a failure, an error or a time limit into a success, or skip a check", () => {
    expect(CI.defaults.run.shell).toBe("bash"); // bash -e -o pipefail: a failing command, even in a pipe, fails the step
    for (const [jobName, job] of Object.entries(JOBS)) {
      expect(job.if, `${jobName} has a condition`).toBeUndefined();
      expect(job.defaults, `${jobName} overrides the shell`).toBeUndefined();
      expect(job["continue-on-error"], jobName).toBeUndefined();
      expect(job["timeout-minutes"], `${jobName} has no time limit`).toBeGreaterThan(0);
      for (const step of job.steps ?? []) {
        const where = `${jobName} / ${step.name ?? step.uses}`;
        expect(step.if, `${where} has a condition`).toBeUndefined();
        expect(step.shell, `${where} overrides the shell`).toBeUndefined();
        expect(step["continue-on-error"], where).toBeUndefined();
        expect(masked(step.run ?? ""), `${where} hides a failure`).toBe(false);
      }
      // The install fails on a lockfile that does not match package.json.
      expect((job.steps ?? []).find((s) => s.name === "install")?.run, jobName).toBe("pnpm install --frozen-lockfile");
    }
  });

  it("the tools some tests skip without are required before those tests run", () => {
    const [, job] = Object.entries(JOBS).find(([, j]) => (j.steps ?? []).some((s) => s.name === "check: sonni"))!;
    const steps = job.steps!;
    const tools = steps.findIndex((s) => s.name === TOOLS_STEP);
    expect(tools).toBeGreaterThanOrEqual(0);
    for (const name of ["check: sonni", "check: money-lab", "check: runtime"]) expect(tools).toBeLessThan(steps.findIndex((s) => s.name === name));
    const lines = steps[tools].run!.trim().split("\n").map((l) => l.trim());
    expect(lines).toContain("command -v pdftoppm");
    expect(lines.some((l) => l.startsWith("pwsh -NoProfile -Command "))).toBe(true);
    // The browser line accepts any of the names findBrowser looks for, and nothing else.
    expect(lines).toContain(BROWSER_NAMES.map((n) => `command -v ${n}`).join(" || "));
    expect(lines.filter((l) => l.includes("||"))).toHaveLength(1);
  });

  it("refuses the patterns that made the old CI green", () => {
    expect(masked("timeout 300 pnpm test\nRC=$?\nif [ $RC -eq 124 ]; then exit 0; fi")).toBe(true);
    expect(masked("pnpm audit --audit-level=high || true")).toBe(true);
    expect(masked("command -v pdftoppm || :")).toBe(true);
    expect(masked("command -v pdftoppm || echo missing")).toBe(true);
    expect(masked("set +e\npnpm test")).toBe(true);
    expect(masked("set +o errexit\npnpm test")).toBe(true);
    expect(masked(expectedRun(CHECKS.sonni))).toBe(false);
    expect(masked("command -v google-chrome || command -v chromium")).toBe(false);
    expect(shellLine(["pnpm", "exec", "vitest", "run", "--exclude", "src/__tests__/trader/**"])).toBe("pnpm exec vitest run --exclude 'src/__tests__/trader/**'");
  });
});
