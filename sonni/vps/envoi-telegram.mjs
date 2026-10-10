#!/usr/bin/env node
/**
 * Sends a French report to the owner's Telegram chat (controlled deployment of 2026-10-10). The owner pipes the
 * `--resume` output of a check into it, as root, because the bot token lives in /etc/sonni.env (root only).
 *
 * Run it as root ONLY from a root-owned copy whose SHA-256 matches the one published with the approved commit,
 * never from the checkout: /opt/sonni belongs to the sonni user, so any code running as sonni (a dependency's
 * install script, the runtime itself) can rewrite sonni/vps/envoi-telegram.mjs there, and root running that file
 * hands it /etc/sonni.env and the whole VPS. The guide's steps, as root:
 *   install -o root -g root -m 0500 sonni/vps/envoi-telegram.mjs /root/envoi-telegram.mjs
 *   sha256sum /root/envoi-telegram.mjs        (compare with the published value; stop if it differs)
 *   sudo -u sonni -H node sonni/vps/controle-apres-demarrage.mjs … --resume | node /root/envoi-telegram.mjs
 * The copy needs nothing beside it: it imports Node built-ins only.
 *
 * Safety: the token is read from the environment file only (never from the command line, where `ps` would show
 * it, nor from the shell's environment), and only under the name TELEGRAM_BOT_TOKEN. The configuration it reads
 * (/home/sonni/.automaton/automaton.json) is writable by sonni, so it may not choose which root-only secret is
 * sent: a moneyLab.telegram.botTokenEnv other than TELEGRAM_BOT_TOKEN is refused. The token is never printed:
 * not the token, not the URL that carries it, not a network error text that could hold either; a piped message
 * holding the token or anything shaped like a key is shown masked and never sent. The message goes only to the
 * chat of moneyLab.telegram.ownerChatId (its last three digits are shown). The one network call is a POST to
 * https://api.telegram.org; tests point it at a local server through SONNI_TELEGRAM_API, accepted only as
 * http://127.0.0.1:<port>. The script writes no file and changes nothing in Sonni's memory.
 *
 * Exit codes: 0 sent (or simulated with --essai); 1 Telegram refused the message (HTTP status and Telegram's
 * description shown); 2 refused or usage error (empty message, a message holding something shaped like a token or
 * a key, unreadable configuration or environment file, botTokenEnv other than TELEGRAM_BOT_TOKEN, missing token
 * or chat, SONNI_TELEGRAM_API not local; nothing sent); 3 network error (Telegram unreachable, no answer within
 * 20 s); 130 interrupted. These codes are the SENDING's, not the report's. The last line of stdout is
 * `RÉSULTAT : code=<n> envoi=<fait|simulé|aucun|inconnu> caractères=<n>`, followed by ` rapport=code <r>` (or
 * ` rapport=code inconnu` with a warning when the piped text has no RÉSULTAT line: an incomplete report) when
 * the piped report has its own `RÉSULTAT : code=<r>` line (the last one counts); when r is not 0 a French line
 * just before it says that the report's code is the one that counts for the deployment.
 *
 * Usage: <commande> --resume | node /root/envoi-telegram.mjs [--env /etc/sonni.env]
 *          [--config /home/sonni/.automaton/automaton.json] [--essai]
 *   --essai: checks the configuration, the environment file and the token, prints the message, sends nothing.
 */

import fs from "fs";
import { fileURLToPath } from "url";

export const DEFAULT_ENV_FILE = "/etc/sonni.env";
export const DEFAULT_CONFIG = "/home/sonni/.automaton/automaton.json";
export const DEFAULT_TOKEN_ENV = "TELEGRAM_BOT_TOKEN";
export const TELEGRAM_API = "https://api.telegram.org";
/** Telegram takes 4,096 characters; above 4,000 the message is cut at 3,950 with a note. */
export const MAX_MESSAGE = 4000;
export const CUT_AT = 3950;
export const CUT_NOTE = "… (rapport coupé, la suite dans le terminal)";
export const TIMEOUT_MS = 20_000;
/** A Telegram bot token: the bot's number, a colon, the secret part. Anything else could change the URL. */
const TOKEN_SHAPE = /^\d{3,20}:[A-Za-z0-9_-]{20,100}$/;
/** Standard input above this is not a report. */
const MAX_INPUT = 1_048_576;

/** A refusal or failure with its exit code. */
export class Failure extends Error {
  constructor(code, message) {
    super(message);
    this.exitCode = code;
  }
}

const USAGE = "Usage : <commande> --resume | node /root/envoi-telegram.mjs [--env /etc/sonni.env] [--config /home/sonni/.automaton/automaton.json] [--essai]";

