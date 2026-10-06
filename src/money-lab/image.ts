/**
 * Money Lab image rendering
 *
 * The agent designs an image in HTML/CSS (text, colours, shapes, SVG, its
 * own pictures in ~/images) and the server's Chrome renders it to a PNG or
 * JPEG at the size a network expects: share cards, square posts, stories,
 * banners. Free: no image model, no account. The result is shown back to
 * the agent.
 *
 * The design is served by a short-lived local web server that only serves
 * files really inside ~/images (symbolic links resolved). A page opened
 * from file:// could embed any local file (runtime keys, /proc environment)
 * in the picture; a page served over http cannot. Chrome also runs without
 * the runtime's secrets in its environment.
 */

import fs from "fs";
import http from "http";
import path from "path";
import type { AddressInfo } from "net";
import { chromium } from "playwright-core";
import { isRuntimePath } from "./guard.js";
import { scrubbedEnv } from "./selfhosted.js";

export const IMAGE_PRESETS: Record<string, [number, number]> = {
  og: [1200, 630],
  square: [1080, 1080],
  portrait: [1080, 1350],
  story: [1080, 1920],
  banner: [1500, 500],
};
const NAME = /^[a-z0-9][a-z0-9-]{0,59}$/;
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
  ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".json": "application/json",
};

export function imagesDir(home = process.env.HOME || "/root"): string {
  return path.join(home, "images");
}

export type RenderFn = (url: string, out: string, width: number, height: number, format: "png" | "jpeg") => Promise<void>;

/** Exact-size screenshot (Chrome's own --screenshot leaves a blank band in headless mode). */
export function playwrightRender(browser: string): RenderFn {
  return async (url, out, width, height, format) => {
    const instance = await chromium.launch({
      executablePath: browser,
      headless: true,
      args: ["--no-sandbox", "--disable-gpu"],
      env: scrubbedEnv() as Record<string, string>,
    });
    try {
      const page = await instance.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
      // Slow third-party pages still get a screenshot of what has loaded.
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 });
      await page.waitForLoadState("load", { timeout: 10_000 }).catch(() => undefined);
      await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
      await page.screenshot({
        path: out,
        clip: { x: 0, y: 0, width, height },
        ...(format === "jpeg" ? { type: "jpeg" as const, quality: 85 } : { type: "png" as const }),
      });
    } finally {
      await instance.close();
    }
  };
}

/**
 * Serves only regular files whose real path is inside `root`, on
 * 127.0.0.1 and a random port, until the returned close() is called.
 */
export async function serveDirectory(root: string): Promise<{ url: string; close: () => Promise<void> }> {
  const realRoot = fs.realpathSync(root);
  const server = http.createServer((req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
      const real = fs.realpathSync(path.join(realRoot, path.normalize(pathname)));
      if (!real.startsWith(realRoot + path.sep) || isRuntimePath(real) || !fs.statSync(real).isFile()) throw new Error("refused");
      res.writeHead(200, { "content-type": MIME[path.extname(real).toLowerCase()] ?? "application/octet-stream" });
      fs.createReadStream(real).pipe(res);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}

export async function renderImage(
  input: { name: string; html?: string; file?: string; preset?: string; width?: number; height?: number; format?: string },
  options: { render: RenderFn; home: string },
): Promise<string> {
  if (!NAME.test(input.name)) return "name must be 1-60 lowercase letters, digits or dashes (e.g. og-devis-plombier).";
  const [width, height] = IMAGE_PRESETS[input.preset ?? ""] ?? [Number(input.width), Number(input.height)];
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 100 || height < 100 || width > 3000 || height > 3000) {
    return `Choose a preset (${Object.entries(IMAGE_PRESETS).map(([k, [w, h]]) => `${k} ${w}x${h}`).join(", ")}) or width and height between 100 and 3000.`;
  }
  const format = input.format === "jpeg" || input.format === "jpg" ? "jpeg" : "png";
  const dir = imagesDir(options.home);
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  const realDir = fs.realpathSync(dir);
  let page: string;
  if (input.html) {
    const html = /<html[\s>]/i.test(input.html)
      ? input.html
      : `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:${width}px;height:${height}px;overflow:hidden}</style></head><body>${input.html}</body></html>`;
    fs.writeFileSync(path.join(dir, "src", `${input.name}.html`), html);
    page = `src/${input.name}.html`;
  } else if (input.file) {
    const requested = path.resolve(options.home, input.file.replace(/^~(?=$|\/)/, options.home));
    const real = fs.existsSync(requested) ? fs.realpathSync(requested) : "";
    if (!real.startsWith(realDir + path.sep) || !/\.html?$/i.test(real)) {
      return "file must be an HTML file inside ~/images (e.g. ~/images/src/post.html); put the pictures it uses there too.";
    }
    page = path.relative(realDir, real).split(path.sep).map(encodeURIComponent).join("/");
  } else {
    return "Give html (the design) or file (an HTML file in ~/images).";
  }
  const out = path.join(dir, `${input.name}.${format === "jpeg" ? "jpg" : "png"}`);
  fs.rmSync(out, { force: true });
  const server = await serveDirectory(dir);
  try {
    await options.render(`${server.url}/${page}`, out, width, height, format);
  } catch (err: any) {
    return `Rendering failed: ${String(err?.message ?? err).split("\n")[0].slice(0, 300)}`;
  } finally {
    await server.close();
  }
  if (!fs.existsSync(out)) return "Rendering failed: no image produced.";
  const kb = Math.round(fs.statSync(out).size / 1024);
  const heavy = kb > 900 ? " It is over 900 KB, too heavy for Bluesky: render it again with format jpeg." : "";
  return `Image ${out} (${width}x${height}, ${kb} KB) attached below. Check the text is readable at phone size.${heavy}\n` +
    `Pictures used by the design must be inside ~/images (referenced as /name.png).\n[[image:${out}]]`;
}
