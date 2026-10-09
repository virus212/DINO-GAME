// —— SCIMMIONE (fase 4). Tributo fedele al primo livello del cabinato dello
// scimmione coi barili (quello delle travi inclinate): sei travi a zig zag,
// le scale intere e quelle rotte, lo scimmione in cima che lancia barili
// che rotolano lungo le travi, cadono dai bordi e a volte scendono dalle
// scale, il bidone in fondo a sinistra che li inghiotte con la fiammata.
// Il dino al posto dell'idraulico sale fino alla ragazza sulla trave più
// alta. Decisioni (09/10): 2 vite come gli invasori, si vince arrivando in
// cima, si perde al secondo barile addosso; salto sopra i barili (+100).
// Un dito: tieni premuto e il dino cammina verso il dito; trascina su (o
// giù) vicino a una scala e sale (o scende); tocco breve, swipe veloce in
// su o un secondo dito: salto. Frecce, spazio e invio sul desktop.
// Ambiente nostro: cielo del tramonto, travi arancio, scritte a pixel.
// Campo 256 x 150 unità. File a parte: solo definizioni al caricamento,
// la registrazione in fondo ——
const SC_W = 256;
const SC_H = 150;
const SC_TICK = 1000 / 60; // passo fisso: uguale a 60 e a 120 Hz
// le travi dal basso: estremi, altezza della superficie ai due capi e verso
// in cui ci rotolano i barili (la 6 è quella della ragazza, la meta)
const SC_TRAVI = [
  { x1: 0, x2: 256, y1: 147, y2: 141, dir: -1 },
  { x1: 8, x2: 232, y1: 118, y2: 124, dir: 1 },
  { x1: 24, x2: 248, y1: 102, y2: 96, dir: -1 },
  { x1: 8, x2: 232, y1: 74, y2: 80, dir: 1 },
  { x1: 24, x2: 248, y1: 58, y2: 52, dir: -1 },
  { x1: 8, x2: 232, y1: 32, y2: 38, dir: 1 },
  { x1: 96, x2: 152, y1: 14, y2: 14, dir: 0 },
];
const SC_META = 6;
// le scale: centro, trave da cui parte (sale alla successiva); le rotte non
// si salgono (ma i barili ci scendono lo stesso, come nell'originale)
const SC_SCALE = [
  { x: 200, da: 0 }, { x: 88, da: 0, rotta: true },
  { x: 40, da: 1 }, { x: 120, da: 1 }, { x: 184, da: 1, rotta: true },
  { x: 208, da: 2 }, { x: 80, da: 2, rotta: true },
  { x: 48, da: 3 }, { x: 136, da: 3 }, { x: 192, da: 3, rotta: true },
  { x: 208, da: 4 }, { x: 120, da: 4, rotta: true },
  { x: 136, da: 5 },
];
const SC_SCIMMIA_X = 22; // lo scimmione sulla trave in cima (24 x 22)
const SC_LANCIO_X = 50; // dove nasce il barile lanciato
const SC_BIDONE_X = 6; // il bidone in fondo a sinistra (12 x 14)
const SC_PASSO = 0.7; // camminata del dino, unità per tick
const SC_SALTO_V = 1.8; // il salto: alto 13 unità, mezzo secondo in aria (un barile da fermo si scavalca con ~0,2 s di margine)
const SC_GRAVITA = 0.12;
const SC_SCALA_V = 0.55;
const SC_TIENI = 150; // ms: il dito tenuto giù comincia a camminare solo dopo (prima è un tocco)
const SC_TIRA = 8; // unità di trascinamento in su o in giù per chiedere la scala
const SC_MARTELLO = 9000; // ms col martello in mano
const SC_MARTELLO_SU = 15; // il martello sospeso: la base sopra la trave (si prende saltando)
const SC_MELODIA = [1, 2, 3, 2, 1, 2, 4, 2]; // la musichetta del martello, a giro

/** Le righe a metà: la metà destra è lo specchio della sinistra. */
const scSpecchio = (righe) => righe.map((r) => r + [...r].reverse().join(""));
/** Le righe girate (il dino che guarda a sinistra). */
const scGira = (righe) => righe.map((r) => [...r].reverse().join(""));

