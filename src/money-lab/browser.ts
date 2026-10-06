/**
 * Money Lab interactive browser
 *
 * One headless Chrome session the agent drives step by step (open, click,
 * fill, read, screenshot) on its own server, with its own profile under
 * ~/.money-lab/browser-profile: no owner cookies or accounts. The session
 * closes itself after a few idle minutes.
 */

import fs from "fs";
import path from "path";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { findBrowser, scrubbedEnv } from "./selfhosted.js";

const IDLE_CLOSE_MS = 10 * 60_000;
const ACTION_TIMEOUT_MS = 15_000;
const TEXT_LIMIT = 4000;

let context: BrowserContext | null = null;
let page: Page | null = null;
let idleTimer: ReturnType<typeof setTimeout> | undefined;

function home(): string {
  return process.env.HOME || "/root";
}

async function getPage(): Promise<Page> {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => void closeBrowser(), IDLE_CLOSE_MS);
  idleTimer.unref?.();
  if (page && !page.isClosed()) return page;
  const executablePath = findBrowser();
  if (!executablePath) throw new Error("No headless browser on this server. Ask the owner to install Google Chrome.");
  if (!context) {
    const profile = path.join(home(), ".money-lab", "browser-profile");
    fs.mkdirSync(profile, { recursive: true });
    context = await chromium.launchPersistentContext(profile, {
      executablePath,
      headless: true,
      // The profile persists: keep its cache from filling the disk.
      args: ["--no-sandbox", "--disable-gpu", "--disk-cache-size=52428800"],
      viewport: { width: 1280, height: 900 },
      // The browser never needs the runtime's keys.
      env: scrubbedEnv() as Record<string, string>,
    });
    context.on("close", () => {
      context = null;
      page = null;
    });
  }
  page = context.pages()[0] ?? (await context.newPage());
  page.setDefaultTimeout(ACTION_TIMEOUT_MS);
  return page;
}

export async function closeBrowser(): Promise<void> {
  if (idleTimer) clearTimeout(idleTimer);
  const current = context;
  context = null;
  page = null;
  await current?.close().catch(() => undefined);
}

async function describe(p: Page, withText = true): Promise<string> {
  const title = await p.title().catch(() => "");
  const lines = [`URL: ${p.url()}`, `Title: ${title}`];
  if (withText) {
    const text = (await p.evaluate(() => document.body?.innerText ?? "").catch(() => "")).replace(/\n{3,}/g, "\n\n").trim();
    lines.push(`Visible text${text.length > TEXT_LIMIT ? ` (first ${TEXT_LIMIT} chars)` : ""}:\n${text.slice(0, TEXT_LIMIT)}`);
  }
  return lines.join("\n");
}

/** Interactive elements with a selector the agent can pass back to click/fill. */
async function listElements(p: Page): Promise<string> {
  const items = await p.evaluate(() => {
    const out: string[] = [];
    const nodes = Array.from(document.querySelectorAll("a[href], button, input, textarea, select, [role=button]")).slice(0, 80);
    for (const el of nodes) {
      const e = el as HTMLElement & { name?: string; type?: string; placeholder?: string; value?: string };
      const tag = e.tagName.toLowerCase();
      const label = (e.innerText || e.getAttribute("aria-label") || e.placeholder || e.value || "").trim().replace(/\s+/g, " ").slice(0, 60);
      const selector = e.id
        ? `#${CSS.escape(e.id)}`
        : e.getAttribute("name")
          ? `${tag}[name="${e.getAttribute("name")}"]`
          : label && (tag === "a" || tag === "button")
            ? `${tag}:has-text("${label.replace(/"/g, "'")}")`
            : "";
      if (!selector) continue;
      const type = tag === "input" ? `[${e.type || "text"}]` : "";
      out.push(`${tag}${type} ${selector}${label ? ` — ${label}` : ""}`);
    }
    return out;
  });
  return items.length ? `Interactive elements:\n${items.join("\n")}` : "No interactive elements found.";
}

export interface BrowseArgs {
  action: string;
  url?: string;
  selector?: string;
  value?: string;
  key?: string;
}

/** Runs one browser action and returns what the agent should see next. */
export async function browse(args: BrowseArgs): Promise<string> {
  if (args.action === "close") {
    await closeBrowser();
    return "Browser closed.";
  }
  const p = await getPage();
  switch (args.action) {
    case "goto": {
      const url = new URL(String(args.url ?? ""));
      if (url.protocol !== "http:" && url.protocol !== "https:") return "Only http(s) URLs can be opened.";
      await p.goto(url.toString(), { waitUntil: "domcontentloaded" });
      await p.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
      return await describe(p);
    }
    case "click":
      if (!args.selector) return "click needs a selector (see action: elements).";
      await p.click(args.selector);
      await p.waitForLoadState("domcontentloaded").catch(() => undefined);
      return await describe(p);
    case "fill":
      if (!args.selector) return "fill needs a selector (see action: elements).";
      await p.fill(args.selector, String(args.value ?? ""));
      return `Filled ${args.selector}.\n${await describe(p, false)}`;
    case "select":
      if (!args.selector) return "select needs a selector.";
      await p.selectOption(args.selector, String(args.value ?? ""));
      return `Selected "${args.value}" in ${args.selector}.\n${await describe(p, false)}`;
    case "press":
      await p.keyboard.press(String(args.key ?? "Enter"));
      await p.waitForLoadState("domcontentloaded").catch(() => undefined);
      return await describe(p);
    case "text":
      return args.selector
        ? `Text of ${args.selector}:\n${(await p.innerText(args.selector)).slice(0, TEXT_LIMIT)}`
        : await describe(p);
    case "elements":
      return `${await describe(p, false)}\n${await listElements(p)}`;
    case "screenshot": {
      const dir = path.join(home(), ".money-lab", "screenshots");
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${Date.now()}-browser.png`);
      await p.screenshot({ path: file });
      return `${await describe(p, false)}\nScreenshot attached below.\n[[image:${file}]]`;
    }
    default:
      return "Unknown action. Use goto, elements, click, fill, select, press, text, screenshot or close.";
  }
}
