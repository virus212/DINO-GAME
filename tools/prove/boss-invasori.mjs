// Fase 3: gli invasori. Incontro (fumetto, salto sull'astronave, volo),
// tendina vera, partita giocata da un «dito» che insegue gli alieni, gag di
// vittoria (e ritorno: dino a terra, Stella, grazia) e di sconfitta (game
// over). Uso: node boss-invasori.mjs <cartella-foto> [verticale|orizzontale]
import { apri, foto } from "./banco.mjs";

const OUT = process.argv[2] || ".";
const oriz = process.argv[3] === "orizzontale";
const ok = [];
const ko = [];
const verifica = (cond, testo) => (cond ? ok : ko).push(testo);
const { browser, page, errori } = await apri(oriz ? { largo: 852, alto: 393, schermo: true } : {});
const P = oriz ? "o" : "v";
const scatta = async (fase, t, nome) => {
  await page.waitForFunction(([f, t]) => __dino.boss && __dino.boss.fase === f && __dino.boss.t >= t, [fase, t], { timeout: 25000 });
  await foto(page, `${OUT}/${P}-inv-${nome}.png`, oriz);
};
const campo = () =>
  page.evaluate(() => {
    const r = document.getElementById("dinoCanvas").getBoundingClientRect();
    const c = dinoBossCampo(__dino.boss);
    return { r: { left: r.left, top: r.top, width: r.width, height: r.height }, c, w: __dino.w, h: __dino.h };
  });
const pagina = (m, ux, uy) => ({ x: m.r.left + ((m.c.x + ux) / m.w) * m.r.width, y: m.r.top + ((m.c.y + uy) / m.h) * m.r.height });

await page.locator("#dinoCampo").tap();
await page.evaluate(() => {
  window.__dinoSeme = 7;
  window.__pulisci = setInterval(() => (__dino.ostacoli = __dino.ostacoli.filter((o) => o.x > 90 || o.x + o.w < 0)), 20);
  window.__suoni = [];
  const o = window.dinoSuono;
  window.dinoSuono = (n) => (window.__suoni.push(n), o(n));
  window.__dinoBoss("invasori");
});
await scatta("arrivo", 900, "1-arrivo");
await scatta("incontro", 600, "2-parolaccia");
await scatta("incontro", 1330, "3-salto");
await scatta("incontro", 1750, "4-volo");
await scatta("entra", 60, "5-lampo");
await scatta("entra", 330, "6-spirale");
await scatta("entra", 760, "7-riapre");
await page.waitForFunction(() => __dino.boss && __dino.boss.fase === "gioco" && __dino.boss.t > 300, null, { timeout: 5000 });

// —— una partita vera: il mouse tenuto giù insegue l'alieno più basso e vicino
let m = await campo();
let p = pagina(m, 112, 140);
await page.mouse.move(p.x, p.y);
await page.mouse.down();
for (let i = 0; i < 70; i++) {
  const bx = await page.evaluate(() => {
    const g = __dino.boss && __dino.boss.gioco;
    if (!g || !g.alieni) return null;
    const vivi = g.alieni.filter((a) => a.vivo).map((a) => invAlieno(g, a));
    if (!vivi.length) return null;
    vivi.sort((a, b) => b.y - a.y || Math.abs(a.x - g.x) - Math.abs(b.x - g.x));
    return vivi[0].x + vivi[0].w / 2;
  });
  if (bx === null) break;
  m = await campo();
  p = pagina(m, bx, 140);
  await page.mouse.move(p.x, p.y);
  if (i === 30) await foto(page, `${OUT}/${P}-inv-8-gioco.png`, oriz);
  await page.waitForTimeout(100);
}
await page.mouse.up();
const partita = await page.evaluate(() => {
  const g = __dino.boss.gioco;
  return { fase: __dino.boss.fase, vivi: g.alieni.filter((a) => a.vivo).length, punti: g.punti, fy: g.fy, bunker: g.bunker.map((b) => b.griglia.reduce((s, v) => s + v, 0)) };
});
verifica(partita.vivi < 32 && partita.punti > 0, `partita vera: abbattuti ${32 - partita.vivi}, punti ${partita.punti}, formazione a y ${partita.fy}`);
const suoni = await page.evaluate(() => [...new Set(window.__suoni)].join(","));
verifica(/inv_passo1/.test(suoni) && /inv_sparo/.test(suoni) && /inv_scoppio/.test(suoni), `suoni: ${suoni}`);

// —— vittoria: tutti giù
if (partita.fase === "gioco") await page.evaluate(() => __dino.boss.gioco.alieni.forEach((a) => (a.vivo = false)));
await scatta("esito", 250, "9-vinto-godzilla");
await scatta("esito", 950, "10-vinto-soffio");
await scatta("esito", 1550, "11-vinto-boom");
await page.waitForFunction(() => !__dino.boss, null, { timeout: 6000 });
const dopo = await page.evaluate(() => ({ stato: __dino.stato, y: __dino.y, potere: __dino.potere && __dino.potere.tipo, prossimo: __dino.prossimoBoss }));
verifica(dopo.stato === "corsa" && dopo.y === 0 && dopo.potere === "stella", `vittoria: si torna a correre a terra con la Stella ${JSON.stringify(dopo)}`);
await page.waitForTimeout(200);
await foto(page, `${OUT}/${P}-inv-12-ritorno.png`, oriz);

// —— sconfitta: ultima vita e una bomba addosso
await page.waitForTimeout(900);
await page.evaluate(() => {
  __dino.potere = null;
  __dino.grazia = 0;
  window.__dinoBoss("invasori");
});
await page.waitForFunction(() => __dino.boss && __dino.boss.fase === "gioco" && __dino.boss.t > 300, null, { timeout: 25000 });
await page.evaluate(() => {
  const g = __dino.boss.gioco;
  g.vite = 1;
  g.prossimaBomba = 1e9;
  g.bombe = [{ tipo: "spirale", x: Math.round(g.x), y: INV_NAVE_Y - 2, eta: 0 }];
});
await scatta("esito", 400, "13-perso-raggio");
await scatta("esito", 1250, "14-perso-scagliato");
await page.waitForFunction(() => __dino.stato === "fine", null, { timeout: 6000 });
const fine = await page.evaluate(() => ({ causa: __dino.causa, y: __dino.y }));
verifica(fine.causa === "Battuto dal boss" && fine.y === 0, `sconfitta: game over ${JSON.stringify(fine)}`);
await page.waitForTimeout(300);
await foto(page, `${OUT}/${P}-inv-15-gameover.png`, oriz);

console.log("OK:\n  " + ok.join("\n  "));
console.log("KO:\n  " + (ko.join("\n  ") || "nessuno"));
console.log("errori:", errori.length ? errori : "nessuno");
await browser.close();
process.exit(ko.length || errori.length ? 1 : 0);
