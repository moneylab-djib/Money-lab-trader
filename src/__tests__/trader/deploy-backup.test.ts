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
    if (!/^  (mv |\[ -e )/.test(l)) break;
    out.push(l.trim());
  }
  return out;
}
/** Runs the printed commands as the owner would paste them into a shell. */
function runCommands(commands: string[]) {
  const r = spawnSync("sh", ["-c", commands.join("\n")], { encoding: "utf-8" });
  expect(r.stderr).toBe("");
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
    expect(r.stdout).toContain("Mode : à chaud (Sonni en marche)");
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
    expect(lines).toContain("Mode : à chaud (Sonni en marche)");
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
    const realCopy = fs.copyFileSync;
    const cases: Array<{ during: (to: string) => void; message: string }> = [
      { during: () => fs.appendFileSync(live, Buffer.alloc(16)), message: "La base a changé pendant la copie" },
      { during: (to) => fs.appendFileSync(to, Buffer.alloc(16)), message: "La base a changé pendant la copie" },
      { during: () => fs.writeFileSync(`${live}-wal`, ""), message: "Sonni a démarré pendant la copie" },
    ];
    for (const c of cases) {
      const spy = vi.spyOn(fs, "copyFileSync").mockImplementation((from, to, flags) => {
        realCopy(from, to, flags);
        if (from === live) c.during(String(to));
      });
      const dossier = path.join(tmp("sonni-deploy-out-"), "copies");
      const lines: string[] = [];
      let r: { code: number };
      try {
        r = await sauvegarde({ source: live, dossier, env: { HOME: h }, say: (l = "") => lines.push(l), warn: (l: string) => lines.push(l) });
      } finally {
        spy.mockRestore();
      }
      expect(r.code, lines.join("\n")).toBe(1);
      expect(lines).toContain("Mode : à froid (Sonni arrêté)");
      expect(lines.join("\n")).toContain(c.message);
      expect(lines.at(-1)).toBe("RÉSULTAT : code=1 copie=aucune");
      expect(fs.readdirSync(dossier)).toEqual([]);
    }
    // The -wal the test wrote is not the script's: it stays.
    expect(fs.existsSync(`${live}-wal`)).toBe(true);
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

  it("refuses while systemd says Sonni runs (exit 2), and without systemd unless --sans-systemd", () => {
    const s = laterState();
    for (const state of ["active", "activating", "reloading", "deactivating"]) {
      const fake = fakeSystemctl(state);
      const r = run(RESTAURATION, ["--restaurer", s.copy, "--confirmer"], env(s.h, { SONNI_SYSTEMCTL: fake.bin }));
      expect(r.status, state).toBe(2);
      expect(r.stderr).toContain("Sonni tourne : arrête-le d'abord (systemctl stop sonni)");
      expect(fs.readFileSync(fake.calls, "utf-8")).toBe("is-active sonni\n");
      s.untouched();
    }
    // An answer that says neither "running" nor "stopped" is not taken as stopped.
    for (const state of ["unknown", ""]) {
      const fake = fakeSystemctl(state);
      const r = run(RESTAURATION, ["--restaurer", s.copy, "--confirmer"], env(s.h, { SONNI_SYSTEMCTL: fake.bin }));
      expect(r.status, state).toBe(2);
      expect(r.stderr).toContain(`Refusé : état de Sonni inattendu (« ${state || "vide"} »)`);
      expect(lastLine(r.stdout)).toBe("RÉSULTAT : code=2 cible=inchangée quarantaine=aucune");
      s.untouched();
    }
    const missing = env(s.h, { SONNI_SYSTEMCTL: path.join(tmp("sonni-deploy-nosystemd-"), "systemctl") });
    const r = run(RESTAURATION, ["--restaurer", s.copy, "--confirmer"], missing);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("--sans-systemd");
    s.untouched();
    const r2 = run(RESTAURATION, ["--restaurer", s.copy, "--confirmer", "--sans-systemd"], missing);
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
    const r1 = run(RESTAURATION, ["--restaurer", s.copy, "--confirmer"], e);
    expect(r1.status).toBe(1);
    expect(r1.stderr).toContain("Empreinte SHA-256 différente");
    s.untouched();
    fs.rmSync(shaFile);
    const r2 = run(RESTAURATION, ["--restaurer", s.copy, "--confirmer"], e);
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

  it("on a failure after the move (a foreign partial file appears), exits 3, keeps the quarantine and prints how to put the old files back", () => {
    const s = laterState();
    const partial = `${s.live}.restauration-partielle`;
    // Another program creates the partial file between the checks and the copy (here: while systemd is asked).
    const fake = fakeSystemctl("inactive", `echo "fichier d'un autre programme" > '${partial}'`);
    const r = run(RESTAURATION, ["--restaurer", s.copy, "--confirmer"], env(s.h, { SONNI_SYSTEMCTL: fake.bin }));
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
    for (const x of ["", "-wal", "-shm"]) {
      expect(r.stderr).toContain(`  - ${s.live}${x} est maintenant ${path.join(q, `state.db${x}`)} (intact)`);
      expect(r.stderr).toContain(`  mv '${path.join(q, `state.db${x}`)}' '${s.live}${x}'`);
    }
    expect(r.stderr).toContain(`Le dossier ${q} n'a pas été supprimé.`);
    expect(fs.existsSync(s.live)).toBe(false);

    // The printed commands put the previous memory back as it was.
    runCommands(commandsAfter(r.stderr, "Pour remettre l'ancienne mémoire"));
    for (const [x, hash] of Object.entries(s.files)) expect(sha(`${s.live}${x}`), `state.db${x}`).toBe(hash);
    expect(fs.readdirSync(q)).toEqual([]);
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
        r = await captured(() => restaurer(s.copy, { confirmed: true, env: { ...process.env, HOME: s.h, SONNI_SYSTEMCTL: fake.bin } }));
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
      for (const [x, hash] of Object.entries(placed)) expect(sha(`${s.live}.echec${x}`), `state.db.echec${x}`).toBe(hash);
      expect(fs.readdirSync(q)).toEqual([]);
    }
  });

  it("refuses a corrupted copy (exit 1) before moving anything", () => {
    const s = laterState();
    corrupt(s.copy);
    fs.writeFileSync(`${s.copy}.sha256`, `${sha(s.copy)}  ${path.basename(s.copy)}\n`);
    const fake = fakeSystemctl("inactive");
    const r = run(RESTAURATION, ["--restaurer", s.copy, "--confirmer"], env(s.h, { SONNI_SYSTEMCTL: fake.bin }));
    expect(r.status, r.stdout + r.stderr).toBe(1);
    s.untouched();
  });

  it("with Sonni stopped, moves state.db and its -wal and -shm into a quarantine folder and puts the copy in place; the runtime opens it", () => {
    const s = laterState();
    const copyHash = sha(s.copy);
    const fake = fakeSystemctl("inactive");
    const e = env(s.h, { SONNI_SYSTEMCTL: fake.bin });
    const r = run(RESTAURATION, ["--restaurer", s.copy, "--confirmer"], e);
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
    expect(r.stdout).toContain("sudo systemctl start sonni");
    expect(r.stdout).toContain("controle-apres-demarrage.mjs --depuis");
    expect(r.stdout).toContain(`mv '${path.join(q, "state.db-wal")}' '${s.live}-wal'`);
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
    const r = run(RESTAURATION, ["--restaurer", s.copy, "--confirmer"], env(s.h, { SONNI_SYSTEMCTL: fake.bin }));
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

    const commands = commandsAfter(r.stdout, "Pour revenir à l'ancienne mémoire");
    const moveBack = commands.findIndex((c) => c.startsWith("mv '") && c.endsWith(`'${s.live}'`));
    const walAside = commands.findIndex((c) => c.includes(`mv -f '${s.live}-wal' '${s.live}.restauree-wal'`));
    expect(walAside, commands.join("\n")).toBeGreaterThanOrEqual(0);
    expect(walAside).toBeLessThan(moveBack);
    runCommands(commands);

    // The old memory is back byte for byte with nothing beside it, and opens with all of its rows.
    expect(sha(s.live)).toBe(oldHash);
    expect(sidecars(s.live)).toEqual([]);
    const db = createDatabase(s.live);
    try {
      expect(db.raw.pragma("integrity_check", { simple: true })).toBe("ok");
      expect(countsOf(db.raw)).toEqual(oldCounts);
      expect(db.raw.prepare("SELECT COUNT(*) AS n FROM trader_prices WHERE asset = 'CRASH'").get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }
    // The restored run went aside whole: its file and its -wal together still hold what it wrote.
    expect(sidecars(`${s.live}.restauree`)).toEqual(["-wal", "-shm"]);
    const restored = new Database(`${s.live}.restauree`);
    try {
      expect(restored.prepare("SELECT COUNT(*) AS n FROM trader_prices WHERE asset = 'CRASH'").get()).toEqual({ n: 500 });
    } finally {
      restored.close();
    }
  });
});
