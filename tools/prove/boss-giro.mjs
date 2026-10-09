// Fase 1 del boss: il giro intero col segnaposto, pausa e background a metà,
// vittoria (premio, regalo, grazia, strada libera) e sconfitta (game over).
import { apri, foto } from "./banco.mjs";

const OUT = process.argv[2] || ".";
const ok = [];
const ko = [];
const verifica = (cond, testo) => (cond ? ok : ko).push(testo);

const { browser, page, errori } = await apri();
// il motore si prova col segnaposto (tocco a destra vince, a sinistra perde),
// registrato qui come boss «prova»: i minigiochi veri hanno le loro prove
await page.evaluate(() => (BOSS_GIOCHI.prova = BOSS_SEGNAPOSTO));
const stato = () =>
  page.evaluate(() => {
    const d = window.__dino;
    const b = d.boss;
    return { stato: d.stato, fase: b && b.fase, tipo: b && b.tipo, t: b && Math.round(b.t), punti: Math.floor(d.punti), vel: +d.velocita.toFixed(2), corsa: Math.round(d.corsa), ostacoli: d.ostacoli.length, potere: d.potere && d.potere.tipo, grazia: Math.round(d.grazia), coda: d.coda, prossimoBoss: d.prossimoBoss, bossVisti: d.bossVisti, cab: document.getElementById("offlineCabinato").classList.contains("boss") };
  });
// i test non giocano: via gli ostacoli vicini al dino (come suggerito nel README)
const pulisci = () =>
  page.evaluate(() => {
    clearInterval(window.__pulisci);
    window.__pulisci = setInterval(() => {
      const d = window.__dino;
      d.ostacoli = d.ostacoli.filter((o) => o.x > 90 || o.x + o.w < 0);
    }, 20);
  });
const aspettaFase = async (fase, max = 15000) => {
  await page.waitForFunction((f) => window.__dino.boss && window.__dino.boss.fase === f, fase, { timeout: max });
};
// tocco a un punto del campo del minigioco (unità del campo → pixel della pagina)
const toccaCampo = async (ux, uy) => {
  const p = await page.evaluate(([ux, uy]) => {
    const r = document.getElementById("dinoCanvas").getBoundingClientRect();
    const campo = dinoBossCampo(window.__dino.boss);
    return { x: r.left + ((campo.x + ux) / window.__dino.w) * r.width, y: r.top + ((campo.y + uy) / window.__dino.h) * r.height };
  }, [ux, uy]);
  await page.touchscreen.tap(p.x, p.y);
};

// —— partita e boss chiamato a mano
await page.locator("#dinoCampo").tap();
await pulisci();
await page.waitForTimeout(800);
const prima = await stato();
// le fasi registrate da dentro (dinoBossFase è una funzione globale)
await page.evaluate(() => {
  window.__fasi = ["attesa"];
  const orig = window.dinoBossFase;
  window.dinoBossFase = (b, f) => {
    window.__fasi.push(f);
    orig(b, f);
  };
});
await page.evaluate(() => window.__dinoBoss("prova"));
// le fasi in ordine, campionate
const viste = [];
const t0 = Date.now();
while (Date.now() - t0 < 12000) {
  const s = await stato();
  if (s.fase && viste[viste.length - 1] !== s.fase) viste.push(s.fase);
  if (s.fase === "arrivo" && !viste.includes("foto-arrivo")) {
    await page.waitForTimeout(500);
    await foto(page, `${OUT}/1-arrivo.png`);
    viste.push("foto-arrivo");
  }
  if (s.fase === "entra" && s.t > 250 && s.t < 450 && !viste.includes("foto-tendina")) {
    await foto(page, `${OUT}/2-tendina.png`);
    viste.push("foto-tendina");
  }
  if (s.fase === "gioco") break;
  await page.waitForTimeout(30);
}
const fasi = await page.evaluate(() => window.__fasi);
verifica(JSON.stringify(fasi) === JSON.stringify(["attesa", "sgombro", "arrivo", "incontro", "entra", "gioco"]), `fasi in ordine: ${fasi.join(" → ")}`);
let s = await stato();
verifica(s.stato === "corsa" && s.cab, "in gioco: stato corsa e classe .boss sul cabinato");
verifica(s.vel === 0.5, `corsa ferma durante il boss (velocità ${s.vel})`);
await page.waitForTimeout(400);
await foto(page, `${OUT}/3-gioco.png`);

