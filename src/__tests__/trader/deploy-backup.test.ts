/**
 * Controlled deployment of 2026-10-10: a consistent copy of the LIVE database (sonni/vps/sauvegarde.mjs), its
 * restore drill and the real restore (sonni/vps/restauration.mjs). The scripts run as the owner runs them, in
 * a child process with a temporary HOME and TMPDIR; Sonni's service state comes from a fake systemctl given
 * through SONNI_SYSTEMCTL. No network, no inference, no real systemctl.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { pathToFileURL } from "url";
import { spawn, spawnSync } from "child_process";
import Database from "better-sqlite3";
import { createDatabase } from "../../state/database.js";
import { ensureMoneyLabSchema } from "../../money-lab/journal.js";
import type { AutomatonDatabase } from "../../types.js";
import { parseTraderConfig, type TraderConfig } from "../../trader/config.js";
import { ensureTraderSchema } from "../../trader/schema.js";
import { isoSeconds } from "../../trader/prices.js";
import { brokerTick, placeOrder } from "../../trader/portfolio.js";

const ROOT = path.join(__dirname, "..", "..", "..");
const SAUVEGARDE = path.join(ROOT, "sonni", "vps", "sauvegarde.mjs");
const RESTAURATION = path.join(ROOT, "sonni", "vps", "restauration.mjs");
const EXAMPLE = JSON.parse(fs.readFileSync(path.join(ROOT, "sonni", "automaton.sonni.example.json"), "utf-8"));
const TRADER: TraderConfig = parseTraderConfig(EXAMPLE.trader)!;
const T0 = new Date("2026-10-07T08:00:00Z");
const hours = (n: number) => new Date(T0.getTime() + n * 3_600_000);
const THESIS = "Test de sauvegarde : petite position pour que la copie porte un ordre, une position et le registre.";
const KEY_TABLES = [
  "trader_orders", "trader_ledger", "trader_positions", "trader_trades", "trader_prices", "trader_predictions",
  "trader_decisions", "trader_incidents", "trader_reflections", "turns", "inference_costs", "inbox_messages",
];
const COPY_NAME = /^state\.db\.predeploiement-\d{8}T\d{6}Z$/;

let tmpDirs: string[] = [];
function tmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
beforeEach(() => { tmpDirs = []; });
afterEach(() => { for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true }); });

const sha = (file: string) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const mode = (file: string) => fs.statSync(file).mode & 0o777;
const lastLine = (out: string) => out.trimEnd().split("\n").at(-1) ?? "";
const env = (home: string, extra: Record<string, string> = {}) => ({ ...process.env, HOME: home, TMPDIR: tmp("sonni-deploy-tmp-"), ...extra });

type Run = { status: number | null; stdout: string; stderr: string };
function run(script: string, args: string[], e: NodeJS.ProcessEnv): Run {
  const r = spawnSync(process.execPath, [script, ...args], { encoding: "utf-8", env: e });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}
/** The script in a child process while this process keeps running (and writing). */
function runAsync(script: string, args: string[], e: NodeJS.ProcessEnv): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { env: e });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

/** A temporary HOME with ~/.automaton, as the sonni user has on the VPS. */
function home(): string {
  const h = tmp("sonni-deploy-home-");
  fs.mkdirSync(path.join(h, ".automaton"), { mode: 0o700 });
  return h;
}
const livePath = (h: string) => path.join(h, ".automaton", "state.db");

function storePrice(db: AutomatonDatabase, asset: string, at: Date, price: number) {
  db.raw.prepare("INSERT INTO trader_prices (asset, ts, price, source) VALUES (?, ?, ?, 'test')").run(asset, isoSeconds(at), price);
}

/**
 * Sonni's live database as the runtime opens it (WAL), with a funded portfolio, one filled buy, an open
 * position, a few thousand stored prices and an owner message. The connection stays open: -wal exists.
 */
function liveDb(file: string): AutomatonDatabase {
  const db = createDatabase(file);
  ensureMoneyLabSchema(db.raw);
  ensureTraderSchema(db.raw);
  storePrice(db, "BTC", T0, 60_000);
  brokerTick(db.raw, TRADER, T0);
  storePrice(db, "BTC", hours(1), 60_100);
  expect(placeOrder(db.raw, TRADER, { asset: "BTC", side: "buy", amountEur: 100, invalidation: 42_000, thesis: THESIS } as any, hours(1)).ok).toBe(true);
  storePrice(db, "BTC", hours(1.1), 60_200);
  expect(brokerTick(db.raw, TRADER, hours(1.1)).fills.length).toBe(1);
  const insert = db.raw.prepare("INSERT INTO trader_prices (asset, ts, price, source) VALUES ('ETH', ?, ?, 'test')");
  db.raw.transaction(() => {
    for (let i = 0; i < 3000; i++) insert.run(isoSeconds(new Date(hours(2).getTime() + i * 60_000)), 2_000 + i);
  })();
  db.raw.prepare("INSERT INTO inbox_messages (id, from_address, content) VALUES ('m1', 'telegram:owner', 'Bonjour Sonni')").run();
  return db;
}

function countsOf(db: Database.Database): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of KEY_TABLES) {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t)) continue;
    out[t] = (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
  }
  return out;
}
/** Opens a self-contained (rollback journal) copy read-only: nothing is created beside it. */
function readCopy<T>(file: string, read: (db: Database.Database) => T): T {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    return read(db);
  } finally {
    db.close();
  }
}
const sidecars = (file: string) => ["-wal", "-shm", "-journal"].filter((s) => fs.existsSync(`${file}${s}`));

/** A stopped Sonni's database (clean close: no -wal) and a verified cold copy of it made by the script. */
function stoppedWithCopy(): { h: string; live: string; copy: string; counts: Record<string, number> } {
  const h = home();
  const live = livePath(h);
  const db = liveDb(live);
  const counts = countsOf(db.raw);
  db.close();
  const r = run(SAUVEGARDE, [], env(h));
  expect(r.status, r.stderr).toBe(0);
  const copy = /^RÉSULTAT : code=0 copie=(.+)$/.exec(lastLine(r.stdout))![1];
  return { h, live, copy, counts };
}

/** Overwrites the root page of trader_prices: SQLite's integrity check fails, the header stays valid. */
function corrupt(file: string) {
  const { rootpage, pageSize } = readCopy(file, (db) => ({
    rootpage: (db.prepare("SELECT rootpage FROM sqlite_master WHERE type = 'table' AND name = 'trader_prices'").get() as { rootpage: number }).rootpage,
    pageSize: db.pragma("page_size", { simple: true }) as number,
  }));
  const fd = fs.openSync(file, "r+");
  fs.writeSync(fd, Buffer.alloc(64, 0xff), 0, 64, (rootpage - 1) * pageSize);
  fs.closeSync(fd);
}

/**
 * A fake systemctl printing `state` (exit 0 for active, 3 otherwise, like systemctl is-active) and logging its
 * arguments; `before` is an extra shell line it runs first.
 */
function fakeSystemctl(state: string, before = ""): { bin: string; calls: string } {
  const dir = tmp("sonni-deploy-systemctl-");
  const bin = path.join(dir, "systemctl");
  const calls = path.join(dir, "appels");
  fs.writeFileSync(bin, `#!/bin/sh\n${before}\necho "$@" >> "${calls}"\necho "${state}"\n[ "${state}" = active ] && exit 0\nexit 3\n`, { mode: 0o755 });
  return { bin, calls };
}