// lo scimmione di fronte, 24 x 22, a pugni in terra e a braccia alzate
const SC_SCIMMIA = [
  scSpecchio([
    "........oooo",
    "......ooBBBB",
    ".....oBBBBBB",
    "....oBBBBBBB",
    "....oBffffff",
    "....oBfwwfff",
    "....oBfwefff",
    "....oBffffff",
    "...oBBfffffo",
    "..oBBBffmmmm",
    ".oBBBBBfffff",
    "oBBBBBBBcccc",
    "oBBBoBBccccc",
    "oBBBoBBccccc",
    "oBBBoBBBcccc",
    "oBBBooBBBBcc",
    "oBBBo.oBBBBB",
    "obbbo.oBBBBB",
    "obbbo..oBBBB",
    ".ooo...oBBoo",
    "......oBBBo.",
    ".....ooooo..",
  ]),
  scSpecchio([
    "oo......oooo",
    "obo...ooBBBB",
    "obBo.oBBBBBB",
    ".oBBoBBBBBBB",
    "..oBoBffffff",
    "..oBoBfwwfff",
    "...oBBfwefff",
    "...oBBffffff",
    "...oBBfffffo",
    "...oBBffmmmm",
    "...oBBfmmwmm",
    "..oBBBBBcccc",
    ".oBBBBBccccc",
    ".oBBBBBccccc",
    ".oBBBBBBcccc",
    ".oBBBBBBBBcc",
    "..oBBBBBBBBB",
    "..oBBBBBBBBB",
    "...oBBBBBBBB",
    "...ooBBBoooo",
    "....oBBBo...",
    "....ooooo...",
  ]),
];
const SC_SCIMMIA_COLORI = { o: "#1c0a04", B: "#8a3a12", b: "#b5541c", f: "#f2b27a", c: "#e89a5c", w: "#ffffff", e: "#141414", m: "#4a1206" };
// arrostito dal soffio: tutto carbone, restano gli occhi
const SC_SCIMMIA_ARROSTO = { o: "#0a0604", B: "#2a1a12", b: "#3a2416", f: "#4a3424", c: "#3a2a1e", w: "#ffffff", e: "#141414", m: "#0a0604" };
// il dino piccolo (12 x 12): due passi di profilo, il salto, e di schiena sulla scala
const SC_DINO_PASSI = [
  ["......#####.", "......#e####", "......######", "......###...", "#....####...", "##..######..", "#########.d.", ".#########..", "..#######...", "...#####....", "...##.##....", "...#...##..."],
  ["......#####.", "......#e####", "......######", "......###...", "#....####...", "##..######..", "#########.d.", ".#########..", "..#######...", "...#####....", "...##.##....", "...##..#...."],
  ["......#####.", "......#e####", "......######", "......###...", "#....####...", "##..######..", "#########d..", ".#########..", "..#######...", "...#####....", "..##...##...", "............"],
];
const SC_DINO_SCALA = [
  ["....####....", "...######...", "...######...", "#..######...", "##.######...", ".#########..", "..#########.", "..########..", "...######...", "...######...", "...##..##...", "...##......."],
];
SC_DINO_SCALA.push(scGira(SC_DINO_SCALA[0]));
const SC_DINO_COLORI = { "#": "#ff6a00", e: "#141414", d: "#8f3200" };
// la ragazza in cima (8 x 13), capelli al vento
const SC_RAGAZZA = [
  ["..hhhh..", ".hhffhh.", ".hfeffh.", ".hffffhh", "hh.ff..h", "..pppp..", ".pppppp.", "f.pppp.f", "..pppp..", ".pppppp.", "pppppppp", "..f..f..", "..s..s.."],
  ["..hhhh..", ".hhffhh.", ".hfeffh.", "hhffffh.", "h..ff.hh", "..pppp..", "fpppppp.", "..pppp.f", "..pppp..", ".pppppp.", "pppppppp", "..f..f..", "..s..s.."],
];
const SC_RAGAZZA_COLORI = { h: "#ffb066", f: "#ffd9b8", e: "#141414", p: "#ff5fd2", s: "#f4f4f5" };
// il barile che rotola (8 x 8), quattro pose della fascia che gira
const SC_BARILE = [0, 1, 2, 3].map((posa) => {
  const righe = ["..oooo..", ".obbbbo.", "obbbbbbo", "obbbbbbo", "obbbbbbo", "obbbbbbo", ".obbbbo.", "..oooo.."].map((r) => [...r]);
  for (let i = 1; i < 7; i++) {
    const [x, y] = [
      [i, 3], [i, i], [3, i], [7 - i, i],
    ][posa];
    if (righe[y][x] === "b") righe[y][x] = "d";
    const [x2, y2] = [[i, 4], [i, i + 1 > 6 ? 6 : i + 1], [4, i], [7 - i, i + 1 > 6 ? 6 : i + 1]][posa];
    if (righe[y2] && righe[y2][x2] === "b") righe[y2][x2] = "d";
  }
  return righe.map((r) => r.join(""));
});
const SC_BARILE_COLORI = { o: "#3a1606", b: "#c8742a", d: "#6a2c0c" };
// il barile in piedi (della pila accanto allo scimmione) e quello di fronte (scende)
const SC_BARILE_DRITTO = [".oooooo.", "obbbbbbo", "oddddddo", "obbbbbbo", "obbbbbbo", "obbbbbbo", "oddddddo", ".oooooo."];
const SC_BIDONE = [".oooooooooo.", "oaaaaaaaaaao", "oddddddddddo", "oaaaaaaaaaao", "oaaaaaaaaaao", "oaayyaaaaaao", "oaayyaaaaaao", "oaaaaaaaaaao", "oddddddddddo", "oaaaaaaaaaao", "oaaaaaaaaaao", "oaaaaaaaaaao", "oddddddddddo", ".oooooooooo."];
const SC_BIDONE_COLORI = { o: "#141414", a: "#2a2f4a", d: "#ff6a00", y: "#ffd23f" };
const SC_BARILE_BLU = { o: "#0a1a3a", b: "#4aa8ff", d: "#1a4a9a" }; // il barile blu che accende il bidone
// la fiammella uscita dal bidone (8 x 8, due pose delle punte), con gli occhi
const SC_FIAMMELLA = [
  ["..y...y.", ".yy..yy.", ".yyyyyy.", "yyoooooy", "yowkowko", "yoooooo.", ".oooooo.", "..oooo.."],
  ["...y..y.", "..yy.yy.", ".yyyyyy.", "yyoooooy", "yowkowko", "yoooooo.", ".oooooo.", "..oooo.."],
];
const SC_FIAMMELLA_COLORI = { y: "#ffd23f", o: "#ff6a00", w: "#ffffff", k: "#141414" };
// il martello: dritto (sospeso, o alzato sopra la testa) e steso davanti
const SC_MARTELLO_SU_RIGHE = ["hhhhhh", "hhhhhh", "hhhhhh", "..mm..", "..mm..", "..mm..", "..mm..", "..mm..", "..mm.."];
const SC_MARTELLO_GIU = ["......hhh", "......hhh", "mmmmmmhhh", "mmmmmmhhh", "......hhh", "......hhh"];
const SC_MARTELLO_GIU_SX = scGira(SC_MARTELLO_GIU);
const SC_MARTELLO_COLORI = { h: "#c9c9ce", m: "#8f3200" };
const SC_MARTELLO_FINE = { h: "#ffd23f", m: "#8f3200" }; // lampeggia quando sta per finire
const SC_CUORE = [".##.##.", "#######", "#######", ".#####.", "..###..", "...#..."];

/** La superficie di una trave a quella x: a gradini di 8 unità come le
 * travi dell'originale. */
function scSu(i, x) {
  const t = SC_TRAVI[i];
  const m = Math.floor(x / 8) * 8 + 4;
  const q = Math.max(0, Math.min(1, (m - t.x1) / (t.x2 - t.x1)));
  return Math.round(t.y1 + (t.y2 - t.y1) * q);
}

function scNuovo(livello) {
  const seme = window.__dinoSeme || Math.floor(Math.random() * 1e9);
  const caso = invCaso(seme);
  const stelle = [];
  for (let i = 0; i < 30; i++) stelle.push({ x: 2 * Math.floor((caso() * SC_W) / 2), y: 2 * Math.floor((caso() * 110) / 2) + 2, f: caso() * 6.28 });
  return {
    caso,
    liv: livello || 0,
    t: 0,
    resto: 0,
    d: { x: 36, y: scSu(0, 36), piano: 0, scala: null, aria: false, vy: 0, vx: 0, verso: 1, passo: 0, alto: 0 },
    barili: [],
    prossimoBarile: 900, // il primo (blu, dritto nel bidone) quasi subito
    lancio: 0,
    lanci: 0,
    petto: 0,
    fiamma: 0,
    acceso: false, // il bidone si accende col primo barile blu
    fiamme: [], // le fiammelle uscite dal bidone
    prossimaFiamma: 0,
    martelli: [{ x: 168, piano: 1, preso: false }, { x: 176, piano: 4, preso: false }],
    martello: 0,
    nota: 0,
    prossimaNota: 0,
    scoppi: [],
    saltoVerso: null,
    vite: 2,
    invulnerabile: 0,
    punti: 0,
    scritte: [],
    dito: null,
    tasti: {},
    salta: false,
    prossimoPasso: 0,
    fine: 0,
    esito: null,
    stelle,
  };
}

/** La scala buona per salire (-1) o scendere (+1) più vicina alla x
 * «mira» (il dito, o il dino coi tasti), entro «entro» unità. */
function scScalaPer(g, verso, mira, entro) {
  const da = verso < 0 ? g.d.piano : g.d.piano - 1;
  let meglio = null;
  SC_SCALE.forEach((s) => {
    if (s.rotta || s.da !== da || Math.abs(s.x - mira) > entro) return;
    if (!meglio || Math.abs(s.x - mira) < Math.abs(meglio.x - mira)) meglio = s;
  });
  return meglio;
}