// —— corsa, punti e velocità fermi durante il minigioco
const a = await stato();
await page.waitForTimeout(600);
const b = await stato();
verifica(a.corsa === b.corsa && a.punti === b.punti, `nel minigioco corsa e punti fermi (${a.corsa}/${b.corsa}, ${a.punti}/${b.punti})`);
verifica(b.t > a.t, "il tempo del boss va avanti");

// —— background: pausa, il boss si ferma; al ritorno «Pausa», un tocco riprende (e non vale per il minigioco)
await page.evaluate(() => {
  Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
});
s = await stato();
verifica(s.stato === "pausa", `background → pausa (${s.stato})`);
const tPausa = s.t;
await page.waitForTimeout(500);
await page.evaluate(() => {
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
});
await page.waitForTimeout(300);
s = await stato();
verifica(s.stato === "pausa" && s.t === tPausa, `in pausa il boss non va avanti (t ${tPausa} → ${s.t})`);
await foto(page, `${OUT}/4-pausa.png`);
await toccaCampo(170, 50); // a destra: in pausa NON deve vincere, solo riprendere
await page.waitForTimeout(100);
s = await stato();
verifica(s.stato === "corsa" && s.fase === "gioco", `il tocco in pausa riprende e basta (${s.stato}, ${s.fase})`);

// —— vittoria
const puntiPrima = s.punti;
await toccaCampo(170, 50);
await aspettaFase("esito", 2000);
await page.waitForTimeout(500);
await foto(page, `${OUT}/5-esito.png`);
await page.waitForFunction(() => !window.__dino.boss, null, { timeout: 5000 });
s = await stato();
verifica(s.stato === "corsa", `tornato a correre (${s.stato})`);
verifica(s.punti >= puntiPrima + 300, `premio: ${puntiPrima} → ${s.punti}`);
verifica(s.potere === "stella", `regalo: ${s.potere}`);
verifica(s.grazia > s.corsa, "grazia al ritorno");
verifica(s.vel === prima.vel || s.vel > 6, `velocità ridata (${s.vel})`);
verifica(s.coda && s.coda.w === 0 && s.coda.distacco > 100, `coda segnaposto: ${JSON.stringify(s.coda)}`);
verifica(s.bossVisti === 1, "bossVisti = 1");
verifica(!s.cab, "classe .boss tolta");
await page.waitForTimeout(150);
await foto(page, `${OUT}/6-ritorno.png`);
// strada libera: niente ostacoli nuovi per un po'
await page.evaluate(() => clearInterval(window.__pulisci));
await page.waitForTimeout(700);
s = await stato();
verifica(s.ostacoli === 0, `strada libera dopo il ritorno (${s.ostacoli} ostacoli)`);
await pulisci();

// —— sconfitta: game over (BOSS_SCONFITTA = "muori"), record salvato
await page.waitForTimeout(500);
await page.evaluate(() => window.__dinoBoss("prova"));
await aspettaFase("gioco", 20000);
await page.waitForTimeout(300); // BOSS_SORDO
await toccaCampo(30, 50);
await page.waitForFunction(() => window.__dino.stato === "fine", null, { timeout: 6000 });
s = await stato();
const causa = await page.evaluate(() => __dino.causa);
verifica(s.stato === "fine" && causa === "Battuto dal boss" && !s.fase, `sconfitta: game over «${causa}»`);

// —— niente salti col boss arrivato: un tocco nell'incontro non fa saltare
await page.waitForTimeout(600);
await page.evaluate(() => window.__dinoBoss("prova"));
await aspettaFase("incontro", 20000);
await page.locator("#dinoCampo").tap();
await page.waitForTimeout(80);
const y = await page.evaluate(() => window.__dino.y);
verifica(y === 0, `nell'incontro il tocco non fa saltare (y ${y})`);

console.log("OK:\n  " + ok.join("\n  "));
console.log("KO:\n  " + (ko.join("\n  ") || "nessuno"));
console.log("errori:", errori.length ? errori : "nessuno");
await browser.close();
process.exit(ko.length || errori.length ? 1 : 0);
