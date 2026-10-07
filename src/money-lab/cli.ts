/**
 * Money Lab operator CLI: `automaton --money-lab <command>`.
 *
 * Local only: reads/writes the state database, never the network.
 * Resolving help, pausing/resuming and ledger entries are operator
 * actions; the agent has no tool for them.
 */

import type Database from "better-sqlite3";
import type { AutomatonConfig } from "../types.js";
import {
  LEDGER_KINDS,
  addLedgerEntry,
  ensureMoneyLabSchema,
  listHelpRequests,
  pause,
  resolveHelpRequest,
  resume,
  type LedgerKind,
} from "./journal.js";
import { formatStatus } from "./status.js";

export const MONEY_LAB_USAGE = `Money Lab operator commands:
  automaton --money-lab status
  automaton --money-lab summary
  automaton --money-lab pause "<reason>"
  automaton --money-lab resume
  automaton --money-lab help-list
  automaton --money-lab help-resolve <request-id> "<note>"
  automaton --money-lab help-reject <request-id> "<note>"
  automaton --money-lab ledger-add <kind> <amount-cents|unknown> <reference> ["<note>"] [--provider-import]
    kinds: ${LEDGER_KINDS.join(", ")}`;

export function runMoneyLabCommand(
  argv: string[],
  db: Database.Database,
  config: AutomatonConfig,
  write: (text: string) => void = (t) => process.stdout.write(t + "\n"),
): number {
  ensureMoneyLabSchema(db);
  const [command, ...rest] = argv;

  switch (command) {
    case "status":
      write(formatStatus(db, config));
      return 0;
    case "summary":
      write(formatStatus(db, config, `RÉSUMÉ QUOTIDIEN MONEY LAB ${new Date().toISOString().slice(0, 10)}`));
      return 0;
    case "pause": {
      const reason = rest.join(" ").trim() || "pause opérateur";
      const state = pause(db, reason, "operator");
      write(`Money Lab en pause depuis ${state.at} : ${state.reason}`);
      write(config.moneyLab?.runtime === "self-hosted"
        ? "Attention : la pause n'arrête PAS la facturation du VPS ni des services créés pour le bot. Voir le guide (« Arrêter le bot »)."
        : "Attention : la pause n'arrête PAS la facturation Conway. Voir la checklist d'arrêt des ressources.");
      return 0;
    }
    case "resume":
      write(resume(db) ? "Money Lab relancé ; l'agent sera réveillé." : "Money Lab n'était pas en pause.");
      return 0;
    case "help-list": {
      const open = listHelpRequests(db, "open");
      if (open.length === 0) write("Aucune demande d'aide ouverte.");
      for (const h of open) write(`${h.id} — ${h.humanAction} (reprise quand : ${h.resumeCondition})`);
      return 0;
    }
    case "help-resolve":
    case "help-reject": {
      const [id, ...noteParts] = rest;
      const note = noteParts.join(" ").trim();
      if (!id || !note) {
        write("Usage : --money-lab help-resolve|help-reject <request-id> \"<note>\"");
        return 2;
      }
      const status = command === "help-resolve" ? "resolved" : "rejected";
      const { outcome } = resolveHelpRequest(db, id, status, note);
      if (outcome === "not_found") {
        write(`Demande ${id} introuvable.`);
        return 1;
      }
      write(outcome === "updated"
        ? `Demande ${id} : ${status === "resolved" ? "résolue" : "refusée"}. L'agent sera réveillé et doit vérifier la condition de reprise.`
        : `Demande ${id} déjà clôturée ; rien n'a changé.`);
      return 0;
    }
    case "ledger-add": {
      const providerImport = rest.includes("--provider-import");
      const args = rest.filter((a) => a !== "--provider-import");
      const [kind, amount, reference, ...noteParts] = args;
      if (!kind || !amount || !reference || !LEDGER_KINDS.includes(kind as LedgerKind)) {
        write(MONEY_LAB_USAGE);
        return 2;
      }
      const amountCents = amount === "unknown" ? null : Number(amount);
      if (amountCents !== null && (!Number.isInteger(amountCents) || amountCents < 0)) {
        write("Le montant doit être un entier de cents USD ou 'unknown'.");
        return 2;
      }
      const added = addLedgerEntry(db, {
        kind: kind as LedgerKind,
        amountCents,
        source: providerImport ? "provider_import" : "operator",
        reference,
        note: noteParts.join(" ").trim() || null,
      });
      write(added ? `Écriture ${kind} enregistrée (${reference}).` : `Référence ${reference} déjà importée ; ignorée.`);
      return 0;
    }
    default:
      write(MONEY_LAB_USAGE);
      return command ? 2 : 0;
  }
}
