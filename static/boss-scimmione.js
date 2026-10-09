// —— SCIMMIONE (fase 4). Tributo fedele al primo livello del cabinato dello
// scimmione coi barili (quello delle travi inclinate): sei travi a zig zag,
// le scale intere e quelle rotte, lo scimmione in cima che lancia barili
// che rotolano lungo le travi, cadono dai bordi e a volte scendono dalle
// scale, il bidone in fondo a sinistra che li inghiotte con la fiammata.
// Il dino al posto dell'idraulico sale fino alla ragazza sulla trave più
// alta. Decisioni (09/10): 2 vite come gli invasori, si vince arrivando in
// cima, si perde al secondo barile addosso; salto sopra i barili (+100).
// Comandi fissi a schermo come sul pannello del cabinato (Vitto 09/10: «lo
// scimmione si fa fatica un attimo a muoversi, magari gli diamo dei comandi
// levette arcade fisse a schermo»; prima erano gesti: tieni premuto,
// trascina, tocca): la levetta in basso a sinistra (destra e sinistra
// camminano, su e giù prendono la scala lì vicino) e il pulsante rosso del
// salto in basso a destra. Ogni dito si lega al comando della metà del
// banner dove è andato giù, quindi due dita insieme: corsa e salto. Con un
// dito solo il pulsante si ricorda la levetta appena lasciata
// (SC_SALTO_MEMORIA): lascia, tocca, e il salto è in corsa.
// Frecce, spazio e invio sul desktop, come prima.
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
// camminata del dino, unità per tick. Era 0,7 (il campo da una parte
// all'altra in 6 s): 0,8 il 09/10 («si fa fatica a muoversi»), resta sotto
// i barili (0,85 al primo giro) che ti raggiungono da dietro come
// nell'originale; il salto in corsa passa da 21 a 24 unità
const SC_PASSO = 0.8;
const SC_SALTO_V = 1.8; // il salto: alto 13 unità, mezzo secondo in aria (un barile da fermo si scavalca con ~0,2 s di margine)
const SC_GRAVITA = 0.12;
const SC_SCALA_V = 0.55;
// la levetta: parte da dove appoggi il pollice (se cade sulla levetta,
// entro SC_LEV_AGGANCIO dal centro; più lontano conta il centro), con una
// zona morta (il pollice appoggiato non muove niente); su e giù solo da
// SC_LEV_VERT in là. Quanto lontano prende una scala tirandola su o giù
// (coi tasti 6: col pollice si mira peggio, il dino ci va da solo)
const SC_LEV_MORTA = 7;
const SC_LEV_VERT = 8;
const SC_LEV_AGGANCIO = 16;
const SC_LEV_PRESA = 10;
// con un dito solo: il pulsante toccato entro tanti ms dall'ultimo passo
// salta nel verso in cui camminava (il pollice va dalla levetta al
// pulsante; le fiammelle si scavalcano solo in corsa)
const SC_SALTO_MEMORIA = 350;
const SC_COM_META = 14; // mezzo comando (12 unità) più 2 di aria dal bordo
const SC_COM_LONTANO = 24; // con tanto posto ai lati, al massimo così lontani dal campo
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

// —— i comandi a schermo, visti un po' dall'alto come sul pannello di un
// cabinato: la levetta (base tonda con l'anello arancio, asta, pallina
// rossa) e il pulsante rosso nella sua ghiera. Ovali fatti a celle una
// volta sola al caricamento (scDisco), poi tele fisse di dinoTela ——
/** Un disco a celle visto un po' dall'alto: la faccia w x h (la cella la
 * sceglie faccia(nx, ny), da -1 a 1 dal centro), sotto il fianco alto «alto»
 * celle (lato), tutto intorno il bordo «o». */
function scDisco(w, h, alto, faccia, lato = "s") {
  const su = (x, y) => x >= 0 && x < w && y >= 0 && y < h && ((2 * x + 1 - w) / w) ** 2 + ((2 * y + 1 - h) / h) ** 2 <= 1;
  const pieno = (x, y) => {
    for (let k = 0; k <= alto; k++) if (su(x, y - k)) return true;
    return false;
  };
  return Array.from({ length: h + alto }, (_, y) =>
    Array.from({ length: w }, (_, x) => {
      if (!pieno(x, y)) return ".";
      if (!pieno(x - 1, y) || !pieno(x + 1, y) || !pieno(x, y - 1) || !pieno(x, y + 1)) return "o";
      return su(x, y) && su(x, y + 1) ? faccia((2 * x + 1 - w) / w, (2 * y + 1 - h) / h) : lato;
    }).join(""),
  );
}
/** Le righe «sopra» incollate su quelle «sotto» a (x, y); «.» è trasparente. */
const scIncolla = (sotto, sopra, x, y) =>
  sotto.map((r, j) => [...r].map((ch, i) => (sopra[j - y] && sopra[j - y][i - x] && sopra[j - y][i - x] !== "." ? sopra[j - y][i - x] : ch)).join(""));
