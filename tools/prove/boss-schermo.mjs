// Fase 1 del boss: schermo intero in orizzontale (zoom, tocchi mappati),
// schermo intero chiuso a metà minigioco (misure che cambiano), tastiera,
// «riduci movimento» (tendina corta, a taglio).
import { apri, foto } from "./banco.mjs";

const OUT = process.argv[2] || ".";
const ok = [];
const ko = [];
const verifica = (cond, testo) => (cond ? ok : ko).push(testo);
const tuttiErrori = [];

async function giro(page, tipo) {
  await page.evaluate(() => {
    clearInterval(window.__pulisci);
    window.__pulisci = setInterval(() => {
      const d = window.__dino;
      d.ostacoli = d.ostacoli.filter((o) => o.x > 90 || o.x + o.w < 0);
    }, 20);
  });
  await page.evaluate((t) => window.__dinoBoss(t), tipo);
  await page.waitForFunction(() => window.__dino.boss && window.__dino.boss.fase === "gioco", null, { timeout: 20000 });
  await page.waitForTimeout(300); // BOSS_SORDO
}
async function toccaCampo(page, ux, uy) {
  const p = await page.evaluate(([ux, uy]) => {
    const r = document.getElementById("dinoCanvas").getBoundingClientRect();
    const campo = dinoBossCampo(window.__dino.boss);
    return { x: r.left + ((campo.x + ux) / window.__dino.w) * r.width, y: r.top + ((campo.y + uy) / window.__dino.h) * r.height };
  }, [ux, uy]);
  await page.touchscreen.tap(p.x, p.y);
}
const finito = (page) => page.waitForFunction(() => !window.__dino.boss, null, { timeout: 6000 });

// —— 1. schermo intero in orizzontale
{
  const { browser, page, errori } = await apri({ largo: 852, alto: 393, schermo: true });
  const misura = await page.evaluate(() => ({ w: Math.round(__dino.w), h: Math.round(__dino.h), zoom: __dino.zoom, aperto: dinoSchermoAperto() }));
  verifica(misura.aperto && misura.zoom > 1, `schermo intero aperto: ${JSON.stringify(misura)}`);
  await page.locator("#dinoCampo").tap();
  await giro(page, "labirinto");
  await page.waitForTimeout(300);
  await foto(page, `${OUT}/7-schermo-intero.png`, true);
  // tocco a destra del campo ingrandito: deve vincere
  await toccaCampo(page, 160, 40);
  await page.waitForFunction(() => window.__dino.boss && window.__dino.boss.fase === "esito", null, { timeout: 2000 });
  verifica((await page.evaluate(() => __dino.boss.esito)) === "vinto", "schermo intero: il tocco ingrandito arriva nel posto giusto (vinto)");
  await finito(page);
  // —— 2. si chiude lo schermo intero a metà minigioco: pausa, misure nuove, si riprende
  await giro(page, "invasori");
  const prima = await page.evaluate(() => Math.round(__dino.w));
  await page.evaluate(() => chiudiSchermoDino());
  await page.waitForTimeout(400);
  const dopo = await page.evaluate(() => ({ w: Math.round(__dino.w), stato: __dino.stato, fase: __dino.boss && __dino.boss.fase }));
  verifica(dopo.stato === "pausa" && dopo.fase === "gioco", `chiuso lo schermo intero a metà: ${JSON.stringify(dopo)} (larghezza ${prima} → ${dopo.w})`);
  await page.locator("#dinoCampo").tap(); // riprende
  await page.waitForTimeout(100);
  await toccaCampo(page, 20, 40); // a sinistra: perde
  await page.waitForFunction(() => window.__dino.boss && window.__dino.boss.esito, null, { timeout: 2000 });
  verifica((await page.evaluate(() => __dino.boss.esito)) === "perso", "dopo il cambio di misura il tocco a sinistra perde");
  await finito(page);
  verifica((await page.evaluate(() => __dino.stato)) === "corsa", "e si torna a correre");
  tuttiErrori.push(...errori);
  await browser.close();
}

// —— 3. tastiera (desktop) e «riduci movimento»
{
  const { browser, page, errori } = await apri({ largo: 1280, alto: 800, ridotto: true });
  await page.locator("#dinoCampo").tap();
  await page.evaluate(() => {
    window.__tempi = [];
    const orig = window.dinoBossFase;
    window.dinoBossFase = (b, f) => {
      window.__tempi.push([b.fase, Math.round(b.t)]);
      orig(b, f);
    };
  });
  await giro(page, "scimmione");
  await page.locator("#dinoCampo").focus();
  // le frecce in su / giù non devono far saltare il dino né finire il gioco
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Space");
  await page.waitForTimeout(100);
  verifica((await page.evaluate(() => __dino.boss && __dino.boss.fase)) === "gioco", "su e spazio vanno al minigioco senza effetti strani");
  await page.keyboard.press("ArrowRight");
  await page.waitForFunction(() => window.__dino.boss && window.__dino.boss.esito, null, { timeout: 2000 });
  verifica((await page.evaluate(() => __dino.boss.esito)) === "vinto", "freccia a destra: vinto");
  await finito(page);
  const tempi = await page.evaluate(() => window.__tempi);
  const entra = tempi.find(([f]) => f === "entra");
  verifica(entra && entra[1] <= 260, `riduci movimento: la tendina dura ${entra && entra[1]} ms`);
  const misura = await page.evaluate(() => ({ w: Math.round(__dino.w), h: Math.round(__dino.h) }));
  verifica(true, `desktop: mondo ${misura.w}x${misura.h}`);
  await giro(page, "labirinto");
  await page.waitForTimeout(150);
  await foto(page, `${OUT}/8-largo.png`);
  tuttiErrori.push(...errori);
  await browser.close();
}

