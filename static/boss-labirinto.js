// —— LABIRINTO (fase 4). Tributo al cabinato del labirinto coi fantasmi: la
// mappa originale 28 x 31 (tunnel laterale, casa dei fantasmi), puntini e 4
// pillole, i quattro fantasmi coi comportamenti veri (rosso insegue, rosa
// punta 4 caselle avanti, azzurro col vettore del rosso, arancio insegue
// lontano e scappa vicino; fasi sparsi/caccia; spaventati e blu dopo la
// pillola, occhi che tornano a casa). Il protagonista è il dino-mangiapunti:
// la testa del dino coi dentini. Decisione di Vitto (08/10): si perde se un
// fantasma ti prende (1 vita). Si vince mangiando LAB_PUNTINI puntini prima
// che scada il boss (BOSS_TEMPO del motore, poi «pari»). Il 09/10 Vitto: «il
// labirinto e troppo easy aumentiamo il numero di palline da racoggliere».
// Fino ad allora bastavano 70 puntini o resistere 40 s; la vittoria a tempo
// l'abbiamo tolta noi (da confermare con Vitto): con quella, più puntini non
// cambiavano niente per chi resiste. Muri nei colori Crackify. Campo
// 224 x 156: labirinto a celle da 5 unità (140 x 155) al centro, ai lati i
// contatori (puntini a sinistra, secondi che restano al boss a destra) ——
const LAB_W = 224;
const LAB_H = 156;
const LAB_T = 5; // unità per casella
const LAB_MX = 42; // dove parte il labirinto nel campo
const LAB_MY = 0;
const LAB_TICK = 1000 / 60;
// puntini per vincere, su 244 (prima 70). Tarato col simulatore (node
// tools/percorso/sim-labirinto.mjs): un giocatore automatico ragionevole
// (decide ogni 150-250 ms, va al puntino più vicino girando al largo dai
// fantasmi, usa le pillole) ci arriva entro i 60 s nel 68% delle partite al
// primo giro (a 70 ci arrivava il 97%); se decide ogni 250-400 ms, come un
// dito più lento, il 44%. Chi ce la fa ci arriva in ~28 s: col dito c'è
// margine di tempo, la sfida vera è non farsi prendere
const LAB_PUNTINI = 150;
const LAB_VEL = 8 / 60; // caselle a tick al 100%
const LAB_PAURA = 6000; // ms di fantasmi blu dopo la pillola
// la difficoltà per giro, tutta qui: i fantasmi a caccia al primo giro
// (livello 0 del motore) e dal secondo, veloci quanto il dino (0,8: in fuga
// non si guadagna più strada; il simulatore dà 61% e 35% col dito lento).
// Prima un «veloce» su tutto contava i livelli da 1 (primo e secondo giro
// uguali) e accelerando anche il dino rendeva i puntini più facili
const LAB_FANT_VEL = [0.75, 0.8];
const LAB_SWIPE = 5; // unità di trascinamento per girare
const LAB_TAGLIO = 0.45; // caselle prima o dopo il centro in cui si può già girare
const LAB_PRONTI = 1200; // ms fermi all'inizio, con la scritta (il «pronti» dell'originale)
const LAB_SU = 0;
const LAB_SINISTRA = 1;
const LAB_GIU = 2;
const LAB_DESTRA = 3;
const LAB_DIR = [[0, -1], [-1, 0], [0, 1], [1, 0]];
// fasi sparsi/caccia del primo livello (ms), l'ultima per sempre
const LAB_FASI = [7000, 20000, 7000, 20000, 5000, 20000, 5000, Infinity];
const LAB_NO_SU = new Set(["12,11", "15,11", "12,23", "15,23"]);
const LAB_MAPPA = [
  "############################",
  "#............##............#",
  "#.####.#####.##.#####.####.#",
  "#o####.#####.##.#####.####o#",
  "#.####.#####.##.#####.####.#",
  "#..........................#",
  "#.####.##.########.##.####.#",
  "#.####.##.########.##.####.#",
  "#......##....##....##......#",
  "######.##### ## #####.######",
  "     #.##### ## #####.#     ",
  "     #.##          ##.#     ",
  "     #.## ###--### ##.#     ",
  "######.## #      # ##.######",
  "      .   #      #   .      ",
  "######.## #      # ##.######",
  "     #.## ######## ##.#     ",
  "     #.##          ##.#     ",
  "     #.## ######## ##.#     ",
  "######.## ######## ##.######",
  "#............##............#",
  "#.####.#####.##.#####.####.#",
  "#.####.#####.##.#####.####.#",
  "#o..##.......  .......##..o#",
  "###.##.##.########.##.##.###",
  "###.##.##.########.##.##.###",
  "#......##....##....##......#",
  "#.##########.##.##########.#",
  "#.##########.##.##########.#",
  "#..........................#",
  "############################",
];
// la testa del dino-mangiapunti, verso destra: tonda come l'originale ma
// col muso del dino (occhio col riflesso, narice, i dentini sulle labbra) e
// la cuffia grigia dietro. Chiusa, mezza, spalancata
const LAB_TESTA = [
  ["...####...", ".##we####.", ".##ee####.", "H#######n#", "H#########", "H###mtmtmt", "H#########", ".########.", ".dddddddd.", "...dddd..."],
  ["...####...", ".##we####.", ".##ee####.", "H#######n#", "H#####t.t.", "H####.....", "H#####t.t.", ".########.", ".dddddddd.", "...dddd..."],
  ["...####...", ".##we###..", ".##ee#t...", "H#####....", "H###t.....", "H###t.....", "H#####....", ".#####t...", ".ddddddd..", "...dddd..."],
];
const LAB_FANT = [
  ["...####...", ".########.", "##########", "##########", "##########", "##########", "##########", "##########", "##########", "#.##..##.#"],
  ["...####...", ".########.", "##########", "##########", "##########", "##########", "##########", "##########", "##########", "##..##..##"],
];
const LAB_FANTASMI = [
  { nome: "rosso", colore: "#ff0000", angolo: [25, -3], x: 13.5, y: 11, uscita: 0 },
  { nome: "rosa", colore: "#ffb8ff", angolo: [2, -3], x: 13.5, y: 14, uscita: 500 },
  { nome: "azzurro", colore: "#00ffff", angolo: [27, 31], x: 11.5, y: 14, uscita: 4000 },
  { nome: "arancio", colore: "#ffb852", angolo: [0, 31], x: 15.5, y: 14, uscita: 8000 },
];

