/**
 * Step 3 of the 2026-10-08 plan: the scripts the owner runs outside Sonni's process (sonni/GUIDE-PC.fr.md).
 * The VPS's nightly export (sonni/vps/export-backup.mjs) runs on temporary folders. The PC's PowerShell
 * scripts run with pwsh when it is installed (GitHub's Ubuntu runners have it), with a fake sftp and a
 * fake llama-server: no network, no model, no Windows needed.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "child_process";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3";

const REPO = path.join(__dirname, "..", "..", "..");
const EXPORT = path.join(REPO, "sonni", "vps", "export-backup.mjs");
const PULL = path.join(REPO, "sonni", "pc", "backup-pull.ps1");
const MAIN = path.join(REPO, "sonni", "pc", "llm-main.ps1");
const HAS_PWSH = spawnSync("pwsh", ["-NoProfile", "-Command", "exit 0"]).status === 0;

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sonni-pc-")); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

function sonniDb(file: string, tables = ["trader_predictions", "trader_orders", "trader_reflections", "trader_lessons", "trader_dossiers"]) {
  const db = new Database(file);
  for (const t of tables) db.exec(`CREATE TABLE ${t} (id TEXT PRIMARY KEY, body TEXT); INSERT INTO ${t} VALUES ('a', '${t}');`);
  db.close();
}
const sha = (file: string) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const day = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

function runExport(source: string, target: string) {
  return spawnSync(process.execPath, [EXPORT, source, target], { encoding: "utf-8", timeout: 30_000 });
}

describe("VPS: the nightly export of the memory copy", () => {
  it("exports the newest sound copy with its SHA-256, once, keeps only the newest and refuses a damaged one", () => {
    const source = path.join(tmp, "backups");
    const target = path.join(tmp, "files");
    fs.mkdirSync(source);
    fs.mkdirSync(target);
    expect(runExport(source, target).stdout).toContain("Aucune copie quotidienne");
    sonniDb(path.join(source, "state.db.backup-2026-10-07"));
    fs.writeFileSync(path.join(source, "state.db.backup-2026-10-08.partial"), "unfinished"); // never exported
    let r = runExport(source, target);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Exportée pour le PC : state.db.backup-2026-10-07");
    const copy = path.join(target, "state.db.backup-2026-10-07");
    expect(fs.readFileSync(`${copy}.sha256`, "utf-8")).toBe(`${sha(copy)}  state.db.backup-2026-10-07\n`);
    expect(fs.statSync(copy).mode & 0o777).toBe(0o640);
    expect(runExport(source, target).stdout).toContain("Déjà exportée");
    // A new day: only the newest copy stays.
    sonniDb(path.join(source, "state.db.backup-2026-10-08"));
    expect(runExport(source, target).status).toBe(0);
    expect(fs.readdirSync(target).sort()).toEqual(["state.db.backup-2026-10-08", "state.db.backup-2026-10-08.sha256"]);
    // A damaged copy, or one without Sonni's stores, is refused; the previous one stays for the PC.
    fs.writeFileSync(path.join(source, "state.db.backup-2026-10-09"), crypto.randomBytes(8192));
    r = runExport(source, target);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Copie state.db.backup-2026-10-09 refusée");
    fs.rmSync(path.join(source, "state.db.backup-2026-10-09"));
    sonniDb(path.join(source, "state.db.backup-2026-10-10"), ["turns"]);
    r = runExport(source, target);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("tables absentes : trader_predictions");
    expect(fs.readdirSync(target).sort()).toEqual(["state.db.backup-2026-10-08", "state.db.backup-2026-10-08.sha256"]);
  });

  it("makes a WAL-mode copy self-contained and leaves no -wal or -shm file in the export folder", async () => {
    const source = path.join(tmp, "backups");
    const target = path.join(tmp, "files");
    fs.mkdirSync(source);
    fs.mkdirSync(target);
    const live = new Database(path.join(tmp, "state.db"));
    live.pragma("journal_mode = WAL");
    for (const t of ["trader_predictions", "trader_orders", "trader_reflections", "trader_lessons", "trader_dossiers"]) live.exec(`CREATE TABLE ${t} (id TEXT)`);
    await live.backup(path.join(source, "state.db.backup-2026-10-08")); // what the runtime made before 2026-10-08
    live.close();
    expect(runExport(source, target).status).toBe(0);
    expect(fs.readdirSync(target).sort()).toEqual(["state.db.backup-2026-10-08", "state.db.backup-2026-10-08.sha256"]);
    const copy = new Database(path.join(target, "state.db.backup-2026-10-08"), { readonly: true });
    expect(copy.pragma("journal_mode", { simple: true })).toBe("delete");
    copy.close();
    expect(fs.readdirSync(target).sort()).toEqual(["state.db.backup-2026-10-08", "state.db.backup-2026-10-08.sha256"]);
  });
});

/** A fake sftp: runs the batch file's `ls -1 files` and `get files/X Y` against $FAKE_REMOTE, or fails with $FAKE_FAIL. */
function fakeSftp(): string {
  const file = path.join(tmp, "fake-sftp");
  fs.writeFileSync(file, `#!/bin/bash
set -e
[ -n "$FAKE_FAIL" ] && { echo "ssh: connect to host sonni-vps port 22: Connection timed out" >&2; exit 255; }
batch=""
while [ $# -gt 0 ]; do [ "$1" = "-b" ] && batch="$2"; shift; done
echo "Connected to sonni-vps." >&2
while read -r cmd a b; do
  echo "sftp> $cmd $a $b"
  case "$cmd" in
    ls) for f in "$FAKE_REMOTE"/*; do echo "files/$(basename "$f")"; done ;;
    get) cp "$FAKE_REMOTE/\${a#files/}" "$b" ;;
  esac
done < "$batch"
`);
  fs.chmodSync(file, 0o755);
  return file;
}

