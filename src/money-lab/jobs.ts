/**
 * Money Lab scheduled jobs
 *
 * The agent schedules shell commands (check its site, collect its stats,
 * watch a ranking) that the runtime runs on its own, without any paid
 * inference. The agent is only woken when a job's result needs it: the
 * output changed, or the command started failing. Wakes are limited to one
 * per hour, and none while paused, dead or sleeping on a budget cap.
 */

import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import type Database from "better-sqlite3";
import type { ExecResult } from "../types.js";
import { getKV, getPauseState, setKV } from "./journal.js";

export const JOB_WAKE_MODES = ["on_change", "on_failure", "never"] as const;
export type JobWakeMode = (typeof JOB_WAKE_MODES)[number];

export interface ScheduledJob {
  name: string;
  command: string;
  everyMinutes: number;
  wake: JobWakeMode;
  createdAt: string;
  nextRunAt: string;
  lastRunAt?: string;
  lastExit?: number;
  lastOutput?: string;
  lastOutputHash?: string;
  /** Last time the job asked for the agent (change or new failure). */
  lastAlertAt?: string;
  lastAlert?: string;
}

const JOBS_KEY = "money_lab.jobs";
const LAST_JOB_WAKE_KEY = "money_lab.last_job_wake";
export const MAX_JOBS = 10;
export const MIN_EVERY_MINUTES = 15;
export const MAX_EVERY_MINUTES = 7 * 24 * 60;
export const JOB_TIMEOUT_MS = 120_000;
const OUTPUT_LIMIT = 1500;
const JOB_WAKE_INTERVAL_MS = 60 * 60_000;
const LOG_MAX_BYTES = 200_000;
const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function listJobs(db: Database.Database): ScheduledJob[] {
  try {
    const jobs = JSON.parse(getKV(db, JOBS_KEY) ?? "[]");
    return Array.isArray(jobs) ? (jobs as ScheduledJob[]) : [];
  } catch {
    return [];
  }
}

function saveJobs(db: Database.Database, jobs: ScheduledJob[]): void {
  setKV(db, JOBS_KEY, JSON.stringify(jobs));
}

/** Adds or replaces a job; returns an error message or the stored job. */
export function upsertJob(
  db: Database.Database,
  input: { name: unknown; command: unknown; everyMinutes: unknown; wake?: unknown },
  now = new Date(),
): ScheduledJob | string {
  const name = String(input.name ?? "");
  if (!NAME.test(name)) return "name must be 1-40 lowercase letters, digits or dashes (e.g. site-check).";
  const command = String(input.command ?? "").trim();
  if (!command || command.length > 2000) return "command must be 1-2000 characters.";
  const every = Number(input.everyMinutes);
  if (!Number.isInteger(every) || every < MIN_EVERY_MINUTES || every > MAX_EVERY_MINUTES) {
    return `every_minutes must be an integer between ${MIN_EVERY_MINUTES} and ${MAX_EVERY_MINUTES}.`;
  }
  const wake = (input.wake ?? "on_failure") as JobWakeMode;
  if (!JOB_WAKE_MODES.includes(wake)) return `wake must be one of ${JOB_WAKE_MODES.join(", ")}.`;
  const jobs = listJobs(db).filter((j) => j.name !== name);
  if (jobs.length >= MAX_JOBS) return `At most ${MAX_JOBS} jobs; remove one first.`;
  const job: ScheduledJob = { name, command, everyMinutes: every, wake, createdAt: now.toISOString(), nextRunAt: now.toISOString() };
  saveJobs(db, [...jobs, job]);
  return job;
}

export function removeJob(db: Database.Database, name: string): boolean {
  const jobs = listJobs(db);
  const kept = jobs.filter((j) => j.name !== name);
  saveJobs(db, kept);
  return kept.length !== jobs.length;
}

export function jobLogFile(name: string, home = process.env.HOME || "/root"): string {
  return path.join(home, ".money-lab", "jobs", `${name}.log`);
}

