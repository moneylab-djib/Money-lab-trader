#!/usr/bin/env node
/**
 * Write ~/.automaton/automaton.json for Sonni on its own VPS.
 *
 * Usage (from the repository root, as the sonni user):
 *   node sonni/vps/configure.mjs --chat-id 123456789 \
 *     [--monthly-budget-eur 50] [--eur-usd 1.16] [--name sonni]
 *
 * The monthly budget (inference and paid data, decision 0003) becomes a
 * daily inference cap of one thirtieth of it, converted to USD at the
 * owner's rate. The VPS cost is not counted in Sonni's budget (the owner
 * pays it separately). Secrets are not written here: ANTHROPIC_API_KEY and
 * TELEGRAM_BOT_TOKEN belong in /etc/sonni.env.
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

const chatId = Number(opt("chat-id"));
if (!Number.isInteger(chatId) || chatId === 0) {
  console.error("Erreur : --chat-id <ton identifiant Telegram> est obligatoire (voir le guide, étape Telegram).");
  process.exit(2);
}
const name = opt("name", "sonni");
const monthlyEur = Number(opt("monthly-budget-eur", "50"));
const eurUsd = Number(opt("eur-usd", "1.16"));
for (const [label, v] of [["--monthly-budget-eur", monthlyEur], ["--eur-usd", eurUsd]]) {
  if (!Number.isFinite(v) || v <= 0) {
    console.error(`Erreur : ${label} doit être un nombre positif.`);
    process.exit(2);
  }
}

const example = JSON.parse(fs.readFileSync(path.join(here, "..", "automaton.sonni.example.json"), "utf-8"));
const lab = example.moneyLab;
lab.telegram.ownerChatId = chatId;
lab.stripe = null;
const monthlyCents = Math.round(monthlyEur * eurUsd * 100);
const dailyCents = Math.max(1, Math.round(monthlyCents / 30));
lab.inference.dailyCents = dailyCents;
lab.inference.hourlyCents = Math.max(1, Math.ceil(dailyCents / 3));
lab.funding.provisionedCents = monthlyCents;
lab.resources = [{ id: "vps", kind: "server", description: "Sonni's own VPS (paid by the owner, outside Sonni's budget)", expectedDailyCostCents: 0 }];

const dir = path.join(process.env.HOME || os.homedir(), ".automaton");
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const file = path.join(dir, "automaton.json");
const existing = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf-8")) : {};
// The runtime derives model routing and budgets at every start; copies saved
// by older versions would cap a budget the owner raises here.
delete existing.modelStrategy;
delete existing.treasuryPolicy;

const config = {
  name,
  genesisPrompt: "You are Sonni. Your mission and rules are set by the runtime.",
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
  trader: example.trader,
};
fs.writeFileSync(file, JSON.stringify(config, null, 2), { mode: 0o600 });

const usd = (cents) => `${(cents / 100).toFixed(2)} $`;
console.log(`Configuration Sonni écrite : ${file}`);
console.log(`  Modèle : ${lab.inference.model} — budget : ${monthlyEur} €/mois ≈ ${usd(monthlyCents)}, plafond ${usd(dailyCents)}/jour`);
console.log(`  Actifs suivis : ${example.trader.assets.map((a) => a.symbol).join(", ")} — prix toutes les ${example.trader.collectMinutes} min`);
console.log(`  Réveils spontanés : ${example.trader.curiosity.maxSelfWakesPerDay}/jour au plus, mouvement de ${example.trader.curiosity.moveAlertPct} % en 1 h`);
console.log(`  IA lectrices (gratuites, facultatives) : ${example.trader.readers.map((r) => `${r.id} (clé ${r.keyEnv})`).join(", ")} — clés dans /etc/sonni.env`);
console.log(`  Telegram : chat ${chatId}`);
console.log(`  Étape suivante : donner le budget du mois (en centimes de dollar) :`);
console.log(`    node dist/index.js --money-lab ledger-add owner_funding ${monthlyCents} budget-mois-1`);
