#!/usr/bin/env node
/**
 * Read-only preflight of the server before the controlled deployment (2026-10-10). The deployment tools were
 * tested in the laboratory (Node 22, better-sqlite3 11.10.0, a sonni user owning ~/.automaton); this script checks
 * that the VPS really offers the same, from the place the tools will run (the isolated folder of the guide, whose
 * node_modules points at /opt/sonni/node_modules), before anything is stopped or changed.
 *
 * It only reads, except one private temporary folder (os.tmpdir()) where it proves that better-sqlite3 can write a
 * database and copy it with the online backup API; that folder is removed. Sonni's files are never opened by
 * SQLite: only their status (owner, mode, size) is read.
 *
 * Checks, each OK, ÉCHEC or INFO:
 *   - Node: version >= 20 and the functions the tools use (fs.statfsSync, O_NOFOLLOW, AbortSignal.timeout, fetch);
 *   - better-sqlite3: loads from this script's place, its version, the backup API on a scratch database, and that
 *     it is the same module as Sonni's (`--depot`, default /opt/sonni);
 *   - the user: not root, HOME is the user's home;
 *   - ~/.automaton and state.db: present, owned by this user, a regular file (not a link), readable and the folder
 *     writable (the backup writes ~/.automaton/predeploiement); -wal/-shm present or not (said, not judged);
 *   - free space: ~/.automaton and the temporary folder can each hold twice the database and its -wal;
 *   - commands: git, tar, sha256sum and systemctl answer; `systemctl is-active sonni` is reported.
 *
 * Exit codes: 0 every check OK; 1 at least one ÉCHEC (do not go on; send the output); 2 usage error; 3 technical
 * error. The last line of stdout is `RÉSULTAT : code=<n> echecs=<n>`.
 *
 * Usage: node sonni/vps/verification-environnement.mjs [--depot <dossier de Sonni>]
 * Environment (tests): SONNI_SYSTEMCTL replaces systemctl, as in restauration.mjs.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { createRequire } from "module";
import { fileURLToPath, pathToFileURL } from "url";

export const NODE_MAJOR_MIN = 20;
export const DEFAULT_DEPOT = "/opt/sonni";
const USAGE = "Usage : node sonni/vps/verification-environnement.mjs [--depot <dossier de Sonni>]";
const COMMANDS = [["git", ["--version"]], ["tar", ["--version"]], ["sha256sum", ["--version"]]];

const mo = (bytes) => `${(bytes / 1_048_576).toLocaleString("fr-FR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} Mo`;
const mode = (st) => (st.mode & 0o777).toString(8).padStart(4, "0");

export function parseArgs(argv) {
  const out = { depot: DEFAULT_DEPOT };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--depot" && argv[i + 1] && !argv[i + 1].startsWith("--")) out.depot = argv[++i];
    else {
      const err = new Error(`Option inconnue ou incomplète : ${argv[i]}. ${USAGE}`);
      err.exitCode = 2;
      throw err;
    }
  }
  return out;
}

/** The real path of the better-sqlite3 package that code in `dir` loads, or null. */
function moduleFrom(dir) {
  try {
    const req = createRequire(path.join(dir, "noop.js"));
    const pkg = req.resolve("better-sqlite3/package.json");
    return { dir: fs.realpathSync(path.dirname(pkg)), version: JSON.parse(fs.readFileSync(pkg, "utf-8")).version };
  } catch {
    return null;
  }
}