function labCaso(g) {
  g.seme = (Math.imul(g.seme, 1664525) + 1013904223) >>> 0;
  return g.seme / 4294967296;
}

function labNuovo(livello = 0) {
  const puntini = new Uint8Array(28 * 31);
  LAB_MAPPA.forEach((r, y) => [...r].forEach((ch, x) => (puntini[y * 28 + x] = ch === "." ? 1 : ch === "o" ? 2 : 0)));
  return {
    t: 0,
    resto: 0,
    orologio: 0, // ms del boss (i dt del motore, «pronti» compreso): i secondi che restano
    seme: ((typeof window !== "undefined" && window.__dinoSeme) || Math.random() * 4294967296) >>> 0,
    livello,
    puntini,
    mangiati: 0,
    punti: 0,
    pac: { x: 13.5, y: 23, dir: LAB_SINISTRA, voglio: null, fermo: false, anda: 0 },
    fantasmi: LAB_FANTASMI.map((f) => ({ ...f, dir: LAB_SINISTRA, stato: f.uscita === 0 ? "fuori" : "casa", spaventato: false, bob: 1 })),
    fase: 0,
    faseT: 0,
    paura: 0,
    catena: 0,
    fermo: 0,
    pronti: LAB_PRONTI,
    testi: [],
    ultimoWaka: -1e9,
    waka: false,
    dito: null,
    esito: null,
    fine: 0,
  };
}

function labLibera(x, y) {
  if (!Number.isInteger(x) || !Number.isInteger(y) || y < 0 || y >= 31) return false;
  if (x < 0 || x >= 28) return y === 14;
  const ch = LAB_MAPPA[y][x];
  return ch !== "#" && ch !== "-";
}

/** Avanza lungo la direzione; a ogni centro di casella chiama alCentro. */
function labMuovi(a, passo, alCentro) {
  let resto = passo;
  // dopo una svolta anticipata l'altro asse si rimette in riga in diagonale
  if (!a.fermo) {
    if (LAB_DIR[a.dir][0] && a.y !== Math.round(a.y)) a.y = labVerso(a.y, Math.round(a.y), passo);
    else if (LAB_DIR[a.dir][1] && a.x !== Math.round(a.x)) a.x = labVerso(a.x, Math.round(a.x), passo);
  }
  for (let giri = 0; resto > 1e-9 && giri < 8; giri++) {
    if (a.fermo) {
      alCentro(a);
      if (a.fermo) return;
    }
    const [dx, dy] = LAB_DIR[a.dir];
    const pos = dx ? a.x : a.y;
    const s = dx || dy;
    const prossimo = s > 0 ? Math.floor(pos + 1e-6) + 1 : Math.ceil(pos - 1e-6) - 1;
    const d = Math.abs(prossimo - pos);
    if (resto < d - 1e-9) {
      if (dx) a.x += s * resto;
      else a.y += s * resto;
      return;
    }
    // al centro della casella: anche l'altro asse in riga (dopo un taglio
    // d'angolo seguito da un dietrofront può mancare ancora un pezzetto)
    if (dx) {
      a.x = prossimo;
      a.y = Math.round(a.y);
    } else {
      a.y = prossimo;
      a.x = Math.round(a.x);
    }
    resto -= d;
    if (a.x <= -2) a.x = 28;
    else if (a.x >= 29) a.x = -1;
    alCentro(a);
  }
}

