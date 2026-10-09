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
const BOSS_TENDINA = 1000; // ms: chiude a nero e riapre (metà e metà)
const BOSS_TEMPO = 60000; // ms: tetto del minigioco, poi «pari»
const BOSS_ESITO = 1800; // ms: la gag di vittoria o sconfitta
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
// —— INVASORI (fase 3). Tributo fedele al cabinato degli invasori alieni:
// la formazione che marcia a scatti e scende a ogni bordo, sempre più svelta
// man mano che cala, le quattro note della marcia, le bombe dritte e a zig
// zag, i quattro bunker che si sbriciolano, il disco volante del bonus. Il
// cannone è il dino sulla sua astronave (ci salta sopra all'incontro).
// Decisioni di Vitto (08/10): formazione 8 x 4, 2 vite, si vince
// abbattendoli tutti, si perde se arrivano ai bunker. Un dito: il dino
// segue il dito (tenuto o trascinato) e spara da solo; frecce sul desktop.
// Ambiente nostro: cielo notturno col bagliore del tramonto in fondo, bunker
// arancio, cifre e scritte a pixel del gioco. Campo 224 x 150 unità ——
const INV_W = 224;
const INV_H = 150;
const INV_TICK = 1000 / 60; // passo fisso: uguale a 60 e a 120 Hz
// Safari dà i tempi dei fotogrammi arrotondati al ms (16, 17, 17...): col
// passo fisso secco certi fotogrammi facevano 0 tick e altri 2, e astronave,
// colpi e disco andavano a scatti. Con questa tolleranza a 60 Hz è sempre
// uno per fotogramma (il resto può andare un filo sotto zero: in media il
// tempo resta giusto)
const INV_TOLLERA = 2.5;
// il dino insegue il dito: dritto sotto il dito finché il dito non corre più
// di INV_VEL_DITO unità a tick (oltre, ci arriva in scivolata). Il cannone
// originale fa 1 unità al fotogramma, ma col dito sul vetro la lentezza si
// sente come ritardo; con le frecce resta un cannone (INV_VEL_TASTI)
const INV_VEL_DITO = 3.5;
const INV_VEL_TASTI = 2;
// regole e ritmo (bilanciati col simulatore: un giocatore normale vince in
// 30-45 s e perde ogni tanto, mai senza colpa)
const INV_VITE = 2; // Vitto 08/10
const INV_RICARICA = 120; // ms fra un colpo del dino finito e il prossimo
const INV_VEL_COLPO = 5; // unità a tick del colpo del dino (lungo 4, a passi di 5: nessun alieno alto 8 si salta)
const INV_BOMBA_OGNI = 1600; // ms fra due colpi alieni all'inizio...
const INV_BOMBA_MIN = 950; // ...e al più fitto (scende coi punti fatti)
const INV_SCOPPIO_DURA = 270; // ms dell'alieno che esplode (la marcia aspetta)
const INV_ESPLODE = 1000; // ms del dino colpito che esplode (tutto fermo)
const INV_INVULNERABILE = 900; // ms di lampeggio dopo, senza farsi male
const INV_COLONNE = 8;
const INV_RIGHE = 4;
const INV_PASSO_X = 16; // passo della griglia della formazione
const INV_PASSO_Y = 12;
const INV_CIMA = 26; // dove parte la formazione
const INV_BUNKER_Y = 104; // cima dei bunker: arrivati qui gli alieni hanno vinto
const INV_NAVE_Y = 128; // cima del dino sull'astronave
const INV_TERRA = 146;
// gli alieni a celle da 1 unità, due pose ciascuno (seppia, granchio, polpo)
const INV_SEPPIA = [
  ["...##...", "..####..", ".######.", "##.##.##", "########", "..#..#..", ".#.##.#.", "#.#..#.#"],
  ["...##...", "..####..", ".######.", "##.##.##", "########", ".#.##.#.", "#......#", ".#....#."],
];
const INV_GRANCHIO = [
  ["..#.....#..", "...#...#...", "..#######..", ".##.###.##.", "###########", "#.#######.#", "#.#.....#.#", "...##.##..."],
  ["..#.....#..", "#..#...#..#", "#.#######.#", "###.###.###", "###########", ".#########.", "..#.....#..", ".#.......#."],
];
const INV_POLPO = [
  ["....####....", ".##########.", "############", "###..##..###", "############", "...##..##...", "..##.##.##..", "##........##"],
  ["....####....", ".##########.", "############", "###..##..###", "############", "..###..###..", ".##..##..##.", "..##....##.."],
];
const INV_TIPI = [
  { pose: INV_SEPPIA, punti: 30, colore: "#fff3e0" },
  { pose: INV_GRANCHIO, punti: 20, colore: "#fff3e0" },
  { pose: INV_GRANCHIO, punti: 20, colore: "#ffe2c2" },
  { pose: INV_POLPO, punti: 10, colore: "#ffd0a0" },
];
const INV_DISCO = [".....######.....", "...##########...", "..############..", ".##.##.##.##.##.", "################", "..###..##..###..", "...#........#..."];
const INV_SCOPPIO = ["....#...#....", ".#...#.#...#.", "..#.......#..", "...#.....#...", "##.........##", "...#.....#...", "..#.#...#.#..", ".#...#.#...#."];
// i tre colpi degli alieni, come nel cabinato (3 x 7, quattro pose che
// girano mentre cadono): la spirale (mira al dino), il pistone dritto con la
// traversa che scorre e lo zig zag. Al massimo uno per tipo in volo
const INV_COLPI = {
  spirale: [0, 1, 2, 3].map((f) => Array.from({ length: 7 }, (_, r) => ["##.", ".#.", ".##", ".#."][(r + f) % 4])),
  pistone: [0, 1, 2, 3].map((f) => Array.from({ length: 7 }, (_, r) => (r === 6 - 2 * f || (f === 3 && r === 0) ? "###" : ".#."))),
  zigzag: [0, 1, 2, 3].map((f) => Array.from({ length: 7 }, (_, r) => ["#..", ".#.", "..#", ".#."][(r + f) % 4])),
};
const INV_COLPI_ORDINE = ["spirale", "pistone", "zigzag"];
// lo schizzo del colpo alieno che arriva (sui bunker, sul terreno) e il
// botto del colpo del dino (in cima, contro un colpo, sotto un bunker): sono
// anche la forma del morso che lasciano nei bunker, come nell'originale
const INV_SCHIZZO = ["#..#..", "..#..#", ".####.", "######", ".####.", "#.##.#", "..#...", ".#..#."];
const INV_BOTTO = ["#..#...#", "..#..#..", "#.####.#", ".######.", "#######.", ".#####.#", "#.#.##..", "..#..#.#"];
// il morso del colpo del dino da sotto un bunker: stretto, così sparando da
// solo apre una feritoia (come nel cabinato) e non si mangia il riparo
const INV_FORO = ["#.#", "###", "###", ".#."];
// il dino colpito: l'astronave in pezzi, due pose che si alternano
const INV_ROTTA = [
  ["....#....#....#...", ".#....#.....#...#.", "...#..#####..#....", ".....#######..#...", "..#.ooggggoo.#....", ".oogyggg.gyggoo...", "ooggg..ggggggggo.#", ".ooo.oooo..ooo...."],
  ["..#....#...#....#.", "....#.....#..#....", ".#....#####.....#.", "...#.#######.#....", "....ooggggoo...#..", "..oogggyg.gggoo...", "#.oggggggg..gggoo.", "...oooo..oooo.oo.."],
];
// il punteggio misterioso del disco: dipende da quanti colpi hai sparato,
// con la tabella del cabinato (il 23° colpo e poi ogni 15 valgono 300)
const INV_MISTERO = [100, 50, 50, 100, 150, 100, 100, 50, 300, 100, 100, 100, 50, 150, 100];
// il bunker classico, 22 x 16, con l'arco sotto
const INV_BUNKER = [
  "....##############....",
  "...################...",
  "..##################..",
  ".####################.",
  ...Array(8).fill("######################"),
  "#######........#######",
  "######..........######",
  "#####............#####",
  "#####............#####",
];
// il dino sulla sua astronave (18 x 13): testa e collo sopra la cupola, il
// disco grigio con le luci, le fiamme sotto (due pose)
const INV_NAVE = [
  [
    "........#####.....",
    ".......##e####....",
    ".......########...",
    ".......####dddd...",
    "......#####.......",
    ".....######.......",
    "....oooooooooo....",
    "..oowwwwwwwwwwoo..",
    ".oggggggggggggggo.",
    "ogylgylgylgylgylgo",
    ".oggggggggggggggo.",
    "...oooooooooooo...",
    ".....aa....aa.....",
  ],
];
INV_NAVE.push(INV_NAVE[0].map((r, i) => (i === 12 ? ".....AA....AA....." : r))); // fiamme che pulsano
const INV_NAVE_COLORI = { "#": "#ff6a00", e: "#141414", d: "#8f3200", o: "#2a1a12", w: "#bfe9ff", g: "#c9c9ce", y: "#ffd23f", l: "#ff6a00", a: "#ffb066", A: "#ffd23f" };
// una vita in alto a destra: il dino sulla sua astronave in piccolo (11 x 7;
// prima era il solo disco grigio e si confondeva col disco del bonus)
const INV_VITA = ["......###..", ".....##e##.", ".....####..", "....####...", "..ooooooo..", ".ogylgylgo.", "..ooooooo.."];
// i simboli della parolaccia nel fumetto dell'alieno (5 x 7 come le lettere
// grandi, celle da 2: prima a 3 x 5 non si leggevano)
const INV_PAROLACCIA = {
  "#": [".#.#.", ".#.#.", "#####", ".#.#.", "#####", ".#.#.", ".#.#."],
  "@": [".###.", "#...#", "#.###", "#.#.#", "#.###", "#....", ".###."],
  $: ["..#..", ".####", "#.#..", ".###.", "..#.#", "####.", "..#.."],
  "%": ["##...", "##..#", "...#.", "..#..", ".#...", "#..##", "...##"],
  "&": [".##..", "#..#.", "#.#..", ".#...", "#.#.#", "#..#.", ".##.#"],
  "!": ["##", "##", "##", "##", "##", "..", "##"],
};
// la vena della rabbia accanto alla testa dell'alieno, da fumetto (celle da 2)
const INV_RABBIA = [".#.#.", "##.##", ".....", "##.##", ".#.#."];
const INV_ALIENO_SCALA = 4; // l'alieno sulla strada: il granchio a celle da 4