function appendLog(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, text);
  const size = fs.statSync(file).size;
  if (size > LOG_MAX_BYTES) {
    const tail = fs.readFileSync(file, "utf-8").slice(-LOG_MAX_BYTES / 2);
    fs.writeFileSync(file, tail);
  }
}

export interface JobRunOptions {
  run: (command: string, timeoutMs: number) => Promise<ExecResult>;
  /** Wakes the agent with a reason (only called when waking is allowed). */
  wake: (reason: string) => void;
  /** False while the agent must not be woken (dead, budget sleep). */
  canWake: () => boolean;
  now?: () => Date;
  home?: string;
}

/** Runs one job, stores its result and returns the alert it raises, if any. */
export async function runJob(db: Database.Database, job: ScheduledJob, options: JobRunOptions): Promise<string | null> {
  const now = options.now?.() ?? new Date();
  const result = await options.run(job.command, JOB_TIMEOUT_MS);
  const output = `${result.stdout}${result.stderr ? `\n[stderr] ${result.stderr}` : ""}`.trim();
  const hash = createHash("sha256").update(result.stdout.trim()).digest("hex");
  appendLog(jobLogFile(job.name, options.home), `--- ${now.toISOString()} exit ${result.exitCode}\n${output}\n`);

  let alert: string | null = null;
  const failedNow = result.exitCode !== 0;
  const failedBefore = job.lastExit !== undefined && job.lastExit !== 0;
  if (job.wake === "on_failure" && failedNow && !failedBefore) {
    alert = `job "${job.name}" failed (exit ${result.exitCode})`;
  } else if (job.wake === "on_change" && job.lastOutputHash && job.lastOutputHash !== hash) {
    alert = `job "${job.name}" output changed`;
  }

  const jobs = listJobs(db);
  const stored = jobs.find((j) => j.name === job.name);
  if (stored) {
    stored.lastRunAt = now.toISOString();
    stored.lastExit = result.exitCode;
    stored.lastOutput = output.slice(-OUTPUT_LIMIT);
    stored.lastOutputHash = hash;
    stored.nextRunAt = new Date(now.getTime() + job.everyMinutes * 60_000).toISOString();
    if (alert) {
      stored.lastAlertAt = now.toISOString();
      stored.lastAlert = alert;
    }
    saveJobs(db, jobs);
  }
  return alert ? `${alert}: ${output.slice(-300) || "(no output)"}` : null;
}

/** Runs every due job (never while paused) and wakes the agent at most hourly. */
export async function runDueJobs(db: Database.Database, options: JobRunOptions): Promise<string[]> {
  if (getPauseState(db)) return [];
  const now = options.now?.() ?? new Date();
  const due = listJobs(db).filter((j) => Date.parse(j.nextRunAt) <= now.getTime());
  const alerts: string[] = [];
  for (const job of due) {
    const alert = await runJob(db, job, options);
    if (alert) alerts.push(alert);
  }
  if (alerts.length > 0 && options.canWake()) {
    const last = Date.parse(getKV(db, LAST_JOB_WAKE_KEY) ?? "");
    if (!(now.getTime() - last < JOB_WAKE_INTERVAL_MS)) {
      setKV(db, LAST_JOB_WAKE_KEY, now.toISOString());
      options.wake(`scheduled ${alerts.join("; ")}`);
    }
  }
  return due.map((j) => j.name);
}

/** One line per job for the prompt and the tool. */
export function describeJobs(db: Database.Database): string {
  const jobs = listJobs(db);
  if (jobs.length === 0) return "none";
  return jobs.map((j) => {
    const last = j.lastRunAt ? `last run ${j.lastRunAt.slice(0, 16)}Z exit ${j.lastExit}` : "not run yet";
    const alert = j.lastAlert ? `; last alert ${j.lastAlertAt?.slice(0, 16)}Z: ${j.lastAlert}` : "";
    return `${j.name} (every ${j.everyMinutes} min, wake ${j.wake}; ${last}${alert})`;
  }).join("; ");
}
