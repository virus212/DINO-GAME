// —— BOSS BATTLE del gioco del dino (Crackify, modalità offline). File a parte
// (deciso il 08/10 con la sessione locale: niente conflitti con app.js),
// caricato PRIMA di app.js nello stesso scope globale: qui al caricamento
// solo letterali e funzioni (dino, DINO_CELLA, dinoScritta... di app.js si
// leggono solo quando le funzioni girano). Gli agganci in app.js cercano
// «dinoBoss» e «dino.boss». ——

// —— BOSS (Vitto, idea del boss battle: «tributo arcade offline»). Ogni tanto
// (DINO_MODI[modo].boss: la prima soglia e poi ogni quanti punti; mai in
// Default dino) il dinosauro incontra un boss e per 30-60 s il banner diventa
// un minigioco fedele a un cabinato classico: lo scimmione coi barili, il
// labirinto coi fantasmi, gli invasori. Il protagonista è sempre il dino,
// l'ambiente è il nostro (arancio, tramonto, cabinato), nessun nome
// originale a schermo. ARCHITETTURA (fase 1):
//
// · Stato. dino.stato resta "corsa" per tutto il boss: il ciclo va a rAF
//   pieno, la pausa (tocco, menu, schermo intero, background) e i tasti
//   nascosti in corsa funzionano da soli. Il boss è un sotto-stato a parte,
//   dino.boss: null (nessuno) oppure { fase, tipo, livello, t, corsa0,
//   velocita, esito, gioco, dita, tasti, prima }: gioco è lo stato del
//   minigioco, dita e tasti quello che è tenuto giù, prima = primo incontro
//   con quel boss (suggerimento). t = ms passati nella fase, accumulati SOLO col
//   dt dei passi (dinoAvanza): in pausa o in background il boss è fermo come
//   la corsa. Mai performance.now, setTimeout o dino.amb.tempo (girano anche
//   in pausa).
//
// · Fasi (dinoBossPasso):
//   attesa   soglia raggiunta (dino.prossimoBoss, a livello: anche i +10 e le
//            combo la scavalcano). Corsa normale ma niente bonus né icone di
//            Windows nuovi; aspetta che finiscano oggetto in volo, potere,
//            trasformazione, drop, finestre, cartellone e grazia
//            (dinoBossLibero). In Crazy senza questo stop non finirebbe mai.
//   sgombro  non parte più niente, neanche gli ostacoli; quelli già in
//            strada si saltano come sempre (urti accesi). Finisce con la
//            strada vuota e il dino a terra: quindi nessun ostacolo passa
//            attraverso il dino e nessuno sparisce per magia.
//   arrivo   la corsa frena fino a fermarsi, il boss entra dal lato opposto
//            (BOSS_ARRIVO). La strada è vuota: urti spenti per costruzione.
//   incontro mondo fermo, la scena (BOSS_INCONTRO): reazione del dino, il
//            cartellone col titolo (dinoCartellone col suo orologio), suono e
//            vibrazione.
//   entra    la tendina a nero (BOSS_TENDINA): metà chiude sulla scena, metà
//            apre sul minigioco. Con «riduci movimento» è un taglio netto.
//   gioco    il minigioco, nello stesso canvas e alla stessa scala; al
//            massimo BOSS_TEMPO, poi «pari». Finisce con vinto/perso/pari.
//   esito    la gag finale (BOSS_ESITO), disegnata dal minigioco.
//   esce     la tendina al contrario, sulla corsa. Poi dinoBossFine: la
//            conseguenza (BOSS_PREMIO e BOSS_REGALO, o BOSS_SCONFITTA), la
//            grazia (BOSS_GRAZIA, il dino sfarfalla da solo), la strada libera
//            davanti (BOSS_RIPRESA) e la soglia dopo.
//
// · Innesti nel gioco (pochi, e tutti cercano «dino.boss» o «dinoBoss»):
//   dinoAvanza   a ogni passo da un fotogramma: dinoPasso solo nelle fasi in
//                cui la corsa gira (dinoBossCorre), poi dinoBossPasso.
//                Dall'incontro in poi dinoPasso non gira: dino.corsa (che è
//                l'orologio di poteri, grazia, scadenze), la velocità e i
//                punti restano fermi.
//   dinoPasso    lo spawn solo senza boss (un cancello: ostacoli, bonus e
//                virus insieme); bonus e virus anche dentro dinoNuovoOggetto
//                e dinoNuovoOstacolo (in attesa gli ostacoli continuano).
//   dinoDisegna  se il minigioco copre la scena (dinoBossCopre) disegna solo
//                quello e la pausa; altrimenti il mondo come sempre più il
//                boss sulla strada (dinoBossStrada) e titolo e tendina sopra
//                (dinoBossSopra).
//   input        il dito (in unità del campo, con il suo id, dinoBossPuntatore)
//                e i tasti (frecce, spazio, invio: dinoBossTasto, anche col
//                fuoco altrove: dinoBossFreccia) vanno al minigioco. I
//                rilasci arrivano sempre, anche in pausa; alla ripresa e al
//                blur della finestra si lascia tutto (dinoBossMolla). Nei
//                primi BOSS_SORDO ms i tocchi non contano. dinoTocca non fa
//                saltare né caricare Godzilla col boss arrivato.
//   azzerare     dinoNuovaPartita e dinoPrepara (ingresso, cambio modalità).
//   dinoDom      la classe .boss sul cabinato nasconde OFFLINE MODE mentre
//                il minigioco ha bisogno di tutta l'altezza.
//   background   il visibilitychange «hidden» mette in pausa (prima non lo
//                faceva nessuno: il rAF in sospeso ripartiva da solo), e quella
//                pausa resta protetta dal rientro online (dinoInGioco,
//                DINO_PAUSA_TUTELA). Il blur della finestra a metà minigioco
//                pure.
//
// · Ritorno alla corsa. dino.corsa è andato avanti in attesa, sgombro e
//   arrivo: prossimoOggetto e prossimoErrore si spostano avanti dello stesso
//   tanto (al ritorno non esce subito un bonus). dino.coda diventa un
//   segnaposto largo BOSS_RIPRESA ms di strada: il meccanismo è quello di
//   sempre, quindi il simulatore (tools/percorso) resta valido. La velocità
//   torna quella di prima del boss. Si esce dal boss SOLO da dinoBossFine o
//   con una partita nuova (dinoNuovaPartita, dinoPrepara, dinoSchianto):
//   l'arrivo lascia la velocità a 0,5 e solo dinoBossFine la ridà.
//
// · Minigiochi (BOSS_GIOCHI[tipo], fasi 3-4), tutti con la stessa forma:
//   { titolo, sotto, colore, aiuto, nuovo(livello), misura(g) → { w, h },
//     passo(g, dt) → null | "vinto" | "perso", disegna(c, g, x0, y0),
//     dito(g, { tipo: "giu" | "muovi" | "su", x, y, id }),
//     tasto(g, { tasto: "sinistra" | "destra" | "su" | "giu" | "azione", giu }),
//     esito(c, g, x0, y0, k, esito) }
//   Coordinate tutte loro (unità del campo, celle a 1 unità con dinoTela):
//   il campo si ricentra a ogni fotogramma da dino.w e dino.h, così rotazione,
//   schermo intero e Home desktop non rompono niente. Il dito arriva già in
//   unità del campo. Un solo dito basta: zone, tocco, tieni premuto, trascina.
//   Vincoli: la scala è quella del gioco e l'altezza è il limite (162 unità
//   nel banner e in Home, 168 a schermo intero), quindi campo al massimo
//   ~272 × 150 (iPhone da 375 pt: banner largo 295; a schermo intero la ×
//   copre l'angolo in alto a destra), misure pari (celle su pixel interi).
//   Un errore nel minigioco non blocca il gioco: il boss finisce «pari»
//   (dinoBossProva). disegna ed esito non cambiano mai lo stato: girano
//   anche in pausa e al resize. Fisica e passi propri, a tick fisso
//   di 1000/60 con accumulatore (mai DINO_G né dinoSpinta: il salto del dino
//   è alto 58 unità). Quello che cambia (puntini mangiati) su una tela
//   propria dentro g: la cache di dinoTela si svuota tutta oltre 160 chiavi.
//   Con la musica di Crackify accesa il gioco tace: ogni segnale anche a vista.
//   Il simulatore ha lo scenario col boss: node tools/percorso/run.mjs misto boss.
//
// · Debug: window.__dinoBoss("invasori") chiama subito quel boss (anche con
//   BOSS_ACCESO spento); con BOSS_ACCESO window.__dino.punti = 990 porta
//   alla prima soglia. ——
// Il boss vero si accende a minigiochi pronti (fase 2): fino ad allora solo
// window.__dinoBoss lo fa partire
const BOSS_ACCESO = false;
// l'ordine dei boss in una partita; finito il giro ricomincia un livello più su
const BOSS_ORDINE = ["invasori", "scimmione", "labirinto"]; // Vitto 08/10: dal più immediato al più impegnativo
const BOSS_ARRIVO = 1600; // ms: la corsa frena e il boss entra
const BOSS_INCONTRO = 2000; // ms: la scena d'incontro col titolo
const BOSS_TENDINA = 900; // ms: chiude a nero e riapre (metà e metà)
const BOSS_TEMPO = 60000; // ms: tetto del minigioco, poi «pari»
const BOSS_ESITO = 1400; // ms: la gag di vittoria o sconfitta
const BOSS_GRAZIA = 2000; // ms di corsa senza morire, al ritorno
const BOSS_RIPRESA = 1500; // ms di strada libera davanti, al ritorno
const BOSS_FRENATA = 900; // ms dell'arrivo in cui la corsa rallenta fino a fermarsi
const BOSS_SORDO = 250; // ms all'inizio del minigioco in cui i tocchi non contano
// conseguenze (decise da Vitto il 08/10: vittoria +300 e Stella, sconfitta
// game over; «riprendi» resta pronta cambiando BOSS_SCONFITTA):
// vittoria = BOSS_PREMIO punti e il potere BOSS_REGALO (chiave di OGGETTI, o
// null); sconfitta = "riprendi" (scagliato lontano, la corsa riparte, meno
// BOSS_PENALITA punti) oppure "muori" (game over, record salvato come sempre).
// Tempo scaduto («pari»): né premio né penalità
const BOSS_PREMIO = 300;
const BOSS_REGALO = "stella";
const BOSS_SCONFITTA = "muori"; // Vitto 08/10: perdere col boss è game over
const BOSS_PENALITA = 0;
const BOSS_VISTI_KEY = "crackify_dino_boss_visti"; // boss già giocati: il suggerimento solo la prima volta

