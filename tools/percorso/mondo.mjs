// Genera una partita (solo il mondo: non dipende dal giocatore) con le regole
// di spawn di app.js v402, fotogramma per fotogramma. «regole» permette di
// sostituire il piazzamento degli oggetti per confrontare.
import { K, F, CELLA, W } from './fisica.mjs';
const TIPI = {
  piccolo: { largo: 17, gruppi: 4, distacco: 120, da: 0, peso: 1 },
  grande: { largo: 25, gruppi: 7, distacco: 120, da: 0, peso: 1 },
  fantasma: { largo: 46, gruppi: 999, distacco: 150, da: 7, scarto: 0.8, peso: 1.6 },
  mina: { largo: 17, gruppi: 999, distacco: 120, da: 7, peso: 0.45 },
  paracadute: { largo: 28, gruppi: 999, distacco: 150, da: 8, peso: 0.35 },
};
export const OGG = { scaglia: [11, 13], stella: [11, 11], cuffie: [11, 13], basso: [17, 11], pozione: [9, 10] };
export function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }

export function nuovoOstacolo(g, R, forza, solo1) {
  let ammessi = Object.keys(TIPI).filter((n) => g.v >= TIPI[n].da && !(g.storia[0] === n && g.storia[1] === n));
  if (forza) { const f = ammessi.filter(forza); ammessi = f.length ? f : Object.keys(TIPI).filter((n) => forza(n) && g.v >= TIPI[n].da); }
  let caso = R() * ammessi.reduce((s, n) => s + TIPI[n].peso, 0);
  let tipo = ammessi[ammessi.length - 1];
  for (const n of ammessi) { caso -= TIPI[n].peso; if (caso < 0) { tipo = n; break; } }
  const t = TIPI[tipo];
  g.storia = [tipo, g.storia[0]];
  let n = 1 + Math.floor(R() * 3);
  if ((n > 1 && t.gruppi > g.v) || solo1) n = 1;
  const minimo = Math.round(t.largo * n * g.v + t.distacco * 0.6);
  const distacco = (minimo + R() * minimo * 0.5) * K;
  let o;
  if (tipo === 'mina') o = { tipo, x: W + 10, w: 18, h: 10, sopra: 0, distacco };
  else if (tipo === 'paracadute') { const tocca = W * (0.4 + R() * 0.25); o = { tipo, x: W + 10, w: 18, h: 18, sopra: 46, discesa: 46 / (W + 10 - tocca), distacco }; }
  else if (tipo === 'fantasma') { const sopra = R() < 0.5 ? 28 + 14 : 4; const scarto = R() < 0.5 ? 0.8 : -0.8; o = { tipo, x: W + 10, w: 26, h: 28, sopra, scarto, distacco }; }
  else {
    const m = tipo === 'grande' ? { canale: 6, min: 14, max: 16 } : { canale: 4, min: 9, max: 11 };
    const canali = [];
    for (let i = 0; i < n; i++) { let a; do a = m.min + Math.floor(R() * (m.max - m.min + 1)); while (a * CELLA === canali[i - 1]); canali.push(a * CELLA); }
    const lc = m.canale * CELLA;
    o = { tipo: 'mixer', grande: tipo === 'grande', x: W + 10, w: n * lc + (n + 1) * CELLA, h: Math.max(...canali), sopra: 0, canali, lc, distacco };
  }
  g.ostacoli.push(o);
  g.coda = { x: o.x, w: o.w, distacco: o.distacco, scarto: o.scarto };
  return o;
}

// Piazzamento attuale (v402): l'oggetto parte al posto di un ostacolo, a 30
// da terra, e il distacco dell'ultimo si allunga di it.w + 700 ms di strada
export const regoleV402 = {
  passo(g, R, ultimo) {
    if (ultimo && !g.oggetto && g.corsa > g.prossimoOggetto) {
      const tipo = Object.keys(OGG)[Math.floor(R() * 5)];
      const [c, r] = OGG[tipo];
      const it = { tipo, x: W + 10, w: c * CELLA, h: r * CELLA, sopra: 30, nato: g.f, prima: ultimo };
      g.oggetto = it; g.oggetti.push(it);
      ultimo.distacco += it.w + (g.v - 0.5) * (K / F) * 700;
      g.prossimoOggetto = g.corsa + g.ogni();
      return true;
    }
    return false;
  },
};

// boss (app.js, dinoBossPasso): ogni boss.ogni ms di corsa un boss. In attesa
// niente oggetti (gli ostacoli sì), nello sgombro niente spawn finché la
// strada non è vuota, poi il ritorno con la coda segnaposto lunga boss.ripresa
// ms di strada. Le fasi da fermi (incontro, minigioco) non fanno fotogrammi.
// boss.forza: il primo spawn dopo il ritorno è un oggetto (il caso peggiore)
export function genera({ seed = 1, durata = 150000, regole = regoleV402, ogni = 6000, v0 = 6, boss = null } = {}) {
  const R = rng(seed);
  const g = { f: 0, corsa: 0, v: v0, ostacoli: [], storia: [], oggetto: null, oggetti: [], prossimoOggetto: 4000, ogni: () => ogni * (0.8 + R() * 0.4) };
  const fot = [];
  const N = Math.round(durata / F);
  let b = null;
  let prossimoBoss = boss ? boss.ogni : Infinity;
  for (let f = 0; f < N; f++) {
    g.f = f;
    g.v = Math.min(13, g.v + 0.001);
    const dx = (g.v - 0.5) * K;
    g.corsa += F;
    for (const o of g.ostacoli) {
      const passo = o.scarto ? (g.v + o.scarto - 0.5) * K : dx;
      o.x -= passo;
      if (o.tipo === 'paracadute' && o.sopra > 0) o.sopra = Math.max(0, o.sopra - o.discesa * passo);
    }
    g.ostacoli = g.ostacoli.filter((o) => o.x + o.w > -10);
    if (g.coda) g.coda.x -= g.coda.scarto ? (g.v + g.coda.scarto - 0.5) * K : dx;
    if (g.oggetto) { g.oggetto.x -= dx; if (g.oggetto.x + g.oggetto.w < -10) g.oggetto = null; }
    if (!b && g.corsa >= prossimoBoss) b = { fase: 'attesa', corsa0: g.corsa };
    if (b && b.fase === 'attesa' && !g.oggetto) b.fase = 'sgombro';
    if (b && b.fase === 'sgombro' && !g.ostacoli.length && !g.oggetto) {
      g.prossimoOggetto = boss.forza ? g.corsa : g.prossimoOggetto + g.corsa - b.corsa0;
      g.coda = { x: W, w: 0, distacco: (boss.ripresa * (g.v - 0.5) * K) / F, scarto: 0 };
      b = null;
      prossimoBoss = g.corsa + boss.ogni;
    }
    if (g.corsa > 3000 && (!b || b.fase === 'attesa')) {
      const ultimo = regole.usaCoda ? g.coda : g.ostacoli[g.ostacoli.length - 1];
      if (!ultimo || ultimo.x + ultimo.w + ultimo.distacco < W) {
        const r = !b && regole.passo(g, R, ultimo);
        if (!r) nuovoOstacolo(g, R, regole.forza && regole.forza(g));
      }
    }
    fot.push({ v: g.v, ost: g.ostacoli.map((o) => ({ ...o })), it: g.oggetto ? { ...g.oggetto } : null });
  }
  return { fot, oggetti: g.oggetti };
}