function labScatter(g) {
  return g.fase % 2 === 0;
}

function labBersaglio(g, f) {
  if (f.stato === "occhi") return [13, 11];
  if (labScatter(g)) return f.angolo;
  const p = g.pac;
  const px = Math.round(p.x);
  const py = Math.round(p.y);
  const [dx, dy] = LAB_DIR[p.dir];
  const su = p.dir === LAB_SU; // l'errore dell'originale: verso l'alto punta anche a sinistra
  if (f.nome === "rosso") return [px, py];
  if (f.nome === "rosa") return [px + 4 * dx - (su ? 4 : 0), py + 4 * dy];
  if (f.nome === "azzurro") {
    const r = g.fantasmi[0];
    const ax = px + 2 * dx - (su ? 2 : 0);
    const ay = py + 2 * dy;
    return [2 * ax - Math.round(r.x), 2 * ay - Math.round(r.y)];
  }
  return (f.x - p.x) ** 2 + (f.y - p.y) ** 2 > 64 ? [px, py] : f.angolo;
}

function labFantasmaCentro(g, f) {
  if (f.stato === "occhi" && f.y === 11 && (f.x === 13 || f.x === 14)) {
    f.stato = "entra";
    return;
  }
  if (f.x < 0 || f.x > 27) return;
  const vietato = (f.dir + 2) % 4;
  const opzioni = [];
  for (let d = 0; d < 4; d++) {
    if (d === vietato || !labLibera(f.x + LAB_DIR[d][0], f.y + LAB_DIR[d][1])) continue;
    if (d === LAB_SU && !f.spaventato && f.stato === "fuori" && LAB_NO_SU.has(`${f.x},${f.y}`)) continue;
    opzioni.push(d);
  }
  if (!opzioni.length) {
    f.dir = vietato;
    return;
  }
  if (f.spaventato && f.stato === "fuori") {
    f.dir = opzioni[Math.floor(labCaso(g) * opzioni.length)];
    return;
  }
  const [tx, ty] = labBersaglio(g, f);
  let dmin = Infinity;
  opzioni.forEach((d) => {
    const dd = (f.x + LAB_DIR[d][0] - tx) ** 2 + (f.y + LAB_DIR[d][1] - ty) ** 2;
    if (dd < dmin) {
      dmin = dd;
      f.dir = d;
    }
  });
}

function labPacCentro(g) {
  const p = g.pac;
  if (p.voglio !== null && labLibera(p.x + LAB_DIR[p.voglio][0], p.y + LAB_DIR[p.voglio][1])) {
    p.dir = p.voglio;
    p.fermo = false;
  } else p.fermo = !labLibera(p.x + LAB_DIR[p.dir][0], p.y + LAB_DIR[p.dir][1]);
}

function labMangia(g, i) {
  const tipo = g.puntini[i];
  g.puntini[i] = 0;
  g.mangiati++;
  g.punti += tipo === 2 ? 50 : 10;
  if (tipo === 2) {
    dinoSuono("lab_pillola");
    labSpavento(g);
  } else if (g.t - g.ultimoWaka >= 120) {
    g.ultimoWaka = g.t;
    g.waka = !g.waka;
    dinoSuono(g.waka ? "lab_waka1" : "lab_waka2");
  }
}

/** La pillola: i fantasmi diventano blu e fanno dietrofront. */
function labSpavento(g) {
  g.paura = LAB_PAURA;
  g.catena = 0;
  g.fantasmi.forEach((f) => {
    if (f.stato === "occhi" || f.stato === "entra") return;
    if (f.stato === "fuori" && !f.spaventato) f.dir = (f.dir + 2) % 4;
    f.spaventato = true;
  });
}

function labVicino(a, b) {
  return Math.abs(a.x - b.x) < 0.6 && Math.abs(a.y - b.y) < 0.6;
}

