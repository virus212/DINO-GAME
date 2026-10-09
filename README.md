# Dino game — gioco offline di Crackify

Il gioco del dinosauro della modalità **Offline mode** dell'app Crackify (iPhone via Capacitor, e Home desktop del web).
Italiano ovunque (UI, commenti, messaggi). Pixel art arancio su cielo al tramonto, stile cabinato.

> **Attenzione:** il gioco NON è un progetto a sé: vive dentro il frontend di Crackify. `static/` contiene i tre file veri
> dell'app (versione `app.js?v=420`, `style.css?v=396`, più `boss.js?v=8`, `boss-scimmione.js?v=6`, `boss-labirinto.js?v=6`). Il codice del gioco è un blocco in `app.js`
> (cerca `DINO_RECORD_KEY` fino a `(function collegaDino()`), più CSS `.dino-*` / `.offline-*` in `style.css`
> e il markup `#offlineCabinato`, `#dinoMenu`, `#dinoSchermo`, `#homeDinoSlot` in `index.html`.
> Non c'è un build: JS vanilla, nessuna dipendenza.

## Struttura
- `static/index.html`, `static/style.css`, `static/app.js` — frontend completo (il gioco è una parte)
- `ios-native/NativeAudioPlugin.swift` — suoni 8 bit nativi (`SuoniGioco.crea`: buffer sintetizzati)
- `ios-native/OrientamentoPlugin.swift` — gira lo schermo in orizzontale per lo schermo intero
- `tools/percorso/` — simulatore Node del piazzamento oggetti/ostacoli (programmazione dinamica su tutti i salti possibili),
  e `sim-labirinto.mjs`: un giocatore automatico sul labirinto vero, per tarare `LAB_PUNTINI` (`node tools/percorso/sim-labirinto.mjs partite=200`)
- `tools/prove/` — prove Playwright del boss (offline finto, nessun login né rete): motore (`boss-giro`, `boss-schermo`, `boss-regressione`,
  `boss-casi`, `boss-home`, `boss-incontro`), i tre minigiochi (`boss-invasori`, `boss-scimmione`, `boss-labirinto`, anche `orizzontale`),
  `boss-leggenda`, `boss-debug`. Uso: `PW_DIR=~/crackify-redesign/node_modules BROWSER=webkit node tools/prove/boss-scimmione.mjs <cartella-foto> [orizzontale]`.
  Escono con codice 0 se tutto passa e zero errori in console.

## Come si prova
Il gioco parte dentro `enterOfflineMode()` (app.js) oppure, da desktop online, in fondo alla Home (`dinoSistema()`).
Nel browser si può forzare: `window.isNativeShell = () => true; enterOfflineMode('scelta')` dalla console, con un finto
`Capacitor.Plugins.Filesystem` (`readdir/deleteFile/stat/getUri/addListener`). Stato di gioco: `window.__dino`.

## Concetti chiave
- **Unità del mondo:** `DINO_SCALA = 7/6` (cella da 2 unità = 7 px su schermo 3x); `terra = dino.h - 26`.
  Sprite da 1 unità si disegnano via `dinoTela()` (tela offscreen 1px/cella, cache) + `drawImage` senza smoothing (niente righine).
- **Fisica:** quella del T-Rex di Chrome (`DINO_G`, `dinoSpinta`, velocità 6→13, passi da 1 fotogramma).
- **Modalità** (`DINO_MODI`): `normale`, `crazy` (~3x oggetti/cattivi), `classico` (solo mixer/cristalli/fantasmini). Record separati
  in localStorage (`crackify_dino_record2`, `_crazy`, `_classico`); scelta in `crackify_dino_modo`.
- **Bonus** (`OGGETTI`): `scaglia`=Godzilla (carica-e-spara il soffio atomico), `stella`, `cuffie`=Scudo blu, `basso`=Boombox (bass drop), `pozione`=Mini.
  Cartellone arcade al posto del titolo + timer a 8 tacche sopra la testa (`dinoCartellone`, `dinoTimerPotere`).
