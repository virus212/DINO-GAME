// Fase 4: lo scimmione. Incontro (petto, dino stordito), tendina, partita
// giocata coi comandi a schermo (Vitto 09/10): la levetta col «mouse» (giù
// sul centro, poi scivola verso la scala, su per salire), il pulsante con
// un tocco vero dell'altro dito; poi le prove dei comandi uno per uno (levetta
// a destra, su vicino alla scala, pulsante, due dita insieme, rilascio in
// pausa, un dito solo dalla levetta al pulsante, pollice tenuto dalla pausa),
// la tastiera, il martello, le gag sulla strada di vittoria (Godzilla,
// ritorno con la Stella) e di sconfitta (carica, game over). In verticale
// anche il banner stretto dell'iPhone da 375 pt, dove i comandi sporgono sul
// campo, e il pollice appoggiato già durante la tendina.
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
// le misure di adesso: canvas in pagina, campo e comandi (unità del campo)
const misure = (pg) =>
  pg.evaluate(() => {
    const r = document.getElementById("dinoCanvas").getBoundingClientRect();
    const c = dinoBossCampo(__dino.boss);
    return { r: { left: r.left, top: r.top, width: r.width, height: r.height }, c, w: __dino.w, h: __dino.h, k: scComandi(c.x), margine: __dino.margine, margineDx: __dino.margineDx };
  });
const pagina = (m, ux, uy) => ({ x: m.r.left + ((m.c.x + ux) / m.w) * m.r.width, y: m.r.top + ((m.c.y + uy) / m.h) * m.r.height });
// il centro della levetta (dove il pollice la tiene ferma) e del pulsante
const centroLev = (m) => ({ x: m.k.lev.x, y: m.k.lev.y - 3 });
const centroPul = (m) => ({ x: m.k.pul.x, y: m.k.pul.y - 2 });
const stato = (pg = page) =>
  pg.evaluate(() => {
    const g = __dino.boss && __dino.boss.gioco;
    return g && g.d ? { x: g.d.x, y: g.d.y, piano: g.d.piano, scala: !!g.d.scala, aria: g.d.aria, vx: g.d.vx, verso: g.d.verso, punti: g.punti, barili: g.barili.length, fase: __dino.boss.fase, levetta: g.levetta, pulsante: g.pulsante } : null;
  });
/** Un dito sintetico col suo id (più dita insieme): giù sul canvas, su e
 * muovi sulla finestra, come il dito vero (dinoBossPuntatore). */
const dito = (pg, tipo, id, ux, uy) =>
  pg.evaluate(
    ([tipo, id, ux, uy]) => {
      const cv = document.getElementById("dinoCanvas");
      const r = cv.getBoundingClientRect();
      const c = dinoBossCampo(__dino.boss);
      const ev = new PointerEvent(tipo, { pointerId: id, clientX: r.left + ((c.x + ux) / __dino.w) * r.width, clientY: r.top + ((c.y + uy) / __dino.h) * r.height, bubbles: true, cancelable: true, pointerType: "touch", isPrimary: false, button: 0 });
      (tipo === "pointerdown" ? cv : window).dispatchEvent(ev);
    },
    [tipo, id, ux, uy],
  );
/** La levetta tenuta col mouse: giù sul centro, poi il dito scivola nella
 * direzione [ox, oy] (null = la lascia). */
