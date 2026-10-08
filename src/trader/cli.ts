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
import { type BudgetView, formatAgenda, formatHypotheses, formatIdentityFr, formatJournalFr, formatLessonsFr, formatPortfolioFr, formatSonniStatus } from "./status.js";
import { buildSonniEveningSummary } from "./report.js";
import { addOwnerNote, formatDossierFr, listDossiers, listOwnerNotes, refusalFr } from "./dossiers.js";
import { exportNotebooks, notebooksDir } from "./notebooks.js";
import { formatCyclesFr } from "./cycles.js";
import { fmtWhen } from "./format.js";
import { recall } from "../money-lab/recall.js";
import { searchMemory, type MemoryHit } from "./memory.js";
import type { MoneyLabConfig } from "../money-lab/profile.js";
import { activeConfig, formatUniverseFr, ownerVeto } from "./universe.js";
import { formatScreenFr } from "./screen.js";
import { askBrainFr, formatBrainFr, setBrainModeFr } from "./brain.js";

/** /memoire (plan of 2026-10-08 step 4): hits of the full-text memory index, labelled in French, without identifiers. */
export function formatMemoireFr(db: Database.Database, query: string, hits: MemoryHit[]): string {
  if (hits.length === 0) return `🧠 Rien dans la mémoire de Sonni sur « ${query} » (dossiers, intuitions, journal, leçons, pièges, tes notes, ses ordres et décisions, l'actualité).`;
  const day = (at: string) => at.slice(0, 10);
  const status = (id: string) => (db.prepare("SELECT status FROM trader_lessons WHERE id = ?").get(id) as { status: string } | undefined)?.status === "retired" ? "retirée" : "active";
  const strip = (text: string) => text.replace(/^[^:]{1,80}:\s*/, "");
  const line = (h: MemoryHit): [string, string] => {
    switch (h.kind) {
      case "lesson": return [`leçon (${status(h.ref)})`, h.text];
      case "reflection": return [`journal (${h.text.split(":")[0]}) du ${day(h.at)}`, strip(h.text)];
      case "dossier": return [`dossier ${h.ref}`, h.text];
      case "hypothesis": return [`intuition du ${day(h.at)}`, h.text];
      case "trap": return [`piège « ${h.ref} »`, strip(h.text).replace(/ Signs: /, " Signes : ")];
      case "note": return [`ta note du ${day(h.at)}`, h.text];
      case "order": return [`ordre ${h.text.startsWith("buy") ? "d'achat" : "de vente"} ${h.asset ?? ""} du ${day(h.at)}`, strip(h.text)];
      case "decision": return [`décision ${h.asset ?? ""} du ${day(h.at)}`, h.text];
      case "observation": return [`actualité du ${day(h.at)}, non vérifiée`, strip(h.text)];
      case "brain": return [`second cerveau, ${day(h.at)}, non vérifié`, strip(h.text)];
      case "identity": return [h.ref.replace("identity", "identité"), h.text];
      case "summary": return ["résumé calculé par le code", h.text.replace(/ \(calculé par le code\)/, "").replace(/ Sources : .*$/, "")];
    }
  };
  return [`🧠 Ce que Sonni sait sur « ${query} » :`, ...hits.map((h) => {
    const [label, text] = line(h);
    return `- [${label.replace(/\s+/g, " ").trim()}] ${text.replace(/\s+/g, " ").trim().slice(0, 300)}`;
  })].join("\n");
}