/** Parses the command line; throws a Failure(2) on a usage error. The token is never an option. */
export function parseArgs(argv) {
  const out = { essai: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--essai") out.essai = true;
    else if (a === "--env" || a === "--config") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) throw new Failure(2, `${a} attend un chemin. ${USAGE}`);
      out[a.slice(2)] = value;
      i += 1;
    } else throw new Failure(2, `Option inconnue : ${a}. ${USAGE}`);
  }
  return out;
}

/**
 * KEY=VALUE lines of an environment file (systemd EnvironmentFile, .env): blank lines and lines starting with
 * `#` or `;` are skipped, `export ` is allowed, a value may be in double or single quotes, and an unquoted
 * value ends at ` #` (a comment).
 */
export function parseEnvFile(text) {
  const out = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2];
    const q = value[0];
    if ((q === '"' || q === "'") && value.indexOf(q, 1) > 0) {
      const end = q === '"' ? closingQuote(value) : value.indexOf(q, 1);
      value = value.slice(1, end);
      if (q === '"') value = value.replace(/\\(["\\$`])/g, "$1");
    } else value = value.replace(/\s+#.*$/, "").trim();
    out[m[1]] = value;
  }
  return out;
}

/** Index of the double quote that closes a value starting with one (a backslash escapes a quote). */
function closingQuote(value) {
  for (let i = 1; i < value.length; i++) {
    if (value[i] === "\\") i += 1;
    else if (value[i] === '"') return i;
  }
  return value.length;
}

function readFailure(err) {
  if (err instanceof SyntaxError) return "JSON invalide";
  if (err?.code === "ENOENT") return "fichier introuvable";
  if (err?.code === "EACCES") return "accès refusé : lance cette commande en root, comme dans le guide";
  if (err?.code === "EISDIR") return "c'est un dossier";
  return err?.code ? `erreur ${err.code}` : "illisible";
}

/**
 * The owner's chat from Sonni's configuration, and the name of the token variable: always TELEGRAM_BOT_TOKEN.
 * The configuration is writable by sonni while this script runs as root, so its botTokenEnv may only confirm
 * that name (or be absent): any other value would let it choose which root-only secret of the environment file
 * goes into the Telegram URL. The refusal never repeats the configured value.
 */
export function readTelegramConfig(file) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (err) {
    throw new Failure(2, `Configuration illisible : ${file} (${readFailure(err)}). Rien n'a été envoyé.`);
  }
  const tg = raw?.moneyLab?.telegram;
  if (!tg || typeof tg !== "object") throw new Failure(2, `Pas de bloc moneyLab.telegram dans ${file} : Telegram n'est pas configuré. Rien n'a été envoyé.`);
  if (tg.botTokenEnv !== undefined && tg.botTokenEnv !== DEFAULT_TOKEN_ENV) {
    throw new Failure(2, `moneyLab.telegram.botTokenEnv de ${file} ne vaut pas ${DEFAULT_TOKEN_ENV} : lancé en root, ce script ne lit que ${DEFAULT_TOKEN_ENV} dans le fichier d'environnement, et la configuration de Sonni ne peut pas choisir un autre secret. Ce n'est pas la configuration du guide : arrête-toi et envoie-moi cette sortie. Rien n'a été envoyé.`);
  }
  if (!Number.isSafeInteger(tg.ownerChatId)) {
    throw new Failure(2, `moneyLab.telegram.ownerChatId manque ou n'est pas un entier dans ${file}. Rien n'a été envoyé.`);
  }
  return { tokenEnv: DEFAULT_TOKEN_ENV, chatId: tg.ownerChatId };
}

/** The bot token from the environment file; the messages name the variable, never its value. */
export function readToken(envFile, tokenEnv) {
  let text;
  try {
    text = fs.readFileSync(envFile, "utf-8");
  } catch (err) {
    throw new Failure(2, `Fichier d'environnement illisible : ${envFile} (${readFailure(err)}). Rien n'a été envoyé.`);
  }
  const token = parseEnvFile(text)[tokenEnv];
  if (!token) throw new Failure(2, `${tokenEnv} est absent ou vide dans ${envFile}. Rien n'a été envoyé.`);
  if (!TOKEN_SHAPE.test(token)) {
    throw new Failure(2, `${tokenEnv} dans ${envFile} n'a pas la forme d'un jeton de bot Telegram (chiffres, deux-points, puis la partie secrète). Rien n'a été envoyé.`);
  }
  return token;
}

/** The API base: Telegram's, or a local test server named by SONNI_TELEGRAM_API (http://127.0.0.1:<port> only). */
export function apiBase(env = process.env) {
  const value = env.SONNI_TELEGRAM_API;
  if (value === undefined || value === "") return TELEGRAM_API;
  // A strict pattern, then the parsed host: "http://127.0.0.1:80@ailleurs" starts the same way but goes elsewhere.
  const m = /^http:\/\/127\.0\.0\.1:(\d{1,5})\/?$/.exec(value);
  let host = "";
  try {
    host = new URL(value).hostname;
  } catch { /* refused below */ }
  if (!m || host !== "127.0.0.1" || Number(m[1]) < 1 || Number(m[1]) > 65535) {
    throw new Failure(2, "SONNI_TELEGRAM_API ne sert qu'aux tests et doit valoir http://127.0.0.1:<port> : retire cette variable. Rien n'a été envoyé.");
  }
  return `http://127.0.0.1:${Number(m[1])}`;
}

/** The text sent: unchanged up to 4,000 characters, else cut at 3,950 (never inside a character) with a note. */
export function fitMessage(text) {
  if (text.length <= MAX_MESSAGE) return { text, cut: false };
  let head = text.slice(0, CUT_AT);
  const last = head.charCodeAt(head.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) head = head.slice(0, -1);
  return { text: `${head}\n${CUT_NOTE}`, cut: true };
}

/** Shapes of the secrets of /etc/sonni.env: a Telegram bot token, an API key (src/trader/incidents.ts scrub). */
const SECRET_SHAPES = [/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, /sk-[A-Za-z0-9_-]{8,}/g];

/** The text with the token, and anything shaped like a token or a key, replaced by "[jeton masqué]". */
export function maskSecrets(text, token) {
  let out = String(text ?? "");
  if (token) out = out.split(token).join("[jeton masqué]");
  for (const shape of SECRET_SHAPES) out = out.replace(shape, "[jeton masqué]");
  return out;
}

/** True when a report holds the token or something shaped like a secret: it is never sent. */
export const hasSecret = (text, token) => maskSecrets(text, token) !== text;

/** Telegram's own text (an error description), masked and on one line. */
function scrub(text, token) {
  return maskSecrets(text, token).replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 300);
}

