/**
 * The owner runs the controlled deployment from sonni/GUIDE-VPS.fr.md by copying its commands. This test keeps
 * the guide and the scripts in step: every `node sonni/vps/<script>.mjs` command of the guide names a script
 * that exists, every option it passes is one the script reads, and the procedure names every tool it relies on.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

const ROOT = path.resolve(__dirname, "..", "..", "..");
const GUIDE = fs.readFileSync(path.join(ROOT, "sonni", "GUIDE-VPS.fr.md"), "utf-8");

/** The commands of the guide that run a sonni/vps script, with the options they pass. */
function scriptCommands(text: string): { script: string; options: string[]; line: string }[] {
  const out: { script: string; options: string[]; line: string }[] = [];
  for (const line of text.split("\n")) {
    // The Telegram sender runs as root from a root-owned copy (/root/envoi-telegram.mjs) of sonni/vps/envoi-telegram.mjs.
    for (const m of line.matchAll(/node (?:sonni\/vps\/|\/root\/)([a-z-]+\.mjs)([^|`]*)/g)) {
      out.push({ script: m[1], options: [...m[2].matchAll(/(--[a-z][a-z-]*)/g)].map((o) => o[1]), line: line.trim() });
    }
  }
  return out;
}

describe("Controlled deployment guide (sonni/GUIDE-VPS.fr.md) and the sonni/vps scripts", () => {
  const section = GUIDE.slice(GUIDE.indexOf("## Déploiement contrôlé des étapes 0.1 à 0.3"), GUIDE.indexOf("## Arrêter Sonni"));

  it("has the procedure, its phases and the rollback", () => {
    expect(section.length).toBeGreaterThan(1000);
    for (const title of ["### Phase 0", "### Phase 1", "### Phase 2", "### Phase 3", "### Retour arrière"]) expect(section).toContain(title);
  });

  it("names every tool of the procedure", () => {
    const used = new Set(scriptCommands(section).map((c) => c.script));
    for (const script of ["sauvegarde.mjs", "restauration.mjs", "controle-predeploiement.mjs", "controle-apres-demarrage.mjs", "envoi-telegram.mjs"]) {
      expect(used.has(script), script).toBe(true);
    }
  });

  it("runs only scripts that exist, with options they read", () => {
    const commands = scriptCommands(GUIDE);
    expect(commands.length).toBeGreaterThan(8);
    for (const c of commands) {
      const file = path.join(ROOT, "sonni", "vps", c.script);
      expect(fs.existsSync(file), `${c.script} (${c.line})`).toBe(true);
      const source = fs.readFileSync(file, "utf-8");
      // An option is read as "--name", or by name through a small opt("name") helper (configure.mjs).
      for (const option of c.options) expect(source.includes(`"${option}"`) || source.includes(`opt("${option.slice(2)}")`), `${option} in ${c.script} (${c.line})`).toBe(true);
    }
  });

  it("runs the Telegram sender as root only from a root-owned copy whose fingerprint is checked", () => {
    expect(section).toContain("install -o root -g root -m 0500 sonni/vps/envoi-telegram.mjs /root/envoi-telegram.mjs");
    expect(section).toContain("sha256sum /root/envoi-telegram.mjs");
    expect(section).toContain("EMPREINTE_ENVOI");
    expect(section).not.toMatch(/\| node sonni\/vps\/envoi-telegram\.mjs/);
    expect(section.indexOf("sha256sum /root/envoi-telegram.mjs")).toBeLessThan(section.indexOf("| node /root/envoi-telegram.mjs"));
  });

  it("starts every server block that runs a tool from /opt/sonni", () => {
    for (const block of section.split("```sh").slice(1).map((b) => b.split("```")[0])) {
      if (/node sonni\/vps\//.test(block) && !/node sonni\/vps\/(sauvegarde|restauration --essai|restauration\.mjs --essai|controle-predeploiement)/.test(block)) {
        expect(block, block).toContain("cd /opt/sonni");
      }
    }
  });

  it("pins the approved commit and never runs configure.mjs or a bare git pull in the procedure", () => {
    expect(section).toContain("git merge --ff-only COMMIT");
    expect(section).not.toMatch(/^\s*sudo -u sonni -H git pull/m);
    expect(section).not.toMatch(/^\s*sudo -u sonni -H node sonni\/vps\/configure\.mjs/m);
  });

  it("stops Sonni before installing, and backs up, drills and checks before starting", () => {
    const at = (s: string, from = 0) => {
      const i = section.indexOf(s, from);
      expect(i, s).toBeGreaterThan(-1);
      return i;
    };
    const phase2 = at("### Phase 2");
    const stop = at("systemctl stop sonni", phase2);
    const install = at("pnpm install --frozen-lockfile", phase2); // Phase 1 also installs, on the owner's PC
    const backup = at("node sonni/vps/sauvegarde.mjs");
    const drill = at("node sonni/vps/restauration.mjs --essai COPIE");
    const gate = at("node sonni/vps/controle-predeploiement.mjs COPIE");
    const start = at("systemctl start sonni", at("**Démarre :**")); // not the restart of the old version on a refused merge
    const after = at("node sonni/vps/controle-apres-demarrage.mjs");
    expect(stop).toBeLessThan(install);
    expect(install).toBeLessThan(backup);
    expect(backup).toBeLessThan(drill);
    expect(drill).toBeLessThan(gate);
    expect(gate).toBeLessThan(start);
    expect(start).toBeLessThan(after);
  });
});
