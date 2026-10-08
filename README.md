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

## Deploy attuale (non riproducibile da qui)
Due copie di `static/`: il Mac mini (web, via scp) e quella per la build iOS (`ios-app/.../public`, poi `xcodebuild` + `devicectl install`).
Il backend FastAPI di Crackify NON è in questo repo; il gioco offline non lo usa (solo `Filesystem` di Capacitor per le playlist scaricate).

## Da fare / idee
- Rivedere: Stella, Mini, mina col paracadute, soffio di Godzilla, Boombox, virus Windows sul telefono vero
- Spegnere `DINO_DIAG` (log dei bip) a suoni approvati
- `haptic()` generico in app.js passa stili minuscoli → vibra sempre forte (il gioco usa `dinoVibra`, maiuscoli)
- Test Playwright (webkit) esistevano in un altro workspace con credenziali: non inclusi
