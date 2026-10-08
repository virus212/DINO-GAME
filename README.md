# Dino game — gioco offline di Crackify

Il gioco del dinosauro della modalità **Offline mode** dell'app Crackify (iPhone via Capacitor, e Home desktop del web).
Italiano ovunque (UI, commenti, messaggi). Pixel art arancio su cielo al tramonto, stile cabinato.

> **Attenzione:** il gioco NON è un progetto a sé: vive dentro il frontend di Crackify. `static/` contiene i tre file veri
> dell'app (versione `app.js?v=409`, `style.css?v=394`). Il codice del gioco è un blocco in `app.js`
> (cerca `DINO_RECORD_KEY` fino a `(function collegaDino()`), più CSS `.dino-*` / `.offline-*` in `style.css`
> e il markup `#offlineCabinato`, `#dinoMenu`, `#dinoSchermo`, `#homeDinoSlot` in `index.html`.
> Non c'è un build: JS vanilla, nessuna dipendenza.

## Struttura
- `static/index.html`, `static/style.css`, `static/app.js` — frontend completo (il gioco è una parte)
- `ios-native/NativeAudioPlugin.swift` — suoni 8 bit nativi (`SuoniGioco.crea`: buffer sintetizzati)
- `ios-native/OrientamentoPlugin.swift` — gira lo schermo in orizzontale per lo schermo intero
- `tools/percorso/` — simulatore Node del piazzamento oggetti/ostacoli (programmazione dinamica su tutti i salti possibili)

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
  Verificato col simulatore: 0 bonus impossibili, finestra comoda 400-530 ms. Se tocchi spawn o distacchi, rilancia `node tools/percorso/run.mjs misto`.
- **Schermo intero:** il banner si sposta in `#dinoSchermo`, zoom k/7, a tutto schermo, `dinoX() = 22 + dino.margine` (isola).
- **Impostazioni:** `#dinoMenu`, in orizzontale a schede Modalità/Leggenda.
- **Desktop:** `dinoInHome()`, titolo CRACKIFY, dopo il primo via lo spazio va al gioco (`dinoSpazio`) e non mette in pausa la musica.

## Boss (in lavorazione: fase 1, architettura)
Ogni tanto il dino incontra un boss e il banner diventa per 30-60 s un minigioco tributo a un cabinato classico:
lo scimmione coi barili, il labirinto coi fantasmi, gli invasori. Il protagonista è sempre il dino; l'ambiente è il nostro.
Tutto è documentato nel commento **BOSS** in cima al blocco del gioco (subito dopo `DINO_RECORD_KEY`), con le costanti `BOSS_*`.
Il motore sta prima di `dinoDisegna` (cerca `—— BOSS: il motore`).

- **Quando:** `DINO_MODI[modo].boss = { primo, ogni }`: Normale 1000/1000, Crazy 700/700, Default dino mai.
  Soglia controllata «a livello» (`dino.punti >= dino.prossimoBoss`), quindi anche i +10 e le combo la scavalcano. La soglia dopo
  si conta da quella raggiunta. Ordine `BOSS_ORDINE`, poi il giro ricomincia un livello più su.
  `BOSS_ACCESO = false` finché i minigiochi non sono pronti: oggi il boss parte solo dalla console.
- **Stato:** `dino.stato` resta `"corsa"` (pausa, background, menu e schermo intero funzionano da soli). Il boss è `dino.boss`:
  `{ fase, tipo, livello, t, corsa0, velocita, esito, gioco, dita, tasti, prima }`. `t` va avanti solo col dt dei passi.
- **Fasi:**
  1. `attesa`: niente bonus né virus nuovi, finché non finiscono poteri, oggetto in volo, drop, finestre, cartellone e grazia.
  2. `sgombro`: non parte più niente; gli ultimi ostacoli si saltano.
  3. `arrivo`: la corsa frena, entra il boss.
  4. `incontro`: la scena col titolo.
  5. `entra`: la tendina a nero.
  6. `gioco`: il minigioco, massimo `BOSS_TEMPO`, poi «pari».
  7. `esito`: la gag.
  8. `esce`: la tendina al contrario, poi `dinoBossFine`.
- **Innesti nel gioco:**
  - `dinoAvanza`: `dinoPasso` gira solo finché la corsa gira, poi `dinoBossPasso`.
  - Il cancello dello spawn in `dinoPasso`, più `dinoNuovoOggetto` e il ramo virus di `dinoNuovoOstacolo`.
  - `dinoDisegna`: con `dinoBossCopre` disegna solo il minigioco; altrimenti `dinoBossStrada` e `dinoBossSopra`.
  - `dinoTocca`: col boss arrivato non salta.
  - `collegaDino`: dita con coordinate e id, `pointermove`, frecce, rilasci anche in pausa, `blur`.
  - `dinoDom`: la classe `.boss` nasconde OFFLINE MODE.
  - `dinoNuovaPartita` e `dinoPrepara` azzerano il boss.
  - `visibilitychange` hidden mette in pausa.
- **Ritorno:** velocità di prima, `prossimoOggetto`/`prossimoErrore` spostati avanti, `dino.coda` segnaposto di `BOSS_RIPRESA` ms
  (stesso meccanismo di sempre: il simulatore resta valido), grazia `BOSS_GRAZIA`. Conseguenze in costanti, da decidere:
  vittoria `BOSS_PREMIO` + `BOSS_REGALO`; sconfitta `BOSS_SCONFITTA = "riprendi"` (meno `BOSS_PENALITA`) oppure `"muori"`.
- **Minigiochi** (`BOSS_GIOCHI[tipo]`, oggi tutti e tre il segnaposto: tocco a destra vince, a sinistra perde):
  `{ titolo, sotto, colore, aiuto, nuovo(livello), misura(g), passo(g, dt), disegna(c, g, x0, y0), dito(g, ev), tasto(g, ev), esito(c, g, x0, y0, k, esito) }`.
  - Coordinate in unità del campo, che `dinoBossCampo` centra a ogni fotogramma (a schermo intero fra isola e bordo destro).
  - Il banner è circa 310×162 unità in verticale, 365×168 a schermo intero e fino a ~900×162 in Home.
  - Il dito arriva come `{ tipo: "giu" | "muovi" | "su", x, y, id }`. Il tasto arriva come `{ tasto: "sinistra" | "destra" | "su" | "giu" | "azione", giu }`.
- **Debug:**
  - `window.__dinoBoss()` o `window.__dinoBoss("invasori")` chiama subito un boss (anche col boss spento).
  - Con `BOSS_ACCESO` attivo basta `window.__dino.punti = 990`.

## Deploy attuale (non riproducibile da qui)
Due copie di `static/`: il Mac mini (web, via scp) e quella per la build iOS (`ios-app/.../public`, poi `xcodebuild` + `devicectl install`).
Il backend FastAPI di Crackify NON è in questo repo; il gioco offline non lo usa (solo `Filesystem` di Capacitor per le playlist scaricate).

## Da fare / idee
- Rivedere: Stella, Mini, mina col paracadute, soffio di Godzilla, Boombox, virus Windows sul telefono vero
- Spegnere `DINO_DIAG` (log dei bip) a suoni approvati
- `haptic()` generico in app.js passa stili minuscoli → vibra sempre forte (il gioco usa `dinoVibra`, maiuscoli)
- Test Playwright (webkit) esistevano in un altro workspace con credenziali: non inclusi