// —— BOSS: il motore (l'architettura è in cima al blocco, vicino a
// BOSS_ACCESO). Qui la macchina a stati, l'input del minigioco, la tendina e
// il segnaposto della fase 1. ——

// I minigiochi, uno per boss (fasi 3-4). Finché non ci sono, tutti e tre
// usano il segnaposto: un riquadro dove un tocco a destra vince e uno a
// sinistra perde, per provare il giro intero (arrivo, tendina, ritorno)
const BOSS_SEGNAPOSTO = {
  titolo: "Boss!",
  sotto: "Arriva il boss",
  colore: "#ff5fd2",
  aiuto: "Destra vinci  sinistra perdi",
  nuovo: () => ({ esito: null }),
  misura: () => ({ w: 200, h: 110 }),
  passo: (g) => g.esito,
  dito: (g, ev) => {
    if (ev.tipo === "giu" && ev.y >= 0 && ev.y <= 110) g.esito = ev.x >= 100 ? "vinto" : "perso";
  },
  tasto: (g, ev) => {
    if (ev.giu && ev.tasto === "destra") g.esito = "vinto";
    if (ev.giu && ev.tasto === "sinistra") g.esito = "perso";
  },
  disegna: (c, g, x, y) => {
    c.fillStyle = "rgba(255, 106, 0, 0.5)";
    c.fillRect(x, y, 200, 1);
    c.fillRect(x, y + 109, 200, 1);
    c.fillRect(x, y, 1, 110);
    c.fillRect(x + 199, y, 1, 110);
    c.fillRect(x + 100, y + 8, 1, 94);
    dinoScritta(c, "Minigioco", x + 100, y + 10, "#f4f4f5", DINO_FONT_PICCOLO);
    dinoScritta(c, "Perdi", x + 50, y + 52, "#ff3b3b", DINO_FONT_PICCOLO);
    dinoScritta(c, "Vinci", x + 150, y + 52, "#7dff4a", DINO_FONT_PICCOLO);
  },
  esito: (c, g, x, y, k, esito) => {
    const testo = esito === "vinto" ? "Vinto!" : esito === "perso" ? "Perso!" : "Tempo!";
    dinoScritta(c, testo, x + 100, y + 48, esito === "vinto" ? "#7dff4a" : "#ff5fd2");
  },
};
// il titolo del cartellone all'incontro (mai i nomi dei giochi originali; il
// DINO_FONT grande non ha J né Q fino alla v415)
const BOSS_GIOCHI = {
  invasori: { ...BOSS_SEGNAPOSTO, titolo: "Invasione!", sotto: "Difendi la Terra", colore: "#7dff4a" },
  scimmione: { ...BOSS_SEGNAPOSTO, titolo: "Scimmione!", sotto: "Sali fino in cima", colore: "#ff8a2a" },
  labirinto: { ...BOSS_SEGNAPOSTO, titolo: "Labirinto!", sotto: "Mangia e scappa", colore: "#ffd23f" },
};

