// Piazzamento nuovo: la «coda» (segnaposto dell'ultima cosa partita, che
// scorre anche se l'ostacolo è uscito, spaccato o preso) + due schemi per gli
// oggetti: RADURA (tratto calmo prima e dopo) e SOPRA (sospeso sopra un
// ostacolo basso: lo prendi col salto che fai comunque, se lo centri)
import { OGG, nuovoOstacolo } from './mondo.mjs';
import { K, F, W, CELLA } from './fisica.mjs';
export function crea({ prima = 650, dopo = 800, sopraQuota = 44, quotaRadura = 30, schema = 'misto' } = {}) {
  const pxms = (g) => ((g.v - 0.5) * K) / F; // px di strada a ms
  return {
    usaCoda: true,
    passo(g, R, ultimo) {
      if (!(g.corsa > g.prossimoOggetto && !g.oggetto)) return false;
      const s = schema === 'misto' ? (R() < 0.5 ? 'radura' : 'sopra') : schema;
      const tipo = Object.keys(OGG)[Math.floor(R() * 5)];
      const [c, r] = OGG[tipo];
      // la radura vuole un tratto vuoto di «prima» ms dietro l'ultimo
      if (ultimo && ultimo.x + ultimo.w + Math.max(0, prima * pxms(g) - ultimo.distacco) >= W) return 'aspetta';
      let it;
      if (s === 'sopra') {
        // un mixer piccolo da 1 o una mina, con l'oggetto centrato sopra
        const o = nuovoOstacolo(g, R, (n) => n === 'piccolo' || n === 'mina', 1);
        o.distacco = Math.max(o.distacco, dopo * pxms(g));
        it = { tipo, x: o.x + o.w / 2 - c, w: c * CELLA, h: r * CELLA, sopra: sopraQuota, nato: g.f, prima: ultimo, schema: s };
        g.coda = { x: o.x, w: o.w, distacco: o.distacco };
      } else {
        it = { tipo, x: W + 10, w: c * CELLA, h: r * CELLA, sopra: quotaRadura, nato: g.f, prima: ultimo, schema: s };
        g.coda = { x: it.x, w: it.w, distacco: dopo * pxms(g) };
      }
      g.oggetto = it; g.oggetti.push(it);
      g.prossimoOggetto = g.corsa + g.ogni();
      return true;
    },
  };
}
export const radura = crea({ schema: 'radura' });
export const sopra = crea({ schema: 'sopra' });
export const misto = crea({});
export const sopra36 = crea({ schema: 'sopra', sopraQuota: 36 });
export const sopra40 = crea({ schema: 'sopra', sopraQuota: 40 });
export const radura700 = crea({ schema: 'radura', prima: 700, dopo: 900 });
export const radura550 = crea({ schema: 'radura', prima: 550, dopo: 700 });
export const sopra48 = crea({ schema: 'sopra', sopraQuota: 48 });
export const sopra52 = crea({ schema: 'sopra', sopraQuota: 52 });
export const sopra56 = crea({ schema: 'sopra', sopraQuota: 56 });
