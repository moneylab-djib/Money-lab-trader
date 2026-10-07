/**
 * Sonni operator commands (French output), shared by the CLI
 * (automaton --sonni ...) and Telegram (/idee, /intuitions, /statut...).
 */

import type Database from "better-sqlite3";
import { withSecrets } from "../money-lab/selfhosted.js";
import type { TraderConfig } from "./config.js";
import { formatWakesFr } from "./curiosity.js";
import { addHypothesis } from "./hypotheses.js";
import { formatReadersFr } from "./readers.js";
import { decideSource, formatSourcesFr } from "./sources.js";
import { formatSelfReportFr, IDENTITY_ANCHOR, retireLesson, reviseIdentity, selfReport } from "./soul.js";
import { formatAgenda, formatHypotheses, formatIdentityFr, formatJournalFr, formatLessonsFr, formatSonniStatus } from "./status.js";
import { activeConfig, formatUniverseFr } from "./universe.js";

export const SONNI_USAGE = `Commandes Sonni :
  statut                 état de Sonni (prix, prédictions, intuitions)
  intuitions             liste des intuitions
  agenda                 événements des 30 prochains jours
  idee "<texte>"         ajouter une intuition à tester (origine : propriétaire)
  bilan                  calibration et scores calculés par le code
  identite [texte]       l'identité que Sonni s'est écrite (et ses versions) ; avec un texte, ta version
                         (elle doit garder « Je suis Sonni »)
  journal [n]            ses n dernières réflexions (défaut 5)
  lecons                 ses leçons actives
  veto <id> [raison]     retirer une leçon
  reveils                ses réveils et déclencheurs des 7 derniers jours
  lecteurs               état des IA lectrices gratuites
  sources                sources de données et dernières valeurs
  source ok|non <id> [note]  accepter ou refuser une source proposée par Sonni
  actifs                 actifs suivis et changements décidés par Sonni`;

/** The owner reads French; the validation messages are written for the model, in English. */
function identityRefusalFr(error: string): string {
  if (error.includes(IDENTITY_ANCHOR)) return `le texte doit contenir « ${IDENTITY_ANCHOR} ».`;
  if (error.includes("unchanged")) return "c'est déjà la version actuelle.";
  const short = /at least (\d+)/.exec(error);
  if (short) return `trop court (au moins ${short[1]} caractères).`;
  const long = /at most (\d+) characters \(got (\d+)\)/.exec(error);
  if (long) return `trop long (${long[2]} caractères, au plus ${long[1]}).`;
  if (error.includes("prompt-boundary") || error.includes("section headers")) {
    return "le texte contient des marqueurs réservés (titres #, ---, balises ou noms de sections du runtime) ; écris-le en prose.";
  }
  return error;
}

export interface SonniCommandOptions {
  /** Owner's daily inference cap, for the self-report. */
  dailyCapCents?: number | null;
  env?: NodeJS.ProcessEnv;
}

export function runSonniCommand(
  argv: string[],
  db: Database.Database,
  cfg: TraderConfig,
  print: (text: string) => void = console.log,
  options: SonniCommandOptions = {},
): number {
  const [command, ...rest] = argv;
  const live = activeConfig(db, cfg);
  switch (command) {
    case "statut":
    case "status":
      print(formatSonniStatus(db, cfg));
      return 0;
    case "intuitions":
      print(formatHypotheses(db));
      return 0;
    case "agenda":
      print(formatAgenda(db));
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
    case "bilan":
      print(formatSelfReportFr(selfReport(db, live, options.dailyCapCents ?? null)));
      return 0;
    case "identite":
    case "identité": {
      // With a text, the owner writes a new version (kept with the others; Sonni reads it at once).
      const text = rest.join(" ").trim();
      if (!text) {
        print(formatIdentityFr(db));
        return 0;
      }
      const r = reviseIdentity(db, { content: text, reason: "correction du propriétaire", source: "owner" });
      print(r.ok ? `Identité version ${r.value.version} enregistrée (écrite par toi). Sonni la lira à son prochain tour.` : `Refusé : ${identityRefusalFr(r.error)}`);
      return r.ok ? 0 : 1;
    }
    case "journal": {
      const n = Number(rest[0] ?? "5");
      print(formatJournalFr(db, Number.isInteger(n) && n > 0 ? Math.min(n, 30) : 5));
      return 0;
    }
    case "lecons":
    case "leçons":
      print(formatLessonsFr(db));
      return 0;
    case "veto": {
      const [id, ...note] = rest;
      if (!id) {
        print("Usage : veto <id de la leçon> [raison]");
        return 1;
      }
      const r = retireLesson(db, id, "owner", note.join(" ") || "veto du propriétaire");
      print(r.ok ? `Leçon ${r.value.id} retirée : « ${r.value.text} »` : r.error);
      return r.ok ? 0 : 1;
    }
    case "reveils":
    case "réveils":
      print(formatWakesFr(db, live));
      return 0;
    case "lecteurs":
      print(formatReadersFr(db, live, options.env ?? withSecrets()));
      return 0;
    case "sources":
      print(formatSourcesFr(db));
      return 0;
    case "source": {
      const [decision, id, ...note] = rest;
      if ((decision !== "ok" && decision !== "non") || !id) {
        print("Usage : source ok <id> [note] ou source non <id> [raison]");
        return 1;
      }
      const r = decideSource(db, id, decision === "ok", note.join(" "));
      print(r.ok ? `Source ${r.value.id} ${r.value.status === "enabled" ? "acceptée et activée" : "refusée"}.` : r.error);
      return r.ok ? 0 : 1;
    }
    case "actifs":
      print(formatUniverseFr(db, cfg));
      return 0;
    default:
      print(SONNI_USAGE);
      return command ? 1 : 0;
  }
}