// —— FASE 2: l'incontro. Il boss segnaposto (lo stesso per tutti finché non
// ci sono i veri): un mostro viola a celle da 1 unità, corna, occhi gialli,
// zanne e braccia. Due pose: braccia giù e braccia su (si batte il petto) ——
const BOSS_SAGOMA = [
  "....hh..............hh....",
  "....hHh............hHh....",
  ".....hHh..........hHh.....",
  "......hh.oooooooo.hh......",
  ".......ooppppppppoo.......",
  "......opPPPPPPPPPPpo......",
  ".....opPPPPPPPPPPPPpo.....",
  ".....opPyyPPPPPPyyPpo.....",
  ".....opPyKPPPPPPKyPpo.....",
  ".....opPPPPPPPPPPPPpo.....",
  ".....opPkkkkkkkkkkPpo.....",
  ".....opPkwkwkkwkwkPpo.....",
  "......opPkkkkkkkkPpo......",
  ".......oppPPPPPPppo.......",
  "....oooopPPPPPPPPpoooo....",
  "..oopppPPPPPPPPPPPPpppoo..",
  ".opPPPPPPPPPPPPPPPPPPPPpo.",
  ".opPPo.pPPPPPPPPPPp.oPPpo.",
  ".opPo..pPPPPPPPPPPp..oPpo.",
  ".oppo..pPPPddddPPPp..oppo.",
  ".owwo..pPPddddddPPp..owwo.",
  "..oo...pPPPPPPPPPPp...oo..",
  ".......ppPPPPPPPPpp.......",
  ".......opPPpoopPPpo.......",
  "......oopPpo..opPpoo......",
  "......owwwwo..owwwwo......",
];
// braccia su: le righe delle braccia (16-21) col pugno al petto
const BOSS_SAGOMA_SU = BOSS_SAGOMA.map((r, i) => {
  if (i === 16) return ".opPPPPPPwwPPPPwwPPPPPPpo.";
  if (i === 17) return "..oopPPPwwwPPPPwwwPPPpoo..";
  if (i === 18) return "....ooPPPPPPPPPPPPPPoo....";
  if (i === 19) return ".......pPPPddddPPPp.......";
  if (i === 20) return ".......pPPddddddPPp.......";
  if (i === 21) return ".......pPPPPPPPPPPp.......";
  return r;
});
const BOSS_SAGOMA_SCALA = 2; // celle da 2 unità: il boss è alto il doppio del dino
const BOSS_SAGOMA_COLORI = { o: "#1a0826", p: "#6b2a9e", P: "#9b4fd6", d: "#4a1a70", h: "#e6e6f0", H: "#ffffff", y: "#ffd23f", K: "#141414", k: "#2a0a1a", w: "#f4f4f5" };
// i suoni del boss sul web (Web Audio, dinoSuono): stessi numeri della
// ricetta nativa (NativeAudioPlugin.swift, SuoniGioco, 08/10)
const BOSS_SUONI = {
  boss_arriva: (tono, campana, rumore) =>
    [0, 0.3, 0.6].forEach((t) => {
      rumore(0.07, 400, t, 0.9);
      tono(75, 50, t, 0.12, 0.9);
    }),
  boss_titolo: (tono, campana) => {
    [523, 659, 784].forEach((f, i) => tono(f, f, i * 0.09, 0.08, 0.8));
    tono(1047, 1047, 0.27, 0.22, 0.8);
    campana(1047, 0.27, 0.45, 0.5);
  },
  tendina: (tono, campana, rumore) => [600, 1200, 2400, 4800].forEach((f, i) => rumore(0.06, f, i * 0.05, 0.3 + i * 0.1)),
  tendina_corta: (tono, campana, rumore) => rumore(0.08, 2000, 0, 0.5),
  boss_vinto: (tono, campana) => {
    [523, 659, 784].forEach((f, i) => tono(f, f, i * 0.1, 0.09, 0.8));
    tono(1047, 1047, 0.3, 0.3, 0.8);
    campana(1568, 0.3, 0.5, 0.4);
  },
  boss_perso: (tono) => {
    tono(392, 196, 0, 0.32, 0.8);
    tono(330, 165, 0.34, 0.4, 0.8);
  },
  inv_passo1: (tono) => tono(110, 110, 0, 0.07, 0.8),
  inv_passo2: (tono) => tono(98, 98, 0, 0.07, 0.8),
  inv_passo3: (tono) => tono(87, 87, 0, 0.07, 0.8),
  inv_passo4: (tono) => tono(82, 82, 0, 0.07, 0.8),
  inv_sparo: (tono) => tono(1400, 350, 0, 0.09, 0.5),
  inv_scoppio: (tono, campana, rumore) => rumore(0.16, 1500, 0, 0.7),
  inv_ufo: (tono) => {
    tono(880, 1320, 0, 0.12, 0.4);
    tono(1320, 880, 0.12, 0.12, 0.4);
  },
  inv_colpito: (tono, campana, rumore) => {
    rumore(0.25, 800, 0, 0.8);
    tono(220, 60, 0, 0.3, 0.7);
  },
  sc_petto: (tono, campana, rumore) =>
    [0, 0.12, 0.24, 0.36].forEach((t) => {
      rumore(0.05, 300, t, 0.9);
      tono(80, 80, t, 0.06, 0.9);
    }),
  sc_barile: (tono) => {
    tono(1320, 1320, 0, 0.05, 0.6);
    tono(1760, 1760, 0.05, 0.06, 0.6);
  },
  lab_waka1: (tono) => tono(220, 440, 0, 0.07, 0.6),
  lab_waka2: (tono) => tono(440, 220, 0, 0.07, 0.6),
  lab_pillola: (tono) => tono(220, 880, 0, 0.25, 0.6),
  lab_fantasma: (tono) => tono(200, 1600, 0, 0.22, 0.6),
};
const BOSS_TITOLO_DA = 150; // ms dell'incontro in cui entra il cartellone
// i tasti del minigioco (desktop): frecce, spazio e invio
const BOSS_TASTI = { ArrowLeft: "sinistra", ArrowRight: "destra", ArrowUp: "su", ArrowDown: "giu", " ": "azione", Enter: "azione" };