function labTick(g) {
  if (g.pronti > 0) {
    g.pronti -= LAB_TICK;
    return;
  }
  g.t += LAB_TICK;
  if (g.esito) return;
  if (g.fermo > 0) {
    g.fermo -= LAB_TICK;
    return;
  }
  const v = LAB_VEL;
  // fasi sparsi/caccia: l'orologio si ferma con la paura; al cambio dietrofront
  if (g.paura > 0) {
    g.paura -= LAB_TICK;
    if (g.paura <= 0) {
      g.paura = 0;
      g.fantasmi.forEach((f) => (f.spaventato = false));
    }
  } else {
    g.faseT += LAB_TICK;
    if (g.faseT >= LAB_FASI[g.fase]) {
      g.faseT = 0;
      g.fase++;
      g.fantasmi.forEach((f) => f.stato === "fuori" && (f.dir = (f.dir + 2) % 4));
    }
  }
  // il dino-mangiapunti: dietrofront subito, il resto al centro della casella
  const p = g.pac;
  if (p.voglio !== null && p.voglio !== p.dir) {
    if (p.voglio === (p.dir + 2) % 4) {
      if (!p.fermo) p.dir = p.voglio; // il dietrofront è sempre subito
    } else {
      // la svolta prenotata: appena la casella vicina la permette, anche un
      // po' prima o un po' dopo il centro (l'originale «taglia» gli angoli)
      const cx = Math.round(p.x);
      const cy = Math.round(p.y);
      if (Math.abs(p.x - cx) + Math.abs(p.y - cy) <= LAB_TAGLIO && labLibera(cx + LAB_DIR[p.voglio][0], cy + LAB_DIR[p.voglio][1])) {
        p.dir = p.voglio;
        p.fermo = false;
      }
    }
  }
  const prima = p.x + p.y;
  labMuovi(p, v * (g.paura > 0 ? 0.9 : 0.8), () => labPacCentro(g));
  p.anda += Math.abs(p.x + p.y - prima) > 2 ? 0.5 : Math.abs(p.x + p.y - prima);
  const tx = Math.round(p.x);
  const ty = Math.round(p.y);
  if (tx >= 0 && tx < 28 && g.puntini[ty * 28 + tx]) labMangia(g, ty * 28 + tx);
  g.fantasmi.forEach((f) => labFantasmaPasso(g, f, v));
  // gli incontri
  for (const f of g.fantasmi) {
    if (f.stato !== "fuori" || !labVicino(p, f)) continue;
    if (f.spaventato) {
      f.stato = "occhi";
      f.spaventato = false;
      g.catena++;
      const premio = 200 * 2 ** (g.catena - 1);
      g.punti += premio;
      g.testi.push({ x: f.x, y: f.y, testo: String(premio), t: g.t });
      g.fermo = 400;
      dinoSuono("lab_fantasma");
    } else {
      g.esito = "perso";
      g.preso = f.nome;
      g.fine = g.t + 600;
      dinoSuono("lab_morte");
      return;
    }
  }
  if (g.mangiati >= LAB_PUNTINI) {
    g.esito = "vinto";
    g.fine = g.t + 300;
  }
}

function labVerso(val, meta, passo) {
  return Math.abs(meta - val) <= passo ? meta : val + Math.sign(meta - val) * passo;
}

function labFantasmaPasso(g, f, v) {
  if (f.stato === "casa") {
    f.y += f.bob * v * 0.3;
    if (f.y < 13.5) f.bob = 1;
    if (f.y > 14.5) f.bob = -1;
    if (g.t >= f.uscita) f.stato = "esce";
  } else if (f.stato === "esce" || f.stato === "entra") {
    const passo = v * (f.stato === "entra" ? 1.2 : 0.5);
    if (f.x !== 13.5) f.x = labVerso(f.x, 13.5, passo);
    else {
      const meta = f.stato === "esce" ? 11 : 14;
      f.y = labVerso(f.y, meta, passo);
      if (f.y === meta) {
        if (f.stato === "esce") {
          f.stato = "fuori";
          f.dir = LAB_SINISTRA;
        } else {
          f.stato = "esce";
          f.spaventato = false;
        }
      }
    }
  } else {
    const tunnel = f.y === 14 && (f.x < 6 || f.x > 21);
    const vel = f.stato === "occhi" ? 1.6 : tunnel ? 0.4 : f.spaventato ? 0.5 : LAB_FANT_VEL[Math.min(1, g.livello)];
    labMuovi(f, v * vel, () => labFantasmaCentro(g, f));
  }
}

/** orologio somma gli stessi dt del motore (il suo b.t nella fase gioco;
 * se cambia il tetto BOSS_TEMPO o come conta il motore, va visto anche qui):
 * l'HUD conta i secondi veri che restano. Caso limite: l'ultimo puntino
 * mangiato prima dello scadere vale «vinto» anche se la scenetta (g.fine)
 * non è finita; una presa negli ultimi 600 ms invece resta «pari», come
 * prima (perdere è game over: lì decide il tempo). */
function labPasso(g, dt) {
  g.orologio += dt;
  g.resto += dt;
  while (g.resto >= LAB_TICK) {
    g.resto -= LAB_TICK;
    labTick(g);
  }
  const scaduto = g.esito === "vinto" && g.orologio >= BOSS_TEMPO;
  return g.esito && (g.t >= g.fine || scaduto) ? g.esito : null;
}

// —— disegno ——
let _labMuri = null;
/** I muri, una volta sola: il contorno a 2 unità dentro le caselle di muro
 * (come l'originale, corridoi larghi 9), arancio Crackify. */
