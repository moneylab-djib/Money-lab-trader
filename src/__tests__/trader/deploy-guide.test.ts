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
    for (const script of ["verification-environnement.mjs", "sauvegarde.mjs", "restauration.mjs", "controle-predeploiement.mjs", "controle-apres-demarrage.mjs",
      "envoi-telegram.mjs", "verifier-pause.mjs"]) {
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

  it("runs every tool from /opt/sonni or from the isolated tools folder, and the pre-install tools only from the isolated one", () => {
    for (const block of section.split("```sh").slice(1).map((b) => b.split("```")[0])) {
      if (!/node sonni\/vps\//.test(block)) continue;
      const isolated = block.includes("cd /home/sonni/outils-deploiement");
      expect(isolated || block.includes("cd /opt/sonni"), block).toBe(true);
      // Before the install (Phase 2) and during a rollback, /opt/sonni holds the old version, which lacks these tools.
      if (/node sonni\/vps\/(verification-environnement|sauvegarde|restauration|controle-predeploiement|verifier-pause)\.mjs/.test(block)) expect(isolated, block).toBe(true);
    }
  });

  it("extracts the tools of the approved commit into a private folder, linked to Sonni's own SQLite library, without installing anything", () => {
    expect(section).toContain("sudo -u sonni -H git cat-file -e COMMIT^{commit}");
    expect(section).toContain("sudo -u sonni -H mkdir -m 700 /home/sonni/outils-deploiement");
    expect(section).toContain("sudo -u sonni -H sh -c 'git -C /opt/sonni archive COMMIT sonni/vps | tar -x -C /home/sonni/outils-deploiement'");
    expect(section).toContain("sudo -u sonni -H ln -s /opt/sonni/node_modules /home/sonni/outils-deploiement/node_modules");
  });

  it("pins the approved commit and never runs configure.mjs or a bare git pull in the procedure", () => {
    expect(section).toContain("git merge --ff-only COMMIT");
    expect(section).not.toMatch(/^\s*sudo -u sonni -H git pull/m);
    expect(section).not.toMatch(/^\s*sudo -u sonni -H node sonni\/vps\/configure\.mjs/m);
  });

  it("backs up, drills and checks before anything is installed, built or checked out, and starts last", () => {
    const at = (needle: string, from = 0) => {
      const i = section.indexOf(needle, from);
      expect(i, needle).toBeGreaterThan(-1);
      return i;
    };
    const phase2 = at("### Phase 2");
    const phase3 = at("### Phase 3");
    const step = [
      at("git rev-parse HEAD | tee /root/sonni-commit-avant.txt", phase2),
      at("archive COMMIT sonni/vps", phase2),
      at("node sonni/vps/verification-environnement.mjs", phase2),
      at("systemctl stop sonni", phase2),
      at("node sonni/vps/sauvegarde.mjs", phase2),
      at("node sonni/vps/restauration.mjs --essai COPIE", phase2),
      at("node sonni/vps/controle-predeploiement.mjs COPIE", phase2),
      at("git checkout main", phase2),
      at("git merge --ff-only COMMIT", phase2),
      at("pnpm install --frozen-lockfile", phase2), // Phase 1 also installs, on the owner's PC
      at("pnpm run build", phase2),
      at("systemctl start sonni", phase2),
      at("node sonni/vps/controle-apres-demarrage.mjs", phase2),
    ];
    for (let i = 1; i < step.length; i++) expect(step[i - 1], `step ${i}`).toBeLessThan(step[i]);
    // Nothing in Phase 2 changes /opt/sonni's checkout, dependencies or build before the gate.
    const beforeGate = section.slice(phase2, step[6]);
    for (const change of ["git checkout", "git merge", "git pull", "pnpm install", "pnpm run build", "pnpm add", "npm install"]) expect(beforeGate).not.toContain(change);
    expect(step[11]).toBeLessThan(phase3);
  });

  it("starts the old version only after the pause is recorded and verified by a tool, then checks it running", () => {
    const at = (needle: string, from: number) => {
      const i = section.indexOf(needle, from);
      expect(i, needle).toBeGreaterThan(-1);
      return i;
    };
    const rollback = at("### Retour arrière", 0);
    const stop = at("systemctl stop sonni", rollback);
    const restore = at("node sonni/vps/restauration.mjs --restaurer COPIE --confirmer", rollback);
    const code = at("git checkout --detach", rollback);
    const pause = at("node dist/index.js --money-lab pause", rollback);
    const backup = at("node sonni/vps/sauvegarde.mjs", rollback);
    const verify = at("node sonni/vps/verifier-pause.mjs --copie COPIE_RETOUR", rollback);
    const start = at("systemctl start sonni", code); // the earlier one restarts the NEW version, paused (R4)
    const running = at("node sonni/vps/verifier-pause.mjs --en-marche --depuis", rollback);
    // A restore brings back the copy's pause state: the pause is recorded after it, then checked on a fresh copy while
    // the new version is still installed (so pending buys can still be left to it), and only then is the code rolled back.
    for (const [a, b] of [[stop, restore], [restore, pause], [pause, backup], [backup, verify], [verify, code], [code, start], [start, running]]) {
      expect(a).toBeLessThan(b);
    }
    // The pause CLI of the installed version records the pause. That 4c015b0 and fd5916d have it too was checked by
    // hand (git show <commit>:src/money-lab/cli.ts, docs/research/deploy-prep.md); this test only reads the current one.
    expect(fs.readFileSync(path.join(ROOT, "src", "money-lab", "cli.ts"), "utf-8")).toContain('case "pause"');
    // The rollback no longer sends the owner to /reprendre: it relaunches a paid cycle.
    expect(section.slice(rollback)).not.toMatch(/envoie `\/reprendre`/);
  });
});
