// Simulatore del labirinto (static/boss-labirinto.js), per tarare LAB_PUNTINI
// (Vitto 09/10: «il labirinto è troppo easy, aumentiamo le palline»). Carica
// il file vero in un contesto vm (stub minimi: niente disegno né suoni) e lo
// fa giocare a un «giocatore» automatico RAGIONEVOLE, non perfetto:
// · decide ogni 150-250 ms (il ritardo di un umano, reazione=), mai a ogni tick;
// · va verso il puntino più vicino (BFS sulla mappa) girando al largo dalle
//   caselle a distanza <= r da un fantasma non spaventato e, se margine >= 0,
//   da quelle dove un fantasma arriva prima di lui (con margine caselle di
//   scarto: l'occhio che vede chi gli viene incontro);
// · se un fantasma è vicino e una pillola è a portata va a prendersela, coi
//   fantasmi blu non ha paura (finché non stanno per tornare normali);
// · senza strade sicure scappa verso dove gli resta più spazio (le caselle in
//   cui arriva prima lui dei fantasmi);
// · la svolta la PRENOTA come il dito (pac.voglio), appena non c'è un'altra
//   apertura dalla stessa parte prima dell'incrocio giusto: se il giro dopo
//   arriva tardi, gira all'incrocio dopo, proprio come sul telefono;
// · a pari distanza sceglie a caso: ogni partita fa la sua strada (con la
//   stessa apertura per tutte, mezze partite morivano nello stesso agguato).
// La soglia di vittoria è tolta (si misura fin dove arriva): conta i puntini
// mangiati entro BOSS_TEMPO (letto da boss.js, «pronti» compreso come nel
// motore) o alla morte, e quanti arrivano a ogni soglia. Livelli 0 e 1.
// Uso: node tools/percorso/sim-labirinto.mjs [partite=200] [r=2.5] [margine=2] [reazione=150-250]
//        [soglie=90,110,130,150,170] [file=...]
//   margine=-1 è il giocatore distratto: guarda solo i fantasmi vicini (r);
//   file è un'altra copia del gioco da provare (una variante da confrontare).
// 200 partite per livello: un paio di minuti. Taratura del 09/10 in LAB_PUNTINI.
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const arg = Object.fromEntries(process.argv.slice(2).map((a) => a.split('=')));
const PARTITE = +(arg.partite || 200);
const R = +(arg.r || 2.5);
const MARGINE = +(arg.margine ?? 2);
const SOGLIE = (arg.soglie || '90,110,130,150,170').split(',').map(Number);
const [REAZIONE, REAZIONE_MAX] = (arg.reazione || '150-250').split('-').map(Number); // ms fra una decisione e l'altra
const FILE = arg.file || fileURLToPath(new URL('../../static/boss-labirinto.js', import.meta.url));
const MOTORE = fileURLToPath(new URL('../../static/boss.js', import.meta.url));
const BOSS_TEMPO = +fs.readFileSync(MOTORE, 'utf8').match(/const BOSS_TEMPO = (\d+)/)[1];
const DT = 1000 / 60; // un fotogramma a 60 Hz: il motore somma questi dt
const sorgente = fs.readFileSync(FILE, 'utf8');
const SOGLIA_VERA = +sorgente.match(/const LAB_PUNTINI = (\d+)/)[1];
const TAGLIO = +sorgente.match(/const LAB_TAGLIO = ([\d.]+)/)[1];

/** Il file vero in un contesto nuovo; la soglia diventa irraggiungibile. */
function carica(seme) {
  const ctx = vm.createContext({
    window: { __dinoSeme: seme },
    BOSS_GIOCHI: {},
    BOSS_SUONI: {},
    BOSS_TEMPO,
    dinoSuono() {},
    dinoVibra() {},
  });
  const senzaSoglia = sorgente.replace(/const LAB_PUNTINI = \d+;/, 'const LAB_PUNTINI = 1e9;');
  // se la dichiarazione cambia forma le partite si fermerebbero alla soglia vera, zitte
  if (senzaSoglia === sorgente) throw new Error('LAB_PUNTINI non trovato in boss-labirinto.js');
  vm.runInContext(senzaSoglia, ctx, { filename: 'boss-labirinto.js' });
  const k = (nome) => vm.runInContext(nome, ctx);
  return { labNuovo: k('labNuovo'), labPasso: k('labPasso'), labLibera: k('labLibera'), DIR: k('LAB_DIR') };
}

/** Un generatore tutto suo (il ritmo del giocatore), che non tocca quello del gioco. */
function caso(seme) {
  let s = seme >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0), s / 4294967296);
}

/** La casella vicina, col tunnel della riga 14 che fa il giro (o null se è muro). */
function vicina(L, x, y, d) {
  let nx = x + L.DIR[d][0];
  const ny = y + L.DIR[d][1];
  if (ny === 14 && (nx < 0 || nx > 27)) nx = (nx + 28) % 28;
  return L.labLibera(nx, ny) ? [nx, ny] : null;
}
const casella = (v) => [((Math.round(v.x) % 28) + 28) % 28, Math.round(v.y)];