function labMuri() {
  if (_labMuri) return _labMuri;
  const w = 28 * LAB_T;
  const h = 31 * LAB_T;
  const muro = (px, py) => {
    const tx = Math.floor(px / LAB_T);
    const ty = Math.floor(py / LAB_T);
    if (tx < 0 || ty < 0 || tx >= 28 || ty >= 31) return true;
    return LAB_MAPPA[ty][tx] === "#";
  };
  const dentro = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let ok = muro(x, y);
      for (let dy = -2; dy <= 2 && ok; dy++) for (let dx = -2; dx <= 2 && ok; dx++) ok = muro(x + dx, y + dy);
      dentro[y * w + x] = ok ? 1 : 0;
    }
  const d = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 1 : dentro[y * w + x]);
  const tela = document.createElement("canvas");
  tela.width = w;
  tela.height = h;
  const c = tela.getContext("2d");
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (!dentro[y * w + x]) continue;
      const bordo = !d(x - 1, y) || !d(x + 1, y) || !d(x, y - 1) || !d(x, y + 1);
      c.fillStyle = bordo ? "#ff7a1a" : "rgba(255, 106, 0, 0.16)";
      c.fillRect(x, y, 1, 1);
    }
  c.fillStyle = "#ffb8ff"; // la porta della casa
  c.fillRect(13 * LAB_T, 12 * LAB_T + 2, 2 * LAB_T, 1);
  _labMuri = tela;
  return tela;
}

function labTestaColori() {
  return { ...dinoColori(DINO_ARANCIO), t: "#ffffff", m: "#5a1408", H: "#a9a9b1" };
}

/** La testa del dino-mangiapunti centrata su (cx, cy), girata verso dir. */
function labTesta(c, cx, cy, dir, aperta, scala = 1, sx = 1, sy = 1) {
  const righe = LAB_TESTA[aperta];
  const tela = dinoTela(`lab|testa2|${aperta}`, righe, labTestaColori());
  const w = 10 * scala;
  c.save();
  c.translate(labPx(c, cx), labPx(c, cy));
  if (dir === LAB_SINISTRA) c.scale(-1, 1);
  else if (dir === LAB_SU) c.rotate(-Math.PI / 2);
  else if (dir === LAB_GIU) c.rotate(Math.PI / 2);
  c.scale(sx, sy);
  c.drawImage(tela, -w / 2, -w / 2, w, w);
  c.restore();
}

/** Un fantasma (10 x 10 a scala 1) con l'angolo in alto a sinistra in (x, y). */
function labFantasma(c, x, y, f, t, scala = 1, faccia = null, lampo = !!f.lampo) {
  x = labPx(c, x);
  y = labPx(c, y);
  const s = scala;
  const tipo = faccia || (f.stato === "occhi" || f.stato === "entra" ? "occhi" : f.spaventato ? "paura" : "normale");
  const gonna = Math.floor(t / 130) % 2;
  if (tipo === "paura") {
    c.drawImage(dinoTela(`lab|f|${lampo ? "w" : "b"}|${gonna}`, LAB_FANT[gonna], { "#": lampo ? "#f4f4f5" : "#2121ff" }), x, y, 10 * s, 10 * s);
    c.fillStyle = lampo ? "#ff0000" : "#ffb8ae";
    c.fillRect(x + 3 * s, y + 3 * s, 2 * s, 2 * s);
    c.fillRect(x + 6 * s, y + 3 * s, 2 * s, 2 * s);
    for (let i = 0; i < 8; i++) c.fillRect(x + (1 + i) * s, y + (i % 2 ? 6 : 7) * s, s, s); // la bocca a zig zag
    return;
  }
  if (tipo === "normale") c.drawImage(dinoTela(`lab|f|${f.colore}|${gonna}`, LAB_FANT[gonna], { "#": f.colore }), x, y, 10 * s, 10 * s);
  const [dx, dy] = LAB_DIR[f.dir == null ? LAB_SINISTRA : f.dir];
  [1, 6].forEach((ex, i) => {
    c.fillStyle = "#ffffff";
    c.fillRect(x + (ex + dx) * s, y + (2 + dy) * s, 3 * s, 4 * s);
    c.fillStyle = "#2121ff";
    const px = dx > 0 ? 1 : dx < 0 ? 0 : i === 0 ? 1 : 0;
    const py = dy < 0 ? 0 : dy > 0 ? 2 : 1;
    c.fillRect(x + (ex + dx + px) * s, y + (2 + dy + py) * s, 2 * s, 2 * s);
  });
}

function labBocca(g) {
  if (g.pac.fermo) return 1;
  return [0, 1, 2, 1][Math.floor(g.pac.anda * 3) % 4];
}