/** Cosa chiede il giocatore adesso: tasti, o il dito tenuto giù. Il dito
 * comincia a camminare dopo SC_TIENI ms (o appena si muove), così un tocco
 * breve è solo un salto; trascinato su o giù chiede la scala più vicina al
 * dito, e il dino ci va da solo e sale. */
function scComando(g) {
  let orizz = (g.tasti.destra ? 1 : 0) - (g.tasti.sinistra ? 1 : 0);
  let vert = (g.tasti.giu ? 1 : 0) - (g.tasti.su ? 1 : 0);
  let mira = g.d.x;
  let entro = 6;
  const f = g.dito;
  if (f && (f.attivo || g.t - f.t0 >= SC_TIENI)) {
    f.attivo = true;
    const dx = f.x - g.d.x;
    if (Math.abs(dx) > 2) orizz = Math.sign(dx);
    const tirato = f.y - f.y0;
    if (Math.abs(tirato) > SC_TIRA) vert = Math.sign(tirato);
    mira = f.x;
    entro = 16;
  }
  return { orizz, vert, mira, entro };
}

function scPrendi(g) {
  const d = g.d;
  g.vite--;
  g.invulnerabile = 1600;
  dinoSuono("sc_colpito");
  dinoVibra("HEAVY");
  // un attimo di respiro: via i barili lì vicino
  g.barili = g.barili.filter((b) => Math.abs(b.x - d.x) > 34 || Math.abs(b.y - d.y) > 16);
  if (g.vite <= 0) {
    g.esito = "perso";
    g.fine = g.t + 700;
  }
}

