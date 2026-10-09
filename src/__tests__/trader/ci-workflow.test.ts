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

const ROOT = path.join(__dirname, "..", "..", "..");
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), "utf-8");

interface Check { argv: string[]; timeout_seconds?: number; requires?: string[] }
interface Step { name?: string; run?: string; uses?: string; "continue-on-error"?: unknown }
interface Job { "timeout-minutes"?: number; "continue-on-error"?: unknown; steps?: Step[]; uses?: string }

const CHECKS: Record<string, Check> = JSON.parse(read("likma.project.json")).commands.check;
const CI = parse(read(".github/workflows/ci.yml"));
const JOBS: Record<string, Job> = CI.jobs;
const DEFAULT_TIMEOUT_SECONDS = 600;

/** The argv as a bash line: plain words stay bare, anything else (globs) is single-quoted. */
const shellLine = (argv: string[]) => argv.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(" ");
const expectedRun = (check: Check) => `timeout -k 30 ${check.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS} ${shellLine(check.argv)}`;

describe("GitHub CI runs every check and hides no failure", () => {
  it("runs on every pull request and every push to main, and a version tag reuses it", () => {
    expect(CI.on).toHaveProperty("pull_request");
    expect(CI.on.push.branches).toEqual(["main"]);
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
    const dirs = suites.map((c) => c.argv.slice(4)).filter((rest) => rest.length === 1).map(([dir]) => dir);
    expect(dirs.sort()).toEqual(["src/__tests__/money-lab", "src/__tests__/trader"]);
    // One check runs the rest: everything except exactly the directories the others run.
    const rest = suites.filter((c) => c.argv.includes("--exclude"));
    expect(rest).toHaveLength(1);
    const excluded = rest[0].argv.filter((_, i, all) => all[i - 1] === "--exclude");
    expect(excluded.sort()).toEqual(dirs.map((d) => `${d}/**`).sort());
    expect(rest[0].argv.filter((a) => !a.startsWith("--") && !excluded.includes(a))).toEqual(["pnpm", "exec", "vitest", "run"]);
  });

  it("no job or step can turn a failure, an error or a time limit into a success", () => {
    expect(CI.defaults.run.shell).toBe("bash"); // bash with -e and pipefail: a failing command in a pipe fails the step
    for (const [jobName, job] of Object.entries(JOBS)) {
      expect(job["continue-on-error"], jobName).toBeUndefined();
      expect(job["timeout-minutes"], `${jobName} has no time limit`).toBeGreaterThan(0);
      for (const step of job.steps ?? []) {
        expect(step["continue-on-error"], `${jobName} / ${step.name}`).toBeUndefined();
        const run = step.run ?? "";
        expect(run, `${jobName} / ${step.name}`).not.toMatch(/\|\|\s*(true|:)\b|set \+e|\bexit 0\b|\$\?/);
      }
    }
    // The install fails on a lockfile that does not match package.json, in every job.
    for (const job of Object.values(JOBS)) {
      expect((job.steps ?? []).find((s) => s.name === "install")?.run).toBe("pnpm install --frozen-lockfile");
    }
  });

  it("refuses the patterns that made the old CI green", () => {
    const masked = (run: string) => /\|\|\s*(true|:)\b|set \+e|\bexit 0\b|\$\?/.test(run);
    expect(masked("timeout 300 pnpm test\nRC=$?\nif [ $RC -eq 124 ]; then exit 0; fi")).toBe(true);
    expect(masked("pnpm audit --audit-level=high || true")).toBe(true);
    expect(masked("set +e\npnpm test")).toBe(true);
    expect(masked(expectedRun(CHECKS.sonni))).toBe(false);
    expect(shellLine(["pnpm", "exec", "vitest", "run", "--exclude", "src/__tests__/trader/**"])).toBe("pnpm exec vitest run --exclude 'src/__tests__/trader/**'");
  });
});