- **Cattivi** (`DINO_TIPI`): mixer piccoli, **cristalli arancioni** (i "grandi", `dinoCristalli`), fantasmini (alti non scavalcabili), mina, mina col paracadute,
  icona di Windows (non uccide: apre finestre d'errore che rinascono).
- **Piazzamento degli oggetti** (`dinoNuovoOggetto`, `dino.coda`): tratto libero `OGGETTO_PRIMA`=650 ms / `OGGETTO_DOPO`=800 ms, schemi RADURA e SOPRA.
  Verificato col simulatore: 0 bonus impossibili, finestra comoda 400-530 ms. Se tocchi spawn o distacchi, rilancia `node tools/percorso/run.mjs misto`. Col boss: `run.mjs misto boss`.
- **Schermo intero:** il banner si sposta in `#dinoSchermo`, zoom k/7, a tutto schermo, `dinoX() = 22 + dino.margine` (isola).
- **Impostazioni:** `#dinoMenu`, in orizzontale a schede Modalità/Leggenda.
- **Desktop:** `dinoInHome()`, titolo CRACKIFY, dopo il primo via lo spazio va al gioco (`dinoSpazio`) e non mette in pausa la musica.

## Boss (minigiochi pronti, `BOSS_ACCESO` ancora spento)
Ogni tanto il dino incontra un boss e il banner diventa per 30-60 s un minigioco tributo a un cabinato classico:
lo scimmione coi barili, il labirinto coi fantasmi, gli invasori. Il protagonista è sempre il dino; l'ambiente è il nostro.
Il motore e gli invasori vivono in **`static/boss.js`** (commento BOSS in cima, costanti `BOSS_*`); scimmione e labirinto in
`static/boss-scimmione.js` e `static/boss-labirinto.js`, che si registrano in `BOSS_GIOCHI`. Tutti caricati da `index.html` **prima** di `app.js`
nello stesso scope globale: al caricamento solo letterali e funzioni. In `app.js` restano solo gli agganci (cerca `dinoBoss` e `dino.boss`).

- **Quando:** `DINO_MODI[modo].boss = { primo, ogni }`: Normale 1000/1000, Crazy 800/800, Default dino mai (decisioni di Vitto, 08/10).
  Soglia controllata «a livello» (`dino.punti >= dino.prossimoBoss`), quindi anche i +10 e le combo la scavalcano. La soglia dopo
  si conta da quella raggiunta e si sposta del premio. Ordine `BOSS_ORDINE`, poi il giro ricomincia un livello più su.
  `BOSS_ACCESO = false` finché Vitto non approva la demo: oggi il boss parte dalla console o dal pannello Debug.
- **Stato:** `dino.stato` resta `"corsa"` (pausa, background, menu e schermo intero funzionano da soli). Il boss è `dino.boss`:
  `{ fase, tipo, livello, t, corsa0, velocita, esito, gioco, dita, sordi, tasti, prima }`. `t` va avanti solo col dt dei passi.
- **Fasi:**
  1. `attesa`: niente bonus né virus nuovi, finché non finiscono poteri, oggetto in volo, drop, finestre, cartellone e grazia.
  2. `sgombro`: non parte più niente; gli ultimi ostacoli si saltano.
  3. `arrivo`: la corsa frena, entra il boss.
  4. `incontro`: la scena col titolo.
  5. `entra`: la tendina a nero (lampi e spirale di quadrettoni).
  6. `gioco`: il minigioco, massimo `BOSS_TEMPO`, poi «pari».
  7. `esce`: la tendina al contrario, si torna sulla strada.
  8. `esito`: la gag **sulla strada**, come l'incontro (Vitto 09/10), per `BOSS_ESITO` ms, col risultato a cartellone; poi `dinoBossFine`.
     Di serie (`dinoBossGagDiSerie`): vinto = il dino diventa Godzilla e col soffio fa esplodere il boss; perso = il boss carica e scaglia via
     il dino; pari = il boss se ne va. Ogni boss può darne una sua (`gag`, gli invasori: l'astronave madre col raggio) o solo il suo
     ritratto (`ritratto`: lo scimmione, il fantasma rosso del labirinto).
- **Innesti nel gioco:**
  - `dinoAvanza`: `dinoPasso` gira solo finché la corsa gira, poi `dinoBossPasso`.
  - Il cancello dello spawn in `dinoPasso`, più `dinoNuovoOggetto` e il ramo virus di `dinoNuovoOstacolo`.
  - `dinoDisegna`: con `dinoBossCopre` disegna solo il minigioco; altrimenti `dinoBossStrada` e `dinoBossSopra`.
  - `dinoTocca`: col boss arrivato non salta.
  - `dinoDisegna`: durante la gag il dino lo disegna la gag (`dinoBossNascondeDino`).
  - `collegaDino`: dita con coordinate e id, `pointermove`, frecce, rilasci anche in pausa (senza coordinate), `blur`.
    Un dito giù durante la tendina o i primi `BOSS_SORDO` ms, o rimasto giù dalla pausa, conta dal primo movimento (`b.sordi`).
  - `dinoDom`: la classe `.boss` nasconde OFFLINE MODE.
  - `dinoNuovaPartita` e `dinoPrepara` azzerano il boss.
  - `visibilitychange` hidden mette in pausa: vale anche per la corsa normale, che prima ripartiva da sola. Quella pausa resta protetta dal rientro online
    (che ricarica l'app) per `DINO_PAUSA_TUTELA`, 5 minuti.
- **Ritorno:** velocità di prima, `prossimoOggetto`/`prossimoErrore` spostati avanti, `dino.coda` segnaposto di `BOSS_RIPRESA` ms
  (stesso meccanismo di sempre: il simulatore resta valido), grazia `BOSS_GRAZIA`. Conseguenze in costanti, da decidere:
  vittoria `BOSS_PREMIO` (300) + `BOSS_REGALO` (Stella); sconfitta `BOSS_SCONFITTA = "muori"` (game over, scelto da Vitto) oppure `"riprendi"`.
- **Minigiochi** (`BOSS_GIOCHI[tipo]`; `BOSS_SEGNAPOSTO` resta per le prove del motore: tocco a destra vince, a sinistra perde):
  `{ titolo, sotto, colore, aiuto, nuovo(livello), misura(g), passo(g, dt), disegna(c, g, x0, y0), dito(g, ev), tasto(g, ev),`
  `strada, sopra, incontroPasso, larga, ritratto, gag, gagPasso }` (le ultime per l'incontro e la gag sulla strada).
  - **Invasori** 8×4, 2 vite: trascina, si spara da soli.
  - **Scimmione** 4 travi, 2 vite: levetta da cabinato in basso a sinistra (destra e sinistra camminano, su e giù prendono la scala vicina)
    e pulsante del salto in basso a destra (Vitto 09/10). Due dita insieme = salto in corsa; con un dito solo il pulsante toccato entro
    `SC_SALTO_MEMORIA` ms dalla levetta salta nel verso in cui camminava. La levetta parte da dove appoggi il pollice (`SC_LEV_AGGANCIO`),
    zona morta `SC_LEV_MORTA`. Camminata `SC_PASSO` 0,8.
  - **Labirinto** 1 vita: si vince solo mangiando `LAB_PUNTINI` (150 su 244) entro `BOSS_TEMPO`, se no «pari» (09/10: la vittoria
    resistendo 40 s è tolta, da confermare con Vitto). Dal secondo giro i fantasmi vanno veloci quanto il dino (`LAB_FANT_VEL`).
  - Coordinate in unità del campo, che `dinoBossCampo` centra a ogni fotogramma (a schermo intero fra isola e bordo destro).
  - Il banner è circa 310×162 unità in verticale, 365×168 a schermo intero e fino a ~900×162 in Home.
  - Il dito arriva come `{ tipo: "giu" | "muovi" | "su", x, y, id }`. Il tasto arriva come `{ tasto: "sinistra" | "destra" | "su" | "giu" | "azione", giu }`.
  - Vincoli: campo al massimo ~272×150 unità con misure pari (iPhone da 375 pt: banner largo 295); a schermo intero l'angolo in alto a destra è della ×.
    Un errore nel minigioco chiude il boss «pari» (`dinoBossProva`) invece di bloccare il ciclo.
    Fisica propria a tick fisso 1000/60 (non quella del dino). Lo stato che cambia va su una tela propria (la cache di `dinoTela` si svuota oltre 160 chiavi).
    Con la musica accesa il gioco tace: ogni segnale deve essere anche visivo.
- **Simulatore:** `node tools/percorso/run.mjs misto boss` aggiunge un boss ogni 20 s, col primo spawn dopo il ritorno forzato a oggetto. Risultato: 0 impossibili.
- **Debug:**
  - `window.__dinoBoss()` o `window.__dinoBoss("invasori")` chiama subito un boss (anche col boss spento).
  - Con `BOSS_ACCESO` attivo basta `window.__dino.punti = 990`.
  - Il pannello Debug (cerca `DEBUG boss` in `app.js`) fa partire boss, esiti e trucchi dal telefono: **da togliere** prima dell'accensione.

## Deploy attuale (non riproducibile da qui)
Due copie di `static/`: il Mac mini (web, via scp) e quella per la build iOS (`ios-app/.../public`, poi `xcodebuild` + `devicectl install`).
Il backend FastAPI di Crackify NON è in questo repo; il gioco offline non lo usa (solo `Filesystem` di Capacitor per le playlist scaricate).

## Da fare / idee
- Rivedere: Stella, Mini, mina col paracadute, soffio di Godzilla, Boombox, virus Windows sul telefono vero
- Spegnere `DINO_DIAG` (log dei bip) a suoni approvati
- `haptic()` generico in app.js passa stili minuscoli → vibra sempre forte (il gioco usa `dinoVibra`, maiuscoli)
- Test Playwright (webkit) esistevano in un altro workspace con credenziali: non inclusi (quelli del boss sì, in `tools/prove/`, senza credenziali)