/** Un passo fisso da 1/60 s. */
function scTick(g) {
  const ms = SC_TICK;
  g.t += ms;
  g.scritte = g.scritte.filter((s) => g.t - s.t < 700);
  g.scoppi = g.scoppi.filter((o) => g.t - o.t < 320);
  if (g.fine) return;
  const d = g.d;
  const cmd = scComando(g);
  const salta = g.salta;
  g.salta = false;
  let cammina = false;
  if (d.scala) {
    // sulla scala: solo su e giù
    const s = d.scala;
    if (cmd.vert) {
      d.y += cmd.vert * SC_SCALA_V;
      d.passo += ms;
      cammina = true;
    }
    if (d.y <= scSu(s.da + 1, s.x)) {
      d.y = scSu(s.da + 1, s.x);
      d.piano = s.da + 1;
      d.scala = null;
    } else if (d.y >= scSu(s.da, s.x)) {
      d.y = scSu(s.da, s.x);
      d.piano = s.da;
      d.scala = null;
    }
  } else if (d.aria) {
    d.vy += SC_GRAVITA;
    d.y += d.vy;
    const t = SC_TRAVI[d.piano];
    d.x = Math.max(t.x1 + 4, Math.min(t.x2 - 4, d.x + d.vx));
    const suolo = scSu(d.piano, d.x);
    if (d.vy > 0 && d.y >= suolo) {
      d.y = suolo;
      d.aria = false;
      d.vy = 0;
    }
  } else {
    // la scala chiesta (la più vicina al dito): il dino ci va e ci sale
    const s = cmd.vert && !g.martello ? scScalaPer(g, cmd.vert, cmd.mira, cmd.entro) : null;
    let verso = cmd.orizz;
    if (s) {
      if (Math.abs(s.x - d.x) <= SC_PASSO) {
        d.scala = s;
        d.x = s.x;
        if (cmd.vert > 0) d.y += 1; // si stacca dalla trave di sopra
        verso = 0;
      } else verso = Math.sign(s.x - d.x);
    }
    if (!d.scala) {
      if (verso) {
        d.verso = verso;
        const t = SC_TRAVI[d.piano];
        d.x = Math.max(t.x1 + 4, Math.min(t.x2 - 4, d.x + verso * SC_PASSO));
        d.passo += ms;
        cammina = true;
      }
      d.y = scSu(d.piano, d.x);
      if (salta && !g.martello) {
        const sv = g.saltoVerso === null ? verso : g.saltoVerso;
        d.aria = true;
        d.vy = -SC_SALTO_V;
        d.vx = sv * SC_PASSO;
        if (sv) d.verso = sv;
        dinoSuono("sc_salto");
      }
    }
  }
  g.saltoVerso = null;
  if (cammina) {
    g.prossimoPasso -= ms;
    if (g.prossimoPasso <= 0) {
      g.prossimoPasso = 170;
      dinoSuono("sc_passo");
    }
  }
  // arrivato dalla ragazza: vinto
  if (d.piano === SC_META && !d.scala) {
    g.esito = "vinto";
    g.fine = g.t + 600;
    return;
  }
  g.invulnerabile = Math.max(0, g.invulnerabile - ms);
  // lo scimmione: prende un barile dalla pila, lo alza sopra la testa e lo
  // lancia giù per la trave; il primo è blu e lo butta dritto nel bidone,
  // che si accende. Fra un lancio e l'altro ogni tanto si batte il petto
  if (g.petto && g.t >= g.petto && !g.pettoSuonato) {
    g.pettoSuonato = true;
    dinoSuono("sc_petto");
  }
  if (g.petto && g.t >= g.petto + SC_PETTO) g.petto = 0;
  g.prossimoBarile -= ms;
  if (g.prossimoBarile <= 0 && !g.lancio && !g.petto) {
    g.lancio = g.t;
    g.lanci++;
    g.prossimoBarile = Math.max(1600, 2400 + g.caso() * 1300 - g.liv * 300);
  }
  if (g.lancio && g.t - g.lancio >= 500) {
    g.lancio = 0;
    const primo = g.lanci === 1;
    if (g.barili.length < 8) {
      g.barili.push({
        x: primo ? SC_BIDONE_X + 6 : SC_LANCIO_X,
        y: scSu(5, primo ? SC_SCIMMIA_X : SC_LANCIO_X) - (primo ? 14 : 0),
        piano: 5,
        stato: primo ? "giu" : "rotola",
        blu: scBlu(g.lanci),
        vy: 0,
        dx: 0,
        giro: 0,
        ultima: null,
        saltato: false,
        scala: null,
      });
    }
    dinoSuono("sc_lancio");
    if (!primo && g.caso() < 0.4) {
      g.petto = g.t + 500;
      g.pettoSuonato = false;
      g.prossimoBarile = Math.max(g.prossimoBarile, 500 + SC_PETTO + 400);
    }
  }
  // i martelli: si prendono saltandoci contro, e parte la musichetta
  if (!g.martello) {
    g.martelli.forEach((m) => {
      if (m.preso || d.scala || d.piano !== m.piano || Math.abs(d.x - m.x) >= 7) return;
      if (d.y - 12 <= scSu(m.piano, m.x) - SC_MARTELLO_SU) {
        m.preso = true;
        g.martello = SC_MARTELLO;
        g.nota = 0;
        g.prossimaNota = 0;
      }
    });
  } else {
    g.martello = Math.max(0, g.martello - ms);
    g.prossimaNota -= ms;
    if (g.martello && g.prossimaNota <= 0) {
      g.prossimaNota = 150;
      dinoSuono(`sc_martello${SC_MELODIA[g.nota % SC_MELODIA.length]}`);
      g.nota++;
    }
  }
  const v = 0.85 + 0.15 * g.liv;
  g.barili = g.barili.filter((b) => {
    if (b.stato === "giu") {
      // il barile blu: dritto giù attraverso le travi, fino al bidone
      b.vy = Math.min(2.4, b.vy + 0.12);
      b.y += b.vy;
      if (b.y >= scSu(0, b.x) - 12) {
        scAccendi(g, true);
        return false;
      }
    } else if (b.stato === "rotola") {
      const t = SC_TRAVI[b.piano];
      const prima = b.x;
      b.x += v * t.dir;
      b.giro += v;
      // passando sopra una scala a volte ci scende (di più se il dino è sotto)
      const s = SC_SCALE.find((s) => s.da === b.piano - 1 && s !== b.ultima && (prima - s.x) * (b.x - s.x) <= 0);
      if (s) {
        b.ultima = s;
        const sotto = d.piano < b.piano ? 0.15 : 0;
        if (g.caso() < 0.22 + sotto) {
          b.stato = "scende";
          b.scala = s;
          b.x = s.x;
        }
      }
      if (b.stato === "rotola") {
        if (b.piano === 0 && b.x < SC_BIDONE_X + 12) {
          scAccendi(g, b.blu); // il bidone lo inghiotte: fiammata
          return false;
        }
        if (b.x < t.x1 || b.x > t.x2) {
          b.stato = "cade";
          b.vy = 0;
          b.dx = 0.4 * t.dir;
          b.piano--;
        } else b.y = scSu(b.piano, b.x);
      }
    } else if (b.stato === "cade") {
      b.vy = Math.min(3, b.vy + 0.18);
      b.y += b.vy;
      b.x += b.dx;
      const suolo = scSu(b.piano, b.x);
      if (b.y >= suolo) {
        b.y = suolo;
        b.stato = "rotola";
        b.ultima = null;
      }
    } else {
      b.y += 0.9;
      const suolo = scSu(b.scala.da, b.x);
      if (b.y >= suolo) {
        b.y = suolo;
        b.piano = b.scala.da;
        b.stato = "rotola";
      }
    }
    // il martello lo spacca: +300
    if (g.martello && scColpoMartello(g, b)) {
      scSpacca(g, b, 300);
      return false;
    }
    if (b.stato === "rotola") scScavalca(g, b);
    if (scAddosso(g, b)) {
      scPrendi(g);
      return false;
    }
    return true;
  });
  // le fiammelle: girano per le travi, a volte salgono o scendono le scale
  // (mai fin sulle ultime due), e se il dino è sulla loro trave lo cercano
  const vf = 0.3 + 0.05 * g.liv;
  g.fiamme = g.fiamme.filter((f) => {
    if (g.t - f.nasce < 400) return true; // sta saltando fuori dal bidone
    if (f.ultima && Math.abs(f.x - f.ultima.x) > 12) f.ultima = null;
    if (f.scala) {
      f.y += f.su * 0.35;
      if (f.y <= scSu(f.scala.da + 1, f.x)) {
        f.y = scSu(f.scala.da + 1, f.x);
        f.piano = f.scala.da + 1;
        f.scala = null;
      } else if (f.y >= scSu(f.scala.da, f.x)) {
        f.y = scSu(f.scala.da, f.x);
        f.piano = f.scala.da;
        f.scala = null;
      }
    } else {
      const t = SC_TRAVI[f.piano];
      f.cambia -= ms;
      if (f.cambia <= 0) {
        f.cambia = 900 + g.caso() * 1600;
        if (f.piano === d.piano && !d.scala && g.caso() < 0.7) f.dir = Math.sign(d.x - f.x) || 1;
        else if (g.caso() < 0.4) f.dir = -f.dir;
      }
      const prima = f.x;
      f.x += vf * f.dir;
      if (f.x < t.x1 + 4 || f.x > t.x2 - 4) {
        f.x = Math.max(t.x1 + 4, Math.min(t.x2 - 4, f.x));
        f.dir = -f.dir;
      }
      f.y = scSu(f.piano, f.x);
      const s = SC_SCALE.find((s) => !s.rotta && s.da < 4 && s !== f.ultima && (s.da === f.piano || s.da === f.piano - 1) && (prima - s.x) * (f.x - s.x) <= 0);
      if (s) {
        f.ultima = s;
        if (g.caso() < 0.3) {
          f.scala = s;
          f.x = s.x;
          f.su = s.da === f.piano ? -1 : 1;
          if (f.su > 0) f.y += 1;
        }
      }
    }
    if (g.martello && scColpoMartello(g, f)) {
      scSpacca(g, f, 500);
      g.prossimaFiamma = g.t + 5000;
      return false;
    }
    if (!f.scala) scScavalca(g, f);
    if (scAddosso(g, f)) {
      scPrendi(g);
      // torna nel bidone e riparte da lì
      Object.assign(f, { x: SC_BIDONE_X + 16, piano: 0, scala: null, nasce: g.t, dir: 1, ultima: null });
      f.y = scSu(0, f.x);
    }
    return true;
  });
  if (g.acceso && !g.fiamme.length && g.prossimaFiamma && g.t >= g.prossimaFiamma) {
    g.prossimaFiamma = 0;
    scNuovaFiamma(g);
  }
}

const SC_PETTO = 900; // ms in cui si batte il petto fra due lanci
const scBlu = (n) => n === 1 || n % 6 === 0; // il primo barile e ogni sesto sono blu

/** Il bidone inghiotte un barile: fiammata; il primo lo accende, e un
 * barile blu fa uscire una fiammella (al massimo due in giro). */
