/**
 * The counter-verification the owner's Windows agent runs on the PC (sonni/pc/contre-verification.mjs): every
 * deployment tool on fictitious databases, with expected exit codes and messages. Here it runs with Sonni's
 * TypeScript sources instead of dist/ (the build is not part of this check), on this platform. Each case spawns
 * the real script; no network, no inference, no real systemctl.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { createDatabase } from "../../state/database.js";
import { ensureMoneyLabSchema, pause } from "../../money-lab/journal.js";
import { parseTraderConfig } from "../../trader/config.js";
import { ensureTraderSchema } from "../../trader/schema.js";
import { isoSeconds } from "../../trader/prices.js";
import { brokerTick, placeOrder } from "../../trader/portfolio.js";
// @ts-expect-error plain ESM script without type declarations (tests are not type-checked)
import { report, runCounterCheck } from "../../../sonni/pc/contre-verification.mjs";

const ROOT = path.join(__dirname, "..", "..", "..");
const SCRIPT = path.join(ROOT, "sonni", "pc", "contre-verification.mjs");
const API = { createDatabase, ensureMoneyLabSchema, pause, parseTraderConfig, ensureTraderSchema, isoSeconds, brokerTick, placeOrder };

describe("Counter-verification of the deployment tools on fictitious databases (sonni/pc/contre-verification.mjs)", () => {
  it("runs every case as expected, removes its temporary folder and writes a report without its paths", async () => {
    const before = new Set(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("sonni-contre-verif-")));
    const { results, code } = await runCounterCheck({ api: API });
    const ecarts = results.filter((r: { status: string }) => r.status === "ÉCART");
    expect(ecarts, JSON.stringify(ecarts, null, 2)).toEqual([]);
    expect(code).toBe(0);
    expect(results.length).toBeGreaterThanOrEqual(27);
    // Every tool of the procedure is exercised.
    const scripts = new Set(results.map((r: { script: string }) => r.script));
    for (const s of ["audit-prix.mjs", "sauvegarde.mjs", "restauration.mjs", "controle-predeploiement.mjs", "verifier-pause.mjs", "verification-environnement.mjs"]) expect(scripts.has(s), s).toBe(true);
    const after = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("sonni-contre-verif-") && !before.has(n));
    expect(after).toEqual([]);
    const md = report(results, code);
    expect(md).toContain("# Contre-vérification des outils de déploiement (bases fictives)");
    expect(md).toContain("| # | Cas | Outil | Code attendu | Code obtenu | Statut |");
    expect(md).toContain("aucune donnée de production, aucun réseau");
    expect(md).not.toContain(os.tmpdir() + path.sep + "sonni-contre-verif-");
  }, 120_000);

  it("reports a deviation with the command, the problems and the end of the output", () => {
    const md = report([
      { name: "cas fictif", script: "verifier-pause.mjs", args: ["--copie", "<tmp>/copies/x.db"], expect: 0, got: 1, status: "ÉCART", problems: ["code 1 au lieu de 0"], tail: "RÉSULTAT : code=1" },
      { name: "cas Linux", script: "restauration.mjs", args: [], expect: 2, status: "NON APPLICABLE", note: "comportement propre à Linux" },
    ], 1);
    expect(md).toContain("au moins un écart");
    expect(md).toContain("### cas fictif");
    expect(md).toContain("Commande : `node sonni/vps/verifier-pause.mjs --copie <tmp>/copies/x.db`");
    expect(md).toContain("- code 1 au lieu de 0");
    expect(md).toContain("- cas Linux : comportement propre à Linux");
  });

  it("refuses an unknown option (exit 2) and stops with exit 3 when dist/ is missing", () => {
    let r = spawnSync(process.execPath, [SCRIPT, "--inconnue"], { encoding: "utf-8" });
    expect(r.status).toBe(2);
    expect(r.stdout.trimEnd().split("\n").pop()).toBe("RÉSULTAT : code=2 cas=0 ok=0 ecarts=0 non_applicables=0");
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "sonni-sans-dist-"));
    try {
      r = spawnSync(process.execPath, [SCRIPT, "--dist", empty, "--rapport", path.join(empty, "r.md")], { encoding: "utf-8" });
      expect(r.status).toBe(3);
      expect(r.stderr).toContain("pnpm run build");
      expect(fs.existsSync(path.join(empty, "r.md"))).toBe(false);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});
