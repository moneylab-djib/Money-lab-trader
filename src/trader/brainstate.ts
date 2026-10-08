/**
 * The second brain's mode and link state (plan of 2026-10-08 step 3).
 *
 * Kept apart from brain.ts so the readers (src/trader/readers.ts) can
 * prepend the second brain without an import cycle. Mode and health live
 * in the kv table: the owner chooses the mode with /cerveau (assistant by
 * default); the worker records whether the PC answers.
 */

import type Database from "better-sqlite3";
import { getKV, setKV } from "../money-lab/journal.js";
import type { ReaderConfig, TraderConfig } from "./config.js";

type DB = Database.Database;

export const BRAIN_MODES = ["off", "assistant", "parallel", "delegated"] as const;
export type BrainMode = (typeof BRAIN_MODES)[number];
export const DEFAULT_BRAIN_MODE: BrainMode = "assistant";
export const BRAIN_READER_ID = "second_brain";

const KV_MODE = "sonni.brain_mode";
const KV_HEALTH = "sonni.brain_health";

export const MODE_FR: Record<BrainMode, string> = {
  off: "arrêt", assistant: "assistant", parallel: "parallèle", delegated: "délégué",
};

export function brainMode(db: DB): BrainMode {
  const m = getKV(db, KV_MODE);
  return (BRAIN_MODES as readonly string[]).includes(m ?? "") ? (m as BrainMode) : DEFAULT_BRAIN_MODE;
}

export function setBrainMode(db: DB, mode: BrainMode): void {
  setKV(db, KV_MODE, mode);
}

export interface BrainHealth {
  online: boolean;
  /** When the current state (online or offline) began. */
  since: string;
  lastCheckAt: string;
  lastOkAt: string | null;
  lastError: string | null;
  /** True once the incident for the current outage was recorded. */
  incidentRecorded: boolean;
  /** The model the PC says it serves (its /models list), stored with each answer so evidence never mixes models. */
  model?: string | null;
}

export function brainHealth(db: DB): BrainHealth | null {
  try {
    const raw = getKV(db, KV_HEALTH);
    return raw ? (JSON.parse(raw) as BrainHealth) : null;
  } catch {
    return null;
  }
}

export function setBrainHealth(db: DB, h: BrainHealth): void {
  setKV(db, KV_HEALTH, JSON.stringify(h));
}

/** True when the second brain may be asked: configured, keyed, not switched off, and answering. */
export function brainUsable(db: DB, cfg: TraderConfig, env: NodeJS.ProcessEnv): boolean {
  const b = cfg.secondBrain;
  if (!b || !env[b.keyEnv]) return false;
  if (brainMode(db) === "off") return false;
  return brainHealth(db)?.online === true;
}

/** The second brain seen as the first reader: a long timeout, no daily cap that matters, no thinking phase. */
export function brainAsReader(cfg: TraderConfig): ReaderConfig | null {
  const b = cfg.secondBrain;
  if (!b) return null;
  return {
    id: BRAIN_READER_ID,
    baseUrl: b.baseUrl,
    model: b.model,
    keyEnv: b.keyEnv,
    dailyRequests: 100_000,
    jsonMode: true,
    timeoutMs: b.timeoutSeconds * 1000,
    ...(b.noThinking ? { extraBody: { chat_template_kwargs: { enable_thinking: false } } } : {}),
  };
}