function scAccendi(g, blu) {
  g.fiamma = g.t;
  if (!g.acceso) {
    g.acceso = true;
    blu = true;
  }
  if (blu && g.fiamme.length < 2) scNuovaFiamma(g);
}
function scNuovaFiamma(g) {
  const x = SC_BIDONE_X + 16;
  g.fiamme.push({ x, y: scSu(0, x), piano: 0, scala: null, su: 0, dir: 1, cambia: 1500, saltato: false, nasce: g.t, ultima: null });
  dinoSuono("sc_fuoco");
}
/** Il dino ci salta sopra (una volta sola): +100. */
function scScavalca(g, o) {
  const d = g.d;
  if (!d.aria || o.saltato || o.piano !== d.piano || Math.abs(o.x - d.x) >= 5 || d.y >= o.y - 6) return;
  o.saltato = true;
  g.punti += 100;
  g.scritte.push({ x: o.x, y: o.y - 16, testo: "100", t: g.t });
  dinoSuono("sc_barile");
}
/** Ci sbatte contro (da lampeggiante no). */
function scAddosso(g, o) {
  const d = g.d;
  return g.invulnerabile <= 0 && g.vite > 0 && Math.abs(o.x - d.x) < 5 && d.y > o.y - 5 && d.y - 10 < o.y;
}
/** Il martello alzato (si alterna con quello steso davanti). */
function scMartelloSu(g) {
  return Math.floor(g.martello / 200) % 2 === 0;
}
/** Il martello lo prende: addosso al dino sempre, davanti quando è steso. */
function scColpoMartello(g, o) {
  const d = g.d;
  if (d.scala || Math.abs(o.y - d.y) > 12) return false;
  const dx = o.x - d.x;
  return Math.abs(dx) < 7 || (!scMartelloSu(g) && dx * d.verso > 0 && Math.abs(dx) < 18);
}
function scSpacca(g, o, punti) {
  g.punti += punti;
  g.scritte.push({ x: o.x, y: o.y - 16, testo: String(punti), t: g.t });
  g.scoppi.push({ x: o.x, y: o.y - 4, t: g.t });
  dinoSuono("sc_spacca");
}

function scPasso(g, dt) {
  g.resto += dt;
  while (g.resto >= SC_TICK) {
    g.resto -= SC_TICK;
    scTick(g);
  }
  return g.fine && g.t >= g.fine ? g.esito : null;
}

/** Disegna una cosa a celle da 1 (tela in cache) in unità del campo. */
function scSprite(c, chiave, righe, colori, x, y, scala = 1) {
  c.drawImage(dinoTela(`sc|${chiave}`, righe, colori), Math.round(x), Math.round(y), righe[0].length * scala, righe.length * scala);
}

/** La tela di una trave (a gradini, con la reticolare a zig zag). */
function scTrave(i) {
  const t = SC_TRAVI[i];
  const w = t.x2 - t.x1;
  const ymin = Math.min(scSu(i, t.x1), scSu(i, t.x2 - 1));
  const ymax = Math.max(scSu(i, t.x1), scSu(i, t.x2 - 1));
  const righe = Array.from({ length: ymax - ymin + 4 }, () => Array(w).fill("."));
  for (let xx = 0; xx < w; xx++) {
    const y = scSu(i, t.x1 + xx) - ymin;
    const p = (t.x1 + xx) % 6;
    righe[y][xx] = "a";
    righe[y + 3][xx] = "b";
    righe[y + 1][xx] = p < 2 || p === 5 ? "b" : ".";
    righe[y + 2][xx] = p >= 2 && p <= 4 ? "b" : ".";
  }
  return { righe: righe.map((r) => r.join("")), y: ymin };
}

/** Il campo: il cielo del tramonto, il sole basso a strisce, le stelle. */
function scFondo(c, g, x0, y0) {
  const cielo = c.createLinearGradient(0, y0, 0, y0 + SC_H);
  cielo.addColorStop(0, "#0b0714");
  cielo.addColorStop(0.6, "#1a0b1a");
  cielo.addColorStop(1, "#4a1a0a");
  c.fillStyle = cielo;
  c.fillRect(x0, y0, SC_W, SC_H);
  g.stelle.forEach((s) => {
    const v = Math.sin(g.t / 700 + s.f);
    c.fillStyle = `rgba(255, 236, 214, ${v > 0.5 ? 0.5 : 0.18})`;
    c.fillRect(x0 + s.x, y0 + s.y, 1, 1);
  });
  // il sole che tramonta dietro le travi, a strisce
  c.fillStyle = "rgba(255, 106, 0, 0.16)";
  for (let r = 0; r < 44; r += 2) {
    if (r % 8 === 6) continue;
    const w = Math.round(2 * Math.sqrt(44 * 44 - (44 - r) * (44 - r)));
    c.fillRect(x0 + SC_W / 2 - Math.round(w / 2), y0 + SC_H - 44 + r, w, 2);
  }
  c.fillStyle = "rgba(255, 106, 0, 0.35)";
  c.fillRect(x0, y0, SC_W, 1);
  c.fillRect(x0, y0, 1, SC_H);
  c.fillRect(x0 + SC_W - 1, y0, 1, SC_H);
}

/** Una scala (rotta: solo i due mozziconi). */
function scDisegnaScala(c, x0, y0, s) {
  const basso = scSu(s.da, s.x);
  const alto = scSu(s.da + 1, s.x) + 4; // parte sotto la trave di sopra
  const pezzi = s.rotta ? [[alto, alto + 5], [basso - 5, basso]] : [[alto, basso]];
  c.fillStyle = "#8fe3ff";
  pezzi.forEach(([a, b]) => {
    c.fillRect(x0 + s.x - 4, y0 + a, 1, b - a);
    c.fillRect(x0 + s.x + 3, y0 + a, 1, b - a);
    for (let y = b - 3; y > a; y -= 4) c.fillRect(x0 + s.x - 3, y0 + y, 6, 1);
  });
}

/** Lo scimmione nel campo (posa 0 a pugni giù, 1 a braccia su). */
function scDisegnaScimmia(c, x, y, posa, colori = SC_SCIMMIA_COLORI, chiave = "") {
  scSprite(c, `scimmia${posa}${chiave}`, SC_SCIMMIA[posa], colori, x, y);
}

/** Il dino piccolo nel campo, coi piedi a (x, y). */
function scDisegnaDino(c, g, x0, y0) {
  const d = g.d;
  let righe;
  let chiave;
  if (d.scala) {
    const p = Math.floor(d.passo / 160) % 2;
    righe = SC_DINO_SCALA[p];
    chiave = `dinoscala${p}`;
  } else {
    const p = d.aria ? 2 : Math.floor(d.passo / 110) % 2;
    righe = d.verso < 0 ? scGiraCache(p) : SC_DINO_PASSI[p];
    chiave = `dino${p}${d.verso < 0 ? "s" : "d"}`;
  }
  scSprite(c, chiave, righe, SC_DINO_COLORI, x0 + d.x - 6, y0 + d.y - 12);
}
const SC_DINO_PASSI_SX = SC_DINO_PASSI.map(scGira);
const scGiraCache = (p) => SC_DINO_PASSI_SX[p];