/** La corsa gira? Sì senza boss e finché il boss non è arrivato. */
function dinoBossCorre() {
  const b = dino.boss;
  return !b || b.fase === "attesa" || b.fase === "sgombro" || b.fase === "arrivo";
}

/** Niente in corso che il boss interromperebbe: oggetto in volo, potere,
 * trasformazione di Godzilla, drop, finestre di Windows (o la sua icona in
 * strada), il cartellone di un potere, la grazia. */
function dinoBossLibero() {
  return (
    !dino.oggetto &&
    !dino.potere &&
    !dino.muta &&
    !dino.carica &&
    !dino.soffio &&
    !dino.drop &&
    !dino.lanciati.length &&
    !dino.virus &&
    !dino.ostacoli.some((o) => o.tipo === "virus") &&
    !(dino.annuncio && dino.corsa < dino.annuncio.fino) &&
    dino.corsa >= dino.grazia
  );
}

/** Soglia raggiunta (o window.__dinoBoss): il boss si prepara. */
function dinoBossChiama(tipo) {
  let visti = {};
  try {
    visti = JSON.parse(localStorage.getItem(BOSS_VISTI_KEY) || "{}") || {};
  } catch (_) {}
  const giro = BOSS_ORDINE.length;
  tipo = BOSS_GIOCHI[tipo] ? tipo : BOSS_ORDINE[dino.bossVisti % giro];
  dino.boss = {
    fase: "attesa",
    tipo,
    livello: Math.floor(dino.bossVisti / giro), // al secondo giro più difficile
    t: 0,
    corsa0: dino.corsa, // per spostare avanti le scadenze al ritorno
    velocita: dino.velocita, // quella da ridare al ritorno
    esito: null, // "vinto" | "perso" | "pari"
    gioco: null, // lo stato del minigioco (BOSS_GIOCHI[tipo].nuovo)
    dita: new Set(), // pointerId delle dita giù nel minigioco
    tasti: new Set(), // tasti tenuti nel minigioco ("sinistra", "azione"...)
    prima: !visti[tipo], // prima volta: il suggerimento
  };
}

