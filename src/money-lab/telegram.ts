/**
 * Telegram channel between the owner and the bot.
 *
 * Only the configured owner chat is served; every other chat is ignored.
 * Commands map to the local operator actions (same code as the CLI); any
 * other text is delivered to the agent as an inbox message and wakes it.
 * Outgoing messages come from the outbox (queueOwnerNotification), so the
 * agent loop never calls Telegram directly. The bot token is read from an
 * environment variable and never logged or shown to the agent.
 */

import type Database from "better-sqlite3";
import type { AutomatonConfig, AutomatonDatabase } from "../types.js";
import { runMoneyLabCommand } from "./cli.js";
import { formatStatus } from "./status.js";
import { buildHealthReport } from "./health.js";
import {
  getKV,
  markOwnerNotificationSent,
  queueOwnerNotification,
  pendingOwnerNotifications,
  setKV,
  OWNER_TELEGRAM_SENDER,
} from "./journal.js";

import { approvalRequired, decidePost, describePosts, setApprovalMode } from "./social.js";
import { withSecrets } from "./selfhosted.js";

const KV_OFFSET = "money_lab.telegram_offset";
const KV_SUMMARY_DAY = "money_lab.telegram_summary_day";
const MAX_MESSAGE = 3900;

export const TELEGRAM_HELP = `Commandes Money Lab :
/statut — état complet (budget, expériences, demandes, finances)
/sante — rapport de santé (envoyé aussi chaque matin)
/resume — résumé détaillé
/pause [raison] — mettre le bot en pause
/reprendre — relancer le bot
/aides — demandes d'aide ouvertes
/ok <id> [note] — demande faite (le bot vérifiera)
/non <id> [raison] — demande refusée
/fonds <montant $> [réf] — ajouter des fonds (ex : /fonds 21.50)
/revenu <montant $> <réf> — revenu hors Stripe, confirmé par toi
/publier <id> — publier une publication proposée par le bot
/rejeter <id> [raison] — refuser une publication
/publications [auto|validation] — voir les publications, ou changer le mode
/aide — cette liste
Tout autre message est transmis au bot.`;

type FetchFn = typeof fetch;

interface TelegramUpdate {
  update_id: number;
  message?: { message_id: number; chat: { id: number }; text?: string };
}

function splitMessage(text: string): string[] {
  const parts: string[] = [];
  for (let i = 0; i < text.length; i += MAX_MESSAGE) parts.push(text.slice(i, i + MAX_MESSAGE));
  return parts.length ? parts : [""];
}

/** Dollars as typed by the owner ("21.50", "21,50") to integer cents. */
export function parseDollars(value: string | undefined): number | null {
  if (!value) return null;
  const n = Number(value.replace(",", "."));
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100);
}

export class TelegramChannel {
  constructor(
    private readonly token: string,
    private readonly ownerChatId: number,
    private readonly db: AutomatonDatabase,
    private readonly config: AutomatonConfig,
    private readonly fetchFn: FetchFn = fetch,
  ) {}

  private get raw(): Database.Database {
    return this.db.raw;
  }