/** La faccia di una base: l'anello arancio (luce in alto a sinistra) attorno
 * al fondo scuro, col foro dell'asta al centro. */
const scAnello = (fondo, foro) => (nx, ny) => {
  const r = Math.hypot(nx, ny);
  if (r < fondo) return r < foro ? "n" : "k";
  return ny < -0.4 && nx < 0.25 ? "l" : "a";
};
const SC_LEVETTA = scDisco(24, 18, 2, scAnello(0.58, 0.2)); // la base: 24 x 20, la faccia centrata sulla riga 9
const SC_PALLINA = scDisco(10, 10, 0, (nx, ny) => (Math.hypot(nx + 0.38, ny + 0.38) < 0.32 ? "w" : nx + ny > 0.55 ? "d" : "r"));
// il pulsante su (tappo alto 3) e premuto (alto 1: scende di 2), 24 x 21,
// la ghiera centrata sulla riga 10; dove i due bordi si incrociano un pixel
// d'anello rimasto solo fra due bordi diventa bordo (sembrava polvere)
const SC_PULSANTE = [3, 1].map((alto) =>
  scIncolla(
    ["", ""].map(() => ".".repeat(24)).concat(scDisco(24, 16, 3, scAnello(0.68, 0))),
    scDisco(16, 10, alto, (nx, ny) => (Math.hypot(nx + 0.4, ny + 0.4) < 0.28 ? "w" : "r"), "d"),
    4,
    4 - alto,
  ).map((r) => r.replace(/o[^o.]o/g, "ooo")),
);
const SC_COMANDI_COLORI = { o: "#141414", a: "#ff6a00", l: "#ffb066", s: "#8f3200", k: "#2a1a12", n: "#0a0604", r: "#ff3b3b", d: "#a8201a", w: "#ffd9d0" };
// tenuto giù: l'anello si accende (e il tappo premuto pure), a vista che il dito c'è
const SC_COMANDI_ACCESI = { ...SC_COMANDI_COLORI, a: "#ff9a3c", l: "#ffd23f", r: "#ff5a4a" };

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
    vite: 2,
    invulnerabile: 0,
    punti: 0,
    scritte: [],
    levetta: null, // il dito sulla levetta: { id, ox, oy (da dove parte), oriz, vert } (-1, 0, 1)
    pulsante: null, // il dito sul pulsante: { id }
    tasti: {},
    salta: false,
    prossimoPasso: 0,
    camminava: -1e9, // g.t dell'ultimo passo sulla trave (SC_SALTO_MEMORIA)
    fine: 0,
    esito: null,
    stelle,
  };
}

/** La scala buona per salire (-1) o scendere (+1) più vicina al dino,
 * entro «entro» unità. */
function scScalaPer(g, verso, entro) {
  const da = verso < 0 ? g.d.piano : g.d.piano - 1;
  let meglio = null;
  SC_SCALE.forEach((s) => {
    if (s.rotta || s.da !== da || Math.abs(s.x - g.d.x) > entro) return;
    if (!meglio || Math.abs(s.x - g.d.x) < Math.abs(meglio.x - g.d.x)) meglio = s;
  });
  return meglio;
}

/** Cosa chiede il giocatore adesso: le frecce, o la levetta dove le frecce
 * tacciono. Su o giù chiedono la scala lì vicino, e il dino ci va da solo e
 * sale (o scende); con la levetta la si prende un po' più da lontano. */
function scComando(g) {
  let orizz = (g.tasti.destra ? 1 : 0) - (g.tasti.sinistra ? 1 : 0);
  let vert = (g.tasti.giu ? 1 : 0) - (g.tasti.su ? 1 : 0);
  let entro = 6;
  const l = g.levetta;
  if (l && !orizz) orizz = l.oriz;
  if (l && !vert && l.vert) {
    vert = l.vert;
    entro = SC_LEV_PRESA;
  }
  return { orizz, vert, entro };
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
    // la scala chiesta (la più vicina): il dino ci va e ci sale
    const s = cmd.vert && !g.martello ? scScalaPer(g, cmd.vert, cmd.entro) : null;
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
        g.camminava = g.t;
      }
      d.y = scSu(d.piano, d.x);
      if (salta && !g.martello) {
        // nel verso in cui sta camminando, o camminava un attimo fa (un dito
        // solo: dalla levetta al pulsante); fermo da un po': sul posto
        const sv = verso || (g.t - g.camminava <= SC_SALTO_MEMORIA ? d.verso : 0);
        d.aria = true;
        d.vy = -SC_SALTO_V;
        d.vx = sv * SC_PASSO;
        dinoSuono("sc_salto");
      }
    }
  }
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

