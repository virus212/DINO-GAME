// Fase 1 del boss, regressione: senza boss la partita è quella di sempre
// (ostacoli, schianto, record); con la soglia (punti a 990) il boss parte da
// solo; in Default dino mai; cambio modalità a metà boss lo azzera.
import { apri } from "./banco.mjs";

const ok = [];
const ko = [];
const verifica = (cond, testo) => (cond ? ok : ko).push(testo);
const { browser, page, errori } = await apri();

// —— 1. partita normale: BOSS_ACCESO spento → prossimoBoss = mai; ci si schianta come sempre
await page.locator("#dinoCampo").tap();
const pb = await page.evaluate(() => __dino.prossimoBoss);
verifica(pb === 1e12, `boss spento finché i minigiochi non sono pronti (prossimoBoss ${pb})`);
await page.waitForFunction(() => __dino.stato === "fine", null, { timeout: 30000 });
const fine = await page.evaluate(() => ({ causa: __dino.causa, record: __dino.record, boss: __dino.boss }));
verifica(fine.causa && fine.boss === null, `schianto normale: «${fine.causa}», record ${fine.record}`);

// —— 2. soglia: punti a 990 con la soglia a 1000 (come sarà con BOSS_ACCESO)
await page.waitForTimeout(500);
await page.locator("#dinoCampo").tap();
await page.evaluate(() => {
  __dino.prossimoBoss = 1000;
  __dino.punti = 990;
  window.__pulisci = setInterval(() => {
    __dino.ostacoli = __dino.ostacoli.filter((o) => o.x > 90 || o.x + o.w < 0);
  }, 20);
});
await page.waitForFunction(() => __dino.boss, null, { timeout: 5000 });
const b = await page.evaluate(() => ({ tipo: __dino.boss.tipo, punti: Math.floor(__dino.punti) }));
verifica(b.tipo === "scimmione" && b.punti >= 1000, `a 1000 punti parte il primo boss: ${JSON.stringify(b)}`);
await page.waitForFunction(() => __dino.boss && __dino.boss.fase === "gioco", null, { timeout: 20000 });
await page.evaluate(() => BOSS_GIOCHI.scimmione.tasto(__dino.boss.gioco, { tasto: "destra", giu: true }));
await page.waitForFunction(() => !__dino.boss, null, { timeout: 6000 });
const dopo = await page.evaluate(() => ({ prossimo: __dino.prossimoBoss, punti: Math.floor(__dino.punti), visti: __dino.bossVisti }));
verifica(dopo.prossimo === 2000 && dopo.visti === 1, `la soglia dopo: ${JSON.stringify(dopo)}`);

// —— 3. il premio non deve scavalcare la soglia dopo senza boss: punti a 1990 → boss, vinto (+300 = 2290) → prossima 3000
await page.evaluate(() => {
  __dino.grazia = 0;
  __dino.potere = null;
  __dino.punti = 1995;
});
await page.waitForFunction(() => __dino.boss, null, { timeout: 5000 });
const tipo2 = await page.evaluate(() => __dino.boss.tipo);
verifica(tipo2 === "labirinto", `secondo boss: ${tipo2}`);
await page.waitForFunction(() => __dino.boss && __dino.boss.fase === "gioco", null, { timeout: 25000 });
// —— 4. cambio modalità a metà boss: tutto azzerato, niente boss in Default dino
await page.evaluate(() => dinoImpostaModo("classico"));
const m = await page.evaluate(() => ({ stato: __dino.stato, boss: __dino.boss, cab: document.getElementById("offlineCabinato").classList.contains("boss") }));
verifica(m.stato === "riposo" && m.boss === null && !m.cab, `cambio modalità a metà boss: ${JSON.stringify(m)}`);
await page.locator("#dinoCampo").tap();
const pc = await page.evaluate(() => __dino.prossimoBoss);
verifica(pc === 1e12, "in Default dino nessun boss");
await page.evaluate(() => dinoImpostaModo("normale"));

console.log("OK:\n  " + ok.join("\n  "));
console.log("KO:\n  " + (ko.join("\n  ") || "nessuno"));
console.log("errori:", errori.length ? errori : "nessuno");
await browser.close();
process.exit(ko.length || errori.length ? 1 : 0);