/** The indented shell commands printed after the line containing `header` (the owner copies them as they are). */
function commandsAfter(text: string, header: string): string[] {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.includes(header));
  expect(start, `« ${header} » absent de :\n${text}`).toBeGreaterThanOrEqual(0);
  const out: string[] = [];
  for (const l of lines.slice(start + 1)) {
    if (!/^  \(cd '/.test(l)) break;
    out.push(l.trim());
  }
  expect(out.length, text).toBeGreaterThan(0);
  return out;
}
/** Runs the printed commands as the owner would paste them into a shell (from another folder). */
function runCommands(commands: string[]) {
  const r = spawnSync("sh", ["-c", commands.join("\n")], { encoding: "utf-8", cwd: os.tmpdir() });
  expect(r.stderr).toBe("");
  expect(r.stdout).toBe("");
}
/** SHA-256 of every file directly in `dir` (by name): what a set of moves must or must not change. */
function filesOf(dir: string): Record<string, string> {
  return Object.fromEntries(fs.readdirSync(dir).filter((f) => fs.lstatSync(path.join(dir, f)).isFile()).map((f) => [f, sha(path.join(dir, f))]));
}
/** The UTC stamp a restore run used, read from its quarantine folder's name. */
const stampOf = (quarantine: string) => path.basename(quarantine).slice("quarantaine-".length);

/**
 * A script run as the owner runs it, from a shell whose umask is 022 (the usual default), with a preload module
 * that reports on stderr the umask the script ends with and the mode of every file just before the script
 * chmods it (the mode the file was created with). The script itself reads no test variable.
 */
function runObserved(script: string, args: string[], e: NodeJS.ProcessEnv): Run {
  const hook = path.join(tmp("sonni-deploy-hook-"), "observe.mjs");
  fs.writeFileSync(hook, [
    "import fs from 'fs';",
    "const chmod = fs.chmodSync;",
    "fs.chmodSync = function (file, mode) {",
    "  try { process.stderr.write(`OBSERVE avant-chmod ${file} ${(fs.statSync(file).mode & 0o777).toString(8)}\\n`); } catch {}",
    "  return chmod.call(this, file, mode);",
    "};",
    // The restore changes modes through a descriptor opened without following links (fchmod): its path is read
    // back from /proc.
    "const fchmod = fs.fchmodSync;",
    "fs.fchmodSync = function (fd, mode) {",
    "  try { process.stderr.write(`OBSERVE avant-chmod ${fs.readlinkSync(`/proc/self/fd/${fd}`)} ${(fs.fstatSync(fd).mode & 0o777).toString(8)}\\n`); } catch {}",
    "  return fchmod.call(this, fd, mode);",
    "};",
    "process.on('exit', () => { process.stderr.write(`OBSERVE umask ${process.umask().toString(8)}\\n`); });",
    "",
  ].join("\n"));
  const r = spawnSync("sh", ["-c", 'umask 022 && exec "$@"', "sh", process.execPath, "--import", pathToFileURL(hook).href, script, ...args], { encoding: "utf-8", env: e });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** Calls a script's function in this process, capturing what it writes on stdout and stderr. */
async function captured<T>(call: () => T | Promise<T>): Promise<{ value: T; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const out = vi.spyOn(process.stdout, "write").mockImplementation((chunk: any) => { stdout += String(chunk); return true; });
  const err = vi.spyOn(process.stderr, "write").mockImplementation((chunk: any) => { stderr += String(chunk); return true; });
  try {
    return { value: await call(), stdout, stderr };
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
}
afterEach(() => { vi.restoreAllMocks(); });

describe("Consistent backup of the live database (sonni/vps/sauvegarde.mjs)", () => {
  it("copies a running Sonni's database while a second connection keeps writing: one snapshot, self-contained, 600, with its .sha256", async () => {
    const h = home();
    const live = livePath(h);
    const db = liveDb(live);
    expect(fs.existsSync(`${live}-wal`)).toBe(true);
    const before = countsOf(db.raw);
    // Sonni keeps writing: 20 prices per transaction, every 2 ms, for the whole life of the child process.
    const insert = db.raw.prepare("INSERT INTO trader_prices (asset, ts, price, source) VALUES ('SPY', ?, ?, 'test')");
    let written = 0;
    const timer = setInterval(() => {
      db.raw.transaction(() => {
        for (let k = 0; k < 20; k++) {
          insert.run(isoSeconds(new Date(hours(100).getTime() + written * 1000)), 1_000 + written);
          written += 1;
        }
      })();
    }, 2);
    let r: Run;
    try {
      r = await runAsync(SAUVEGARDE, [], env(h));
    } finally {
      clearInterval(timer);
    }
    expect(r.status, r.stderr).toBe(0);
    expect(written).toBeGreaterThan(0);
    const after = countsOf(db.raw);
    db.close();

    const m = /^RÉSULTAT : code=0 copie=(.+)$/.exec(lastLine(r.stdout));
    expect(m, r.stdout).not.toBeNull();
    const copy = m![1];
    const dossier = path.join(h, ".automaton", "predeploiement");
    expect(path.dirname(copy)).toBe(dossier);
    expect(path.basename(copy)).toMatch(COPY_NAME);
    expect(mode(dossier)).toBe(0o700);
    expect(mode(copy)).toBe(0o600);
    expect(mode(`${copy}.sha256`)).toBe(0o600);
    expect(sidecars(copy)).toEqual([]);
    expect(fs.readdirSync(dossier).sort()).toEqual([path.basename(copy), `${path.basename(copy)}.sha256`]);
    // Rollback journal (header bytes 18-19 = 1): the copy needs no -wal and opens read-only anywhere.
    const header = fs.readFileSync(copy).subarray(18, 20);
    expect([...header]).toEqual([1, 1]);
    // sha256sum format, checkable with `sha256sum -c` from the folder.
    expect(fs.readFileSync(`${copy}.sha256`, "utf-8")).toBe(`${sha(copy)}  ${path.basename(copy)}\n`);

    readCopy(copy, (c) => {
      expect(c.pragma("integrity_check", { simple: true })).toBe("ok");
      expect(c.pragma("journal_mode", { simple: true })).toBe("delete");
      const copied = countsOf(c);
      expect(Object.keys(copied).sort()).toEqual(Object.keys(before).sort());
      for (const t of Object.keys(before)) {
        expect(copied[t], t).toBeGreaterThanOrEqual(before[t]);
        expect(copied[t], t).toBeLessThanOrEqual(after[t]);
      }
      // One snapshot: the writer's rows form whole transactions with no gap (20, 40, … rows, prices 1000…).
      const spy = c.prepare("SELECT COUNT(*) AS n, MIN(price) AS lo, MAX(price) AS hi FROM trader_prices WHERE asset = 'SPY'").get() as { n: number; lo: number | null; hi: number | null };
      expect(spy.n % 20).toBe(0);
      if (spy.n > 0) expect([spy.lo, spy.hi]).toEqual([1_000, 1_000 + spy.n - 1]);
    });
    expect(r.stdout).toContain("Mode : à chaud (Sonni en marche, ou arrêté sans fermer sa base : un fichier -wal est à côté)");
    expect(r.stdout).toContain(`Source : ${live}`);
    expect(r.stdout).toContain(`Copie : ${copy}`);
    expect(r.stdout).toContain(`SHA-256 : ${sha(copy)}`);
    expect(r.stdout).toContain("Intégrité : ok");
    expect(r.stdout).toMatch(/  - trader_orders : 1 \(base active juste avant : 1\)/);
    expect(r.stdout).toMatch(/  - inbox_messages : 1 /);
    expect(r.stdout).toContain("  - dernier ordre passé : 2026-10-07T09:00:00.000Z");
    expect(r.stdout).toContain("  - dernière ligne du registre : 2026-10-07T09:06:00Z");
    expect(r.stdout).toMatch(/  - dernier prix enregistré : 2026-10-\d\dT/);
  });

  it("copies a stopped Sonni's database byte for byte without opening it: no -wal or -shm appears beside it", () => {
    const h = home();
    const live = livePath(h);
    const db = liveDb(live);
    const counts = countsOf(db.raw);
    db.close();
    expect(sidecars(live)).toEqual([]);
    const before = sha(live);
    const mtime = fs.statSync(live).mtimeMs;
    const dossier = path.join(tmp("sonni-deploy-out-"), "copies");
    const r = run(SAUVEGARDE, ["--source", live, "--dossier", dossier], env(h));
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("Mode : à froid (Sonni arrêté)");
    // The live file is untouched and was never opened by SQLite (a read-only open of a WAL database leaves -wal/-shm).
    expect(sha(live)).toBe(before);
    expect(fs.statSync(live).mtimeMs).toBe(mtime);
    expect(sidecars(live)).toEqual([]);
    expect(fs.readdirSync(path.dirname(live))).toEqual(["state.db"]);

    const copy = /^RÉSULTAT : code=0 copie=(.+)$/.exec(lastLine(r.stdout))![1];
    expect(path.dirname(copy)).toBe(dossier);
    expect(mode(dossier)).toBe(0o700);
    expect(mode(copy)).toBe(0o600);
    expect(sidecars(copy)).toEqual([]);
    expect(fs.readFileSync(`${copy}.sha256`, "utf-8")).toBe(`${sha(copy)}  ${path.basename(copy)}\n`);
    readCopy(copy, (c) => {
      expect(c.pragma("integrity_check", { simple: true })).toBe("ok");
      expect(c.pragma("journal_mode", { simple: true })).toBe("delete");
      expect(countsOf(c)).toEqual(counts);
    });
    expect(r.stdout).toMatch(/  - trader_prices : 3003\n/);
  });

  it("refuses a symbolic link, a missing source, the runtime's backups folder and the database's own folder, writing nothing", () => {
    const h = home();
    const live = livePath(h);
    liveDb(live).close();
    const refused = (args: string[], message: string | RegExp) => {
      const r = run(SAUVEGARDE, args, env(h));
      expect(r.status, r.stdout + r.stderr).toBe(2);
      expect(r.stderr).toMatch(message);
      expect(lastLine(r.stdout)).toBe("RÉSULTAT : code=2 copie=aucune");
    };
    const link = path.join(tmp("sonni-deploy-link-"), "state.db");
    fs.symlinkSync(live, link);
    refused(["--source", link], /lien symbolique/);
    refused(["--source", path.join(h, ".automaton", "absente.db")], /base introuvable/);
    refused(["--source", path.join(h, ".automaton")], /pas un fichier ordinaire/);
    refused(["--dossier", path.join(h, ".automaton", "backups")], /au bout de 7 jours/);
    refused(["--dossier", path.join(h, ".automaton")], /dossier de la base/);
    refused(["--dossier", `${path.join(h, ".automaton")}/.`], /dossier de la base/);
    refused(["--inconnue"], /Option inconnue/);
    refused(["--source"], /attend un chemin/);
    expect(fs.readdirSync(path.join(h, ".automaton"))).toEqual(["state.db"]);
    expect(sidecars(live)).toEqual([]);
  });

  it("stops before copying when the disk lacks twice the database and its journal (exit 3, both figures)", async () => {
    const { sauvegarde, spaceNeeded, freeSpace } = await import(pathToFileURL(SAUVEGARDE).href);
    const h = home();
    const live = livePath(h);
    liveDb(live).close();
    const size = fs.statSync(live).size;
    expect(spaceNeeded(live)).toBe(2 * size);
    fs.writeFileSync(`${live}-wal`, Buffer.alloc(4096));
    expect(spaceNeeded(live)).toBe(2 * (size + 4096));
    fs.rmSync(`${live}-wal`);
    expect(freeSpace(h)).toBeGreaterThan(0);

    const dossier = path.join(tmp("sonni-deploy-out-"), "copies");
    const lines: string[] = [];
    const r = await sauvegarde({ source: live, dossier, env: { HOME: h }, say: (l = "") => lines.push(l), warn: (l: string) => lines.push(l), freeSpace: () => 1_048_576 });
    expect(r.code).toBe(3);
    const text = lines.join("\n");
    const needed = (2 * size / 1_048_576).toLocaleString("fr-FR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    expect(text).toContain(`Espace disque insuffisant dans ${dossier} : 1,0 Mo libres, ${needed} Mo nécessaires`);
    expect(lines.at(-1)).toBe("RÉSULTAT : code=3 copie=aucune");
    expect(fs.readdirSync(dossier)).toEqual([]);
    expect(sidecars(live)).toEqual([]);

    // Enough room: the same call makes the copy.
    const ok = await sauvegarde({ source: live, dossier, env: { HOME: h }, say: () => {}, warn: () => {}, freeSpace: () => 4 * size });
    expect(ok.code).toBe(0);
    expect(path.basename(ok.copy)).toMatch(COPY_NAME);
  });

  it("keeps the copy private from its creation: umask 077, an existing 0755 folder closed to 0700, the partial copy created 600 (hot and cold)", () => {
    const h = home();
    const live = livePath(h);
    const db = liveDb(live);
    // The default folder already there and open to everyone, as `mkdir` leaves it with the usual umask (only the
    // default folder is closed by the script; any other open folder is refused, see the next test).
    const openFolder = () => {
      const dossier = path.join(h, ".automaton", "predeploiement");
      fs.rmSync(dossier, { recursive: true, force: true });
      fs.mkdirSync(dossier);
      fs.chmodSync(dossier, 0o755);
      return dossier;
    };
    const check = (r: Run, dossier: string, hot: boolean) => {
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(r.stdout).toContain(hot ? "Mode : à chaud (Sonni en marche, ou arrêté sans fermer sa base : un fichier -wal est à côté)" : "Mode : à froid (Sonni arrêté)");
      expect(r.stderr).toContain("OBSERVE umask 77\n");
      expect(r.stdout).toContain(`Dossier ${dossier} : droits 755 ramenés à 700 (la copie contient toute la mémoire de Sonni).`);
      const copy = /^RÉSULTAT : code=0 copie=(.+)$/.exec(lastLine(r.stdout))![1];
      // The copy was already 600 when the script set it to 600: never readable by others, not even for a moment.
      expect(r.stderr).toContain(`OBSERVE avant-chmod ${copy}.partial 600\n`);
      expect(mode(dossier)).toBe(0o700);
      expect(mode(copy)).toBe(0o600);
      expect(mode(`${copy}.sha256`)).toBe(0o600);
    };
    // Hot: SQLite creates the partial copy and its journal with the process umask.
    const hotFolder = openFolder();
    const hot = runObserved(SAUVEGARDE, [], env(h));
    db.close();
    check(hot, hotFolder, true);
    // Cold: the live file is 644 (the runtime sets no umask); a plain copyFileSync would give the copy that mode.
    fs.chmodSync(live, 0o644);
    const coldFolder = openFolder();
    const cold = runObserved(SAUVEGARDE, [], env(h));
    check(cold, coldFolder, false);
    expect(mode(live)).toBe(0o644);
  });
});

describe("Verifications of the backup (sonni/vps/sauvegarde.mjs, called in this process)", () => {
  const realBackup = Database.prototype.backup;

  it("takes the hot snapshot in ONE backup step: one progress call, answered with at least every page", async () => {
    const { sauvegarde } = await import(pathToFileURL(SAUVEGARDE).href);
    const h = home();
    const live = livePath(h);
    const db = liveDb(live);
    const steps: Array<{ total: number; remaining: number; rate: unknown }> = [];
    vi.spyOn(Database.prototype, "backup").mockImplementation(function (this: Database.Database, file: string, options?: Database.BackupOptions) {
      const progress = options?.progress;
      return realBackup.call(this, file, {
        ...options,
        progress: (info) => {
          const rate = progress?.(info);
          steps.push({ total: info.totalPages, remaining: info.remainingPages, rate });
          return rate as number;
        },
      });
    });
    const lines: string[] = [];
    const r = await sauvegarde({ env: { HOME: h }, say: (l = "") => lines.push(l), warn: (l: string) => lines.push(l) });
    db.close();
    expect(r.code, lines.join("\n")).toBe(0);
    expect(lines).toContain("Mode : à chaud (Sonni en marche, ou arrêté sans fermer sa base : un fichier -wal est à côté)");
    // better-sqlite3 first transfers no page, asks the callback once, then copies what it answered: every page.
    expect(steps).toHaveLength(1);
    expect(steps[0].total).toBeGreaterThan(100);
    expect(steps[0].remaining).toBe(steps[0].total);
    expect(steps[0].rate).toBeGreaterThanOrEqual(steps[0].total);
  });

  it("refuses a hot copy holding fewer rows than the live database had just before (exit 1, nothing kept)", async () => {
    const { sauvegarde } = await import(pathToFileURL(SAUVEGARDE).href);
    const h = home();
    const live = livePath(h);
    const db = liveDb(live);
    // Rows disappear between the counts and the snapshot: the copy cannot be trusted to hold all of Sonni's memory.
    vi.spyOn(Database.prototype, "backup").mockImplementation(function (this: Database.Database, file: string, options?: Database.BackupOptions) {
      db.raw.prepare("DELETE FROM trader_prices WHERE asset = 'ETH' AND ts < ?").run(isoSeconds(hours(2.1)));
      return realBackup.call(this, file, options);
    });
    const dossier = path.join(tmp("sonni-deploy-out-"), "copies");
    const lines: string[] = [];
    const r = await sauvegarde({ dossier, env: { HOME: h }, say: (l = "") => lines.push(l), warn: (l: string) => lines.push(l) });
    db.close();
    expect(r.code, lines.join("\n")).toBe(1);
    expect(lines.join("\n")).toContain("Copie incomplète : trader_prices a 2997 lignes dans la copie contre 3003 dans la base active.");
    expect(lines.at(-1)).toBe("RÉSULTAT : code=1 copie=aucune");
    expect(fs.readdirSync(dossier)).toEqual([]);
  });

  it("cold copy: removes the copy and exits 1 when the database changes, the copy differs or a -wal appears during the copy", async () => {
    const { sauvegarde } = await import(pathToFileURL(SAUVEGARDE).href);
    const h = home();
    const live = livePath(h);
    liveDb(live).close();
    const realRead = fs.readFileSync;
    const cases: Array<{ during: (to: string) => void; message: string }> = [
      { during: () => fs.appendFileSync(live, Buffer.alloc(16)), message: "La base a changé pendant la copie" },
      { during: (to) => fs.appendFileSync(to, Buffer.alloc(16)), message: "La base a changé pendant la copie" },
      { during: () => fs.writeFileSync(`${live}-wal`, ""), message: "Sonni a démarré pendant la copie" },
    ];
    for (const c of cases) {
      // The change happens once the byte copy is made, just before the script first reads the copy back.
      let fired = false;
      const spy = vi.spyOn(fs, "readFileSync").mockImplementation(function (this: unknown, file: any, ...rest: any[]) {
        if (!fired && String(file).endsWith(".partial")) {
          fired = true;
          c.during(String(file));
        }
        return (realRead as any).call(this, file, ...rest);
      } as any);
      const dossier = path.join(tmp("sonni-deploy-out-"), "copies");
      const lines: string[] = [];
      let r: { code: number };
      try {
        r = await sauvegarde({ source: live, dossier, env: { HOME: h }, say: (l = "") => lines.push(l), warn: (l: string) => lines.push(l) });
      } finally {
        spy.mockRestore();
      }
      expect(fired).toBe(true);
      expect(r.code, lines.join("\n")).toBe(1);
      expect(lines).toContain("Mode : à froid (Sonni arrêté)");
      expect(lines.join("\n")).toContain(c.message);
      expect(lines.at(-1)).toBe("RÉSULTAT : code=1 copie=aucune");
      expect(fs.readdirSync(dossier)).toEqual([]);
    }
    // The -wal the test wrote is not the script's: it stays.
    expect(fs.existsSync(`${live}-wal`)).toBe(true);
  });

  it("refuses before creating or changing anything when a name it would use is taken, even by a dangling symbolic link (exit 2)", async () => {
    const { sauvegarde, stamp } = await import(pathToFileURL(SAUVEGARDE).href);
    const h = home();
    const live = livePath(h);
    liveDb(live).close();
    const now = new Date("2026-10-10T12:00:00Z");
    const name = `state.db.predeploiement-${stamp(now)}`;
    for (const suffix of ["", ".partial", ".sha256", ".partial-journal", ".partial-wal"]) {
      // A folder open to others too: a refusal leaves it exactly as it was (not even closed to 0700).
      const dossier = path.join(tmp("sonni-deploy-out-"), "copies");
      fs.mkdirSync(dossier);
      fs.chmodSync(dossier, 0o755);
      const elsewhere = path.join(tmp("sonni-deploy-elsewhere-"), "cible-du-lien");
      const link = path.join(dossier, `${name}${suffix}`);
      fs.symlinkSync(elsewhere, link);
      expect(fs.existsSync(link)).toBe(false);
      const lines: string[] = [];
      const r = await sauvegarde({ source: live, dossier, now, env: { HOME: h }, say: (l = "") => lines.push(l), warn: (l: string) => lines.push(l) });
      expect(r.code, `${suffix}\n${lines.join("\n")}`).toBe(2);
      expect(lines.join("\n")).toContain(`Refusé : ${link} existe déjà (fichier ou lien) : rien n'est jamais écrasé.`);
      expect(lines.at(-1)).toBe("RÉSULTAT : code=2 copie=aucune");
      expect(fs.readdirSync(dossier)).toEqual([path.basename(link)]);
      expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
      expect(fs.existsSync(elsewhere)).toBe(false);
      expect(mode(dossier)).toBe(0o755);
    }
    expect(sidecars(live)).toEqual([]);

    // A dangling link appearing at the copy's name during the run (just before the final rename) is not replaced.
    const dossier = path.join(tmp("sonni-deploy-out-"), "copies");
    const final = path.join(dossier, name);
    const elsewhere = path.join(tmp("sonni-deploy-elsewhere-"), "cible-du-lien");
    const realChmod = fs.chmodSync;
    const spy = vi.spyOn(fs, "chmodSync").mockImplementation((file, m) => {
      realChmod(file, m);
      if (String(file) === `${final}.partial`) fs.symlinkSync(elsewhere, final);
    });
    const lines: string[] = [];
    let r: { code: number };
    try {
      r = await sauvegarde({ source: live, dossier, now, env: { HOME: h }, say: (l = "") => lines.push(l), warn: (l: string) => lines.push(l) });
    } finally {
      spy.mockRestore();
    }
    expect(r.code, lines.join("\n")).toBe(3);
    expect(lines.join("\n")).toContain(`${final} est apparu pendant la sauvegarde : rien n'a été écrasé.`);
    expect(fs.readdirSync(dossier)).toEqual([name]);
    expect(fs.lstatSync(final).isSymbolicLink()).toBe(true);
  });

  it("refuses a folder open to others unless it is its own default folder: never changes a shared folder such as /tmp", async () => {
    const { sauvegarde } = await import(pathToFileURL(SAUVEGARDE).href);
    const h = home();
    const live = livePath(h);
    liveDb(live).close();
    const dossier = path.join(tmp("sonni-deploy-out-"), "partage");
    fs.mkdirSync(dossier);
    fs.chmodSync(dossier, 0o750);
    const owner = fs.statSync(dossier).uid;
    const lines: string[] = [];
    const say = (l = "") => lines.push(l);
    const r = await sauvegarde({ source: live, dossier, env: { HOME: h }, say, warn: say, getuid: () => owner + 1 });
    expect(r.code, lines.join("\n")).toBe(2);
    const refusedText = `Refusé : le dossier ${dossier} est ouvert à d'autres utilisateurs (droits 750). La copie contient toute la mémoire de Sonni : choisis un dossier fermé aux autres (droits 700), par défaut ~/.automaton/predeploiement.`;
    expect(lines.join("\n")).toContain(refusedText);
    expect(lines.at(-1)).toBe("RÉSULTAT : code=2 copie=aucune");
    expect(fs.readdirSync(dossier)).toEqual([]);
    expect(mode(dossier)).toBe(0o750);
    // The same folder owned by the user running the script is still refused and left as it is (a shared folder,
    // /tmp as root for example, must never be closed or lose its sticky bit).
    lines.length = 0;
    const mine = await sauvegarde({ source: live, dossier, env: { HOME: h }, say, warn: say, getuid: () => owner });
    expect(mine.code, lines.join("\n")).toBe(2);
    expect(lines.join("\n")).toContain(refusedText);
    expect(mode(dossier)).toBe(0o750);
    // Its own default folder, open to others: closed to 0700, then the copy is made.
    const own = path.join(h, ".automaton", "predeploiement");
    fs.mkdirSync(own);
    fs.chmodSync(own, 0o750);
    lines.length = 0;
    const byDefault = await sauvegarde({ source: live, env: { HOME: h }, say, warn: say, getuid: () => owner });
    expect(byDefault.code, lines.join("\n")).toBe(0);
    expect(lines).toContain(`Dossier ${own} : droits 750 ramenés à 700 (la copie contient toute la mémoire de Sonni).`);
    expect(mode(own)).toBe(0o700);
  });
});

describe("Restore drill (sonni/vps/restauration.mjs --essai)", () => {
  it("restores the copy into a private folder, finds the same rows, reports RTO and RPO, and removes the folder", () => {
    const { h, copy, live } = stoppedWithCopy();
    const before = sha(copy);
    const liveBefore = sha(live);
    const e = env(h);
    const r = run(RESTAURATION, ["--essai", copy], e);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("Empreinte SHA-256 : conforme au fichier .sha256");
    expect(r.stdout).toContain("Intégrité de la copie : ok");
    expect(r.stdout).toMatch(/  - trader_prices : 3003 → 3003\n/);
    expect(r.stdout).toMatch(/Durée de la remise en place \(RTO\) : \d+,\d\d s/);
    expect(r.stdout).toMatch(/Âge des données \(RPO\) : .* \(dernière donnée le 2026-10-09T/);
    expect(lastLine(r.stdout)).toMatch(/^RÉSULTAT : code=0 essai=réussi tables=\d+ rto_s=\d+\.\d\d rpo_min=\d+$/);
    expect(fs.readdirSync(e.TMPDIR!)).toEqual([]);
    expect(sha(copy)).toBe(before);
    expect(sha(live)).toBe(liveBefore);
    expect(fs.readdirSync(path.join(h, ".automaton")).sort()).toEqual(["predeploiement", "state.db"]);
  });

  it("says when there is no .sha256 to check (a runtime daily copy)", () => {
    const { h, copy } = stoppedWithCopy();
    const daily = path.join(tmp("sonni-deploy-daily-"), "state.db.backup-2026-10-09");
    fs.copyFileSync(copy, daily);
    const r = run(RESTAURATION, ["--essai", daily], env(h));
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("pas de fichier .sha256 : empreinte calculée, non vérifiée");
  });

  it("fails on a fingerprint mismatch or a corrupted copy (exit 1) and still removes its temporary folders", () => {
    const { h, copy } = stoppedWithCopy();
    const shaFile = `${copy}.sha256`;
    const good = fs.readFileSync(shaFile, "utf-8");
    fs.writeFileSync(shaFile, good.replace(/^[0-9a-f]/, (c) => (c === "0" ? "1" : "0")));
    const e1 = env(h);
    const r1 = run(RESTAURATION, ["--essai", copy], e1);
    expect(r1.status).toBe(1);
    expect(r1.stderr).toContain("Empreinte SHA-256 différente");
    expect(lastLine(r1.stdout)).toBe("RÉSULTAT : code=1 essai=échoué");
    expect(fs.readdirSync(e1.TMPDIR!)).toEqual([]);

    corrupt(copy);
    fs.writeFileSync(shaFile, `${sha(copy)}  ${path.basename(copy)}\n`);
    const e2 = env(h);
    const r2 = run(RESTAURATION, ["--essai", copy], e2);
    expect(r2.status, r2.stdout + r2.stderr).toBe(1);
    expect(r2.stderr).toMatch(/Intégrité de la copie en défaut|Base abîmée/);
    expect(lastLine(r2.stdout)).toBe("RÉSULTAT : code=1 essai=échoué");
    expect(fs.readdirSync(e2.TMPDIR!)).toEqual([]);
  });

  it("reports a file that is not SQLite in plain French (exit 3)", async () => {
    const h = home();
    const fake = path.join(tmp("sonni-deploy-fake-"), "faux.db");
    fs.writeFileSync(fake, "ceci n'est pas une base\n");
    const e = env(h);
    const r = run(RESTAURATION, ["--essai", fake], e);
    expect(r.status, r.stdout + r.stderr).toBe(3);
    expect(r.stderr).toBe("Erreur technique : ce fichier n'est pas une base SQLite.\n");
    expect(lastLine(r.stdout)).toBe("RÉSULTAT : code=3 essai=échoué");
    expect(fs.readdirSync(e.TMPDIR!)).toEqual([]);
    const { technicalFr } = await import(pathToFileURL(SAUVEGARDE).href);
    expect(technicalFr(new Error("Something odd happened."))).toBe("cas imprévu (détail : Something odd happened)");
    expect(technicalFr(Object.assign(new Error("x"), { code: "EXDEV" }))).toBe("erreur système (EXDEV)");
  });

  it("a SIGTERM during the drill does not cut it short: it finishes, keeps its own result and removes its folders", async () => {
    const h = home();
    // A copy big enough (about 30 MB) for the signal to arrive while the drill copies and checks it.
    const copy = path.join(tmp("sonni-deploy-big-"), "state.db.predeploiement-20261010T000000Z");
    const big = new Database(copy);
    big.exec("CREATE TABLE trader_prices (asset TEXT NOT NULL, ts TEXT NOT NULL, price REAL NOT NULL CHECK (price > 0), source TEXT NOT NULL, PRIMARY KEY (asset, ts))");
    big.exec("WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 200000) "
      + "INSERT INTO trader_prices SELECT 'BIG', strftime('%Y-%m-%dT%H:%M:%SZ', '2026-01-01', '+' || x || ' seconds'), x, hex(randomblob(40)) FROM c");
    big.close();
    const e = env(h);
    const r = await new Promise<Run & { signal: NodeJS.Signals | null }>((resolve, reject) => {
      const child = spawn(process.execPath, [RESTAURATION, "--essai", copy], { env: e });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => {
        // Sent as soon as the drill has started (its first line), while it works.
        if (!stdout) child.kill("SIGTERM");
        stdout += d;
      });
      child.stderr.on("data", (d) => { stderr += d; });
      child.on("error", reject);
      child.on("close", (status, signal) => resolve({ status, signal, stdout, stderr }));
    });
    expect(r.signal, r.stderr).toBeNull();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain("  - trader_prices : 200000 → 200000");
    expect(r.stdout).not.toContain("Interrompu");
    expect(lastLine(r.stdout)).toMatch(/^RÉSULTAT : code=0 essai=réussi /);
    expect(fs.readdirSync(e.TMPDIR!)).toEqual([]);
  });

  it("refuses the active database: a file named state.db or a copy with -wal beside it (exit 2)", () => {
    const { h, live, copy } = stoppedWithCopy();
    const r1 = run(RESTAURATION, ["--essai", live], env(h));
    expect(r1.status).toBe(2);
    expect(r1.stderr).toContain("Refusé : c'est la base active de Sonni");
    fs.writeFileSync(`${copy}-wal`, "");
    const r2 = run(RESTAURATION, ["--essai", copy], env(h));
    expect(r2.status).toBe(2);
    expect(r2.stderr).toContain("un fichier -wal ou -shm est à côté");
    expect(lastLine(r2.stdout)).toBe("RÉSULTAT : code=2 essai=échoué");
    expect(run(RESTAURATION, [], env(h)).status).toBe(2);
    expect(run(RESTAURATION, ["--essai", copy, "--confirmer"], env(h)).status).toBe(2);
  });
});

describe("Real restore (sonni/vps/restauration.mjs --restaurer)", () => {
  /** A copy, then Sonni wrote more and stopped uncleanly: the target has newer rows and a -wal and -shm beside it. */
  function laterState() {
    const s = stoppedWithCopy();
    const db = createDatabase(s.live);
    storePrice(db, "BTC", hours(200), 61_000);
    db.close();
    fs.writeFileSync(`${s.live}-wal`, "journal laissé par un arrêt brutal");
    fs.writeFileSync(`${s.live}-shm`, "index du journal");
    const files = Object.fromEntries(["", "-wal", "-shm"].map((x) => [x, sha(`${s.live}${x}`)]));
    const untouched = () => {
      for (const [x, hash] of Object.entries(files)) expect(sha(`${s.live}${x}`), `state.db${x}`).toBe(hash);
      expect(fs.readdirSync(path.dirname(s.live)).filter((f) => f.startsWith("quarantaine-"))).toEqual([]);
      expect(fs.existsSync(`${s.live}.restauration-partielle`)).toBe(false);
    };
    return { ...s, files, untouched };
  }

  it("refuses without --confirmer and moves nothing (exit 2), without even asking systemd", () => {
    const s = laterState();
    const fake = fakeSystemctl("inactive");
    const r = run(RESTAURATION, ["--restaurer", s.copy], env(s.h, { SONNI_SYSTEMCTL: fake.bin }));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("relance avec --confirmer");
    expect(r.stderr).toContain("perd tout ce qu'il a écrit depuis");
    expect(lastLine(r.stdout)).toBe("RÉSULTAT : code=2 cible=inchangée quarantaine=aucune");
    expect(fs.existsSync(fake.calls)).toBe(false);
    s.untouched();
  });

  // The command-line runs below name the target with --cible: run as root (as in some containers), a restore
  // without --cible is refused, which a separate test covers through the exported function.
  it("refuses while systemd says Sonni runs (exit 2), and without systemd unless --sans-systemd", () => {
    const s = laterState();
    for (const state of ["active", "activating", "reloading", "deactivating"]) {
      const fake = fakeSystemctl(state);
      const r = run(RESTAURATION, ["--restaurer", s.copy, "--confirmer", "--cible", s.live], env(s.h, { SONNI_SYSTEMCTL: fake.bin }));
      expect(r.status, state).toBe(2);
      expect(r.stderr).toContain("Sonni tourne : arrête-le d'abord (systemctl stop sonni)");
      expect(fs.readFileSync(fake.calls, "utf-8")).toBe("is-active sonni\n");
      s.untouched();
    }
    // An answer that says neither "running" nor "stopped" is not taken as stopped.
    for (const state of ["unknown", ""]) {
      const fake = fakeSystemctl(state);
      const r = run(RESTAURATION, ["--restaurer", s.copy, "--confirmer", "--cible", s.live], env(s.h, { SONNI_SYSTEMCTL: fake.bin }));
      expect(r.status, state).toBe(2);
      expect(r.stderr).toContain(`Refusé : état de Sonni inattendu (« ${state || "vide"} »)`);
      expect(lastLine(r.stdout)).toBe("RÉSULTAT : code=2 cible=inchangée quarantaine=aucune");
      s.untouched();
    }
    const missing = env(s.h, { SONNI_SYSTEMCTL: path.join(tmp("sonni-deploy-nosystemd-"), "systemctl") });
    const r = run(RESTAURATION, ["--restaurer", s.copy, "--confirmer", "--cible", s.live], missing);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("--sans-systemd");
    s.untouched();
    const r2 = run(RESTAURATION, ["--restaurer", s.copy, "--confirmer", "--cible", s.live, "--sans-systemd"], missing);
    expect(r2.status, r2.stderr).toBe(0);
    expect(sha(s.live)).toBe(sha(s.copy));
  });

  it("refuses a copy whose fingerprint does not match or is missing (exit 1), and the copy itself as target (exit 2)", () => {
    const s = laterState();
    const fake = fakeSystemctl("inactive");
    const e = env(s.h, { SONNI_SYSTEMCTL: fake.bin });
    const shaFile = `${s.copy}.sha256`;
    const good = fs.readFileSync(shaFile, "utf-8");
    fs.writeFileSync(shaFile, `${"0".repeat(64)}  ${path.basename(s.copy)}\n`);
    const r1 = run(RESTAURATION, ["--restaurer", s.copy, "--confirmer", "--cible", s.live], e);
    expect(r1.status).toBe(1);
    expect(r1.stderr).toContain("Empreinte SHA-256 différente");
    s.untouched();
    fs.rmSync(shaFile);
    const r2 = run(RESTAURATION, ["--restaurer", s.copy, "--confirmer", "--cible", s.live], e);
    expect(r2.status).toBe(1);
    expect(r2.stderr).toContain("pas de fichier");
    s.untouched();
    fs.writeFileSync(shaFile, good);
    const r3 = run(RESTAURATION, ["--restaurer", s.copy, "--confirmer", "--cible", s.copy], e);
    expect(r3.status).toBe(2);
    expect(r3.stderr).toContain("la copie et la cible sont le même fichier");
    s.untouched();
    expect(fs.existsSync(fake.calls)).toBe(false);
  });

  it("refuses a target that is a folder or a symbolic link (exit 2) before moving anything", () => {
    const s = laterState();
    const fake = fakeSystemctl("inactive");
    const e = env(s.h, { SONNI_SYSTEMCTL: fake.bin });
    const automaton = path.dirname(s.live);
    const r1 = run(RESTAURATION, ["--restaurer", s.copy, "--confirmer", "--cible", automaton], e);
    expect(r1.status, r1.stdout + r1.stderr).toBe(2);
    expect(r1.stderr).toContain("Refusé : la cible n'est pas un fichier de base ordinaire");
    expect(lastLine(r1.stdout)).toBe("RÉSULTAT : code=2 cible=inchangée quarantaine=aucune");
    expect(fs.readdirSync(s.h).filter((f) => f.startsWith("quarantaine-"))).toEqual([]);
    const link = path.join(tmp("sonni-deploy-link-"), "state.db");
    fs.symlinkSync(s.live, link);
    const r2 = run(RESTAURATION, ["--restaurer", s.copy, "--confirmer", "--cible", link], e);
    expect(r2.status, r2.stdout + r2.stderr).toBe(2);
    expect(r2.stderr).toContain("Refusé : la cible n'est pas un fichier de base ordinaire");
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(fake.calls)).toBe(false);
    s.untouched();
  });

  it("on a failure before anything moved (the quarantine folder cannot be secured), says the previous database is intact and removes the empty folder", async () => {
    // Report local-win n°04: fchmod on the folder's descriptor failed (EPERM) right after the quarantine was created,
    // and the message called the untouched previous database "base restaurée NON conforme, à déplacer". On the VPS the
    // same path is reached when securing the folder fails (an owner change as root, for example).
    const { restaurer } = await import(pathToFileURL(RESTAURATION).href);
    const s = laterState();
    const fake = fakeSystemctl("inactive");
    const realFchmod = fs.fchmodSync;
    const spy = vi.spyOn(fs, "fchmodSync").mockImplementation((fd, mode) => {
      if (fs.fstatSync(fd).isDirectory()) throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
      realFchmod(fd, mode);
    });
    let r: { value: number; stdout: string; stderr: string };
    try {
      r = await captured(() => restaurer(s.copy, { confirmed: true, getuid: () => 1000, env: { ...process.env, HOME: s.h, SONNI_SYSTEMCTL: fake.bin } }));
    } finally {
      spy.mockRestore();
    }
    expect(r.value, r.stdout + r.stderr).toBe(3);
    expect(r.stderr).toContain(`ÉCHEC avant tout déplacement : l'ancienne base est intacte, à sa place (${s.live}). Ne la déplace pas ; rien n'a été restauré.`);
    expect(r.stderr).toMatch(/Le dossier .*quarantaine-\d{8}T\d{6}Z, vide, a été retiré\./);
    expect(r.stderr).not.toContain("NON conforme");
    expect(r.stderr).not.toContain("ÉCHEC après");
    expect(r.stderr).not.toContain("Pour remettre l'ancienne mémoire");
    expect(lastLine(r.stdout)).toBe("RÉSULTAT : code=3 cible=inchangée quarantaine=aucune");
    s.untouched();
  });

  it("restores on Windows without changing a folder's mode (fchmod and fsync on a folder's descriptor fail there)", async () => {
    const { restaurer } = await import(pathToFileURL(RESTAURATION).href);
    const s = laterState();
    const fake = fakeSystemctl("inactive");
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    const folders: string[] = [];
    const realFchmod = fs.fchmodSync;
    const spy = vi.spyOn(fs, "fchmodSync").mockImplementation((fd, mode) => {
      if (fs.fstatSync(fd).isDirectory()) folders.push(String(mode));
      realFchmod(fd, mode);
    });
    let r: { value: number; stdout: string; stderr: string };
    try {
      Object.defineProperty(process, "platform", { ...platform, value: "win32" });
      r = await captured(() => restaurer(s.copy, { confirmed: true, getuid: () => 1000, env: { ...process.env, HOME: s.h, SONNI_SYSTEMCTL: fake.bin } }));
    } finally {
      Object.defineProperty(process, "platform", platform);
      spy.mockRestore();
    }
    expect(r.value, r.stdout + r.stderr).toBe(0);
    expect(folders).toEqual([]);
    expect(sha(s.live)).toBe(sha(s.copy));
    const automaton = path.dirname(s.live);
    const q = path.join(automaton, fs.readdirSync(automaton).filter((f) => f.startsWith("quarantaine-"))[0]);
    for (const [x, hash] of Object.entries(s.files)) expect(sha(path.join(q, `state.db${x}`)), `state.db${x}`).toBe(hash);
  });

  it("on a failure after the move (a foreign partial file appears), exits 3, keeps the quarantine and prints how to put the old files back", () => {
    const s = laterState();
    const partial = `${s.live}.restauration-partielle`;
    // Another program creates the partial file between the checks and the copy (here: while systemd is asked).
    const fake = fakeSystemctl("inactive", `echo "fichier d'un autre programme" > '${partial}'`);
    const r = run(RESTAURATION, ["--restaurer", s.copy, "--confirmer", "--cible", s.live], env(s.h, { SONNI_SYSTEMCTL: fake.bin }));
    expect(r.status, r.stdout + r.stderr).toBe(3);
    const automaton = path.dirname(s.live);
    const quarantines = fs.readdirSync(automaton).filter((f) => f.startsWith("quarantaine-"));
    expect(quarantines).toHaveLength(1);
    const q = path.join(automaton, quarantines[0]);
    expect(lastLine(r.stdout)).toBe(`RÉSULTAT : code=3 cible=modifiée quarantaine=${q}`);
    expect(r.stderr).toContain("Erreur technique : un fichier du même nom existe déjà (EEXIST).");
    // The quarantine holds the previous files, byte for byte; the foreign file is left as it was.
    expect(fs.readdirSync(q).sort()).toEqual(["state.db", "state.db-shm", "state.db-wal"]);
    for (const [x, hash] of Object.entries(s.files)) expect(sha(path.join(q, `state.db${x}`)), `state.db${x}`).toBe(hash);
    expect(fs.readFileSync(partial, "utf-8")).toBe("fichier d'un autre programme\n");
    expect(r.stderr).toContain(`  - ${partial} : fichier qui n'a pas été créé par cette restauration, laissé tel quel (à examiner)`);
    const commands = commandsAfter(r.stderr, "Pour remettre l'ancienne mémoire");
    for (const x of ["", "-wal", "-shm"]) {
      expect(r.stderr).toContain(`  - ${s.live}${x} est maintenant ${path.join(q, `state.db${x}`)} (intact)`);
      expect(commands.filter((c) => c.endsWith(`&& mv '${quarantines[0]}/state.db${x}' 'state.db${x}')`)), x).toHaveLength(1);
    }
    expect(commands.every((c) => c.startsWith(`(cd '${automaton}' && [ `))).toBe(true);
    expect(r.stderr).toContain(`part de côté sous le nom state.db.echec-${stampOf(q)} :`);
    expect(r.stderr).toContain(`Ces lignes n'écrasent jamais un fichier`);
    expect(r.stderr).toContain(`Le dossier ${q} n'a pas été supprimé.`);
    expect(fs.existsSync(s.live)).toBe(false);

    // The printed commands put the previous memory back as it was; the foreign file stays where it is.
    runCommands(commands);
    for (const [x, hash] of Object.entries(s.files)) expect(sha(`${s.live}${x}`), `state.db${x}`).toBe(hash);
    expect(fs.readdirSync(q)).toEqual([]);
    expect(fs.readFileSync(partial, "utf-8")).toBe("fichier d'un autre programme\n");
    // Pasted a second time, the same lines leave the old memory where it is (nothing was ever placed here, so
    // nothing may go aside now: what is at the target is the old memory itself).
    const back = filesOf(automaton);
    runCommands(commands);
    expect(filesOf(automaton)).toEqual(back);
    expect(fs.readdirSync(automaton).filter((f) => f.includes(".echec-"))).toEqual([]);
  });

  it("exits 1 when the placed file is not the copy or a -wal appears beside it, and the printed commands move it aside with its -wal before the old files return", async () => {
    const { restaurer } = await import(pathToFileURL(RESTAURATION).href);
    const realRename = fs.renameSync;
    const cases: Array<{ after: (target: string) => void; message: string; aside: string[] }> = [
      { after: (target) => fs.appendFileSync(target, Buffer.alloc(16)), message: "La base restaurée n'a pas l'empreinte de la copie.", aside: [""] },
      { after: (target) => fs.writeFileSync(`${target}-wal`, "journal d'un programme qui a ouvert la base"), message: "Un fichier -wal est apparu à côté de la base restaurée", aside: ["", "-wal"] },
    ];
    for (const c of cases) {
      const s = laterState();
      const fake = fakeSystemctl("inactive");
      const partial = `${s.live}.restauration-partielle`;
      const spy = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
        realRename(from, to);
        if (from === partial) c.after(String(to));
      });
      let r: { value: number; stdout: string; stderr: string };
      try {
        r = await captured(() => restaurer(s.copy, { confirmed: true, getuid: () => 1000, env: { ...process.env, HOME: s.h, SONNI_SYSTEMCTL: fake.bin } }));
      } finally {
        spy.mockRestore();
      }
      expect(r.value, r.stdout + r.stderr).toBe(1);
      expect(r.stderr).toContain(c.message);
      const automaton = path.dirname(s.live);
      const q = path.join(automaton, fs.readdirSync(automaton).filter((f) => f.startsWith("quarantaine-"))[0]);
      expect(lastLine(r.stdout)).toBe(`RÉSULTAT : code=1 cible=modifiée quarantaine=${q}`);
      expect(r.stderr).toContain(`  - ${s.live} : base restaurée NON conforme, à déplacer avant de remettre l'ancienne`);
      for (const [x, hash] of Object.entries(s.files)) expect(sha(path.join(q, `state.db${x}`)), `state.db${x}`).toBe(hash);
      const placed = Object.fromEntries(c.aside.map((x) => [x, sha(`${s.live}${x}`)]));

      runCommands(commandsAfter(r.stderr, "Pour remettre l'ancienne mémoire"));
      // The previous files are back, byte for byte, and what the failed restore left went aside together.
      for (const [x, hash] of Object.entries(s.files)) expect(sha(`${s.live}${x}`), `state.db${x}`).toBe(hash);
      for (const [x, hash] of Object.entries(placed)) expect(sha(`${s.live}.echec-${stampOf(q)}${x}`), `state.db.echec${x}`).toBe(hash);
      expect(fs.readdirSync(q)).toEqual([]);
    }
  });

  it("refuses a corrupted copy (exit 1) before moving anything", () => {
    const s = laterState();
    corrupt(s.copy);
    fs.writeFileSync(`${s.copy}.sha256`, `${sha(s.copy)}  ${path.basename(s.copy)}\n`);
    const fake = fakeSystemctl("inactive");
    const r = run(RESTAURATION, ["--restaurer", s.copy, "--confirmer", "--cible", s.live], env(s.h, { SONNI_SYSTEMCTL: fake.bin }));
    expect(r.status, r.stdout + r.stderr).toBe(1);
    s.untouched();
  });

  it("with Sonni stopped, moves state.db and its -wal and -shm into a quarantine folder and puts the copy in place; the runtime opens it", () => {
    const s = laterState();
    const copyHash = sha(s.copy);
    const fake = fakeSystemctl("inactive");
    const e = env(s.h, { SONNI_SYSTEMCTL: fake.bin });
    const r = run(RESTAURATION, ["--restaurer", s.copy, "--confirmer", "--cible", s.live], e);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(fs.readFileSync(fake.calls, "utf-8")).toBe("is-active sonni\n");

    const automaton = path.dirname(s.live);
    const quarantines = fs.readdirSync(automaton).filter((f) => f.startsWith("quarantaine-"));
    expect(quarantines).toHaveLength(1);
    expect(quarantines[0]).toMatch(/^quarantaine-\d{8}T\d{6}Z$/);
    const q = path.join(automaton, quarantines[0]);
    expect(mode(q)).toBe(0o700);
    // Moved, never deleted: the previous files are in the quarantine, byte for byte.
    expect(fs.readdirSync(q).sort()).toEqual(["state.db", "state.db-shm", "state.db-wal"]);
    for (const [x, hash] of Object.entries(s.files)) expect(sha(path.join(q, `state.db${x}`)), `state.db${x}`).toBe(hash);
    // The target is the copy, alone, private.
    expect(sha(s.live)).toBe(copyHash);
    expect(mode(s.live)).toBe(0o600);
    expect(sidecars(s.live)).toEqual([]);
    expect(fs.existsSync(`${s.live}.restauration-partielle`)).toBe(false);
    expect(fs.readdirSync(automaton).sort()).toEqual(["predeploiement", quarantines[0], "state.db"].sort());
    expect(sha(s.copy)).toBe(copyHash);
    expect(fs.readdirSync(e.TMPDIR!)).toEqual([]);
    expect(r.stdout).toContain(`Ancienne mémoire mise de côté dans ${q} (rien n'a été supprimé)`);
    // Next steps: an old version, or going back on the code, means no start yet (the guide's verified pause), then the start and the post-start
    // check as the guide runs it (as the sonni user, with the expected version).
    const steps = r.stdout.slice(r.stdout.indexOf("Étapes suivantes :"));
    // The start time is noted BEFORE the start, so the check counts what the first broker tick does.
    expect(steps.split("\n").slice(1, 6)).toEqual([
      "  - Si l'ancienne version est installée, ou si tu reviens aussi sur le code : ne démarre pas encore, suis R3 à R6 du guide (pause enregistrée et vérifiée).",
      "  - Seulement si la version approuvée a déjà tourné (étape 9 faite, contrôle après démarrage à code=0, git -C /opt/sonni rev-parse HEAD affiche COMMIT) et que tu la gardes : note l'heure, démarre, puis contrôle après 10 à 15 minutes :",
      "    date -u +%Y-%m-%dT%H:%M:%SZ | tee /root/sonni-demarrage.txt",
      "    systemctl start sonni",
      '    cd /opt/sonni && sudo -u sonni -H node sonni/vps/controle-apres-demarrage.mjs --depuis "$(cat /root/sonni-demarrage.txt)" --commit-attendu COMMIT',
    ]);
    expect(r.stdout).not.toContain("sudo systemctl start sonni");
    expect(r.stdout).not.toMatch(/^\s*node sonni\/vps\/controle-apres-demarrage/m);
    const commands = commandsAfter(r.stdout, "Pour revenir à l'ancienne mémoire");
    expect(r.stdout).toContain(`part de côté sous le nom state.db.restauree-${stampOf(q)}, avec ses fichiers -wal, -shm et -journal`);
    expect(commands.filter((c) => c.endsWith(`&& mv '${quarantines[0]}/state.db-wal' 'state.db-wal')`))).toHaveLength(1);
    expect(commands.join("\n")).not.toMatch(/mv -f/);
    expect(lastLine(r.stdout)).toBe(`RÉSULTAT : code=0 cible=${s.live} quarantaine=${q}`);

    // The runtime opens the restored memory: integrity, the copy's rows (the later price is gone), WAL again.
    const db = createDatabase(s.live);
    try {
      ensureMoneyLabSchema(db.raw);
      ensureTraderSchema(db.raw);
      expect(countsOf(db.raw)).toEqual(s.counts);
      expect(db.raw.prepare("SELECT COUNT(*) AS n FROM trader_prices WHERE ts = ?").get(isoSeconds(hours(200)))).toEqual({ n: 0 });
      expect(db.raw.pragma("journal_mode", { simple: true })).toBe("wal");
    } finally {
      db.close();
    }
  });

  it("rollback after the restored run crashed: the printed commands move its -wal aside, so the old memory comes back whole", () => {
    // Sonni wrote 50 prices after the copy, then stopped cleanly: only state.db exists (no -wal to quarantine).
    const s = stoppedWithCopy();
    const later = createDatabase(s.live);
    for (let i = 0; i < 50; i++) storePrice(later, "BTC", hours(200 + i), 61_000 + i);
    const oldCounts = countsOf(later.raw);
    later.close();
    expect(sidecars(s.live)).toEqual([]);
    const oldHash = sha(s.live);
    const fake = fakeSystemctl("inactive");
    const r = run(RESTAURATION, ["--restaurer", s.copy, "--confirmer", "--cible", s.live], env(s.h, { SONNI_SYSTEMCTL: fake.bin }));
    expect(r.status, r.stdout + r.stderr).toBe(0);

    // The restored Sonni writes 500 prices and is killed: its -wal (holding them) and -shm stay beside state.db.
    const crash = spawnSync(process.execPath, ["-e", `
      const Database = require(${JSON.stringify(path.join(ROOT, "node_modules", "better-sqlite3"))});
      const db = new Database(${JSON.stringify(s.live)});
      db.pragma("journal_mode = WAL");
      db.pragma("wal_autocheckpoint = 0");
      const insert = db.prepare("INSERT INTO trader_prices (asset, ts, price, source) VALUES ('CRASH', ?, ?, 'test')");
      db.transaction(() => { for (let i = 0; i < 500; i++) insert.run(new Date(Date.UTC(2026, 9, 20, 0, 0, i)).toISOString(), 1 + i); })();
      process.kill(process.pid, "SIGKILL");
    `], { encoding: "utf-8" });
    expect(crash.signal, crash.stderr).toBe("SIGKILL");
    expect(sidecars(s.live)).toEqual(["-wal", "-shm"]);

    const automaton = path.dirname(s.live);
    const q = /quarantaine=(.+)$/.exec(lastLine(r.stdout))![1];
    const aside = `${s.live}.restauree-${stampOf(q)}`;
    const commands = commandsAfter(r.stdout, "Pour revenir à l'ancienne mémoire");
    const moveBack = commands.findIndex((c) => c.endsWith(`&& mv '${path.basename(q)}/state.db' 'state.db')`));
    const walAside = commands.findIndex((c) => c.endsWith(`&& mv 'state.db-wal' '${path.basename(aside)}-wal')`));
    expect(moveBack, commands.join("\n")).toBeGreaterThanOrEqual(0);
    expect(walAside, commands.join("\n")).toBeGreaterThanOrEqual(0);
    expect(walAside).toBeLessThan(moveBack);
    // Files an earlier restore-and-rollback cycle put aside under the old fixed name are never touched.
    fs.writeFileSync(`${s.live}.restauree`, "base mise de côté par un cycle précédent");
    fs.writeFileSync(`${s.live}.restauree-wal`, "son journal");
    const earlier = { restauree: sha(`${s.live}.restauree`), wal: sha(`${s.live}.restauree-wal`) };
    runCommands(commands);
    expect(sha(`${s.live}.restauree`)).toBe(earlier.restauree);
    expect(sha(`${s.live}.restauree-wal`)).toBe(earlier.wal);

    // The old memory is back byte for byte with nothing beside it, and opens with all of its rows.
    expect(sha(s.live)).toBe(oldHash);
    expect(sidecars(s.live)).toEqual([]);
    expect(fs.readdirSync(q)).toEqual([]);
    // Pasting the same lines a second time changes nothing (the old memory does not go aside again).
    const after = filesOf(automaton);
    runCommands(commands);
    expect(filesOf(automaton)).toEqual(after);
    const db = createDatabase(s.live);
    try {
      expect(db.raw.pragma("integrity_check", { simple: true })).toBe("ok");
      expect(countsOf(db.raw)).toEqual(oldCounts);
      expect(db.raw.prepare("SELECT COUNT(*) AS n FROM trader_prices WHERE asset = 'CRASH'").get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }
    // The restored run went aside whole: its file and its -wal together still hold what it wrote.
    expect(sidecars(aside)).toEqual(["-wal", "-shm"]);
    const restored = new Database(aside);
    try {
      expect(restored.prepare("SELECT COUNT(*) AS n FROM trader_prices WHERE asset = 'CRASH'").get()).toEqual({ n: 500 });
    } finally {
      restored.close();
    }
  });

  it("the printed commands never overwrite: with the stamped aside name taken, nothing moves; once it is free, the same lines finish", async () => {
    const { restaurer } = await import(pathToFileURL(RESTAURATION).href);
    const { stamp } = await import(pathToFileURL(SAUVEGARDE).href);
    const s = laterState();
    const fake = fakeSystemctl("inactive");
    const at = new Date("2026-10-10T15:30:05Z");
    const r = await captured(() => restaurer(s.copy, { confirmed: true, cible: s.live, now: () => at, getuid: () => 1000, env: { ...process.env, HOME: s.h, SONNI_SYSTEMCTL: fake.bin } }));
    expect(r.value, r.stdout + r.stderr).toBe(0);
    const automaton = path.dirname(s.live);
    const q = path.join(automaton, `quarantaine-${stamp(at)}`);
    const aside = `${s.live}.restauree-${stamp(at)}`;
    expect(lastLine(r.stdout)).toBe(`RÉSULTAT : code=0 cible=${s.live} quarantaine=${q}`);
    const commands = commandsAfter(r.stdout, "Pour revenir à l'ancienne mémoire");
    // The restored run wrote a journal beside the restored file; something else already holds the aside name.
    fs.writeFileSync(`${s.live}-wal`, "journal du lancement restauré");
    fs.writeFileSync(aside, "fichier qui porte déjà ce nom");
    const before = { here: filesOf(automaton), quarantine: filesOf(q) };
    runCommands(commands);
    // Nothing moved: the restored file keeps its journal, the old -wal does not land beside it, nothing is lost.
    expect(filesOf(automaton)).toEqual(before.here);
    expect(filesOf(q)).toEqual(before.quarantine);
    expect(sha(path.join(q, "state.db-wal"))).toBe(s.files["-wal"]);

    // Only the journal's aside name is taken: the restored file goes aside, but its journal cannot follow, so the
    // old database must not return (SQLite would replay the restored run's journal into it).
    fs.renameSync(aside, `${s.live}.autre`);
    fs.writeFileSync(`${aside}-wal`, "autre journal qui porte déjà ce nom");
    const restoredHash = sha(s.live);
    runCommands(commands);
    expect(fs.existsSync(s.live)).toBe(false);
    expect(sha(aside)).toBe(restoredHash);
    expect(fs.readFileSync(`${s.live}-wal`, "utf-8")).toBe("journal du lancement restauré");
    expect(filesOf(q)).toEqual(before.quarantine);

    // Every name freed, the same lines move the journal aside and bring the old memory back.
    fs.renameSync(`${aside}-wal`, `${s.live}.autre-wal`);
    runCommands(commands);
    for (const [x, hash] of Object.entries(s.files)) expect(sha(`${s.live}${x}`), `state.db${x}`).toBe(hash);
    expect(sha(aside)).toBe(restoredHash);
    expect(fs.readFileSync(`${aside}-wal`, "utf-8")).toBe("journal du lancement restauré");
    expect(fs.readdirSync(q)).toEqual([]);
  });

  it("run as root without --cible, refuses (exit 2): the default target would be root's own ~/.automaton, not Sonni's memory", async () => {
    const { restaurer } = await import(pathToFileURL(RESTAURATION).href);
    const s = laterState();
    const fake = fakeSystemctl("inactive");
    // root's home, where configure.mjs or the CLI once run as root left a database of their own.
    const rootHome = home();
    const rootDb = path.join(rootHome, ".automaton", "state.db");
    fs.copyFileSync(s.copy, rootDb);
    const rootHash = sha(rootDb);
    const r = await captured(() => restaurer(s.copy, { confirmed: true, getuid: () => 0, env: { ...process.env, HOME: rootHome, SONNI_SYSTEMCTL: fake.bin } }));
    expect(r.value, r.stdout + r.stderr).toBe(2);
    expect(r.stderr).toContain(`Refusé : tu lances la restauration en root, sans --cible : la cible serait ${rootDb}, pas la mémoire de Sonni.`);
    expect(r.stderr).toContain("cd /opt/sonni && sudo -u sonni -H node sonni/vps/restauration.mjs --restaurer COPIE --confirmer");
    expect(lastLine(r.stdout)).toBe("RÉSULTAT : code=2 cible=inchangée quarantaine=aucune");
    expect(fs.readdirSync(path.join(rootHome, ".automaton"))).toEqual(["state.db"]);
    expect(sha(rootDb)).toBe(rootHash);
    expect(fs.existsSync(fake.calls)).toBe(false);
    s.untouched();
  });

  it("run as root with --cible, gives the restored file and the quarantine to the owner of the target's folder, also when no database was there", async () => {
    const { restaurer } = await import(pathToFileURL(RESTAURATION).href);
    const chowns: Array<[string, number, number]> = [];
    // The owner is changed through a descriptor opened without following links (fchown): its path is read back.
    const spy = vi.spyOn(fs, "fchownSync").mockImplementation((fd, uid, gid) => { chowns.push([fs.readlinkSync(`/proc/self/fd/${fd}`), Number(uid), Number(gid)]); });
    try {
      // A database in place: it goes to the quarantine, which belongs to the folder's owner like the restored file.
      const s = laterState();
      const fake = fakeSystemctl("inactive");
      const e = { ...process.env, HOME: s.h, SONNI_SYSTEMCTL: fake.bin };
      const automaton = path.dirname(s.live);
      const folder = fs.statSync(automaton);
      const r1 = await captured(() => restaurer(s.copy, { confirmed: true, cible: s.live, getuid: () => 0, env: e }));
      expect(r1.value, r1.stdout + r1.stderr).toBe(0);
      const q = /quarantaine=(.+)$/.exec(lastLine(r1.stdout))![1];
      expect(chowns).toEqual([[q, folder.uid, folder.gid], [`${s.live}.restauration-partielle`, folder.uid, folder.gid]]);

      // No database there (--sans-base-actuelle): the restored file still goes to the folder's owner, not root.
      chowns.length = 0;
      const empty = path.join(tmp("sonni-deploy-empty-"), ".automaton");
      fs.mkdirSync(empty, { mode: 0o700 });
      const target = path.join(empty, "state.db");
      const r2 = await captured(() => restaurer(s.copy, { confirmed: true, cible: target, sansBaseActuelle: true, getuid: () => 0, env: e }));
      expect(r2.value, r2.stdout + r2.stderr).toBe(0);
      const owner = fs.statSync(empty);
      expect(chowns).toEqual([[`${target}.restauration-partielle`, owner.uid, owner.gid]]);
      expect(sha(target)).toBe(sha(s.copy));

      // Not root: nothing is given away.
      chowns.length = 0;
      fs.renameSync(target, `${target}.vu`);
      const r3 = await captured(() => restaurer(s.copy, { confirmed: true, cible: target, sansBaseActuelle: true, getuid: () => 1000, env: e }));
      expect(r3.value, r3.stdout + r3.stderr).toBe(0);
      expect(chowns).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it("as root, never follows a link swapped in for the partial file: the linked file keeps its mode and owner", async () => {
    const { restaurer } = await import(pathToFileURL(RESTAURATION).href);
    const s = laterState();
    const fake = fakeSystemctl("inactive");
    const e = { ...process.env, HOME: s.h, SONNI_SYSTEMCTL: fake.bin };
    // A file the sonni user must never get: a process of that user swaps the partial copy for a link to it.
    const secret = path.join(tmp("sonni-deploy-secret-"), "secret");
    fs.writeFileSync(secret, "racine seulement");
    fs.chmodSync(secret, 0o640);
    // The swap happens in the window between the copy and the change of owner: just before the script opens the
    // partial file to secure it.
    const realOpen = fs.openSync;
    const copySpy = vi.spyOn(fs, "openSync").mockImplementation(function (this: unknown, file: fs.PathLike, flags?: fs.OpenMode, mode?: fs.Mode | null) {
      if (String(file).endsWith(".restauration-partielle") && typeof flags === "number" && (flags & fs.constants.O_NOFOLLOW)) {
        fs.unlinkSync(file);
        fs.symlinkSync(secret, file);
      }
      return realOpen.call(fs, file, flags, mode);
    } as typeof fs.openSync);
    const chowned: string[] = [];
    const chownSpy = vi.spyOn(fs, "fchownSync").mockImplementation((fd) => { chowned.push(fs.readlinkSync(`/proc/self/fd/${fd}`)); });
    try {
      const r = await captured(() => restaurer(s.copy, { confirmed: true, cible: s.live, getuid: () => 0, env: e }));
      expect(r.value, r.stdout + r.stderr).not.toBe(0);
      expect(mode(secret)).toBe(0o640);
      expect(fs.readFileSync(secret, "utf-8")).toBe("racine seulement");
      // Only the quarantine folder this run created was given to the folder's owner: never the linked file.
      expect(chowned).not.toContain(fs.realpathSync(secret));
      expect(chowned.every((f) => path.basename(f).startsWith("quarantaine-"))).toBe(true);
      // The old memory is in the quarantine and the printed commands put it back.
      expect(r.stdout + r.stderr).toMatch(/quarantaine-/);
    } finally {
      copySpy.mockRestore();
      chownSpy.mockRestore();
    }
  });

  it("refuses a target with no database in place (exit 2) unless --sans-base-actuelle, which a database in place refuses", () => {
    const s = stoppedWithCopy();
    const fake = fakeSystemctl("inactive");
    const e = env(s.h, { SONNI_SYSTEMCTL: fake.bin });
    const dir = path.join(tmp("sonni-deploy-empty-"), ".automaton");
    fs.mkdirSync(dir, { mode: 0o700 });
    const target = path.join(dir, "state.db");
    const r1 = run(RESTAURATION, ["--restaurer", s.copy, "--confirmer", "--cible", target], e);
    expect(r1.status, r1.stdout + r1.stderr).toBe(2);
    expect(r1.stderr).toContain(`Refusé : aucune base en place à ${target}, donc rien à mettre de côté : c'est sans doute le mauvais chemin`);
    expect(r1.stderr).toContain("relance avec --sans-base-actuelle");
    expect(lastLine(r1.stdout)).toBe("RÉSULTAT : code=2 cible=inchangée quarantaine=aucune");
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(fs.existsSync(fake.calls)).toBe(false);

    const r2 = run(RESTAURATION, ["--restaurer", s.copy, "--confirmer", "--cible", target, "--sans-base-actuelle"], e);
    expect(r2.status, r2.stdout + r2.stderr).toBe(0);
    expect(r2.stdout).toContain("Aucune base n'était en place : rien à mettre de côté.");
    expect(lastLine(r2.stdout)).toBe(`RÉSULTAT : code=0 cible=${target} quarantaine=aucune`);
    expect(fs.readdirSync(dir)).toEqual(["state.db"]);
    expect(sha(target)).toBe(sha(s.copy));
    expect(mode(target)).toBe(0o600);

    const liveHash = sha(s.live);
    const r3 = run(RESTAURATION, ["--restaurer", s.copy, "--confirmer", "--cible", s.live, "--sans-base-actuelle"], e);
    expect(r3.status, r3.stdout + r3.stderr).toBe(2);
    expect(r3.stderr).toContain(`Refusé : --sans-base-actuelle, mais une base est en place à ${s.live}. Retire --sans-base-actuelle`);
    expect(sha(s.live)).toBe(liveHash);
    expect(fs.readdirSync(path.dirname(s.live)).sort()).toEqual(["predeploiement", "state.db"]);

    const r4 = run(RESTAURATION, ["--essai", s.copy, "--sans-base-actuelle"], e);
    expect(r4.status).toBe(2);
    expect(r4.stderr).toContain("ne servent qu'avec --restaurer");
  });

  it("refuses when anything sits at the partial file's name, a dangling symbolic link included (exit 2), before moving anything", () => {
    const s = laterState();
    const partial = `${s.live}.restauration-partielle`;
    const elsewhere = path.join(tmp("sonni-deploy-elsewhere-"), "absent");
    fs.symlinkSync(elsewhere, partial);
    expect(fs.existsSync(partial)).toBe(false);
    const fake = fakeSystemctl("inactive");
    const r = run(RESTAURATION, ["--restaurer", s.copy, "--confirmer", "--cible", s.live], env(s.h, { SONNI_SYSTEMCTL: fake.bin }));
    expect(r.status, r.stdout + r.stderr).toBe(2);
    expect(r.stderr).toContain(`Refusé : ${partial} existe déjà (fichier ou lien, reste d'une restauration interrompue ?)`);
    expect(lastLine(r.stdout)).toBe("RÉSULTAT : code=2 cible=inchangée quarantaine=aucune");
    expect(fs.lstatSync(partial).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(elsewhere)).toBe(false);
    expect(fs.existsSync(fake.calls)).toBe(false);
    s.untouched();
  });

  it("restores with umask 077: the partial file is created 600 even from a 644 copy, the quarantine 700", () => {
    const s = laterState();
    fs.chmodSync(s.copy, 0o644);
    const fake = fakeSystemctl("inactive");
    const r = runObserved(RESTAURATION, ["--restaurer", s.copy, "--confirmer", "--cible", s.live], env(s.h, { SONNI_SYSTEMCTL: fake.bin }));
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stderr).toContain("OBSERVE umask 77\n");
    const q = /quarantaine=(.+)$/.exec(lastLine(r.stdout))![1];
    expect(r.stderr).toContain(`OBSERVE avant-chmod ${q} 700\n`);
    expect(r.stderr).toContain(`OBSERVE avant-chmod ${s.live}.restauration-partielle 600\n`);
    expect(mode(s.live)).toBe(0o600);
    expect(sha(s.live)).toBe(sha(s.copy));
  });
});
