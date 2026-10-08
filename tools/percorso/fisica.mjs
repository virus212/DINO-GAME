// Fisica e geometria del gioco del dino (copiate da app.js v402), a fotogrammi
// di Chrome. Altezze in unità sopra la terra, x in unità del banner.
export const K = 28 / 44, F = 1000 / 60, CELLA = 2, DINO_X = 22, W = 309;
export const G = 0.6 * K, TAGLIO = 63 * K, TAGLIO_VY = 5 * K;
export const spinta = (v) => (10 + v / 10) * K;
// traiettoria di un salto: y dopo 1, 2, ... fotogrammi (l'ultimo è 0 = a terra)
export function salto(v) {
  let y = 0, vy = spinta(v); const ys = [];
  do { y += vy; vy -= G; if (y > TAGLIO && vy > TAGLIO_VY) vy = TAGLIO_VY; if (y <= 0) { y = 0; } ys.push(y); } while (y > 0);
  return ys;
}
// scatola del dino: x0..x1, altezze h0..h1 (aperti)
export const dinoBox = (y) => ({ x0: DINO_X + 5, x1: DINO_X + 23, h0: y + 2, h1: y + 22 });
// scatole degli ostacoli in altezze
export function scatole(o) {
  const cl = CELLA;
  if (o.tipo === 'mixer') return o.canali.map((h, i) => ({ x0: o.x + cl + i * (o.lc + cl) + 1, x1: o.x + cl + i * (o.lc + cl) + 1 + o.lc - 2, h0: 0, h1: h - 2 }));
  if (o.tipo === 'virus') return [{ x0: o.x + 2, x1: o.x + o.w - 2, h0: o.sopra + 2, h1: o.sopra + o.h - 2 }];
  if (o.tipo === 'mina') return [{ x0: o.x + 2, x1: o.x + o.w - 2, h0: 0, h1: o.h - cl - 1 }];
  if (o.tipo === 'paracadute') return [{ x0: o.x + cl + 1, x1: o.x + o.w - cl - 1, h0: o.sopra + cl + 1, h1: o.sopra + o.h - cl - 1 }];
  // fantasma (h 28): corpo + fascia delle cuffie
  return [
    { x0: o.x + 2 * cl + 1, x1: o.x + 2 * cl + 1 + 9 * cl - 2, h0: o.sopra + o.h - cl - 1 - (13 * cl - 2), h1: o.sopra + o.h - cl - 1 },
    { x0: o.x + 2, x1: o.x + o.w - 2, h0: o.sopra + o.h - 4 * cl - 1 - (3 * cl - 2), h1: o.sopra + o.h - 4 * cl - 1 },
  ];
}
export const tocca = (a, b) => a.x0 < b.x1 && a.x1 > b.x0 && a.h0 < b.h1 && a.h1 > b.h0;
export const scatolaOggetto = (it) => ({ x0: it.x + 2, x1: it.x + it.w - 2, h0: it.sopra + 2, h1: it.sopra + it.h - 2 });