/** Fra quante caselle (per la strada) ci arriva il fantasma più vicino, per
 * ogni casella: BFS da ciascuno, il primo passo mai all'indietro (non può). */
function arrivi(L, cattivi) {
  const arrivo = new Float64Array(28 * 31).fill(Infinity);
  for (const f of cattivi) {
    const [fx, fy] = casella(f);
    const visti = new Set([fy * 28 + fx]);
    arrivo[fy * 28 + fx] = 0;
    let giro = [[fx, fy]];
    for (let passi = 1; giro.length; passi++) {
      const dopo = [];
      for (const [x, y] of giro)
        for (let d = 0; d < 4; d++) {
          const n = passi === 1 && d === (f.dir + 2) % 4 ? null : vicina(L, x, y, d);
          if (!n || visti.has(n[1] * 28 + n[0])) continue;
          visti.add(n[1] * 28 + n[0]);
          arrivo[n[1] * 28 + n[0]] = Math.min(arrivo[n[1] * 28 + n[0]], passi);
          dopo.push(n);
        }
      giro = dopo;
    }
  }
  return arrivo;
}

/** La direzione da prenotare per seguire la strada: si gira qui (o si torna
 * indietro) subito; la prima svolta più avanti solo se prima dell'incrocio
 * giusto non c'è un'altra apertura dalla stessa parte (girerebbe lì).
 * Altrimenti dritto, e la svolta al giro dopo. */
function prenota(L, g, sx, sy, strada) {
  const p = g.pac;
  if (p.fermo || strada[0].d !== p.dir) return strada[0].d;
  const i = strada.findIndex((s) => s.d !== p.dir);
  if (i < 0) return p.dir;
  const svolta = strada[i].d;
  // la casella di partenza conta solo se non l'ha già passata oltre il taglio
  const [dx, dy] = L.DIR[p.dir];
  const oltre = (p.x - Math.round(p.x)) * dx + (p.y - Math.round(p.y)) * dy > TAGLIO;
  const prima = [oltre ? null : [sx, sy], ...strada.slice(0, i - 1).map((s) => [s.x, s.y])];
  return prima.some((c) => c && vicina(L, c[0], c[1], svolta)) ? p.dir : svolta;
}

/** La decisione del giocatore: la direzione da prenotare (o null). A pari
 * distanza sceglie a caso (ordine delle direzioni mescolato): ogni partita
 * prende la sua strada, come le persone, e non sempre la stessa apertura. */
function decidi(L, g, ritmo) {
  const p = g.pac;
  const [sx, sy] = casella(p);
  // pericolosi: fuori (o sulla porta) e non blu, o blu ma quasi finita la paura
  const cattivi = g.fantasmi.filter((f) => (f.stato === 'fuori' || (f.stato === 'esce' && f.y < 12.5)) && (!f.spaventato || g.paura < 1000));
  const dist = (f, x, y) => Math.abs(f.x - x) + Math.abs(f.y - y);
  const arrivo = arrivi(L, cattivi);
  const pericolo = (x, y, k) => cattivi.some((f) => dist(f, x, y) <= R) || (MARGINE >= 0 && arrivo[y * 28 + x] <= k + MARGINE);
  const ordine = [0, 1, 2, 3].sort(() => ritmo() - 0.5);
  // la strada più corta verso una casella buona, solo per caselle sicure
  const cerca = (buona, maxPassi = Infinity) => {
    const da = new Map([[sy * 28 + sx, null]]);
    let giro = [[sx, sy]];
    for (let k = 1; giro.length && k <= maxPassi; k++) {
      const dopo = [];
      for (const [x, y] of giro)
        for (const d of ordine) {
          const n = vicina(L, x, y, d);
          if (!n || da.has(n[1] * 28 + n[0]) || pericolo(n[0], n[1], k)) continue;
          da.set(n[1] * 28 + n[0], { x: n[0], y: n[1], d, prima: y * 28 + x });
          if (buona(n[0], n[1])) {
            const strada = [];
            for (let s = da.get(n[1] * 28 + n[0]); s; s = da.get(s.prima)) strada.unshift(s);
            return strada;
          }
          dopo.push(n);
        }
      giro = dopo;
    }
    return null;
  };
  const minacciato = cattivi.some((f) => dist(f, p.x, p.y) <= 6);
  let strada = minacciato && g.paura === 0 ? cerca((x, y) => g.puntini[y * 28 + x] === 2, 8) : null;
  strada = strada || cerca((x, y) => g.puntini[y * 28 + x] > 0);
  if (strada) return prenota(L, g, sx, sy, strada);
  // nessuna strada sicura: verso dove resta più spazio, cioè più caselle in
  // cui arriva prima lui dei fantasmi (da distratto: lontano da quelli vicini)
  let d = null;
  let meglio = -1;
  for (let k = 0; k < 4; k++) {
    const n = vicina(L, sx, sy, k);
    if (!n) continue;
    let spazio = Math.min(99, ...cattivi.map((f) => dist(f, n[0], n[1])));
    if (MARGINE >= 0) {
      const visti = new Set([sy * 28 + sx, n[1] * 28 + n[0]]);
      let giro = arrivo[n[1] * 28 + n[0]] > 1 ? [n] : [];
      spazio = giro.length;
      for (let passi = 2; giro.length && spazio < 80; passi++) {
        const dopo = [];
        for (const [x, y] of giro)
          for (let e = 0; e < 4; e++) {
            const c = vicina(L, x, y, e);
            if (!c || visti.has(c[1] * 28 + c[0]) || arrivo[c[1] * 28 + c[0]] <= passi) continue;
            visti.add(c[1] * 28 + c[0]);
            dopo.push(c);
          }
        spazio += dopo.length;
        giro = dopo;
      }
    }
    if (spazio > meglio || (spazio === meglio && k === p.dir)) {
      meglio = spazio;
      d = k;
    }
  }
  return d;
}

