// Banco di prova del gioco offline: serve static/ da un'origine finta,
// Capacitor finto (iOS, Filesystem, Orientamento, qualunque plugin), entra in
// offline mode come il telefono senza rete. Nessuna rete vera e nessun login:
// /api/* risponde 503, il resto 404.
// Uso: PW_DIR=~/crackify-redesign/node_modules BROWSER=webkit node boss-giro.mjs foto
//   PW_DIR   la cartella node_modules che contiene playwright (se manca: quella di Node)
//   BROWSER  webkit (come l'iPhone) o chromium
//   STATIC   la cartella coi tre file (se manca: ../../static)
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(process.env.PW_DIR ? path.join(process.env.PW_DIR, "/") : import.meta.url);
const pw = require("playwright");
export const motore = pw[process.env.BROWSER || "webkit"];

const STATIC = process.env.STATIC || fileURLToPath(new URL("../../static", import.meta.url));
const ORIGINE = "http://crackify.test";
const TIPI = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

const capacitorFinto = () => {
  const promessa = () => Promise.resolve({});
  const plugin = (nome) =>
    new Proxy(
      {},
      {
        get(_, k) {
          if (k === "then") return undefined;
          if (nome === "Filesystem" && k === "readdir") return () => Promise.resolve({ files: [] });
          if (k === "addListener") return () => Promise.resolve({ remove() {} });
          return (...a) => {
            (window.__chiamate = window.__chiamate || []).push([nome, String(k), a[0]]);
            return promessa();
          };
        },
      },
    );
  const cache = {};
  const prendi = (n) => (cache[n] = cache[n] || plugin(n));
  window.Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => "ios",
    isPluginAvailable: () => true,
    registerPlugin: prendi,
    Plugins: new Proxy({}, { get: (_, n) => prendi(String(n)) }),
  };
};

export async function apri({ largo = 393, alto = 852, schermo = false, ridotto = false } = {}) {
  const browser = await motore.launch();
  const ctx = await browser.newContext({
    viewport: { width: largo, height: alto },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    reducedMotion: ridotto ? "reduce" : "no-preference",
  });
  const page = await ctx.newPage();
  const errori = [];
  page.on("pageerror", (e) => errori.push("pageerror: " + e.message));
  page.on("console", (m) => {
    // le icone e il manifest non sono nel repo: i loro 404 non sono errori del gioco
    if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errori.push("console.error: " + m.text());
  });
  await page.addInitScript(capacitorFinto);
  // indirizzo del Mac già configurato: niente pannello «Connetti al tuo Mac»
  await page.addInitScript(() => {
    try {
      if (!localStorage.getItem("crackify_api_base")) localStorage.setItem("crackify_api_base", "http://crackify.test");
      // una playlist scaricata finta + «resta offline»: l'avvio entra da solo
      // in modalità offline, come sul telefono senza rete
      localStorage.setItem("crackify_offline_playlists", JSON.stringify({ p1: { pl: { id: "p1", name: "Prova", tracks: [] }, ownerId: 1 } }));
      localStorage.setItem("crackify_offline_resta", "1");
    } catch (_) {}
  });
  await page.route("**/*", (route) => {
    const u = new URL(route.request().url());
    if (u.origin !== ORIGINE) return route.abort();
    if (u.pathname.startsWith("/api/")) return route.fulfill({ status: 503, body: "" });
    const nome = u.pathname === "/" ? "index.html" : u.pathname.slice(1);
    const file = path.join(STATIC, nome);
    if (!["index.html", "app.js", "style.css", "boss.js", "boss-scimmione.js", "boss-labirinto.js"].includes(nome) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: "" });
    route.fulfill({ status: 200, contentType: TIPI[path.extname(nome)], body: fs.readFileSync(file) });
  });
  await page.goto(ORIGINE + "/");
  await page.waitForFunction(() => typeof appOfflineMode !== "undefined" && appOfflineMode);
  // la schermata «Modalità offline» sparisce da sola
  await page.waitForTimeout(3500);
  await page.waitForFunction(() => window.__dino && window.__dino.w > 0);
  if (schermo) {
    await page.evaluate(() => apriSchermoDino());
    await page.waitForTimeout(400);
  }
  return { browser, page, errori };
}

/** Foto del solo cabinato (o dello schermo intero). */
export async function foto(page, file, schermo = false) {
  const sel = schermo ? "#dinoSchermo" : "#offlineCabinato";
  await page.locator(sel).screenshot({ path: file });
}