function dinoBossFase(b, fase) {
  b.fase = fase;
  b.t = 0;
  // suoni e vibrazioni di fase: qui, dentro il passo (mai nel disegno, che
  // gira anche in pausa). Con la musica di Crackify accesa tacciono
  if (fase === "arrivo") dinoSuono("boss_arriva");
  else if (fase === "incontro") {
    dinoSuono("boss_titolo");
    dinoVibra("HEAVY");
  } else if (fase === "entra" || fase === "esce") dinoSuono(dinoMotoRidotto() ? "tendina_corta" : "tendina");
  else if (fase === "esito") {
    dinoSuono(b.esito === "vinto" ? "boss_vinto" : b.esito === "perso" ? "boss_perso" : "tendina_corta");
    dinoVibra(b.esito === "vinto" ? "MEDIUM" : "HEAVY");
  }
}

/** Chiama il minigioco senza rischi: un errore lì dentro fermerebbe il ciclo
 * (il rAF non si riarma) e il gioco resterebbe bloccato fino al reload.
 * Segna il guasto (anche dal disegno: è l'unica cosa che cambia) e il boss
 * finisce «pari» al passo dopo. */
function dinoBossProva(b, fn) {
  if (b.guasto) return null;
  try {
    return fn();
  } catch (err) {
    b.guasto = true;
    console.error("Boss", b.tipo, err);
    return null;
  }
}

/** Quanto dura la tendina: con «riduci movimento» è solo un taglio a nero. */
function dinoBossTendina() {
  return dinoMotoRidotto() ? 240 : BOSS_TENDINA;
}

/** Un passo del boss (dopo dinoPasso, se la corsa gira): senza boss guarda
 * la soglia, altrimenti manda avanti la sua fase. Tempo solo dal dt. */
function dinoBossPasso(dt) {
  const b = dino.boss;
  if (!b) {
    if (dino.punti >= dino.prossimoBoss) dinoBossChiama();
    return;
  }
  b.t += dt;
  const gioco = BOSS_GIOCHI[b.tipo];
  if (b.fase === "attesa") {
    if (dinoBossLibero()) dinoBossFase(b, "sgombro");
  } else if (b.fase === "sgombro") {
    // strada vuota e dino a terra: nessun ostacolo passa attraverso il dino
    if (!dino.ostacoli.length && !dino.oggetto && !dino.lanciati.length && dino.y === 0 && dino.vy === 0) {
      b.velocita = dino.velocita;
      dinoBossFase(b, "arrivo");
    }
  } else if (b.fase === "arrivo") {
    // frena fino a fermarsi (0,5: lo scenario scorre di velocità − 0,5)
    const q = Math.min(1, b.t / BOSS_FRENATA);
    dino.velocita = Math.max(0.5, b.velocita * (1 - q) * (1 - q));
    // i passi pesanti del boss: una botta a ogni passo del suono
    const passo = Math.floor(b.t / 300);
    if (passo < 3 && passo !== b.passo) {
      b.passo = passo;
      dinoVibra("LIGHT");
    }
    if (b.t >= BOSS_ARRIVO) dinoBossFase(b, "incontro");
  } else if (b.fase === "incontro") {
    if (b.t >= BOSS_INCONTRO) {
      dinoBossFase(b, "entra");
      b.gioco = dinoBossProva(b, () => gioco.nuovo(b.livello)) || {};
    }
  } else if (b.fase === "entra") {
    if (b.t >= dinoBossTendina()) dinoBossFase(b, "gioco");
  } else if (b.fase === "gioco") {
    const esito = dinoBossProva(b, () => gioco.passo(b.gioco, dt)) || (b.guasto || b.t >= BOSS_TEMPO ? "pari" : null);
    if (esito) {
      b.esito = esito;
      dinoBossFase(b, "esito");
    }
  } else if (b.fase === "esito") {
    if (b.t >= BOSS_ESITO) dinoBossFase(b, "esce");
  } else if (b.fase === "esce") {
    if (b.t >= dinoBossTendina()) dinoBossFine(b);
  }
}

/** Fine del boss: si torna a correre (vedi BOSS in cima, «Ritorno»). */
function dinoBossFine(b) {
  const m = dinoModo();
  dino.boss = null;
  dino.bossVisti++;
  try {
    const visti = JSON.parse(localStorage.getItem(BOSS_VISTI_KEY) || "{}") || {};
    visti[b.tipo] = 1;
    localStorage.setItem(BOSS_VISTI_KEY, JSON.stringify(visti));
  } catch (_) {}
  // la corsa riparte com'era: velocità di prima, scadenze di bonus e icone
  // di Windows spostate avanti di quanto è durata la parte di corsa del
  // boss, strada libera davanti (la coda è un segnaposto) e un po' di grazia
  const d = dino.corsa - b.corsa0;
  dino.prossimoOggetto += d;
  dino.prossimoErrore += d;
  dino.velocita = b.velocita;
  const pxms = ((dino.velocita - 0.5) * DINO_K) / DINO_FOTOGRAMMA;
  dino.coda = { x: dino.w, w: 0, distacco: BOSS_RIPRESA * pxms, scarto: 0 };
  dino.grazia = dino.corsa + BOSS_GRAZIA;
  if (b.esito === "vinto") {
    dino.punti += BOSS_PREMIO;
    dino.cento = dino.corsa; // il punteggio lampeggia (dinoPunteggio)
    dino.scritte.push({ x: dinoX() + DINO_W / 2, y: dinoTerra() - DINO_H - 10, vita: 0, testo: `+${BOSS_PREMIO}` });
    if (BOSS_REGALO && OGGETTI[BOSS_REGALO]) dinoPrendi({ tipo: BOSS_REGALO });
  } else if (b.esito === "perso") {
    if (BOSS_SCONFITTA === "muori") {
      dinoSchianto({ tipo: "boss" });
      return;
    }
    dino.punti = Math.max(0, dino.punti - BOSS_PENALITA);
  }
  // la soglia dopo, contata da quella raggiunta e spostata del premio (Vitto
  // 08/10: il premio non avvicina il boss dopo): mai saltata né ripetuta
  const ogni = m.boss ? m.boss.ogni : 1e12;
  if (dino.prossimoBoss < 1e12) {
    dino.prossimoBoss += b.esito === "vinto" ? BOSS_PREMIO : 0;
    do dino.prossimoBoss += ogni;
    while (dino.prossimoBoss <= dino.punti);
  }
}

