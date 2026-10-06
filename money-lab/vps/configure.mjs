#!/usr/bin/env node
/**
 * Write ~/.automaton/automaton.json for a self-hosted Money Lab run.
 *
 * Usage (from the repository root, as the bot user):
 *   node money-lab/vps/configure.mjs --chat-id 123456789 \
 *     [--name money-lab] [--vps-cost-per-month 5] [--eur-usd 1] \
 *     [--daily-budget 3] [--no-stripe]
 *
 * Secrets are not written here: ANTHROPIC_API_KEY, TELEGRAM_BOT_TOKEN and
 * STRIPE_API_KEY belong in the systemd environment file.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
};
const flag = (name) => args.includes(`--${name}`);

const chatId = Number(opt("chat-id"));
if (!Number.isInteger(chatId) || chatId === 0) {
  console.error("Erreur : --chat-id <ton identifiant Telegram> est obligatoire (voir le guide, étape Telegram).");
  process.exit(2);
}
const name = opt("name", "money-lab");
const vpsMonthly = Number(opt("vps-cost-per-month", "0"));
const eurUsd = Number(opt("eur-usd", "1"));
const dailyBudget = Number(opt("daily-budget", "3"));
for (const [label, v] of [["--vps-cost-per-month", vpsMonthly], ["--eur-usd", eurUsd], ["--daily-budget", dailyBudget]]) {
  if (!Number.isFinite(v) || v < 0) {
    console.error(`Erreur : ${label} doit être un nombre positif.`);
    process.exit(2);
  }
}

const example = JSON.parse(fs.readFileSync(path.join(here, "..", "automaton.money-lab.example.json"), "utf-8"));
delete example._comment;
const lab = example.moneyLab;
lab.telegram.ownerChatId = chatId;
if (flag("no-stripe")) lab.stripe = null;
else lab.stripe.usdPerUnit = eurUsd > 0 ? eurUsd : 1;
const dailyCents = Math.round(dailyBudget * 100);
lab.inference.dailyCents = dailyCents > 0 ? dailyCents : null;
lab.inference.hourlyCents = dailyCents > 0 ? Math.max(1, Math.ceil(dailyCents / 3)) : null;
lab.resources[0].expectedDailyCostCents = vpsMonthly > 0 ? Math.ceil((vpsMonthly * 100) / 30) : null;

const dir = path.join(process.env.HOME || os.homedir(), ".automaton");
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const file = path.join(dir, "automaton.json");
const existing = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf-8")) : {};
// The runtime derives model routing and budgets from moneyLab at every start;
// copies saved by older versions would cap a budget the owner raises here.
delete existing.modelStrategy;
delete existing.treasuryPolicy;

const config = {
  name,
  genesisPrompt: example.genesisPrompt,
  creatorAddress: existing.creatorAddress || "0x0000000000000000000000000000000000000000",
  registeredWithConway: false,
  sandboxId: "",
  walletAddress: existing.walletAddress || "",
  inferenceModel: lab.inference.model,
  maxTokensPerTurn: lab.inference.maxOutputTokens,
  dbPath: "~/.automaton/state.db",
  heartbeatConfigPath: "~/.automaton/heartbeat.yml",
  skillsDir: "~/.automaton/skills",
  version: "0.2.1",
  logLevel: "info",
  ...existing,
  maxChildren: 0,
  socialRelayUrl: "",
  moneyLab: lab,
};
fs.writeFileSync(file, JSON.stringify(config, null, 2), { mode: 0o600 });

const skillSrc = path.join(here, "..", "skills", "money-lab-strategy");
const skillDst = path.join(dir, "skills", "money-lab-strategy");
fs.mkdirSync(skillDst, { recursive: true });
fs.copyFileSync(path.join(skillSrc, "SKILL.md"), path.join(skillDst, "SKILL.md"));

console.log(`Configuration Money Lab écrite : ${file}`);
console.log(`  Modèle : ${lab.inference.model} — budget inférence : ${lab.inference.dailyCents === null ? "aucune limite" : `${(lab.inference.dailyCents / 100).toFixed(2)} $/jour`}`);
console.log(`  Telegram : chat ${chatId} — Stripe : ${lab.stripe ? `actif (${lab.stripe.currency}, × ${lab.stripe.usdPerUnit} USD)` : "désactivé"}`);
console.log(`  Coût VPS compté : ${lab.resources[0].expectedDailyCostCents === null ? "inconnu (non compté)" : `${lab.resources[0].expectedDailyCostCents} cents/jour`}`);
