// Fase 4: il labirinto. Incontro (fantasma, pillola, trasformazione), tendina,
// partita giocata da un «dito» che fa swipe veri verso il puntino più vicino,
// gag di vittoria sulla strada (e ritorno con la Stella), tempo scaduto senza
// i puntini («pari»: dal 09/10 resistere non basta più) e sconfitta (game over).
// Uso: node boss-labirinto.mjs <cartella-foto> [verticale|orizzontale]
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
  await foto(page, `${OUT}/${P}-lab-${nome}.png`, oriz);
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
  window.__dinoBoss("labirinto");
});
await scatta("arrivo", 900, "1-arrivo");
await scatta("incontro", 500, "2-spavento");
await scatta("incontro", 1000, "3-mangiapunti");
await scatta("incontro", 1600, "4-pillola");
await scatta("entra", 330, "5-tendina");
await page.waitForFunction(() => __dino.boss && __dino.boss.fase === "gioco" && __dino.boss.t > 300, null, { timeout: 5000 });
await foto(page, `${OUT}/${P}-lab-6-gioco.png`, oriz);

// —— i comandi, uno per uno
// la svolta prenotata scatta all'incrocio giusto: dalla partenza verso
// sinistra, «su» prenotato gira alla colonna 12 (la prima aperta in alto)
const prenotata = await page.evaluate(() => {
  const g = labNuovo(1);
  g.pronti = 0;
  g.fantasmi.forEach((f) => Object.assign(f, { stato: "casa", uscita: 1e12 }));
  g.pac.voglio = LAB_SU;
  for (let i = 0; i < 300 && g.pac.dir !== LAB_SU; i++) labPasso(g, 1000 / 60);
  return { x: +g.pac.x.toFixed(2), y: g.pac.y, dir: g.pac.dir };
});
verifica(prenotata.dir === 0 && Math.abs(prenotata.x - 12) <= 0.45, `svolta prenotata all'incrocio giusto (colonna 12): ${JSON.stringify(prenotata)}`);
await page.waitForFunction(() => __dino.boss.gioco.pronti <= 0, null, { timeout: 5000 });
// un dito tenuto giù che si sposta: destra, poi su, poi sinistra senza alzarlo
const voglio = () => page.evaluate(() => __dino.boss.gioco.pac.voglio);
let m = await campo();
const v0 = pagina(m, 112, 80);
await page.mouse.move(v0.x, v0.y);
await page.mouse.down();
const sequenza = [];
for (const [ux, uy] of [[122, 80], [122, 70], [110, 70]]) {
  const q = pagina(m, ux, uy);
  await page.mouse.move(q.x, q.y, { steps: 3 });
  sequenza.push(await voglio());
}
await page.mouse.up();
verifica(sequenza.join() === "3,0,1", `dito tenuto giù che cambia strada: ${sequenza.join()} (atteso 3,0,1)`);
// tastiera (desktop): frecce
await page.keyboard.press("ArrowDown");
const k1 = await voglio();
await page.keyboard.press("ArrowRight");
const k2 = await voglio();
verifica(k1 === 2 && k2 === 3, `frecce: giù ${k1}, destra ${k2}`);

// —— si vince solo a puntini (dal 09/10): resistere fino in fondo senza
// mangiarne abbastanza non vince, e alla scadenza il motore chiude «pari»
const regole = await page.evaluate(() => {
  const chiusi = (g) => g.fantasmi.forEach((f, i) => Object.assign(f, { stato: "casa", uscita: 1e12, x: LAB_FANTASMI[i].x, y: 14, spaventato: false }));
  // 70 s di partita coi fantasmi chiusi in casa: nessuno ti prende, mai «vinto»
  const g = labNuovo(0);
  chiusi(g);
  let esito = null;
  for (let i = 0; i < 70 * 60 && !esito; i++) esito = labPasso(g, 1000 / 60);
  // l'ultimo puntino a 0,4 s dalla scadenza: vinto, e arriva al motore entro
  // la scadenza anche se la scenetta (300 ms) non è finita
  const h = labNuovo(0);
  chiusi(h);
  h.pronti = 0;
  h.orologio = BOSS_TEMPO - 400;
  h.mangiati = LAB_PUNTINI - 1;
  let ultimo = null;
  while (!ultimo && h.orologio < BOSS_TEMPO + 1000) ultimo = labPasso(h, 1000 / 60);
  // il primo passo da quando il motore direbbe «pari» (b.t = orologio >= BOSS_TEMPO)
  const primo = h.orologio >= BOSS_TEMPO && h.orologio - 1000 / 60 < BOSS_TEMPO;
  return { esito, mangiati: g.mangiati, resiste: typeof LAB_RESISTE, puntini: LAB_PUNTINI, ultimo, primo, scena: Math.round(h.fine - h.t) };
});
verifica(regole.esito === null && regole.mangiati < regole.puntini && regole.resiste === "undefined", `70 s senza farsi prendere e senza i puntini: nessuna vittoria ${JSON.stringify(regole)}`);
verifica(regole.ultimo === "vinto" && regole.primo && regole.scena > 0, `l'ultimo puntino all'ultimo: vinto entro il passo della scadenza, con la scenetta ancora a ${regole.scena} ms (${regole.ultimo})`);