export const SONNI_USAGE = `Commandes Sonni :
  statut                 état de Sonni (prix, prédictions, intuitions)
  intuitions             liste des intuitions
  dossier [actif]        son dossier sur un actif (thèse, catalyseurs, niveaux, versions)
  note <texte>           lui laisser une note (information fiable, lue à sa prochaine séance)
  memoire <sujet>        ce qu'il sait sur un sujet (dossiers, intuitions, journal, leçons, pièges, notes)
  carnets                écrire ses carnets Markdown dans ~/carnet (aussi chaque dimanche)
  cycles                 réactions mesurées autour des événements et cycles nommés par Sonni
  portefeuille           son portefeuille virtuel : valeur, positions, ordres, résultats
  journee                le résumé du jour (envoyé chaque soir)
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
  actifs [non <symbole>]  socle, places tournantes, crible de la semaine ; non : veto sur une place tournante
  cerveau [mode]         le second cerveau sur ton PC ; modes : arret, assistant, parallele, delegue
  question <texte>       poser une question au second cerveau sur la mémoire de Sonni`;

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
  /** Spend and balance from the Money Lab ledger, for the status. */
  budget?: BudgetView | null;
  /** Money Lab profile, for the evening summary's cap. */
  lab?: MoneyLabConfig | null;
  /** Home directory for the notebooks and recall (defaults to $HOME). */
  home?: string;
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
      print(formatSonniStatus(db, cfg, new Date(), options.budget ?? null));
      return 0;
    case "intuitions":
      print(formatHypotheses(db));
      return 0;
    case "dossier": {
      const asset = rest[0] ?? "";
      if (!asset) {
        const all = listDossiers(db, live);
        print(all.length === 0 ? "Aucun dossier encore. Sonni les écrit en séance et à sa revue du dimanche." : `Dossiers : ${all.map((d) => `${d.asset} (v${d.version})`).join(", ")}. Détail : /dossier <actif>.`);
        return 0;
      }
      print(formatDossierFr(db, live, asset, live.timeZone));
      return 0;
    }
    case "note": {
      const text = rest.join(" ").trim();
      if (!text) {
        const notes = listOwnerNotes(db, undefined, 5);
        print(notes.length === 0 ? "Aucune note. /note <texte> pour en laisser une : Sonni la lit à sa prochaine séance." : `Tes dernières notes :\n${notes.map((n) => `- ${fmtWhen(n.at, live.timeZone)}${n.assets.length ? ` [${n.assets.join(", ")}]` : ""} : ${n.text}`).join("\n")}`);
        return 0;
      }
      const r = addOwnerNote(db, live, text);
      print(r.ok ? `Note enregistrée${r.value.assets.length ? ` (${r.value.assets.join(", ")})` : ""} : Sonni la verra à sa prochaine séance, comme une information de ta part, pas comme un ordre.` : `Refusé : ${refusalFr(r.error)}`);
      return r.ok ? 0 : 1;
    }
    case "memoire":
    case "mémoire": {
      const query = rest.join(" ").trim();
      if (!query) {
        print("Usage : /memoire <sujet> — ce que Sonni sait sur un sujet (dossiers, intuitions, journal, leçons, pièges, tes notes, ses ordres).");
        return 1;
      }
      print(formatMemoireFr(db, query, searchMemory(db, query, { limit: 8 })));
      return 0;
    }
    case "cycles":
      print(formatCyclesFr(db, live));
      return 0;
    case "cerveau": {
      // Step 3 (2026-10-08): the second brain on the owner's PC.
      const env = options.env ?? withSecrets();
      print(rest[0] ? setBrainModeFr(db, rest[0]) : formatBrainFr(db, cfg, env));
      return 0;
    }
    case "question": {
      const question = rest.join(" ").trim();
      const hits = question ? recall(question, { home: options.home ?? process.env.HOME ?? "/root", db, limit: 8 }) : [];
      const context = hits.map((h) => `[${h.source}] ${h.text}`).join("\n---\n");
      print(askBrainFr(db, cfg, options.env ?? withSecrets(), question, context));
      return 0;
    }
    case "carnets": {
      const dir = notebooksDir(options.home ?? process.env.HOME ?? "/root");
      const files = exportNotebooks(db, live, dir);
      print(`📚 Carnets écrits dans ${dir} : ${files.join(", ")}. Ils sont réécrits chaque dimanche et à chaque /carnets.`);
      return 0;
    }
    case "portefeuille":
      print(formatPortfolioFr(db, live));
      return 0;
    case "journee":
    case "journée":
      print(buildSonniEveningSummary(db, live, options.lab ?? null));
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
      print(formatJournalFr(db, Number.isInteger(n) && n > 0 ? Math.min(n, 30) : 5, cfg.timeZone));
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
      if (rest[0] === "non") {
        print(ownerVeto(db, cfg, rest[1]));
        return 0;
      }
      print(`${formatUniverseFr(db, cfg)}\n\n${formatScreenFr(db)}`);
      return 0;
    default:
      print(SONNI_USAGE);
      return command ? 1 : 0;
  }
}