function runPull(root: string, remote: string, env: Record<string, string> = {}) {
  return spawnSync("pwsh", ["-NoProfile", "-File", PULL, "-Root", root, "-Key", path.join(tmp, "key"), "-Sftp", fakeSftp()], {
    encoding: "utf-8", timeout: 60_000, env: { ...process.env, TZ: "UTC", FAKE_REMOTE: remote, ...env },
  });
}

describe.skipIf(!HAS_PWSH)("PC: the nightly fetch of the memory copy (pwsh)", () => {
  it("fetches only the expected names, checks the SHA-256, keeps 30 days and says when it fails", () => {
    const root = path.join(tmp, "Sonni");
    const remote = path.join(tmp, "remote");
    fs.mkdirSync(remote);
    const log = () => fs.readFileSync(path.join(root, "logs", "sauvegarde.log"), "utf-8");
    const offer = (name: string, content: string, hash?: string) => {
      fs.writeFileSync(path.join(remote, name), content);
      fs.writeFileSync(path.join(remote, `${name}.sha256`), `${hash ?? crypto.createHash("sha256").update(content).digest("hex")}  ${name}\n`);
    };
    const today = `state.db.backup-${day(0)}`;
    offer(today, "copy of today");
    fs.writeFileSync(path.join(remote, "..\\..\\evil.ps1"), "Write-Host pwned"); // a name the PC must never fetch
    fs.mkdirSync(path.join(root, "sauvegardes"), { recursive: true });
    fs.writeFileSync(path.join(root, "sauvegardes", `state.db.backup-${day(-40)}`), "old");
    fs.writeFileSync(path.join(root, "sauvegardes", `state.db.backup-${day(-10)}`), "recent");
    let r = runPull(root, remote);
    expect(r.status).toBe(0);
    expect(log()).toMatch(/OK : copie du \d{4}-\d{2}-\d{2} recuperee et verifiee/);
    expect(fs.readdirSync(path.join(root, "sauvegardes")).sort()).toEqual([`state.db.backup-${day(-10)}`, today, `${today}.sha256`].sort());
    expect(fs.readdirSync(tmp).some((f) => f.includes("evil"))).toBe(false);
    r = runPull(root, remote);
    expect(r.status).toBe(0);
    expect(log()).toContain(`deja a jour : copie du ${day(0)}`);
    // A copy damaged in transit is not kept; the previous one stays.
    const tomorrow = `state.db.backup-${day(1)}`;
    offer(tomorrow, "copy of tomorrow", "0".repeat(64));
    r = runPull(root, remote);
    expect(r.status).toBe(1);
    expect(log()).toContain(`ECHEC : la copie du ${day(1)} est arrivee abimee`);
    expect(fs.readdirSync(path.join(root, "sauvegardes")).filter((f) => f.includes(day(1)))).toEqual([]);
    // The server unreachable: a clear failure line.
    r = runPull(root, remote, { FAKE_FAIL: "1" });
    expect(r.status).toBe(1);
    expect(log()).toContain("ECHEC : sftp a echoue (code 255)");
  });

  it("warns when the newest copy on the server is several days old", () => {
    const root = path.join(tmp, "Sonni");
    const remote = path.join(tmp, "remote");
    fs.mkdirSync(remote);
    const name = `state.db.backup-${day(-5)}`;
    fs.writeFileSync(path.join(remote, name), "stale");
    fs.writeFileSync(path.join(remote, `${name}.sha256`), `${crypto.createHash("sha256").update("stale").digest("hex")}  ${name}\n`);
    expect(runPull(root, remote).status).toBe(0);
    expect(fs.readFileSync(path.join(root, "logs", "sauvegarde.log"), "utf-8")).toContain(`ATTENTION : la copie la plus recente du serveur date du ${day(-5)} (5 jours)`);
  });
});

