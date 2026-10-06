#!/usr/bin/env node
/**
 * Conway Automaton Runtime
 *
 * The entry point for the sovereign AI agent.
 * Handles CLI args, bootstrapping, and orchestrating
 * the heartbeat daemon + agent loop.
 */

import fs from "fs";
import path from "path";
import { getWallet, getAutomatonDir } from "./identity/wallet.js";
import { provision, loadApiKeyFromConfig } from "./identity/provision.js";
import { loadConfig, resolvePath } from "./config.js";
import { createDatabase } from "./state/database.js";
import { createConwayClient } from "./conway/client.js";
import { createInferenceClient } from "./conway/inference.js";
import { createHeartbeatDaemon } from "./heartbeat/daemon.js";
import {
  loadHeartbeatConfig,
  syncHeartbeatToDb,
} from "./heartbeat/config.js";
import { consumeNextWakeEvent, insertWakeEvent, recoverInboxClaims } from "./state/database.js";
import { runAgentLoop } from "./agent/loop.js";
import { ModelRegistry } from "./inference/registry.js";
import { loadSkills } from "./skills/loader.js";
import { initStateRepo } from "./git/state-versioning.js";
import { createSocialClient } from "./social/client.js";
import { PolicyEngine } from "./agent/policy-engine.js";
import { SpendTracker } from "./agent/spend-tracker.js";
import { createDefaultRules } from "./agent/policy-rules/index.js";
import type { AutomatonIdentity, AgentState, Skill, SocialClientInterface } from "./types.js";
import { DEFAULT_TREASURY_POLICY } from "./types.js";
import { createLogger, setGlobalLogLevel, StructuredLogger } from "./observability/logger.js";
import { prettySink } from "./observability/pretty-sink.js";
import { bootstrapTopup } from "./conway/topup.js";
import { randomUUID } from "crypto";
import { keccak256, toHex } from "viem";
import { applyMoneyLabProfile, automaticTopupsAllowed, MoneyLabConfigError } from "./money-lab/profile.js";
import { installMoneyLabPaymentGuard } from "./money-lab/guard.js";
import { ensureMoneyLabSchema, getKV, getPauseState, journalFingerprint, queueOwnerNotification, setKV } from "./money-lab/journal.js";
import { afterWakeCycle, inferenceCallCount, isOperatorWake } from "./money-lab/cycle.js";
import { MONEY_LAB_WAKE_REASON_KEY } from "./money-lab/journal.js";
import { isReviewDue } from "./money-lab/review.js";
import { recordHealthEvent } from "./money-lab/health.js";
import {
  createSelfHostedClient,
  environmentProtected,
  registerSecretEnvNames,
  sealSecrets,
  withSecrets,
  markRunStarted,
  scrubbedEnv,
  seedAnthropicModels,
  survivalBalance,
  runLocalCommand,
  runAutostart,
} from "./money-lab/selfhosted.js";
import type { AutomatonConfig } from "./types.js";