function labFondo(c, x0, y0) {
  const cielo = c.createLinearGradient(0, y0, 0, y0 + LAB_H);
  cielo.addColorStop(0, "#0b0714");
  cielo.addColorStop(0.7, "#160b18");
  cielo.addColorStop(1, "#3a140a");
  c.fillStyle = cielo;
  c.fillRect(x0, y0, LAB_W, LAB_H);
}

const LAB_PILLOLA = [".###.", "#####", "#####", "#####", ".###."];
const _labPuntiniTele = new WeakMap(); // partita → { tela, conta }: cache del disegno, non stato
function labTelaPuntini(g) {
  let v = _labPuntiniTele.get(g);
  if (!v) {
    const tela = document.createElement("canvas");
    tela.width = 28 * LAB_T;
    tela.height = 31 * LAB_T;
    v = { tela, conta: -1 };
    _labPuntiniTele.set(g, v);
  }
  if (v.conta !== g.mangiati) {
    const c = v.tela.getContext("2d");
    c.clearRect(0, 0, v.tela.width, v.tela.height);
    c.fillStyle = "#ffb8ae";
    for (let i = 0; i < g.puntini.length; i++) if (g.puntini[i] === 1) c.fillRect((i % 28) * LAB_T + 2, Math.floor(i / 28) * LAB_T + 2, 1, 1);
    v.conta = g.mangiati;
  }
  return v.tela;
}

/** Arrotonda al pixel vero dello schermo (non all'unità): gli attori
 * scorrono fluidi e restano netti. */
function labPx(c, v) {
  const k = c.getTransform().a || 1;
  return Math.round(v * k) / k;
}

function labDisegna(c, g, x0, y0) {
  labFondo(c, x0, y0);
  const mx = x0 + LAB_MX;
  const my = y0 + LAB_MY;
  c.drawImage(labMuri(), mx, my);
  // i puntini su una tela a parte (netti, ridisegnata solo quando cambiano),
  // le pillole a celle che lampeggiano
  c.drawImage(labTelaPuntini(g), mx, my);
  if (Math.floor(g.t / 200) % 2 === 0 || g.pronti > 0)
    for (let i = 0; i < g.puntini.length; i++)
      if (g.puntini[i] === 2) c.drawImage(dinoTela("lab|pillola", LAB_PILLOLA, { "#": "#ffb8ae" }), mx + (i % 28) * LAB_T, my + Math.floor(i / 28) * LAB_T, 5, 5);
  // gli attori, tagliati al labirinto (il tunnel)
  c.save();
  c.beginPath();
  c.rect(mx, my, 28 * LAB_T, 31 * LAB_T);
  c.clip();
  const p = g.pac;
  const cx = mx + p.x * LAB_T + 2.5;
  const cy = my + p.y * LAB_T + 2.5;
  labTesta(c, cx, cy, p.dir, labBocca(g));
  // la svolta prenotata: una freccina gialla davanti, finché non gira
  if (p.voglio !== null && p.voglio !== p.dir) {
    const [vx, vy] = LAB_DIR[p.voglio];
    const bx = labPx(c, cx + vx * 8 - 0.5);
    const by = labPx(c, cy + vy * 8 - 0.5);
    c.fillStyle = "rgba(255, 210, 63, 0.9)";
    c.fillRect(bx + vx, by + vy, 1, 1);
    c.fillRect(bx + vy, by + vx, 1, 1);
    c.fillRect(bx - vy, by - vx, 1, 1);
  }
  g.fantasmi.forEach((f) => {
    // gli ultimi 2 s di paura lampeggiano bianchi (disegno: niente stato)
    const lampo = f.spaventato && g.paura < 2000 && Math.floor(g.paura / 200) % 2 === 0;
    labFantasma(c, mx + f.x * LAB_T + 2.5 - 5, my + f.y * LAB_T + 2.5 - 5, f, g.t, 1, null, lampo);
  });
  c.restore();
  g.testi.forEach((s) => {
    if (g.t - s.t < 1000) dinoScritta(c, s.testo, mx + s.x * LAB_T + 2.5, my + s.y * LAB_T, "#00ffff", DINO_FONT_PICCOLO, 1);
  });
  if (g.pronti > 0) dinoScritta(c, "PRONTI!", mx + 14 * LAB_T, my + 17 * LAB_T, "#ffd23f", DINO_FONT_PICCOLO, 1);
  // a sinistra i puntini (mangiati sopra, da mangiare sotto), a destra i
  // secondi che restano prima che il boss finisca «pari»: si vince solo a
  // puntini, quindi è una corsa contro il tempo, non un «resisti». Negli
  // ultimi 10 s lampeggiano (con «riduci movimento» fissi, in giallo)
  const sx = x0 + LAB_MX / 2;
  c.fillStyle = "#ffb8ae";
  c.fillRect(sx - 1, y0 + 46, 3, 5);
  c.fillRect(sx - 2, y0 + 47, 5, 3);
  dinoScritta(c, String(Math.min(g.mangiati, LAB_PUNTINI)), sx, y0 + 58, "#ffd23f", DINO_FONT_PICCOLO);
  c.fillStyle = "rgba(255, 184, 174, 0.6)";
  c.fillRect(sx - 9, y0 + 71, 18, 1);
  dinoScritta(c, String(LAB_PUNTINI), sx, y0 + 75, "#ffb8ae", DINO_FONT_PICCOLO);
  const dx = x0 + LAB_W - LAB_MX / 2;
  const resta = Math.max(0, Math.ceil((BOSS_TEMPO - g.orologio) / 1000));
  const allarme = resta <= 10 && !g.esito;
  const colore = !allarme ? "#7dff4a" : dinoMotoRidotto() ? "#ffd23f" : Math.floor(g.orologio / 250) % 2 ? "#ffffff" : "#7dff4a";
  dinoScritta(c, String(resta), dx, y0 + 58, colore, DINO_FONT_PICCOLO);
  dinoScritta(c, "SEC", dx, y0 + 75, "#7dff4a", DINO_FONT_PICCOLO);
}