  private async call(method: string, payload: Record<string, unknown>): Promise<any> {
    const resp = await this.fetchFn(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      // A stalled connection must not freeze the owner's channel (/pause).
      signal: AbortSignal.timeout(30_000),
    });
    const data = (await resp.json().catch(() => ({}))) as any;
    if (!resp.ok || data.ok === false) {
      // Never include the URL (it contains the token) in the error.
      throw Object.assign(new Error(`Telegram ${method} failed: ${resp.status} ${data.description ?? ""}`.trim()), {
        status: resp.status,
      });
    }
    return data.result;
  }

  async send(text: string): Promise<void> {
    for (const part of splitMessage(text)) {
      await this.call("sendMessage", { chat_id: this.ownerChatId, text: part });
    }
  }

  /** Handle one owner message; returns the reply text (or null for forwarded text). */
  handleOwnerText(text: string, updateId: number): string | null {
    const trimmed = text.trim();
    if (!trimmed.startsWith("/")) {
      const at = new Date().toISOString();
      this.db.insertInboxMessage({
        id: `tg_${updateId}`,
        from: OWNER_TELEGRAM_SENDER,
        to: "",
        content: trimmed,
        signedAt: at,
        createdAt: at,
      });
      this.raw.prepare(
        "INSERT INTO wake_events (source, reason, payload) VALUES ('money_lab_operator', 'Message du propriétaire', '{}')",
      ).run();
      return null;
    }

    const [rawCommand, ...args] = trimmed.split(/\s+/);
    const command = rawCommand.toLowerCase().replace(/@.*$/, "");
    const out: string[] = [];
    const run = (argv: string[]) => {
      runMoneyLabCommand(argv, this.raw, this.config, (t) => out.push(t));
      return out.join("\n");
    };

    switch (command) {
      case "/start":
      case "/aide":
      case "/help":
        return TELEGRAM_HELP;
      case "/statut":
      case "/status":
        return formatStatus(this.raw, this.config);
      case "/sante":
      case "/santé":
      case "/health":
        return this.config.moneyLab ? buildHealthReport(this.raw, this.config.moneyLab).text : "Profil Money Lab absent.";
      case "/resume":
        return run(["summary"]);
      case "/pause":
        return run(["pause", ...args]);
      case "/reprendre":
        return run(["resume"]);
      case "/aides":
        return run(["help-list"]);
      case "/ok":
      case "/non": {
        const [id, ...note] = args;
        if (!id) return `Usage : ${command} <id> [note]`;
        const fallback = command === "/ok" ? "fait par le propriétaire" : "refusé par le propriétaire";
        return run([command === "/ok" ? "help-resolve" : "help-reject", id, ...(note.length ? note : [fallback])]);
      }
      case "/fonds": {
        const cents = parseDollars(args[0]);
        if (cents === null) return "Usage : /fonds <montant en $> [référence] — ex : /fonds 21.50";
        const ref = args[1] ?? `telegram-${updateId}`;
        run(["ledger-add", "owner_funding", String(cents), ref, "dépôt via Telegram"]);
        this.raw.prepare(
          "INSERT INTO wake_events (source, reason, payload) VALUES ('money_lab_operator', 'Fonds ajoutés', '{}')",
        ).run();
        return out.join("\n");
      }
      case "/revenu": {
        const cents = parseDollars(args[0]);
        if (cents === null || !args[1]) return "Usage : /revenu <montant en $> <référence> — ex : /revenu 12.00 vente-42";
        return run(["ledger-add", "confirmed_revenue", String(cents), args[1], "revenu confirmé via Telegram"]);
      }
      case "/publier":
      case "/rejeter": {
        const [id, ...note] = args;
        if (!id) return `Usage : ${command} <id>${command === "/rejeter" ? " [raison]" : ""}`;
        return decidePost(this.raw, id, command === "/publier", note.join(" "));
      }
      case "/publications": {
        if (args[0] === "auto" || args[0] === "validation") {
          setApprovalMode(this.raw, args[0] === "auto" ? "auto" : "required");
          return args[0] === "auto"
            ? "Mode automatique : le bot publie sans validation (3 publications par jour au maximum)."
            : "Mode validation : chaque publication attend ton /publier.";
        }
        return `Mode : ${approvalRequired(this.raw) ? "validation" : "automatique"}\n${describePosts(this.raw)}`;
      }
      default:
        return `Commande inconnue.\n\n${TELEGRAM_HELP}`;
    }
  }

  /** Fetch new updates, serve the owner's messages, then flush the outbox. */
  async tick(now: Date = new Date()): Promise<void> {
    const offset = Number(getKV(this.raw, KV_OFFSET) ?? "0");
    const updates = (await this.call("getUpdates", {
      offset,
      timeout: 0,
      allowed_updates: ["message"],
    })) as TelegramUpdate[];

    for (const update of updates ?? []) {
      setKV(this.raw, KV_OFFSET, String(update.update_id + 1));
      const msg = update.message;
      if (!msg || msg.chat.id !== this.ownerChatId || typeof msg.text !== "string") continue;
      const reply = this.handleOwnerText(msg.text, update.update_id);
      try {
        await this.send(reply ?? "Message transmis au bot.");
      } catch {
        // The command already ran: deliver its reply later rather than lose
        // it (an owner who sees no answer to /fonds would send it again).
        queueOwnerNotification(this.raw, reply ?? "Message transmis au bot.");
      }
    }

    // Daily health report once per UTC day, after 07:00 UTC (09:00 in Paris
    // in summer). Queued in the outbox: a Telegram outage delays it, never
    // loses it. The full summary stays available with /resume.
    const day = now.toISOString().slice(0, 10);
    if (now.getUTCHours() >= 7 && getKV(this.raw, KV_SUMMARY_DAY) !== day && this.config.moneyLab) {
      setKV(this.raw, KV_SUMMARY_DAY, day);
      queueOwnerNotification(this.raw, buildHealthReport(this.raw, this.config.moneyLab, { now }).text);
    }

    for (const item of pendingOwnerNotifications(this.raw)) {
      try {
        await this.send(item.text);
      } catch (err: any) {
        // Telegram rejects this message for good (400): drop it instead of
        // blocking every later notification; otherwise retry next tick.
        if (err?.status !== 400) throw err;
      }
      markOwnerNotificationSent(this.raw, item.id);
    }
  }
}

/** Build the channel from config and environment; null when not configured. */
export function createTelegramChannel(
  db: AutomatonDatabase,
  config: AutomatonConfig,
  env: NodeJS.ProcessEnv = withSecrets(),
  fetchFn: FetchFn = fetch,
): TelegramChannel | null {
  const tg = config.moneyLab?.telegram;
  if (!tg) return null;
  const token = env[tg.botTokenEnv];
  if (!token) return null;
  return new TelegramChannel(token, tg.ownerChatId, db, config, fetchFn);
}
