/**
 * Sonni operator commands (French output), shared by the CLI
 * (automaton --sonni ...) and Telegram (/idee, /intuitions, /statut).
 */

import type Database from "better-sqlite3";
import type { TraderConfig } from "./config.js";
import { addHypothesis } from "./hypotheses.js";
import { formatHypotheses, formatSonniStatus } from "./status.js";

export const SONNI_USAGE = `Commandes Sonni :
  statut                 état de Sonni (prix, prédictions, intuitions)
  intuitions             liste des intuitions
  idee "<texte>"         ajouter une intuition à tester (origine : propriétaire)`;

export function runSonniCommand(
  argv: string[],
  db: Database.Database,
  cfg: TraderConfig,
  print: (text: string) => void = console.log,
): number {
  const [command, ...rest] = argv;
  switch (command) {
    case "statut":
    case "status":
      print(formatSonniStatus(db, cfg));
      return 0;
    case "intuitions":
      print(formatHypotheses(db));
      return 0;
    case "idee":
    case "idée": {
      const text = rest.join(" ").trim();
      if (!text) {
        print('Usage : idee "<texte de l\'intuition>"');
        return 1;
      }
      try {
        const h = addHypothesis(db, { statement: text, origin: "owner" });
        print(`Intuition ${h.id} ajoutée. Sonni pourra la tester avec ses prédictions.`);
        return 0;
      } catch (err: any) {
        print(String(err?.message ?? err));
        return 1;
      }
    }
    default:
      print(SONNI_USAGE);
      return command ? 1 : 0;
  }
}