// —— una partita vera a swipe: verso il puntino più vicino per la strada più
// corta che non passa accanto ai fantasmi; una pillola d'ufficio solo se uno
// è proprio addosso (contata)
let aiuti = 0;
let scarto = null;
const t0 = Date.now();
for (let i = 0; Date.now() - t0 < 75000; i++) {
  const mossa = await page.evaluate(() => {
    const b = __dino.boss;
    if (!b || b.fase !== "gioco") return null;
    const g = b.gioco;
    const p = g.pac;
    let aiuto = false;
    if (g.fantasmi.some((f) => f.stato === "fuori" && !f.spaventato && Math.abs(f.x - p.x) + Math.abs(f.y - p.y) < 2.2)) {
      labSpavento(g);
      aiuto = true;
    }
    const sx = Math.round(p.x);
    const sy = Math.round(p.y);
    const pericolo = (x, y) => g.fantasmi.some((f) => f.stato === "fuori" && !f.spaventato && Math.abs(f.x - x) + Math.abs(f.y - y) < 4);
    const visti = new Set([`${sx},${sy}`]);
    const coda = [[sx, sy, null]];
    let d = null;
    while (coda.length) {
      const [x, y, d0] = coda.shift();
      if (d0 !== null && x >= 0 && x < 28 && g.puntini[y * 28 + x]) {
        d = d0;
        break;
      }
      for (let k = 0; k < 4; k++) {
        const nx = x + LAB_DIR[k][0];
        const ny = y + LAB_DIR[k][1];
        if (nx < 0 || nx > 27 || !labLibera(nx, ny) || visti.has(`${nx},${ny}`) || pericolo(nx, ny)) continue;
        visti.add(`${nx},${ny}`);
        coda.push([nx, ny, d0 === null ? k : d0]);
      }
    }
    if (d === null) {
      // nessuna strada sicura: si scappa dalla parte più lontana dai fantasmi
      let meglio = -1;
      for (let k = 0; k < 4; k++) {
        const nx = sx + LAB_DIR[k][0];
        const ny = sy + LAB_DIR[k][1];
        if (!labLibera(nx, ny)) continue;
        const lontano = Math.min(...g.fantasmi.filter((f) => f.stato === "fuori" && !f.spaventato).map((f) => Math.abs(f.x - nx) + Math.abs(f.y - ny)), 99);
        if (lontano > meglio) {
          meglio = lontano;
          d = k;
        }
      }
    }
    return { d, aiuto, px: LAB_MX + p.x * LAB_T + 2.5, py: LAB_MY + p.y * LAB_T + 2.5, voglio: p.voglio };
  });
  if (!mossa) break;
  if (mossa.aiuto) aiuti++;
  if (mossa.d !== null && mossa.d !== mossa.voglio) {
    m = await campo();
    const [dx, dy] = [[0, -1], [-1, 0], [0, 1], [1, 0]][mossa.d];
    const a = pagina(m, mossa.px, mossa.py);
    const z = pagina(m, mossa.px + dx * 12, mossa.py + dy * 12);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move((a.x + z.x) / 2, (a.y + z.y) / 2);
    await page.mouse.move(z.x, z.y);
    await page.mouse.up();
  }
  if (i === 60) {
    await foto(page, `${OUT}/${P}-lab-7-partita.png`, oriz);
    // l'orologio del gioco (HUD, scadenza) è quello del motore
    scarto = await page.evaluate(() => (__dino.boss.fase === "gioco" ? Math.abs(__dino.boss.t - __dino.boss.gioco.orologio) : 0));
  }
  await page.waitForTimeout(25);
}
verifica(scarto !== null && scarto < 0.001, `a metà partita l'orologio del gioco è quello del motore (scarto ${scarto})`);
const partita = await page.evaluate(() => ({ fase: __dino.boss.fase, esito: __dino.boss.esito, mangiati: __dino.boss.gioco.mangiati, serve: LAB_PUNTINI, t: Math.round(__dino.boss.gioco.t) }));
verifica(partita.esito === "vinto" && partita.mangiati >= partita.serve, `partita a swipe veri fino in fondo: ${JSON.stringify(partita)}, pillole d'ufficio ${aiuti}`);
const suoni = await page.evaluate(() => [...new Set(window.__suoni)].join(","));
verifica(/lab_waka1/.test(suoni) && /lab_waka2/.test(suoni), `suoni: ${suoni}`);