/** Dove stanno levetta e pulsante (i centri delle loro facce, in unità del
 * campo), dalle misure di adesso e mai salvati (rotazione, schermo intero,
 * Home): x0 è dove comincia il campo nel banner. Ai lati del campo se c'è
 * posto (a schermo intero ~29 unità per lato dentro l'isola, nel banner
 * verticale da 393 pt 28), al massimo SC_COM_LONTANO dal campo; se no
 * attaccati ai bordi, un po' sopra gli angoli bassi del campo (iPhone da
 * 375 pt in verticale: 20 unità per lato, ne sporgono 6 sulla trave di
 * sotto, lontano dal bidone e dalle scale). In basso, dove stanno i pollici. */
function scComandi(x0) {
  const sx = dino.margine - x0; // il bordo visibile a sinistra (dentro l'isola)
  const dx = dino.w - dino.margineDx - x0; // e a destra
  const lx = Math.max(sx + SC_COM_META, -Math.min(-sx / 2, SC_COM_LONTANO));
  const px = Math.min(dx - SC_COM_META, SC_W + Math.min((dx - SC_W) / 2, SC_COM_LONTANO));
  // il fondo dei comandi pari al fondo del campo, non del banner: nel
  // banner verticale gli angoli del cabinato sono tondi (16 pt) e li
  // taglierebbero
  const y = SC_H - 10;
  return { lev: { x: 2 * Math.round(lx / 2), y }, pul: { x: 2 * Math.round(px / 2), y } };
}

/** Il centro della levetta (fra la base e la pallina a riposo: lì cade il
 * pollice), in unità del campo. */
function scCentroLevetta() {
  const k = scComandi(dinoBossCampo(dino.boss).x);
  return { x: k.lev.x, y: k.lev.y - 3 };
}

/** Dove spinge la levetta il dito l, ora a (x, y): la posizione rispetto a
 * dove è partito (l.ox, l.oy), fuori dalla zona morta, in 8 direzioni
 * ridotte a orizzontale + verticale. Le diagonali sono un po' strette verso
 * l'orizzontale (su o giù solo oltre 30° invece di 22,5°, e da SC_LEV_VERT
 * in là): camminando, il pollice che sbanda non prende una scala per
 * sbaglio. */
function scLevettaVerso(l, x, y) {
  const dx = x - l.ox;
  const dy = y - l.oy;
  if (dx * dx + dy * dy < SC_LEV_MORTA * SC_LEV_MORTA) return { oriz: 0, vert: 0 };
  return {
    oriz: Math.abs(dx) > Math.abs(dy) * 0.414 ? Math.sign(dx) : 0,
    vert: Math.abs(dy) >= SC_LEV_VERT && Math.abs(dy) > Math.abs(dx) * 0.577 ? Math.sign(dy) : 0,
  };
}

/** I comandi a schermo, solo dallo stato (g.levetta, g.pulsante): la base
 * della levetta, l'asta dal foro alla pallina che si sposta a scatti verso
 * dove la tieni, il pulsante che si abbassa premuto; l'anello si accende
 * sotto il dito. Fuori dal campo pieni; se sporgono sul campo (iPhone da
 * 375 pt) tutto il comando un po' trasparente (travi, barili e dino si
 * vedono sotto). A partita decisa a riposo (non rispondono più). Niente che
 * si muova da solo: con «riduci movimento» è tutto uguale. */
function scDisegnaComandi(c, g, x0, y0) {
  const k = scComandi(x0);
  const l = g.fine ? null : g.levetta;
  const p = g.pulsante && !g.fine ? 1 : 0;
  const leva = () => {
    const lx = x0 + k.lev.x;
    const ly = y0 + k.lev.y;
    scSprite(c, `levetta${l ? 1 : 0}`, SC_LEVETTA, l ? SC_COMANDI_ACCESI : SC_COMANDI_COLORI, lx - 12, ly - 9);
    const bx = lx + (l ? l.oriz * 6 : 0);
    const by = ly - 6 + (l ? l.vert * 5 : 0);
    const n = Math.max(1, Math.abs(bx - lx), Math.abs(by - ly));
    for (let i = 0; i <= n; i++) {
      const ax = Math.round(lx + ((bx - lx) * i) / n);
      const ay = Math.round(ly + ((by - ly) * i) / n);
      c.fillStyle = "#e8e8ec";
      c.fillRect(ax - 1, ay - 1, 1, 2);
      c.fillStyle = "#8a8a90";
      c.fillRect(ax, ay - 1, 1, 2);
    }
    scSprite(c, "pallina", SC_PALLINA, SC_COMANDI_COLORI, bx - 5, by - 5);
  };
  const pulsante = () => scSprite(c, `pulsante${p}`, SC_PULSANTE[p], p ? SC_COMANDI_ACCESI : SC_COMANDI_COLORI, x0 + k.pul.x - 12, y0 + k.pul.y - 10);
  const conAlfa = (sporge, disegna) => {
    if (!sporge) return disegna();
    c.save();
    c.globalAlpha = 0.7;
    disegna();
    c.restore();
  };
  conAlfa(k.lev.x + 12 > 0, leva);
  conAlfa(k.pul.x - 12 < SC_W, pulsante);
}