/** Runs every check; returns `{ lines, failures }`. Never throws for a failed check. */
export async function verifierEnvironnement({ depot = DEFAULT_DEPOT, env = process.env, here = path.dirname(fileURLToPath(import.meta.url)) } = {}) {
  const lines = [];
  let failures = 0;
  const ok = (t) => lines.push(`- OK : ${t}`);
  const fail = (t) => {
    failures += 1;
    lines.push(`- ÉCHEC : ${t}`);
  };
  const info = (t) => lines.push(`- INFO : ${t}`);

  // Node and the functions the tools call.
  const major = Number(process.versions.node.split(".")[0]);
  if (major >= NODE_MAJOR_MIN) ok(`Node ${process.version}`);
  else fail(`Node ${process.version} : les outils demandent Node ${NODE_MAJOR_MIN} ou plus (Sonni aussi).`);
  const missing = [
    ["fs.statfsSync", typeof fs.statfsSync === "function"],
    ["O_NOFOLLOW", typeof fs.constants.O_NOFOLLOW === "number"],
    ["AbortSignal.timeout", typeof AbortSignal?.timeout === "function"],
    ["fetch", typeof fetch === "function"],
  ].filter(([, present]) => !present).map(([name]) => name);
  if (missing.length === 0) ok("fonctions de Node utilisées par les outils présentes");
  else fail(`fonctions de Node absentes : ${missing.join(", ")}.`);

  // better-sqlite3, as the tools load it from here, and as Sonni loads it from its folder.
  const tools = moduleFrom(here);
  const sonni = moduleFrom(depot);
  if (!tools) fail(`better-sqlite3 introuvable depuis ${here} : le lien node_modules vers ${depot}/node_modules manque ou ne mène nulle part.`);
  else {
    let Database;
    try {
      Database = (await import(pathToFileURL(createRequire(path.join(here, "noop.js")).resolve("better-sqlite3")).href)).default;
    } catch (err) {
      fail(`better-sqlite3 ${tools.version} ne se charge pas (${String(err?.code ?? err?.message ?? err).slice(0, 160)}) : son module compilé ne va pas avec ce Node.`);
    }
    if (Database) {
      const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "sonni-environnement-"));
      try {
        const src = new Database(path.join(scratch, "essai.db"));
        src.pragma("journal_mode = WAL");
        src.exec("CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (1), (2), (3);");
        await src.backup(path.join(scratch, "copie.db"), { progress: () => 1e9 });
        const sqlite = src.prepare("SELECT sqlite_version() AS v").get().v;
        src.close();
        const copy = new Database(path.join(scratch, "copie.db"), { readonly: true, fileMustExist: true });
        const n = copy.prepare("SELECT COUNT(*) AS n FROM t").get().n;
        const integrity = copy.pragma("integrity_check", { simple: true });
        copy.close();
        if (n === 3 && integrity === "ok") ok(`better-sqlite3 ${tools.version} se charge et copie une base d'essai (SQLite ${sqlite})`);
        else fail(`better-sqlite3 ${tools.version} : la copie d'essai est fausse (${n} lignes, intégrité ${integrity}).`);
      } catch (err) {
        fail(`better-sqlite3 ${tools.version} : l'essai de copie échoue (${String(err?.code ?? err?.message ?? err).slice(0, 160)}).`);
      } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
      }
    }
    if (!sonni) fail(`better-sqlite3 introuvable dans ${depot} : vérifie --depot (le dossier de Sonni).`);
    else if (sonni.dir !== tools.dir) fail(`les outils chargent ${tools.dir} (${tools.version}) mais Sonni charge ${sonni.dir} (${sonni.version}) : refais le lien node_modules du guide.`);
    else ok(`même module que Sonni (${depot}, better-sqlite3 ${sonni.version})`);
  }

  // The user the tools run as.
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  const user = os.userInfo();
  const home = env.HOME || os.homedir();
  if (uid === 0) fail("lancé en root : lance les outils avec sudo -u sonni -H, pour que les copies appartiennent à sonni.");
  else ok(`utilisateur ${user.username}${uid === null ? "" : ` (uid ${uid})`}`);
  // `sudo -u sonni` without -H keeps root's HOME: the tools would look for /root/.automaton.
  let homeOwner = null;
  try {
    homeOwner = fs.statSync(home).uid;
  } catch { /* said below */ }
  if (path.resolve(home) === path.resolve(user.homedir)) ok(`HOME ${home}`);
  else if (uid !== null && homeOwner !== uid) fail(`HOME vaut ${home}, qui n'est pas à ${user.username} (son dossier est ${user.homedir}) : ajoute -H à sudo.`);
  else info(`HOME vaut ${home}, et non ${user.homedir} : les outils liront ${path.join(home, ".automaton")}.`);

  // Sonni's folder and database: status only.
  const automaton = path.join(home, ".automaton");
  const base = path.join(automaton, "state.db");
  let need = 0;
  try {
    const st = fs.lstatSync(automaton);
    if (!st.isDirectory()) fail(`${automaton} n'est pas un dossier.`);
    else if (uid !== null && st.uid !== uid) fail(`${automaton} appartient à l'uid ${st.uid}, pas à ${user.username}.`);
    else {
      fs.accessSync(automaton, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
      ok(`${automaton} : dossier de ${user.username}, droits ${mode(st)}, lisible et inscriptible`);
    }
  } catch (err) {
    fail(`${automaton} : ${err?.code === "ENOENT" ? "introuvable" : err?.code === "EACCES" ? "accès refusé" : String(err?.code ?? err)}.`);
  }
  try {
    const st = fs.lstatSync(base);
    if (st.isSymbolicLink()) fail(`${base} est un lien symbolique : les outils le refusent.`);
    else if (!st.isFile()) fail(`${base} n'est pas un fichier ordinaire.`);
    else if (uid !== null && st.uid !== uid) fail(`${base} appartient à l'uid ${st.uid}, pas à ${user.username}.`);
    else {
      fs.accessSync(base, fs.constants.R_OK);
      const wal = fs.existsSync(`${base}-wal`) ? fs.statSync(`${base}-wal`).size : null;
      need = 2 * (st.size + (wal ?? 0));
      ok(`${base} : ${mo(st.size)}, à ${user.username}, droits ${mode(st)}`);
      info(wal === null
        ? "pas de fichier -wal : Sonni est arrêté proprement (la sauvegarde fera une copie exacte du fichier)"
        : `fichier -wal présent (${mo(wal)}) : Sonni tourne, ou s'est arrêté sans fermer sa base (la sauvegarde fera une copie « à chaud »)`);
    }
  } catch (err) {
    fail(`${base} : ${err?.code === "ENOENT" ? "introuvable" : err?.code === "EACCES" ? "lecture refusée" : String(err?.code ?? err)}.`);
  }

  // Free space where the backup is written and where the drill and the gate copy the database.
  for (const [label, dir] of [["dossier de Sonni", automaton], ["dossier temporaire", os.tmpdir()]]) {
    try {
      const s = fs.statfsSync(dir);
      const free = Number(s.bavail) * Number(s.bsize);
      if (need === 0) info(`${label} (${dir}) : ${mo(free)} libres`);
      else if (free >= need) ok(`${label} (${dir}) : ${mo(free)} libres, il en faut ${mo(need)}`);
      else fail(`${label} (${dir}) : ${mo(free)} libres, il en faut ${mo(need)} (deux fois la base et son -wal).`);
    } catch (err) {
      fail(`${label} (${dir}) : place libre illisible (${String(err?.code ?? err)}).`);
    }
  }

  // Commands of the procedure.
  for (const [command, args] of COMMANDS) {
    const r = spawnSync(command, args, { encoding: "utf-8", timeout: 15_000 });
    if (r.error || r.status !== 0) fail(`commande ${command} absente ou en erreur.`);
    else ok(`${command} : ${String(r.stdout).split("\n")[0].trim().slice(0, 80)}`);
  }
  const systemctl = env.SONNI_SYSTEMCTL || "systemctl";
  const state = spawnSync(systemctl, ["is-active", "sonni"], { encoding: "utf-8", timeout: 15_000 });
  if (state.error) fail(`commande ${systemctl} absente : la restauration en a besoin pour savoir si Sonni tourne.`);
  else info(`systemctl is-active sonni : ${String(state.stdout).trim().split("\n")[0] || "(rien)"}`);

  return { lines, failures };
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.stdout.write("RÉSULTAT : code=2 echecs=inconnu\n");
    process.exitCode = 2;
    return;
  }
  try {
    const { lines, failures } = await verifierEnvironnement({ depot: path.resolve(args.depot) });
    process.stdout.write(`Vérification de l'environnement (lecture seule), outils dans ${path.dirname(fileURLToPath(import.meta.url))}\n`);
    for (const l of lines) process.stdout.write(`${l}\n`);
    const code = failures > 0 ? 1 : 0;
    process.stdout.write(code === 0
      ? "Conclusion : le serveur a ce que les outils demandent.\n"
      : "Conclusion : ne va pas plus loin ; envoie-moi cette sortie.\n");
    process.stdout.write(`RÉSULTAT : code=${code} echecs=${failures}\n`);
    process.exitCode = code;
  } catch (err) {
    process.stderr.write(`Vérification impossible : ${String(err?.message ?? err)}\n`);
    process.stdout.write("RÉSULTAT : code=3 echecs=inconnu\n");
    process.exitCode = 3;
  }
}

// Same test as copie-privee.mjs's isMain, inlined: this script must not load better-sqlite3 before checking it.
const self = fileURLToPath(import.meta.url);
const real = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
};
if (process.argv[1] && real(path.resolve(process.argv[1])) === real(self)) await main();
