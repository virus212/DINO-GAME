// Fase 5 del boss, la leggenda: il gruppo «Boss» nel foglio delle
// impostazioni (#dinoMenu). In verticale (telefono, scorrendo fino ai boss),
// a schermo intero in orizzontale (scheda Leggenda) e largo (computer).
// Controlla: tre righe nell'ordine di BOSS_ORDINE, icone disegnate a pixel
// (canvas non vuoti, misure intere), badge col colore del cartellone, la nota
// coi numeri veri (DINO_MODI, BOSS_PREMIO, BOSS_REGALO, BOSS_SCONFITTA), in
// Default dino i boss spenti, nessun nome dei giochi originali, nessun errore.
// Uso: PW_DIR=… BROWSER=webkit STATIC=$PWD/static node tools/prove/boss-leggenda.mjs cartella-foto
import fs from "node:fs";
import { apri } from "./banco.mjs";

const OUT = process.argv[2] || ".";
fs.mkdirSync(OUT, { recursive: true });
const ok = [];
const ko = [];
const verifica = (cond, testo) => (cond ? ok : ko).push(testo);
const tuttiErrori = [];
const ORIGINALI = /space\s*invaders|invaders|pac-?\s*man|donkey|\bkong\b|namco|nintendo|taito|mario|pauline|blinky|pinky|inky|clyde/i;

/** Apre il foglio e aspetta che sia salito (animazione 0,34 s). */
async function apriFoglio(page) {
  await page.evaluate(() => apriMenuDino());
  await page.waitForTimeout(500);
}

/** Lo stato della sezione Boss, letto dalla pagina. */
function leggiBoss(page) {
  return page.evaluate(() => {
    const menu = document.getElementById("dinoMenu");
    const gruppo = menu.querySelector(".dino-leg-gruppo[data-gruppo='boss']");
    if (!gruppo) return null;
    const righe = [...gruppo.querySelectorAll("li[data-boss]")].map((li) => {
      const cv = li.querySelector("canvas");
      const em = li.querySelector("em");
      let pieni = 0;
      try {
        const d = cv.getContext("2d").getImageData(0, 0, cv.width, cv.height).data;
        for (let i = 3; i < d.length; i += 4) if (d[i] > 0) pieni++;
      } catch (_) {}
      const r = cv.getBoundingClientRect();
      return {
        boss: li.dataset.boss,
        nome: li.querySelector("b").textContent.trim(),
        desc: li.querySelector("span").textContent.trim(),
        badge: em ? em.textContent.trim() : "",
        colore: getComputedStyle(li).getPropertyValue("--c").trim(),
        coloreBadge: em ? getComputedStyle(em).color : "",
        tela: [cv.width, cv.height],
        css: [Math.round(r.width * 100) / 100, Math.round(r.height * 100) / 100],
        pieni,
        opacita: getComputedStyle(li).opacity,
        dopo: getComputedStyle(li, "::after").content,
      };
    });
    const nota = gruppo.querySelector(".dino-leg-nota");
    return {
      righe,
      nota: nota ? nota.textContent.replace(/\s+/g, " ").trim() : "",
      ordine: BOSS_ORDINE.slice(),
      colori: Object.fromEntries(BOSS_ORDINE.map((t) => [t, BOSS_GIOCHI[t].colore])),
      testo: menu.textContent,
      dpr: window.devicePixelRatio,
    };
  });
}

function controllaBoss(s, dove) {
  verifica(!!s, `${dove}: c'è il gruppo Boss`);
  if (!s) return;
  verifica(s.righe.length === 3, `${dove}: tre righe (${s.righe.map((r) => r.boss).join(", ")})`);
  verifica(s.righe.map((r) => r.boss).join() === s.ordine.join(), `${dove}: nell'ordine di BOSS_ORDINE`);
  s.righe.forEach((r, i) => {
    verifica(r.pieni > 20, `${dove}: icona di ${r.boss} disegnata (${r.pieni} pixel pieni, tela ${r.tela.join("x")})`);
    // celle nitide: la tela in pixel veri è grande quanto il canvas a schermo
    const nitida = Math.abs(r.css[0] * s.dpr - r.tela[0]) < 0.6 && Math.abs(r.css[1] * s.dpr - r.tela[1]) < 0.6;
    verifica(nitida, `${dove}: icona di ${r.boss} senza ridimensionare (${r.tela.join("x")} px veri, ${r.css.join("x")} css a dpr ${s.dpr})`);
    verifica(r.badge === `${i + 1}°`, `${dove}: badge di ${r.boss} «${r.badge}»`);
    verifica(r.colore.toLowerCase() === s.colori[r.boss].toLowerCase(), `${dove}: colore di ${r.boss} ${r.colore} (cartellone ${s.colori[r.boss]})`);
    verifica(r.desc.length > 10, `${dove}: ${r.nome}: «${r.desc}»`);
  });
  verifica(!ORIGINALI.test(s.testo), `${dove}: nessun nome dei giochi originali nel foglio`);
}