function scDisegna(c, g, x0, y0) {
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
  // le schegge di quello che il martello ha spaccato
  g.scoppi.forEach((o) => {
    const q = (g.t - o.t) / 320;
    const r = 2 + q * 8;
    c.fillStyle = q < 0.5 ? "#ffffff" : "#ffd23f";
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * 6.283;
      c.fillRect(Math.round(x0 + o.x + Math.cos(a) * r), Math.round(y0 + o.y + Math.sin(a) * r), 2, 2);
    }
  });
  // il dino (lampeggia appena preso)
  if (g.vite > 0 && !(g.invulnerabile > 0 && Math.floor(g.t / 90) % 2)) {
    scDisegnaDino(c, g, x0, y0);
    // il martello in mano: alzato e steso davanti, a tempo; lampeggia alla fine
    if (g.martello) {
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
  // in basso ai lati la levetta e il pulsante
  scDisegnaComandi(c, g, x0, y0);
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

// —— la gag sulla strada (Vitto 09/10: «le scene di vittoria o sconfitta le
// volevo fuori dal minigame, come l'incontro»): quella di serie di boss.js
// (Godzilla col soffio; il dino scagliato via) con lo scimmione vero, che a
// vincere si batte il petto e sotto il soffio resta arrosto ——
function scRitratto(c, b, x, terra, stato) {
  const s = SC_SCALA_STRADA;
  const larga = 24 * s;
  const alto = 22 * s;
  const posa = stato.esulta && !dinoMotoRidotto() ? Math.floor(b.t / 220) % 2 : 0;
  c.fillStyle = "rgba(0, 0, 0, 0.35)";
  c.fillRect(x + 4, terra - 1, larga - 8, 2);
  c.imageSmoothingEnabled = false;
  c.drawImage(dinoTela(`sc|scimmia${posa}${stato.arrosto ? "a" : ""}`, SC_SCIMMIA[posa], stato.arrosto ? SC_SCIMMIA_ARROSTO : SC_SCIMMIA_COLORI), x, terra - alto, larga, alto);
}
function scGagPasso(b, k, una) {
  dinoBossGagPassoDiSerie(b, k, una);
  if (b.esito === "perso") una("petto", GAG_CARICA + 0.05, () => dinoSuono("sc_petto"));
}

function scDito(g, ev) {
  if (ev.tipo === "su") {
    if (g.levetta && g.levetta.id === ev.id) g.levetta = null;
    if (g.pulsante && g.pulsante.id === ev.id) g.pulsante = null;
    return;
  }
  if (ev.tipo === "giu") {
    if (ev.x >= SC_W / 2) {
      g.pulsante = { id: ev.id };
      g.salta = true; // nel verso in cui sta camminando, come lo spazio
    } else if (!g.levetta) {
      // un altro dito (il palmo) sulla levetta già tenuta non la ruba
      const o = scCentroLevetta();
      const vicino = (ev.x - o.x) ** 2 + (ev.y - o.y) ** 2 <= SC_LEV_AGGANCIO ** 2;
      g.levetta = { id: ev.id, ox: vicino ? ev.x : o.x, oy: vicino ? ev.y : o.y, oriz: 0, vert: 0 };
    }
  }
  const l = g.levetta;
  if (l && l.id === ev.id) Object.assign(l, scLevettaVerso(l, ev.x, ev.y));
}

const BOSS_SCIMMIONE = {
  titolo: "Scimmione!",
  sotto: "Sali fino in cima",
  colore: "#ff8a2a",
  aiuto: "Levetta e pulsante",
  nuovo: scNuovo,
  misura: () => ({ w: SC_W, h: SC_H }),
  passo: scPasso,
  disegna: (c, g, x0, y0) => scDisegna(c, g, x0, y0),
  dito: scDito,
  tasto: (g, ev) => {
    if (ev.tasto === "azione") {
      if (ev.giu) g.salta = true;
    } else g.tasti[ev.tasto] = ev.giu;
  },
  larga: 24 * SC_SCALA_STRADA,
  ritratto: scRitratto,
  gagPasso: scGagPasso,
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