function scDisegna(c, g, x0, y0, opz = {}) {
  scFondo(c, g, x0, y0);
  // le due scale lunghe a sinistra della ragazza (da lì è salito lo scimmione)
  c.fillStyle = "rgba(143, 227, 255, 0.55)";
  [64, 78].forEach((x) => {
    c.fillRect(x0 + x - 4, y0 + 4, 1, scSu(5, x) - 4);
    c.fillRect(x0 + x + 3, y0 + 4, 1, scSu(5, x) - 4);
    for (let y = scSu(5, x) - 3; y > 4; y -= 4) c.fillRect(x0 + x - 3, y0 + y, 6, 1);
  });
  SC_SCALE.forEach((s) => scDisegnaScala(c, x0, y0, s));
  SC_TRAVI.forEach((t, i) => {
    const tr = scTrave(i);
    scSprite(c, `trave${i}`, tr.righe, { a: "#ffb066", b: "#ff6a00" }, x0 + t.x1, y0 + tr.y);
  });
  // il bidone, con le fiamme (più alte appena inghiotte un barile)
  const by = scSu(0, SC_BIDONE_X + 6) - 14;
  scSprite(c, "bidone", SC_BIDONE, SC_BIDONE_COLORI, x0 + SC_BIDONE_X, y0 + by);
  if (g.acceso) {
    const vampa = g.fiamma && g.t - g.fiamma < 500 ? 6 : 0;
    for (let i = 0; i < 5; i++) {
      const h = 2 + ((Math.floor(g.t / 90) + i * 3) % 4) + vampa;
      c.fillStyle = i % 2 ? "#ffd23f" : "#ff6a00";
      c.fillRect(x0 + SC_BIDONE_X + 1 + i * 2, y0 + by - h, 2, h);
    }
  }
  // la pila di barili in piedi accanto allo scimmione
  const py = scSu(5, 12);
  [[8, 0], [8, 8], [14, 0], [14, 8]].forEach(([x, y], i) => scSprite(c, "dritto", SC_BARILE_DRITTO, SC_BARILE_COLORI, x0 + x + (i > 1 ? 0 : 0), y0 + py - 8 - y));
  // lo scimmione: barile sopra la testa quando lancia, ogni tanto si batte il petto
  if (!opz.senzaScimmia) {
    const sy = scSu(5, SC_SCIMMIA_X + 12) - 22;
    const petto = g.petto && g.t >= g.petto && Math.floor((g.t - g.petto) / 150) % 2;
    const prende = g.lancio && g.t - g.lancio < 200;
    const posa = (g.lancio && !prende) || petto || (g.esito === "perso" && g.fine) ? 1 : 0;
    scDisegnaScimmia(c, x0 + SC_SCIMMIA_X, y0 + sy, posa);
    if (g.lancio) {
      // il barile dalla pila alle mani, poi sopra la testa
      const q = Math.min(1, (g.t - g.lancio) / 220);
      const blu = scBlu(g.lanci);
      scSprite(c, `barile0${blu ? "b" : ""}`, SC_BARILE[0], blu ? SC_BARILE_BLU : SC_BARILE_COLORI, x0 + 10 + (SC_SCIMMIA_X - 2) * q, y0 + sy + 8 - 15 * q);
    }
  }
  // la ragazza in cima che chiama aiuto
  const rx = 104;
  scSprite(c, `ragazza${Math.floor(g.t / 400) % 2}`, SC_RAGAZZA[Math.floor(g.t / 400) % 2], SC_RAGAZZA_COLORI, x0 + rx, y0 + SC_TRAVI[SC_META].y1 - 13);
  if (!g.fine && Math.floor(g.t / 700) % 2) dinoScrittaDa(c, "Aiuto!", x0 + rx - 26, y0 + 4, "#ff5fd2", DINO_FONT_PICCOLO, 1);
  if (g.esito === "vinto") scSprite(c, "cuore", SC_CUORE, { "#": "#ff3b5c" }, x0 + rx + 12, y0 + 1);
  // i barili
  // i martelli sospesi, da prendere saltando
  g.martelli.forEach((m) => {
    if (!m.preso) scSprite(c, "martello", SC_MARTELLO_SU_RIGHE, SC_MARTELLO_COLORI, x0 + m.x - 3, y0 + scSu(m.piano, m.x) - SC_MARTELLO_SU - 9);
  });
  if (!opz.gag) {
    g.barili.forEach((b) => {
      const posa = b.stato === "scende" || b.stato === "giu" ? 0 : Math.floor(b.giro / 3) % 4;
      scSprite(c, `barile${posa}${b.blu ? "b" : ""}`, SC_BARILE[posa], b.blu ? SC_BARILE_BLU : SC_BARILE_COLORI, x0 + b.x - 4, y0 + b.y - 8);
    });
    g.fiamme.forEach((f) => {
      let fx = f.x;
      let fy = f.y;
      const q = (g.t - f.nasce) / 400;
      if (q < 1) {
        // salta fuori dal bidone ad arco
        fx = SC_BIDONE_X + 6 + (f.x - SC_BIDONE_X - 6) * q;
        fy = f.y - 16 * Math.sin(Math.PI * q) - (1 - q) * 12;
      }
      const p = Math.floor(g.t / 120) % 2;
      scSprite(c, `fiamma${p}`, SC_FIAMMELLA[p], SC_FIAMMELLA_COLORI, x0 + fx - 4, y0 + fy - 8);
    });
  }
  // le schegge di quello che il martello ha spaccato
  if (!opz.gag) g.scoppi.forEach((o) => {
    const q = (g.t - o.t) / 320;
    const r = 2 + q * 8;
    c.fillStyle = q < 0.5 ? "#ffffff" : "#ffd23f";
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * 6.283;
      c.fillRect(Math.round(x0 + o.x + Math.cos(a) * r), Math.round(y0 + o.y + Math.sin(a) * r), 2, 2);
    }
  });
  // il dino (lampeggia appena preso)
  if (!opz.senzaDino && (g.vite > 0 || opz.gag) && !(g.invulnerabile > 0 && !opz.gag && Math.floor(g.t / 90) % 2)) {
    scDisegnaDino(c, g, x0, y0);
    // il martello in mano: alzato e steso davanti, a tempo; lampeggia alla fine
    if (g.martello && !opz.gag) {
      const d = g.d;
      const fine = g.martello < 2000 && Math.floor(g.t / 100) % 2;
      const col = fine ? SC_MARTELLO_FINE : SC_MARTELLO_COLORI;
      if (scMartelloSu(g)) scSprite(c, `martsu${fine ? "f" : ""}`, SC_MARTELLO_SU_RIGHE, col, x0 + d.x - 3 + d.verso * 2, y0 + d.y - 20);
      else scSprite(c, `martgiu${d.verso < 0 ? "s" : "d"}${fine ? "f" : ""}`, d.verso < 0 ? SC_MARTELLO_GIU_SX : SC_MARTELLO_GIU, col, x0 + d.x + (d.verso < 0 ? -11 : 2), y0 + d.y - 9);
    }
  }
  g.scritte.forEach((s) => dinoScritta(c, s.testo, x0 + s.x, y0 + s.y - Math.round((g.t - s.t) / 60), "#ffd23f", DINO_FONT_PICCOLO));
  // in alto a destra: i punti, le vite, il tempo
  dinoScrittaDa(c, String(g.punti).padStart(4, "0"), x0 + 166, y0 + 3, "#ff9a3c", DINO_FONT_PICCOLO);
  for (let i = 0; i < g.vite; i++) scSprite(c, "vita", SC_DINO_PASSI[0].slice(0, 4), SC_DINO_COLORI, x0 + SC_W - 16 - i * 10, y0 + 4);
  const resta = Math.max(0, 1 - g.t / BOSS_TEMPO);
  for (let i = 0; i < 8; i++) {
    c.fillStyle = "rgba(255, 255, 255, 0.14)";
    c.fillRect(x0 + 168 + i * 4, y0 + 16, 3, 3);
    if (resta * 8 > i) {
      c.fillStyle = resta < 0.25 && Math.floor(g.t / 140) % 2 ? "#ffffff" : "#7dff4a";
      c.fillRect(x0 + 168 + i * 4, y0 + 16, 3, 3);
    }
  }
}