/** Generatore a caso con seme (mulberry32): livelli ripetibili nelle prove
 * (window.__dinoSeme). */
function invCaso(seme) {
  let a = seme >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function invNuovo(livello) {
  const seme = window.__dinoSeme || Math.floor(Math.random() * 1e9);
  const caso = invCaso(seme);
  const alieni = [];
  for (let r = 0; r < INV_RIGHE; r++) for (let c = 0; c < INV_COLONNE; c++) alieni.push({ r, c, vivo: true });
  const bunker = [0, 1, 2, 3].map((i) => {
    const x = Math.round((INV_W / 4) * i + INV_W / 8 - 11);
    const griglia = new Uint8Array(22 * 16);
    INV_BUNKER.forEach((riga, y) => [...riga].forEach((ch, xx) => (griglia[y * 22 + xx] = ch === "#" ? 1 : 0)));
    return { x: x - (x % 2), griglia, tela: null };
  });
  const stelle = [];
  for (let i = 0; i < 26; i++) stelle.push({ x: 2 * Math.floor((caso() * INV_W) / 2), y: 2 * Math.floor((caso() * 96) / 2) + 12, f: caso() * 6.28 });
  return {
    caso,
    liv: livello || 0,
    t: 0,
    resto: 0,
    alieni,
    fx: Math.round((INV_W - ((INV_COLONNE - 1) * INV_PASSO_X + 12)) / 2 / 2) * 2,
    fy: INV_CIMA,
    dir: 1,
    prossimoPasso: 600, // un attimo prima di partire
    ferma: 0, // ms di marcia ferma: l'alieno colpito che esplode (come nel cabinato)
    posa: 0,
    nota: 0,
    colpo: null,
    ricarica: 400,
    spari: 0, // colpi sparati: decidono il punteggio misterioso del disco
    bombe: [],
    prossimaBomba: 1200,
    turno: 0, // a chi tocca sparare fra spirale, pistone e zig zag
    disco: null,
    prossimoDisco: 9000 + caso() * 5000,
    ronzio: 0,
    bunker,
    terra: new Uint8Array(INV_W).fill(1), // la riga del terreno, bucata dai colpi
    telaTerra: null,
    x: INV_W / 2,
    vite: INV_VITE,
    esplode: 0, // ms: il dino colpito esplode e tutto si ferma
    invulnerabile: 0,
    scoppi: [],
    punti: 0,
    dito: null,
    tasti: {},
    fine: 0,
    esito: null,
    stelle,
  };
}

/** Dove sta un alieno (rettangolo in unità del campo). */
function invAlieno(g, a) {
  const w = INV_TIPI[a.r].pose[0][0].length;
  return { x: g.fx + a.c * INV_PASSO_X + Math.floor((12 - w) / 2), y: g.fy + a.r * INV_PASSO_Y, w, h: 8 };
}

/** Un colpo che arriva su un bunker ci lascia il morso con la forma della
 * sua esplosione (maschera centrata in px, py), come nel cabinato. */
function invSbriciola(g, px, py, maschera) {
  const mw = maschera[0].length;
  const mh = maschera.length;
  for (const b of g.bunker) {
    const lx = Math.round(px - b.x - mw / 2);
    const ly = Math.round(py - INV_BUNKER_Y - mh / 2);
    if (lx + mw <= 0 || lx >= 22 || ly + mh <= 0 || ly >= 16) continue;
    maschera.forEach((riga, my) =>
      [...riga].forEach((ch, mx) => {
        const x = lx + mx;
        const y = ly + my;
        if (ch !== "#" || x < 0 || x >= 22 || y < 0 || y >= 16 || !b.griglia[y * 22 + x]) return;
        b.griglia[y * 22 + x] = 0;
        if (b.tela) b.tela.getContext("2d").clearRect(x, y, 1, 1);
      }),
    );
  }
}
/** C'è bunker in quel punto? */
function invBunker(g, px, py) {
  for (const b of g.bunker) {
    const x = Math.floor(px - b.x);
    const y = Math.floor(py - INV_BUNKER_Y);
    if (x >= 0 && x < 22 && y >= 0 && y < 16 && b.griglia[y * 22 + x]) return true;
  }
  return false;
}

/** La marcia: un passo di 2 unità, sempre più svelta man mano che calano;
 * al bordo scende di 8 e torna indietro. Le quattro note, a giro. */
function invMarcia(g, vivi) {
  g.prossimoPasso = (40 + vivi.length * 7) * (g.liv ? 0.75 : 1);
  let minX = 1e9;
  let maxX = -1e9;
  vivi.forEach((a) => {
    const r = invAlieno(g, a);
    minX = Math.min(minX, r.x);
    maxX = Math.max(maxX, r.x + r.w);
  });
  if ((g.dir > 0 && maxX + 2 > INV_W - 2) || (g.dir < 0 && minX - 2 < 2)) {
    g.fy += 8;
    g.dir = -g.dir;
  } else g.fx += 2 * g.dir;
  g.posa ^= 1;
  g.nota = (g.nota + 1) % 4;
  dinoSuono(`inv_passo${g.nota + 1}`);
  // arrivati ai bunker: hanno vinto loro
  if (vivi.some((a) => invAlieno(g, a).y + 8 >= INV_BUNKER_Y)) {
    g.esito = "perso";
    g.fine = g.t + 400;
    dinoVibra("HEAVY");
  }
}

/** Il colpo del dino: sale di 4 a tick; alieno, disco, colpo alieno, bunker
 * o il cielo in cima (dove esplode, come nel cabinato). */
function invColpo(g, vivi) {
  const c = g.colpo;
  c.y -= INV_VEL_COLPO;
  let fatto = false;
  for (const a of vivi) {
    const r = invAlieno(g, a);
    if (c.x >= r.x && c.x < r.x + r.w && c.y < r.y + r.h && c.y + 4 > r.y) {
      a.vivo = false;
      g.punti += INV_TIPI[a.r].punti;
      g.scoppi.push({ x: r.x + r.w / 2, y: r.y + 4, t: g.t, dura: INV_SCOPPIO_DURA, colore: INV_TIPI[a.r].colore });
      g.ferma = INV_SCOPPIO_DURA; // la formazione aspetta che l'alieno finisca di esplodere
      dinoSuono("inv_scoppio");
      fatto = true;
      break;
    }
  }
  if (!fatto && g.disco && c.x >= g.disco.x && c.x < g.disco.x + 16 && c.y < 21) {
    const punti = INV_MISTERO[g.spari % INV_MISTERO.length];
    g.punti += punti;
    g.scoppi.push({ x: g.disco.x + 8, y: 17, t: g.t, dura: 1300, punti, disco: true });
    g.disco = null;
    dinoSuono("inv_disco_preso");
    dinoVibra("MEDIUM");
    fatto = true;
  }
  if (!fatto) {
    const i = g.bombe.findIndex((b) => Math.abs(b.x - c.x) <= 1 && b.y + 7 > c.y && b.y < c.y + 4);
    if (i >= 0) {
      g.scoppi.push({ x: c.x, y: c.y, t: g.t, dura: 220, botto: true, colore: "#f4f4f5" });
      g.bombe.splice(i, 1);
      fatto = true;
    }
  }
  if (!fatto && invBunker(g, c.x, c.y)) {
    invSbriciola(g, c.x, c.y, INV_FORO);
    g.scoppi.push({ x: c.x, y: c.y + 2, t: g.t, dura: 120, botto: true, colore: "#ffd23f" });
    fatto = true;
  }
  if (!fatto && c.y < 12) {
    g.scoppi.push({ x: c.x, y: 13, t: g.t, dura: 220, botto: true, colore: "#ff5f3a" });
    fatto = true;
  }
  if (fatto) {
    g.colpo = null;
    g.ricarica = INV_RICARICA;
  }
}

/** Un colpo alieno nuovo: tocca a spirale, pistone e zig zag a turno, uno
 * per tipo in volo. La spirale parte dalla colonna sopra il dino; il pistone
 * no se è rimasto un alieno solo, lo zig zag no col disco in volo (nel
 * cabinato usano lo stesso posto). */
function invSparaAlieni(g, vivi) {
  const tipo = INV_COLPI_ORDINE[g.turno++ % 3];
  if (g.bombe.some((b) => b.tipo === tipo)) return;
  if ((tipo === "pistone" && vivi.length < 2) || (tipo === "zigzag" && g.disco)) return;
  const fondo = {};
  vivi.forEach((a) => {
    if (!fondo[a.c] || fondo[a.c].r < a.r) fondo[a.c] = a;
  });
  const colonne = Object.values(fondo);
  const centro = (a) => {
    const r = invAlieno(g, a);
    return r.x + r.w / 2;
  };
  const chi = tipo === "spirale" ? colonne.reduce((m, a) => (Math.abs(centro(a) - g.x) < Math.abs(centro(m) - g.x) ? a : m)) : colonne[Math.floor(g.caso() * colonne.length)];
  const r = invAlieno(g, chi);
  g.bombe.push({ tipo, x: Math.round(r.x + r.w / 2), y: r.y + r.h, eta: 0 });
}

/** Un passo fisso da 1/60 s. */
function invTick(g) {
  const ms = INV_TICK;
  g.t += ms;
  if (g.fine) return;
  const vivi = g.alieni.filter((a) => a.vivo);
  // il dino colpito esplode: tutto fermo (la marcia, i colpi), come nel cabinato
  if (g.esplode > 0) {
    g.esplode -= ms;
    if (g.esplode <= 0) g.invulnerabile = INV_INVULNERABILE;
    g.scoppi = g.scoppi.filter((s) => g.t - s.t < s.dura);
    return;
  }
  g.ferma = Math.max(0, g.ferma - ms);
  if (!g.ferma) g.prossimoPasso -= ms;
  if (g.prossimoPasso <= 0 && vivi.length) {
    invMarcia(g, vivi);
    if (g.fine) return;
  }
  // il dino segue il dito (senza ritardo fino a INV_VEL_DITO) o le frecce
  if (g.dito) g.x += Math.max(-INV_VEL_DITO, Math.min(INV_VEL_DITO, g.dito.x - g.x));
  else g.x += ((g.tasti.destra ? 1 : 0) - (g.tasti.sinistra ? 1 : 0)) * INV_VEL_TASTI;
  g.x = Math.max(10, Math.min(INV_W - 10, g.x));
  g.invulnerabile = Math.max(0, g.invulnerabile - ms);
  // spara da solo: un colpo alla volta, come nell'originale
  g.ricarica -= ms;
  if (!g.colpo && g.ricarica <= 0) {
    g.colpo = { x: Math.round(g.x), y: INV_NAVE_Y - 2 };
    g.spari++;
    dinoSuono("inv_sparo");
  }
  if (g.colpo) invColpo(g, vivi);
  // i colpi degli alieni, sempre più fitti man mano che fai punti
  g.prossimaBomba -= ms;
  if (g.prossimaBomba <= 0 && vivi.length) {
    g.prossimaBomba = Math.max(INV_BOMBA_MIN, INV_BOMBA_OGNI - g.punti * 0.5) * (g.liv ? 0.8 : 1);
    invSparaAlieni(g, vivi);
  }
  // cadono (più svelti con 8 alieni o meno, come nel cabinato)
  const vb = (vivi.length <= 8 ? 1.25 : 1) * (g.liv ? 1.2 : 1);
  g.bombe = g.bombe.filter((b) => {
    b.y += vb;
    b.eta++;
    const punta = b.y + 7;
    if (invBunker(g, b.x, punta) || invBunker(g, b.x, punta - 1)) {
      invSbriciola(g, b.x, punta + 1, INV_SCHIZZO);
      g.scoppi.push({ x: b.x, y: punta, t: g.t, dura: 200, colore: "#f4f4f5" });
      return false;
    }
    if (punta >= INV_TERRA) {
      // il terreno si buca dove arriva
      for (let x = b.x - 2; x <= b.x + 2; x++) if (x >= 0 && x < INV_W && (Math.abs(x - b.x) < 2 || g.caso() < 0.5)) g.terra[x] = 0;
      g.terraCambiata = true;
      g.scoppi.push({ x: b.x, y: INV_TERRA - 4, t: g.t, dura: 200, colore: "#f4f4f5" });
      return false;
    }
    // il dino: la testa e l'astronave (un filo di margine a favore)
    if (g.invulnerabile <= 0 && Math.abs(b.x - g.x) <= 5 && punta >= INV_NAVE_Y && b.y <= INV_NAVE_Y + 8) {
      g.vite--;
      g.esplode = INV_ESPLODE;
      g.colpo = null;
      g.bombe = [];
      dinoSuono("inv_colpito");
      dinoVibra("HEAVY");
      if (g.vite <= 0) {
        g.esito = "perso";
        g.fine = g.t + INV_ESPLODE;
      }
      return false;
    }
    return true;
  });
  // il disco volante del bonus, ogni tanto lassù (solo con 8 alieni o più),
  // col suo ronzio finché vola
  g.prossimoDisco -= ms;
  if (!g.disco && g.prossimoDisco <= 0 && vivi.length >= 8) {
    const da = g.caso() < 0.5 ? -1 : 1;
    g.disco = { x: da > 0 ? -16 : INV_W, v: 0.8 * da };
    g.prossimoDisco = 12000 + g.caso() * 6000;
    g.ronzio = 0;
  }
  if (g.disco) {
    g.disco.x += g.disco.v;
    g.ronzio -= ms;
    if (g.ronzio <= 0) {
      g.ronzio = 180;
      dinoSuono("inv_disco");
    }
    if (g.disco.x < -18 || g.disco.x > INV_W + 2) g.disco = null;
  }
  g.scoppi = g.scoppi.filter((s) => g.t - s.t < s.dura);
  if (!g.alieni.some((a) => a.vivo)) {
    g.esito = "vinto";
    g.fine = g.t + 300;
  }
}

function invPasso(g, dt) {
  g.resto += dt;
  while (g.resto >= INV_TICK - INV_TOLLERA) {
    g.resto -= INV_TICK;
    invTick(g);
  }
  return g.fine && g.t >= g.fine ? g.esito : null;
}

/** Disegna una cosa a celle da 1 (tela in cache) in unità del campo. */
function invSprite(c, chiave, righe, colori, x, y, scala = 1) {
  c.drawImage(dinoTela(`inv|${chiave}`, righe, colori), Math.round(x), Math.round(y), righe[0].length * scala, righe.length * scala);
}

/** Il campo: cielo, stelle, bagliore del tramonto in fondo, il terreno. */
function invFondo(c, g, x0, y0) {
  const cielo = c.createLinearGradient(0, y0, 0, y0 + INV_H);
  cielo.addColorStop(0, "#0b0714");
  cielo.addColorStop(0.7, "#160b18");
  cielo.addColorStop(1, "#3a140a");
  c.fillStyle = cielo;
  c.fillRect(x0, y0, INV_W, INV_H);
  g.stelle.forEach((s) => {
    const v = Math.sin(g.t / 700 + s.f);
    c.fillStyle = `rgba(255, 236, 214, ${v > 0.5 ? 0.55 : 0.2})`;
    c.fillRect(x0 + s.x, y0 + s.y, 1, 1);
  });
  // il sole a righe del nostro tramonto, basso dietro i bunker
  dinoSole(c, x0 + INV_W / 2, y0 + INV_TERRA, 46, g.t);
  // il terreno: una tela a 1 px per unità, bucata dove arrivano i colpi
  if (!g.telaTerra || g.terraCambiata) {
    g.telaTerra = g.telaTerra || document.createElement("canvas");
    g.telaTerra.width = INV_W;
    g.telaTerra.height = 2;
    const tc = g.telaTerra.getContext("2d");
    tc.clearRect(0, 0, INV_W, 2);
    for (let x = 0; x < INV_W; x++) {
      if (!g.terra[x]) continue;
      tc.fillStyle = "#ff8a2a";
      tc.fillRect(x, 0, 1, 1);
      tc.fillStyle = "#a33d00";
      tc.fillRect(x, 1, 1, 1);
    }
    g.terraCambiata = false;
  }
  c.drawImage(g.telaTerra, x0, y0 + INV_TERRA);
  c.fillStyle = "rgba(255, 106, 0, 0.12)";
  c.fillRect(x0, y0 + INV_TERRA + 2, INV_W, INV_H - INV_TERRA - 2);
  // la cornice del campo, sottile
  c.fillStyle = "rgba(255, 106, 0, 0.35)";
  c.fillRect(x0, y0, INV_W, 1);
  c.fillRect(x0, y0, 1, INV_H);
  c.fillRect(x0 + INV_W - 1, y0, 1, INV_H);
}

function invDisegna(c, g, x0, y0, opz = {}) {
  invFondo(c, g, x0, y0);
  // in alto: i punti a sinistra, le vite a destra, il tempo al centro
  dinoScrittaDa(c, String(g.punti).padStart(4, "0"), x0 + 4, y0 + 2, "#ff9a3c", DINO_FONT_PICCOLO);
  for (let i = 0; i < g.vite; i++) invSprite(c, "vita", INV_VITA, INV_NAVE_COLORI, x0 + INV_W - 16 - i * 14, y0 + 3);
  const resta = Math.max(0, 1 - g.t / BOSS_TEMPO);
  for (let i = 0; i < 8; i++) {
    c.fillStyle = "rgba(255, 255, 255, 0.14)";
    c.fillRect(x0 + INV_W / 2 - 16 + i * 4, y0 + 4, 3, 3);
    if (resta * 8 > i) {
      c.fillStyle = resta < 0.25 && Math.floor(g.t / 140) % 2 ? "#ffffff" : "#7dff4a";
      c.fillRect(x0 + INV_W / 2 - 16 + i * 4, y0 + 4, 3, 3);
    }
  }
  // la formazione
  if (!opz.senzaAlieni) {
    c.save();
    c.globalAlpha = opz.alieniAlfa === undefined ? 1 : opz.alieniAlfa; // nella gag della sconfitta si fanno da parte
    g.alieni.forEach((a) => {
      if (!a.vivo) return;
      const r = invAlieno(g, a);
      const tipo = INV_TIPI[a.r];
      invSprite(c, `al${a.r}${g.posa}`, tipo.pose[g.posa], { "#": tipo.colore }, x0 + r.x, y0 + r.y);
    });
    c.restore();
  }
  if (g.disco) invSprite(c, "disco", INV_DISCO, { "#": "#ff3b3b" }, x0 + g.disco.x, y0 + 14);
  // i bunker: una tela a 1 px per unità ciascuno, sbriciolata a mano
  g.bunker.forEach((b) => {
    if (!b.tela) {
      b.tela = document.createElement("canvas");
      b.tela.width = 22;
      b.tela.height = 16;
      const bc = b.tela.getContext("2d");
      bc.fillStyle = "#ff6a00";
      for (let i = 0; i < b.griglia.length; i++) if (b.griglia[i]) bc.fillRect(i % 22, Math.floor(i / 22), 1, 1);
      bc.fillStyle = "#ffb066";
      for (let x = 0; x < 22; x++) {
        const y = INV_BUNKER.findIndex((r) => r[x] === "#");
        if (y >= 0 && b.griglia[y * 22 + x]) bc.fillRect(x, y, 1, 1); // luce sul bordo in alto
      }
    }
    c.drawImage(b.tela, x0 + b.x, y0 + INV_BUNKER_Y);
  });
  // i colpi alieni: spirale, pistone, zig zag, con le pose che girano (non
  // nella gag); il colpo del dino. Tele a 1 px per unità: niente righine
  if (!opz.gag) {
    g.bombe.forEach((b) => {
      const tipo = INV_COLPI[b.tipo] ? b.tipo : "pistone";
      const posa = Math.floor((b.eta || 0) / 5) % 4;
      invSprite(c, `colpo${tipo}${posa}`, INV_COLPI[tipo][posa], { "#": "#f4f4f5" }, x0 + b.x - 1, y0 + b.y);
    });
    if (g.colpo) invSprite(c, "sparo", ["#", "#", "#", "#"], { "#": "#ffd23f" }, x0 + g.colpo.x, y0 + g.colpo.y);
  }
  // il dino sulla sua astronave (lampeggia appena tornato), o in pezzi
  const pezzi = g.esplode > 0 || (g.vite <= 0 && g.fine);
  if (pezzi && !opz.senzaNave && !opz.gag) {
    const p = Math.floor(g.t / 110) % 2;
    invSprite(c, `rotta${p}`, INV_ROTTA[p], { ...INV_NAVE_COLORI, "#": p ? "#ffd23f" : "#ff6a00" }, x0 + g.x - 9, y0 + INV_NAVE_Y);
  } else if (!opz.senzaNave && g.vite > 0 && !(g.invulnerabile > 0 && Math.floor(g.t / 90) % 2)) {
    invSprite(c, `nave${Math.floor(g.t / 120) % 2}`, INV_NAVE[Math.floor(g.t / 120) % 2], INV_NAVE_COLORI, x0 + g.x - 9, y0 + INV_NAVE_Y - 4);
  }
  // gli scoppi: l'alieno colpito (nel suo colore), i botti dei colpi, il
  // punteggio misterioso al posto del disco
  if (!opz.senzaScoppi) {
    g.scoppi.forEach((s) => {
      if (s.punti) {
        if (g.t - s.t < 200) invSprite(c, "scoppiod", INV_SCOPPIO, { "#": "#ff3b3b" }, x0 + s.x - 6, y0 + s.y - 4);
        else dinoScritta(c, String(s.punti), x0 + s.x, y0 + s.y - 4, "#ff3b3b", DINO_FONT_PICCOLO);
        return;
      }
      const forma = s.botto ? INV_BOTTO : s.colore === "#f4f4f5" ? INV_SCHIZZO : INV_SCOPPIO;
      const chiave = s.botto ? "botto" : s.colore === "#f4f4f5" ? "schizzo" : "scoppio";
      invSprite(c, `${chiave}${s.colore || ""}`, forma, { "#": s.colore || "#ffd23f" }, x0 + s.x - Math.floor(forma[0].length / 2), y0 + s.y - 4);
    });
  }
}

// —— l'incontro degli invasori: il granchio grande sulla strada; dopo il
// titolo fa il fumetto con la parolaccia, scende l'astronave, il dino ci
// salta sopra e vola via in alto (da lì comincia il minigioco) ——
const INV_ASTRONAVE_DA = 900; // ms dell'incontro: l'astronave scende
const INV_SALTO_DA = 1250; // il dino salta sull'astronave
const INV_VOLO_DA = 1400; // e parte verso l'alto
function invAstronave(b) {
  // altezza da terra della pancia dell'astronave
  const t = b.fase === "incontro" ? b.t : BOSS_INCONTRO + b.t;
  if (t < INV_ASTRONAVE_DA) return null;
  if (t < INV_SALTO_DA) {
    const q = (t - INV_ASTRONAVE_DA) / (INV_SALTO_DA - INV_ASTRONAVE_DA);
    return 2 + 140 * (1 - q) * (1 - q);
  }
  if (t < INV_VOLO_DA) return 2;
  const q = (t - INV_VOLO_DA) / 600;
  return 2 + 320 * q * q;
}
function invIncontroPasso(b) {
  const t = b.t;
  if (t >= INV_ASTRONAVE_DA && !b.disco) {
    b.disco = true;
    dinoSuono("inv_ufo");
  }
  if (t >= INV_SALTO_DA && !b.saltato) {
    b.saltato = true;
    dinoSuono("salto");
  }
  // il dino sale sull'astronave e vola via con lei (dinoBossFine lo rimette a terra)
  if (t >= INV_SALTO_DA && t < INV_VOLO_DA) {
    const q = (t - INV_SALTO_DA) / (INV_VOLO_DA - INV_SALTO_DA);
    dino.y = 14 * q + 20 * Math.sin(Math.PI * q);
  } else if (t >= INV_VOLO_DA) dino.y = invAstronave(b) + 12;
}
function invStrada(c, b, terra, W) {
  const s = INV_ALIENO_SCALA;
  const pose = INV_GRANCHIO;
  const larga = pose[0][0].length * s;
  const x = dinoBossPosto(b, W, larga);
  const fermo = dinoMotoRidotto();
  // mentre impreca saltella arrabbiato e agita le zampe, svelto
  const impreca = b.fase === "incontro" && b.t > 250 && b.t < 1150;
  const posa = fermo ? 0 : Math.floor(b.t / (b.fase === "arrivo" ? 150 : impreca ? 90 : 300)) % 2;
  const su = fermo ? 0 : impreca ? -(Math.floor(b.t / 90) % 2) * 2 * DINO_CELLA : Math.round(Math.sin(b.t / 220) * 1) * DINO_CELLA;
  const alto = pose[0].length * s;
  c.fillStyle = "rgba(0, 0, 0, 0.35)";
  c.fillRect(x + 6, terra - 1, larga - 12, 2);
  c.imageSmoothingEnabled = false;
  c.drawImage(dinoTela(`inv|grande${posa}`, pose[posa], { "#": "#7dff4a" }), x, terra - alto - 8 + su, larga, alto);
  // l'astronave sotto il dino (sotto anche quando vola via con lui)
  const alt = invAstronave(b);
  if (alt !== null) {
    const nave = INV_NAVE[Math.floor(b.t / 120) % 2].slice(6);
    const nx = DINO_CELLA * Math.round((dinoX() + 14 - 18) / DINO_CELLA);
    c.drawImage(dinoTela(`inv|astronave${Math.floor(b.t / 120) % 2}`, nave, INV_NAVE_COLORI), nx, Math.round(terra - alt - nave.length * 2), 36, nave.length * 2);
  }
}
function invSopra(c, b, W) {
  const t = b.fase === "incontro" ? b.t : BOSS_INCONTRO + b.t;
  if (t < INV_SALTO_DA) dinoBossSpavento(c, b);
  // il fumetto con la parolaccia, sopra l'alieno (angoli smussati, punta
  // verso di lui, simboli che tremano a colori alterni)
  if (t > 250 && t < 1150) {
    const larga = INV_GRANCHIO[0][0].length * INV_ALIENO_SCALA;
    const posto = dinoBossPosto(b, W, larga);
    const testo = "#@$%&!";
    const lw = 4 + [...testo].reduce((n, ch) => n + INV_PAROLACCIA[ch][0].length * 2 + 2, 0);
    const x = DINO_CELLA * Math.round((posto + larga / 2 - lw / 2 - 6) / DINO_CELLA);
    const y = DINO_CELLA * Math.round((dinoTerra() - 8 * INV_ALIENO_SCALA - 8 - 36) / DINO_CELLA);
    c.fillStyle = "#141414";
    c.fillRect(x, y - 2, lw, 22);
    c.fillRect(x - 2, y, lw + 4, 18);
    c.fillRect(x + lw - 16, y + 20, 8, 2); // la punta verso l'alieno
    c.fillRect(x + lw - 12, y + 22, 4, 2);
    c.fillStyle = "#f4f4f5";
    c.fillRect(x, y, lw, 18);
    c.fillRect(x + lw - 14, y + 18, 4, 2);
    let cx = x + 4;
    [...testo].forEach((ch, i) => {
      const gl = INV_PAROLACCIA[ch];
      c.fillStyle = i % 2 ? "#ff3b3b" : "#141414";
      const tremo = !dinoMotoRidotto() && Math.floor(t / 90 + i) % 2 ? DINO_CELLA : 0;
      gl.forEach((riga, r) => [...riga].forEach((p, k) => p === "#" && c.fillRect(cx + k * 2, y + 2 + r * 2 - tremo, 2, 2)));
      cx += gl[0].length * 2 + 2;
    });
    // la vena della rabbia che pulsa accanto alla testa
    if (dinoMotoRidotto() || Math.floor(t / 180) % 2) {
      c.fillStyle = "#ff3b3b";
      const vx = posto + larga - 4;
      const vy = DINO_CELLA * Math.round((dinoTerra() - 8 * INV_ALIENO_SCALA - 14) / DINO_CELLA);
      INV_RABBIA.forEach((riga, r) => [...riga].forEach((p, k) => p === "#" && c.fillRect(vx + k * 2, vy + r * 2, 2, 2)));
    }
  }
}

// —— le gag dell'esito (k da 0 a 1 in BOSS_ESITO) ——
function invEsito(c, g, x0, y0, k, esito) {
  const vinto = esito === "vinto";
  invDisegna(c, g, x0, y0, { gag: true, senzaNave: true, senzaAlieni: esito === "pari" && k > 0.5, senzaScoppi: k > 0.25, alieniAlfa: vinto ? 1 : Math.max(0.25, 1 - k * 4) });
  // le scritte con l'ombra sotto: si leggono anche sopra alieni e stelle
  const scritta = (testo, y, colore) => {
    dinoScritta(c, testo, x0 + INV_W / 2, y + 2, "#141414");
    dinoScritta(c, testo, x0 + INV_W / 2, y, colore);
  };
  const cx = x0 + g.x;
  const madre = (alto) => invSprite(c, "madre", INV_DISCO, { "#": "#ff3b3b" }, x0 + INV_W / 2 - 32, y0 + alto, 4);
  if (vinto) {
    // il dino diventa Godzilla (lampo bianco), cresce, e col soffio atomico
    // tira giù l'astronave madre che era venuta a vendicarli
    const righe = dinoGodzillaRighe(0, k > 0.35);
    const sc = Math.min(1, 0.35 + k * 2);
    const gw = Math.round(GODZILLA_W * sc);
    const gh = Math.round(GODZILLA_H * sc);
    const gx = Math.round(cx - gw / 2);
    const gy = y0 + INV_TERRA - gh;
    if (k < 0.75) madre(Math.round(-30 + Math.min(1, k * 3) * 40));
    c.drawImage(dinoTela(`godz|0|${k > 0.35}|${k < 0.08 ? "b" : ""}`, righe, k < 0.08 ? Object.fromEntries(Object.keys(GODZILLA_COLORI).map((ch) => [ch, "#ffffff"])) : GODZILLA_COLORI), gx, gy, gw, gh);
    if (k > 0.38 && k < 0.75) {
      // il soffio: dalla bocca all'astronave, a quadretti che si sommano alla luce
      const bx = gx + gw * 0.85;
      const by = gy + gh * 0.12;
      const tx = x0 + INV_W / 2;
      const ty = y0 + 20;
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
    if (k >= 0.7) {
      // l'astronave madre esplode in mille pezzi
      const q = (k - 0.7) / 0.3;
      for (let i = 0; i < 28; i++) {
        const a = (i / 28) * 6.283;
        const r = 4 + q * (30 + (i % 5) * 6);
        c.fillStyle = i % 3 ? "#ff3b3b" : i % 2 ? "#ffd23f" : "#ffffff";
        c.fillRect(Math.round(x0 + INV_W / 2 + Math.cos(a) * r), Math.round(y0 + 24 + Math.sin(a) * r * 0.6), 2, 2);
      }
      if (k > 0.8) scritta("Spazzati via!", y0 + 60, "#7dff4a");
    }
  } else if (esito === "perso") {
    // l'astronave madre scende, il raggio traente agguanta il dino e lo
    // scaglia lontanissimo: una stellina in alto a destra
    const alto = Math.round(-30 + Math.min(1, k / 0.25) * 40);
    madre(alto);
    let nx = cx;
    let ny = y0 + INV_NAVE_Y - 4;
    let sc = 1;
    if (k > 0.25 && k < 0.6) {
      const q = (k - 0.25) / 0.35;
      // il raggio traente: righe da 2 unità, bande più chiare che salgono
      const cima = y0 + DINO_CELLA * Math.round((alto + 28) / DINO_CELLA);
      const sale = DINO_CELLA * Math.floor((k * BOSS_ESITO) / 40);
      for (let y = cima; y < ny + 10; y += 2) {
        const w = 10 + ((y - cima) / (ny - cima + 10)) * 30;
        c.fillStyle = (y - cima + sale) % 12 < 4 ? "rgba(214, 255, 120, 0.5)" : "rgba(255, 210, 63, 0.26)";
        c.fillRect(DINO_CELLA * Math.round((x0 + INV_W / 2 - w / 2 + (cx - x0 - INV_W / 2) * ((y - y0) / INV_H)) / DINO_CELLA), y, DINO_CELLA * Math.round(w / DINO_CELLA), 2);
      }
      nx = cx + (x0 + INV_W / 2 - cx) * q * 0.6;
      ny = ny - q * 50;
    } else if (k >= 0.6) {
      const q = Math.min(1, (k - 0.6) / 0.25);
      nx = x0 + INV_W / 2 + q * (INV_W / 2 - 6);
      ny = y0 + INV_NAVE_Y - 54 - q * 70;
      sc = Math.max(0.15, 1 - q);
    }
    if (k < 0.85) {
      c.save();
      c.translate(Math.round(nx), Math.round(ny));
      c.rotate(k > 0.6 ? (k - 0.6) * 30 : 0);
      c.drawImage(dinoTela("inv|nave0", INV_NAVE[0], INV_NAVE_COLORI), -9 * sc, -6 * sc, 18 * sc, 13 * sc);
      c.restore();
    } else {
      // la stellina dove è sparito («ding»)
      const q = (k - 0.85) / 0.15;
      const r = q < 0.5 ? 1 + q * 6 : 4 - (q - 0.5) * 6;
      c.fillStyle = "#ffffff";
      c.fillRect(x0 + INV_W - 8 - r, y0 + 8, r * 2 + 1, 1);
      c.fillRect(x0 + INV_W - 8, y0 + 8 - r, 1, r * 2 + 1);
    }
    if (k > 0.4) scritta("Rapito!", y0 + 84, "#ff5fd2");
  } else {
    // tempo scaduto: gli alieni se ne vanno e il dino resta lì
    invSprite(c, "nave0", INV_NAVE[0], INV_NAVE_COLORI, cx - 9, y0 + INV_NAVE_Y - 4);
    scritta("Tempo!", y0 + 60, "#ffd23f");
  }
}

const BOSS_INVASORI = {
  titolo: "Invasione!",
  sotto: "Difendi la Terra",
  colore: "#7dff4a",
  aiuto: "Trascina. Spara da solo",
  nuovo: invNuovo,
  misura: () => ({ w: INV_W, h: INV_H }),
  passo: invPasso,
  disegna: (c, g, x0, y0) => invDisegna(c, g, x0, y0),
  dito: (g, ev) => {
    if (ev.tipo === "su") {
      if (!g.dito || g.dito.id === ev.id) g.dito = null;
      return;
    }
    if (ev.tipo === "giu" || (g.dito && g.dito.id === ev.id)) g.dito = { id: ev.id, x: Math.max(0, Math.min(INV_W, ev.x)) };
    if (ev.tipo === "giu") g.ricarica = 0; // il tocco spara subito (poi spara da solo)
  },
  tasto: (g, ev) => {
    if (ev.tasto === "sinistra" || ev.tasto === "destra") g.tasti[ev.tasto] = ev.giu;
    // frecce per muoversi; spazio (o invio, o su) spara subito
    if (ev.giu && (ev.tasto === "azione" || ev.tasto === "su")) g.ricarica = 0;
  },
  esito: invEsito,
  strada: invStrada,
  sopra: invSopra,
  incontroPasso: invIncontroPasso,
};

// il titolo del cartellone all'incontro (mai i nomi dei giochi originali; il
// DINO_FONT grande non ha J né Q fino alla v415)
const BOSS_GIOCHI = {
  invasori: BOSS_INVASORI,
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
  inv_disco: (tono) => {
    tono(1180, 1560, 0, 0.09, 0.22);
    tono(1560, 1180, 0.09, 0.09, 0.22);
  },
  inv_disco_preso: (tono) => [1568, 1319, 1047, 880, 1568].forEach((f, i) => tono(f, f * 0.94, i * 0.06, 0.055, 0.45)),
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
    // la scena del boss vero (l'astronave degli invasori...), solo dal dt
    if (gioco.incontroPasso) dinoBossProva(b, () => gioco.incontroPasso(b, dt));
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
  dino.y = 0; // l'incontro può averlo portato via (l'astronave degli invasori)
  dino.vy = 0;
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
function dinoBossPosto(b, W, larga = BOSS_SAGOMA[0].length * BOSS_SAGOMA_SCALA) {
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
  const gioco = BOSS_GIOCHI[b.tipo];
  if (gioco.strada) {
    dinoBossProva(b, () => gioco.strada(c, b, terra, W));
    return;
  }
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
    const gioco = BOSS_GIOCHI[b.tipo];
    if (gioco.sopra) dinoBossProva(b, () => gioco.sopra(c, b, W));
    else dinoBossSpavento(c, b);
    const k = b.fase === "incontro" ? b.t - BOSS_TITOLO_DA : BOSS_INCONTRO - BOSS_TITOLO_DA + b.t;
    if (k >= 0 && k < ANNUNCIO_DURA) {
      const g = BOSS_GIOCHI[b.tipo];
      dinoCartellone(c, W, { testo: g.titolo, sotto: g.sotto, colore: g.colore }, dinoMotoRidotto() ? Math.max(k, 400) : k);
    }
  }
  dinoBossVelo(c, W, H);
}

/** La tendina «da battaglia» (fase 3): tre lampi bianchi a scatti, poi la
 * scena si chiude in una spirale di quadrettoni neri dal bordo verso il
 * centro; dall'altra parte si riapre al contrario, dal centro verso fuori.
 * Quadrettoni da 8 unità a coordinate pari: pixel netti. Con «riduci
 * movimento» nero pieno per tutta la (breve) durata, senza lampi. */
const BOSS_LAMPI = 160; // ms di lampi prima della spirale
let _dinoBossSpirale = null; // { w, h, ordine } l'ordine dei quadrettoni, rifatto al cambio di misura
function dinoBossSpirale(nx, ny) {
  const s = _dinoBossSpirale;
  if (s && s.nx === nx && s.ny === ny) return s.ordine;
  // giro a spirale dal bordo: alto, destra, basso, sinistra, sempre più dentro
  const ordine = new Array(nx * ny);
  let x0 = 0;
  let y0 = 0;
  let x1 = nx - 1;
  let y1 = ny - 1;
  let n = 0;
  while (x0 <= x1 && y0 <= y1) {
    for (let x = x0; x <= x1; x++) ordine[y0 * nx + x] = n++;
    for (let y = y0 + 1; y <= y1; y++) ordine[y * nx + x1] = n++;
    if (y0 < y1) for (let x = x1 - 1; x >= x0; x--) ordine[y1 * nx + x] = n++;
    if (x0 < x1) for (let y = y1 - 1; y > y0; y--) ordine[y * nx + x0] = n++;
    x0++;
    y0++;
    x1--;
    y1--;
  }
  _dinoBossSpirale = { nx, ny, ordine, tot: n };
  return ordine;
}
function dinoBossVelo(c, W, H) {
  const b = dino.boss;
  if (b.fase !== "entra" && b.fase !== "esce") return;
  const dura = dinoBossTendina();
  const meta = dura / 2;
  c.fillStyle = "#000000";
  if (dinoMotoRidotto()) {
    c.fillRect(0, 0, W, H);
    return;
  }
  // in entrata: lampi, poi chiude; in uscita: apre e basta
  const chiude = b.t < meta;
  if (b.fase === "entra" && b.t < BOSS_LAMPI) {
    if (Math.floor(b.t / 40) % 2 === 0) {
      c.fillStyle = "rgba(255, 255, 255, 0.85)";
      c.fillRect(0, 0, W, H);
    }
    return;
  }
  const da = b.fase === "entra" ? BOSS_LAMPI : 0;
  const k = chiude ? (b.t - da) / (meta - da) : 1 - (b.t - meta) / meta; // quanto è chiuso, 0-1
  if (k <= 0) return;
  const q = 8; // lato dei quadrettoni, in unità
  const nx = Math.ceil(W / q);
  const ny = Math.ceil(H / q);
  const ordine = dinoBossSpirale(nx, ny);
  const tot = _dinoBossSpirale.tot;
  // chiude dal bordo verso il centro; riapre dal centro verso il bordo
  const soglia = k * tot;
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      const o = ordine[y * nx + x];
      // gli ultimi a chiudersi (al centro) sono i primi a riaprirsi
      if (o < soglia) c.fillRect(x * q, y * q, q, q);
    }
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