const logger = createLogger("main");
const VERSION = "0.2.1";

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // ─── CLI Commands ────────────────────────────────────────────

  if (args.includes("--version") || args.includes("-v")) {
    logger.info(`Conway Automaton v${VERSION}`);
    process.exit(0);
  }

  if (args.includes("--help") || args.includes("-h")) {
    logger.info(`
Conway Automaton v${VERSION}
Sovereign AI Agent Runtime

Usage:
  automaton --run          Start the automaton (first run triggers setup wizard)
  automaton --setup        Re-run the interactive setup wizard
  automaton --configure    Edit configuration (providers, model, treasury, general)
  automaton --pick-model   Interactively pick the active inference model
  automaton --init         Initialize wallet and config directory
  automaton --provision    Provision Conway API key via SIWE
  automaton --status       Show current automaton status
  automaton --money-lab    Money Lab operator commands (status, summary, pause, resume,
                           help-list, help-resolve, help-reject, ledger-add)
  automaton --version      Show version
  automaton --help         Show this help

Environment:
  CONWAY_API_URL           Conway API URL (default: https://api.conway.tech)
  CONWAY_API_KEY           Conway API key (overrides config)
  OLLAMA_BASE_URL          Ollama base URL (overrides config, e.g. http://localhost:11434)
`);
    process.exit(0);
  }

  if (args.includes("--init")) {
    // Read chain type from genesis.json if written by parent during spawn
    let initChainType: import("./identity/chain.js").ChainType | undefined;
    try {
      const genesisPath = path.join(getAutomatonDir(), "genesis.json");
      if (fs.existsSync(genesisPath)) {
        const genesis = JSON.parse(fs.readFileSync(genesisPath, "utf-8"));
        initChainType = genesis.chainType;
      }
    } catch {}
    const { chainIdentity, isNew } = await getWallet(initChainType);
    logger.info(
      JSON.stringify({
        address: chainIdentity.address,
        isNew,
        configDir: getAutomatonDir(),
      }),
    );
    process.exit(0);
  }

  if (args.includes("--provision")) {
    try {
      const result = await provision();
      logger.info(JSON.stringify(result));
    } catch (err: any) {
      logger.error(`Provision failed: ${err.message}`);
      process.exit(1);
    }
    process.exit(0);
  }

  if (args[0] === "--money-lab") {
    process.exit(await moneyLabCommand(args.slice(1)));
  }

  if (args.includes("--status")) {
    await showStatus();
    process.exit(0);
  }

  if (args.includes("--setup")) {
    const { runSetupWizard } = await import("./setup/wizard.js");
    await runSetupWizard();
    process.exit(0);
  }

  if (args.includes("--pick-model")) {
    const { runModelPicker } = await import("./setup/model-picker.js");
    await runModelPicker();
    process.exit(0);
  }

  if (args.includes("--configure")) {
    const { runConfigure } = await import("./setup/configure.js");
    await runConfigure();
    process.exit(0);
  }

  if (args.includes("--run")) {
    StructuredLogger.setSink(prettySink);
    await run();
    return;
  }

  // Default: show help
  logger.info('Run "automaton --help" for usage information.');
  logger.info('Run "automaton --run" to start the automaton.');
}

// ─── Status Command ────────────────────────────────────────────

async function showStatus(): Promise<void> {
  const config = loadConfig();
  if (!config) {
    logger.info("Automaton is not configured. Run the setup script first.");
    return;
  }

  const dbPath = resolvePath(config.dbPath);
  const db = createDatabase(dbPath);

  const state = db.getAgentState();
  const turnCount = db.getTurnCount();
  const tools = db.getInstalledTools();
  const heartbeats = db.getHeartbeatEntries();
  const skills = db.getSkills(true);
  const children = db.getChildren();
  const registry = db.getRegistryEntry();

  logger.info(`
=== AUTOMATON STATUS ===
Name:       ${config.name}
Address:    ${config.walletAddress}
Creator:    ${config.creatorAddress}
Sandbox:    ${config.sandboxId}
State:      ${state}
Turns:      ${turnCount}
Tools:      ${tools.length} installed
Skills:     ${skills.length} active
Heartbeats: ${heartbeats.filter((h) => h.enabled).length} active
Children:   ${children.filter((c) => c.status !== "dead").length} alive / ${children.length} total
Agent ID:   ${registry?.agentId || "not registered"}
Model:      ${config.inferenceModel}
Version:    ${config.version}
========================
`);

  db.close();
}

// ─── Money Lab ─────────────────────────────────────────────────

/** Validate and apply the Money Lab profile; an invalid profile is fatal. */
function withMoneyLabProfile(config: AutomatonConfig): AutomatonConfig {
  try {
    return applyMoneyLabProfile(config);
  } catch (err) {
    if (err instanceof MoneyLabConfigError) {
      logger.error(err.message);
      process.exit(1);
    }
    throw err;
  }
}