const levetta = (pg) => {
  let giu = false;
  let ora = "";
  return async (dir) => {
    if (!dir) {
      if (giu) await pg.mouse.up();
      giu = false;
      ora = "";
      return;
    }
    if (giu && ora === String(dir)) return;
    const m = await misure(pg);
    const c = centroLev(m);
    if (!giu) {
      const q = pagina(m, c.x, c.y);
      await pg.mouse.move(q.x, q.y);
      await pg.mouse.down();
      giu = true;
    }
    const q = pagina(m, c.x + dir[0] * 12, c.y + dir[1] * 12);
    await pg.mouse.move(q.x, q.y);
    ora = String(dir);
  };
};
/** Il pulsante: un tocco vero (un altro dito, anche col mouse giù). */
const premi = async (pg) => {
  const m = await misure(pg);
  const c = centroPul(m);
  const q = pagina(m, c.x, c.y);
  await pg.touchscreen.tap(q.x, q.y);
};

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
await scatta("gioco", 600, "4b-aiuto");
// i comandi stanno dentro la parte visibile del banner (isola compresa), in basso
{
  const m = await misure(page);
  const vis = (x) => x - 12 >= m.margine - m.c.x - 0.01 && x + 12 <= m.w - m.margineDx - m.c.x + 0.01;
  const fuori = m.k.lev.x + 12 <= 0 && m.k.pul.x - 12 >= 256;
  verifica(vis(m.k.lev.x) && vis(m.k.pul.x) && m.k.lev.y + 10 <= m.h - m.c.y, `comandi visibili ${JSON.stringify(m.k)} (banner ${m.w.toFixed(1)}, campo da ${m.c.x})${fuori ? ", fuori dal campo" : ""}`);
}
// —— la partita vera, SENZA barare: la levetta porta il dino alla scala
// più vicina e lo fa salire; se un barile o una fiammella arriva sulla sua
// trave la rimette al centro e preme il pulsante: salto sul posto per i
// barili, in corsa verso la fiammella (levetta e pulsante insieme)
const gioca = async (pianoMeta, tempoMax) => {
  const leva = levetta(page);
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
    const p = st.pericolo;
    if (!st.scala && !st.aria && p && p.dist < 30) {
      if (p.fiamma && p.dist >= 9 && p.dist <= 18) {
        await leva([Math.sign(p.x - st.x), 0]);
        await premi(page);
        salti++;
        await page.waitForTimeout(120);
      } else {
        await leva([0, 0]);
        if (!p.fiamma && p.dist >= 8 && p.dist <= 14) {
          await premi(page);
          salti++;
          await page.waitForTimeout(120);
        }
      }
      await page.waitForTimeout(10);
      continue;
    }
    if (st.scala) await leva([0, -1]);
    else if (st.meta !== null) await leva(Math.abs(st.meta - st.x) > 6 ? [Math.sign(st.meta - st.x), 0] : [0, -1]);
    await page.waitForTimeout(25);
  }
  await leva(null);
  return salti;
};
const salti = await gioca(6, 58000);
await page.waitForFunction(() => !__dino.boss || __dino.boss.fase !== "gioco" || __dino.boss.gioco.esito, null, { timeout: 5000 }).catch(() => {});
const fineGiro = await page.evaluate(() => ({ fase: __dino.boss && __dino.boss.fase, esito: __dino.boss && __dino.boss.gioco && __dino.boss.gioco.esito, t: __dino.boss && __dino.boss.gioco && Math.round(__dino.boss.gioco.t), vite: __dino.boss && __dino.boss.gioco && __dino.boss.gioco.vite, punti: __dino.boss && __dino.boss.gioco && __dino.boss.gioco.punti }));
verifica(fineGiro.esito === "vinto", `partita vera coi comandi, senza trucchi, fino in cima: ${JSON.stringify(fineGiro)} salti ${salti}`);
await scatta("esito", 300, "8-vinto-godzilla");
await scatta("esito", 900, "9-vinto-soffio");
await scatta("esito", 1550, "10-vinto-arrosto");
await page.waitForFunction(() => !__dino.boss, null, { timeout: 6000 });
const dopo = await page.evaluate(() => ({ stato: __dino.stato, y: __dino.y, potere: __dino.potere && __dino.potere.tipo }));
verifica(dopo.stato === "corsa" && dopo.y === 0 && dopo.potere === "stella", `vittoria: si torna a correre con la Stella ${JSON.stringify(dopo)}`);
await page.waitForTimeout(200);
await foto(page, `${OUT}/${P}-sc-11-ritorno.png`, oriz);

// —— secondo giro: tastiera, comandi uno per uno, fuoco, martello; poi la sconfitta
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
// da qui le prove delle singole cose: niente vite perse
await page.evaluate(() => {
  window.__scAddosso = scAddosso;
  scAddosso = () => false;
});

