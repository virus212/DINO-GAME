// Fase 4: lo scimmione. Incontro (petto, dino stordito), tendina, partita
// giocata da un «dito» (cammina verso la scala, trascina su e sale, tocco e
// salta), poi un aiutino sul tempo fino in cima; gag di vittoria (Godzilla,
// ritorno con la Stella) e di sconfitta (calcio, game over).
// Uso: node boss-scimmione.mjs <cartella-foto> [verticale|orizzontale]
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
  await foto(page, `${OUT}/${P}-sc-${nome}.png`, oriz);
};
const campo = () =>
  page.evaluate(() => {
    const r = document.getElementById("dinoCanvas").getBoundingClientRect();
    const c = dinoBossCampo(__dino.boss);
    return { r: { left: r.left, top: r.top, width: r.width, height: r.height }, c, w: __dino.w, h: __dino.h };
  });
const pagina = (m, ux, uy) => ({ x: m.r.left + ((m.c.x + ux) / m.w) * m.r.width, y: m.r.top + ((m.c.y + uy) / m.h) * m.r.height });
const stato = () => page.evaluate(() => { const g = __dino.boss && __dino.boss.gioco; return g && g.d ? { x: g.d.x, y: g.d.y, piano: g.d.piano, scala: !!g.d.scala, aria: g.d.aria, punti: g.punti, barili: g.barili.length, fase: __dino.boss.fase } : null; });

await page.locator("#dinoCampo").tap();
await page.evaluate(() => {
  window.__dinoSeme = 7;
  window.__pulisci = setInterval(() => (__dino.ostacoli = __dino.ostacoli.filter((o) => o.x > 90 || o.x + o.w < 0)), 20);
  window.__suoni = [];
  const o = window.dinoSuono;
  window.dinoSuono = (n) => (window.__suoni.push(n), o(n));
  window.__dinoBoss("scimmione");
});
await scatta("arrivo", 900, "1-arrivo");
await scatta("incontro", 700, "2-petto");
await scatta("incontro", 1500, "3-stordito");
await scatta("entra", 330, "4-tendina");
await page.waitForFunction(() => __dino.boss && __dino.boss.fase === "gioco" && __dino.boss.t > 400, null, { timeout: 5000 });
// —— la partita vera, SENZA barare: il dito tiene premuto sulla scala più
// vicina e trascina su (il dino ci va e sale); se un barile o una fiammella
// arriva sulla sua trave lo lascia, si ferma e tocca: salto sul posto per i
// barili, verso la fiammella per scavalcarla
const gioca = async (pianoMeta, tempoMax) => {
  let giu = false;
  let pianoPrima = -1;
  let salti = 0;
  let fotoMeta = false;
  const t0 = Date.now();
  while (Date.now() - t0 < tempoMax) {
    const st = await page.evaluate(() => {
      const b = __dino.boss;
      if (!b || b.fase !== "gioco") return null;
      const g = b.gioco;
      const d = g.d;
      const pericoli = [
        ...g.barili.filter((o) => o.stato === "rotola").map((o) => ({ x: o.x, piano: o.piano, v: SC_TRAVI[o.piano].dir, fiamma: false })),
        ...g.fiamme.filter((f) => !f.scala && g.t - f.nasce >= 400).map((f) => ({ x: f.x, piano: f.piano, v: f.dir, fiamma: true })),
      ]
        .filter((o) => o.piano === d.piano && (d.x - o.x) * o.v > 0)
        .map((o) => ({ ...o, dist: Math.abs(o.x - d.x) }))
        .sort((a, b) => a.dist - b.dist);
      const scale = SC_SCALE.filter((s) => !s.rotta && s.da === d.piano).sort((a, b) => Math.abs(a.x - d.x) - Math.abs(b.x - d.x));
      return { x: d.x, y: d.y, piano: d.piano, scala: !!d.scala, aria: d.aria, vite: g.vite, pericolo: pericoli[0] || null, meta: scale[0] ? scale[0].x : null };
    });
    if (!st || st.piano >= pianoMeta) break;
    if (st.piano === 3 && !fotoMeta) {
      fotoMeta = true;
      await foto(page, `${OUT}/${P}-sc-5-gioco.png`, oriz);
    }
    if (st.piano !== pianoPrima && !st.scala && giu) {
      await page.mouse.up();
      giu = false;
    }
    pianoPrima = st.scala ? pianoPrima : st.piano;
    const m = await campo();
    const p = st.pericolo;
    if (!st.scala && !st.aria && p && p.dist < 30) {
      if (giu) {
        await page.mouse.up();
        giu = false;
      }
      const [da, a] = p.fiamma ? [9, 18] : [8, 14];
      if (p.dist >= da && p.dist <= a) {
        const q = pagina(m, st.x + (p.fiamma ? Math.sign(p.x - st.x) * 20 : 0), st.y - 6);
        await page.mouse.click(q.x, q.y);
        salti++;
        await page.waitForTimeout(120);
      }
      await page.waitForTimeout(10);
      continue;
    }
    if (!giu && !st.aria && st.meta !== null) {
      const q = pagina(m, st.meta, st.y - 4);
      await page.mouse.move(q.x, q.y);
      await page.mouse.down();
      giu = true;
      await page.waitForTimeout(40);
      const q2 = pagina(m, st.meta, st.y - 22);
      await page.mouse.move(q2.x, q2.y, { steps: 3 });
    }
    await page.waitForTimeout(25);
  }
  if (giu) await page.mouse.up();
  return salti;
};
const salti = await gioca(6, 58000);
await page.waitForFunction(() => !__dino.boss || __dino.boss.fase !== "gioco" || __dino.boss.gioco.esito, null, { timeout: 5000 }).catch(() => {});
const fineGiro = await page.evaluate(() => ({ fase: __dino.boss && __dino.boss.fase, esito: __dino.boss && __dino.boss.gioco && __dino.boss.gioco.esito, t: __dino.boss && __dino.boss.gioco && Math.round(__dino.boss.gioco.t), vite: __dino.boss && __dino.boss.gioco && __dino.boss.gioco.vite, punti: __dino.boss && __dino.boss.gioco && __dino.boss.gioco.punti }));
verifica(fineGiro.esito === "vinto", `partita vera col dito, senza trucchi, fino in cima: ${JSON.stringify(fineGiro)} salti ${salti}`);
await scatta("esito", 300, "8-vinto-godzilla");
await scatta("esito", 900, "9-vinto-soffio");
await scatta("esito", 1550, "10-vinto-arrosto");
await page.waitForFunction(() => !__dino.boss, null, { timeout: 6000 });
const dopo = await page.evaluate(() => ({ stato: __dino.stato, y: __dino.y, potere: __dino.potere && __dino.potere.tipo }));
verifica(dopo.stato === "corsa" && dopo.y === 0 && dopo.potere === "stella", `vittoria: si torna a correre con la Stella ${JSON.stringify(dopo)}`);
await page.waitForTimeout(200);
await foto(page, `${OUT}/${P}-sc-11-ritorno.png`, oriz);