/** Last three digits of the chat, enough for the owner to recognise it. */
export const chatHint = (chatId) => `…${String(Math.abs(chatId)).slice(-3)}`;

/** One POST to sendMessage. Returns `{ code, message }`; never throws and never puts the URL in a message. */
export async function sendMessage({ base, token, chatId, text, fetchFn = fetch, timeoutMs = TIMEOUT_MS }) {
  let resp;
  try {
    resp = await fetchFn(`${base}/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    // Only a code or the timeout: an error's message could carry the URL, and the URL carries the token.
    if (err?.name === "TimeoutError" || err?.name === "AbortError") return { code: 3, message: `Telegram injoignable : pas de réponse en ${Math.round(timeoutMs / 1000)} s. Le rapport n'est pas parti.` };
    const code = typeof err?.cause?.code === "string" ? err.cause.code : typeof err?.code === "string" ? err.code : "erreur réseau";
    return { code: 3, message: `Telegram injoignable (${code}). Le rapport n'est pas parti.` };
  }
  let data = {};
  try {
    data = await resp.json();
  } catch {
    data = {};
  }
  if (resp.ok && data?.ok === true) return { code: 0, message: "Rapport envoyé sur Telegram." };
  const description = scrub(data?.description, token);
  return { code: 1, message: `Telegram a refusé le rapport : HTTP ${resp.status}${description ? ` — ${description}` : ""}.` };
}

/** Reads standard input to the end (refused when it is a terminal: nothing was piped in). */
export async function readStdin(stream = process.stdin) {
  if (stream.isTTY) return "";
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > MAX_INPUT) throw new Failure(2, "Message trop long sur l'entrée standard (plus de 1 Mo) : ce n'est pas un rapport. Rien n'a été envoyé.");
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

/** The piped report's own verdict: the code of its last `RÉSULTAT : code=<n>` line, or null when it has none. */
export function reportCode(text) {
  let code = null;
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const m = /^RÉSULTAT : code=(\d{1,3})(?=\s|$)/.exec(line.trim());
    if (m) code = Number(m[1]);
  }
  return code;
}

/**
 * The last lines on screen. The RÉSULTAT code is the sending's; ` rapport=code <r>` repeats the piped report's
 * own verdict, and when that verdict is not 0 a French line says it is the one that counts: the guide's rule
 * reads the last line, and a report with alerts that was sent fine must not end on a bare `code=0`.
 */
export function closingLines(code, sent, chars, report) {
  const lines = [];
  if (report === "inconnu") {
    // A report cut before its verdict (the check killed while writing) must not end on a bare code=0 either.
    lines.push("Le rapport ne contient pas de ligne RÉSULTAT : il est incomplet (contrôle interrompu ?). Ne le prends pas pour un feu vert : relance le contrôle.");
  } else if (report !== null && report !== 0) {
    lines.push(`Le rapport${sent === "fait" ? " envoyé" : ""} signale code=${report} : c'est ce code qui compte, pas celui de l'envoi.`);
  }
  lines.push(`RÉSULTAT : code=${code} envoi=${sent} caractères=${chars}${report === null ? "" : ` rapport=code ${report}`}`);
  return lines;
}