/** I comandi a schermo uno per uno (anche sul banner da 375 pt). */
async function provaComandi(pg, pre, dove) {
  const leva = levetta(pg);
  const metti = (x, piano) =>
    pg.evaluate(
      ([x, piano]) => {
        const g = __dino.boss.gioco;
        Object.assign(g.d, { piano, x, y: scSu(piano, x), verso: 1, scala: null, aria: false, vy: 0, vx: 0 });
        g.barili = [];
        g.fiamme = [];
        g.martello = 0;
        g.prossimoBarile = 1e9;
        g.camminava = -1e9;
      },
      [x, piano],
    );
  // a riposo
  await metti(150, 1);
  await pg.waitForTimeout(120);
  await foto(pg, `${OUT}/${pre}-sc-7-comandi-riposo.png`, oriz && pg === page);
  // levetta a destra: cammina a destra (e il dito si lega alla levetta)
  await metti(60, 1);
  await leva([1, 0]);
  const l1 = await stato(pg);
  await pg.waitForTimeout(400);
  const l2 = await stato(pg);
  await leva(null);
  await pg.waitForTimeout(60);
  const l3 = await stato(pg);
  verifica(l1.levetta && l1.levetta.oriz === 1 && l2.x > l1.x + 8 && l2.verso === 1 && !l3.levetta && !l3.aria, `${dove}: levetta a destra, cammina a destra ${JSON.stringify({ da: l1.x, a: l2.x, levetta: l1.levetta, lasciata: l3.levetta })}`);
  // levetta a sinistra
  await leva([-1, 0]);
  const s1 = await stato(pg);
  await pg.waitForTimeout(300);
  const s2 = await stato(pg);
  await leva(null);
  verifica(s2.x < s1.x - 6 && s2.verso === -1, `${dove}: levetta a sinistra, cammina a sinistra ${JSON.stringify({ da: s1.x, a: s2.x })}`);
  // levetta su a 8 unità da una scala: il dino ci va e sale
  await metti(112, 1);
  await leva([0, -1]);
  await pg.waitForFunction(() => __dino.boss.gioco.d.piano > 1, null, { timeout: 5000 }).catch(() => {});
  const su = await stato(pg);
  await leva(null);
  verifica(su.piano === 2, `${dove}: levetta su vicino alla scala, sale ${JSON.stringify({ piano: su.piano, x: su.x })}`);
  // e giù: dalla trave 2 scende per la stessa scala
  await leva([0, 1]);
  await pg.waitForFunction(() => __dino.boss.gioco.d.piano === 1 && !__dino.boss.gioco.d.scala, null, { timeout: 5000 }).catch(() => {});
  const giu = await stato(pg);
  await leva(null);
  verifica(giu.piano === 1, `${dove}: levetta giù, riscende ${JSON.stringify({ piano: giu.piano })}`);
  // il pulsante da solo: salto sul posto
  await metti(150, 1);
  await pg.waitForTimeout(60);
  const p0 = await stato(pg);
  await premi(pg);
  await pg.waitForTimeout(90);
  const p1 = await stato(pg);
  verifica(p1.aria && Math.abs(p1.x - p0.x) < 0.01, `${dove}: pulsante, salto sul posto ${JSON.stringify({ prima: p0.x, dopo: p1.x, aria: p1.aria })}`);
  await pg.waitForTimeout(600);
  // il pulsante anche in alto a destra (zona a tutta altezza)
  await dito(pg, "pointerdown", 61, 200, 4);
  await pg.waitForTimeout(60);
  const alto = await stato(pg);
  await dito(pg, "pointerup", 61, 200, 4);
  verifica(alto.aria, `${dove}: tocco in alto a destra, salta lo stesso`);
  await pg.waitForTimeout(600);
  // due dita insieme: levetta a destra (id 21) e pulsante (id 22) = salto in corsa
  await metti(120, 1);
  const m = await misure(pg);
  const cl = centroLev(m);
  const cp = centroPul(m);
  await dito(pg, "pointerdown", 21, cl.x, cl.y);
  await dito(pg, "pointermove", 21, cl.x + 12, cl.y - 2);
  await pg.waitForTimeout(150);
  await dito(pg, "pointerdown", 22, cp.x, cp.y);
  await pg.waitForTimeout(40);
  await foto(pg, `${OUT}/${pre}-sc-7b-comandi-premuti.png`, oriz && pg === page);
  const due = await stato(pg);
  verifica(due.aria && due.vx > 0 && due.levetta && due.levetta.id === 21 && due.pulsante && due.pulsante.id === 22, `${dove}: levetta + pulsante insieme (due dita), salto in corsa ${JSON.stringify({ aria: due.aria, vx: due.vx, levetta: due.levetta, pulsante: due.pulsante })}`);
  await dito(pg, "pointerup", 22, cp.x, cp.y);
  await dito(pg, "pointerup", 21, cl.x + 12, cl.y);
  await pg.waitForTimeout(600);
  // un dito solo: levetta a destra, lasciata, e subito il pulsante → salto in
  // corsa (le fiammelle si scavalcano solo così). Da x 60: il salto (~38
  // unità) non deve arrivare al martello della trave 1 (x 168)
  await metti(60, 1);
  await dito(pg, "pointerdown", 71, cl.x, cl.y);
  await dito(pg, "pointermove", 71, cl.x + 12, cl.y);
  await pg.waitForTimeout(200);
  await dito(pg, "pointerup", 71, cl.x + 12, cl.y);
  await pg.waitForTimeout(120);
  await dito(pg, "pointerdown", 72, cp.x, cp.y);
  await pg.waitForTimeout(40);
  const uno = await stato(pg);
  await dito(pg, "pointerup", 72, cp.x, cp.y);
  verifica(uno.aria && uno.vx > 0 && !uno.levetta, `${dove}: un dito solo, dalla levetta al pulsante: salto in corsa ${JSON.stringify({ aria: uno.aria, vx: uno.vx })}`);
  await pg.waitForTimeout(600);
  // il pollice appoggiato un po' alto, a 8 unità da una scala: fermo (la
  // levetta parte da dove lo appoggi), poi spinto su: sale
  await metti(112, 1);
  await dito(pg, "pointerdown", 75, cl.x, cl.y - 6);
  await pg.waitForTimeout(400);
  const fermo = await stato(pg);
  await dito(pg, "pointermove", 75, cl.x, cl.y - 6 - 12);
  await pg.waitForFunction(() => __dino.boss.gioco.d.piano > 1, null, { timeout: 5000 }).catch(() => {});
  const spinto = await stato(pg);
  await dito(pg, "pointerup", 75, cl.x, cl.y - 18);
  verifica(fermo.piano === 1 && fermo.x === 112 && fermo.levetta && fermo.levetta.oriz === 0 && fermo.levetta.vert === 0 && spinto.piano === 2, `${dove}: pollice appoggiato fuori centro fermo, spinto su sale ${JSON.stringify({ fermo: [fermo.piano, fermo.x], levetta: fermo.levetta, poi: spinto.piano })}`);
  // un secondo dito (il palmo) sulla levetta già tenuta non la ruba
  await metti(60, 1);
  await dito(pg, "pointerdown", 73, cl.x, cl.y);
  await dito(pg, "pointermove", 73, cl.x + 12, cl.y);
  await dito(pg, "pointerdown", 74, cl.x - 6, cl.y + 4);
  const palmo = await stato(pg);
  await dito(pg, "pointerup", 74, cl.x - 6, cl.y + 4);
  const dopoPalmo = await stato(pg);
  await dito(pg, "pointerup", 73, cl.x + 12, cl.y);
  verifica(palmo.levetta && palmo.levetta.id === 73 && palmo.levetta.oriz === 1 && dopoPalmo.levetta && dopoPalmo.levetta.id === 73, `${dove}: il secondo dito sulla levetta tenuta non la ruba ${JSON.stringify({ palmo: palmo.levetta, dopo: dopoPalmo.levetta })}`);
  await pg.waitForTimeout(100);
  // il dito della levetta scivola nella metà del pulsante: resta levetta (a destra)
  await metti(120, 1);
  await dito(pg, "pointerdown", 31, cl.x, cl.y);
  await dito(pg, "pointermove", 31, 220, cl.y);
  const scivola = await stato(pg);
  await dito(pg, "pointerup", 31, 220, cl.y);
  const via = await stato(pg);
  verifica(scivola.levetta && scivola.levetta.oriz === 1 && !scivola.pulsante && !scivola.aria && !via.levetta, `${dove}: la levetta segue il dito anche di là ${JSON.stringify(scivola.levetta)}`);
  // direttamente col minigioco: due id, poi il rilascio solo per id
  const k0 = (await misure(pg)).k;
  // lontano dal centro (oltre SC_LEV_AGGANCIO) la levetta parte dal centro
  const diretto = await pg.evaluate(() => {
    const g = __dino.boss.gioco;
    const k = scComandi(dinoBossCampo(__dino.boss).x);
    const gioco = BOSS_GIOCHI.scimmione;
    gioco.dito(g, { tipo: "giu", x: k.lev.x, y: k.lev.y - 3 - 20, id: 41 });
    gioco.dito(g, { tipo: "giu", x: k.pul.x, y: k.pul.y, id: 42 });
    const insieme = { levetta: { ...g.levetta }, pulsante: { ...g.pulsante }, salta: g.salta };
    gioco.dito(g, { tipo: "su", x: NaN, y: NaN, id: 42 });
    const dopoPul = { levetta: !!g.levetta, pulsante: !!g.pulsante };
    gioco.dito(g, { tipo: "su", x: NaN, y: NaN, id: 41 });
    return { insieme, dopoPul, fine: { levetta: g.levetta, pulsante: g.pulsante } };
  });
  verifica(diretto.insieme.levetta.vert === -1 && diretto.insieme.levetta.ox === k0.lev.x && diretto.insieme.levetta.oriz === 0 && diretto.insieme.pulsante.id === 42 && diretto.insieme.salta && diretto.dopoPul.levetta && !diretto.dopoPul.pulsante && !diretto.fine.levetta && !diretto.fine.pulsante, `${dove}: dito() con due id, rilascio per id ${JSON.stringify(diretto)}`);
  await pg.waitForTimeout(600);
  // rilascio in pausa: levetta e pulsante tenuti, pausa, le dita si alzano → liberi
  await metti(150, 1);
  await leva([1, 0]);
  await dito(pg, "pointerdown", 52, cp.x, cp.y);
  await pg.waitForTimeout(60);
  const tenuti = await stato(pg);
  await pg.evaluate(() => (__dino.stato = "pausa"));
  await leva(null);
  await dito(pg, "pointerup", 52, cp.x, cp.y);
  const inPausa = await pg.evaluate(() => ({ stato: __dino.stato, levetta: __dino.boss.gioco.levetta, pulsante: __dino.boss.gioco.pulsante, dita: __dino.boss.dita.size }));
  verifica(tenuti.levetta && tenuti.pulsante && inPausa.stato === "pausa" && !inPausa.levetta && !inPausa.pulsante && inPausa.dita === 0, `${dove}: rilascio in pausa, tutto libero ${JSON.stringify({ tenuti: [!!tenuti.levetta, !!tenuti.pulsante], inPausa })}`);
  // si riprende toccando, e il dino resta fermo (nessun comando rimasto giù)
  await pg.locator("#dinoCampo").tap();
  await pg.waitForTimeout(700); // il salto partito prima della pausa atterra
  const r0 = await stato(pg);
  await pg.waitForTimeout(300);
  const r1 = await stato(pg);
  verifica(r1.x === r0.x && !r1.levetta && !r1.pulsante && (await pg.evaluate(() => __dino.stato)) === "corsa", `${dove}: ripreso, dino fermo ${JSON.stringify({ x0: r0.x, x1: r1.x })}`);
  // il pollice resta sulla levetta in pausa (background) e alla ripresa
  // (tocco di un altro dito) torna a contare dal primo movimento
  await metti(60, 1);
  await dito(pg, "pointerdown", 81, cl.x, cl.y);
  const nascondi = (v) =>
    pg.evaluate((v) => {
      Object.defineProperty(document, "visibilityState", { value: v, configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    }, v);
  await nascondi("hidden");
  await nascondi("visible");
  await pg.locator("#dinoCampo").tap();
  await pg.waitForTimeout(60);
  const ripreso = await pg.evaluate(() => ({ stato: __dino.stato, levetta: __dino.boss.gioco.levetta, sordi: [...__dino.boss.sordi] }));
  await dito(pg, "pointermove", 81, cl.x + 1, cl.y);
  await dito(pg, "pointermove", 81, cl.x + 13, cl.y);
  const t0 = await stato(pg);
  await pg.waitForTimeout(300);
  const t1 = await stato(pg);
  await dito(pg, "pointerup", 81, cl.x + 13, cl.y);
  const lasciato = await pg.evaluate(() => ({ dita: __dino.boss.dita.size, sordi: __dino.boss.sordi.size, levetta: __dino.boss.gioco.levetta }));
  verifica(ripreso.stato === "corsa" && !ripreso.levetta && ripreso.sordi.includes(81) && t0.levetta && t0.levetta.id === 81 && t0.levetta.oriz === 1 && t1.x > t0.x + 4 && !lasciato.dita && !lasciato.sordi && !lasciato.levetta, `${dove}: pollice tenuto dalla pausa, alla ripresa conta muovendolo ${JSON.stringify({ ripreso, da: t0.x, a: t1.x, lasciato })}`);
}
// il barile blu ha acceso il bidone ed è uscita la fiammella
const fuoco = await page.evaluate(() => ({ acceso: __dino.boss.gioco.acceso, fiamme: __dino.boss.gioco.fiamme.length, lanci: __dino.boss.gioco.lanci }));
verifica(fuoco.acceso && fuoco.fiamme >= 1, `bidone acceso dal barile blu, fiammelle in giro ${JSON.stringify(fuoco)}`);
await provaComandi(page, P, oriz ? "852x393 schermo intero" : "393x852");
// il martello: sotto quello della trave 1, salto, e un barile spaccato
await page.evaluate(() => {
  const g = __dino.boss.gioco;
  Object.assign(g.d, { piano: 1, x: 168, y: scSu(1, 168), verso: -1, scala: null, aria: false });
  g.barili = [];
  g.camminava = -1e9; // fermo da un po': salto sul posto (SC_SALTO_MEMORIA)
  g.martelli.forEach((m) => (m.preso = false)); // le prove dei comandi ci saltano sopra
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
await scatta("esito", 500, "12-perso-carica");
await scatta("esito", 1200, "13-perso-volo");
await page.waitForFunction(() => __dino.stato === "fine", null, { timeout: 6000 });
const fine = await page.evaluate(() => ({ causa: __dino.causa, y: __dino.y }));
verifica(fine.causa === "Battuto dal boss" && fine.y === 0, `sconfitta: game over ${JSON.stringify(fine)}`);
await page.waitForTimeout(300);
await foto(page, `${OUT}/${P}-sc-14-gameover.png`, oriz);
await browser.close();

// —— in verticale anche l'iPhone da 375 pt: banner di 295 unità, 20 per lato
// accanto al campo, i comandi sporgono un poco sul campo (in trasparenza)
if (!oriz) {
  const stretto = await apri({ largo: 375, alto: 812 });
  const pg = stretto.page;
  await pg.locator("#dinoCampo").tap();
  await pg.evaluate(() => {
    window.__dinoSeme = 7;
    window.__pulisci = setInterval(() => (__dino.ostacoli = __dino.ostacoli.filter((o) => o.x > 90 || o.x + o.w < 0)), 20);
    window.__dinoBoss("scimmione");
  });
  // il pollice appoggiato sulla levetta già durante la tendina (il minigioco
  // non ascolta ancora): conta dal primo movimento, senza rialzarlo
  await pg.waitForFunction(() => __dino.boss && __dino.boss.fase === "entra" && __dino.boss.t > 600, null, { timeout: 25000 });
  const cl0 = centroLev(await misure(pg));
  await dito(pg, "pointerdown", 91, cl0.x, cl0.y);
  await pg.waitForFunction(() => __dino.boss && __dino.boss.fase === "gioco" && __dino.boss.t > 400, null, { timeout: 25000 });
  const prima = await stato(pg);
  await dito(pg, "pointermove", 91, cl0.x + 1, cl0.y);
  await dito(pg, "pointermove", 91, cl0.x + 13, cl0.y);
  const mosso = await stato(pg);
  await pg.waitForTimeout(250);
  const andato = await stato(pg);
  await dito(pg, "pointerup", 91, cl0.x + 13, cl0.y);
  const via = await pg.evaluate(() => ({ dita: __dino.boss.dita.size, sordi: __dino.boss.sordi.size, levetta: __dino.boss.gioco.levetta }));
  verifica(!prima.levetta && mosso.levetta && mosso.levetta.id === 91 && mosso.levetta.oriz === 1 && andato.x > mosso.x + 3 && !via.dita && !via.sordi && !via.levetta, `375x812: pollice giù dalla tendina, conta al primo movimento ${JSON.stringify({ prima: prima.levetta, mosso: mosso.levetta, da: mosso.x, a: andato.x, via })}`);
  const m = await misure(pg);
  verifica(m.k.lev.x - 12 >= m.margine - m.c.x - 0.01 && m.k.pul.x + 12 <= m.w - m.c.x + 0.01 && m.k.lev.x - 12 < 0, `375x812: comandi visibili, sporgono sul campo ${JSON.stringify(m.k)} (banner ${m.w.toFixed(1)}, campo da ${m.c.x})`);
  await pg.evaluate(() => (scAddosso = () => false));
  await provaComandi(pg, "v375", "375x812");
  errori.push(...stretto.errori.map((e) => `375: ${e}`));
  await stretto.browser.close();
}

console.log("OK:\n  " + ok.join("\n  "));
console.log("KO:\n  " + (ko.join("\n  ") || "nessuno"));
console.log("errori:", errori.length ? errori : "nessuno");
process.exit(ko.length || errori.length ? 1 : 0);