// —— 1. telefono in verticale: il foglio dal basso, si scorre fino ai boss
{
  const { browser, page, errori } = await apri();
  await apriFoglio(page);
  await page.locator(".dino-menu-foglio").screenshot({ path: `${OUT}/1-verticale-cima.png` });
  const s = await leggiBoss(page);
  controllaBoss(s, "verticale");
  if (s) {
    const atteso = await page.evaluate(() => ({ n: DINO_MODI.normale.boss, c: DINO_MODI.crazy.boss, premio: BOSS_PREMIO, regalo: BOSS_REGALO, sconfitta: BOSS_SCONFITTA }));
    verifica(s.nota.includes(`ogni ${atteso.n.ogni} punti`) && s.nota.includes(`ogni ${atteso.c.ogni}`), `nota coi punti veri: «${s.nota}»`);
    verifica(s.nota.includes(`+${atteso.premio}`) && /Stella/.test(s.nota), `nota col premio vero (+${atteso.premio}, ${atteso.regalo})`);
    verifica(atteso.sconfitta !== "muori" || /game over/i.test(s.nota), `nota con la sconfitta vera (${atteso.sconfitta})`);
    verifica(/Default dino/i.test(s.nota), "nota: in Default dino niente boss");
  }
  // in fondo: il gruppo Boss tutto in vista
  await page.evaluate(() => {
    const g = document.querySelector("#dinoMenu .dino-leg-gruppo[data-gruppo='boss']");
    if (g) g.scrollIntoView({ block: "end" });
  });
  await page.waitForTimeout(150);
  await page.locator(".dino-menu-foglio").screenshot({ path: `${OUT}/2-verticale-boss.png` });
  const visibile = await page.evaluate(() => {
    const g = document.querySelector("#dinoMenu .dino-leg-gruppo[data-gruppo='boss']");
    const c = document.querySelector("#dinoMenu .dino-menu-corpo").getBoundingClientRect();
    if (!g) return false;
    const r = g.getBoundingClientRect();
    return r.top >= c.top - 1 && r.bottom <= c.bottom + 1;
  });
  verifica(visibile, "verticale: scorrendo, il gruppo Boss sta tutto nel foglio");
  // Default dino: boss spenti come bonus e cattivi nuovi
  await page.evaluate(() => dinoImpostaModo("classico"));
  await page.waitForTimeout(250);
  const sc = await leggiBoss(page);
  if (sc) {
    const spenti = sc.righe.every((r) => Number(r.opacita) < 0.5 && /OFF/.test(r.dopo));
    verifica(spenti, `Default dino: boss spenti (${sc.righe.map((r) => r.opacita + " " + r.dopo).join(" | ")})`);
  }
  await page.locator(".dino-menu-foglio").screenshot({ path: `${OUT}/3-verticale-default-dino.png` });
  await page.evaluate(() => dinoImpostaModo("normale"));
  // e chiudendo e riaprendo il foglio le icone restano (disegnate una volta)
  await page.evaluate(() => chiudiMenuDino());
  await page.waitForTimeout(300);
  await apriFoglio(page);
  const s2 = await leggiBoss(page);
  verifica(s2 && s2.righe.every((r) => r.pieni > 20), "riaperto il foglio, le icone ci sono ancora");
  tuttiErrori.push(...errori.map((e) => "verticale: " + e));
  await browser.close();
}