describe.skipIf(!HAS_PWSH)("PC: the supervisor that keeps llama-server running (pwsh)", () => {
  function setup() {
    const root = path.join(tmp, "Sonni");
    fs.mkdirSync(path.join(root, "llama"), { recursive: true });
    fs.mkdirSync(path.join(root, "modeles"));
    fs.writeFileSync(path.join(root, "modeles", "Qwen3.6-35B-A3B-UD-Q4_K_M.gguf"), "");
    fs.writeFileSync(path.join(root, "cle.txt"), "k".repeat(64));
    const server = path.join(root, "llama", "llama-server.exe");
    fs.writeFileSync(server, `#!/bin/sh\necho "$@" >> "$FAKE_OUT"\necho "server is listening" >&2\nexit 3\n`);
    fs.chmodSync(server, 0o755);
    return root;
  }
  const run = (root: string, runs: number) => spawnSync("pwsh", ["-NoProfile", "-File", MAIN, "-Root", root, "-RestartSeconds", "0", "-MaxRuns", String(runs)], {
    encoding: "utf-8", timeout: 60_000, env: { ...process.env, FAKE_OUT: path.join(tmp, "args.txt") },
  });

  it("starts llama-server on 127.0.0.1 with the key file, restarts it when it stops, and reads the model and options files", () => {
    const root = setup();
    expect(run(root, 2).status).toBe(0);
    const calls = fs.readFileSync(path.join(tmp, "args.txt"), "utf-8").trim().split("\n");
    expect(calls).toHaveLength(2);
    expect(calls[0]).toBe(`-m ${path.join(root, "modeles", "Qwen3.6-35B-A3B-UD-Q4_K_M.gguf")} --alias qwen3.6-35b-a3b --host 127.0.0.1 --port 8080 ` +
      `--api-key-file ${path.join(root, "cle.txt")} -c 32768 --no-ui --no-slots --load-mode none`);
    const supervisor = fs.readFileSync(path.join(root, "logs", "superviseur.log"), "utf-8");
    expect(supervisor.match(/llama-server arrete \(code 3\), relance dans 0 s/g)).toHaveLength(2);
    expect(fs.readdirSync(path.join(root, "logs")).some((f) => /^llama-.*\.log$/.test(f))).toBe(true);
    // The fallback model and an extra option, from the two text files.
    fs.writeFileSync(path.join(root, "modeles", "gpt-oss-20b-MXFP4.gguf"), "");
    fs.writeFileSync(path.join(root, "modele.txt"), "gpt-oss-20b-MXFP4.gguf gpt-oss-20b\r\n");
    fs.writeFileSync(path.join(root, "options.txt"), "--n-cpu-moe 20\r\n");
    fs.rmSync(path.join(tmp, "args.txt"));
    expect(run(root, 1).status).toBe(0);
    expect(fs.readFileSync(path.join(tmp, "args.txt"), "utf-8").trim()).toBe(`-m ${path.join(root, "modeles", "gpt-oss-20b-MXFP4.gguf")} --alias gpt-oss-20b ` +
      `--host 127.0.0.1 --port 8080 --api-key-file ${path.join(root, "cle.txt")} -c 32768 --no-ui --no-slots --load-mode none --n-cpu-moe 20`);
    // A malformed model file falls back to the default model, and says so.
    fs.writeFileSync(path.join(root, "modele.txt"), "rm -rf\n");
    fs.rmSync(path.join(tmp, "args.txt"));
    expect(run(root, 1).status).toBe(0);
    expect(fs.readFileSync(path.join(tmp, "args.txt"), "utf-8")).toContain("--alias qwen3.6-35b-a3b");
    expect(fs.readFileSync(path.join(root, "logs", "superviseur.log"), "utf-8")).toContain("modele.txt ignore");
  });
});