// —— input: swipe (con svolta prenotata), tocco verso un lato, frecce ——
function labDito(g, ev) {
  if (ev.tipo === "giu") {
    g.dito = { id: ev.id, x: ev.x, y: ev.y, mosso: false };
    return;
  }
  if (!g.dito || g.dito.id !== ev.id) return;
  const dx = ev.x - g.dito.x;
  const dy = ev.y - g.dito.y;
  if (ev.tipo === "su") {
    if (!g.dito.mosso) {
      // un tocco senza trascinare: verso il tocco, rispetto al dino
      const px = LAB_MX + g.pac.x * LAB_T + 2.5;
      const py = LAB_MY + g.pac.y * LAB_T + 2.5;
      const tx = ev.x - px;
      const ty = ev.y - py;
      if (Math.max(Math.abs(tx), Math.abs(ty)) > LAB_SWIPE) g.pac.voglio = Math.abs(tx) > Math.abs(ty) ? (tx > 0 ? LAB_DESTRA : LAB_SINISTRA) : ty > 0 ? LAB_GIU : LAB_SU;
    }
    g.dito = null;
    return;
  }
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (Math.max(ax, ay) < LAB_SWIPE) return;
  // quasi in diagonale: si aspetta ancora un pezzetto, così non gira dal lato sbagliato
  if (Math.max(ax, ay) < LAB_SWIPE * 2 && Math.max(ax, ay) < Math.min(ax, ay) * 1.3) return;
  g.pac.voglio = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? LAB_DESTRA : LAB_SINISTRA) : dy > 0 ? LAB_GIU : LAB_SU;
  g.dito.x = ev.x;
  g.dito.y = ev.y;
  g.dito.mosso = true;
}

function labTasto(g, ev) {
  const d = { su: LAB_SU, sinistra: LAB_SINISTRA, giu: LAB_GIU, destra: LAB_DESTRA }[ev.tasto];
  if (ev.giu && d !== undefined) g.pac.voglio = d;
}