// —— 2. schermo intero in orizzontale: la scheda Leggenda
{
  const { browser, page, errori } = await apri({ largo: 852, alto: 393, schermo: true });
  await apriFoglio(page);
  await page.locator('.dino-schede [data-scheda="leggenda"]').tap();
  await page.waitForTimeout(250);
  await page.locator(".dino-menu-foglio").screenshot({ path: `${OUT}/4-orizzontale-leggenda.png` });
  const s = await leggiBoss(page);
  controllaBoss(s, "orizzontale");
  const misure = await page.evaluate(() => {
    const col = document.querySelector('#dinoMenu .dino-menu-col[data-scheda="leggenda"]');
    const g = document.querySelector("#dinoMenu .dino-leg-gruppo[data-gruppo='boss']");
    const r = g && g.getBoundingClientRect();
    const c = col.getBoundingClientRect();
    return { scorre: col.scrollHeight - col.clientHeight, boss: r && [Math.round(r.top), Math.round(r.bottom)], col: [Math.round(c.top), Math.round(c.bottom)], largo: document.documentElement.scrollWidth - window.innerWidth };
  });
  verifica(misure.largo <= 0, `orizzontale: niente scorrimento di lato (${misure.largo})`);
  // se la scheda scorre, in fondo ci sono i boss
  await page.evaluate(() => {
    const col = document.querySelector('#dinoMenu .dino-menu-col[data-scheda="leggenda"]');
    col.scrollTop = col.scrollHeight;
  });
  await page.waitForTimeout(150);
  await page.locator(".dino-menu-foglio").screenshot({ path: `${OUT}/5-orizzontale-leggenda-fondo.png` });
  const inVista = await page.evaluate(() => {
    const col = document.querySelector('#dinoMenu .dino-menu-col[data-scheda="leggenda"]').getBoundingClientRect();
    const g = document.querySelector("#dinoMenu .dino-leg-gruppo[data-gruppo='boss']");
    if (!g) return false;
    const r = g.getBoundingClientRect();
    return r.top >= col.top - 1 && r.bottom <= col.bottom + 1;
  });
  verifica(inVista, `orizzontale: il gruppo Boss sta nella scheda (scorre di ${misure.scorre} px; boss ${JSON.stringify(misure.boss)} in ${JSON.stringify(misure.col)})`);
  // la scheda Modalità torna come prima
  await page.locator('.dino-schede [data-scheda="modi"]').tap();
  await page.waitForTimeout(200);
  await page.locator(".dino-menu-foglio").screenshot({ path: `${OUT}/6-orizzontale-modi.png` });
  tuttiErrori.push(...errori.map((e) => "orizzontale: " + e));
  await browser.close();
}

// —— 3. largo (computer): il foglio al centro in basso, come in verticale
{
  const { browser, page, errori } = await apri({ largo: 1280, alto: 800 });
  await apriFoglio(page);
  const s = await leggiBoss(page);
  controllaBoss(s, "largo");
  await page.evaluate(() => {
    const g = document.querySelector("#dinoMenu .dino-leg-gruppo[data-gruppo='boss']");
    if (g) g.scrollIntoView({ block: "end" });
  });
  await page.waitForTimeout(150);
  await page.locator(".dino-menu-foglio").screenshot({ path: `${OUT}/7-largo-boss.png` });
  tuttiErrori.push(...errori.map((e) => "largo: " + e));
  await browser.close();
}

// —— 4. telefono piccolo (iPhone SE, 320 × 568): niente che esce dai bordi
{
  const { browser, page, errori } = await apri({ largo: 320, alto: 568 });
  await apriFoglio(page);
  await page.evaluate(() => {
    const g = document.querySelector("#dinoMenu .dino-leg-gruppo[data-gruppo='boss']");
    if (g) g.scrollIntoView({ block: "end" });
  });
  await page.waitForTimeout(150);
  const fuori = await page.evaluate(() =>
    [...document.querySelectorAll("#dinoMenu .dino-leg-gruppo[data-gruppo='boss'] li > *")]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.right > window.innerWidth + 0.5 || r.left < -0.5;
      })
      .map((el) => el.tagName),
  );
  verifica(fuori.length === 0, `piccolo: niente fuori dai bordi (${fuori.join(", ") || "ok"})`);
  await page.locator(".dino-menu-foglio").screenshot({ path: `${OUT}/8-piccolo-boss.png` });
  tuttiErrori.push(...errori.map((e) => "piccolo: " + e));
  await browser.close();
}

console.log("OK:\n  " + ok.join("\n  "));
console.log("KO:\n  " + (ko.join("\n  ") || "nessuno"));
console.log("errori:", tuttiErrori.length ? tuttiErrori : "nessuno");
process.exit(ko.length || tuttiErrori.length ? 1 : 0);
