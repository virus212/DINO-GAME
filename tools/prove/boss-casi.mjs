// Fase 1 del boss, correzioni dopo la revisione: rientro online protetto dopo
// il background, morte nello sgombro, blur a metà minigioco, keyup altrove,
// errore dentro un minigioco, debug con boss già in corso.
import { apri } from "./banco.mjs";

const ok = [];
const ko = [];
const verifica = (cond, testo) => (cond ? ok : ko).push(testo);
const { browser, page, errori } = await apri({ largo: 1280, alto: 800 });
const pulisci = () =>
  page.evaluate(() => {
    clearInterval(window.__pulisci);
    window.__pulisci = setInterval(() => (__dino.ostacoli = __dino.ostacoli.filter((o) => o.x > 90 || o.x + o.w < 0)), 20);
  });
const aGioco = async (tipo) => {
  await page.evaluate((t) => window.__dinoBoss(t), tipo);
  await page.waitForFunction(() => __dino.boss && __dino.boss.fase === "gioco", null, { timeout: 20000 });
  await page.waitForTimeout(300);
};

// —— 1. background → pausa protetta dal rientro online; dopo DINO_PAUSA_TUTELA no
await page.locator("#dinoCampo").tap();
await pulisci();
await aGioco("invasori");
await page.evaluate(() => {
  Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
});
const prot = await page.evaluate(() => ({ stato: __dino.stato, inGioco: dinoInGioco() }));
verifica(prot.stato === "pausa" && prot.inGioco, `pausa dal background protetta dal rientro online: ${JSON.stringify(prot)}`);
const scaduta = await page.evaluate(() => {
  const prima = __dino.pausaSfondo;
  __dino.pausaSfondo = Date.now() - DINO_PAUSA_TUTELA - 1000;
  const r = dinoInGioco();
  __dino.pausaSfondo = prima;
  return r;
});
verifica(!scaduta, "dopo DINO_PAUSA_TUTELA il rientro online torna possibile");
await page.evaluate(() => {
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
});
await page.locator("#dinoCampo").tap(); // riprende
const ripresa = await page.evaluate(() => ({ stato: __dino.stato, sfondo: __dino.pausaSfondo }));
verifica(ripresa.stato === "corsa" && ripresa.sfondo === 0, `ripresa: tutela tolta ${JSON.stringify(ripresa)}`);
// pausa dal menu: come sempre non protetta
await page.evaluate(() => apriMenuDino());
verifica(!(await page.evaluate(() => dinoInGioco())), "pausa dal menu: non protetta (come prima)");
await page.evaluate(() => chiudiMenuDino());
await page.waitForTimeout(300);
await page.locator("#dinoCampo").tap();

// —— 2. blur della finestra a metà minigioco → pausa; keyup arrivato altrove → rilasciato
await page.locator("#dinoCampo").focus();
await page.keyboard.down("ArrowDown");
await page.evaluate(() => document.activeElement.blur());
await page.keyboard.up("ArrowDown");
verifica((await page.evaluate(() => __dino.boss.tasti.size)) === 0, "keyup arrivato fuori dal campo: tasto rilasciato");
await page.evaluate(() => window.dispatchEvent(new Event("blur")));
verifica((await page.evaluate(() => __dino.stato)) === "pausa", "blur a metà minigioco: pausa");
await page.locator("#dinoCampo").tap();
await page.waitForTimeout(100);

// —— 3. debug con boss già in corso: rifiutato
const rif = await page.evaluate(() => window.__dinoBoss("scimmione"));
verifica(/già in corso/.test(rif) && (await page.evaluate(() => __dino.boss.tipo)) === "invasori", `__dinoBoss con boss in corso: «${rif}»`);

// —— 4. errore dentro il minigioco: il boss finisce «pari», il ciclo va avanti
await page.evaluate(() => {
  const g = BOSS_GIOCHI.invasori;
  window.__passoVero = g.passo;
  g.passo = () => {
    throw new Error("prova di guasto");
  };
});
await page.waitForFunction(() => !__dino.boss, null, { timeout: 8000 });
const dopoGuasto = await page.evaluate(() => ({ stato: __dino.stato, raf: !!__dino.raf || !!__dino.attesa }));
verifica(dopoGuasto.stato === "corsa" && dopoGuasto.raf, `errore nel minigioco: boss chiuso, si corre (${JSON.stringify(dopoGuasto)})`);
const erroreAtteso = errori.filter((e) => /prova di guasto/.test(e));
verifica(erroreAtteso.length >= 1, "l'errore è segnalato in console");
errori.splice(0, errori.length, ...errori.filter((e) => !/prova di guasto/.test(e)));
await page.evaluate(() => (BOSS_GIOCHI.invasori.passo = window.__passoVero));

// —— 5. morte nello sgombro: il boss si azzera con lo schianto
await page.evaluate(() => clearInterval(window.__pulisci));
await page.waitForTimeout(400);
await page.evaluate(() => {
  __dino.grazia = 0;
  __dino.potere = null;
  dinoNuovoOstacolo(); // uno in strada, nessuno lo salta
  dinoBossChiama("labirinto");
});
await page.waitForFunction(() => __dino.stato === "fine", null, { timeout: 10000 });
verifica((await page.evaluate(() => __dino.boss)) === null, "morto nello sgombro: boss azzerato");

console.log("OK:\n  " + ok.join("\n  "));
console.log("KO:\n  " + (ko.join("\n  ") || "nessuno"));
console.log("errori:", errori.length ? errori : "nessuno");
await browser.close();
process.exit(ko.length || errori.length ? 1 : 0);