/** Shared state for an interruption: whether the message may already be on its way, and the report's verdict. */
export const progress = { sending: false, report: null };

/**
 * Checks everything, then sends the message (or prints it with --essai). Writes the French report with `say`
 * (stdout) and problems with `warn` (stderr); returns `{ code }` and never exits.
 */
export async function envoiTelegram(options = {}) {
  const env = options.env ?? process.env;
  const say = options.say ?? ((line = "") => process.stdout.write(`${line}\n`));
  const warn = options.warn ?? ((line) => process.stderr.write(`${line}\n`));
  let chars = 0;
  let report = null;
  const done = (code, sent, message) => {
    if (message) (code === 0 ? say : warn)(message);
    for (const line of closingLines(code, sent, chars, report)) say(line);
    return { code };
  };
  try {
    const raw = (options.message ?? "").replace(/\s+$/, "");
    // A non-empty message without a verdict line is an incomplete report ("inconnu"); an empty one is refused below.
    report = reportCode(raw) ?? (raw.trim() === "" ? null : "inconnu");
    progress.report = report;
    if (raw.trim() === "") {
      return done(2, "aucun", `Aucun message reçu sur l'entrée standard. ${USAGE}`);
    }
    // The token first, so the message shown below can be masked with it; a failure is reported after the message.
    let setup;
    let failure = null;
    try {
      const { tokenEnv, chatId } = readTelegramConfig(options.config ?? DEFAULT_CONFIG);
      setup = { tokenEnv, chatId, token: readToken(options.envFile ?? DEFAULT_ENV_FILE, tokenEnv), base: apiBase(env) };
    } catch (err) {
      failure = err;
    }
    // The full message in the terminal: the piped report stays readable whatever happens next, and it holds
    // the rest of a report cut for Telegram. Anything shaped like a key is masked here, and such a message is
    // never sent.
    say(maskSecrets(raw, setup?.token));
    say("---");
    if (failure) throw failure;
    if (hasSecret(raw, setup.token)) {
      return done(2, "aucun", "Le message contient ce qui ressemble à un jeton ou une clé (masqué ci-dessus) : il n'est pas envoyé. Envoie seulement la sortie de --resume.");
    }
    const { tokenEnv, chatId, token, base } = setup;
    const fitted = fitMessage(raw);
    chars = fitted.text.length;
    if (fitted.cut) say(`Rapport coupé à ${CUT_AT} caractères pour Telegram : le texte complet est ci-dessus.`);
    if (options.essai) return done(0, "simulé", `Essai : envoi simulé au chat ${chatHint(chatId)} (jeton ${tokenEnv} présent, non affiché). Rien n'a été envoyé.`);
    progress.sending = true;
    const result = await sendMessage({ base, token, chatId, text: fitted.text, fetchFn: options.fetchFn, timeoutMs: options.timeoutMs });
    progress.sending = false;
    return done(result.code, result.code === 0 ? "fait" : "aucun", result.code === 0 ? `${result.message} (chat ${chatHint(chatId)})` : result.message);
  } catch (err) {
    progress.sending = false;
    if (err instanceof Failure) return done(err.exitCode, "aucun", err.message);
    // Never err.message: it could hold a path with the token in a URL.
    return done(3, "aucun", `Envoi impossible : erreur technique${typeof err?.code === "string" ? ` (${err.code})` : ""}. Rien n'a été envoyé.`);
  }
}

/** True when this file is the script node was started with. Kept here so the script loads no native module. */
export function isMain(metaUrl) {
  try {
    return !!process.argv[1] && fs.realpathSync(fileURLToPath(metaUrl)) === fs.realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

async function main() {
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => {
      if (process.exitCode !== undefined) process.exit(process.exitCode);
      const sent = progress.sending ? "inconnu" : "aucun";
      const closing = closingLines(130, sent, 0, progress.report).join("\n");
      process.stdout.write(`Interrompu${progress.sending ? " pendant l'envoi : le rapport a pu partir ou non" : " : rien n'a été envoyé"}.\n${closing}\n`);
      process.exit(130);
    });
  }
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.stdout.write("RÉSULTAT : code=2 envoi=aucun caractères=0\n");
    process.exitCode = 2;
    return;
  }
  let message;
  try {
    message = await readStdin();
  } catch (err) {
    process.stderr.write(`${err instanceof Failure ? err.message : "Entrée standard illisible. Rien n'a été envoyé."}\n`);
    process.stdout.write("RÉSULTAT : code=2 envoi=aucun caractères=0\n");
    process.exitCode = 2;
    return;
  }
  const { code } = await envoiTelegram({ message, essai: args.essai, envFile: args.env, config: args.config });
  process.exitCode = code;
}

if (isMain(import.meta.url)) await main();
