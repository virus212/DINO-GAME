// Per ogni oggetto comparso: in quali fotogrammi puoi saltare per prenderlo
// senza morire, e quanto respiro hai prima (a terra dopo l'ostacolo di prima)
// e dopo (a terra prima di dover saltare il prossimo). Programmazione
// dinamica su tutte le scelte salta/corri. Dopo la presa NIENTE potere (il
// caso peggiore: conta solo come lo piazzi).
import { salto, dinoBox, scatole, tocca, scatolaOggetto, F } from './fisica.mjs';
export function analizza({ fot, oggetti }, { respiro = 12, conPotere = false } = {}) {
  const N = fot.length;
  const urta = (f, y) => { const d = dinoBox(y); return fot[f].ost.some((o) => scatole(o).some((s) => tocca(d, s))); };
  // salto da f: fotogrammi f+1..L, null se urta
  const salti = new Array(N);
  const traiettoria = (f) => {
    if (salti[f] !== undefined) return salti[f];
    const ys = salto(fot[f].v);
    let r = { L: f + ys.length, prende: null };
    for (let k = 0; k < ys.length; k++) {
      const ff = f + 1 + k; if (ff >= N) { r.L = N - 1; break; }
      const it = fot[ff].it;
      if (it && !r.prende && tocca(dinoBox(ys[k]), scatolaOggetto(it))) r.prende = { nato: it.nato, f: ff };
      if (urta(ff, ys[k])) { r = null; break; }
    }
    salti[f] = r; return r;
  };
  // S[f]: da terra a f si sopravvive fino in fondo
  const S = new Uint8Array(N + 1); S[N] = 1; S[N - 1] = 1;
  for (let f = N - 2; f >= 0; f--) {
    if (!urta(f + 1, 0) && S[f + 1]) { S[f] = 1; continue; }
    const t = traiettoria(f); if (t && S[t.L]) S[f] = 1;
  }
  // R[f]: si arriva a terra a f vivi
  const R = new Uint8Array(N); R[0] = 1;
  for (let f = 0; f < N - 1; f++) {
    if (!R[f]) continue;
    if (!urta(f + 1, 0)) R[f + 1] = 1;
    const t = traiettoria(f); if (t && t.L < N) R[t.L] = 1;
  }
  // corsa sicura da a per k fotogrammi
  const corre = (a, k) => { for (let i = 1; i <= k; i++) if (a + i < N && urta(a + i, 0)) return false; return true; };
  return oggetti.filter((it) => it.nato < N - 300).map((it) => {
    let presa = 0, comoda = 0, primaMax = 0, dopoMax = 0;
    for (let s = Math.max(0, it.nato); s < Math.min(N, it.nato + 400); s++) {
      if (!R[s]) continue;
      const t = traiettoria(s);
      if (!t || !t.prende || t.prende.nato !== it.nato || !S[t.L]) continue;
      presa++;
      // respiro prima: quanti fotogrammi potevi già essere a terra (max 30)
      let prima = 0; while (prima < 30 && s - prima - 1 >= 0 && R[s - prima - 1] && corre(s - prima - 1, prima + 1)) prima++;
      // respiro dopo: quanti fotogrammi puoi restare a terra dopo l'atterraggio e poi cavartela
      let dopo = 0; while (dopo < 30 && corre(t.L, dopo + 1) && (t.L + dopo + 1 >= N || S[t.L + dopo + 1])) dopo++;
      primaMax = Math.max(primaMax, prima); dopoMax = Math.max(dopoMax, dopo);
      if (prima >= respiro && dopo >= respiro) comoda++;
    }
    const davanti = it.prima ? (it.prima.tipo === 'mixer' ? (it.prima.grande ? 'grande' : 'piccolo') + it.prima.canali.length : it.prima.tipo + (it.prima.tipo === 'fantasma' ? (it.prima.sopra > 10 ? '-alto' : '-basso') : '')) : '-';
    return { v: fot[it.nato].v, tipo: it.tipo, davanti, presaMs: Math.round(presa * F), comodaMs: Math.round(comoda * F), primaMs: Math.round(primaMax * F), dopoMs: Math.round(dopoMax * F) };
  });
}
export function riassumi(righe, etichetta) {
  const fasce = [[6, 8], [8, 10], [10, 13.01]];
  console.log(`\n== ${etichetta}: ${righe.length} oggetti`);
  for (const [a, b] of fasce) {
    const r = righe.filter((x) => x.v >= a && x.v < b); if (!r.length) continue;
    const imp = r.filter((x) => x.presaMs === 0).length, scomodi = r.filter((x) => x.presaMs > 0 && x.comodaMs === 0).length;
    const med = (k) => { const s = r.map((x) => x[k]).sort((p, q) => p - q); return s[Math.floor(s.length / 2)]; };
    const p10 = (k) => { const s = r.map((x) => x[k]).sort((p, q) => p - q); return s[Math.floor(s.length / 10)]; };
    console.log(`vel ${a}-${b}: n=${r.length}  impossibili ${pc(imp, r.length)}  solo-al-volo ${pc(scomodi, r.length)}  finestra comoda mediana ${med('comodaMs')}ms, peggior 10% ${p10('comodaMs')}ms`);
  }
}
const pc = (a, b) => Math.round((100 * a) / b) + '%';