// —— l'incontro dello scimmione: entra a passi pesanti e si batte il
// petto; il dino resta di sasso, occhioni e bocca aperta, stordito ——
const SC_SCALA_STRADA = 2; // lo scimmione sulla strada a celle da 2
function scIncontroPasso(b) {
  if (b.fase !== "incontro") return;
  if (b.t >= 150 && !b.petto1) {
    b.petto1 = true;
    dinoSuono("sc_petto");
  }
  if (b.t >= 1150 && !b.petto2) {
    b.petto2 = true;
    dinoSuono("sc_petto");
  }
}
function scStrada(c, b, terra, W) {
  const s = SC_SCALA_STRADA;
  const larga = 24 * s;
  const alto = 22 * s;
  const x = dinoBossPosto(b, W, larga);
  const fermo = dinoMotoRidotto();
  const dy = !fermo && b.fase === "arrivo" && Math.floor(b.t / 150) % 2 ? -DINO_CELLA : 0;
  const su = !fermo && b.fase !== "arrivo" && Math.floor(b.t / 220) % 2 === 1;
  c.fillStyle = "rgba(0, 0, 0, 0.35)";
  c.fillRect(x + 4, terra - 1, larga - 8, 2);
  c.imageSmoothingEnabled = false;
  c.drawImage(dinoTela(`sc|scimmia${su ? 1 : 0}`, SC_SCIMMIA[su ? 1 : 0], SC_SCIMMIA_COLORI), x, terra - alto + dy, larga, alto);
  // battendosi il petto: le onde d'urto
  if (su) {
    const k = (b.t % 440) / 440;
    c.fillStyle = `rgba(255, 138, 42, ${(0.6 * (1 - k)).toFixed(2)})`;
    const r = Math.round(14 + 22 * k);
    const cx = x + larga / 2;
    const cy = terra - 26;
    c.fillRect(cx - r, cy - 2, 2, 4);
    c.fillRect(cx + r - 2, cy - 2, 2, 4);
    c.fillRect(cx - r - 4, cy - 8, 2, 2);
    c.fillRect(cx + r + 2, cy - 8, 2, 2);
  }
}
function scSopra(c, b, W) {
  dinoBossSpavento(c, b);
  // il fumetto del ruggito sopra lo scimmione, che trema
  const tr = b.fase === "incontro" ? b.t : BOSS_INCONTRO + b.t;
  if (tr > 250 && tr < 1300) {
    const bx = dinoBossPosto(b, W, 24 * SC_SCALA_STRADA) - 14;
    const by = dinoTerra() - 22 * SC_SCALA_STRADA - 26;
    const trema = !dinoMotoRidotto() && Math.floor(tr / 80) % 2 ? DINO_CELLA : 0;
    c.fillStyle = "#141414";
    c.fillRect(bx - 2, by - 2, 48, 20);
    c.fillStyle = "#f4f4f5";
    c.fillRect(bx, by, 44, 16);
    c.fillRect(bx + 30, by + 16, 4, 2); // la punta verso la bocca
    c.fillRect(bx + 32, by + 18, 2, 2);
    dinoScritta(c, "Grr!", bx + 22 + trema / 2, by + 3, "#ff3b3b", DINO_FONT_PICCOLO);
  }
  // stordito: tre stelline che girano sopra la testa
  const t = b.fase === "incontro" ? b.t : BOSS_INCONTRO + b.t;
  if (t < 500) return;
  const cx = dinoX() + 14;
  const cy = Math.round(dinoTerra() - dino.y - DINO_H) - 6;
  const fermo = dinoMotoRidotto();
  for (let i = 0; i < 3; i++) {
    const a = (fermo ? 0 : t / 260) + (i * 6.283) / 3;
    const x = Math.round(cx + Math.cos(a) * 14);
    const y = Math.round(cy + Math.sin(a) * 4);
    c.fillStyle = "#ffd23f";
    c.fillRect(x - 1, y, 3, 1);
    c.fillRect(x, y - 1, 1, 3);
  }
}