/** Una partita: puntini mangiati entro BOSS_TEMPO o alla morte, e quando. */
function gioca(livello, seme) {
  const L = carica(seme);
  const g = L.labNuovo(livello);
  const ritmo = caso(seme * 7919 + 1);
  let t = 0; // il tempo del motore (b.t della fase gioco): «pronti» compreso
  let prossima = 0;
  const quando = {}; // soglia → ms in cui ci arriva
  while (t < BOSS_TEMPO) {
    t += DT;
    if (t >= prossima && g.pronti <= 0) {
      const d = decidi(L, g, ritmo);
      if (d !== null) g.pac.voglio = d;
      prossima = t + REAZIONE + ritmo() * (REAZIONE_MAX - REAZIONE);
    }
    const esito = L.labPasso(g, DT);
    SOGLIE.concat(SOGLIA_VERA).forEach((s) => g.mangiati >= s && quando[s] === undefined && (quando[s] = t));
    if (esito || g.esito === 'perso') break;
  }
  return { mangiati: g.mangiati, morto: g.esito === 'perso', preso: g.preso, t, quando };
}

const pct = (n, tot) => `${((100 * n) / tot).toFixed(0)}%`.padStart(4);
console.log(`labirinto: ${PARTITE} partite per livello, decisioni ogni ${REAZIONE}-${REAZIONE_MAX} ms, pericolo a distanza <= ${R}` + (MARGINE >= 0 ? ` o dove un fantasma arriva prima (margine ${MARGINE})` : ' (distratto)') + `, BOSS_TEMPO ${BOSS_TEMPO / 1000} s`);
for (const livello of [0, 1]) {
  const r = [];
  for (let seme = 1; seme <= PARTITE; seme++) r.push(gioca(livello, seme));
  const m = r.map((x) => x.mangiati).sort((a, b) => a - b);
  const q = (k) => m[Math.min(m.length - 1, Math.floor(k * m.length))];
  const morti = r.filter((x) => x.morto);
  console.log(`\nlivello ${livello}: puntini min ${m[0]}, 10% ${q(0.1)}, 25% ${q(0.25)}, mediana ${q(0.5)}, 75% ${q(0.75)}, 90% ${q(0.9)}, max ${m[m.length - 1]}`);
  console.log(`  morti entro ${BOSS_TEMPO / 1000} s ${pct(morti.length, r.length)} (in media a ${(morti.reduce((a, x) => a + x.t, 0) / Math.max(1, morti.length) / 1000).toFixed(1)} s; ${['rosso', 'rosa', 'azzurro', 'arancio'].map((n) => `${n} ${morti.filter((x) => x.preso === n).length}`).join(', ')})`);
  const fasce = {};
  m.forEach((v) => (fasce[Math.floor(v / 20) * 20] = (fasce[Math.floor(v / 20) * 20] || 0) + 1));
  console.log('  fasce: ' + Object.entries(fasce).map(([k, n]) => `${k}-${+k + 19}: ${n}`).join(', '));
  for (const s of [...new Set(SOGLIE.concat(SOGLIA_VERA))].sort((a, b) => a - b)) {
    const arrivati = r.filter((x) => x.quando[s] !== undefined);
    const tardi = arrivati.filter((x) => x.quando[s] > BOSS_TEMPO - 5000).length;
    const t = arrivati.map((x) => x.quando[s]).sort((a, b) => a - b);
    const med = t.length ? `${(t[Math.floor(t.length / 2)] / 1000).toFixed(1)} s` : '-';
    console.log(`  ${s === SOGLIA_VERA ? '→ ' : '  '}a ${String(s).padStart(3)}: ${pct(arrivati.length, r.length)} (mediana a ${med}, negli ultimi 5 s ${tardi})${s === SOGLIA_VERA ? '  ← LAB_PUNTINI' : ''}`);
  }
}