// —— secondo giro: tastiera, tocco, fuoco, martello; poi la sconfitta
await page.waitForTimeout(900);
await page.evaluate(() => {
  __dino.potere = null;
  __dino.grazia = 0;
  window.__dinoBoss("scimmione");
});
await page.waitForFunction(() => __dino.boss && __dino.boss.fase === "gioco" && __dino.boss.t > 400, null, { timeout: 25000 });
// tastiera: alla scala buona più vicina con le frecce, poi su
const sc = await page.evaluate(() => {
  const d = __dino.boss.gioco.d;
  const s = SC_SCALE.filter((s) => !s.rotta && s.da === d.piano).sort((a, b) => Math.abs(a.x - d.x) - Math.abs(b.x - d.x))[0];
  return { x: s.x, piano: d.piano, dx: d.x };
});
const freccia = sc.x < sc.dx ? "ArrowLeft" : "ArrowRight";
await page.keyboard.down(freccia);
await page.waitForFunction((x) => Math.abs(__dino.boss.gioco.d.x - x) < 4, sc.x, { timeout: 8000 }).catch(() => {});
await page.keyboard.up(freccia);
await page.keyboard.down("ArrowUp");
await page.waitForFunction((p) => __dino.boss.gioco.d.piano > p, sc.piano, { timeout: 5000 }).catch(() => {});
await page.keyboard.up("ArrowUp");
const s3 = await stato();
verifica(s3 && s3.piano > sc.piano, `tastiera: frecce fino alla scala e su, trave ${sc.piano} -> ${s3 && s3.piano}`);
await foto(page, `${OUT}/${P}-sc-6-gioco.png`, oriz);
// tocco breve vicino al dino: salto sul posto (e mai un passo)
{
  const qui = await stato();
  const mm = await campo();
  const pt = pagina(mm, qui.x, qui.y - 6);
  await page.mouse.click(pt.x, pt.y);
  await page.waitForTimeout(90);
  const su = await stato();
  verifica(su.aria && Math.abs(su.x - qui.x) < 0.01, `tocco breve: salta sul posto ${JSON.stringify({ prima: qui.x, dopo: su.x, aria: su.aria })}`);
  await page.waitForTimeout(600);
}
// da qui le prove delle singole cose: niente vite perse
await page.evaluate(() => {
  window.__scAddosso = scAddosso;
  scAddosso = () => false;
});
// il barile blu ha acceso il bidone ed è uscita la fiammella
const fuoco = await page.evaluate(() => ({ acceso: __dino.boss.gioco.acceso, fiamme: __dino.boss.gioco.fiamme.length, lanci: __dino.boss.gioco.lanci }));
verifica(fuoco.acceso && fuoco.fiamme >= 1, `bidone acceso dal barile blu, fiammelle in giro ${JSON.stringify(fuoco)}`);
// il martello: sotto quello della trave 1, salto, e un barile spaccato
await page.evaluate(() => {
  const g = __dino.boss.gioco;
  Object.assign(g.d, { piano: 1, x: 168, y: scSu(1, 168), verso: -1, scala: null, aria: false });
  g.barili = [];
});
await page.keyboard.press(" ");
await page.waitForFunction(() => __dino.boss.gioco.martello > 0, null, { timeout: 3000 }).catch(() => {});
const punti0 = await page.evaluate(() => __dino.boss.gioco.punti);
await page.evaluate(() => {
  const g = __dino.boss.gioco;
  g.barili.push({ x: 140, y: scSu(1, 140), piano: 1, stato: "rotola", blu: false, vy: 0, dx: 0, giro: 0, ultima: null, saltato: false, scala: null });
});
await page.waitForFunction((p0) => __dino.boss.gioco.punti >= p0 + 300, punti0, { timeout: 4000 }).catch(() => {});
await foto(page, `${OUT}/${P}-sc-6b-martello.png`, oriz);
const mart = await page.evaluate(() => ({ martello: Math.round(__dino.boss.gioco.martello), punti: __dino.boss.gioco.punti }));
verifica(mart.martello > 0 && mart.punti >= punti0 + 300, `martello preso saltando, barile spaccato ${JSON.stringify(mart)}`);
await page.evaluate(() => (__dino.boss.gioco.martello = 0));
const suoni = await page.evaluate(() => [...new Set(window.__suoni)].join(","));
verifica(/sc_petto/.test(suoni) && /sc_lancio/.test(suoni) && /sc_salto/.test(suoni) && /sc_fuoco/.test(suoni) && /sc_martello1/.test(suoni) && /sc_spacca/.test(suoni), `suoni: ${suoni}`);
await page.evaluate(() => (scAddosso = window.__scAddosso));
// —— sconfitta: ultima vita e un barile addosso
await page.evaluate(() => {
  const g = __dino.boss.gioco;
  g.vite = 1;
  g.prossimoBarile = 1e9;
  g.invulnerabile = 0;
  g.martello = 0;
  g.fiamme = [];
  g.barili = [{ x: g.d.x + 3, y: g.d.y, piano: g.d.piano, stato: "rotola", vy: 0, dx: 0, giro: 0, ultima: null, saltato: false, scala: null }];
});
await scatta("esito", 500, "12-perso-salto");
await scatta("esito", 1200, "13-perso-calcio");
await page.waitForFunction(() => __dino.stato === "fine", null, { timeout: 6000 });
const fine = await page.evaluate(() => ({ causa: __dino.causa, y: __dino.y }));
verifica(fine.causa === "Battuto dal boss" && fine.y === 0, `sconfitta: game over ${JSON.stringify(fine)}`);
await page.waitForTimeout(300);
await foto(page, `${OUT}/${P}-sc-14-gameover.png`, oriz);

console.log("OK:\n  " + ok.join("\n  "));
console.log("KO:\n  " + (ko.join("\n  ") || "nessuno"));
console.log("errori:", errori.length ? errori : "nessuno");
await browser.close();
process.exit(ko.length || errori.length ? 1 : 0);