// —— le gag dell'esito (k da 0 a 1 in BOSS_ESITO) ——
function scEsito(c, g, x0, y0, k, esito) {
  const vinto = esito === "vinto";
  const perso = esito === "perso";
  scDisegna(c, g, x0, y0, { gag: true, senzaScimmia: true, senzaDino: perso && k > 0.42 });
  const sy0 = scSu(5, SC_SCIMMIA_X + 12) - 22;
  if (vinto) {
    // arriva Godzilla dal basso a destra e col soffio arrostisce lo scimmione,
    // che vola giù dalle travi
    const aperta = k > 0.32 && k < 0.7;
    const righe = dinoGodzillaRighe(0, aperta);
    const gw = GODZILLA_W;
    const gh = GODZILLA_H;
    const gx = x0 + SC_W - gw - 10;
    const gy = y0 + SC_H - gh + Math.round(gh * Math.max(0, 1 - k / 0.25));
    const arrosto = k > 0.55;
    let sx = x0 + SC_SCIMMIA_X;
    let sy = y0 + sy0;
    if (k > 0.7) {
      const q = (k - 0.7) / 0.3;
      sx += q * 30;
      sy += -12 * q + 190 * q * q;
    }
    c.save();
    c.translate(Math.round(sx + 12), Math.round(sy + 11));
    if (k > 0.7) c.rotate((k - 0.7) * 14);
    c.drawImage(dinoTela(`sc|scimmia${arrosto ? 1 : 0}${arrosto ? "a" : ""}`, SC_SCIMMIA[arrosto ? 1 : 0], arrosto ? SC_SCIMMIA_ARROSTO : SC_SCIMMIA_COLORI), -12, -11, 24, 22);
    c.restore();
    if (arrosto && k < 0.9) {
      // il fumo dell'arrosto
      for (let i = 0; i < 4; i++) {
        const q = ((k - 0.55) * 4 + i * 0.25) % 1;
        c.fillStyle = `rgba(200, 200, 210, ${(0.5 * (1 - q)).toFixed(2)})`;
        c.fillRect(Math.round(sx + 6 + i * 4), Math.round(sy - 4 - q * 16), 3, 3);
      }
    }
    c.save();
    c.translate(gx + gw, gy);
    c.scale(-1, 1);
    c.drawImage(dinoTela(`godz|0|${aperta}|`, righe, GODZILLA_COLORI), 0, 0, gw, gh);
    c.restore();
    if (aperta) {
      // il soffio atomico dalla bocca allo scimmione
      const bx = gx + gw - GODZILLA_BOCCA[0];
      const by = gy + GODZILLA_BOCCA[1];
      const tx = x0 + SC_SCIMMIA_X + 12;
      const ty = y0 + sy0 + 10;
      c.save();
      c.globalCompositeOperation = "lighter";
      for (let l = 0; l <= 1; l += 0.02) {
        const px = Math.round(bx + (tx - bx) * l);
        const py = Math.round(by + (ty - by) * l);
        c.fillStyle = "rgba(80, 200, 255, 0.35)";
        c.fillRect(px - 3, py - 3, 6, 6);
        c.fillStyle = "rgba(240, 253, 255, 0.8)";
        c.fillRect(px - 1, py - 1, 2, 2);
      }
      c.restore();
    }
    if (k > 0.72) dinoScritta(c, "Arrosto!", x0 + SC_W / 2 - 20, y0 + 60, "#7dff4a");
  } else if (perso) {
    // lo scimmione salta giù accanto al dino e gli tira un calcio che lo
    // manda lontanissimo: una stellina in alto a destra
    const d = g.d;
    const q = Math.min(1, k / 0.3);
    const ax = SC_SCIMMIA_X + (d.x - 30 - SC_SCIMMIA_X) * q;
    const ay = sy0 + (d.y - 22 - sy0) * q - Math.sin(Math.PI * q) * 30;
    const posa = k > 0.3 && k < 0.42 ? 1 : k >= 0.42 ? 0 : 1;
    scDisegnaScimmia(c, x0 + Math.max(0, ax), y0 + ay, posa);
    if (k >= 0.42 && k < 0.5) {
      // il colpo: una stella gialla
      c.fillStyle = "#ffd23f";
      c.fillRect(x0 + d.x - 8, y0 + d.y - 7, 9, 2);
      c.fillRect(x0 + d.x - 4, y0 + d.y - 11, 2, 9);
    }
    if (k >= 0.42 && k < 0.85) {
      const r = (k - 0.42) / 0.43;
      const nx = d.x + (SC_W - 10 - d.x) * r;
      const ny = d.y - 6 - (d.y - 8) * r - Math.sin(Math.PI * r) * 30;
      const sc = Math.max(0.2, 1 - r * 0.8);
      c.save();
      c.translate(Math.round(x0 + nx), Math.round(y0 + ny));
      c.rotate(r * 12);
      c.drawImage(dinoTela("sc|dino2d", SC_DINO_PASSI[2], SC_DINO_COLORI), -6 * sc, -6 * sc, 12 * sc, 12 * sc);
      c.restore();
    } else if (k >= 0.85) {
      const q2 = (k - 0.85) / 0.15;
      const r = q2 < 0.5 ? 1 + q2 * 6 : 4 - (q2 - 0.5) * 6;
      c.fillStyle = "#ffffff";
      c.fillRect(x0 + SC_W - 10 - r, y0 + 8, r * 2 + 1, 1);
      c.fillRect(x0 + SC_W - 10, y0 + 8 - r, 1, r * 2 + 1);
    }
    if (k > 0.45) dinoScritta(c, "Che calcio!", x0 + SC_W / 2, y0 + 62, "#ff5fd2");
  } else {
    // tempo scaduto: lo scimmione se la ride
    scDisegnaScimmia(c, x0 + SC_SCIMMIA_X, y0 + sy0, Math.floor(k * 10) % 2);
    dinoScritta(c, "Tempo!", x0 + SC_W / 2, y0 + 60, "#ffd23f");
  }
}

function scDito(g, ev) {
  const x = Math.max(0, Math.min(SC_W, ev.x));
  const y = ev.y;
  if (ev.tipo === "giu") {
    if (g.dito && g.dito.id !== ev.id) {
      // un secondo dito: salto nel verso in cui sta camminando
      g.salta = true;
      g.saltoVerso = null;
      return;
    }
    g.dito = { id: ev.id, x, y, x0: x, y0: y, t0: g.t, mosso: 0, attivo: false };
    return;
  }
  const f = g.dito;
  if (!f || f.id !== ev.id) return;
  if (ev.tipo === "muovi") {
    f.mosso = Math.max(f.mosso, Math.abs(x - f.x0), Math.abs(y - f.y0));
    if (f.mosso > 6) f.attivo = true;
    f.x = x;
    f.y = y;
    return;
  }
  // il dito si alza: un tocco breve e fermo (mai un trascinamento) è un
  // salto, verso il punto toccato se è lontano dal dino, sul posto se vicino
  if (!f.attivo && f.mosso <= 6) {
    g.salta = true;
    g.saltoVerso = Math.abs(f.x0 - g.d.x) > 10 ? Math.sign(f.x0 - g.d.x) : 0;
  }
  g.dito = null;
}

const BOSS_SCIMMIONE = {
  titolo: "Scimmione!",
  sotto: "Sali fino in cima",
  colore: "#ff8a2a",
  aiuto: "Trascina e tocca",
  nuovo: scNuovo,
  misura: () => ({ w: SC_W, h: SC_H }),
  passo: scPasso,
  disegna: (c, g, x0, y0) => scDisegna(c, g, x0, y0),
  dito: scDito,
  tasto: (g, ev) => {
    if (ev.tasto === "azione") {
      if (ev.giu) {
        g.salta = true;
        g.saltoVerso = null;
      }
    } else g.tasti[ev.tasto] = ev.giu;
  },
  esito: scEsito,
  strada: scStrada,
  sopra: scSopra,
  incontroPasso: scIncontroPasso,
};

BOSS_GIOCHI.scimmione = BOSS_SCIMMIONE;
// i suoni nuovi dello scimmione (stessa ricetta di BOSS_SUONI, da portare
// anche nel nativo: NativeAudioPlugin.swift, SuoniGioco)
Object.assign(BOSS_SUONI, {
  sc_passo: (tono) => tono(260, 200, 0, 0.03, 0.3),
  sc_salto: (tono) => tono(300, 900, 0, 0.12, 0.5),
  sc_lancio: (tono, campana, rumore) => {
    rumore(0.06, 250, 0, 0.7);
    tono(110, 70, 0, 0.1, 0.8);
  },
  sc_colpito: (tono, campana, rumore) => {
    rumore(0.2, 700, 0, 0.8);
    tono(400, 80, 0, 0.35, 0.7);
  },
  sc_fuoco: (tono, campana, rumore) => {
    rumore(0.3, 900, 0, 0.6);
    tono(150, 300, 0, 0.2, 0.4);
  },
  sc_spacca: (tono, campana, rumore) => {
    rumore(0.12, 1800, 0, 0.7);
    tono(300, 100, 0, 0.12, 0.6);
  },
  // la musichetta del martello: quattro note, a giro (SC_MELODIA)
  sc_martello1: (tono) => tono(523, 523, 0, 0.09, 0.35),
  sc_martello2: (tono) => tono(659, 659, 0, 0.09, 0.35),
  sc_martello3: (tono) => tono(784, 784, 0, 0.09, 0.35),
  sc_martello4: (tono) => tono(1047, 1047, 0, 0.09, 0.35),
});