// —— l'incontro: un fantasma sulla strada e una pillola fra lui e il dino;
// occhioni, poi il dino diventa mangiapunti, si mangia la pillola e il
// fantasma diventa blu ——
const LAB_POOF_DA = 700;
const LAB_PILLOLA_DA = 1300;
const LAB_SCALA = 3;
function labIncontroT(b) {
  return b.fase === "incontro" ? b.t : b.fase === "arrivo" ? -1 : BOSS_INCONTRO + b.t;
}
function labIncontroPasso(b) {
  const t = b.t;
  if (t >= LAB_POOF_DA && !b.labPoof) {
    b.labPoof = true;
    dino.y = 400; // il dino vero esce di scena (dinoBossFine lo rimette a terra)
  }
  const n = Math.floor((t - 820) / 160);
  if (t >= 820 && t < LAB_PILLOLA_DA && n !== b.labWaka) {
    b.labWaka = n;
    dinoSuono(n % 2 ? "lab_waka2" : "lab_waka1");
  }
  if (t >= LAB_PILLOLA_DA && !b.labPillola) {
    b.labPillola = true;
    dinoSuono("lab_pillola");
  }
}
function labPosti(b, W) {
  const gx = dinoBossPosto(b, W, 10 * LAB_SCALA);
  const dx = dinoX() + 14;
  return { gx, dx, pill: Math.round((dx + 14 + gx) / 2) };
}
function labStrada(c, b, terra, W) {
  const t = labIncontroT(b);
  const { gx, pill } = labPosti(b, W);
  const fermo = dinoMotoRidotto();
  const paura = t >= LAB_PILLOLA_DA;
  const trema = paura && !fermo ? (Math.floor(t / 60) % 2 ? 1 : -1) : 0;
  const fuga = paura ? Math.max(0, t - 1700) * 0.06 : 0;
  const su = fermo ? 0 : Math.round(Math.sin(Math.max(0, b.t) / 200) * 2);
  c.fillStyle = "rgba(0, 0, 0, 0.35)";
  c.fillRect(gx + fuga + 4, terra - 1, 22, 2);
  const f = { colore: "#ff0000", dir: LAB_SINISTRA, stato: "fuori", spaventato: paura, lampo: paura && Math.floor(t / 150) % 2 === 0 };
  labFantasma(c, gx + trema + fuga, terra - 10 * LAB_SCALA - 4 + su, f, b.t, LAB_SCALA);
  if (t < LAB_PILLOLA_DA && (fermo || Math.floor(b.t / 220) % 2 === 0)) {
    c.fillStyle = "#ffb8ae";
    c.fillRect(pill - 2, terra - 18, 4, 8);
    c.fillRect(pill - 4, terra - 16, 8, 4);
  }
}
function labSopra(c, b, W) {
  const t = labIncontroT(b);
  if (t < LAB_POOF_DA) {
    dinoBossSpavento(c, b);
    return;
  }
  const terra = dinoTerra();
  const { gx, dx, pill } = labPosti(b, W);
  const fermo = dinoMotoRidotto();
  let x = dx;
  if (t > 850) x = dx + (pill - dx) * Math.min(1, (t - 850) / (LAB_PILLOLA_DA - 850));
  if (t > LAB_PILLOLA_DA) x = Math.min(gx - 10, pill + (t - LAB_PILLOLA_DA) * 0.03);
  const bocca = fermo ? 1 : [0, 1, 2, 1][Math.floor(t / 70) % 4];
  // «boing»: la testa si gonfia a palla e rimbalza un paio di volte
  const q = (t - LAB_POOF_DA) / 360;
  const boing = fermo || q >= 1 ? 1 : 1 + 0.3 * Math.sin(q * Math.PI * 3) * (1 - q);
  labTesta(c, x, terra - 15 * boing, LAB_DESTRA, bocca, LAB_SCALA, 2 - boing, boing);
  // la nuvoletta della trasformazione
  if (t < LAB_POOF_DA + 250) {
    const q = (t - LAB_POOF_DA) / 250;
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * 6.283;
      const r = 8 + q * 18;
      c.fillStyle = i % 2 ? "#ffffff" : "#ffd23f";
      c.fillRect(Math.round(dx + Math.cos(a) * r) - 1, Math.round(terra - 15 + Math.sin(a) * r) - 1, 3, 3);
    }
  }
}

// —— la gag sulla strada (Vitto 09/10: fuori dal minigioco): quella di serie
// di boss.js col fantasma rosso, che sotto il soffio diventa blu di paura
// e a vincere ondeggia contento ——
function labRitratto(c, b, x, terra, stato) {
  const fermo = dinoMotoRidotto();
  const su = stato.esulta && !fermo ? Math.round(Math.sin(b.t / 120) * 2) : 0;
  c.fillStyle = "rgba(0, 0, 0, 0.35)";
  c.fillRect(x + 4, terra - 1, 10 * LAB_SCALA - 8, 2);
  const f = { colore: "#ff0000", dir: LAB_SINISTRA, stato: "fuori", spaventato: stato.arrosto, lampo: stato.arrosto && Math.floor(b.t / 150) % 2 === 0 };
  labFantasma(c, x, terra - 10 * LAB_SCALA - 4 + su, f, b.t, LAB_SCALA);
}

const BOSS_LABIRINTO = {
  titolo: "Labirinto!",
  sotto: "Mangia e scappa",
  colore: "#ffd23f",
  aiuto: "Scorri per girare",
  nuovo: labNuovo,
  misura: () => ({ w: LAB_W, h: LAB_H }),
  passo: labPasso,
  disegna: (c, g, x0, y0) => labDisegna(c, g, x0, y0),
  dito: labDito,
  tasto: labTasto,
  larga: 10 * LAB_SCALA,
  ritratto: labRitratto,
  strada: labStrada,
  sopra: labSopra,
  incontroPasso: labIncontroPasso,
};

BOSS_GIOCHI.labirinto = BOSS_LABIRINTO;
Object.assign(BOSS_SUONI, {
  // la morte: gorgheggio che scende, poi i due «pop» finali
  lab_morte: (tono) => {
    for (let i = 0; i < 6; i++) tono(900 - i * 110, 500 - i * 60, i * 0.1, 0.1, 0.5);
    tono(300, 80, 0.62, 0.12, 0.6);
    tono(300, 80, 0.78, 0.12, 0.6);
  },
});