// —— 4. input: rilasci persi, mouse sospeso, frecce da fuori, Ctrl+freccia, spazio col menu aperto
{
  const { browser, page, errori } = await apri({ largo: 1280, alto: 800 });
  await page.locator("#dinoCampo").tap();
  await giro(page, "invasori");
  // spia sul minigioco: cosa gli arriva
  await page.evaluate(() => {
    window.__arrivi = [];
    const g = BOSS_GIOCHI.invasori;
    const dito = g.dito;
    const tasto = g.tasto;
    g.dito = (gg, ev) => (window.__arrivi.push("dito " + ev.tipo), dito(gg, ev));
    g.tasto = (gg, ev) => (window.__arrivi.push("tasto " + ev.tasto + (ev.giu ? "↓" : "↑")), tasto(gg, ev));
  });
  const arrivi = () => page.evaluate(() => window.__arrivi.splice(0));
  // mouse che passa sopra senza tasti: niente
  const r = await page.locator("#dinoCanvas").boundingBox();
  await page.mouse.move(r.x + r.width / 2, r.y + 20);
  await page.mouse.move(r.x + r.width / 2 + 30, r.y + 30);
  verifica((await arrivi()).length === 0, "il mouse sospeso non muove il minigioco");
  // dito giù (fuori dal campo del segnaposto: non decide), pausa, dito su in pausa → rilasciato
  await page.mouse.move(r.x + r.width / 2, r.y + 3);
  await page.mouse.down();
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.mouse.up();
  const dopo = await page.evaluate(() => ({ dita: __dino.boss.dita.size, stato: __dino.stato }));
  const a1 = await arrivi();
  verifica(dopo.stato === "pausa" && dopo.dita === 0 && a1.includes("dito su"), `dito lasciato in pausa: rilasciato (${a1.join(", ")})`);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.locator("#dinoCampo").focus();
  await page.keyboard.press("Space"); // riprende
  await page.waitForTimeout(300);
  verifica((await page.evaluate(() => __dino.stato)) === "corsa", "spazio in pausa riprende");
  await arrivi();
  // tasto tenuto e finestra che perde il fuoco: rilasciato
  await page.keyboard.down("ArrowDown");
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  const a2 = await arrivi();
  const tenuti = await page.evaluate(() => __dino.boss.tasti.size);
  verifica(tenuti === 0 && a2.join() === "tasto giu↓,tasto giu↑", `tasto tenuto e blur: rilasciato (${a2.join(", ")})`);
  await page.keyboard.up("ArrowDown");
  // il blur a metà minigioco mette anche in pausa: un tocco riprende
  verifica((await page.evaluate(() => __dino.stato)) === "pausa", "blur a metà minigioco: pausa");
  await page.locator("#dinoCampo").tap();
  await page.waitForTimeout(100);
  await arrivi();
  // Ctrl+freccia: è del lettore musicale, non del minigioco
  await page.keyboard.down("Control");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.up("Control");
  verifica((await arrivi()).length === 0 && (await page.evaluate(() => !__dino.boss.esito)), "Ctrl+freccia non arriva al minigioco");
  // frecce col fuoco fuori dal campo: danno il fuoco al campo e arrivano
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await page.keyboard.press("ArrowRight");
  const a3 = await arrivi();
  verifica(a3.join() === "tasto destra↓,tasto destra↑", `freccia col fuoco altrove: ${a3.join(", ")}`);
  await page.waitForFunction(() => !window.__dino.boss, null, { timeout: 6000 });
  // spazio col menu aperto: la partita non riparte dietro il menu
  await page.evaluate(() => apriMenuDino());
  await page.waitForTimeout(250);
  await page.keyboard.press("Space");
  await page.waitForTimeout(100);
  verifica((await page.evaluate(() => __dino.stato)) === "pausa", "spazio col menu aperto: resta in pausa");
  tuttiErrori.push(...errori);
  await browser.close();
}

console.log("OK:\n  " + ok.join("\n  "));
console.log("KO:\n  " + (ko.join("\n  ") || "nessuno"));
console.log("errori:", tuttiErrori.length ? tuttiErrori : "nessuno");
process.exit(ko.length || tuttiErrori.length ? 1 : 0);