/** Il minigioco (o il nero della tendina) prende il posto del mondo? */
function dinoBossCopre() {
  const b = dino.boss;
  if (!b) return false;
  const meta = dinoBossTendina() / 2;
  return b.fase === "gioco" || b.fase === "esito" || (b.fase === "entra" && b.t >= meta) || (b.fase === "esce" && b.t < meta);
}

/** Dove sta il campo del minigioco: centrato nel banner (a schermo intero
 * fra l'isola e il bordo destro), a unità pari (celle su pixel interi),
 * ricalcolato a ogni fotogramma (rotazione, schermo intero, Home). */
function dinoBossCampo(b) {
  const { w, h } = dinoBossProva(b, () => BOSS_GIOCHI[b.tipo].misura(b.gioco)) || { w: 0, h: 0 };
  const cx = (dino.margine + dino.w - dino.margineDx) / 2;
  return { x: DINO_CELLA * Math.round((cx - w / 2) / DINO_CELLA), y: DINO_CELLA * Math.round((dino.h - h) / 2 / DINO_CELLA), w, h };
}

/** Il minigioco ascolta? Solo nella fase di gioco, in corsa (in pausa il
 * tocco deve arrivare a dinoTocca, che riprende e basta) e dopo un attimo
 * (BOSS_SORDO: un tocco nervoso dell'incontro non diventa una mossa). */
function dinoBossAscolta(b) {
  return !!(b && b.fase === "gioco" && b.gioco && dino.stato === "corsa" && b.t >= BOSS_SORDO);
}

/** Il dito nel minigioco, in unità del campo, con il suo id (più dita). Si
 * seguono solo le dita andate giù nel minigioco: il mouse sospeso, o un dito
 * partito dalla × o dalla corsa, non muovono niente. Il rilascio arriva
 * sempre, anche in pausa: un dito lasciato lì non resta giù per sempre.
 * true = preso (solo per «giu»). */
function dinoBossPuntatore(tipo, e) {
  const b = dino.boss;
  if (!b || !b.gioco) return false;
  if (tipo === "giu") {
    if (!dinoBossAscolta(b)) return b.fase === "gioco" && dino.stato === "corsa"; // sordo: preso, senza effetto
    if (e.button > 0) return true; // tasto destro o centrale del mouse
    b.dita.add(e.pointerId);
    dinoSuonoSveglia(); // dentro il gesto: iOS sblocca l'audio solo qui
  } else if (!b.dita.has(e.pointerId)) {
    return false;
  } else if (tipo === "su") {
    b.dita.delete(e.pointerId);
  } else if (dino.stato !== "corsa") {
    return false;
  }
  const gioco = BOSS_GIOCHI[b.tipo];
  const cv = document.getElementById("dinoCanvas");
  const r = cv && cv.getBoundingClientRect();
  if (!r || !r.width || !r.height || !gioco.dito) return true;
  // il rettangolo è già ingrandito (schermo intero, Home): si divide per lui
  const campo = dinoBossCampo(b);
  const x = ((e.clientX - r.left) / r.width) * dino.w - campo.x;
  const y = ((e.clientY - r.top) / r.height) * dino.h - campo.y;
  dinoBossProva(b, () => gioco.dito(b.gioco, { tipo, x, y, id: e.pointerId }));
  return true;
}

/** I tasti nel minigioco (frecce, spazio, invio; con Ctrl/Cmd/Alt no: le
 * frecce cambiano brano). Il rilascio arriva sempre, come per le dita.
 * true = preso. */
function dinoBossTasto(e, giu) {
  const b = dino.boss;
  const tasto = BOSS_TASTI[e.key];
  if (!b || !b.gioco || !tasto || e.altKey || e.ctrlKey || e.metaKey) return false;
  const gioco = BOSS_GIOCHI[b.tipo];
  if (!giu) {
    if (!b.tasti.has(tasto)) return false;
    b.tasti.delete(tasto);
    if (gioco.tasto) dinoBossProva(b, () => gioco.tasto(b.gioco, { tasto, giu: false }));
    return true;
  }
  if (b.fase !== "gioco") return false;
  // in pausa le frecce non scorrono la pagina; spazio, invio e su riprendono
  if (dino.stato !== "corsa") {
    if (tasto === "sinistra" || tasto === "destra" || tasto === "giu") e.preventDefault();
    return false;
  }
  e.preventDefault();
  if (e.repeat || !dinoBossAscolta(b) || b.tasti.has(tasto)) return true;
  b.tasti.add(tasto);
  if (gioco.tasto) dinoBossProva(b, () => gioco.tasto(b.gioco, { tasto, giu: true }));
  return true;
}