async function moneyLabCommand(argv: string[]): Promise<number> {
  const loaded = loadConfig();
  if (!loaded) {
    logger.error("Automaton n'est pas configuré (automaton.json introuvable).");
    return 1;
  }
  const config = withMoneyLabProfile(loaded);
  if (!config.moneyLab) {
    logger.error("Aucun bloc moneyLab dans automaton.json.");
    return 1;
  }
  const { runMoneyLabCommand } = await import("./money-lab/cli.js");
  const db = createDatabase(resolvePath(config.dbPath));
  try {
    return runMoneyLabCommand(argv, db.raw, config);
  } finally {
    db.close();
  }
}

// ─── Main Run ──────────────────────────────────────────────────

async function run(): Promise<void> {
  logger.info(`[${new Date().toISOString()}] Conway Automaton v${VERSION} starting...`);

  // Load config — first run triggers interactive setup wizard
  let config = loadConfig();
  if (!config) {
    const { runSetupWizard } = await import("./setup/wizard.js");
    config = await runSetupWizard();
  }
  config = withMoneyLabProfile(config);
  const moneyLab = config.moneyLab;
  if (moneyLab) {
    if (moneyLab.payments === "disabled") {
      // Before any client is created: no x402 payment or credit purchase
      // can be signed by this process.
      installMoneyLabPaymentGuard();
    }
    logger.info(
      `[MONEY LAB] Profil actif : réplication interdite, paiements ${moneyLab.payments === "allowed" ? "autorisés" : "désactivés"}.`,
    );
  }

  // Load wallet (chain-aware)
  const { account, chainIdentity, chainType: walletChainType } = await getWallet();
  const resolvedChainType = config.chainType || walletChainType || "evm";
  // Self-hosted Money Lab runs without Conway Cloud: no Conway API key.
  const selfHosted = moneyLab?.runtime === "self-hosted";
  const apiKey = selfHosted ? "" : (config.conwayApiKey || loadApiKeyFromConfig() || "");
  const anthropicApiKey = config.anthropicApiKey || process.env.ANTHROPIC_API_KEY;
  if (selfHosted && !anthropicApiKey) {
    logger.error("Mode self-hosted : clé Anthropic manquante (ANTHROPIC_API_KEY ou anthropicApiKey).");
    process.exit(1);
  }
  // Self-hosted Money Lab: keys leave process.env before any child process
  // starts, so none inherits them (skill checks run `which`, upstream checks
  // run git...); the runtime reads them through withSecrets().
  if (selfHosted) {
    registerSecretEnvNames([moneyLab?.telegram?.botTokenEnv, moneyLab?.stripe?.apiKeyEnv]);
    sealSecrets();
  }
  if (!selfHosted && !apiKey) {
    logger.error("No API key found. Run: automaton --provision");
    process.exit(1);
  }

  // Initialize database
  const dbPath = resolvePath(config.dbPath);
  const db = createDatabase(dbPath);
  if (moneyLab) ensureMoneyLabSchema(db.raw);
  // Messages claimed by a turn that a restart or crash interrupted.
  const recovered = recoverInboxClaims(db.raw);
  if (recovered > 0) logger.info(`[INBOX] ${recovered} message(s) interrompu(s) remis en attente.`);
  // Self-hosted Money Lab: the bot's shell runs as the same user as this
  // process; unless started through dist/launch.js, it can read the keys.
  if (selfHosted && !environmentProtected()) {
    logger.warn("[MONEY LAB] Les clés du programme sont lisibles par le shell du bot : installe le nouveau fichier de service (guide, « Mettre à jour le bot »).");
    const today = new Date().toISOString().slice(0, 10);
    if (getKV(db.raw, "money_lab.unprotected_notice") !== today) {
      setKV(db.raw, "money_lab.unprotected_notice", today);
      queueOwnerNotification(db.raw,
        "🔐 Protection des clés inactive : le bot pourrait lire la clé Anthropic avec son shell. " +
        "Installe le nouveau fichier de service (guide, section « Mettre à jour le bot »).");
    }
  }

  // Persist createdAt: only set if not already stored (never overwrite)
  const existingCreatedAt = db.getIdentity("createdAt");
  const createdAt = existingCreatedAt || new Date().toISOString();
  if (!existingCreatedAt) {
    db.setIdentity("createdAt", createdAt);
  }

  // Build identity (chain-aware)
  const identity: AutomatonIdentity = {
    name: config.name,
    address: chainIdentity.address,
    account,
    creatorAddress: config.creatorAddress,
    sandboxId: selfHosted ? "" : config.sandboxId,
    apiKey,
    createdAt,
    chainType: resolvedChainType,
    chainIdentity,
  };

  // Store identity in DB
  db.setIdentity("name", config.name);
  db.setIdentity("address", chainIdentity.address);
  db.setIdentity("creator", config.creatorAddress);
  db.setIdentity("chainType", resolvedChainType);
  db.setIdentity("sandbox", config.sandboxId);
  const storedAutomatonId = db.getIdentity("automatonId");
  const automatonId = storedAutomatonId || config.sandboxId || randomUUID();
  if (!storedAutomatonId) {
    db.setIdentity("automatonId", automatonId);
  }

  // Create Conway client. Self-hosted: local commands/files on this server,
  // secrets removed from the shell environment, balance from the journal.
  const conway = selfHosted
    ? createSelfHostedClient(
      createConwayClient({ apiUrl: config.conwayApiUrl, apiKey: "", sandboxId: "", localExecEnv: scrubbedEnv() }),
      () => survivalBalance(db.raw, moneyLab!).balanceCents,
      { exec: (command, timeout) => runLocalCommand(command, timeout) },
    )
    : createConwayClient({
      apiUrl: config.conwayApiUrl,
      apiKey,
      sandboxId: config.sandboxId,
    });
  if (selfHosted) {
    markRunStarted(db.raw);
    // Background servers stop with the runtime: let the agent restart them.
    runAutostart()
      .then((r) => { if (r) logger.info(`[MONEY LAB] ~/autostart.sh exécuté (code ${r.exitCode}).`); })
      .catch((err) => logger.warn(`[MONEY LAB] ~/autostart.sh : ${err?.message ?? err}`));
  }

  // Register automaton identity (one-time, immutable)
  const registrationState = db.getIdentity("conwayRegistrationStatus");
  if (!selfHosted && registrationState !== "registered") {
    try {
      const genesisPromptHash = config.genesisPrompt
        ? keccak256(toHex(config.genesisPrompt))
        : undefined;
      await conway.registerAutomaton({
        automatonId,
        automatonAddress: chainIdentity.address,
        creatorAddress: config.creatorAddress,
        name: config.name,
        bio: config.creatorMessage || "",
        genesisPromptHash,
        account,
        chainType: resolvedChainType,
        chainIdentity,
      });
      db.setIdentity("conwayRegistrationStatus", "registered");
      logger.info(`[${new Date().toISOString()}] Automaton identity registered.`);
    } catch (err: any) {
      const status = err?.status;
      if (status === 409) {
        db.setIdentity("conwayRegistrationStatus", "conflict");
        logger.warn(`[${new Date().toISOString()}] Automaton identity conflict: ${err.message}`);
      } else {
        db.setIdentity("conwayRegistrationStatus", "failed");
        logger.warn(`[${new Date().toISOString()}] Automaton identity registration failed: ${err.message}`);
      }
    }
  }

  // Resolve Ollama base URL: env var takes precedence over config
  const ollamaBaseUrl = process.env.OLLAMA_BASE_URL || config.ollamaBaseUrl;

  // Create inference client — pass a live registry lookup so model names like
  // "gpt-oss:120b" route to Ollama based on their registered provider, not heuristics.
  const modelRegistry = new ModelRegistry(db.raw);
  modelRegistry.initialize();
  if (selfHosted) seedAnthropicModels(modelRegistry);
  const inference = createInferenceClient({
    apiUrl: config.conwayApiUrl,
    apiKey,
    defaultModel: config.inferenceModel,
    maxTokens: config.maxTokensPerTurn,
    lowComputeModel: config.modelStrategy?.lowComputeModel || "gpt-5-mini",
    openaiApiKey: config.openaiApiKey,
    anthropicApiKey,
    ollamaBaseUrl,
    getModelProvider: (modelId) => modelRegistry.get(modelId)?.provider,
    ...(moneyLab?.inference.effort ? { anthropicEffort: moneyLab.inference.effort } : {}),
    // Self-hosted Money Lab researches the web through Anthropic's server tools.
    ...(selfHosted ? { anthropicWebTools: true } : {}),
  });

  if (ollamaBaseUrl) {
    logger.info(`[${new Date().toISOString()}] Ollama backend: ${ollamaBaseUrl}`);
  }

  // Create social client (chain-aware: pass ChainIdentity for Solana signing)
  let social: SocialClientInterface | undefined;
  if (config.socialRelayUrl && !selfHosted) {
    social = createSocialClient(config.socialRelayUrl, resolvedChainType === "solana" ? chainIdentity : account);
    logger.info(`[${new Date().toISOString()}] Social relay: ${config.socialRelayUrl}`);
  }

  // Initialize PolicyEngine + SpendTracker (Phase 1.4)
  const treasuryPolicy = config.treasuryPolicy ?? DEFAULT_TREASURY_POLICY;
  const rules = createDefaultRules(treasuryPolicy);
  const policyEngine = new PolicyEngine(db.raw, rules);
  const spendTracker = new SpendTracker(db.raw);

  // Load and sync heartbeat config
  const heartbeatConfigPath = resolvePath(config.heartbeatConfigPath);
  const heartbeatConfig = loadHeartbeatConfig(heartbeatConfigPath);
  syncHeartbeatToDb(heartbeatConfig, db);

  // Load skills
  const skillsDir = config.skillsDir || "~/.automaton/skills";
  let skills: Skill[] = [];
  try {
    skills = loadSkills(skillsDir, db);
    logger.info(`[${new Date().toISOString()}] Loaded ${skills.length} skills.`);
  } catch (err: any) {
    logger.warn(`[${new Date().toISOString()}] Skills loading failed: ${err.message}`);
  }

  // Initialize state repo (git)
  try {
    await initStateRepo(conway);
    logger.info(`[${new Date().toISOString()}] State repo initialized.`);
  } catch (err: any) {
    logger.warn(`[${new Date().toISOString()}] State repo init failed: ${err.message}`);
  }

  // Bootstrap topup: buy minimum credits ($5) from USDC so the agent can start.
  // The agent decides larger topups itself via the topup_credits tool.
  // Money Lab: skipped unless payments are allowed without price caps.
  if (automaticTopupsAllowed(moneyLab)) try {
    let bootstrapTimer: ReturnType<typeof setTimeout>;
    const bootstrapTimeout = new Promise<null>((_, reject) => {
      bootstrapTimer = setTimeout(() => reject(new Error("bootstrap topup timed out")), 15_000);
    });
    try {
      await Promise.race([
        (async () => {
          const creditsCents = await conway.getCreditsBalance().catch(() => 0);
          const topupResult = await bootstrapTopup({
            apiUrl: config.conwayApiUrl,
            account,
            creditsCents,
            chainType: resolvedChainType,
          });
          if (topupResult?.success) {
            logger.info(
              `[${new Date().toISOString()}] Bootstrap topup: +$${topupResult.amountUsd} credits from USDC`,
            );
          }
        })(),
        bootstrapTimeout,
      ]);
    } finally {
      clearTimeout(bootstrapTimer!);
    }
  } catch (err: any) {
    logger.warn(`[${new Date().toISOString()}] Bootstrap topup skipped: ${err.message}`);
  }

  // Start heartbeat daemon (Phase 1.1: DurableScheduler)
  const heartbeat = createHeartbeatDaemon({
    identity,
    config,
    heartbeatConfig,
    db,
    rawDb: db.raw,
    conway,
    social,
    onWakeRequest: (reason) => {
      logger.info(`[HEARTBEAT] Wake request: ${reason}`);
      // Phase 1.1: Use wake_events table instead of KV wake_request
      insertWakeEvent(db.raw, 'heartbeat', reason);
    },
  });

  heartbeat.start();
  logger.info(`[${new Date().toISOString()}] Heartbeat daemon started.`);

  // Money Lab: owner channel (Telegram) and Stripe revenue sync. Both run
  // outside the agent loop and never expose their secrets to the agent.
  const backgroundTimers: ReturnType<typeof setInterval>[] = [];
  const every = (ms: number, label: string, fn: () => Promise<unknown>) => {
    let busy = false;
    const run = async () => {
      if (busy) return;
      busy = true;
      try {
        await fn();
      } catch (err: any) {
        logger.warn(`[MONEY LAB] ${label} : ${err?.message ?? err}`);
        recordHealthEvent(db.raw, label, String(err?.message ?? err));
      } finally {
        busy = false;
      }
    };
    void run();
    backgroundTimers.push(setInterval(run, ms));
  };
  if (moneyLab?.telegram) {
    const { createTelegramChannel } = await import("./money-lab/telegram.js");
    const channel = createTelegramChannel(db, config);
    if (channel) {
      every(10_000, "Telegram", () => channel.tick());
      logger.info("[MONEY LAB] Canal Telegram actif.");
    } else {
      logger.warn(`[MONEY LAB] Telegram configuré mais ${moneyLab.telegram.botTokenEnv} est absent.`);
    }
  }
  if (moneyLab) {
    const { backupStateDaily } = await import("./money-lab/backup.js");
    every(60 * 60_000, "Sauvegarde", async () => {
      const file = await backupStateDaily(db.raw);
      if (file) logger.info(`[MONEY LAB] Sauvegarde quotidienne : ${file}`);
    });
  }
  if (moneyLab && selfHosted) {
    const { runDueJobs } = await import("./money-lab/jobs.js");
    every(60_000, "Tâches programmées", async () => {
      await runDueJobs(db.raw, {
        run: (command, timeout) => runLocalCommand(command, timeout),
        wake: (reason) => insertWakeEvent(db.raw, "money_lab_job", reason),
        // No wake while dead or sleeping on a budget cap: the cycle would be blocked.
        canWake: () => db.getAgentState() !== "dead" && !String(db.getKV("sleep_reason") ?? "").startsWith("plafond"),
      });
    });
  }
  if (moneyLab) {
    const { blueskyCredentials, publishApproved } = await import("./money-lab/social.js");
    if (blueskyCredentials()) {
      every(60_000, "Bluesky", async () => {
        await publishApproved(db.raw);
      });
      logger.info("[MONEY LAB] Publication Bluesky active.");
    }
  }
  if (moneyLab?.stripe) {
    const stripeCfg = moneyLab.stripe;
    const stripeKey = withSecrets()[stripeCfg.apiKeyEnv];
    if (stripeKey) {
      const { syncStripe } = await import("./money-lab/stripe.js");
      every(stripeCfg.syncMinutes * 60_000, "Stripe", () => syncStripe(db.raw, stripeCfg, stripeKey));
      logger.info("[MONEY LAB] Synchronisation Stripe active.");
    } else {
      logger.warn(`[MONEY LAB] Stripe configuré mais ${stripeCfg.apiKeyEnv} est absent.`);
    }
  }

  // Handle graceful shutdown
  const shutdown = () => {
    logger.info(`[${new Date().toISOString()}] Shutting down...`);
    for (const timer of backgroundTimers) clearInterval(timer);
    heartbeat.stop();
    db.setAgentState("sleeping");
    db.close();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // ─── Main Run Loop ──────────────────────────────────────────
  // The automaton alternates between running and sleeping.
  // The heartbeat can wake it up.

  while (true) {
    try {
      // Reload skills (may have changed since last loop)
      try {
        skills = loadSkills(skillsDir, db);
      } catch (error) {
        logger.error("Skills reload failed", error instanceof Error ? error : undefined);
      }

      // Money Lab: a paused instance does not start a wake cycle.
      if (moneyLab && getPauseState(db.raw)) {
        db.setAgentState("sleeping");
        await sleep(30_000);
        continue;
      }
      const fingerprintBefore = moneyLab ? journalFingerprint(db.raw) : "";
      const inferenceCallsBefore = moneyLab ? inferenceCallCount(db.raw) : 0;

      // Run the agent loop
      await runAgentLoop({
        identity,
        config,
        db,
        conway,
        inference,
        social,
        skills,
        policyEngine,
        spendTracker,
        ollamaBaseUrl,
        onStateChange: (state: AgentState) => {
          logger.info(`[${new Date().toISOString()}] State: ${state}`);
        },
        onTurnComplete: (turn) => {
          logger.info(
            `[${new Date().toISOString()}] Turn ${turn.id}: ${turn.toolCalls.length} tools, ${turn.tokenUsage.totalTokens} tokens`,
          );
        },
      });

      if (moneyLab) {
        const cycle = afterWakeCycle(db.raw, moneyLab, fingerprintBefore, Date.now(), inferenceCallsBefore);
        if (cycle.longSleepUntil) {
          logger.info(
            `[MONEY LAB] ${cycle.noProgressCycles} cycles sans progrès du journal : sommeil jusqu'à ${cycle.longSleepUntil}.`,
          );
        }
      }

      // Agent loop exited (sleeping or dead)
      const state = db.getAgentState();

      if (state === "dead") {
        logger.info(`[${new Date().toISOString()}] Automaton is dead. Heartbeat will continue.`);
        // In dead state, we just wait for funding
        // The heartbeat will keep checking and broadcasting distress
        await sleep(300_000); // Check every 5 minutes
        continue;
      }

      if (state === "sleeping") {
        const sleepUntilStr = db.getKV("sleep_until");
        const sleepUntil = sleepUntilStr
          ? new Date(sleepUntilStr).getTime()
          : Date.now() + 60_000;
        const sleepMs = Math.max(sleepUntil - Date.now(), 10_000);
        logger.info(
          `[${new Date().toISOString()}] Sleeping for ${Math.round(sleepMs / 1000)}s`,
        );

        // Sleep, but check for wake requests periodically
        const checkInterval = Math.min(sleepMs, 30_000);
        let slept = 0;
        while (slept < sleepMs) {
          await sleep(checkInterval);
          slept += checkInterval;

          // Money Lab: the weekly review cuts an agent-chosen sleep short, but
          // not a budget sleep (the review would be blocked anyway).
          if (
            moneyLab && isReviewDue(db.raw) && !getPauseState(db.raw) && db.getAgentState() !== "dead" &&
            !String(db.getKV("sleep_reason") ?? "").startsWith("plafond")
          ) {
            logger.info("[MONEY LAB] Bilan hebdomadaire dû : réveil.");
            db.setKV(MONEY_LAB_WAKE_REASON_KEY, "weekly review due");
            db.deleteKV("sleep_until");
            break;
          }

          // Phase 1.1: Check for wake events from wake_events table (atomic consume)
          const wakeEvent = consumeNextWakeEvent(db.raw);
          // Money Lab: only the operator can cut a sleep short. Heartbeat
          // distress/inbox wakes would otherwise start paid cycles.
          if (wakeEvent && moneyLab && !isOperatorWake(wakeEvent)) {
            logger.info(`[MONEY LAB] Réveil ignoré pendant le sommeil (${wakeEvent.source}) : ${wakeEvent.reason}`);
            continue;
          }
          if (wakeEvent) {
            logger.info(
              `[${new Date().toISOString()}] Woken by ${wakeEvent.source}: ${wakeEvent.reason}`,
            );
            // Money Lab: tell the agent why it was woken (help answered,
            // owner message, funds added...) instead of letting it guess.
            if (moneyLab) db.setKV(MONEY_LAB_WAKE_REASON_KEY, wakeEvent.reason);
            db.deleteKV("sleep_until");
            break;
          }
        }

        // Clear sleep state
        db.deleteKV("sleep_until");
        if (moneyLab) db.deleteKV("sleep_reason");
        continue;
      }
    } catch (err: any) {
      logger.error(
        `[${new Date().toISOString()}] Fatal error in run loop: ${err.message}`,
      );
      // Wait before retrying
      await sleep(30_000);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Entry Point ───────────────────────────────────────────────

main().catch((err) => {
  logger.error(`Fatal: ${err.message}`);
  process.exit(1);
});