// —— vittoria: LAB_PUNTINI puntini
await scatta("esito", 300, "8-vinto-godzilla");
await scatta("esito", 1000, "9-vinto-soffio");
await scatta("esito", 1600, "10-vinto-arrosto");
await page.waitForFunction(() => !__dino.boss, null, { timeout: 6000 });
const dopo = await page.evaluate(() => ({ stato: __dino.stato, y: __dino.y, potere: __dino.potere && __dino.potere.tipo }));
verifica(dopo.stato === "corsa" && dopo.y === 0 && dopo.potere === "stella", `vittoria: si torna a correre a terra con la Stella ${JSON.stringify(dopo)}`);
await page.waitForTimeout(200);
await foto(page, `${OUT}/${P}-lab-11-ritorno.png`, oriz);

// —— tempo scaduto: fantasmi chiusi in casa, nessuno tocca niente; a 9 s
// dalla fine (motore e orologio del gioco insieme) l'HUD lampeggia, poi «pari»
await page.waitForTimeout(900);
await page.evaluate(() => {
  __dino.potere = null;
  __dino.grazia = 0;
  window.__dinoBoss("labirinto");
});
await page.waitForFunction(() => __dino.boss && __dino.boss.fase === "gioco" && __dino.boss.t > 300, null, { timeout: 25000 });
const puntiPrima = await page.evaluate(() => {
  const b = __dino.boss;
  b.gioco.fantasmi.forEach((f, i) => Object.assign(f, { stato: "casa", uscita: 1e12, x: LAB_FANTASMI[i].x, y: 14, spaventato: false }));
  b.gioco.pronti = 0;
  b.t = b.gioco.orologio = BOSS_TEMPO - 9000;
  return __dino.punti;
});
await page.waitForTimeout(400);
await foto(page, `${OUT}/${P}-lab-16-ultimi-secondi.png`, oriz);
const hud = await page.evaluate(() => Math.ceil((BOSS_TEMPO - __dino.boss.gioco.orologio) / 1000));
verifica(hud >= 7 && hud <= 9, `HUD: i secondi che restano al boss (${hud})`);
await scatta("esito", 600, "17-pari-tempo");
const pari = await page.evaluate(() => ({ esito: __dino.boss.esito, mangiati: __dino.boss.gioco.mangiati }));
verifica(pari.esito === "pari", `tempo scaduto senza i puntini: «pari» ${JSON.stringify(pari)}`);
await page.waitForFunction(() => !__dino.boss, null, { timeout: 6000 });
const dopoPari = await page.evaluate(() => ({ stato: __dino.stato, potere: __dino.potere && __dino.potere.tipo, punti: __dino.punti }));
verifica(dopoPari.stato === "corsa" && !dopoPari.potere && dopoPari.punti - puntiPrima < 50, `«pari»: si torna a correre senza premio ${JSON.stringify(dopoPari)} (punti prima ${puntiPrima})`);

// —— sconfitta: il rosso addosso
await page.waitForTimeout(900);
await page.evaluate(() => {
  __dino.potere = null;
  __dino.grazia = 0;
  window.__dinoBoss("labirinto");
});
await page.waitForFunction(() => __dino.boss && __dino.boss.fase === "gioco" && __dino.boss.t > 300, null, { timeout: 25000 });
await page.evaluate(() => {
  const g = __dino.boss.gioco;
  const r = g.fantasmi[0];
  Object.assign(r, { x: Math.round(g.pac.x), y: g.pac.y, stato: "fuori", spaventato: false });
  g.paura = 0;
});
await scatta("esito", 300, "12-perso-carica");
await scatta("esito", 900, "13-perso-volo");
await scatta("esito", 1600, "14-perso-stella");
await page.waitForFunction(() => __dino.stato === "fine", null, { timeout: 6000 });
const fine = await page.evaluate(() => ({ causa: __dino.causa, y: __dino.y }));
verifica(fine.causa === "Battuto dal boss" && fine.y === 0, `sconfitta: game over ${JSON.stringify(fine)}`);
await page.waitForTimeout(300);
await foto(page, `${OUT}/${P}-lab-15-gameover.png`, oriz);

console.log("OK:\n  " + ok.join("\n  "));
console.log("KO:\n  " + (ko.join("\n  ") || "nessuno"));
console.log("errori:", errori.length ? errori : "nessuno");
await browser.close();
process.exit(ko.length || errori.length ? 1 : 0);