/** Lascia tutte le dita e i tasti tenuti nel minigioco: alla ripresa dalla
 * pausa e quando la finestra perde il fuoco (Alt-Tab: il keyup non arriva). */
function dinoBossMolla() {
  const b = dino.boss;
  if (!b || !b.gioco) return;
  const gioco = BOSS_GIOCHI[b.tipo];
  b.dita.forEach((id) => gioco.dito && dinoBossProva(b, () => gioco.dito(b.gioco, { tipo: "su", x: NaN, y: NaN, id })));
  b.tasti.forEach((tasto) => gioco.tasto && dinoBossProva(b, () => gioco.tasto(b.gioco, { tasto, giu: false })));
  b.dita.clear();
  b.tasti.clear();
}

/** Da desktop col fuoco altrove: le frecce del minigioco danno il fuoco al
 * campo (poi tasti e rilasci li gestisce lui), come lo spazio (dinoSpazio). */
function dinoBossFreccia(e) {
  const campo = dinoCampo();
  const b = dino.boss;
  if (!campo || e.target === campo || !b || b.fase !== "gioco" || dinoMenuAperto()) return false;
  if (e.altKey || e.ctrlKey || e.metaKey || !dinoMisura()) return false;
  campo.focus({ preventScroll: true });
  return dinoBossTasto(e, true);
}

/** Il tocco senza coordinate (lo spazio dal desktop, dinoSpazio): col boss
 * arrivato è suo, e il dino non salta. true = preso. */
function dinoBossTocca() {
  const b = dino.boss;
  if (!b || b.fase === "attesa" || b.fase === "sgombro") return false;
  const gioco = BOSS_GIOCHI[b.tipo];
  if (dinoBossAscolta(b) && !b.tasti.has("azione")) {
    b.tasti.add("azione"); // il keyup arriva al campo, che ora ha il fuoco
    if (gioco.tasto) dinoBossProva(b, () => gioco.tasto(b.gioco, { tasto: "azione", giu: true }));
  }
  return true;
}

/** Il minigioco al posto del mondo: fondo, campo, suggerimento la prima
 * volta, la gag dell'esito e la tendina che apre o chiude. */
function dinoBossScena(c, W, H) {
  const b = dino.boss;
  const gioco = BOSS_GIOCHI[b.tipo];
  c.fillStyle = "#07060b";
  c.fillRect(0, 0, W, H);
  if (b.gioco) {
    const r = dinoBossCampo(b);
    // il minigioco non deve lasciare trasparenze, composizioni o smoothing
    // al resto del disegno (e la corsa ne lascia: lo smoothing lo rimette)
    c.save();
    c.imageSmoothingEnabled = false;
    if (b.fase === "esito") dinoBossProva(b, () => gioco.esito(c, b.gioco, r.x, r.y, Math.min(1, b.t / BOSS_ESITO), b.esito));
    else dinoBossProva(b, () => gioco.disegna(c, b.gioco, r.x, r.y));
    c.restore();
    if (b.fase === "gioco" && b.prima && b.t < 3000 && (dinoMotoRidotto() || Math.floor(b.t / 450) % 3 !== 2)) {
      dinoScritta(c, gioco.aiuto, W / 2, r.y + r.h - 12, "#bdf6ff", DINO_FONT_PICCOLO);
    }
  }
  dinoBossVelo(c, W, H);
}

/** Dove sta il boss sulla strada: entra da destra durante l'arrivo e si
 * ferma a 2/3 del banner, davanti al dino. Solo da b.t e dalle misure di
 * adesso (rotazione e schermo intero non lo perdono). */
function dinoBossPosto(b, W) {
  const larga = BOSS_SAGOMA[0].length * BOSS_SAGOMA_SCALA;
  const fermo = DINO_CELLA * Math.round((Math.max(dinoX() + 90, W * 0.68) - larga / 2) / DINO_CELLA);
  if (b.fase !== "arrivo") return fermo;
  const q = Math.min(1, b.t / BOSS_ARRIVO);
  const ingresso = 1 - (1 - q) * (1 - q); // rallenta arrivando
  return DINO_CELLA * Math.round((W + 6 + (fermo - W - 6) * ingresso) / DINO_CELLA);
}

/** Il boss sulla strada, mentre arriva e durante l'incontro (sotto il
 * dino e gli effetti, e trema col mondo). Cammina a passi pesanti,
 * all'incontro si batte il petto. Con «riduci movimento» fermo. */
function dinoBossStrada(c, terra) {
  const b = dino.boss;
  if (!b || (b.fase !== "arrivo" && b.fase !== "incontro" && !(b.fase === "entra" && !dinoBossCopre()))) return;
  const W = dino.w;
  const fermo = dinoMotoRidotto();
  const x = dinoBossPosto(b, W);
  let su = false;
  let dy = 0;
  if (!fermo && b.fase === "arrivo") dy = Math.floor(b.t / 150) % 2 ? -DINO_CELLA : 0; // passi
  if (!fermo && b.fase === "incontro") su = Math.floor(b.t / 220) % 2 === 1; // petto
  const righe = su ? BOSS_SAGOMA_SU : BOSS_SAGOMA;
  const tela = dinoTela(`boss|sagoma|${su ? 1 : 0}`, righe, BOSS_SAGOMA_COLORI);
  const sc = BOSS_SAGOMA_SCALA;
  const bw = righe[0].length * sc;
  const bh = righe.length * sc;
  // ombra sotto i piedi
  c.fillStyle = "rgba(0, 0, 0, 0.35)";
  c.fillRect(x + 4, terra - 1, bw - 8, 2);
  c.imageSmoothingEnabled = false;
  c.drawImage(tela, x, terra - bh + dy, bw, bh);
  // battendosi il petto: due cerchi d'urto che si allargano
  if (su && !fermo) {
    const k = (b.t % 440) / 440;
    c.fillStyle = `rgba(155, 79, 214, ${(0.5 * (1 - k)).toFixed(2)})`;
    const r = Math.round(12 + 20 * k);
    const cx = x + bw / 2;
    const cy = terra - 16 * sc;
    c.fillRect(cx - r, cy - 1, 2, 2);
    c.fillRect(cx + r - 2, cy - 1, 2, 2);
  }
}

