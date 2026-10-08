// Home desktop (online, non mobile, ≥901 px): il banner in fondo alla Home, mondo largo
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { motore } from "./banco.mjs";
const STATIC = process.env.STATIC || fileURLToPath(new URL("../../static", import.meta.url));
const OUT = process.argv[2] || ".";
const browser = await motore.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errori = [];
page.on("pageerror", (e) => errori.push(e.message));
page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && errori.push(m.text()));
await page.route("**/*", (route) => {
  const u = new URL(route.request().url());
  if (u.origin !== "http://crackify.test") return route.abort();
  if (u.pathname.startsWith("/api/")) return route.fulfill({ status: 503, body: "" });
  const nome = u.pathname === "/" ? "index.html" : u.pathname.slice(1);
  const f = path.join(STATIC, nome);
  if (!["index.html", "app.js", "style.css", "boss.js"].includes(nome)) return route.fulfill({ status: 404, body: "" });
  route.fulfill({ status: 200, contentType: { html: "text/html", js: "text/javascript", css: "text/css" }[nome.split(".").pop()], body: fs.readFileSync(f) });
});
await page.goto("http://crackify.test/");
await page.waitForTimeout(2500);
// finto login: niente gate, vista Home, banner nello slot
await page.evaluate(() => {
  document.documentElement.classList.remove("need-login");
  document.body.classList.remove("auth-checking");
  try { setAuthGate(false); closeLoginModal(); } catch (_) {}
  document.querySelectorAll(".modal, .intro-splash").forEach((m) => (m.style.display = "none"));
  showView("home");
  dinoSistema();
});
await page.waitForTimeout(600);
const info = await page.evaluate(() => ({ home: dinoInHome(), w: Math.round(__dino.w), h: Math.round(__dino.h), zoom: __dino.zoom }));
console.log("home:", JSON.stringify(info));
if (!info.home) { console.log("banner non in Home"); await browser.close(); process.exit(1); }
const campo = page.locator("#dinoCampo");
await campo.scrollIntoViewIfNeeded();
await campo.click();
await page.evaluate(() => {
  window.__pulisci = setInterval(() => (__dino.ostacoli = __dino.ostacoli.filter((o) => o.x > 90 || o.x + o.w < 0)), 20);
  window.__dinoBoss("labirinto");
});
await page.waitForFunction(() => __dino.boss && __dino.boss.fase === "gioco", null, { timeout: 20000 });
await page.waitForTimeout(300);
await page.locator("#homeDinoSlot").screenshot({ path: `${OUT}/10-home.png` });
// clic a destra del campo (mouse, banner ingrandito): vince
const p = await page.evaluate(() => {
  const r = document.getElementById("dinoCanvas").getBoundingClientRect();
  const c = dinoBossCampo(__dino.boss);
  return { x: r.left + ((c.x + 160) / __dino.w) * r.width, y: r.top + ((c.y + 50) / __dino.h) * r.height };
});
await page.mouse.click(p.x, p.y);
await page.waitForFunction(() => __dino.boss && __dino.boss.esito, null, { timeout: 2000 });
const esito = await page.evaluate(() => __dino.boss.esito);
// spazio da fuori: dopo il boss lo spazio salta e non mette in pausa la musica
await page.waitForFunction(() => !__dino.boss, null, { timeout: 6000 });
console.log("esito col mouse in Home:", esito, "| stato:", await page.evaluate(() => __dino.stato));
console.log("errori:", errori.length ? errori : "nessuno");
await browser.close();
process.exit(esito === "vinto" && !errori.length ? 0 : 1);