/** Il dino all'incontro: occhioni sgranati con le pupille piccole, bocca
 * spalancata, un «!» sopra la testa e due gocce di sudore. Sopra lo sprite
 * di sempre (occhio a colonne 19-20 righe 6-7, bocca alla riga 11). */
function dinoBossSpavento(c, b) {
  const x0 = dinoX();
  const y0 = Math.round(dinoTerra() - dino.y - DINO_H);
  c.fillStyle = "#141414";
  c.fillRect(x0 + 17, y0 + 4, 6, 6); // contorno dell'occhio
  c.fillStyle = "#ffffff";
  c.fillRect(x0 + 18, y0 + 5, 4, 4);
  c.fillStyle = "#141414";
  c.fillRect(x0 + 20, y0 + 6, 1, 2); // pupilla minuscola che guarda il boss
  // bocca aperta: il muso si stacca sotto la riga 11
  c.fillStyle = "#141414";
  c.fillRect(x0 + 20, y0 + 11, 8, 3);
  c.fillStyle = "#ff5f7a";
  c.fillRect(x0 + 21, y0 + 13, 4, 1); // la lingua
  c.fillStyle = "#ffffff";
  c.fillRect(x0 + 21, y0 + 11, 1, 1);
  c.fillRect(x0 + 25, y0 + 11, 1, 1); // dentini
  const fermo = dinoMotoRidotto();
  // il «!» salta fuori a scatto e poi resta
  if (b.t > 60) {
    const sale = fermo || b.t > 200 ? 0 : DINO_CELLA;
    dinoScritta(c, "!", x0 + 22, y0 - 16 + sale, "#ffd23f");
  }
  // gocce di sudore che cadono
  if (!fermo) {
    [0, 1].forEach((i) => {
      const k = ((b.t + i * 330) % 660) / 660;
      c.fillStyle = `rgba(150, 220, 255, ${(0.9 * (1 - k)).toFixed(2)})`;
      c.fillRect(x0 + 13 - i * 3, y0 + 2 + Math.round(k * 10), 1, 2);
    });
  }
}

/** Sopra la scena della corsa: la reazione del dino e il titolo
 * dell'incontro (col suo orologio), poi la tendina. */
function dinoBossSopra(c, W, H) {
  const b = dino.boss;
  if (!b) return;
  if (b.fase === "incontro" || (b.fase === "entra" && !dinoBossCopre())) {
    dinoBossSpavento(c, b);
    const k = b.fase === "incontro" ? b.t - BOSS_TITOLO_DA : BOSS_INCONTRO - BOSS_TITOLO_DA + b.t;
    if (k >= 0 && k < ANNUNCIO_DURA) {
      const g = BOSS_GIOCHI[b.tipo];
      dinoCartellone(c, W, { testo: g.titolo, sotto: g.sotto, colore: g.colore }, dinoMotoRidotto() ? Math.max(k, 400) : k);
    }
  }
  dinoBossVelo(c, W, H);
}

/** La tendina a nero (segnaposto, la vera in fase 3): strisce orizzontali
 * che si chiudono da destra e da sinistra alternate e si riaprono al
 * contrario. Con «riduci movimento» nero pieno per tutta la (breve) durata. */
function dinoBossVelo(c, W, H) {
  const b = dino.boss;
  if (b.fase !== "entra" && b.fase !== "esce") return;
  const meta = dinoBossTendina() / 2;
  const k = dinoMotoRidotto() ? 1 : b.t < meta ? b.t / meta : 1 - (b.t - meta) / meta;
  if (k <= 0) return;
  c.fillStyle = "#000000";
  const alta = 6 * DINO_CELLA;
  for (let y = 0, i = 0; y < H; y += alta, i++) {
    const w = DINO_CELLA * Math.ceil((Math.min(1, k * 1.15) * W) / DINO_CELLA);
    c.fillRect(i % 2 ? W - w : 0, y, w, alta);
  }
}

// prova a mano dalla console (Safari, Web Inspector): window.__dinoBoss()
// chiama subito il prossimo boss, window.__dinoBoss("invasori") quello
window.__dinoBoss = (tipo) => {
  if (tipo && !BOSS_GIOCHI[tipo]) return `boss: ${BOSS_ORDINE.join(", ")}`;
  if (dino.boss) return `già in corso: ${dino.boss.tipo} (${dino.boss.fase})`;
  if (dino.stato === "pausa") dino.stato = "corsa";
  if (dino.stato !== "corsa") {
    dinoNuovaPartita();
    dino.stato = "corsa";
    dino.corsa = DINO_SGOMBRO; // via subito, senza i primi 3 s vuoti
  }
  dinoBossChiama(tipo);
  dinoAvvia();
  return dino.boss.tipo;
};
