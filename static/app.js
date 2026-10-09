const $ = (s) => document.querySelector(s);

// ═══════════════════════════════════════════════════════════
// API_BASE — dentro un guscio nativo (Capacitor) il WebView non ha più
// lo stesso origin del Mac: le richieste devono puntare a un indirizzo
// assoluto (es. hostname Tailscale) invece che relativo. Nel browser/PWA
// normale resta "" e il comportamento è identico a prima.
// ═══════════════════════════════════════════════════════════
let API_BASE = (() => {
  try {
    return localStorage.getItem("crackify_api_base") || "";
  } catch (_) {
    return "";
  }
})();

function setApiBase(base) {
  API_BASE = base || "";
  try {
    if (base) localStorage.setItem("crackify_api_base", base);
    else localStorage.removeItem("crackify_api_base");
  } catch (_) {}
}

function apiUrl(path) {
  if (!API_BASE || !path || typeof path !== "string") return path;
  // già assoluto: qualunque schema, non solo http(s). Le copie offline sono
  // capacitor://localhost/_capacitor_file_/… e il player nativo passa la
  // sorgente da qui: col solo http(s) diventava "http://…:8787capacitor://…",
  // che AVPlayer non apre — brani scaricati muti sia offline sia online
  // (Vitto 06/10, rotto dal player nativo del 01/10)
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) return path;
  return API_BASE.replace(/\/$/, "") + path;
}

/** true se giriamo dentro un guscio nativo Capacitor (non browser/PWA) */
function isNativeShell() {
  try {
    return !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  } catch (_) {
    return false;
  }
}

/** Brani a cui è stata cambiata la copertina col selettore (id → revisione),
 * vedi mediaAuthUrl e applyNewTrackCover. Qui in cima perché mediaAuthUrl
 * può girare presto; in localStorage perché la cache immagini della WebView
 * sopravvive al riavvio dell'app, e con lei gli URL vecchi rimasti nella
 * coda o nello stato di sync. */
const COVER_REV_KEY = "crackify_cover_rev";
const _coverRev = (() => {
  try {
    const o = JSON.parse(localStorage.getItem(COVER_REV_KEY) || "{}");
    return new Map(Object.entries(o).filter(([, v]) => typeof v === "string"));
  } catch (_) {
    return new Map();
  }
})();
function setCoverRev(id, rev) {
  _coverRev.delete(id); // in fondo = la più recente, le più vecchie escono prima
  _coverRev.set(id, rev);
  while (_coverRev.size > 300) _coverRev.delete(_coverRev.keys().next().value);
  try {
    localStorage.setItem(COVER_REV_KEY, JSON.stringify(Object.fromEntries(_coverRev)));
  } catch (_) {}
}

/**
 * Player nativo iOS (NativeAudioPlugin.swift, AVPlayer) travestito da
 * HTMLAudioElement. iOS dà il controller musicale (lock screen, Centro di
 * Controllo) all'app che produce davvero l'audio: con l'<audio> lo produce
 * WebKit, che si ritira alla prima interruzione (Instagram, vocali…) e iOS
 * ripiegava su SoundCloud. Con AVPlayer nel processo dell'app restiamo nel
 * controller come Spotify. Imita solo la parte di <audio> che app.js usa:
 * src, play/pause, currentTime, duration, paused, ended, buffered,
 * readyState, error, volume/muted e i relativi eventi.
 */
class NativeAudioElement extends EventTarget {
  constructor(plugin) {
    super();
    this._p = plugin;
    this._src = "";
    this._gen = 0;
    this._attese = []; // play() in attesa del suono vero, vedi _attendiSuono
    this._reset();
    this._volume = 1;
    this._muted = false;
    this.preload = "none";
    plugin.addListener("audio", (e) => this._onNative(e));
  }
  _reset() {
    this._paused = true;
    this._ended = false;
    this._t = 0;
    this._d = NaN;
    this._buf = 0;
    this._sounding = false;
    this.readyState = 0;
    this.error = null;
  }
  _fire(type) {
    this.dispatchEvent(new Event(type));
  }
  _onNative(e) {
    // eventi del brano precedente ancora in viaggio: scartati
    if (!e || !this._src || e.gen !== this._gen) return;
    if (typeof e.t === "number") this._t = e.t;
    if (typeof e.d === "number") this._d = e.d > 0 ? e.d : NaN;
    if (typeof e.buf === "number") this._buf = e.buf;
    if (typeof e.sounding === "boolean") {
      this._sounding = e.sounding;
      if (e.sounding) this._chiudiAttese(null);
    }
    switch (e.type) {
      case "state":
        // play/pausa decisi dal sistema (interruzioni, controller): li
        // inoltriamo solo se cambiano lo stato che app.js già conosce
        if (e.paused !== this._paused) {
          this._paused = !!e.paused;
          if (!this._paused) this._ended = false;
          this._fire(this._paused ? "pause" : "play");
        }
        break;
      case "loadedmetadata":
        this.readyState = Math.max(this.readyState, 1);
        this._fire("loadedmetadata");
        break;
      case "canplay":
        this.readyState = 4;
        this._fire("canplay");
        break;
      case "ended":
        this._ended = true;
        if (!this._paused) {
          this._paused = true;
          this._fire("pause");
        }
        this._fire("ended");
        break;
      case "error":
        this.error = { code: e.code || 4, message: e.msg || "" };
        this._chiudiAttese(new DOMException(this.error.message || "errore audio", "NotSupportedError"));
        this._fire("error");
        break;
      default:
        // timeupdate, durationchange, progress, seeked
        this._fire(e.type);
    }
  }
  get src() {
    return this._src;
  }
  set src(v) {
    this._chiudiAttese(new DOMException("sorgente cambiata", "AbortError"));
    this._src = v ? apiUrl(String(v)) : "";
    this._gen++;
    this._reset();
    this._p.load({ url: this._src, gen: this._gen }).catch(() => {});
  }
  removeAttribute(name) {
    if (name === "src") this.src = "";
  }
  load() {
    if (this._src) this.src = this._src;
  }
  play() {
    if (!this._src) return Promise.reject(new DOMException("nessuna sorgente", "NotSupportedError"));
    if (this._paused) {
      this._paused = false;
      this._ended = false;
      this._fire("play");
    }
    const gen = this._gen;
    return this._p.play().then(() => this._attendiSuono(gen));
  }
  /** Come l'<audio>: play() si risolve quando il brano SI SENTE, non quando
   * AVPlayer ha preso il comando. In streaming (anteprime Deezer di Daily
   * Mix/Discovery) resta in attesa di buffer anche un secondo, e il
   * riempimento della riga (setTrackRowResolving, tolto dopo playWithRetry)
   * finiva di colpo prima del suono (Vitto, 03/10). Il "sounding" arriva dal
   * plugin con ogni evento, anche col timeupdate ogni 0,25s. */
  _attendiSuono(gen) {
    if (gen !== this._gen) return Promise.reject(new DOMException("sorgente cambiata", "AbortError"));
    if (this._sounding) return Promise.resolve();
    return new Promise((res, rej) => {
      // rete di sicurezza: un buffer che non arriva mai non deve tenere
      // ferma la coda (playBusy) per sempre
      const a = { res, rej, timer: setTimeout(() => this._chiudiAttesa(a, null), 20000) };
      this._attese.push(a);
    });
  }
  _chiudiAttesa(a, err) {
    clearTimeout(a.timer);
    this._attese = this._attese.filter((x) => x !== a);
    if (err) a.rej(err);
    else a.res();
  }
  _chiudiAttese(err) {
    this._attese.slice().forEach((a) => this._chiudiAttesa(a, err));
  }
  pause() {
    // come l'<audio>: un play() ancora in attesa viene interrotto
    this._chiudiAttese(new DOMException("play() interrotto da pause()", "AbortError"));
    if (!this._paused) {
      this._paused = true;
      this._fire("pause");
    }
    this._p.pause().catch(() => {});
  }
  get paused() {
    return this._paused;
  }
  get ended() {
    return this._ended;
  }
  get duration() {
    return this._d;
  }
  get currentTime() {
    return this._t;
  }
  set currentTime(v) {
    const t = Math.max(0, Number(v) || 0);
    this._t = t;
    this._ended = false;
    this._p.seek({ time: t }).catch(() => {});
  }
  get buffered() {
    const end = this._buf;
    return { length: end > 0 ? 1 : 0, start: () => 0, end: () => end };
  }
  get volume() {
    return this._volume;
  }
  set volume(v) {
    this._volume = Math.max(0, Math.min(1, Number(v)));
    this._syncVolume();
  }
  get muted() {
    return this._muted;
  }
  set muted(v) {
    this._muted = !!v;
    this._syncVolume();
  }
  _syncVolume() {
    this._p.setVolume({ volume: this._volume, muted: this._muted }).catch(() => {});
    this._fire("volumechange");
  }
}

/** Plugin NativeAudio se giriamo nel guscio iOS che lo registra, sennò null
 * (browser, PWA, Android, o un'app iOS installata prima del plugin). */
function nativeAudioPlugin() {
  try {
    const C = window.Capacitor;
    if (!isNativeShell() || C.getPlatform() !== "ios") return null;
    if (!C.isPluginAvailable("NativeAudio")) return null;
    return C.Plugins.NativeAudio || C.registerPlugin("NativeAudio");
  } catch (_) {
    return null;
  }
}

/** Chiude un modale con un campo di testo dentro: blur() da solo a volte
 * non basta su iOS/Capacitor — la tastiera resta "agganciata" e il
 * viewport bloccato spostato in alto finché non forzi anche il comando
 * nativo di chiusura tastiera. */
function dismissKeyboard() {
  try {
    if (document.activeElement && typeof document.activeElement.blur === "function") {
      document.activeElement.blur();
    }
  } catch (_) {}
  try {
    const Keyboard = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Keyboard;
    if (Keyboard && Keyboard.hide) Keyboard.hide();
  } catch (_) {}
}

/** Primo avvio in app nativa: senza un indirizzo assoluto del Mac,
 * ogni fetch relativa punterebbe al WebView stesso invece che al server. */
/** Pannello Crackify-style per impostare l'indirizzo del Mac (app nativa) —
 * al posto di un window.prompt() nativo del browser, non tematizzabile. */
function openServerBindModal({ cancelable = true } = {}) {
  const modal = document.getElementById("serverBindModal");
  if (!modal) return;
  const input = document.getElementById("serverBindInput");
  const err = document.getElementById("serverBindErr");
  const cancelBtn = document.getElementById("serverBindCancel");
  if (input) input.value = API_BASE || "";
  if (err) {
    err.hidden = true;
    err.textContent = "";
  }
  if (cancelBtn) cancelBtn.classList.toggle("hidden", !cancelable);
  modal.classList.remove("hidden");
  if (input) window.setTimeout(() => input.focus(), 50);
}

function closeServerBindModal() {
  const modal = document.getElementById("serverBindModal");
  dismissKeyboard();
  if (modal) modal.classList.add("hidden");
}

function confirmServerBind() {
  const input = document.getElementById("serverBindInput");
  const err = document.getElementById("serverBindErr");
  const value = (input && input.value || "").trim().replace(/\/$/, "");
  if (!value) {
    if (err) {
      err.textContent = "Inserisci un indirizzo";
      err.hidden = false;
    }
    return;
  }
  setApiBase(value);
  window.location.reload();
}

function ensureApiBaseConfigured() {
  if (!isNativeShell() || API_BASE) return;
  openServerBindModal({ cancelable: false });
}

// ═══════════════════════════════════════════════════════════
// UI THEMES — classic | liquid-glass
// Default: liquid-glass. Non esposto in UI (per ora).
// Futuro picker: CRACKIFY.setUiTheme('classic' | 'liquid-glass')
// ═══════════════════════════════════════════════════════════
const UI_THEMES = {
  classic: {
    id: "classic",
    label: "Classic",
    description: "UI originale CRACKIFY (solidi / gradienti)",
  },
  "liquid-glass": {
    id: "liquid-glass",
    label: "Liquid Glass",
    description: "Vetro, blur, tint dalla cover",
  },
};
const UI_THEME_DEFAULT = "liquid-glass";
const UI_THEME_KEY = "crackify.uiTheme";

function getUiTheme() {
  try {
    const t = localStorage.getItem(UI_THEME_KEY);
    if (t && UI_THEMES[t]) return t;
  } catch (_) {}
  const attr = document.documentElement.getAttribute("data-ui-theme");
  if (attr && UI_THEMES[attr]) return attr;
  return UI_THEME_DEFAULT;
}

function setUiTheme(themeId, { persist = true, repaint = true } = {}) {
  const id = UI_THEMES[themeId] ? themeId : UI_THEME_DEFAULT;
  document.documentElement.setAttribute("data-ui-theme", id);
  document.body.classList.toggle("theme-liquid-glass", id === "liquid-glass");
  document.body.classList.toggle("theme-classic", id === "classic");
  if (persist) {
    try {
      localStorage.setItem(UI_THEME_KEY, id);
    } catch (_) {}
  }
  if (repaint && typeof paintNowPlayingBackground === "function") {
    try {
      paintNowPlayingBackground();
    } catch (_) {}
  }
  try {
    window.dispatchEvent(
      new CustomEvent("crackify:ui-theme", { detail: { theme: id } })
    );
  } catch (_) {}
  return id;
}

// ═══════════════════════════════════════════════════════════
// AUTH / SESSION (multi-user)
// ═══════════════════════════════════════════════════════════
const SESSION_KEY = "crackify.session";
const DEVICE_KEY = "crackify.deviceId";
const DEVICE_NAME_KEY = "crackify.deviceName";

let authState = {
  token: null,
  user: null,
  authenticated: false,
  authRequired: false,
  deviceId: null,
  currentDeviceId: null,
};

function getSessionToken() {
  try {
    const fromStorage = localStorage.getItem(SESSION_KEY);
    if (fromStorage) return fromStorage;
  } catch (_) {}
  // fallback cookie: stesso check dello script inline in <head>, altrimenti
  // un client con cookie valido ma localStorage vuoto/in ritardo vede
  // lampeggiare il login finché /api/me non risponde (falso allarme).
  try {
    const m = document.cookie.match(/(?:^|;\s*)crackify_token=([^;]+)/);
    if (m) return decodeURIComponent(m[1]);
  } catch (_) {}
  return null;
}

function setSessionToken(token) {
  try {
    if (token) localStorage.setItem(SESSION_KEY, token);
    else localStorage.removeItem(SESSION_KEY);
  } catch (_) {}
  authState.token = token || null;
  // cookie mirror per <audio>/<img> (server la setta anche su login)
  try {
    if (token) {
      document.cookie =
        "crackify_token=" +
        encodeURIComponent(token) +
        "; path=/; max-age=" +
        30 * 86400 +
        "; samesite=lax";
    } else {
      document.cookie =
        "crackify_token=; path=/; max-age=0; samesite=lax";
    }
  } catch (_) {}
}

/**
 * URL media library: <audio>/<img> non mandano Authorization.
 * Server legge cookie o query ?t=TOKEN (non usare t= per cache-bust!).
 */
// —— Profilo bassi precalcolato lato server (vedi app/envelope.py) ——
// Alternativa sicura all'analyser Web Audio dal vivo: su iOS agganciare
// createMediaElementSource al player principale rompe l'audio per il
// resto della sessione (vedi ensureJarvisAnalyser più sotto — bug reale
// trovato il 2026-07-30), quindi lì quell'analyser è disabilitato e questo
// profilo precalcolato diventa l'UNICA fonte di reattività vera ai bassi.
// Su web/desktop l'analyser live resta prioritario dove disponibile (più
// accurato), questo è il fallback ovunque manchi.
let currentEnvelope = null; // {fps, values} | null — del brano CORRENTE
let currentEnvelopeSrc = ""; // path già richiesto, evita rifetch identici

// Deriva l'URL dell'envelope dallo stesso stream_url già usato per
// l'audio — stesso pattern "sibling endpoint" di /cover accanto a /audio
// già usato ovunque in questo backend (vedi main.py).
function envelopeUrlForStreamUrl(streamUrl) {
  if (!streamUrl) return null;
  try {
    const u = new URL(streamUrl, location.origin);
    if (u.pathname.endsWith("/audio")) {
      return u.pathname.slice(0, -"/audio".length) + "/envelope";
    }
    if (/^\/api\/media\/[^/]+$/.test(u.pathname)) {
      return u.pathname + "/envelope"; // /api/media/{token} → .../envelope
    }
  } catch (_) {}
  return null; // preview Deezer diretta, file offline locale, ecc. — niente da chiedere
}

async function loadEnvelopeFor(streamUrl) {
  const path = envelopeUrlForStreamUrl(streamUrl);
  if (!path) {
    currentEnvelope = null;
    currentEnvelopeSrc = "";
    return;
  }
  if (path === currentEnvelopeSrc) return; // stesso brano, già in corso/fatto
  currentEnvelopeSrc = path;
  currentEnvelope = null; // finché non arriva: chi legge degrada da solo
  // piccolo ritardo voluto: la PRIMA volta che un brano viene suonato il
  // server calcola lo spettro al volo (ffmpeg decodifica tutto il file +
  // FFT, niente cache su disco ancora — vedi envelope.py) e su hardware
  // modesto quella CPU vera contende con la richiesta di streaming che
  // parte nello STESSO istante, rallentando il "click → suono" percepito
  // (segnalato da Vitto, 2026-08-05: "un click normale avrebbe fatto in
  // meno di un secondo"). Lo spettro serve solo alla soundbar (che degrada
  // già da sola restando "idle" finché non arriva, vedi sopra) — farlo
  // partire un attimo dopo lascia via libera al brano vero.
  // Attese crescenti, non un colpo solo: per un brano in streaming da
  // Telegram il server risponde 404 ("audio non ancora pronto") finché il
  // file non è scaricato per intero, e con un unico tentativo la soundbar
  // restava non reattiva per TUTTA la canzone — quello che si vedeva sul
  // live come "non carica la soundbar" (Vitto, 2026-08-12: /api/media/
  // 2ec9049…/envelope → 404 da entrambi i device). Smettiamo appena
  // l'envelope arriva o appena cambia brano.
  const waits = [700, 2500, 4000, 6000, 10000, 15000, 20000];
  for (const wait of waits) {
    await new Promise((r) => setTimeout(r, wait));
    if (currentEnvelopeSrc !== path) return; // superato da un brano più recente
    try {
      const data = await apiJson(path);
      if (currentEnvelopeSrc !== path) return;
      if (data && Array.isArray(data.values)) {
        currentEnvelope = data;
        return;
      }
    } catch (_) {
      // 404 (file non ancora pronto) o rete: riprova al giro dopo
    }
  }
}

/** Dove è arrivato il brano che suona sull'ALTRO device: ultimo campione
 * ricevuto + tempo passato da allora sul nostro orologio. Unica fonte per
 * barra di avanzamento (startMirrorTicker) ed envelope (qui sotto), così
 * non possono raccontare due storie diverse. */
function mirrorPlaybackPosition() {
  if (!_mirrorPlaying) return _mirrorBasePos;
  const elapsed = (performance.now() - _mirrorServerAt) / 1000;
  let pos = _mirrorBasePos + Math.max(0, elapsed);
  if (_mirrorDur > 0) pos = Math.min(pos, _mirrorDur);
  return pos;
}

/** Livello 0..1 dei bassi al punto di riproduzione attuale, o null se non
 * disponibile (brano senza envelope pronto — chi chiama degrada da solo).
 *
 * In mirror l'envelope è quello VERO del brano che sta suonando sull'altro
 * device (applyRemoteMirror lo carica da library_id/stream_token, che sono
 * gli stessi per tutti i device), indicizzato sulla posizione remota invece
 * che sul nostro <audio> — che in mirror è fermo per costruzione. Così le
 * soundbar seguono davvero la canzone, non un'animazione qualsiasi. */
function envelopeBassLevel() {
  if (!currentEnvelope || !currentEnvelope.values || !currentEnvelope.values.length) return null;
  const t = remoteMirror ? mirrorPlaybackPosition() : audio.currentTime || 0;
  const idx = Math.floor(t * currentEnvelope.fps);
  const v = currentEnvelope.values[Math.max(0, Math.min(currentEnvelope.values.length - 1, idx))];
  return typeof v === "number" ? v : null;
}

/** Il livello normalizzato (0..1 sul MASSIMO di tutto il brano) resta per
 * lo più basso/medio durante l'ascolto normale — un solo istante tocca 1.
 * Curva a radice per "gonfiare" i livelli medi (Vitto: "non sbalza molto,
 * aumenta un po'") invece di sembrare sempre timido. */
function envelopeBoost(level) {
  return Math.pow(Math.max(0, Math.min(1, level)), 0.55);
}

// Stesso identico pattern di currentEnvelope/envelopeBassLevel sopra, ma
// per la VOCE di JARVIS invece della musica — vedi speakJarvisText (dove
// arriva, come header della risposta TTS) e startJarvisSoundbarLoop (dove
// viene letto, fallback quando l'analyser Web Audio live è disabilitato
// su iOS, vedi ensureJarvisSpeechAnalyser).
let jarvisSpeechEnvelope = null;

function envelopeSpeechLevel() {
  if (!jarvisSpeechEnvelope || !jarvisSpeechEnvelope.values || !jarvisSpeechEnvelope.values.length) return null;
  const idx = Math.floor((jarvisSpeechAudio?.currentTime || 0) * jarvisSpeechEnvelope.fps);
  const v = jarvisSpeechEnvelope.values[Math.max(0, Math.min(jarvisSpeechEnvelope.values.length - 1, idx))];
  return typeof v === "number" ? v : null;
}

// ═══════════════════════════════════════════════════════════
// Lazy-loading delle copertine in liste/griglie — le cover qui non sono
// <img> (niente loading="lazy" nativo) ma background-image impostata da
// JS: aprendo "Brani salvati" partivano centinaia di richieste immagine
// tutte insieme, anche per righe fuori schermo. Con l'observer l'URL
// viene assegnato solo quando la riga sta per entrare in viewport.
// NON usarlo per le cover "singole" sempre visibili (art del player,
// hero di playlist/artista, menu): lì l'immagine serve subito, e
// syncLyricsArt legge style.backgroundImage di npArt/coverEl per
// ricavare il tema colore — se fosse differita leggerebbe stringa vuota.
// ═══════════════════════════════════════════════════════════
const _lazyCoverObserver =
  typeof IntersectionObserver === "function"
    ? new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            const el = entry.target;
            _lazyCoverObserver.unobserve(el);
            const url = el.dataset.lazyCover;
            if (url) el.style.backgroundImage = "url(" + url + ")";
            delete el.dataset.lazyCover;
          }
        },
        // margine ampio: la cover parte prima che la riga entri davvero
        // in viewport, così a scroll veloce non si vede il "pop-in"
        { rootMargin: "600px 0px", threshold: 0 }
      )
    : null;

/** Da usare al posto di `el.style.backgroundImage = url(...)` dentro i
 * render di liste/griglie. backgroundSize/Position e lo svuotamento del
 * placeholder restano immediati: costano nulla e evitano il salto di
 * layout quando l'immagine arriva. */
function lazyLoadCover(el, url, { clearText = true } = {}) {
  if (!el || !url) return;
  el.style.backgroundSize = "cover";
  el.style.backgroundPosition = "center";
  // clearText:false per le cover che hanno FIGLI da preservare (il badge
  // di Daily Mix/Radio sta dentro la cover, non accanto)
  if (clearText) el.textContent = "";
  if (!_lazyCoverObserver) {
    // browser senza IntersectionObserver: comportamento di prima
    el.style.backgroundImage = "url(" + url + ")";
    return;
  }
  el.dataset.lazyCover = url;
  _lazyCoverObserver.observe(el);
}

/** Smette di osservare le cover ancora differite dentro `container`.
 * Da chiamare PRIMA di svuotarlo con innerHTML = "": senza questo, ogni
 * rebuild di lista lascia dietro target orfani ancora osservati. */
function releaseLazyCovers(container) {
  if (!container || !_lazyCoverObserver) return;
  const pending = container.querySelectorAll("[data-lazy-cover]");
  for (let i = 0; i < pending.length; i++) _lazyCoverObserver.unobserve(pending[i]);
}

function mediaAuthUrl(url, { bust = true } = {}) {
  if (!url) return url;
  try {
    const u = new URL(url, location.origin);
    // path protetti (richiedono il token anche in query, per il caso
    // cross-origin dell'app nativa dove i cookie di sessione non passano)
    if (
      u.pathname.startsWith("/api/library/") ||
      u.pathname.startsWith("/api/playlists/") ||
      u.pathname.startsWith("/api/home/playlists/") ||
      u.pathname.startsWith("/api/me/avatar")
    ) {
      const tok = authState.token || getSessionToken();
      if (tok) u.searchParams.set("t", tok);
    }
    // copertina cambiata col selettore: liste e coda in memoria possono
    // tenere ancora l'URL vecchio (?v= di prima), per cui la WebView ha in
    // cache 24h l'immagine vecchia — un parametro in più la scavalca
    const coverM = u.pathname.match(/^\/api\/library\/([0-9a-f]{8,64})\/cover(?:\/hd)?$/);
    if (coverM && _coverRev.has(coverM[1])) u.searchParams.set("r", _coverRev.get(coverM[1]));
    if (bust) u.searchParams.set("_", String(Date.now()));
    // se path assoluto same-origin, restituisci path+query (con API_BASE
    // anteposto quando gira in un guscio nativo — vedi apiUrl())
    if (url.startsWith("/")) return apiUrl(u.pathname + u.search);
    return u.toString();
  } catch (_) {
    return url;
  }
}

function getOrCreateDeviceId() {
  try {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id) {
      id =
        (crypto.randomUUID && crypto.randomUUID()) ||
        Math.random().toString(36).slice(2) + Date.now().toString(36);
      localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  } catch (_) {
    return null;
  }
}

function guessDeviceName() {
  try {
    const saved = localStorage.getItem(DEVICE_NAME_KEY);
    if (saved) return saved;
  } catch (_) {}
  const ua = navigator.userAgent || "";
  if (/iPhone|iPad/i.test(ua)) return "iPhone / iPad";
  if (/Android/i.test(ua)) return "Android";
  if (/Mac/i.test(ua)) return "Mac";
  if (/Windows/i.test(ua)) return "Windows";
  return "Browser";
}

function authHeaders(extra) {
  const h = Object.assign({}, extra || {});
  const tok = authState.token || getSessionToken();
  if (tok) h["Authorization"] = "Bearer " + tok;
  return h;
}

// API futura (console / settings)
window.CRACKIFY = Object.assign(window.CRACKIFY || {}, {
  themes: UI_THEMES,
  getUiTheme,
  setUiTheme,
  listUiThemes: () => Object.values(UI_THEMES),
  getAuth: () => ({ ...authState }),
  logout: () => doLogout(),
});

// applica subito (prima del paint di componenti)
setUiTheme(getUiTheme(), { persist: false, repaint: false });
// ripristina token + cookie (serve a <audio>/<img> library)
(function bootSessionCookie() {
  const tok = getSessionToken();
  if (tok) setSessionToken(tok);
  else authState.token = null;
})();
authState.deviceId = getOrCreateDeviceId();

// Mobile / PWA / Tailscale: niente intro lunga (blocca UI e confonde)
const IS_MOBILE =
  window.matchMedia("(max-width: 900px)").matches ||
  "ontouchstart" in window ||
  /iPhone|iPad|iPod|Android/i.test(navigator.userAgent || "");

// —— storico di navigazione (03/10) ——
// Lo tengono le funzioni "apri" (registraTappa) e lo usano gli swipe dai
// bordi sul telefono (navIndietro/navAvanti, vedi setupEdgeSwipeBack): lo
// stesso lavoro dei chevron del guscio Mac. Qui in cima perché showView & co.
// lo toccano da subito.
const _storico = { pila: [], idx: -1, inRiproduzione: false };
// classe d'entrata delle viste: "view-enter" di solito, "back-enter" /
// "fwd-enter" mentre lo swipe rifà una tappa (vedi riproduciTappa)
let _classeEntrata = "view-enter";

// PWA iOS: solo marca standalone — layout dock è CSS flex (no fixed/JS pin)
(function setupMobileDock() {
  const standalone =
    window.matchMedia("(display-mode: standalone)").matches ||
    window.navigator.standalone === true;
  if (standalone) document.documentElement.classList.add("is-pwa");
})();

// —— Intro (solo desktop; mobile salta subito) ——
const INTRO_MS = 11500;
(function bootIntro() {
  const splash = document.getElementById("introSplash");
  const skip = document.getElementById("introSkip");
  if (!splash) return;

  const finish = () => {
    splash.classList.add("hide");
    document.body.classList.remove("intro-lock");
    setTimeout(() => {
      try {
        splash.remove();
      } catch (_) {}
    }, 400);
  };

  if (IS_MOBILE) {
    finish();
    return;
  }

  document.body.classList.add("intro-lock");
  let done = false;
  const end = () => {
    if (done) return;
    done = true;
    finish();
  };
  const timer = setTimeout(end, INTRO_MS);
  if (skip) {
    skip.addEventListener("click", () => {
      clearTimeout(timer);
      end();
    });
  }
  window.addEventListener("message", (e) => {
    if (e && e.data && e.data.type === "crackify-intro-done") {
      clearTimeout(timer);
      end();
    }
  });
  const onKey = (e) => {
    if (e.key === "Escape") {
      clearTimeout(timer);
      end();
      window.removeEventListener("keydown", onKey);
    }
  };
  window.addEventListener("keydown", onKey);
})();

// Pulisci SW/cache vecchi (shell stantia nascondeva CSS nuovi)
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.getRegistrations().then((regs) => {
    regs.forEach((r) => r.unregister());
  });
  if (window.caches && caches.keys) {
    caches.keys().then((keys) => keys.forEach((k) => caches.delete(k)));
  }
}
// forza un reload una tantum se ancora su CSS pre-chrome unificato
(function forceCssRefreshOnce() {
  try {
    const KEY = "crackify.cssRev";
    const REV = "77";
    if (localStorage.getItem(KEY) === REV) return;
    localStorage.setItem(KEY, REV);
    const link = document.querySelector('link[href*="style.css"]');
    if (link && link.href && !link.href.includes("v=77")) {
      location.reload();
    }
  } catch (_) {}
})();

const form = $("#searchForm");
/** L'ultima query davvero mandata ai bot Telegram. Riaprire la finestra con
 * lo stesso testo NON deve rifare la ricerca: ogni ricerca è una richiesta
 * ai bot e sono contate (vedi i limiti in bots/). */
let ultimaQueryBrani = "";
const queryInput = $("#query");
const searchBtn = $("#searchBtn");
const searchHistoryEl = $("#searchHistory");
const trackList = $("#trackList");
const libList = $("#libList");
const libSearch = $("#libSearch");
const libSearchWrap = $("#libSearchWrap");
const libSearchClear = $("#libSearchClear");
const queueList = $("#queueList");
const statusEl = $("#status");
const libStatus = $("#libStatus");
const libLoadingSpinner = $("#libLoadingSpinner");
const mainEl = document.querySelector(".main");
const queueStatus = $("#queueStatus");
const queueBadge = $("#queueBadge");
const queueBadgeMobile = $("#queueBadgeMobile");
const queueNowLabel = $("#queueNowLabel");
// Coda come bottom sheet — vedi openQueueSheet/closeQueueSheet più sotto
const queueSheet = $("#queueSheet");
const queueSheetBackdrop = $("#queueSheetBackdrop");
const queueSheetListWrap = $("#queueSheetListWrap");
const qsNowLabel = $("#qsNowLabel");
const qsClear = $("#qsClear");
const qsShuffle = $("#qsShuffle");
const qsRepeat = $("#qsRepeat");
const qsIcoRepeat = $("#qsIcoRepeat");
const qsIcoRepeatOne = $("#qsIcoRepeatOne");
let queueSheetOpen = false;
let queueSheetMax = false;

// (service worker disabilitato: su iPhone via Tailscale la cache spezzava le API)
const resultsHead = $("#resultsHead");
const resultsTitle = $("#resultsTitle");
const skeleton = $("#skeleton");
const _nativeAudioPlugin = nativeAudioPlugin();
const audio = _nativeAudioPlugin ? new NativeAudioElement(_nativeAudioPlugin) : $("#audio");
// Stato del canale di sync (vedi "Canale di sync (WebSocket)" più sotto per
// le funzioni). DEVE stare qui, prima di qualunque codice che tocchi
// `audio`: un audio.pause() chiamato durante il boot (es. reset dello stato
// player) dispara SUBITO l'evento "pause" già agganciato più sotto, la cui
// callback chiama syncPushNow()/_sync — se questa dichiarazione fosse ancora
// più in basso nel file, quella lettura cadrebbe nella temporal dead zone
// del const e l'intero script si fermava con "Cannot access '_sync' before
// initialization": schermata bianca su iOS, zero richieste di rete, nessun
// errore visibile senza il Web Inspector collegato (bug reale, trovato sul
// device di Vitto l'11/08, "non mi fa fare niente... blurrato sotto").
const SYNC_HB_MS = 5000; // heartbeat posizione (il client interpola tra uno e l'altro)
const _sync = {
  ws: null,
  deviceId: "",
  tries: 0,
  retryTimer: null,
  hbTimer: null,
  seq: 0,
  state: null,
  wasMirror: false,
  lastIdleSig: "",
  helloWatchdog: null, // vedi resumeSyncNow: socket vivo o fantasma?
  sawSnapshotSince: false,
  lastSentAt: 0, // per il keepalive: vedi startSyncHeartbeat
};
// coda condivisa (vedi "coda condivisa" più sotto per le funzioni) — stesso
// motivo di _sync qui sopra
let _sharedQueue = null; // { items, index, shuffle } dell'ultimo owner
let _sharedQueueSig = ""; // firma dell'ultima coda pubblicata da noi
let _publishQueueTimer = null;
// Stato del mirror multi-device (vedi applyRemoteMirror più sotto per come
// si popola). Anche questo deve stare qui e non vicino a dove si usa:
// startHomeDjSoundbarLoop() parte SINCRONA a fine file (poche righe più
// sotto della sua definizione, non aspetta nessun evento) e da subito
// controlla remoteMirror/_mirrorPlaying per decidere se la soundbar deve
// "sembrare viva" anche quando l'audio locale è in pausa — stessa temporal
// dead zone del bug di _sync qui sopra se questi restassero dichiarati
// dove sono usati dal resto del codice (vicino ad applyRemoteMirror).
let remoteMirror = false; // true = mostriamo lo stato di un altro device (no audio locale)
let remoteMirrorIsJarvis = false;
let _mirrorPlaying = false;
// posizione del brano remoto: base + quando l'abbiamo ricevuta, il resto è
// interpolazione locale (vedi mirrorPlaybackPosition). Stanno qui e non
// vicino ad applyRemoteMirror perché envelopeBassLevel() — poche righe più
// sotto, e chiamata dai loop delle soundbar che partono subito — le legge
// per indicizzare lo spettro del brano che suona sull'altro device.
let _mirrorDur = 0;
let _mirrorServerAt = 0; // performance.now() quando abbiamo ricevuto lo stato
let _mirrorBasePos = 0;
const nowTitle = $("#nowTitle");
const nowArtist = $("#nowArtist");
const coverEl = $("#cover");
const pager = $("#pager");
const pageLabel = $("#pageLabel");
const prevPageBtn = $("#prevPage");
const nextPageBtn = $("#nextPage");
const playerBar = $("#playerBar");
const btnPlay = $("#btnPlay");
const playIcon = $("#playIcon");
const seek = $("#seek");
const seekFill = $("#seekFill");
const seekBuf = $("#seekBuf");
const timeCur = $("#timeCur");
const timeDur = $("#timeDur");
const volume = $("#volume");
const volFill = $("#volFill");
const btnMute = $("#btnMute");
const btnLike = $("#btnLike");
const btnPrev = $("#btnPrev");
const btnNext = $("#btnNext");
const btnShuffle = $("#btnShuffle");
const btnRepeat = $("#btnRepeat");
const iconPlay = $("#iconPlay");
const iconPause = $("#iconPause");
const iconRepeat = $("#iconRepeat");
const iconRepeatOne = $("#iconRepeatOne");
const btnClearQueue = $("#btnClearQueue");

// Full Now Playing sheet
const npSheet = $("#nowPlayingSheet");
const npBg = $("#npBg");
const npArtWrap = $("#npArtWrap");
const npMetaRow = $("#npMetaRow");
const npArt = $("#npArt");
const npTitle = $("#npTitle");
const npArtist = $("#npArtist");
const npContext = $("#npContext");
const npClose = $("#npClose");
const npLike = $("#npLike");
const npPlay = $("#npPlay");
const npPrev = $("#npPrev");
const npNext = $("#npNext");

// Sheet full-screen di JARVIS (il DJ AI) — vedi memoria progetto
// crackify_ai_dj_plan. Nessuna coda/riproduzione propria per ora: i
// controlli comandano lo stesso player globale, come fa già il sheet sopra.
const homeDjSection = $("#homeDjSection");
const homeDjCard = $("#homeDjCard");
// niente più sheet/controlli separati per JARVIS — vive dentro
// #nowPlayingSheet (vedi openDjSheet, syncNowPlayingSheetMeta per il
// toggle .jarvis-mode), riusa npClose/npPlay/npPrev/npNext e
// closeNowPlayingSheet per chiudere. Richiesta di Vitto, 2026-07-31.
const djLine = $("#djLine");
const djLoading = $("#djLoading");
const djSoundbar = $("#djSoundbar");
const homeDjSoundbar = $("#homeDjSoundbar");
const djRequestForm = $("#djRequestForm");
const djRequestInput = $("#djRequestInput");
const jarvisVoiceOverlay = $("#jarvisVoiceOverlay");
const jarvisVoiceCircle = $("#jarvisVoiceCircle");
const jarvisVoiceText = $("#jarvisVoiceText");
const jarvisVoiceCancelBtn = $("#jarvisVoiceCancel");
// audio dedicato alla voce di JARVIS (Piper), separato dall'<audio>
// principale — non deve toccare nowPlaying/media session del brano vero
const jarvisSpeechAudio = $("#jarvisSpeechAudio");
const npShuffle = $("#npShuffle");
const npRepeat = $("#npRepeat");
const npSeek = $("#npSeek");
const npSeekFill = $("#npSeekFill");
const npSeekBuf = $("#npSeekBuf");
const npTimeCur = $("#npTimeCur");
const npTimeDur = $("#npTimeDur");
const npAddPl = $("#npAddPl");
const npMore = $("#npMore");
const npMenuSheet = $("#npMenuSheet");
const npMenuBackdrop = $("#npMenuBackdrop");
const npMenuCover = $("#npMenuCover");
const npMenuTitle = $("#npMenuTitle");
const npMenuArtist = $("#npMenuArtist");
const npMenuLikeRow = $("#npMenuLike");
const npMenuLikeLabel = $("#npMenuLikeLabel");
const npMenuSimilar = $("#npMenuSimilar");
const npMenuQueue = $("#npMenuQueue");
const npMenuAddPl = $("#npMenuAddPl");
const npMenuArtistRow = $("#npMenuArtistBtn");
const npMenuGoQueue = $("#npMenuGoQueue");
const npMenuTimer = $("#npMenuTimer");
// "Rigenera copertina": id storico dell'app Mac, vedi il commento in
// index.html — cambiarlo fa ricomparire il doppione sul guscio Mac
const npMenuFixCover = $("#crkFixCover");
const npQueueBtn = $("#npQueue");
const npLyricsBtn = $("#npLyricsBtn");
const npLyricsPreview = $("#npLyricsPreview");
const npLyricsPreviewBody = $("#npLyricsPreviewBody");
const npLyricsExpand = $("#npLyricsExpand");
const npLyricsPanel = $("#npLyricsPanel");
const npLyricsBody = $("#npLyricsBody");
const npLyricsFoot = $("#npLyricsFoot");
const npLyricsTrack = $("#npLyricsTrack");
const npLyricsArtist = $("#npLyricsArtist");
const npLyricsClose = $("#npLyricsClose");
const npLyricsArt = $("#npLyricsArt");
const npLyricsLabel = $("#npLyricsLabel");
const npLyricsNow = $("#npLyricsNow");
const npLyricsNowText = $("#npLyricsNowText");
const lySolidBg = $("#lySolidBg");
const lyPlayBtn = $("#lyPlayBtn");
const lySeekTrack = $("#lySeekTrack");
const lySeekFill = $("#lySeekFill");
const lyTimeCur = $("#lyTimeCur");
const lyTimeDur = $("#lyTimeDur");
const lyIcoPlay = lyPlayBtn ? lyPlayBtn.querySelector(".ly-ico-play") : null;
const lyIcoPause = lyPlayBtn ? lyPlayBtn.querySelector(".ly-ico-pause") : null;
const npIcoPlay = npPlay ? npPlay.querySelector(".np-ico-play") : null;
const npIcoPause = npPlay ? npPlay.querySelector(".np-ico-pause") : null;
const npIcoRepeat = npRepeat ? npRepeat.querySelector(".np-ico-repeat") : null;
const npIcoRepeatOne = npRepeat ? npRepeat.querySelector(".np-ico-repeat-one") : null;
let npOpen = false;
let npSeekDragging = false;
let npTouchStartY = null;
/** cache testi: key = artist|title */
const lyricsCache = new Map();
let lyricsKeyCurrent = "";
let lyricsLoading = false;
/** righe karaoke: { t, text, words?: [{t,text,duration?}] } */
let lyricsSyncedLines = [];
let lyricsActiveIdx = -1;
let lyricsActiveWordIdx = -1;
let lyricsIsKaraoke = false;
let lyricsIsWordMode = false;
let lyricsRaf = 0;
let lyricsSourceLabel = "";
let lyricsEstimated = false;

/** shuffle on/off · repeat: 0 off · 1 all · 2 one */
let shuffleOn = false;
let repeatMode = 0;
let shuffleOrder = []; // indici permutati quando shuffle on
const btnAddPl = $("#btnAddPl");
const viewHome = $("#viewHome");
const homeChartsGrid = $("#homeChartsGrid");
const homeChartsSection = $("#homeChartsSection");
const btnChartsShowAll = $("#btnChartsShowAll");
const chartsModal = $("#chartsModal");
const chartsModalGrid = $("#chartsModalGrid");
const homeDailyMixGrid = $("#homeDailyMixGrid");
const homeDailyMixSection = $("#homeDailyMixSection");
const homeRadioGrid = $("#homeRadioGrid");
const homeRadioSection = $("#homeRadioSection");
const homeRecommendedGrid = $("#homeRecommendedGrid");
const homeRecommendedSection = $("#homeRecommendedSection");
const homeQuickGrid = $("#homeQuickGrid");
const homeDeezerGrid = $("#homeDeezerGrid");
const homeDeezerSection = $("#homeDeezerSection");
const homeDeezerTitle = $("#homeDeezerTitle");
const homeArtistsGrid = $("#homeArtistsGrid");
const homeArtistsSection = $("#homeArtistsSection");
const homeArtistsTitle = $("#homeArtistsTitle");
const homeAlbumsGrid = $("#homeAlbumsGrid");
const homeAlbumsSection = $("#homeAlbumsSection");
const homeAlbumsTitle = $("#homeAlbumsTitle");
const homeSearchFilterRow = $("#homeSearchFilterRow");
const homeSearchHeading = $("#homeSearchHeading");
const homeSearchHeadingTitle = $("#homeSearchHeadingTitle");
const homeSearchSub = $("#homeSearchSub");

/** Intestazione della pagina Cerca: a riposo presenta la pagina, con una
 * query diventa «Risultati per "x"» con la query in arancione. Sotto
 * comanda anche "Aggiunte di recente al server", che è il contenuto della
 * pagina quando non stai cercando niente. */
function aggiornaIntestazioneCerca(raw) {
  const q = (raw || "").trim();
  if (homeSearchHeadingTitle) {
    homeSearchHeadingTitle.textContent = "";
    if (q) {
      homeSearchHeadingTitle.appendChild(document.createTextNode("Risultati per \u201C"));
      const span = document.createElement("span");
      span.id = "homeSearchHeadingQuery";
      span.textContent = q; // testo dell'utente: mai innerHTML
      homeSearchHeadingTitle.appendChild(span);
      homeSearchHeadingTitle.appendChild(document.createTextNode("\u201D"));
    } else {
      homeSearchHeadingTitle.textContent = "Trova il tuo prossimo ascolto.";
    }
  }
  if (homeSearchSub) {
    homeSearchSub.textContent = q
      ? "Artisti, album, playlist e brani."
      : "Cerca un artista, un album o una canzone.";
  }
  const recenti = document.getElementById("recentServerSection");
  const lista = document.getElementById("recentServerList");
  if (recenti) {
    const piene = !!(lista && lista.children.length);
    recenti.classList.toggle("hidden", !!q || !piene);
  }
  const generi = document.getElementById("generiSection");
  const grigliaGeneri = document.getElementById("generiGrid");
  if (generi) {
    generi.classList.toggle("hidden", !!q || !(grigliaGeneri && grigliaGeneri.children.length));
  }
}

/* Le 26 classifiche Deezer come piastrelle per genere, sotto la ricerca a
 * riposo — è la schermata che il prototipo mostra quando non stai cercando
 * niente. Il colore lo decide lo slug e non la posizione, così "Top Rock" è
 * sempre dello stesso colore anche se il server cambia l'ordine.
 * La tavolozza è tutta nella famiglia calda di Crackify (ruggine → ambra):
 * niente arcobaleno come nel prototipo, vedi --crk-genere-* in style.css. */
const GENERI_ORDINE = ("top50 pop hiphop rock dance rnb electro latina reggaeton " +
  "alternative folk reggae jazz country salsa classica film_videogiochi metal " +
  "soul_funk bambini blues cumbia musica_africana musica_asiatica " +
  "musica_brasiliana musica_indiana").split(" ");

function buildGenereTile(c, i) {
  const a = document.createElement("button");
  a.type = "button";
  a.className = "genere-tile";
  const posto = GENERI_ORDINE.indexOf(c.slug);
  a.style.setProperty("--crk-genere-colore",
    `var(--crk-genere-${(posto >= 0 ? posto : i) % 26})`);
  a.dataset.slug = c.slug;
  a.innerHTML = '<strong></strong><span class="genere-art" aria-hidden="true"></span>';
  a.querySelector("strong").textContent = c.label;
  const art = a.querySelector(".genere-art");
  // molte classifiche non hanno ancora una cover in cache: meglio un segno
  // che un rettangolo vuoto (fa così anche il prototipo)
  if (c.cover_url) lazyLoadCover(art, proxiedCover(c.cover_url));
  else art.classList.add("genere-art-vuota");
  a.addEventListener("click", () => {
    activatePlaylistsShell();
    openChart(c.slug);
  });
  return a;
}

/* Le classifiche senza copertina in cache: /api/charts/<slug> la rigenera
 * SEMPRE fresca da Deezer (vedi api_charts_detail) e riscrive la cache lato
 * server, quindi questo giro serve due volte — ci dà l'immagine adesso e
 * rimette in sesto anche "Classifiche" nella Home. Una volta sola per
 * sessione: la cache del server dura 24h.
 *
 * UNA ALLA VOLTA, non tre come fa il prototipo. _refresh_sync in
 * app/charts.py fa _load() → data[slug] = … → _save() su un unico
 * charts.json SENZA lock: due refresh in parallelo leggono lo stesso
 * dizionario e l'ultimo che salva cancella l'altro. Con tre operai in
 * parallelo la cache resta con 2-3 classifiche su 26 — verificato il
 * 19/09. In sequenza ogni salvataggio parte dal file appena scritto e la
 * cache si ricompone da sola. */
let _copertineGeneriFatte = false;
async function riempiCopertineGeneri(charts) {
  if (_copertineGeneriFatte) return;
  const mancanti = (charts || []).filter((c) => c && c.slug && !c.cover_url);
  if (!mancanti.length) return;
  _copertineGeneriFatte = true;
  let i = 0;
  const operaio = async () => {
    while (i < mancanti.length) {
      const c = mancanti[i++];
      try {
        const d = await apiJson(`/api/charts/${encodeURIComponent(c.slug)}`);
        const primo = (d.tracks || [])[0] || {};
        const url = primo.cover_hd_url || primo.cover_url;
        if (!url) continue;
        c.cover_url = url; // così un nuovo render non la richiede di nuovo
        const art = document.querySelector(
          `#generiGrid .genere-tile[data-slug="${CSS.escape(c.slug)}"] .genere-art`
        );
        if (art) {
          art.classList.remove("genere-art-vuota");
          lazyLoadCover(art, proxiedCover(url));
        }
      } catch (_) {
        /* una classifica che non risponde non deve fermare le altre */
      }
    }
  };
  await operaio();
}

function renderGeneri(charts) {
  const griglia = document.getElementById("generiGrid");
  if (!griglia) return;
  releaseLazyCovers(griglia);
  griglia.innerHTML = "";
  (charts || []).forEach((c, i) => griglia.appendChild(buildGenereTile(c, i)));
  riempiCopertineGeneri(charts);
  // la visibilità la decide sempre l'intestazione: dipende dalla query
  aggiornaIntestazioneCerca(homeSearchInput ? homeSearchInput.value : "");
}
const homeEmptyState = $("#homeEmptyState");
const homeSearchInput = $("#homeSearchInput");
let openPlaylistOwnerId = null; // se valorizzato: dettaglio playlist di un altro utente (via Home)
let _openPlaylistFull = null; // risposta completa /api/playlists/{pid} aperta ora (per il download offline)
let _openHomePlaylistFull = null; // idem, per la playlist di un altro utente aperta ora
const viewSearch = $("#viewSearch");
const viewLibrary = $("#viewLibrary");
const btnLibBack = $("#btnLibBack");
const btnLibPlay = $("#btnLibPlay");
const libIcoPlay = $("#libIcoPlay");
const libIcoPause = $("#libIcoPause");
const btnLibShuffle = $("#btnLibShuffle");
const viewArtist = $("#viewArtist");
const loadingOverlay = $("#loadingOverlay");
const loadingOverlayClose = $("#loadingOverlayClose");
// _loadingGen: chi apre l'overlay prende un numero; hideLoadingOverlay(gen)
// nasconde solo se nessun'altra apertura più recente ha già preso il
// controllo — altrimenti l'X premuta su un caricamento, seguita subito da
// un altro tap, nasconderebbe l'overlay del NUOVO caricamento invece che
// lasciare che finisca il suo (bug altrimenti reale, non solo teorico: la X
// chiude visivamente prima che il fetch abortito sollevi la sua eccezione).
let _loadingGen = 0;
let _loadingAbortController = null;

/** opts.tonda: lo scheletro da telefono con la copertina tonda (artista). */
function showLoadingOverlay(opts) {
  if (loadingOverlay) {
    loadingOverlay.classList.toggle("lsk-tonda", !!(opts && opts.tonda));
    // anche lo scheletro entra dal lato dello swipe, se c'è
    loadingOverlay.dataset.entrata = _classeEntrata;
    loadingOverlay.classList.remove("hidden");
  }
  document.documentElement.classList.add("crk-caricando");
  const gen = ++_loadingGen;
  _loadingAbortController = typeof AbortController !== "undefined" ? new AbortController() : null;
  return { signal: _loadingAbortController ? _loadingAbortController.signal : null, gen };
}
function hideLoadingOverlay(gen) {
  if (gen !== undefined && gen !== _loadingGen) return;
  const eraAperto = loadingOverlay && !loadingOverlay.classList.contains("hidden");
  if (loadingOverlay) loadingOverlay.classList.add("hidden");
  document.documentElement.classList.remove("crk-caricando");
  // da telefono al posto del velo c'è lo scheletro della pagina (vedi
  // .loading-scheletro): togliendolo, il contenuto arrivato entra in
  // dissolvenza come nel prototipo invece di comparire di scatto
  if (eraAperto && window.innerWidth < 901) rianimaVistaVisibile();
  // una tappa rifatta dallo swipe finisce qui, se aveva da caricare
  _classeEntrata = "view-enter";
}
/** Rifà l'entrata della vista visibile senza toccare lo scorrimento
 * (revealView lo azzera: qui serve anche quando si annulla e si resta). */
function rianimaVistaVisibile() {
  const v = [viewArtist, viewPlaylists, viewLibrary, viewHome, viewSearch, viewQueue].find(
    (x) => x && !x.classList.contains("hidden")
  );
  if (v) entraVista(v);
}
/** Rifà l'animazione d'entrata: fade+risalita di solito, da sinistra/destra
 * quando lo swipe rifà una tappa (_classeEntrata). Le tre classi vanno tolte
 * tutte: .view.view-enter è più specifica di .back-enter e la batterebbe. */
function entraVista(el) {
  el.classList.remove("view-enter", "back-enter", "fwd-enter");
  void el.offsetWidth; // forza reflow: ri-attiva la keyframe anche se la classe c'era già
  el.classList.add(_classeEntrata);
}
function cancelLoadingOverlay() {
  if (_loadingAbortController) {
    try {
      _loadingAbortController.abort();
    } catch (_) {}
  }
  hideLoadingOverlay(_loadingGen);
}
if (loadingOverlayClose) {
  loadingOverlayClose.addEventListener("click", cancelLoadingOverlay);
}
// preparazione sessione JARVIS: overlay dedicato (nero+arancione, barre a
// riposo) invece del loadingOverlay generico riusato da artista/album —
// vedi .jarvis-loading-overlay in style.css e openDjSheet più sotto.
const jarvisLoadingOverlay = $("#jarvisLoadingOverlay");
const jarvisLoadingOverlayClose = $("#jarvisLoadingOverlayClose");
// impostata da openDjSheet subito prima di avviare una sessione nuova,
// azzerata dopo reveal() — la X qui sopra la richiama per saltare l'attesa
// (stesso ruolo di cancelLoadingOverlay, ma senza abort: startJarvisSession
// non è cancellabile, continua in background e lo sheet si apre comunque
// quando sarà pronto).
let _jarvisLoadingSkip = null;
function showJarvisLoadingOverlay() {
  if (jarvisLoadingOverlay) jarvisLoadingOverlay.classList.remove("hidden");
}
function hideJarvisLoadingOverlay() {
  if (jarvisLoadingOverlay) jarvisLoadingOverlay.classList.add("hidden");
}
if (jarvisLoadingOverlayClose) {
  jarvisLoadingOverlayClose.addEventListener("click", () => {
    if (_jarvisLoadingSkip) _jarvisLoadingSkip();
  });
}
const btnArtistBack = $("#btnArtistBack");
const artistHeroCover = $("#artistHeroCover");
const artistHeroTitle = $("#artistHeroTitle");
const artistKicker = $("#artistKicker");
let _detailKind = "artist"; // "artist" | "album" — quale endpoint/etichetta usare per la pagina aperta ora in viewArtist (riusata per entrambi, vedi openDetailPage)
let _detailPrevKind = null; // dettaglio precedente (es. artista da cui si è aperto un album), per il tasto indietro
let _detailPrevId = null;
const artistStatus = $("#artistStatus");
const artistTracksEl = $("#artistTracks");
const artistShowAllBtn = $("#artistShowAllBtn");
const artistFill = $("#artistFill");
const artistFillBar = $("#artistFillBar");
const artistFillLabel = $("#artistFillLabel");
const artistAlbumsSection = $("#artistAlbumsSection");
const artistAlbumsGrid = $("#artistAlbumsGrid");
const ARTIST_COLLAPSED_COUNT = 5;
/* Quante righe prima di "Mostra tutti": 5 sul telefono, 10 da desktop, dove
 * la tabella ha spazio (Vitto 30/09). Letta ogni volta invece che fissata al
 * caricamento, così vale anche se la finestra cambia larghezza. */
function artistCollapsedCount() {
  return window.innerWidth >= 901 ? 10 : ARTIST_COLLAPSED_COUNT;
}
const artistTracksModal = $("#artistTracksModal");
const artistTracksModalTitle = $("#artistTracksModalTitle");
const artistTracksModalList = $("#artistTracksModalList");
const artistTracksModalSearch = $("#artistTracksModalSearch");
const artistTracksModalClear = $("#artistTracksModalClear");
const btnArtistFollow = $("#btnArtistFollow");
const artistAntiBanGroup = $("#artistAntiBanGroup");
const artistAntiBanInfo = $("#artistAntiBanInfo");
const artistAntiBanPopover = $("#artistAntiBanPopover");
const artistAntiBan = $("#artistAntiBan");
let _artistTracks = [];
// polling del completamento catalogo artista (vedi startArtistCatalogFill)
let _artistFillTimer = null;
let _artistFillId = null;
let openArtistId = null;
let _artistPrevView = null; // view da cui si è aperta la pagina artista, per il tasto indietro
let _artistPrevTopbarVisible = true;
const viewQueue = $("#viewQueue");
const viewPlaylists = $("#viewPlaylists");
const plList = $("#plList");
const plTracks = $("#plTracks");
const plTrackSearchWrap = $("#plTrackSearchWrap");
const plTrackSearch = $("#plTrackSearch");
const plTrackSearchClear = $("#plTrackSearchClear");
const plTitle = $("#plTitle");
const plStatus = $("#plStatus");
const plLoadingSpinner = $("#plLoadingSpinner");
const plGridHead = $("#plGridHead");
const plLibSearchWrap = $("#plLibSearchWrap");
const plLibSearch = $("#plLibSearch");
// tieni-premuto per aprire il menu ⋮ (rinomina/copertina/elimina) sulle
// righe playlist in "La tua libreria" — vedi loadPlaylists.
const PL_ROW_LONG_PRESS_MS = 450;
const PL_ROW_LONG_PRESS_MOVE_TOLERANCE = 10;
const plLibSearchClear = $("#plLibSearchClear");
const plHero = $("#plHero");
const plActionRow = $("#plActionRow");
const plHeroCover = $("#plHeroCover");
const plHeroTitle = $("#plHeroTitle");
const plHeroMeta = $("#plHeroMeta");
const plHeroAvatar = $("#plHeroAvatar");
const plHeroMetaText = $("#plHeroMetaText");
const libHeroAvatar = $("#libHeroAvatar");
const libHeroMetaText = $("#libHeroMetaText");
const btnPlCreate = $("#btnPlCreate");
const btnPlBack = $("#btnPlBack");
const btnPlPlay = $("#btnPlPlay");
const btnPlShuffle = $("#btnPlShuffle");
// pagina artista: play, shuffle e lente come nelle playlist (solo desktop,
// vedi #btnArtistPlay in style.css)
const btnArtistPlay = $("#btnArtistPlay");
const btnArtistShuffle = $("#btnArtistShuffle");
const artistTrackSearch = $("#artistTrackSearch");
const artistTrackSearchClear = $("#artistTrackSearchClear");
/** Il bottone "scarica offline" esiste in due copie identiche (playlist e
 * Brani salvati): un widget raccoglie i pezzi di UNA copia, così le stesse
 * funzioni pilotano entrambe senza duplicare la logica. */
function offlineWidget(prefix) {
  return {
    btn: $(`#btn${prefix}Offline`),
    icoDownload: $(`#${prefix.toLowerCase()}OfflineIcoDownload`),
    icoDone: $(`#${prefix.toLowerCase()}OfflineIcoDone`),
    progress: $(`#${prefix.toLowerCase()}OfflineProgress`),
    ring: $(`#${prefix.toLowerCase()}OfflineRing`),
    ringFg: $(`#${prefix.toLowerCase()}OfflineRingFg`),
    fidCheck: $(`#${prefix.toLowerCase()}OfflineFidCheck`),
    fidCircle: $(`#${prefix.toLowerCase()}OfflineFidCircle`),
    checkLen: null,
  };
}
const plOfflineW = offlineWidget("Pl");
const libOfflineW = offlineWidget("Lib");
const RING_CIRCUMFERENCE = 2 * Math.PI * 15.5;
const btnPlAdopt = $("#btnPlAdopt");
const plAntiBanGroup = $("#plAntiBanGroup");
const plAntiBan = $("#plAntiBan");
const plAntiBanInfo = $("#plAntiBanInfo");
const plAntiBanPopover = $("#plAntiBanPopover");
const plModal = $("#plModal");
const plModalList = $("#plModalList");
const plModalTrack = $("#plModalTrack");
const plModalNewName = $("#plModalNewName");
const plModalCreate = $("#plModalCreate");
const plModalClose = $("#plModalClose");

let openPlaylistId = null;
let pendingAddToPl = null; // { library_id?, token?, title, artist }

let currentSearchId = null;
let loadingIndex = null;
let paging = false;
let pageState = { page: 1, has_next: false, has_prev: false };
let seekDragging = false;
let lastVolume = 0.8;
let playBusy = false;
// indice in queue.items ancora in fase di resolve/rete (non ancora confermato
// "sta suonando per davvero") — pilota .resolving vs .playing sulla riga
// corrente della coda, vedi playQueueIndex/playQueueItem/appendQueueRow.
// Richiesta di Vitto, 2026-08-04: prima .playing scattava SUBITO al click
// (solo perché queue.index era già cambiato), ben prima che il brano fosse
// davvero pronto — nessun feedback del buco di caricamento.
let _queueResolvingIndex = -1;

/** Coda stile Spotify: history + current + upcoming */
const queue = {
  items: [], // QueueItem[]
  index: -1, // current index
};

/**
 * QueueItem:
 * { qid, source: 'search'|'library',
 *   title, artist, duration, cover_url,
 *   search_id?, index?,   // search
 *   id?, stream_url?      // library
 * }
 */

let nowPlaying = {
  token: null,
  libraryId: null,
  title: "",
  artist: "",
  saved: false,
};

/** Ricorda l'ultimo brano avviato (qualunque source) tra un riavvio e
 * l'altro dell'app — Vitto: al boot la mini bar mostrava sempre "Nessun
 * brano" invece di riprendere da dove si era interrotto, come Spotify. */
const LAST_TRACK_KEY = "crackify.lastTrack";
function saveLastTrack(item) {
  try {
    localStorage.setItem(LAST_TRACK_KEY, JSON.stringify(item));
  } catch (_) {}
}
function loadLastTrack() {
  try {
    const raw = localStorage.getItem(LAST_TRACK_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}
/** Item ripristinato mostrato in mini bar ma non ancora ricaricato/risolto
 * per davvero — il primo tap su play (vedi togglePlayPause) lo passa a
 * playQueueItem come se fosse appena stato scelto dall'utente. */
let _pendingRestoredTrack = null;
function restoreLastTrackDisplay() {
  if (queue.items.length) return; // coda già viva: niente da ripristinare
  const item = loadLastTrack();
  if (!item) return;
  _pendingRestoredTrack = item;
  nowTitle.textContent = item.title || "Nessun brano";
  nowArtist.textContent = item.artist || "";
  setCover(item.cover_url || null, item.cover_hd_url || item.cover_url || null);
  setLikeUi(!!item.saved);
  syncNowPlayingSheetMeta();
  setStatus("Tocca ▶ per riprendere");
  btnPlay.disabled = false;
  if (npPlay) npPlay.disabled = false;
}

/** Griglia fissa in cima alla Home (scorciatoie stile Spotify, vedi
 * loadHomeQuickGrid) — slot 3/4/5 leggono qui. "aperta" = qualunque playlist/
 * chart/deezer-playlist, "cercata" = stesso ma mentre il filtro ricerca Home
 * era attivo (vedi isHomeSearchActive), tracciate separatamente perché
 * spesso coincidono e in quel caso lo slot 4 mostra altro (vedi Vitto). */
const LAST_OPENED_PLAYLIST_KEY = "crackify.lastOpenedPlaylist";
const LAST_SEARCHED_PLAYLIST_KEY = "crackify.lastSearchedPlaylist";
const LAST_ARTIST_KEY = "crackify.lastArtist";

function _saveJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (_) {}
}
function _loadJson(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

function recordPlaylistOpen(descriptor) {
  _saveJson(LAST_OPENED_PLAYLIST_KEY, descriptor);
  if (typeof isHomeSearchActive === "function" && isHomeSearchActive()) {
    _saveJson(LAST_SEARCHED_PLAYLIST_KEY, descriptor);
  }
}

/** Ripesca una cover_url fresca per uno slot lastOpened/lastSearched la
 * cui immagine salvata ha smesso di funzionare (Vitto: "magari un sistema
 * di auto refresh dei link", 2026-07-31) — stessa chiamata che si farebbe
 * aprendo per davvero quella cosa (vedi openDeezerPlaylist/openChart),
 * qui solo per rinfrescare l'anteprima. null se il kind non è tra quelli
 * gestiti (es. "artist"/"daily_mix") o la richiesta fallisce — chi chiama
 * degrada al placeholder in quel caso. */
async function refreshSlotCoverUrl(slot) {
  try {
    if (slot.kind === "deezer") {
      const data = await apiJson(`/api/deezer/playlists/${slot.id}`);
      const t = (data.tracks || [])[0];
      return (t && (t.cover_hd_url || t.cover_url)) || null;
    }
    if (slot.kind === "chart") {
      const data = await apiJson(`/api/charts/${slot.id}`);
      const t = (data.tracks || [])[0];
      return (t && (t.cover_hd_url || t.cover_url)) || null;
    }
  } catch (_) {}
  return null;
}

/** Aggiorna lo snapshot in localStorage con la cover fresca, così anche il
 * PROSSIMO caricamento di Home parte già con l'URL giusto invece di dover
 * rifallire e re-ripescare ogni volta. */
function updateStoredSlotCover(slot, freshCoverUrl) {
  for (const key of [LAST_OPENED_PLAYLIST_KEY, LAST_SEARCHED_PLAYLIST_KEY]) {
    const stored = _loadJson(key);
    if (stored && stored.kind === slot.kind && String(stored.id) === String(slot.id)) {
      _saveJson(key, { ...stored, coverUrl: freshCoverUrl });
    }
  }
}

function recordArtistOpen(descriptor) {
  _saveJson(LAST_ARTIST_KEY, descriptor);
}

let toastTimer = null;

// SVG cuore con riempimento a onde (clipPath unico per istanza)
let _heartClipSeq = 0;
const HEART_PATH =
  "M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z";

function heartFillMarkup(size = 16) {
  const id = `hc${++_heartClipSeq}`;
  // Onde smooth (periodo 12): loop translateX(-12)
  const waveA =
    "M-24 4 Q-21 1 -18 4 T-12 4 T-6 4 T0 4 T6 4 T12 4 T18 4 T24 4 T30 4 T36 4 V28 H-24Z";
  const waveB =
    "M-24 5 Q-21 7.5 -18 5 T-12 5 T-6 5 T0 5 T6 5 T12 5 T18 5 T24 5 T30 5 T36 5 V28 H-24Z";
  return `<svg class="heart-anim" viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true">
    <defs><clipPath id="${id}"><path d="${HEART_PATH}"/></clipPath></defs>
    <path class="heart-shell" d="${HEART_PATH}" fill="currentColor"/>
    <path class="heart-outline" d="${HEART_PATH}" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linejoin="round"/>
    <g clip-path="url(#${id})">
      <g class="heart-liquid">
        <g class="heart-waves">
          <path class="hw hw-a" d="${waveA}"/>
          <path class="hw hw-b" d="${waveB}"/>
        </g>
      </g>
    </g>
  </svg>`;
}

function iconHeart(filled) {
  // pieno solido (liste salvati) vs outline/fillable
  if (filled) {
    return `<svg class="heart-solid" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="${HEART_PATH}"/></svg>`;
  }
  return heartFillMarkup(16);
}

/** Avvia riempimento a onde (in parallelo al download server) */
function startHeartFill(...btns) {
  for (const b of btns) {
    if (!b) continue;
    b.classList.remove("on", "fill-done", "fill-fail", "fill-pop");
    b.classList.add("filling", "busy");
  }
}

/** Fine salvataggio: completa fill + pop, oppure scarica su errore */
function endHeartFill(success, ...btns) {
  for (const b of btns) {
    if (!b) continue;
    b.classList.remove("filling", "busy");
    if (success) {
      b.classList.add("on", "fill-done", "fill-pop");
      window.setTimeout(() => b.classList.remove("fill-pop", "fill-done"), 520);
    } else {
      b.classList.add("fill-fail");
      b.classList.remove("on");
      window.setTimeout(() => b.classList.remove("fill-fail"), 420);
    }
  }
}
function iconPlaylistAdd() {
  return `<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M1 2.75A.75.75 0 0 1 1.75 2h8.5a.75.75 0 0 1 0 1.5h-8.5A.75.75 0 0 1 1 2.75zm0 5A.75.75 0 0 1 1.75 7h5.5a.75.75 0 0 1 0 1.5h-5.5A.75.75 0 0 1 1 7.75zM1.75 12a.75.75 0 0 0 0 1.5h3.5a.75.75 0 0 0 0-1.5h-3.5z"/><path d="M12 6a.75.75 0 0 1 .75.75v1.5h1.5a.75.75 0 0 1 0 1.5h-1.5v1.5a.75.75 0 0 1-1.5 0v-1.5h-1.5a.75.75 0 0 1 0-1.5h1.5v-1.5A.75.75 0 0 1 12 6z"/></svg>`;
}

// —— toast (+ undo opzionale) ——
let toastActionHandler = null;

/**
 * @param {string} msg
 * @param {{ duration?: number, actionLabel?: string, onAction?: () => void }} [opts]
 */
function toast(msg, opts = {}) {
  const duration = opts.duration != null ? opts.duration : 1800;
  let el = document.querySelector(".toast");
  if (!el) {
    el = document.createElement("div");
    el.className = "toast";
    document.body.appendChild(el);
  }
  el.innerHTML = "";
  el.classList.remove("toast-undo", "show");
  el.classList.toggle("toast-wrap", !!opts.wrap);
  // reflow per riavviare anim progress
  void el.offsetWidth;

  const msgEl = document.createElement("span");
  msgEl.className = "toast-msg";
  msgEl.textContent = msg;
  el.appendChild(msgEl);

  toastActionHandler = null;
  if (opts.actionLabel && typeof opts.onAction === "function") {
    el.classList.add("toast-undo");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "toast-action";
    btn.textContent = opts.actionLabel;
    toastActionHandler = opts.onAction;
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const fn = toastActionHandler;
      toastActionHandler = null;
      clearTimeout(toastTimer);
      el.classList.remove("show", "toast-undo");
      if (fn) fn();
    });
    el.appendChild(btn);
    const bar = document.createElement("span");
    bar.className = "toast-progress";
    bar.style.animationDuration = `${duration}ms`;
    el.appendChild(bar);
  }

  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove("show", "toast-undo");
    toastActionHandler = null;
  }, duration);
}

// —— unsave con undo ——
// IMPORTANTE: il server (e i file in crackify/) vengono toccati SOLO
// dopo la scadenza di UNDO_MS. Fino ad allora l'API DELETE non parte.
const UNDO_MS = 3000;
/** @type {Map<string, { track: object, index: number, timer: any }>} */
const pendingLibraryRemoves = new Map();

function restoreLibraryTrack(entry) {
  if (!entry || !entry.track) return;
  const id = entry.track.id;
  if (libraryTracksCache.some((x) => x.id === id)) {
    // già in lista
  } else {
    const i = Math.max(0, Math.min(entry.index | 0, libraryTracksCache.length));
    libraryTracksCache.splice(i, 0, entry.track);
  }
  if (
    nowPlaying &&
    (nowPlaying.libraryId === id ||
      (nowPlaying.title === entry.track.title &&
        nowPlaying.artist === entry.track.artist))
  ) {
    nowPlaying.libraryId = id;
    setLikeUi(true);
  }
  if (!viewLibrary.classList.contains("hidden")) applyLibraryFilter();
}

/** Annulla remove in sospeso: NESSUNA delete server, file intatti */
function cancelPendingLibraryRemove(trackId, { toastMsg } = {}) {
  const entry = pendingLibraryRemoves.get(trackId);
  if (!entry) return false;
  clearTimeout(entry.timer);
  pendingLibraryRemoves.delete(trackId);
  restoreLibraryTrack(entry);
  if (toastMsg !== false) {
    toast(toastMsg || "Annullato · di nuovo nei salvati");
  }
  return true;
}

function undoLibraryRemove(trackId) {
  if (!cancelPendingLibraryRemove(trackId)) {
    toast("Troppo tardi per annullare");
  }
}

/**
 * Se stai per salvare di nuovo un pezzo con remove in sospeso,
 * cancella il timer (i file non devono sparire).
 */
function cancelPendingRemoveMatching(trackLike) {
  if (!trackLike) return false;
  if (trackLike.id && pendingLibraryRemoves.has(trackLike.id)) {
    return cancelPendingLibraryRemove(trackLike.id, {
      toastMsg: "Di nuovo nei salvati",
    });
  }
  const title = (trackLike.title || "").toLowerCase();
  const artist = (trackLike.artist || "").toLowerCase();
  for (const [id, entry] of pendingLibraryRemoves) {
    const t = entry.track || {};
    if (
      (t.title || "").toLowerCase() === title &&
      (t.artist || "").toLowerCase() === artist
    ) {
      return cancelPendingLibraryRemove(id, { toastMsg: "Di nuovo nei salvati" });
    }
  }
  return false;
}

/** Esegue la DELETE server (file inclusi) — solo a fine undo / pagehide */
async function commitLibraryRemove(trackId) {
  const entry = pendingLibraryRemoves.get(trackId);
  if (entry) {
    clearTimeout(entry.timer);
    pendingLibraryRemoves.delete(trackId);
  }
  await apiJson(`/api/library/${trackId}`, null, "DELETE");
  if (nowPlaying.libraryId === trackId && !nowPlaying.saved) {
    nowPlaying.libraryId = null;
  }
}

/**
 * UI: togli subito dai salvati.
 * Server/file: solo dopo UNDO_MS se non c’è Annulla.
 */
function scheduleLibraryRemove(track) {
  if (!track || !track.id) return;

  // già in coda undo → non toccare il server, resetta solo il timer
  const prev = pendingLibraryRemoves.get(track.id);
  if (prev) {
    clearTimeout(prev.timer);
    pendingLibraryRemoves.delete(track.id);
    // riusa lo snapshot precedente (più completo)
    track = prev.track;
  }

  const index = libraryTracksCache.findIndex((x) => x.id === track.id);
  const snap = { ...track };
  const entry = {
    track: snap,
    index: index >= 0 ? index : 0,
    timer: null,
  };

  // ⏱ unica chiamata server (DELETE + file): solo a scadenza undo
  entry.timer = setTimeout(() => {
    commitLibraryRemove(track.id).catch((err) => {
      // delete fallita → brano resta su disco, rimettilo in UI
      restoreLibraryTrack(entry);
      toast("Errore rimozione: " + (err.message || err));
    });
  }, UNDO_MS);
  pendingLibraryRemoves.set(track.id, entry);

  // solo UI / cache locale
  if (index >= 0) {
    libraryTracksCache = libraryTracksCache.filter((x) => x.id !== track.id);
  }
  if (nowPlaying.libraryId === track.id) {
    setLikeUi(false);
    nowPlaying.libraryId = track.id;
    nowPlaying.saved = false;
  }
  if (!viewLibrary.classList.contains("hidden")) applyLibraryFilter();

  const title = (track.title || "Brano").trim();
  toast(`${title} rimosso dai salvati`, {
    duration: UNDO_MS,
    actionLabel: "Annulla",
    onAction: () => undoLibraryRemove(track.id),
  });
}

/** Rimozione da playlist (swipe sinistra su un brano) con "Annulla" —
 * stesso pattern di scheduleLibraryRemove: la riga sparisce subito ma la
 * DELETE vera parte solo se non annulli entro UNDO_MS. */
const pendingPlaylistTrackRemoves = new Map();

function schedulePlaylistTrackRemove(pid, track, wrapEl) {
  const key = `${pid}:${track.id}`;
  const prev = pendingPlaylistTrackRemoves.get(key);
  if (prev) clearTimeout(prev.timer);

  if (wrapEl) wrapEl.classList.add("q-removed-collapse");

  const timer = setTimeout(async () => {
    pendingPlaylistTrackRemoves.delete(key);
    try {
      await apiJson(`/api/playlists/${pid}/tracks/${track.id}`, null, "DELETE");
      if (openPlaylistId === pid) openPlaylist(pid);
    } catch (err) {
      toast("Errore rimozione: " + (err.message || err));
      if (openPlaylistId === pid) openPlaylist(pid);
    }
  }, UNDO_MS);
  pendingPlaylistTrackRemoves.set(key, { timer, pid, trackId: track.id });

  const title = (track.title || "Brano").trim();
  toast(`${title} rimosso dalla playlist`, {
    duration: UNDO_MS,
    actionLabel: "Annulla",
    onAction: () => {
      const entry = pendingPlaylistTrackRemoves.get(key);
      if (!entry) return;
      clearTimeout(entry.timer);
      pendingPlaylistTrackRemoves.delete(key);
      // niente DELETE mai partita: basta ridisegnare per far riapparire la riga
      if (openPlaylistId === pid) openPlaylist(pid);
    },
  });
}

// chiusura tab: commit delle delete ancora in sospeso (altrimenti restano file orfani in UI)
window.addEventListener("pagehide", () => {
  for (const [key, entry] of [...pendingPlaylistTrackRemoves.entries()]) {
    clearTimeout(entry.timer);
    pendingPlaylistTrackRemoves.delete(key);
    try {
      fetch(apiUrl(`/api/playlists/${entry.pid}/tracks/${entry.trackId}`), {
        method: "DELETE",
        keepalive: true,
        headers: authHeaders(),
        credentials: "same-origin",
      });
    } catch (_) {}
  }
  for (const [id, entry] of [...pendingLibraryRemoves.entries()]) {
    clearTimeout(entry.timer);
    pendingLibraryRemoves.delete(id);
    try {
      fetch(apiUrl(`/api/library/${id}`), {
        method: "DELETE",
        keepalive: true,
        headers: authHeaders(),
        credentials: "same-origin",
      });
    } catch (_) {}
  }
});

// —— utils ——
function fmtTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const s = Math.floor(sec % 60);
  const m = Math.floor(sec / 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

function setPlayerEnabled(on) {
  btnPlay.disabled = !on;
  seek.disabled = !on;
  volume.disabled = !on;
  btnMute.disabled = !on;
  btnLike.disabled = !on;
  btnAddPl.disabled = !on;
  if (npPlay) npPlay.disabled = !on;
  if (npSeek) npSeek.disabled = !on;
  if (npLike) npLike.disabled = !on;
  if (npAddPl) npAddPl.disabled = !on;
  if (npMore) npMore.disabled = !on;
  updateNavButtons();
}

function updateNavButtons() {
  const n = queue.items.length;
  const has = n > 0 && queue.index >= 0;
  // prev: sempre se c'è brano (restart o pezzo prima)
  btnPrev.disabled = !has || playBusy;
  // next: pezzo dopo, oppure loop all, oppure shuffle con altri pezzi
  let canNext = false;
  if (has && !playBusy) {
    if (repeatMode === 2) canNext = true; // one: next = restart / avanza
    else if (repeatMode === 1 && n > 0) canNext = true;
    else if (shuffleOn && n > 1) canNext = true;
    // JARVIS accoda il gruppo successivo solo IN REAZIONE a uno skip/fine
    // (jarvisHandleTrackLeft → jarvisAdvanceToNextGroup, vedi sopra), non
    // in anticipo — un bucket poco popolato (es. un artista con un solo
    // brano nel pool) genera un gruppo da 1-2 tracce, e sull'ultima di
    // quel gruppo "queue.index < n-1" è correttamente falso. Ma un
    // pulsante disabilitato non genera mai il click che chiamerebbe
    // jarvisHandleTrackLeft: vicolo cieco, "skip" bloccato per sempre su
    // quel brano (bug segnalato da Vitto, 2026-08-01: "sono al primo
    // play... il pulsante skip è come disattivato" — gruppo di apertura
    // da 1 solo brano). Se c'è ancora almeno un gruppo in jarvisGroups lo
    // skip in realtà funzionerebbe (l'accodamento è sincrono, avviene
    // PRIMA che nextIndex() venga letto in playNext), va quindi abilitato
    // comunque. Quando jarvisGroups è vuoto per davvero (pool esaurito)
    // resta disabilitato come una coda normale finita.
    else canNext = queue.index < n - 1 || (jarvisSessionActive && jarvisGroups.length > 0);
  }
  btnNext.disabled = !canNext;
  btnShuffle.disabled = n < 2;
  btnRepeat.disabled = n < 1;
  if (npPrev) npPrev.disabled = btnPrev.disabled;
  if (npNext) npNext.disabled = btnNext.disabled;
  // in JARVIS npShuffle/npRepeat sono in realtà microfono/chat (vedi CSS
  // .jarvis-mode), azioni scollegate da "quanti brani ci sono in coda" —
  // seguire btnShuffle.disabled (n<2) qui rendeva il microfono
  // inutilizzabile ogni volta che la coda JARVIS aveva un solo brano
  // risolto, bug segnalato da Vitto 2026-08-07 ("non mi ha mandato il
  // popup", il tap non arrivava proprio: bottone disabled).
  const inJarvisMode = !!(npSheet && npSheet.classList.contains("jarvis-mode"));
  if (npShuffle) npShuffle.disabled = inJarvisMode ? false : btnShuffle.disabled;
  if (npRepeat) npRepeat.disabled = inJarvisMode ? false : btnRepeat.disabled;
}

function setPlayingUi(playing) {
  playerBar.classList.toggle("is-playing", playing);
  if (iconPlay && iconPause) {
    iconPlay.classList.toggle("hidden", playing);
    iconPause.classList.toggle("hidden", !playing);
  }
  btnPlay.title = playing ? "Pausa" : "Play";
  if (npIcoPlay && npIcoPause) {
    npIcoPlay.classList.toggle("hidden", playing);
    npIcoPause.classList.toggle("hidden", !playing);
  }
  if (npPlay) npPlay.title = playing ? "Pausa" : "Play";
  if (libIcoPlay && libIcoPause) {
    const q = queue.index >= 0 ? queue.items[queue.index] : null;
    const libraryPlaying = playing && q && q.source === "library";
    libIcoPlay.classList.toggle("hidden", libraryPlaying);
    libIcoPause.classList.toggle("hidden", !libraryPlaying);
    if (btnLibPlay) btnLibPlay.title = libraryPlaying ? "Pausa" : "Riproduci brani salvati";
    // l'etichetta dentro il tasto (solo desktop) segue l'icona, altrimenti
    // si leggerebbe "Riproduci" con sopra il simbolo di pausa
    const etichetta = document.getElementById("libPlayLabel");
    if (etichetta) etichetta.textContent = libraryPlaying ? "Pausa" : "Riproduci";
  }
  if ("mediaSession" in navigator) {
    try {
      navigator.mediaSession.playbackState = playing ? "playing" : "paused";
    } catch (_) {}
  }
}

/**
 * Titolo/artista/copertina reali su lock screen, Control Center, AirPods,
 * CarPlay (schermata "Now Playing" generica di iOS) — senza questo, iOS
 * mostra solo il nome dell'app e i controlli generici "salta 10s".
 */
function updateMediaSessionMetadata() {
  const title = nowPlaying.title || nowTitle?.textContent || "CRACKIFY";
  const artist = nowPlaying.artist || nowArtist?.textContent || "";
  const artworkUrl = _lastCoverHd || _lastCoverThumb || "";
  if (_nativeAudioPlugin) {
    _nativeAudioPlugin.setNowPlaying({ title, artist, artwork: artworkUrl }).catch(() => {});
    return;
  }
  if (!("mediaSession" in navigator)) return;
  const artwork = artworkUrl
    ? [
        { src: artworkUrl, sizes: "512x512" },
        { src: artworkUrl, sizes: "256x256" },
        { src: artworkUrl, sizes: "96x96" },
      ]
    : [];
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title,
      artist,
      album: "CRACKIFY",
      artwork,
    });
  } catch (_) {}
}

/**
 * Comandi dal controller musicale (lock screen, Centro di Controllo, AirPods).
 * Su web arrivano da navigator.mediaSession; nell'app iOS dal plugin
 * NativeAudio, che play/pausa li ha GIÀ eseguiti da sé ("handled": il
 * WebView può essere ancora sospeso quando arriva il tasto) e ci avvisa solo
 * per allineare sync e mirror. play/pause espliciti, non toggle: dopo
 * un'interruzione lo stato che iOS crede di avere può essere sfasato dal
 * nostro.
 */
function remoteCommand(cmd, arg, handled = false) {
  try {
    if (cmd === "play") {
      if (handled) {
        if (remoteMirror) {
          audio.pause();
          togglePlayPause();
        } else {
          claimThisPlayer();
          setConnectIconState(true);
        }
      } else if (remoteMirror || audio.paused) togglePlayPause();
    } else if (cmd === "pause") {
      if (!handled && !remoteMirror && !audio.paused) togglePlayPause();
    } else if (cmd === "next") playNext();
    else if (cmd === "prev") playPrev();
    else if (cmd === "seek" && arg != null) guardedSeek(Math.max(0, Number(arg)));
  } catch (_) {}
}
if (_nativeAudioPlugin) {
  _nativeAudioPlugin.addListener("remote", (e) => remoteCommand(e && e.cmd, null, !!(e && e.handled)));
}

function setupMediaSessionActions() {
  // nell'app iOS il controller lo gestisce il plugin NativeAudio: se
  // WebKit registrasse anche i suoi handler si contenderebbero il Now Playing
  if (_nativeAudioPlugin || !("mediaSession" in navigator)) return;
  // ogni setActionHandler nel suo try/catch: se un'azione non è supportata
  // da questa versione iOS/Safari lancia e NON deve bloccare le altre.
  const setAction = (name, handler) => {
    try {
      navigator.mediaSession.setActionHandler(name, handler);
    } catch (_) {}
  };
  setAction("play", () => remoteCommand("play"));
  setAction("pause", () => remoteCommand("pause"));
  setAction("previoustrack", () => remoteCommand("prev"));
  setAction("nexttrack", () => remoteCommand("next"));
  setAction("seekto", (details) => {
    if (details && details.seekTime != null) remoteCommand("seek", details.seekTime);
  });
  // iOS mostra "salta 10s" di default finché seekforward/seekbackward
  // non vengono esplicitamente disattivati — con previoustrack/nexttrack
  // attivi E questi disattivati, mostra le frecce salta-brano.
  setAction("seekforward", null);
  setAction("seekbackward", null);
}
setupMediaSessionActions();

function rebuildShuffleOrder() {
  const n = queue.items.length;
  const cur = queue.index;
  if (n <= 0) {
    shuffleOrder = [];
    return;
  }
  // Spotify-like: current → user queue (ordine FIFO) → resto mescolato
  const userNext = [];
  const rest = [];
  for (let i = 0; i < n; i++) {
    if (i === cur) continue;
    if (cur >= 0 && i > cur && queue.items[i].userQueued) userNext.push(i);
    else rest.push(i);
  }
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  shuffleOrder = (cur >= 0 ? [cur] : []).concat(userNext, rest);
}

function updateShuffleRepeatUi() {
  btnShuffle.classList.toggle("active", shuffleOn);
  btnShuffle.setAttribute("aria-pressed", shuffleOn ? "true" : "false");
  btnShuffle.title = shuffleOn ? "Shuffle: on" : "Shuffle: off";

  btnRepeat.classList.toggle("active", repeatMode > 0);
  btnRepeat.dataset.mode = String(repeatMode);
  if (iconRepeat && iconRepeatOne) {
    iconRepeat.classList.toggle("hidden", repeatMode === 2);
    iconRepeatOne.classList.toggle("hidden", repeatMode !== 2);
  }
  const titles = ["Ripeti: off", "Ripeti: tutta la coda", "Ripeti: brano"];
  btnRepeat.title = titles[repeatMode] || titles[0];
  btnRepeat.setAttribute("aria-pressed", repeatMode > 0 ? "true" : "false");

  if (npShuffle) {
    npShuffle.classList.toggle("active", shuffleOn);
    npShuffle.setAttribute("aria-pressed", shuffleOn ? "true" : "false");
  }
  if (npRepeat) {
    npRepeat.classList.toggle("active", repeatMode > 0);
    npRepeat.setAttribute("aria-pressed", repeatMode > 0 ? "true" : "false");
  }
  if (npIcoRepeat && npIcoRepeatOne) {
    npIcoRepeat.classList.toggle("hidden", repeatMode === 2);
    npIcoRepeatOne.classList.toggle("hidden", repeatMode !== 2);
  }
  if (qsShuffle) {
    qsShuffle.classList.toggle("active", shuffleOn);
    qsShuffle.setAttribute("aria-pressed", shuffleOn ? "true" : "false");
  }
  if (btnLibShuffle) {
    btnLibShuffle.classList.toggle("active", shuffleOn);
    btnLibShuffle.setAttribute("aria-pressed", shuffleOn ? "true" : "false");
    btnLibShuffle.title = shuffleOn ? "Shuffle: on" : "Shuffle: off";
  }
  if (btnPlShuffle) {
    btnPlShuffle.classList.toggle("active", shuffleOn);
    btnPlShuffle.setAttribute("aria-pressed", shuffleOn ? "true" : "false");
    btnPlShuffle.title = shuffleOn ? "Shuffle: on" : "Shuffle: off";
  }
  if (btnArtistShuffle) {
    btnArtistShuffle.classList.toggle("active", shuffleOn);
    btnArtistShuffle.setAttribute("aria-pressed", shuffleOn ? "true" : "false");
    btnArtistShuffle.title = shuffleOn ? "Shuffle: on" : "Shuffle: off";
  }
  if (qsRepeat) {
    qsRepeat.classList.toggle("active", repeatMode > 0);
    qsRepeat.setAttribute("aria-pressed", repeatMode > 0 ? "true" : "false");
  }
  if (qsIcoRepeat && qsIcoRepeatOne) {
    qsIcoRepeat.classList.toggle("hidden", repeatMode === 2);
    qsIcoRepeatOne.classList.toggle("hidden", repeatMode !== 2);
  }
}

function setLikeUi(saved) {
  nowPlaying.saved = !!saved;
  for (const btn of [btnLike, npLike]) {
    if (!btn) continue;
    btn.classList.toggle("on", !!saved);
    // non togliere fill-pop: serve al bounce di fine salvataggio
    btn.classList.remove("filling", "fill-fail", "busy");
    if (!saved) btn.classList.remove("fill-done", "fill-pop");
    btn.setAttribute("aria-pressed", saved ? "true" : "false");
  }
  btnLike.title = saved ? "Rimuovi dai salvati" : "Salva brano";
  if (npLike) npLike.title = saved ? "Rimuovi dai salvati" : "Salva";
}

function updateSeekUi() {
  const dur = audio.duration;
  const cur = audio.currentTime;
  const dragging = seekDragging || npSeekDragging;
  if (!dragging && Number.isFinite(dur) && dur > 0) {
    const ratio = cur / dur;
    const v = Math.round(ratio * 1000);
    seek.value = v;
    seekFill.style.width = `${ratio * 100}%`;
    if (npSeek) npSeek.value = v;
    if (npSeekFill) npSeekFill.style.width = `${ratio * 100}%`;
  }
  const curLabel = fmtTime(cur);
  const durLabel = Number.isFinite(dur) ? fmtTime(dur) : "0:00";
  timeCur.textContent = curLabel;
  timeDur.textContent = durLabel;
  if (npTimeCur) npTimeCur.textContent = curLabel;
  if (npTimeDur) npTimeDur.textContent = durLabel;
  try {
    if (audio.buffered.length && Number.isFinite(dur) && dur > 0) {
      const end = audio.buffered.end(audio.buffered.length - 1);
      const bw = `${Math.min(100, (end / dur) * 100)}%`;
      seekBuf.style.width = bw;
      if (npSeekBuf) npSeekBuf.style.width = bw;
    }
  } catch (_) {}
}

function updateVolUi() {
  const v = audio.muted ? 0 : audio.volume;
  volume.value = Math.round(v * 100);
  volFill.style.width = `${v * 100}%`;
  const levels = ["ico-vol-mute", "ico-vol-low", "ico-vol-med", "ico-vol-high"];
  let active = "ico-vol-high";
  if (audio.muted || v === 0) active = "ico-vol-mute";
  else if (v < 0.35) active = "ico-vol-low";
  else if (v < 0.7) active = "ico-vol-med";
  levels.forEach((cls) => {
    const el = btnMute.querySelector("." + cls);
    if (el) el.classList.toggle("hidden", cls !== active);
  });
  btnMute.title = audio.muted || v === 0 ? "Riattiva audio" : "Muto";
}

/** Tema full player / lyrics da copertina */
let _coverThemeGen = 0;
const COVER_THEME_DEFAULT = { r: 255, g: 106, b: 0 }; // brand orange

function clampByte(n) {
  return Math.max(0, Math.min(255, Math.round(n)));
}

function rgbStr(r, g, b, a) {
  if (a != null) return `rgba(${clampByte(r)},${clampByte(g)},${clampByte(b)},${a})`;
  return `rgb(${clampByte(r)},${clampByte(g)},${clampByte(b)})`;
}

function mixRgb(a, b, t) {
  return {
    r: a.r + (b.r - a.r) * t,
    g: a.g + (b.g - a.g) * t,
    b: a.b + (b.b - a.b) * t,
  };
}

function saturateRgb({ r, g, b }, amount) {
  const avg = (r + g + b) / 3;
  return {
    r: clampByte(avg + (r - avg) * amount),
    g: clampByte(avg + (g - avg) * amount),
    b: clampByte(avg + (b - avg) * amount),
  };
}

function relativeLuminance({ r, g, b }) {
  const lin = (c) => {
    c /= 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** Scala luminosità RGB verso un target (0–1 percettivo grezzo) */
function setLuminosity(rgb, targetLum) {
  const cur =
    (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255;
  if (cur < 0.001) {
    const v = clampByte(targetLum * 255);
    return { r: v, g: v, b: v };
  }
  const f = targetLum / cur;
  return {
    r: clampByte(rgb.r * f),
    g: clampByte(rgb.g * f),
    b: clampByte(rgb.b * f),
  };
}

/**
 * Tono di luminosità stile Spotify:
 * - top più luminoso (colore cover vivo)
 * - mid bilanciato
 * - bottom scuro
 * + overlay di luminosità uniforme
 */
function applyCoverTheme(rgb) {
  let base = saturateRgb(rgb || COVER_THEME_DEFAULT, 1.4);
  // normalizza luminosità base (né nero né bianco accecante)
  const rawLum = (0.299 * base.r + 0.587 * base.g + 0.114 * base.b) / 255;
  if (rawLum < 0.18) base = setLuminosity(base, 0.32);
  else if (rawLum > 0.72) base = setLuminosity(base, 0.48);

  // scala tonale (luminosità decrescente)
  const lift = setLuminosity(base, 0.58); // highlight alto
  const top = setLuminosity(base, 0.42);
  const mid = setLuminosity(base, 0.26);
  const bottom = setLuminosity(base, 0.1);
  const deep = mixRgb(bottom, { r: 0, g: 0, b: 0 }, 0.35);

  const accent = saturateRgb(setLuminosity(base, 0.55), 1.25);
  const accentHi = mixRgb(accent, { r: 255, g: 255, b: 255 }, 0.22);

  const glow = rgbStr(accent.r, accent.g, accent.b, 0.5);
  const glowSoft = rgbStr(accent.r, accent.g, accent.b, 0.28);
  // velo di luminosità (leggero bianco in alto → nero in basso)
  const lumTop = rgbStr(lift.r, lift.g, lift.b, 0.35);
  const lumBot = "rgba(0,0,0,0.45)";

  if (npSheet) {
    npSheet.style.setProperty("--np-accent", rgbStr(accent.r, accent.g, accent.b));
    npSheet.style.setProperty(
      "--np-accent-2",
      rgbStr(accentHi.r, accentHi.g, accentHi.b)
    );
    npSheet.style.setProperty("--np-glow", glow);
    npSheet.style.setProperty("--np-glow-soft", glowSoft);
    npSheet.style.setProperty("--np-bg-top", rgbStr(top.r, top.g, top.b));
    npSheet.style.setProperty("--np-bg-mid", rgbStr(mid.r, mid.g, mid.b));
    npSheet.style.setProperty("--np-bg-bot", rgbStr(deep.r, deep.g, deep.b));
    npSheet.style.setProperty("--np-lum-top", lumTop);
    npSheet.style.setProperty("--np-lum-bot", lumBot);
    npSheet.style.setProperty(
      "--np-lift",
      rgbStr(lift.r, lift.g, lift.b, 0.55)
    );
    // liquid glass full screen (stesso linguaggio del karaoke)
    npSheet.style.setProperty(
      "--np-glass-fill",
      rgbStr(top.r, top.g, top.b, 0.32)
    );
    npSheet.style.setProperty(
      "--np-glass-fill-2",
      rgbStr(deep.r, deep.g, deep.b, 0.48)
    );
    npSheet.style.setProperty("--np-glass-shine", "rgba(255,255,255,0.2)");
    npSheet.style.setProperty("--np-glass-edge", "rgba(255,255,255,0.14)");
    npSheet.classList.add("has-cover-theme");
  }

  // lyrics glass: tint MOLTO leggero (lo sfondo player resta dominante)
  const glassTint = setLuminosity(base, 0.38);
  const glassDeep = setLuminosity(base, 0.18);

  if (npLyricsPanel) {
    npLyricsPanel.style.setProperty(
      "--ly-glass-fill",
      rgbStr(glassTint.r, glassTint.g, glassTint.b, 0.3)
    );
    npLyricsPanel.style.setProperty(
      "--ly-glass-fill-2",
      rgbStr(glassDeep.r, glassDeep.g, glassDeep.b, 0.42)
    );
    npLyricsPanel.style.setProperty("--ly-glass-shine", "rgba(255,255,255,0.2)");
    npLyricsPanel.style.setProperty("--ly-glass-edge", "rgba(255,255,255,0.14)");
    npLyricsPanel.style.setProperty("--ly-glass-shadow", "rgba(0,0,0,0.28)");
    npLyricsPanel.style.setProperty(
      "--ly-bg",
      rgbStr(glassDeep.r, glassDeep.g, glassDeep.b, 0.8)
    );

    // testo sempre chiaro sul vetro scuro semi-trasparente
    npLyricsPanel.style.setProperty("--ly-fg", "#fff");
    npLyricsPanel.style.setProperty("--ly-active", "#fff");
    npLyricsPanel.style.setProperty("--ly-muted", "rgba(255,255,255,0.52)");
    npLyricsPanel.style.setProperty("--ly-dim", "rgba(255,255,255,0.3)");
    npLyricsPanel.style.setProperty("--ly-play-bg", "rgba(255,255,255,0.94)");
    npLyricsPanel.style.setProperty("--ly-play-fg", "#0a0a0a");
    npLyricsPanel.style.setProperty("--ly-seek", "#fff");
    npLyricsPanel.style.setProperty("--ly-seek-track", "rgba(255,255,255,0.24)");
    npLyricsPanel.classList.add("ly-dark");
    npLyricsPanel.classList.remove("ly-light");
  }
  if (lySolidBg) {
    lySolidBg.style.background = "";
    lySolidBg.style.inset = "0";
    lySolidBg.style.width = "100%";
    lySolidBg.style.height = "100%";
  }
}

/** Pixel di un'immagine caricata via <img crossOrigin> risultavano "tainted"
 * (getImageData falliva sempre, colore mai estratto) nella WebView nativa
 * (Capacitor, scheme capacitor://) anche con Access-Control-Allow-Origin:*
 * corretto lato server — quirk noto di WKWebView con crossOrigin=anonymous
 * su scheme custom. fetch()+Blob aggira il problema: i pixel di un bitmap
 * costruito da un Blob scaricato da noi non sono mai soggetti a tainting. */
async function extractDominantColor(imageUrl) {
  if (!imageUrl) return null;
  try {
    // no-store: la stessa cover è già stata richiesta un istante prima come
    // background-image "normale" (senza CORS) — senza forzare una richiesta
    // fresca, WKWebView può riservire QUELLA risposta dalla cache per il
    // fetch() qui sotto, che essendo in modalità cors la trova "tainted" e
    // fallisce con un generico "Load failed" anche se il server manda CORS
    // corretti (stesso bug già visto sulle cover offline, vedi apiJson)
    const res = await fetch(imageUrl, { cache: "no-store" });
    if (!res.ok) return COVER_THEME_DEFAULT;
    const blob = await res.blob();
    const bitmap = await createImageBitmap(blob);
    const size = 32;
    const c = document.createElement("canvas");
    c.width = size;
    c.height = size;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0, size, size);
    const data = ctx.getImageData(0, 0, size, size).data;
    // bucket grezzo per colore “vivo”
    const buckets = new Map();
    for (let i = 0; i < data.length; i += 4) {
      const a = data[i + 3];
      if (a < 200) continue;
      let r = data[i],
        g = data[i + 1],
        b = data[i + 2];
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      // skip near black / white / grigi piatti
      if (max < 30 || min > 245) continue;
      if (max - min < 12 && max < 200) continue;
      // quantizza
      r = Math.round(r / 24) * 24;
      g = Math.round(g / 24) * 24;
      b = Math.round(b / 24) * 24;
      const key = `${r},${g},${b}`;
      const sat = max - min;
      const weight = 1 + sat / 64;
      buckets.set(key, (buckets.get(key) || 0) + weight);
    }
    let best = null;
    let bestW = 0;
    for (const [key, w] of buckets) {
      if (w > bestW) {
        bestW = w;
        best = key;
      }
    }
    if (!best) return COVER_THEME_DEFAULT;
    const [r, g, b] = best.split(",").map(Number);
    return { r, g, b };
  } catch (_) {
    return COVER_THEME_DEFAULT;
  }
}

async function themeFromCoverUrl(imageUrl) {
  const gen = ++_coverThemeGen;
  const rgb = (await extractDominantColor(imageUrl)) || COVER_THEME_DEFAULT;
  if (gen !== _coverThemeGen) return; // superata da un brano più recente nel frattempo
  applyCoverTheme(rgb);
}

/**
 * Estrazione colore dominante indipendente (stessa tecnica di extractDominantColor,
 * ma con un proprio contatore di generazione) — usata per il pannello playlist,
 * separata da quella del Now Playing per non cancellarsi a vicenda se partono
 * in contemporanea (es. cambio brano mentre apri una playlist).
 */
let _plHeroColorGen = 0;

/** Stessa tecnica fetch()+Blob di extractDominantColor (vedi commento lì) —
 * evita il tainting di <img crossOrigin> nella WebView nativa. */
async function extractDominantColorStandalone(imageUrl) {
  if (!imageUrl) return null;
  try {
    const res = await fetch(imageUrl, { cache: "no-store" }); // vedi extractDominantColor
    if (!res.ok) return null;
    const blob = await res.blob();
    const bitmap = await createImageBitmap(blob);
    const size = 32;
    const c = document.createElement("canvas");
    c.width = size;
    c.height = size;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0, size, size);
    const data = ctx.getImageData(0, 0, size, size).data;
    const buckets = new Map();
    for (let i = 0; i < data.length; i += 4) {
      const a = data[i + 3];
      if (a < 200) continue;
      let r = data[i],
        g = data[i + 1],
        b = data[i + 2];
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      if (max < 30 || min > 245) continue;
      if (max - min < 12 && max < 200) continue;
      r = Math.round(r / 24) * 24;
      g = Math.round(g / 24) * 24;
      b = Math.round(b / 24) * 24;
      const key = `${r},${g},${b}`;
      const sat = max - min;
      const weight = 1 + sat / 64;
      buckets.set(key, (buckets.get(key) || 0) + weight);
    }
    let best = null;
    let bestW = 0;
    for (const [key, w] of buckets) {
      if (w > bestW) {
        bestW = w;
        best = key;
      }
    }
    if (!best) return null;
    const [r, g, b] = best.split(",").map(Number);
    return { r, g, b };
  } catch (_) {
    return null;
  }
}

/** Applica il colore dominante della copertina come sfondo dinamico del pannello playlist. */
async function applyHeroColor(el, coverUrl) {
  if (!el) return;
  const myGen = ++_plHeroColorGen;
  // lo stesso colore va anche sulla vista: la fascia a scomparsa non è
  // dentro la hero e per ricopiare il colore che stava in cima alla pagina
  // deve poterlo ereditare da un antenato comune
  const vista = el.closest(".view");
  const scrivi = (valore) => {
    el.style.setProperty("--pl-hero-rgb", valore);
    if (vista) vista.style.setProperty("--pl-hero-rgb", valore);
  };
  if (!coverUrl) {
    scrivi("255, 106, 0");
    return;
  }
  const rgb = await extractDominantColorStandalone(mediaAuthUrl(coverUrl, { bust: false }));
  if (myGen !== _plHeroColorGen) return; // superata da un'apertura più recente
  scrivi(rgb ? `${rgb.r}, ${rgb.g}, ${rgb.b}` : "255, 106, 0");
}

/** Sfondo mini-player: stesso colore dominante della cover, scurito per
 * restare leggibile col testo bianco sopra (stile Spotify — vedi screenshot
 * Vitto, mini bar rosso scuro sul brano "Rockstar Made"). Generation counter
 * indipendente da _plHeroColorGen/_coverThemeGen: brano che cambia in fretta
 * non deve far sovrascrivere un'estrazione più recente da una più vecchia. */
let _miniHeroColorGen = 0;
async function applyMiniPlayerHeroColor(coverUrl) {
  if (!playerBar) return;
  const myGen = ++_miniHeroColorGen;
  if (!coverUrl) {
    playerBar.style.removeProperty("--mini-hero-bg");
    if (npSheet) {
      npSheet.style.removeProperty("--mini-hero-rgb");
      npSheet.style.removeProperty("--mini-hero-rgb-dark");
      npSheet.style.removeProperty("--mini-hero-rgb-bright");
    }
    return;
  }
  const rgb = await extractDominantColorStandalone(coverUrl);
  if (myGen !== _miniHeroColorGen) return;
  if (!rgb) {
    playerBar.style.removeProperty("--mini-hero-bg");
    if (npSheet) {
      npSheet.style.removeProperty("--mini-hero-rgb");
      npSheet.style.removeProperty("--mini-hero-rgb-dark");
      npSheet.style.removeProperty("--mini-hero-rgb-bright");
    }
    return;
  }
  const vivid = saturateRgb(rgb, 1.25);
  const toned = setLuminosity(vivid, 0.22);
  playerBar.style.setProperty(
    "--mini-hero-bg",
    rgbStr(toned.r, toned.g, toned.b)
  );
  // stessa metrica di estrazione/saturazione della mini bar, esposta qui
  // PRIMA dello scurimento per leggibilità (quello serve solo alla mini
  // bar) — la soundbar in #nowPlayingSheet ne ricava la propria scala
  // chiaro/scuro, vedi .dj-bar in style.css. Richiesta di Vitto,
  // 2026-07-31: "usa la stessa metrica di selezione colore della minibar".
  if (npSheet) {
    const dark = setLuminosity(vivid, 0.14);
    const bright = mixRgb(vivid, { r: 255, g: 255, b: 255 }, 0.35);
    npSheet.style.setProperty("--mini-hero-rgb", `${vivid.r}, ${vivid.g}, ${vivid.b}`);
    npSheet.style.setProperty("--mini-hero-rgb-dark", `${dark.r}, ${dark.g}, ${dark.b}`);
    npSheet.style.setProperty("--mini-hero-rgb-bright", `${bright.r}, ${bright.g}, ${bright.b}`);
  }
}

/** Ultima cover HD (per ripaint al cambio tema) */
let _lastCoverHd = null;
let _lastCoverThumb = null;

/** Sfondo full NP: dipende dal tema attivo */
function paintNowPlayingBackground(hdUrl) {
  const hd = hdUrl != null ? hdUrl : _lastCoverHd;
  if (!npBg) return;
  const theme = getUiTheme();

  if (!hd) {
    applyCoverTheme(COVER_THEME_DEFAULT);
    npBg.style.backgroundImage = "";
    npBg.style.backgroundColor = "";
    npBg.style.filter = "";
    return;
  }

  themeFromCoverUrl(hd);

  if (theme === "liquid-glass") {
    // cover sotto + .np-glass sopra (CSS)
    npBg.style.backgroundImage = `url(${hd})`;
    npBg.style.backgroundSize = "cover";
    npBg.style.backgroundPosition = "center";
    npBg.style.filter = "saturate(1.2) brightness(0.95)";
  } else {
    // classic: gradienti + cover (senza layer glass)
    npBg.style.backgroundImage = `
      radial-gradient(ellipse 120% 70% at 50% 20%, var(--np-glow, rgba(255,106,0,0.4)), transparent 55%),
      linear-gradient(180deg, var(--np-bg-top, rgba(40,20,8,0.95)) 0%, var(--np-bg-bot, #0a0a0a) 70%),
      url(${hd})`;
    npBg.style.backgroundSize = "cover, cover, cover";
    npBg.style.backgroundPosition = "center";
    npBg.style.filter = "none";
  }
}

/**
 * @param {string|null} url — thumb / lista / mini player
 * @param {string|null} [hdUrl] — full player (se assente usa url)
 */
/** Crossfade leggero invece dello scatto secco quando cambia la cover */
function _fadeSwapCover(el, url, fallbackText) {
  if (!el) return;
  const newBg = url ? `url(${url})` : "";
  // Il guard "è già questa cover?" confrontava el.style.backgroundImage con
  // newBg, ma il CSSOM ri-serializza il valore letto mettendo le virgolette
  // (url("…")) mentre newBg non le ha: NON combaciava mai, quindi ogni
  // chiamata rifaceva il crossfade da capo. Invisibile quando setCover parte
  // una volta per brano, lampeggio grigio continuo nel mirror multi-device,
  // dove applyRemoteMirror gira a ogni poll (1/s). Teniamo noi l'ultimo url
  // applicato, che è già normalizzato.
  if (el._coverKey === newBg) return;
  el._coverKey = newBg;
  el.style.opacity = "0";
  window.setTimeout(() => {
    if (url) {
      el.style.backgroundImage = newBg;
      el.style.backgroundSize = "cover";
      el.style.backgroundPosition = "center";
      el.textContent = "";
    } else {
      el.style.backgroundImage = "";
      el.textContent = fallbackText || "⚡";
    }
    el.style.opacity = "1";
  }, 140);
}

function setCover(url, hdUrl) {
  const u = typeof proxiedCover === "function" ? proxiedCover(url) : url;
  const hd =
    (typeof proxiedCover === "function" ? proxiedCover(hdUrl) : hdUrl) || u;
  _lastCoverThumb = u;
  _lastCoverHd = hd;
  _fadeSwapCover(coverEl, u, "⚡");
  applyMiniPlayerHeroColor(u);
  // Full sheet: preferisci HD
  _fadeSwapCover(npArt, hd, "⚡");
  paintNowPlayingBackground(hd);
  // sync full sheet titles se aperto
  if (npTitle && nowTitle) setNpMarqueeText(npTitle, nowTitle.textContent || "—");
  if (npArtist && nowArtist) setNpMarqueeText(npArtist, nowArtist.textContent || "—");
}

/** Testo a scorrimento (stile Spotify) quando titolo/artista non entrano nella riga. */
function setNpMarqueeText(el, text) {
  if (!el) return;
  const track = el.querySelector(".np-mq-track") || el;
  const str = text || "";
  if (track.textContent !== str) track.textContent = str;
  el.classList.remove("np-mq-scroll");
  el.style.removeProperty("--np-mq-dist");
  el.style.removeProperty("--np-mq-dur");
  requestAnimationFrame(() => {
    const overflow = track.scrollWidth - el.clientWidth;
    if (overflow > 6) {
      const dist = -(overflow + 20);
      const dur = Math.max(5, Math.abs(dist) / 32 + 2.5);
      el.style.setProperty("--np-mq-dist", `${dist}px`);
      el.style.setProperty("--np-mq-dur", `${dur}s`);
      el.classList.add("np-mq-scroll");
    }
  });
}

let _npMqResizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(_npMqResizeTimer);
  _npMqResizeTimer = setTimeout(() => {
    if (npTitle) setNpMarqueeText(npTitle, npTitle.querySelector(".np-mq-track")?.textContent || "");
    if (npArtist) setNpMarqueeText(npArtist, npArtist.querySelector(".np-mq-track")?.textContent || "");
  }, 200);
});

let _lastRequestBarSyncTrackKey = "";
function syncNowPlayingSheetMeta() {
  // JARVIS attivo (sessione vera o ancora in avvio, saluto/pool in corso)
  // → soundbar al posto della cover, vedi .np-sheet.jarvis-mode in
  // style.css. Unico punto che decide la modalità, chiamato ad ogni
  // cambio brano E all'apertura sheet, niente flag separato da tenere
  // sincronizzato a mano (richiesta di Vitto, 2026-07-31).
  const jarvisNow = jarvisSessionActive || jarvisSessionStarting;
  if (npSheet) {
    npSheet.classList.toggle("jarvis-mode", jarvisNow);
    // qid della coda invece di title/artist mostrati: quel testo passa dal
    // marquee (setNpMarqueeText, poco sotto) che tocca il DOM e poteva far
    // sembrare "cambiato" lo stesso identico brano.
    const _qTrack = queue.items[queue.index];
    const trackKey = (_qTrack && _qTrack.qid) || `${nowPlaying.title || ""}|${nowPlaying.artist || ""}`;
    const trackChanged = trackKey !== _lastRequestBarSyncTrackKey;
    // SOLO su cambio brano vero, mai chiuso da una sync periodica sullo
    // STESSO brano (applyRemoteMirror via startRemoteCommandPoll) — questo
    // può restare aperto MENTRE l'utente sta scrivendo una richiesta,
    // chiuderlo ad ogni giro di poll lo farebbe sparire mentre si digita.
    if (trackChanged) {
      npSheet.classList.remove("request-open");
    }
    _lastRequestBarSyncTrackKey = trackKey;
  }
  if (npTitle) setNpMarqueeText(npTitle, nowTitle.textContent || nowPlaying.title || "Nessun brano");
  if (npArtist) setNpMarqueeText(npArtist, nowArtist.textContent || nowPlaying.artist || "—");
  if (npContext) {
    const q = queue.items[queue.index];
    if (jarvisNow) npContext.textContent = "JARVIS";
    else if (q && q.source === "library") npContext.textContent = "Salvati";
    else if (q && q.source === "search") npContext.textContent = "Ricerca";
    else npContext.textContent = "CRACKIFY";
  }
  // se il testo è aperto e cambia brano → ricarica
  if (npLyricsPanel && !npLyricsPanel.hidden) {
    const title = nowPlaying.title || nowTitle?.textContent || "";
    const artist = nowPlaying.artist || nowArtist?.textContent || "";
    const key = lyricsCacheKey(artist, title);
    if (key !== lyricsKeyCurrent && title) {
      openLyricsPanel();
    }
  }
  loadLyricsPreview();
}

/** allowEmpty: JARVIS apre lo sheet PRIMA che esista un brano vero (saluto
 * + costruzione pool ancora in corso) — vedi openDjSheet. Il guard "nessun
 * brano" normale resta per ogni altro punto di ingresso. */
function openNowPlayingSheet({ allowEmpty = false } = {}) {
  if (!npSheet) return;
  if (!allowEmpty && !audio.src && !nowPlaying.title) {
    toast("Nessun brano in riproduzione");
    return;
  }
  syncNowPlayingSheetMeta();
  npOpen = true;
  npSheet.classList.add("open");
  npSheet.setAttribute("aria-hidden", "false");
  document.body.classList.add("np-open");
  // il banner Home sparisce sotto questo sheet — il suo loop di animazione
  // gira a vuoto se non lo fermiamo, vedi stopHomeDjSoundbarLoop
  stopHomeDjSoundbarLoop();
  // innocuo se non siamo in modalità JARVIS: le due funzioni non fanno
  // nulla senza jarvisSessionActive/jarvisSessionStarting attivo
  if (jarvisSessionActive || jarvisSessionStarting) {
    startJarvisBassLoop();
    startJarvisSoundbarLoop();
  }
  try {
    history.pushState({ np: 1 }, "");
  } catch (_) {}
}

function closeNowPlayingSheet(fromPop) {
  if (!npSheet || !npOpen) return;
  npOpen = false;
  closeLyricsPanel();
  // chiudere lo sheet mentre JARVIS sta ancora "partendo" (saluto/annuncio
  // in corso, PRIMA che la musica vera inizi con playFromList) deve fermare
  // tutto per davvero, non solo nascondere lo sheet lasciando l'audio a
  // suonare sotto — bug segnalato da Vitto, 2026-08-04: "ho annullato ma ho
  // sentito ancora kokoro". La X sull'overlay di caricamento (vedi openDjSheet/
  // cancelJarvisSessionStart) copre solo la finestra PRIMA che reveal() apra
  // lo sheet: reveal scatta appena l'audio del saluto comincia DAVVERO a
  // suonare, quindi nella pratica l'overlay+X sparivano già nello stesso
  // istante in cui l'utente sentiva le prime sillabe e provava a fermarlo —
  // chiudere lo sheet stesso è l'unico punto che resta cliccabile in quella
  // finestra, quindi deve fare lo stesso lavoro. Nessun effetto se JARVIS è
  // già "attivo" per davvero (playFromList partito, musica vera in coda).
  if (jarvisSessionStarting && !jarvisSessionActive) {
    cancelJarvisSessionStart();
  }
  npSheet.classList.remove("open");
  npSheet.setAttribute("aria-hidden", "true");
  document.body.classList.remove("np-open");
  // no-op se non stavano girando (vedi guardie interne)
  stopJarvisBassLoop();
  stopJarvisSoundbarLoop();
  // il banner Home torna visibile sotto — riaccende il suo loop (no-op se
  // già acceso, vedi guardia interna)
  startHomeDjSoundbarLoop();
  if (!fromPop) {
    try {
      if (history.state && history.state.np) history.back();
    } catch (_) {}
  }
}

/** Campo "chiedi qualcosa a JARVIS" — prima sempre visibile in
 * .jarvis-mode, ora nascosto di default e aperto solo dall'icona chat al
 * posto del repeat (richiesta di Vitto, 2026-08-01: "così pagina già più
 * clean"). npRepeat stesso è il trigger, vedi il suo click handler più in
 * basso: fuori da JARVIS resta il repeat normale, dentro JARVIS apre/
 * chiude questo invece. */
function toggleJarvisRequestOpen(force, { skipFocus = false } = {}) {
  if (!npSheet) return;
  const on = npSheet.classList.toggle("request-open", force);
  // riusa il glow arancione già esistente di .np-t-btn.active (stesso
  // trattamento visivo del repeat attivo) invece di una regola CSS a
  // parte — occhio: updateRepeatUi la risovrascrive in base a repeatMode
  // se cambia repeat da altrove (es. sidebar) mentre si è in JARVIS con
  // la chat aperta, caso limite accettato, non una vera fonte di bug.
  if (npRepeat) npRepeat.classList.toggle("active", on);
  // skipFocus: usato da jarvisVoiceRequest per mostrare la barra (con la
  // trascrizione live dentro) SENZA far comparire la tastiera — un focus
  // su iOS apre sempre la tastiera nativa, che coprirebbe lo schermo
  // mentre l'utente sta ancora dettando a voce.
  if (on && !skipFocus && djRequestInput) djRequestInput.focus();
}
// Un solo AnalyserNode per tutta la vita della pagina: l'<audio> puo'
// essere agganciato a un MediaElementSourceNode una volta sola (chiamarlo
// due volte lancia InvalidStateError), quindi lo creiamo pigro al primo
// openDjSheet (serve comunque un gesture utente per l'AudioContext su
// Safari/iOS) e lo riusiamo. Se il browser non supporta Web Audio o
// l'elemento è cross-origin senza CORS, l'analyser resta a zero: JARVIS
// smette di reagire ma niente si rompe.
let jarvisAudioCtx = null;
let jarvisAnalyser = null;
let jarvisFreqData = null;
let jarvisRaf = 0;
let jarvisBassSmoothed = 0;

function ensureJarvisAudioCtx() {
  if (!jarvisAudioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    jarvisAudioCtx = new Ctx();
  }
  return jarvisAudioCtx;
}

function ensureJarvisAnalyser() {
  if (jarvisAnalyser) return jarvisAnalyser;
  // createMediaElementSource(audio) dirotta PER SEMPRE l'output del player
  // musicale PRINCIPALE (condiviso con tutta l'app, non solo JARVIS) dentro
  // il grafo Web Audio — non è annullabile. Su iOS/WKWebView questo pare
  // rompere il routing audio nativo in un modo che desktop non ha: bug
  // riprodotto da Vitto (2026-07-30) — aprendo JARVIS per primo, poi NÉ
  // JARVIS NÉ i brani salvati riproducevano più audio per il resto della
  // sessione, finché non richiudeva e riapriva l'app (che dà un <audio>
  // vergine, mai agganciato al grafo). Su web/desktop non risulta rotto
  // (vedi [[crackify_ai_dj_plan]]), quindi qui saltiamo SOLO in guscio
  // nativo — soundbar musica/bordo ai bassi degradano al "respiro" idle
  // (vedi jarvisSoundbarIdleTargets), sacrificio accettabile: sentire la
  // musica viene prima dell'estetica.
  if (isNativeShell()) return null;
  try {
    const ctx = ensureJarvisAudioCtx();
    const source = ctx.createMediaElementSource(audio);
    jarvisAnalyser = ctx.createAnalyser();
    jarvisAnalyser.fftSize = 256;
    jarvisAnalyser.smoothingTimeConstant = 0.8;
    source.connect(jarvisAnalyser);
    // senza questo secondo collegamento a destination l'audio ammutolisce:
    // creare un MediaElementSourceNode dirotta l'output dell'elemento
    // dentro il grafo Web Audio, non lo lascia più passare "di default"
    source.connect(ctx.destination);
    jarvisFreqData = new Uint8Array(jarvisAnalyser.frequencyBinCount);
  } catch (err) {
    console.warn("JARVIS: Web Audio non disponibile", err);
    jarvisAnalyser = null;
  }
  return jarvisAnalyser;
}

function startJarvisBassLoop() {
  if (jarvisRaf) return; // già in corso
  const tick = () => {
    jarvisRaf = requestAnimationFrame(tick);
    // analyser live dove è sicuro (web/desktop, vedi ensureJarvisAnalyser),
    // altrimenti il profilo precalcolato dal server (envelope.py) — MAI
    // un early-return se manca l'analyser: su iOS è disabilitato apposta,
    // ma il loop deve comunque girare per leggere l'envelope.
    const analyser = ensureJarvisAnalyser();
    let level;
    if (analyser) {
      if (jarvisAudioCtx.state === "suspended") jarvisAudioCtx.resume();
      analyser.getByteFrequencyData(jarvisFreqData);
      // fftSize 256 → bin larghi ~172Hz (a 44.1kHz): i primi 4 coprono circa
      // 0-690Hz, il grosso dell'energia dei bassi
      const bassBins = 4;
      let sum = 0;
      for (let i = 0; i < bassBins; i++) sum += jarvisFreqData[i];
      level = sum / bassBins / 255; // 0..1
    } else {
      level = envelopeBassLevel() ?? 0;
    }
    // attacco rapido/rilascio lento: il colpo si vede bene, non lampeggia
    const rate = level > jarvisBassSmoothed ? 0.5 : 0.12;
    jarvisBassSmoothed += (level - jarvisBassSmoothed) * rate;
    document.documentElement.style.setProperty("--jarvis-bass", jarvisBassSmoothed.toFixed(3));
  };
  tick();
}

function stopJarvisBassLoop() {
  if (jarvisRaf) {
    cancelAnimationFrame(jarvisRaf);
    jarvisRaf = 0;
  }
  jarvisBassSmoothed = 0;
  document.documentElement.style.setProperty("--jarvis-bass", "0");
}

// —— JARVIS: soundbar — sempre accesa mentre lo sheet è aperto, tre
// modalità decise ogni frame (in ordine di priorità): JARVIS sta parlando
// (arancione, legge jarvisSpeechAnalyser) > musica in corso (bianco, legge
// lo stesso analyser della musica usato per il glow di sfondo) > nessuno
// dei due, respiro leggero. Interpolazione morbida per-barra (lerp verso
// il valore target invece di scattarci sopra) per un effetto più organico
// da assistente vocale, non le barre rigide di un equalizzatore hardware
// — richiesta esplicita di Vitto dopo aver visto la prima versione.
let jarvisSpeechAnalyser = null;
let jarvisSpeechFreqData = null;
let jarvisSoundbarRaf = 0;
// ═══════════════════════════════════════════════════════════
// Scala delle barre via transform invece che via height.
// Scrivere style.height ad ogni frame su 16-32 barre costringe il browser
// a rifare layout + repaint 60 volte al secondo (height è una proprietà di
// layout), e il drop-shadow di .dj-bar veniva ricalcolato ogni volta: è la
// causa dei rallentamenti e del surriscaldamento segnalati il 2026-08-02.
// Con height:100% fisso in CSS e scaleY() qui, l'animazione resta sul
// compositor: niente layout, niente repaint del bagliore.
// transform-origin:center riproduce l'align-items:center di prima, cioè
// la barra che cresce e cala dal proprio centro.
// ═══════════════════════════════════════════════════════════
function makeBarScaler(container, bars, minPx = 8) {
  let containerH = 0;
  function measure() {
    if (!container) return;
    // offsetHeight e non getBoundingClientRect(): .np-sheet .dj-soundbar ha
    // un transform proprio (il cross-fade di apertura dello sheet) e il rect
    // rifletterebbe quella scala transitoria. offsetHeight è il box di
    // layout, indifferente ai transform.
    const h = container.offsetHeight;
    // 0 = contenitore ancora nascosto (lo sheet non è aperto): tieni
    // l'ultima misura buona, rimisureremo allo start successivo.
    if (h > 0) containerH = h;
  }
  measure();
  window.addEventListener("resize", measure, { passive: true });
  return {
    measure,
    apply(percents) {
      const floor = containerH > 0 ? minPx / containerH : 0;
      for (let i = 0; i < bars.length; i++) {
        let f = percents[i] / 100;
        if (f < floor) f = floor;
        bars[i].style.transform = "scaleY(" + f + ")";
      }
    },
  };
}

const djSoundbarBars = djSoundbar ? Array.from(djSoundbar.querySelectorAll(".dj-bar")) : [];
let jarvisBarHeights = djSoundbarBars.map(() => 10); // % attuale per barra, persiste tra i frame
const jarvisBarScaler = makeBarScaler(djSoundbar, djSoundbarBars);

function ensureJarvisSpeechAnalyser() {
  if (jarvisSpeechAnalyser) return jarvisSpeechAnalyser;
  // stesso motivo/stesso interruttore di ensureJarvisAnalyser (musica) più
  // sopra: createMediaElementSource su iOS/WKWebView è il sospetto numero
  // uno per il lag+surriscaldamento sulla pagina JARVIS segnalato da
  // Vitto, 2026-08-02 ("Home fluida, JARVIS no" — la musica ha già questo
  // stesso interruttore da tempo, alla voce era rimasto scoperto). Degrada
  // allo stesso respiro idle già usato per la musica su iOS
  // (jarvisSoundbarIdleTargets), non silenzio: si sente tutto uguale,
  // cambia solo che le barre non seguono la voce bin-per-bin.
  if (isNativeShell()) return null;
  try {
    const ctx = ensureJarvisAudioCtx();
    const source = ctx.createMediaElementSource(jarvisSpeechAudio);
    jarvisSpeechAnalyser = ctx.createAnalyser();
    jarvisSpeechAnalyser.fftSize = 64;
    jarvisSpeechAnalyser.smoothingTimeConstant = 0.6;
    source.connect(jarvisSpeechAnalyser);
    source.connect(ctx.destination); // altrimenti la voce ammutolisce, vedi sopra
    jarvisSpeechFreqData = new Uint8Array(jarvisSpeechAnalyser.frequencyBinCount);
  } catch (err) {
    console.warn("JARVIS: soundbar (voce) non disponibile", err);
    jarvisSpeechAnalyser = null;
  }
  return jarvisSpeechAnalyser;
}

/** Un'altezza target (0-100) per barra, specchiata al centro, dai dati
 * grezzi di un analyser (voce o musica, stesso identico calcolo). */
function jarvisSoundbarTargetsFromAnalyser(analyser, freqData) {
  analyser.getByteFrequencyData(freqData);
  const half = Math.floor(djSoundbarBars.length / 2);
  const binsPerHalf = Math.max(1, Math.floor(freqData.length / half));
  const targets = new Array(djSoundbarBars.length);
  for (let i = 0; i < half; i++) {
    let sum = 0;
    for (let b = 0; b < binsPerHalf; b++) sum += freqData[i * binsPerHalf + b];
    // *1.6: voce/musica raramente saturano il range 0-255
    const h = Math.max(8, Math.min(100, (sum / binsPerHalf / 255) * 160));
    targets[half - 1 - i] = h;
    targets[half + i] = h;
  }
  return targets;
}

/** Nessun audio attivo: un'onda lenta che scorre dal centro ai bordi
 * invece di barre piatte immobili — "sembra vivo" anche a riposo. */
/** Come jarvisSoundbarTargetsFromAnalyser ma da un singolo livello 0..1
 * precalcolato (envelope.py) invece di bin di frequenza veri — usata dove
 * l'analyser live è disabilitato (iOS, vedi ensureJarvisAnalyser). Piccola
 * variazione di fase per barra così non sembrano scattare tutte insieme. */
// "Personalità" per-barra STABILE (generata una volta, non ad ogni frame):
// fase/velocità/sensibilità casuali così barre diverse reagiscono in modo
// diverso allo stesso livello di bassi. Senza, uno scalare unico (è tutto
// quello che dà envelope.py — un livello, non uno spettro) specchiato dal
// centro sembra sincronizzato/finto — ovvio con tante barre affiancate,
// segnalato da Vitto sulla soundbar Home a 16 barre ("cambia modello,
// questo non va bene per più segmenti"). Niente più specchiatura.
function makeBarPersonalities(n) {
  const arr = new Array(n);
  for (let i = 0; i < n; i++) {
    arr[i] = {
      phase: Math.random() * Math.PI * 2,
      speed: 0.6 + Math.random() * 1.1,
      sensitivity: 0.55 + Math.random() * 0.9,
    };
  }
  return arr;
}
const jarvisBarPersonalities = makeBarPersonalities(djSoundbarBars.length);

/** Curva a campana: centro più alto, bordi che scendono (richiesta di
 * Vitto — "man mano che vai verso i bordi si abbassano"). Post-processing
 * applicato a QUALUNQUE targets già calcolato (voce/musica/idle/livello),
 * un solo punto invece di rifare la stessa curva in ogni funzione. floor =
 * altezza minima che NON viene compressa (i bordi restano vivi, solo
 * meno ampi, non spenti). */
function applyDomeEnvelope(targets, floor = 8) {
  const n = targets.length;
  const center = (n - 1) / 2;
  if (center <= 0) return targets;
  // provato anche un bonus extra solo sulle barre più centrali — Vitto:
  // "era meglio la build prima", tolto. Resta la campana semplice.
  for (let i = 0; i < n; i++) {
    const dist = Math.abs(i - center) / center; // 0 al centro, 1 ai bordi
    const scale = 0.4 + 0.6 * Math.cos((dist * Math.PI) / 2);
    targets[i] = Math.min(100, floor + (targets[i] - floor) * scale);
  }
  return targets;
}

function jarvisSoundbarTargetsFromLevel(level, t) {
  const n = djSoundbarBars.length;
  const targets = new Array(n);
  const boosted = envelopeBoost(level);
  for (let i = 0; i < n; i++) {
    const p = jarvisBarPersonalities[i];
    const base = 8 + boosted * 88 * p.sensitivity;
    const wobble = Math.sin(t / 190 * p.speed + p.phase) * boosted * 14;
    targets[i] = Math.max(8, Math.min(100, base + wobble));
  }
  return targets;
}

/** Livello finto ma vivo, per quando sappiamo che sta suonando (mirror di
 * un altro device: niente analyser/envelope locali per il SUO brano — vedi
 * jarvisSoundbarTargetsFromLevel qui sopra) senza un segnale reale da
 * seguire. A differenza di jarvisSoundbarIdleTargets (respiro quasi piatto,
 * pensato per "nessuno sta suonando") oscilla lui stesso nel tempo. */
function fakePlaybackLevel(t) {
  return 0.5 + Math.sin(t / 480) * 0.28 + Math.sin(t / 137) * 0.14;
}

function jarvisSoundbarIdleTargets(t) {
  const half = Math.floor(djSoundbarBars.length / 2);
  const targets = new Array(djSoundbarBars.length);
  for (let i = 0; i < half; i++) {
    const h = 10 + Math.sin(t / 900 + i * 0.5) * 6;
    targets[half - 1 - i] = h;
    targets[half + i] = h;
  }
  return targets;
}

function startJarvisSoundbarLoop() {
  if (jarvisSoundbarRaf || !djSoundbarBars.length) return;
  jarvisBarScaler.measure();
  const tick = (t) => {
    jarvisSoundbarRaf = requestAnimationFrame(tick);
    const speaking = jarvisSpeechAudio && !jarvisSpeechAudio.paused && !jarvisSpeechAudio.ended;
    // stesso motivo di startHomeDjSoundbarLoop: in mirror l'<audio> locale
    // è sempre in pausa, "sta suonando" lo dice lo stato dell'altro device
    const mirrorPlaying = remoteMirror && _mirrorPlaying;
    const musicPlaying = !speaking && ((!audio.paused && !audio.ended) || mirrorPlaying);
    // titolo/artista/cuore/seek/tema nascosti/fissi su JARVIS finché c'È
    // del testo in .dj-line, non solo mentre l'audio sta letteralmente
    // suonando — copre sia la coda di lettura+dissolvenza dopo che JARVIS
    // ha finito di parlare (jarvisScheduleLineGlitchOut tiene il testo
    // ancora un po' prima di farlo sparire), sia la pausa TRA due battute
    // consecutive (saluto → frase sul brano in startJarvisSession: durante
    // il fetch della seconda sintesi "speaking" torna falso per una
    // manciata di frame). Legato solo ad audio.paused, tema/meta-row
    // sfarfallavano indietro al colore del brano precedente per poi
    // rientrare in JARVIS mode un istante dopo (segnalato da Vitto,
    // 2026-08-01, sia a fine frase "sintonizzare fine speech e
    // dissolvimento testo" sia sul gap saluto/brano "ricambia il colore in
    // quello della cover"). .dj-line resta valorizzato per tutta questa
    // finestra (jarvisSetLine non lo svuota mai, solo jarvisGlitchOut a
    // dissolvenza completata), quindi è il segnale giusto per "JARVIS sta
    // ancora parlando" anche a cavallo di questi due casi.
    const jarvisTalking = speaking || !!(djLine && djLine.textContent);
    if (npSheet) npSheet.classList.toggle("jarvis-speaking", jarvisTalking);
    let targets;
    if (speaking) {
      const analyser = ensureJarvisSpeechAnalyser();
      djSoundbar.classList.add("dj-soundbar-voice");
      djSoundbar.classList.remove("dj-soundbar-music");
      // stessa catena a tre livelli della musica sotto: analyser live dove
      // è sicuro (web/desktop) → envelope precalcolato dal server per
      // QUESTA battuta (iOS, vedi envelopeSpeechLevel) → respiro idle solo
      // se manca anche quello (rete lenta, ffmpeg non disponibile...)
      const speechLevel = analyser ? null : envelopeSpeechLevel();
      targets = analyser
        ? jarvisSoundbarTargetsFromAnalyser(analyser, jarvisSpeechFreqData)
        : speechLevel != null
          ? jarvisSoundbarTargetsFromLevel(speechLevel, t)
          : jarvisSoundbarIdleTargets(t);
    } else if (musicPlaying) {
      // l'analyser Web Audio può leggere solo il NOSTRO <audio>, che in
      // mirror è fermo: lì si va di envelope, che invece è il profilo vero
      // del brano remoto (vedi envelopeBassLevel)
      const analyser = mirrorPlaying ? null : ensureJarvisAnalyser();
      djSoundbar.classList.add("dj-soundbar-music");
      djSoundbar.classList.remove("dj-soundbar-voice");
      // ultimo gradino: sappiamo che sta suonando ma non abbiamo lo spettro
      // (preview Deezer, envelope non ancora pronto) — meglio un movimento
      // fittizio ma vivo che le barre da "nessuno sta suonando"
      const level = analyser
        ? null
        : envelopeBassLevel() ?? (mirrorPlaying ? fakePlaybackLevel(t) : null);
      targets = analyser
        ? jarvisSoundbarTargetsFromAnalyser(analyser, jarvisFreqData)
        : level != null
          ? jarvisSoundbarTargetsFromLevel(level, t)
          : jarvisSoundbarIdleTargets(t);
    } else {
      djSoundbar.classList.remove("dj-soundbar-voice", "dj-soundbar-music");
      targets = jarvisSoundbarIdleTargets(t);
    }
    applyDomeEnvelope(targets);
    for (let i = 0; i < djSoundbarBars.length; i++) {
      // attacco rapido/rilascio più lento: il colpo si vede, non lampeggia
      const rate = targets[i] > jarvisBarHeights[i] ? 0.55 : 0.22;
      jarvisBarHeights[i] += (targets[i] - jarvisBarHeights[i]) * rate;
    }
    jarvisBarScaler.apply(jarvisBarHeights);
  };
  tick(0);
}

function stopJarvisSoundbarLoop() {
  if (jarvisSoundbarRaf) {
    cancelAnimationFrame(jarvisSoundbarRaf);
    jarvisSoundbarRaf = 0;
  }
  if (djSoundbar) djSoundbar.classList.remove("dj-soundbar-voice", "dj-soundbar-music");
}

// —— Soundbar del banner Home — SEMPRE viva, indipendente da JARVIS ——
// Richiesta di Vitto: deve muoversi su QUALUNQUE brano in riproduzione,
// anche se JARVIS non è mai stato aperto in questa sessione. Non usa
// l'analyser Web Audio del player principale (vedi ensureJarvisAnalyser
// più sopra: su iOS quell'aggancio rompe l'audio per il resto della
// sessione, bug reale trovato il 2026-07-30) — qui è un movimento fittizio
// (non pilotato dai bassi veri) ma pensato per "sembrare vivo", coerente
// con l'aspetto voluto ("un'AI che ti parla", non un equalizzatore
// meccanico): ogni barra ha la sua fase/velocità cosi non sembrano
// scattare tutte insieme a comando. Parte una volta all'avvio dell'app e
// resta accesa per tutta la sessione, costo trascurabile (poche altezze
// CSS aggiornate a frame su un pugno di elementi).
const homeDjSoundbarBars = homeDjSoundbar ? Array.from(homeDjSoundbar.querySelectorAll(".dj-bar")) : [];
let homeDjBarHeights = homeDjSoundbarBars.map(() => 18);
const homeDjBarScaler = makeBarScaler(homeDjSoundbar, homeDjSoundbarBars);
let homeDjSoundbarRaf = 0;
// stessa idea di jarvisBarPersonalities: niente specchiatura dal centro,
// con 16 barre affiancate su tutta la larghezza del banner si vedeva
// troppo che erano tutte sincronizzate a comando (Vitto, 2026-07-30)
const homeDjBarPersonalities = makeBarPersonalities(homeDjSoundbarBars.length);

function homeDjSoundbarTargets(t, active) {
  const n = homeDjSoundbarBars.length;
  const targets = new Array(n);
  // reattività vera dal profilo precalcolato (envelope.py) quando disponibile
  // per il brano corrente — altrimenti il movimento fittizio "vivo" sotto,
  // mai un aggancio Web Audio diretto qui (vedi ensureJarvisAnalyser).
  // Vale anche in mirror: envelopeBassLevel legge lo spettro del brano
  // remoto alla posizione remota (vedi lì).
  const level = active ? envelopeBassLevel() : null;
  const boosted = level != null ? envelopeBoost(level) : 0;
  for (let i = 0; i < n; i++) {
    const p = homeDjBarPersonalities[i];
    let h;
    if (level != null) {
      h = 8 + boosted * 80 * p.sensitivity + Math.sin(t / 210 * p.speed + p.phase) * boosted * 14;
    } else if (active) {
      h = 26 + Math.sin(t / 230 * p.speed + p.phase) * 20 + Math.sin(t / 85 * p.speed + p.phase * 1.6) * 7;
    } else {
      h = 12 + Math.sin(t / 950 * p.speed + p.phase) * 5;
    }
    targets[i] = Math.max(6, Math.min(100, h));
  }
  return targets;
}

function startHomeDjSoundbarLoop() {
  if (homeDjSoundbarRaf || !homeDjSoundbarBars.length) return;
  homeDjBarScaler.measure();
  const tick = (t) => {
    homeDjSoundbarRaf = requestAnimationFrame(tick);
    // In mirror l'<audio> locale è SEMPRE in pausa (applyRemoteMirror lo
    // ferma apposta, vedi lì) — "sta suonando" lo dice lo stato dell'altro
    // device, non il nostro elemento audio. Senza questo la soundbar del
    // device che guarda (non quello che suona davvero) restava sul
    // "respiro" idle per tutta la sessione, leggibile come "ferma" (Vitto,
    // 2026-08-11).
    const active =
      (!!audio && !audio.paused && !audio.ended && !!audio.src) ||
      (remoteMirror && _mirrorPlaying);
    const targets = applyDomeEnvelope(homeDjSoundbarTargets(t, active));
    for (let i = 0; i < homeDjSoundbarBars.length; i++) {
      // attacco rapido/rilascio più lento — prima era un lerp fisso troppo
      // morbido, sembrava "debole" anche quando il target era alto
      const rate = targets[i] > homeDjBarHeights[i] ? 0.4 : 0.15;
      homeDjBarHeights[i] += (targets[i] - homeDjBarHeights[i]) * rate;
    }
    homeDjBarScaler.apply(homeDjBarHeights);
  };
  tick(0);
}
// il commento sopra diceva "resta accesa per tutta la sessione" — vero
// finché non c'era nient'altro sopra il banner Home. Con lo sheet
// now-playing/JARVIS aperto il banner è coperto ma questo loop continuava
// comunque a girare invisibile: 16 barre ricalcolate + riscritte in stile
// (style.height) A OGNI FRAME, in parallelo alle stesse 16 di
// startJarvisSoundbarLoop PIÙ startJarvisBassLoop — bug di prestazioni
// segnalato da Vitto, 2026-08-02 ("laggo ogni tanto, mi si riscalda il
// cell"). Ora si ferma quando il banner sparisce sotto lo sheet e riparte
// alla chiusura, vedi openNowPlayingSheet/closeNowPlayingSheet.
function stopHomeDjSoundbarLoop() {
  if (homeDjSoundbarRaf) {
    cancelAnimationFrame(homeDjSoundbarRaf);
    homeDjSoundbarRaf = 0;
  }
}
startHomeDjSoundbarLoop();

// —— JARVIS: sessione (coda reale + commentary parlato) ——————————————
// true mentre la coda in riproduzione È quella del DJ — decide se
// playQueueIndex deve far parlare JARVIS. Si spegne da sola quando
// qualunque altro playFromList (libreria/ricerca/playlist) prende il
// controllo della coda altrove nell'app — vedi playFromList.
let jarvisSessionActive = false;

// Saluto iniziale — indipendente dal brano (vedi startJarvisSession: parte
// subito, in parallelo al caricamento del pool, non dopo). Tono sfrontato/
// sfottente, coerente col personaggio mostriciattolo, non un maggiordomo
// educato — richiesta esplicita di Vitto ("stile tossico/crackify").
// 05/10: Vitto preferisce la 1 e la 3 (la frecciatina da "finto
// abbandonato", poi si parte): la 2, la 4 e la 5 ritoccate su quel tono.
const JARVIS_GREETING_LINES = [
  "Peccato, {user}, sei tornato. Speravo ti fossi perso.",
  "Guarda chi si rivede — {user}. E io che mi godevo il silenzio. Va be', vediamo se hai ancora orecchie decenti.",
  "{user}! Pensavo mi avessi mollato per Spotify. Dai, che ti preparo qualcosa.",
  "Bentornato {user}. Ti avevo già dato per disperso, cerca almeno di non deludermi stavolta.",
  "Eccoti, {user}. Pensavo fossi passato alla radio del bar. Ho fame di buona musica — iniziamo.",
];
// Annuncio del brano — un solo pool per tutte le tracce (prima inclusa):
// il saluto sopra copre già l'apertura, qui basta il brano.
const JARVIS_TRACK_LINES = [
  "Si parte con {title}, di {artist}.",
  "Andiamo avanti con {title}, di {artist}.",
  "Cambio atmosfera: {title}, {artist}.",
  "Questo mi piace parecchio — {title}, di {artist}.",
  "Su con {title}, {artist}.",
];

function jarvisUserName() {
  const u = authState.user;
  return (u && (u.display_name || u.username) && String(u.display_name || u.username).trim()) || "amico";
}

// stesso marcatore "esplicito" gestito lato server in covers.py/charts.py
// (i bot Telegram lo anteppongono al nome artista, es. "🅴 A$AP Rocky") —
// qui serve solo per il testo di JARVIS (parlato/scritto), non tocca come
// l'artista appare altrove nell'app (segnalato da Vitto, 2026-07-30)
function stripExplicitMark(s) {
  return (s || "").replace(/^\s*(?:🅴|\[e\]|\(explicit\))\s*/i, "");
}

// —— JARVIS: testo che si materializza/si dissolve ——————————————————
// Comparsa: macchina da scrivere pulita, un carattere alla volta, passo
// costante — sostituisce il decode-a-simboli-casuali originale, giudicato
// "fa molto schifo" da Vitto (2026-08-01: "grafica più fluida per la
// comparizione del testo, magari lettera per lettera"). Sparizione:
// resta il glitch a simboli casuali sotto (jarvisGlitchOut/JARVIS_GLITCH_CHARS),
// non toccato — la richiesta riguardava solo la comparsa.
const JARVIS_GLITCH_CHARS = "!<>-_\\/[]{}—=+*^?#$%&@~";

function jarvisGlitchStep(chars, revealFromLeft, revealCount) {
  return chars
    .map((c, i) => {
      if (c === " ") return " ";
      const revealed = revealFromLeft ? i < revealCount : i >= chars.length - revealCount;
      if (revealed) return c;
      return JARVIS_GLITCH_CHARS[Math.floor(Math.random() * JARVIS_GLITCH_CHARS.length)];
    })
    .join("");
}

/** Materializza finalText in el, un carattere alla volta da sinistra, a
 * passo costante (non una durata fissa totale) così una frase lunga non
 * lampeggia via in fretta rispetto a una corta. */
function jarvisTypeIn(el, finalText, msPerChar = 22) {
  if (!el) return;
  el.classList.remove("dj-line-glitching");
  const start = performance.now();
  const total = Math.max(1, finalText.length * msPerChar);
  function frame(now) {
    const t = Math.min(1, (now - start) / total);
    el.textContent = finalText.slice(0, Math.floor(t * finalText.length));
    if (t < 1) requestAnimationFrame(frame);
    else el.textContent = finalText;
  }
  requestAnimationFrame(frame);
}

/** Il contrario: il testo ATTUALE di el si scompone in simboli casuali e
 * sparisce, da destra verso sinistra, con un piccolo tremolio/RGB-split
 * (vedi .dj-line-glitching in style.css) per un effetto più "glitch". */
function jarvisGlitchOut(el, duration = 380) {
  if (!el || !el.textContent) return;
  const chars = el.textContent.split("");
  const start = performance.now();
  el.classList.add("dj-line-glitching");
  function frame(now) {
    const t = Math.min(1, (now - start) / duration);
    el.textContent = jarvisGlitchStep(chars, false, Math.floor(t * chars.length));
    if (t < 1) requestAnimationFrame(frame);
    else {
      el.textContent = "";
      el.classList.remove("dj-line-glitching");
    }
  }
  requestAnimationFrame(frame);
}

let jarvisGlitchOutTimer = 0;

/** Da chiamare al posto di "djLine.textContent = testo" — materializza
 * invece di scattare, e annulla uno sparire-a-glitch già programmato per
 * la riga precedente (altrimenti due timer in corsa si accavallano). */
function jarvisSetLine(text) {
  if (jarvisGlitchOutTimer) {
    clearTimeout(jarvisGlitchOutTimer);
    jarvisGlitchOutTimer = 0;
  }
  jarvisTypeIn(djLine, text);
}

/** Da chiamare dopo che JARVIS ha finito di parlare — sparisce a glitch
 * subito, nello stesso istante (richiesta di Vitto, 2026-08-02: prima
 * restava a schermo qualche secondo in più "per leggerlo", ha cambiato
 * idea). Resta un setTimeout (non una chiamata diretta a jarvisGlitchOut)
 * solo per riusare lo stesso meccanismo di cancellazione di jarvisSetLine
 * (jarvisGlitchOutTimer) se una riga nuova arriva nello stesso istante. */
function jarvisScheduleLineGlitchOut(delay = 0) {
  if (jarvisGlitchOutTimer) clearTimeout(jarvisGlitchOutTimer);
  jarvisGlitchOutTimer = setTimeout(() => {
    jarvisGlitchOutTimer = 0;
    jarvisGlitchOut(djLine);
  }, delay);
}

// Kokoro (vedi kokoro-service/service.py) ha solo due pipeline: "i"
// (italiana) e "a" (inglese/americana) — niente terze lingue vere. Liste di
// stopword corte solo per distinguere inglese/italiano nei titoli/artisti;
// vedi guessJarvisSegmentLang più sotto per come vengono usate.
const JARVIS_LANG_STOPWORDS = {
  en: new Set([
    "the", "and", "you", "your", "yours", "my", "mine", "me", "love", "night",
    "baby", "girl", "boy", "know", "like", "never", "again", "heart", "one",
    "time", "life", "world", "dream", "dreams", "home", "way", "for", "with",
    "without", "only", "just", "now", "when", "where", "what", "who", "why",
    "how", "this", "that", "these", "those", "will", "would", "could",
    "should", "can", "cannot", "not", "yeah", "feel", "feeling", "feelings",
    "want", "need", "gonna", "wanna", "gotta", "let", "we", "us", "they",
    "them", "he", "she", "is", "are", "was", "were", "been", "of", "on",
    "from", "up", "down", "over", "under",
  ]),
  it: new Set([
    "il", "lo", "la", "gli", "le", "uno", "una", "che", "non", "per", "con",
    "tra", "fra", "questo", "questa", "questi", "queste", "quello", "quella",
    "sono", "sei", "è", "siamo", "siete", "amore", "cuore", "notte", "vita",
    "tempo", "mai", "sempre", "ancora", "anche", "come", "dove", "quando",
    "perché", "chi", "cosa", "tutto", "tutti", "noi", "voi", "loro", "mio",
    "tuo", "suo", "nostro", "vostro", "bella", "bello", "ragazza", "ragazzo",
    "sogno", "sogni", "casa", "mondo", "niente", "nulla", "solo", "sola",
    "senza", "dentro", "fuori",
  ]),
};

/** Euristica a stopword, non rilevamento lingua vero: conta quante parole
 * combaciano con le liste inglese/italiana sopra. Se non emerge un segnale
 * chiaro per nessuna delle due (titolo/artista in un'altra lingua, o solo
 * un nome proprio) di default va in italiano — richiesta di Vitto,
 * 2026-08-04: "se il linguaggio non è eng o ita, lo parla in italiano". */
function guessJarvisSegmentLang(text) {
  const words = String(text || "").toLowerCase().match(/[a-zà-öø-ÿ']+/g) || [];
  if (!words.length) return "it";
  let enScore = 0;
  let itScore = 0;
  for (const w of words) {
    if (JARVIS_LANG_STOPWORDS.en.has(w)) enScore++;
    if (JARVIS_LANG_STOPWORDS.it.has(w)) itScore++;
  }
  if (itScore > 0 && itScore >= enScore) return "it";
  if (enScore > 0) return "en";
  return "it";
}

/** Spezza il template sui placeholder e marca ogni pezzo con la lingua da
 * usare in sintesi: le parti fisse del template sono italiane, titolo e
 * artista passano da guessJarvisSegmentLang — Kokoro con voce italiana
 * leggerebbe "Iron Man" con la fonemizzazione italiana, storpiandolo
 * (segnalato da Vitto, 2026-07-30). Vedi kokoro-service/service.py per la
 * sintesi vera e propria dei segmenti. */
/** Kokoro prova a pronunciare LETTERALMENTE ogni carattere del testo che
 * riceve — titoli/nomi artista pieni di decorazioni unicode o simboli
 * (es. "★", "†", bullet, emoji) escono come sillabe a caso incollate alle
 * parole vere (bug segnalato da Vitto, 2026-08-06: un titolo con caratteri
 * speciali letto come "governamento hooker"). Ripulisce lasciando solo
 * lettere di qualsiasi lingua/accenti, cifre, spazi e la punteggiatura
 * minima che il parlato usa comunque — non tocca {title}/{artist} prima
 * dello split, quindi non rischia di rompere il templating in buildJarvisSegments. */
function sanitizeForSpeech(s) {
  return (s || "")
    .replace(/[^\p{L}\p{N}\s'’.,!?&-]/gu, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function buildJarvisSegments(tpl, item) {
  const title = sanitizeForSpeech(stripExplicitMark(item && item.title)) || "questo brano";
  const artist =
    sanitizeForSpeech(stripExplicitMark(item && item.artist)) || "un artista che ti piace";
  const user = jarvisUserName();
  return tpl
    .split(/(\{title\}|\{artist\}|\{user\})/)
    .map((p) => {
      if (p === "{title}") return { text: title, lang: guessJarvisSegmentLang(title) };
      if (p === "{artist}") return { text: artist, lang: guessJarvisSegmentLang(artist) };
      if (p === "{user}") return { text: user, lang: "it" };
      return { text: p, lang: "it" };
    })
    // Kokoro sintetizza ogni segmento in ISOLAMENTO: non sa che in realtà
    // continua in un altro segmento subito dopo. Uno split su {title}/
    // {artist} lascia spesso virgole/punti orfani a bordo segmento (es.
    // "Si parte con {title}, di {artist}." → l'ultimo segmento è
    // letteralmente solo "."), che Kokoro legge come fine-frase VERA
    // (respiro/calo di intonazione) anche a metà discorso — probabile
    // causa reale del "blip" (Vitto, 2026-07-30, dopo aver riletto i
    // template), non la giunzione in sé (fade/crossfade già a posto). La
    // pausa naturale tra segmenti la dà già il crossfade/silenzio lato
    // kokoro-service: la punteggiatura di contorno è ridondante e rischiosa.
    .map((seg) => ({ ...seg, text: seg.text.replace(/^[\s,.;:!?]+|[\s,.;:!?]+$/g, "") }))
    .filter((seg) => seg.text);
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** Segmenti → voce via Kokoro (sintesi locale, gratis, container Docker
 * separato — vedi memoria progetto crackify_ai_dj_plan). Accetta anche una
 * stringa semplice (un solo segmento italiano) per comodità dei chiamanti
 * più semplici. Riproduce su un <audio> dedicato, separato dal player
 * musicale — non deve toccare nowPlaying/media session/scrobbling del
 * brano vero. Risolve a fine riproduzione (o subito se qualcosa va
 * storto) così playQueueIndex può aspettare prima di far partire il
 * brano vero. */
/** Fetch+sintesi soltanto, senza riprodurre — separato da playJarvisSpeech
 * apposta per poterlo lanciare in ANTICIPO su una battuta futura mentre
 * quella attuale sta ancora suonando (vedi startJarvisSession: saluto +
 * annuncio brano partono in parallelo), invece di aspettare che la
 * riproduzione corrente finisca prima di iniziare rete+sintesi della
 * prossima — quel sequenziale era il "buco" tra le due battute (Vitto,
 * 2026-08-03: "la distanza tra le due frasi è eccessiva"). */
async function fetchJarvisSpeech(segmentsOrText) {
  if (!jarvisSpeechAudio) return null;
  // JARVIS non deve MAI parlare sopra il brano in corso — coperto già per
  // l'apertura sheet (unlockMainAudioForAutoplay) e le transizioni tra
  // brani (playQueueIndex), ma non per le risposte alle richieste testuali
  // (handleJarvisRequest), che potevano partire col brano vecchio ancora
  // in riproduzione (bug segnalato da Vitto, 2026-07-30). Messo qui, punto
  // unico di sintesi vocale, così vale per ogni chiamante presente e
  // futuro senza doverselo ricordare ad ogni call site.
  if (audio && !audio.paused) audio.pause();
  const segments =
    typeof segmentsOrText === "string" ? [{ text: segmentsOrText, lang: "it" }] : segmentsOrText;
  const displayText = segments.map((s) => s.text).join(" ");
  try {
    const res = await fetch(apiUrl("/api/jarvis/speak"), {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ segments }),
    });
    if (!res.ok) throw new Error("TTS " + res.status);
    // profilo di energia della battuta appena sintetizzata (vedi
    // envelope.get_envelope_from_bytes lato server) — stessa idea di
    // currentEnvelope per la musica (letto via jarvisSpeechAudio.currentTime,
    // vedi envelopeSpeechLevel sotto), ma per audio usa-e-getta niente
    // endpoint a parte: arriva come header sulla STESSA risposta.
    let envelope = null;
    try {
      const raw = res.headers.get("X-Jarvis-Envelope");
      if (raw) envelope = JSON.parse(raw);
    } catch (_) {
      envelope = null;
    }
    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);
    return { objectUrl, displayText, envelope };
  } catch (err) {
    console.warn("JARVIS TTS non disponibile", err);
    return null;
  }
}

/** onStart: chiamato quando l'audio della battuta comincia DAVVERO a
 * suonare (play() risolto) — è il momento esatto in cui startJarvisSoundbarLoop
 * porta jarvis-speaking a true (schermo nero + soundbar arancio, vedi
 * .jarvis-mode.jarvis-speaking in style.css) al giro di rAF successivo.
 * openDjSheet lo usa per rivelare lo sheet solo quando questo screen è
 * già pronto, invece che un attimo prima (bug segnalato da Vitto,
 * 2026-08-03: "entro e non c'è ancora lo schermo nero con soundbar"). */
async function playJarvisSpeech(fetched, onStart) {
  if (!jarvisSpeechAudio || !fetched) return;
  const { objectUrl, displayText, envelope } = fetched;
  jarvisSpeechEnvelope = envelope;
  jarvisSpeechAudio.src = objectUrl;
  try {
    // niente start/stop espliciti sulla soundbar qui: startJarvisSoundbarLoop
    // (sempre attivo mentre lo sheet è aperto) rileva da solo, ogni frame,
    // che jarvisSpeechAudio sta suonando e passa in modalità voce.
    // jarvisSetLine (l'animazione del testo) invece va agganciata al
    // successo VERO di play() — prima partiva subito alla chiamata di
    // speakJarvisText, ben prima che fetch+sintesi finissero: il testo
    // finiva di materializzarsi mentre l'audio non era nemmeno partito
    // (segnalato da Vitto, "non è sintonizzata bene").
    await new Promise((resolve) => {
      jarvisSpeechAudio.onended = resolve;
      jarvisSpeechAudio.onerror = resolve;
      // rete di sicurezza: se qualcosa mette in pausa questo audio da
      // FUORI (vedi playFromList, che ferma JARVIS se l'utente fa
      // partire musica a mano mentre sta parlando) né onended né onerror
      // scattano — senza onpause questa Promise resterebbe in sospeso
      // per sempre, lasciando jarvisTransitionBusy/jarvisSessionStarting
      // bloccati a true (i loro finally non girerebbero mai). onended
      // può far scattare anche onpause a fine naturale: resolve() è
      // innocuo se chiamato due volte.
      jarvisSpeechAudio.onpause = resolve;
      jarvisSpeechAudio
        .play()
        .then(() => {
          if (onStart) onStart();
          jarvisSetLine(displayText);
        })
        .catch(resolve);
    });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function speakJarvisText(segmentsOrText, onStart) {
  const fetched = await fetchJarvisSpeech(segmentsOrText);
  await playJarvisSpeech(fetched, onStart);
}

async function speakJarvisLine(item) {
  const segments = buildJarvisSegments(pickRandom(JARVIS_TRACK_LINES), item);
  await speakJarvisText(segments);
  jarvisScheduleLineGlitchOut();
}

// sotto questa soglia il mix di JARVIS integra con una ricerca (vedi
// buildJarvisPool) — stessa soglia "15" già usata per Daily Mix, vedi
// crackify_daily_mix_network_debug in memoria
const JARVIS_POOL_MIN = 15;

function jarvisDedupeKey(t) {
  return `${(t.title || "").trim().toLowerCase()}|${(t.artist || "").trim().toLowerCase()}`;
}

function mergeJarvisPool(pool, seen, tracks) {
  for (const t of tracks || []) {
    const key = jarvisDedupeKey(t);
    if (!key.trim() || seen.has(key)) continue;
    seen.add(key);
    pool.push(t);
  }
}

// Le tracce grezze di /api/discovery-weekly e /api/daily-mixes NON sono
// riproducibili così come sono: playQueueItem le smista in base a
// item.source, e per queste due il ramo "lazy" (resolveLazyItem) si aspetta
// anche chartIndex/mixIndex — sono gli stessi campi che lazyItemFromTrack
// aggiunge quando l'utente le apre dalla UI normale (vedi openDiscoveryWeekly/
// openDailyMix), ma qui non passiamo da lì. Senza, item.source resta
// undefined, playQueueItem finisce nel ramo "search" senza search_id,
// throw, e il catch in playQueueItem salta al brano successivo — che ha
// LO STESSO problema, quindi parla e salta all'infinito senza mai suonare
// niente (bug segnalato da Vitto, 2026-07-30).
function annotateDiscoveryTrack(t) {
  return { ...t, qid: uid(), source: "discovery_weekly", chartIndex: t.index };
}
function annotateDailyMixTrack(t, mixIndex) {
  return { ...t, qid: uid(), source: "daily_mix", chartIndex: t.index, mixIndex };
}
// i brani salvati arrivano già completi da /api/library (source: "library",
// stream_url, id — vedi playLibraryTrack/libraryTracksCache), nessuna
// annotazione da aggiungere.
function annotateSearchTrack(t, searchId) {
  return { ...t, qid: uid(), source: "search", search_id: searchId, index: t.index };
}
// stessa annotazione che lazyItemFromTrack aggiunge quando l'utente apre
// una playlist Deezer dalla UI normale — serve per la richiesta "vibe"
// di JARVIS (vedi handleJarvisRequest), che pesca da una playlist Deezer
// trovata per genere invece che da un brano preciso
function annotateDeezerPlaylistTrack(t, playlistId) {
  return { ...t, qid: uid(), source: "deezer_playlist", chartIndex: t.index, playlistId };
}
// stessa idea, per la richiesta "metti dei Pink Floyd" di JARVIS (vedi
// handleJarvisRequest) — a differenza di artistItemFromTrack (pagina
// artista) NON legge _detailKind/openArtistId: qui l'artista non è
// "aperto" da nessuna parte nella UI, l'id arriva solo dalla ricerca
// JARVIS, quindi va passato esplicito come per playlistId sopra.
function annotateDeezerArtistTrack(t, artistId) {
  return { ...t, qid: uid(), source: "deezer_artist", chartIndex: t.index, artistId };
}
// stessa idea, per il fallback "album" di resolveJarvisRequest — resolveLazyItem
// per "deezer_album" legge l'id album da item.artistId (stessa convenzione
// già usata dalla pagina album normale, non un nome nuovo inventato qui)
function annotateDeezerAlbumTrack(t, albumId) {
  return { ...t, qid: uid(), source: "deezer_album", chartIndex: t.index, artistId: albumId };
}

function shuffleArray(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Il mix di JARVIS pesca da Discovery Weekly + brani salvati + tutte le
 * Daily Mix, deduplicati per title+artist (fonti diverse, non c'è un id
 * unificato su cui contare). Se il pool resta magro (utente nuovo,
 * libreria vuota) integra con qualche /api/search sui nomi artista già
 * nel pool — stessa strada della barra di ricerca normale, quindi la
 * stessa cache/riuso riferimenti già costruita per non spammare i bot
 * Telegram (vedi crackify_telegram_exposure_architecture in memoria).
 * Usata solo se serve davvero, e si ferma al primo errore/rate-limit
 * invece di insistere. */
async function buildJarvisPool() {
  const pool = [];
  const seen = new Set();
  const [discovery, library, dailyMixes] = await Promise.all([
    apiJson("/api/discovery-weekly").catch(() => ({ tracks: [] })),
    apiJson("/api/library").catch(() => ({ tracks: [] })),
    apiJson("/api/daily-mixes").catch(() => ({ mixes: [] })),
  ]);
  mergeJarvisPool(pool, seen, (discovery.tracks || []).map(annotateDiscoveryTrack));
  // NON già completi come pensava il commento originale: /api/library non
  // manda mai un campo "source" (list_tracks in library.py fa solo
  // dict(t) + stream_url/cover), quindi senza annotazione qui
  // playQueueItem non riconosce questi brani (non "library", non nessun
  // altro ramo noto) e cade nel fallback "search" con item.search_id
  // mancante → throw "search scaduta — cerca di nuovo". Prima passava
  // quasi sempre inosservato nel mix piatto (1 brano su tanti); coi
  // gruppi diventa fatale ogni volta che finisce in posizione 0 di un
  // gruppo (bug segnalato da Vitto, 2026-07-31: "la prima canzone di
  // JARVIS non viene riprodotta", confermato dai debug probe lato server).
  mergeJarvisPool(pool, seen, library.tracks.map((t) => ({ ...t, source: "library" })));
  for (const mix of dailyMixes.mixes || []) {
    mergeJarvisPool(pool, seen, (mix.tracks || []).map((t) => annotateDailyMixTrack(t, mix.mix_index)));
  }

  if (pool.length < JARVIS_POOL_MIN) {
    const seedArtists = [...new Set(pool.map((t) => t.artist).filter(Boolean))];
    for (const artist of seedArtists.slice(0, 3)) {
      if (pool.length >= JARVIS_POOL_MIN) break;
      try {
        const data = await apiJson("/api/search", { query: artist });
        mergeJarvisPool(pool, seen, (data.tracks || []).map((t) => annotateSearchTrack(t, data.search_id)));
      } catch (_) {
        break; // rate limit o bridge offline: si parte con quello che c'è
      }
    }
  }
  return pool;
}

// quanti brani per gruppo — vedi groupJarvisPool/jarvisHandleTrackLeft
const JARVIS_GROUP_SIZE = 4;

/** Raggruppa il pool in batch di JARVIS_GROUP_SIZE brani dello stesso
 * "tipo" — non esiste un tag di genere per singolo brano (genere esiste
 * solo a livello di seed/chart, vedi CHART_DEFS in charts.py), quindi
 * usiamo il cluster di provenienza come proxy: ogni Daily Mix è già un
 * cluster di affinità per artisti correlati (union-find, vedi memoria
 * progetto crackify_daily_mix), i brani senza cluster esplicito (libreria,
 * ricerca di scorta) si raggruppano per artista, Discovery Weekly resta un
 * blocco unico (già una lista pesata per gusto, vedi
 * crackify_discovery_weekly). Ordine dei gruppi mescolato, così la
 * sessione alterna "tipi" invece di esaurirne uno alla volta. Richiesta di
 * Vitto, 2026-07-31: "lavorare a gruppi di 4 canzoni dello stesso
 * tipo/genere".
 */
function groupJarvisPool(pool) {
  const buckets = new Map();
  for (const t of pool) {
    const key =
      t.source === "daily_mix"
        ? `mix:${t.mixIndex}`
        : t.source === "discovery_weekly"
          ? "discovery"
          : t.source === "deezer_playlist"
            ? `playlist:${t.playlistId}`
            : `artist:${(t.artist || "").trim().toLowerCase()}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(t);
  }
  const groups = [];
  for (const [key, tracks] of buckets) {
    const shuffled = shuffleArray(tracks);
    for (let i = 0; i < shuffled.length; i += JARVIS_GROUP_SIZE) {
      groups.push({ key, tracks: shuffled.slice(i, i + JARVIS_GROUP_SIZE) });
    }
  }
  return shuffleArray(groups);
}

/** Scarica in anticipo (fire-and-forget) i brani passati — pensata per
 * "le altre" di un gruppo JARVIS appena diventato attivo (i chiamanti
 * passano tracks.slice(1): MAI il primo brano, che viene risolto "per
 * davvero" pochi istanti dopo da playQueueItem — chiamarlo anche qui in
 * parallelo faceva scontrare due risoluzioni concorrenti sulla stessa,
 * unica conversazione col bot Telegram, vedi bridge.py _search_with/play,
 * e quella vera perdeva la risposta: bug segnalato da Vitto, 2026-07-31,
 * "la prima canzone di JARVIS non viene riprodotta"). I brani "library"
 * sono già sul device, saltati. Ri-risolvere uno di questi brani più tardi
 * (playQueueItem, al suo turno vero) resta economico anche se qui non lo
 * segna come risolto: il backend riconosce il riferimento già noto invece
 * di ricontattare Telegram (vedi _known_play_result/find_media_by_meta in
 * main.py), quindi basta scaldare la cache lato server in anticipo, non
 * serve far combaciare gli oggetti in coda.
 */
async function jarvisPrefetchGroupAhead(tracks) {
  // sequenziale, non in parallelo: il bridge Telegram ha un unico lock per
  // conversazione bot (bridge.py, self._lock) — sparare più resolve insieme
  // non li rende più veloci, li mette solo in coda sullo stesso lock. Se il
  // brano "vero" (quello che JARVIS sta per annunciare) arriva mentre 2-3
  // prefetch sono già in coda, aspetta anche lui dietro di loro anche se il
  // bot stesso risponde in pochi secondi (diagnosticato da Vitto, 2026-08-06,
  // confrontando i nostri log coi timestamp reali su Telegram: il bot non
  // era mai lento, era la coda lato nostro). Sequenziale tiene al massimo
  // UN prefetch in coda alla volta, invece di 2-3, riducendo di netto la
  // finestra in cui il brano vero può restare bloccato dietro di loro.
  for (const t of tracks) {
    if (t.source === "library") continue;
    if (t.source === "search") {
      await prefetchSearchQueueItem(t);
    } else {
      await resolveLazyItem(t, { prefetch: true }).catch(() => {});
    }
  }
}

let jarvisGroups = []; // gruppi {key, tracks} non ancora serviti in questa sessione
let jarvisUsedKeys = new Set(); // cluster già serviti (evita ripetizioni finché ce n'è un altro)
let jarvisRejectedKeys = new Set(); // cluster con tutti i brani skippati — ultima spiaggia se non c'è altro
let jarvisActiveGroup = null; // { key, qids: Set, total, skipCount, doneCount } — gruppo in coda ORA

/** Un brano del gruppo JARVIS attivo è appena stato lasciato (skip manuale
 * o fine naturale) — aggiorna il conteggio e, se il gruppo è esaurito,
 * decide il prossimo: se TUTTI i brani sono stati skippati, quel "tipo"
 * viene evitato finché ce n'è un altro non ancora provato. Richiesta di
 * Vitto, 2026-07-31: "se l'utente skippa tutte e 4 deve ripensarci e
 * trovare un contenuto che l'utente non skippa". Chiamata sia da playNext
 * (skip manuale) sia dall'handler "ended" (fine naturale) — unico punto
 * dove il gruppo avanza, stesso pattern di playQueueIndex per gli annunci.
 */
function jarvisHandleTrackLeft(wasSkipped) {
  if (!jarvisSessionActive || !jarvisActiveGroup) return;
  const item = queue.items[queue.index];
  if (!item || !jarvisActiveGroup.qids.has(item.qid)) return;
  if (wasSkipped) {
    jarvisActiveGroup.skipCount++;
    // evict subito, non aspettare il TTL — uno skippato non serve più
    if (nowPlaying.token) releasePlayedMedia(nowPlaying.token);
  } else {
    jarvisActiveGroup.doneCount++; // eviction di fine naturale già gestita dal chiamante
  }
  if (jarvisActiveGroup.skipCount + jarvisActiveGroup.doneCount < jarvisActiveGroup.total) return;
  if (jarvisActiveGroup.skipCount === jarvisActiveGroup.total) {
    jarvisRejectedKeys.add(jarvisActiveGroup.key);
  }
  jarvisAdvanceToNextGroup();
}

/** Sceglie ed accoda il prossimo gruppo: preferisce un cluster mai
 * servito, poi uno servito-ma-non-rifiutato, solo come ultima spiaggia uno
 * già rifiutato (pool finito). Se jarvisGroups è vuoto la coda finisce qui,
 * come a fine coda normale — nessun rebuild automatico del pool in questa
 * versione. */
function jarvisAdvanceToNextGroup() {
  if (!jarvisGroups.length) {
    jarvisActiveGroup = null;
    return;
  }
  let idx = jarvisGroups.findIndex((g) => !jarvisUsedKeys.has(g.key));
  if (idx < 0) idx = jarvisGroups.findIndex((g) => !jarvisRejectedKeys.has(g.key));
  if (idx < 0) idx = 0;
  const next = jarvisGroups.splice(idx, 1)[0];
  jarvisUsedKeys.add(next.key);
  const entries = next.tracks.map((it) => ({ ...it, userQueued: false }));
  jarvisActiveGroup = {
    key: next.key,
    qids: new Set(entries.map((t) => t.qid)),
    total: entries.length,
    skipCount: 0,
    doneCount: 0,
  };
  queue.items.push(...entries);
  if (shuffleOn) rebuildShuffleOrder();
  updateQueueUi();
  // MAI il primo del nuovo gruppo — stesso motivo di startJarvisSession
  jarvisPrefetchGroupAhead(entries.slice(1));
}

// jarvisSessionActive diventa true solo dentro playFromList, in fondo a
// tutta la catena async — un secondo tap sul banner MENTRE il primo sta
// ancora costruendo il pool/parlando non veniva bloccato, e faceva partire
// una sessione parallela (log: 5 chiamate a /api/jarvis/speak di fila prima
// di un solo caricamento brano — bug segnalato da Vitto, "parla solo non
// carica musica"). Guardia sincrona separata, impostata SUBITO all'ingresso.
let jarvisSessionStarting = false;

/** JARVIS a tutto schermo: quando ha finito di parlare e suona la canzone,
 * al posto della soundbar torna la copertina (05/10 sul telefono, Vitto:
 * «come abbiamo fatto per desktop»). Da desktop dal 01/10 lo faceva il
 * guscio Mac (shell.js) con questa stessa regola, che ora vive qui per
 * tutti: la soundbar resta mentre JARVIS parla (.jarvis-speaking, che il
 * ciclo della soundbar tiene acceso anche durante la dissolvenza della
 * battuta) o si sta avviando — prima del saluto la copertina sarebbe
 * quella del brano di PRIMA. L'aspetto è in style.css (.crk-jarvis-cover). */
function aggiornaCoverJarvis() {
  if (!npSheet) return;
  const on =
    npSheet.classList.contains("jarvis-mode") &&
    !npSheet.classList.contains("jarvis-speaking") &&
    !jarvisSessionStarting &&
    !!(nowPlaying && nowPlaying.title);
  // il confronto evita il giro infinito: toccare la classe risveglierebbe
  // l'osservatore qui sotto
  if (npSheet.classList.contains("crk-jarvis-cover") !== on) {
    npSheet.classList.toggle("crk-jarvis-cover", on);
  }
}
if (npSheet && typeof MutationObserver === "function") {
  new MutationObserver(aggiornaCoverJarvis).observe(npSheet, {
    attributes: true,
    attributeFilter: ["class"],
  });
}
// stesso tipo di guardia di jarvisSessionStarting, ma per il ciclo
// annuncio→ricerca→riproduzione di OGNI brano (non solo l'avvio sessione)
// — vedi playQueueIndex
let jarvisTransitionBusy = false;

// Il primo brano della sessione veniva annunciato con DUE battute
// sequenziali (saluto, poi "si parte con X") — due andata/ritorno di
// sintesi Kokoro (più lenta di Piper) prima del primo audio.play() vero,
// abbastanza da superare la finestra di autoplay concessa dal browser
// dopo il tap originale: bug segnalato da Vitto ("dopo l'intro non sento
// musica", poi confermato "solo alla prima"). Fix: saluto + primo annuncio
// in UN'UNICA battuta, un solo giro di sintesi — playQueueIndex salta
// l'annuncio per quel brano specifico (già fatto qui), vedi
// jarvisSkipNextAnnounce.
let jarvisSkipNextAnnounce = false;

// generation counter: bump da cancelJarvisSessionStart per invalidare una
// startJarvisSession ancora in corso — ogni checkpoint qui sotto controlla
// "sono ancora la generazione corrente?" dopo ogni await e abbandona subito
// se no, invece di proseguire fino a far parlare JARVIS/aprire il fullscreen
// nonostante l'utente abbia già annullato dalla X (vedi cancelJarvisSessionStart).
let _jarvisSessionGen = 0;

/** onReady: chiamato appena il pool è pronto e il primo gruppo è stato
 * scelto, PRIMA che JARVIS inizi davvero a parlare — segnale per openDjSheet
 * per rivelare lo sheet solo a questo punto invece che su una schermata
 * vuota mentre pool/rete lavorano ancora (vedi lì il loadingOverlay). Non
 * chiamato se la sessione era già attiva/in avvio (return anticipato) o va
 * in errore prima di arrivare qui — openDjSheet copre questi casi con un
 * .finally() lato chiamante. */
async function startJarvisSession(onReady) {
  if (jarvisSessionActive || jarvisSessionStarting) return;
  jarvisSessionStarting = true;
  aggiornaCoverJarvis();
  const myGen = ++_jarvisSessionGen;
  const cancelled = () => myGen !== _jarvisSessionGen;
  // reclama SUBITO questo device come player attivo, ben prima del primo
  // audio.play() (che arriva solo dopo saluto+resolve, anche parecchi
  // secondi dopo) — senza, il poll periodico multi-device (vedi
  // applyRemoteMirror/startRemoteCommandPoll) può ancora vedere un ALTRO
  // device come attivo (es. una sessione rimasta aperta sul Mac) e forzare
  // un pause+mirror sopra il primo brano di JARVIS. Bug reale trovato
  // testando su iPhone col Mac ancora loggato: "carica ma non riproduce",
  // mini bar che mostrava il brano dell'altro device. Fire-and-forget:
  // non deve ritardare il saluto.
  claimThisPlayer(true);
  try {
    // il saluto è testo generico (non dipende dal primo brano, vedi sotto)
    // — parte SUBITO, in parallelo alla costruzione del pool, invece di
    // aspettare che quella finisca prima di iniziare rete+sintesi Kokoro.
    // Prima erano in sequenza (pool → poi saluto): la schermata di
    // caricamento sommava i due tempi invece di sovrapporli, e su rete/
    // Mac non fulminei si sentiva (Vitto, 2026-08-05: "ci mette troppo").
    const greetingSegments = buildJarvisSegments(pickRandom(JARVIS_GREETING_LINES), null);
    const greetingSpeech = fetchJarvisSpeech(greetingSegments);
    const pool = await buildJarvisPool();
    if (cancelled()) return; // X premuta mentre il pool si costruiva
    if (!pool.length) {
      toast("JARVIS non ha ancora abbastanza dati per prepararti un mix");
      return;
    }
    jarvisGroups = groupJarvisPool(pool);
    jarvisUsedKeys = new Set();
    jarvisRejectedKeys = new Set();
    const first = jarvisGroups.shift();
    jarvisUsedKeys.add(first.key);
    const firstEntries = first.tracks.map((it) => ({ ...it, userQueued: false }));
    jarvisActiveGroup = {
      key: first.key,
      qids: new Set(firstEntries.map((t) => t.qid)),
      total: firstEntries.length,
      skipCount: 0,
      doneCount: 0,
    };
    // scalda dal 2° brano in poi mentre JARVIS parla — MAI il primo: il
    // bridge Telegram ha un'unica conversazione/lock col bot (vedi
    // bridge.py, _search_with drena i messaggi pendenti ad ogni nuova
    // interazione), e il primo brano viene comunque risolto "per davvero"
    // pochi istanti dopo da playQueueItem — le due risoluzioni concorrenti
    // sullo stesso brano si pestavano i piedi sulla stessa conversazione
    // bot, e quella vera perdeva la risposta (bug segnalato da Vitto,
    // 2026-07-31: "la prima canzone di JARVIS non viene riprodotta" —
    // mini bar caricata, zero audio). Vedi jarvisPrefetchGroupAhead.
    jarvisPrefetchGroupAhead(firstEntries.slice(1));
    // due messaggi separati (saluto, poi frase sul brano), non un unico
    // testo concatenato — richiesta di Vitto, 2026-08-01: unendoli il
    // testo a schermo diventava un'unica frase-fiume senza punteggiatura
    // di raccordo tra saluto e annuncio ("fa molto schifo"), oltre a non
    // riflettere che sono due battute distinte. Il glitch-out va schedulato
    // solo dopo la SECONDA (altrimenti sparirebbe il saluto a metà sessione
    // mentre il brano sta ancora per partire). Saluto già partito sopra, in
    // parallelo al pool — qui solo l'annuncio del brano, che invece DEVE
    // aspettare firstEntries[0].
    const trackSegments = buildJarvisSegments(pickRandom(JARVIS_TRACK_LINES), firstEntries[0]);
    const trackSpeech = fetchJarvisSpeech(trackSegments);
    if (cancelled()) return; // X premuta mentre pool+sintesi erano in volo
    // BUG reale trovato con i log (Vitto, 2026-08-04 — "ancora lo sento"):
    // il controllo qui sopra scatta PRIMA di "await greetingSpeech", che è
    // la fetch/sintesi Kokoro vera, lunga anche secondi interi. Annullare
    // DURANTE quell'attesa passava il checkpoint di sopra (non ancora
    // cancellato in quel momento) ma poi playJarvisSpeech partiva comunque
    // alla cieca — .src+.play() incondizionati, senza mai controllare se
    // nel frattempo l'utente aveva annullato. Serve un controllo SUBITO
    // PRIMA di ogni playJarvisSpeech, dopo aver aspettato la fetch, non
    // solo prima di iniziarla.
    const greetingFetched = await greetingSpeech;
    if (cancelled()) return;
    // onReady passato come onStart: non appena l'audio del saluto comincia
    // DAVVERO a suonare (non solo quando il pool è pronto — la fetch di
    // sintesi in mezzo può durare vari frame), non prima.
    await playJarvisSpeech(greetingFetched, onReady);
    // cancelJarvisSessionStart mette in pausa jarvisSpeechAudio per liberare
    // l'await qui sopra (onpause, vedi playJarvisSpeech) — senza questo
    // controllo si proseguiva comunque con la seconda battuta e poi con la
    // musica vera, nonostante l'utente avesse già premuto la X (bug
    // segnalato da Vitto, 2026-08-04).
    if (cancelled()) return;
    const trackFetched = await trackSpeech;
    if (cancelled()) return;
    await playJarvisSpeech(trackFetched);
    if (cancelled()) return;
    jarvisScheduleLineGlitchOut();
    jarvisSkipNextAnnounce = true;
    await playFromList(firstEntries, 0, null, true);
  } catch (err) {
    if (!err.cancelled && !cancelled()) toast("JARVIS non è riuscito a preparare il mix: " + (err.message || err));
    // debug temporaneo — vedi Vitto 2026-07-31, "la prima canzone di
    // JARVIS non viene riprodotta": nessuna richiesta di resolve arriva
    // mai al server, serve vedere l'eccezione vera lato client
    debugLog("jarvis-session-error", { message: err && err.message, stack: err && err.stack });
  } finally {
    jarvisSessionStarting = false;
    // l'avvio finito non tocca classi: la cover va rivalutata a mano
    aggiornaCoverJarvis();
  }
}

/** Annulla per davvero una startJarvisSession ancora in corso — richiamata
 * dalla X sulla schermata di caricamento (vedi openDjSheet). Prima la X si
 * limitava a "saltare l'attesa" (apriva comunque il fullscreen, JARVIS
 * continuava a parlare in background): bug segnalato da Vitto, 2026-08-04.
 * Bump del generation counter (fa fallire ogni cancelled() check dentro
 * startJarvisSession) + stop vero dell'audio in corso, così non resta
 * nessun residuo — niente fullscreen, niente voce, niente musica. */
function cancelJarvisSessionStart() {
  _jarvisSessionGen++;
  debugLog("jarvis-cancel-session-start", {
    audioPaused: !!(jarvisSpeechAudio && jarvisSpeechAudio.paused),
    audioSrc: !!(jarvisSpeechAudio && jarvisSpeechAudio.src),
    audioCurrentTime: jarvisSpeechAudio ? jarvisSpeechAudio.currentTime : null,
  });
  if (jarvisSpeechAudio) {
    jarvisSpeechAudio.pause();
    // pause() da solo dovrebbe bastare, ma segnalato da Vitto ("dice solo la
    // frase intro" — cioè continua a sentirla FINO ALLA FINE naturale
    // invece di tagliarsi subito): svuotare src e richiamare load() forza
    // l'elemento ad ABBANDONARE qualunque play/decode in corso, non solo
    // metterlo in pausa — reset più duro, stesso pattern usato ovunque sul
    // web per uno stop "vero" di un <audio>.
    jarvisSpeechAudio.removeAttribute("src");
    jarvisSpeechAudio.load();
  }
  jarvisSetLine("");
  jarvisSessionStarting = false;
  jarvisSessionActive = false;
  aggiornaCoverJarvis();
}

// —— JARVIS: richieste dell'utente ———————————————————————————————
// Livello 1: ricerca diretta (stessa /api/search della barra principale,
// quindi stessa cache/riuso Telegram) — funziona per "metti Iron Man",
// un titolo/artista preciso. Livello 2 (aggiunto 2026-07-30, segnalato da
// Vitto: "metti un po' di phonk" non trovava niente): una richiesta per
// GENERE/VIBE non è un titolo, la ricerca letteraria su Telegram non
// trova ovviamente nulla — ma è quasi certamente il nome di decine di
// playlist editoriali Deezer, quindi come fallback proviamo
// /api/deezer/playlists/search (stesso endpoint della ricerca playlist in
// Home) e peschiamo un blocco di brani dalla prima corrispondenza. Non è
// il matching semantico vero discusso a parte (capirebbe "roba per
// correre" o mood impliciti, non solo nomi di genere) — resta un problema
// aperto, vedi memoria progetto crackify_ai_dj_plan.
//
// Bug 2026-08-02 (Vitto: "metti un po di phonk" ANCORA non capisce):
// entrambi i livelli sopra interrogavano le API con la frase GREZZA
// intera, verbi e riempitivi italiani inclusi. Verificato diretto
// sull'API Deezer: /search/playlist?q=metti+un+po+di+phonk → 0
// risultati, /search/playlist?q=phonk → decine ("phonk", "Phonk
// Drift"...) — il fallback vibe quindi non scattava MAI per una frase
// parlata normale, solo per chi scriveva già il nome nudo del genere.
// cleanJarvisQuery toglie i verbi/riempitivi più comuni PRIMA di
// interrogare entrambi i livelli — non è NLU vero (stesso limite di
// sopra, non capisce mood impliciti tipo "roba per correre"), ma
// "metti/suona/riproduci/voglio ascoltare/... [un po' di] X" ora arriva
// a X pulito invece che alla frase intera.
const JARVIS_LEADING_FILLERS = [
  /^dai\s*,?\s+/i,
  /^(mi\s+)?puoi\s+mettere\s+/i,
  /^(mi\s+)?potresti\s+mettere\s+/i,
  /^mettimi\s+su\s+/i,
  /^mettimi\s+/i,
  /^metti\s+su\s+/i,
  /^metti\s+/i,
  /^suonami\s+/i,
  /^suona\s+/i,
  /^riproduci\s+/i,
  /^fai\s+partire\s+/i,
  /^parti\s+con\s+/i,
  /^avvia\s+/i,
  /^dammi\s+/i,
  /^(vorrei|voglio)\s+(ascoltare|sentire)\s+/i,
  /^fammi\s+(ascoltare|sentire)\s+/i,
  /^(ascoltiamo|sentiamo)\s+/i,
  /^qualcosa\s+di\s+/i,
  /^qualcosa\s+/i,
  /^qualche\s+/i,
  /^un\s*p[oò]['’`]?\s+di\s+/i,
  /^un\s*p[oò]['’`]?\s+/i,
  /^(della|delle|dei|del|dello)\s+/i,
];
const JARVIS_TRAILING_FILLERS = [
  /\s*,?\s*per\s+favore\s*!?$/i,
  /\s*,?\s*per\s+piacere\s*!?$/i,
  /\s*,?\s*ti\s+prego\s*!?$/i,
  /\s*,?\s*grazie\s*!?$/i,
  /\s*,?\s*dai\s*!?$/i,
];

/** "metti un po' di phonk" → "phonk". Applica i filtri in loop, non in
 * una sola passata: i comandi si accodano ("dai mettimi un po' di X") e
 * ogni passata può scoprire un nuovo prefisso solo dopo che il
 * precedente è già stato tolto. Se il risultato resta vuoto (l'utente ha
 * scritto solo un verbo, tipo "metti" e basta) ripiega sulla frase
 * originale invece di interrogare le API con una stringa vuota. */
function cleanJarvisQuery(raw) {
  let q = (raw || "").trim();
  let changed = true;
  while (changed) {
    changed = false;
    for (const re of JARVIS_LEADING_FILLERS) {
      const next = q.replace(re, "");
      if (next !== q) {
        q = next.trim();
        changed = true;
      }
    }
    for (const re of JARVIS_TRAILING_FILLERS) {
      const next = q.replace(re, "");
      if (next !== q) {
        q = next.trim();
        changed = true;
      }
    }
  }
  return q || raw.trim();
}

const JARVIS_ARTIST_FOUND_LINES = [
  "Sessione {title} in arrivo — pesco dal meglio del repertorio.",
  "Fatto, parte un blocco di {title}.",
  "Ho trovato l'artista giusto: via con {title}.",
];
const JARVIS_VIBE_FOUND_LINES = [
  'Non ho trovato un brano preciso, ma ho beccato la playlist "{title}" — parto da lì.',
  'Niente di preciso, però "{title}" fa al caso tuo. Ci siamo.',
];
const JARVIS_ALBUM_FOUND_LINES = [
  'Niente di preciso, ma ho pescato dall\'album "{title}" — si parte da lì.',
  'Non ho trovato il brano esatto, però "{title}" ci sta bene. Andiamo.',
];
// dette SUBITO all'arrivo della richiesta, in parallelo alla ricerca vera
// (vedi handleJarvisRequest) — coprono la latenza di rete invece di
// sommarcisi, e grazie a speakJarvisText (che mette SEMPRE in pausa
// l'audio prima di parlare) interrompono da sole il brano in corso senza
// bisogno di codice apposta: richiesta di Vitto, 2026-08-02, "dovremmo
// interrompere la riproduzione attuale" invece di accodare in silenzio.
const JARVIS_SEARCHING_LINES = [
  "Fammi guardare cosa trovo...",
  "Un secondo, ci penso io...",
  "Scavo in giro, aspetta...",
  "Vediamo cosa tiro fuori...",
];
const JARVIS_REQUEST_MISS_LINES = [
  'Non ho trovato niente per "{query}" — provo con altre parole?',
  'Boh, "{query}" non me lo trova nessuno. Riprova diversamente.',
];
// quanti brani mettere in coda per una richiesta "vibe" o artista — un
// solo brano non renderebbe l'idea di "metti un po' di X" / "metti dei
// Pink Floyd". 4, non una scaletta lunga: Vitto, 2026-08-02, la richiesta
// deve interrompere e ripartire subito con un blocco corto.
const JARVIS_REQUEST_QUEUE_COUNT = 4;
// pool da cui pescare i JARVIS_REQUEST_QUEUE_COUNT brani di un artista,
// prima dello shuffle — entry.tracks di /api/deezer/artists/:id è TUTTO
// il catalogo (anche centinaia di brani per un artista prolifico) ordinato
// per popolarità reale, qui teniamo solo la fetta più nota
const JARVIS_ARTIST_POOL_SIZE = 25;

// alias gergali per il fallback vibe/genere — "un po' di X" a volte non è
// un genere in senso letterale ma un modo di dire (Vitto, 2026-08-02:
// "ragazzine asiatiche" = k-pop). cleanJarvisQuery toglie solo i
// riempitivi italiani, non "capisce" il significato: qui teniamo una
// tabella piccola ed esplicita invece di indovinare — se la query pulita
// CONTIENE una delle chiavi, il Livello 2 cerca il termine vero al posto
// suo. Da allargare mano a mano che arrivano altri modi di dire.
const JARVIS_VIBE_ALIASES = {
  "ragazzine asiatiche": "k-pop",
  "ragazze asiatiche": "k-pop",
};
function resolveJarvisVibeAlias(cleaned) {
  const low = cleaned.toLowerCase();
  for (const key in JARVIS_VIBE_ALIASES) {
    if (low.includes(key)) return JARVIS_VIBE_ALIASES[key];
  }
  return cleaned;
}

// normalizza titolo/artista per il confronto "è DAVVERO questo brano" del
// Livello 1 sotto — toglie decorazioni comuni (feat., remix, "(remaster)",
// "- radio edit"...) che altrimenti farebbero fallire anche un confronto
// su un titolo vero. Il trattino va staccato da spazi su ENTRAMBI i lati
// prima di tagliare, altrimenti un titolo tipo "Non-Stop" perderebbe
// "-Stop" per errore (nessuno spazio intorno al trattino lì).
function jarvisNormalizeForMatch(s) {
  return (s || "")
    .toLowerCase()
    .replace(/\(.*?\)/g, " ")
    .replace(/\[.*?\]/g, " ")
    .replace(/\b(feat|ft|featuring)\.?\s.*$/i, " ")
    .replace(/\s[-–—]\s.*$/, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}
// Variante per nomi artista al Livello 0 di resolveJarvisRequest: toglie
// anche gli spazi interni (non solo li normalizza) — "Artie 5ive" vs
// "artiefive" (senza spazio, detto/scritto tutto attaccato) falliva il
// match esatto pur essendo chiaramente lo stesso artista, segnalato da
// Vitto 2026-08-05 (log server: livello 0 mancato, poi 6 minuti bloccato
// prima di ripiegare su un brano a caso). Resta un confronto ESATTO (non
// "contiene") solo più tollerante sugli spazi — non risolve varianti tipo
// "5ive" scritto per lettere ("five"), quello richiederebbe un dizionario
// ad hoc per singolo artista.
function jarvisNormalizeArtistForMatch(s) {
  return jarvisNormalizeForMatch(s).replace(/\s+/g, "");
}

/** Le ricerche di handleJarvisRequest (artista esatto → playlist/album
 * Deezer, stile search bar Home → artista debole come ultima spiaggia),
 * isolate qui SENZA effetti collaterali (niente coda, niente voce) — il
 * chiamante decide cosa dire e quando far partire la riproduzione. null se
 * nessun livello trova niente. */
async function resolveJarvisRequest(cleanedQuery) {
  // Livello 0: la query pulita è ESATTAMENTE il nome di un artista
  // (case-insensitive) — "metti dei Pink Floyd" → "Pink Floyd". Qui
  // peschiamo dalle top track vere dell'artista (stesso endpoint della
  // pagina artista) e ne teniamo un blocco. Match ESATTO (non "contiene")
  // per non deragliare un titolo vero solo perché esiste un artista minore
  // omonimo. Se fallisce per qualunque motivo (rete, artista senza top
  // track...) prosegue silenziosamente sotto.
  debugLog("jarvis-request-resolve-start", { cleanedQuery });
  let bestArtist = null;
  try {
    const artistData = await apiJson(`/api/deezer/artists/search?q=${encodeURIComponent(cleanedQuery)}`);
    bestArtist = (artistData.artists || [])[0] || null;
    const artistExactMatch = !!(
      bestArtist && jarvisNormalizeArtistForMatch(bestArtist.name) === jarvisNormalizeArtistForMatch(cleanedQuery)
    );
    debugLog("jarvis-request-level0-artist", {
      cleanedQuery,
      candidatesCount: (artistData.artists || []).length,
      bestArtistName: bestArtist ? bestArtist.name : null,
      exactMatch: artistExactMatch,
    });
    if (artistExactMatch) {
      const entries = await jarvisArtistPoolEntries(bestArtist);
      if (entries.length) {
        return { entries, lines: JARVIS_ARTIST_FOUND_LINES, lineItem: { title: bestArtist.name, artist: "" } };
      }
    }
  } catch (err) {
    debugLog("jarvis-request-level0-error", { cleanedQuery, message: err && err.message });
    // ricerca artista opzionale — se fallisce prosegue sotto
  }

  // Livello 1: non è (più) un nome di artista esatto — tratta la query come
  // farebbe la search bar della Home, in parallelo su playlist e album
  // Deezer (Vitto 2026-08-07: "non dovrebbe cercare su telegram ma
  // direttamente dalle playlist ricreate da deezer" — una ricerca letterale
  // sui bot Telegram per capire COSA riprodurre ha già causato risultati a
  // caso, es. "Arti 5ive" → "ARTIFICIAL SUICIDE" di Bad Omens solo per
  // somiglianza testuale. Telegram resta usato SOLO per prendere l'audio
  // del brano già scelto qui sotto, dentro resolveLazyItem/playQueueItem —
  // vedi anche _best_track_match_index in charts.py per quel passaggio.
  const vibeQuery = resolveJarvisVibeAlias(cleanedQuery);
  const [plResult, albResult] = await Promise.allSettled([
    apiJson(`/api/deezer/playlists/search?q=${encodeURIComponent(vibeQuery)}`),
    apiJson(`/api/deezer/albums/search?q=${encodeURIComponent(cleanedQuery)}`),
  ]);
  const playlists = plResult.status === "fulfilled" ? plResult.value.playlists || [] : [];
  const albums = albResult.status === "fulfilled" ? albResult.value.albums || [] : [];
  // playlist curate da un editor Deezer ("is_official", vedi charts.py)
  // prima di un reupload utente a caso con lo stesso nome — richiesto da
  // Vitto 2026-08-07, qualità nettamente più affidabile per richieste
  // mood/vibe tipo "musica triste".
  const bestPlaylist = playlists.find((p) => p.is_official) || playlists[0] || null;
  const bestAlbum = albums[0] || null;
  debugLog("jarvis-request-level1-playlist-album", {
    cleanedQuery,
    vibeQuery,
    playlistCandidates: playlists.length,
    bestPlaylistTitle: bestPlaylist ? bestPlaylist.title : null,
    bestPlaylistOfficial: bestPlaylist ? !!bestPlaylist.is_official : null,
    albumCandidates: albums.length,
    bestAlbumTitle: bestAlbum ? bestAlbum.title : null,
  });

  if (bestPlaylist) {
    const detail = await apiJson(`/api/deezer/playlists/${bestPlaylist.id}`);
    const entries = shuffleArray(
      (detail.tracks || []).map((t) => annotateDeezerPlaylistTrack(t, bestPlaylist.id))
    ).slice(0, JARVIS_REQUEST_QUEUE_COUNT);
    if (entries.length) {
      return { entries, lines: JARVIS_VIBE_FOUND_LINES, lineItem: { title: bestPlaylist.title, artist: "" } };
    }
  }

  if (bestAlbum) {
    const detail = await apiJson(`/api/deezer/albums/${bestAlbum.id}`);
    const entries = shuffleArray(
      (detail.tracks || []).map((t) => annotateDeezerAlbumTrack(t, bestAlbum.id))
    ).slice(0, JARVIS_REQUEST_QUEUE_COUNT);
    if (entries.length) {
      return {
        entries,
        lines: JARVIS_ALBUM_FOUND_LINES,
        lineItem: { title: bestAlbum.title, artist: bestAlbum.artist || "" },
      };
    }
  }

  // ultima spiaggia: l'artista "quasi" trovato al Livello 0 (non esatto) —
  // deliberatamente DOPO playlist/album, non prima: è proprio un match
  // debole di questo tipo ad aver causato il bug "triste" → artista
  // "Triste" per pura coincidenza testuale (Vitto, 2026-08-06/07).
  if (bestArtist) {
    try {
      const entries = await jarvisArtistPoolEntries(bestArtist);
      if (entries.length) {
        debugLog("jarvis-request-fallback-weak-artist", { cleanedQuery, bestArtistName: bestArtist.name });
        return { entries, lines: JARVIS_ARTIST_FOUND_LINES, lineItem: { title: bestArtist.name, artist: "" } };
      }
    } catch (err) {
      debugLog("jarvis-request-fallback-artist-error", { cleanedQuery, message: err && err.message });
    }
  }

  debugLog("jarvis-request-miss", { cleanedQuery });
  return null;
}

// sotto questa soglia un "artista" Deezer è quasi sempre un falso
// positivo per JARVIS — omonimi minori/band oscure che combaciano per
// coincidenza testuale con una parola di mood/genere (es. "Triste" band
// screamo con poche tracce, vs "triste" = mood cercato da Vitto) invece
// del significato inteso. Il filtro nb_album/nb_fan già in charts.py
// (_search_deezer_artists_sync) non basta a scartarli — richiesto da
// Vitto 2026-08-07 dopo troppi falsi positivi di questo tipo.
const JARVIS_ARTIST_MIN_TRACKS = 10;

/** Estratta da resolveJarvisRequest: usata sia per il match esatto del
 * Livello 0 sia per il ripiego finale sull'artista debole — stessa pesca
 * dalle top track, evita di duplicare le stesse 4 righe due volte. Array
 * vuoto (invece di lanciare) se l'artista ha meno di
 * JARVIS_ARTIST_MIN_TRACKS brani — i chiamanti già trattano "nessuna
 * entry" come "livello fallito, prosegui sotto", nessun cambiamento lì. */
async function jarvisArtistPoolEntries(artistObj) {
  const detail = await apiJson(`/api/deezer/artists/${artistObj.id}`);
  const allTracks = detail.tracks || [];
  if (allTracks.length < JARVIS_ARTIST_MIN_TRACKS) {
    debugLog("jarvis-request-artist-too-small", {
      artistName: artistObj.name,
      trackCount: allTracks.length,
      minRequired: JARVIS_ARTIST_MIN_TRACKS,
    });
    return [];
  }
  const pool = allTracks.slice(0, JARVIS_ARTIST_POOL_SIZE);
  return shuffleArray(pool)
    .slice(0, JARVIS_REQUEST_QUEUE_COUNT)
    .map((t) => annotateDeezerArtistTrack(t, artistObj.id));
}

async function handleJarvisRequest(rawQuery) {
  const query = (rawQuery || "").trim();
  if (!query) return;
  // vedi cleanJarvisQuery sopra — "metti un po' di phonk" → "phonk" prima
  // di interrogare qualunque API. Il messaggio di miss in fondo mostra
  // comunque `query` (quello che l'utente ha scritto davvero), non
  // `cleanedQuery`.
  const cleanedQuery = cleanJarvisQuery(query);
  debugLog("jarvis-request-query", { rawQuery: query, cleanedQuery });
  if (djRequestInput) djRequestInput.disabled = true;
  try {
    if (!jarvisSessionActive) await startJarvisSession();

    // resolveJarvisRequest parte SUBITO (async, non aspettato qui) e va
    // avanti IN PARALLELO alla battuta "sto cercando" — non in sequenza,
    // altrimenti l'utente aspetta la frase intera prima che parta anche
    // solo la ricerca. La battuta stessa mette in pausa il brano in corso
    // (speakJarvisText, sempre): è così che interrompiamo subito la
    // riproduzione attuale invece di aspettare il risultato per farlo.
    const requestPromise = resolveJarvisRequest(cleanedQuery);
    await speakJarvisText(pickRandom(JARVIS_SEARCHING_LINES));
    const found = await requestPromise;

    if (found) {
      // debug temporaneo — vedi Vitto 2026-08-06, "trova la canzone giusta
      // ma non carica" (caso "Artie 5ive"): dump del gruppo trovato per
      // vedere titoli/chartIndex reali prima che qualunque play/skip parta,
      // da confrontare coi log server (bridge.play timeout ecc.)
      debugLog("jarvis-request-found-group", {
        cleanedQuery,
        entries: found.entries.map((t) => ({
          source: t.source,
          chartIndex: t.chartIndex,
          artistId: t.artistId,
          title: t.title,
          artist: t.artist,
        })),
      });
      const segments = buildJarvisSegments(pickRandom(found.lines), found.lineItem);
      await speakJarvisText(segments);
      jarvisScheduleLineGlitchOut();
      // stesso trucco di startJarvisSession: il blocco appena trovato
      // diventa il gruppo "attivo" di JARVIS — jarvisHandleTrackLeft lo
      // riconosce dai qid, così a fine blocco la sessione riprende da sola
      // pescando il prossimo gruppo da jarvisGroups invece di fermarsi. La
      // richiesta chat è "un gruppo in più" dentro il sistema normale di
      // continuazione, non un brano isolato fuori da esso.
      jarvisActiveGroup = {
        key: `jarvis_request:${uid()}`,
        qids: new Set(found.entries.map((t) => t.qid)),
        total: found.entries.length,
        skipCount: 0,
        doneCount: 0,
      };
      // il blocco è già stato annunciato sopra (segments) — playQueueIndex
      // non deve ripetersi sul primo brano, stesso jarvisSkipNextAnnounce
      // di startJarvisSession
      jarvisSkipNextAnnounce = true;
      jarvisPrefetchGroupAhead(found.entries.slice(1));
      await playFromList(found.entries, 0, null, true);
      return;
    }

    const text = pickRandom(JARVIS_REQUEST_MISS_LINES).replace("{query}", query);
    await speakJarvisText(text);
    jarvisScheduleLineGlitchOut();
  } catch (err) {
    toast("Richiesta a JARVIS non riuscita: " + (err.message || err));
  } finally {
    if (djRequestInput) djRequestInput.disabled = false;
    // la battuta di ricerca qui sopra mette SEMPRE in pausa il brano che
    // stava già suonando (speakJarvisText) — se poi non è partito niente
    // di nuovo (miss, o errore di rete a metà catena) restava fermo lì per
    // sempre invece di riprendere da solo (stesso sintomo di "risponde ma
    // poi non parte niente", segnalato da Vitto, 2026-08-02). Sul percorso
    // di successo audio.paused è già false (playFromList ha avviato il
    // nuovo brano), quindi questo non fa nulla — resume mirato, non un
    // secondo play() a caso.
    if (audio && audio.paused && queue.index >= 0 && queue.items[queue.index]) {
      audio.play().catch(() => {});
    }
  }
}

/** Dettatura vocale della richiesta a JARVIS — al posto di scrivere nel
 * campo di testo, si parla (pulsante microfono che ha preso il posto dello
 * shuffle in JARVIS, richiesta di Vitto 2026-08-07: "un pulsante con icona
 * microfono che clicchi e al posto di scrivere la query testualmente la
 * dici vocalmente"). Usa il riconoscimento vocale NATIVO di iOS
 * (SFSpeechRecognizer, via @capgo/capacitor-speech-recognition — l'unica
 * delle due opzioni npm con Package.swift, questo progetto è SPM puro)
 * invece del Web Speech API dentro la WKWebView — su iOS quest'ultimo non
 * supporta il riconoscimento (solo la sintesi), stesso motivo per cui
 * Kokoro esiste già per la voce di JARVIS. Su web/desktop (nessun plugin
 * nativo) degrada con un semplice avviso, non prova alternative deboli.
 * Il testo riconosciuto passa dritto ad handleJarvisRequest, stessa strada
 * dell'invio testuale — nessuna logica duplicata a valle.
 *
 * NOTA bug audio (Vitto, 2026-08-07: "quando registro il volume si abbassa
 * e dopo aver premuto per interrompere non torna più su"): il plugin mette
 * l'AVAudioSession in .playAndRecord/.measurement per registrare ma non la
 * rimetteva MAI in .playback dopo lo stop — patchato DIRETTAMENTE nel
 * sorgente Swift vendorizzato (`ios-app/node_modules/@capgo/capacitor-
 * speech-recognition/ios/Sources/.../SpeechRecognitionPlugin.swift`,
 * `clearLegacyRecognitionResources()`), non c'è un modo lato JS per farlo.
 * ATTENZIONE: un `npm install`/reinstall di quel pacchetto in
 * ios-app/node_modules cancella la patch, va riapplicata a mano se
 * succede — non è un fix a monte nel pacchetto, è un cerotto locale. */
let jarvisVoicePartialText = ""; // ultima trascrizione parziale sentita, vedi sotto
let jarvisVoiceCancelled = false; // impostato dalla X — vedi jarvisVoiceCancel

/** Popup classico "cerchio + testo sotto" (richiesta di Vitto 2026-08-07,
 * al posto del primo tentativo che riusava la barra di testo) — mostra/
 * nasconde con lo stesso trattamento fade+scale morbido di .dj-request. */
function showJarvisVoiceOverlay() {
  if (!jarvisVoiceOverlay) return;
  jarvisVoiceOverlay.hidden = false;
  // il browser deve "vedere" hidden=false prima di aggiungere .visible,
  // altrimenti la transition parte già nello stato finale (nessuna
  // animazione) — un frame di distanza basta.
  requestAnimationFrame(() => jarvisVoiceOverlay.classList.add("visible"));
  if (jarvisVoiceText) jarvisVoiceText.textContent = "Ti ascolto…";
}
function hideJarvisVoiceOverlay() {
  if (!jarvisVoiceOverlay) return;
  jarvisVoiceOverlay.classList.remove("visible");
  setTimeout(() => {
    if (!jarvisVoiceOverlay.classList.contains("visible")) jarvisVoiceOverlay.hidden = true;
  }, 240);
}

/** Unico punto che decide cosa fare col testo dettato, sia sul percorso di
 * successo (Speech.start() risolto) sia su quello di stop manuale
 * (rigettato ma con una trascrizione parziale buona) — evita di duplicare
 * "manda, chiudi il popup" due volte in jarvisVoiceRequest. Nessun tasto di
 * conferma: invia diretto appena la sessione finisce, richiesta esplicita
 * di Vitto ("alla fine invia diretto senza richiedere click utente") —
 * ECCETTO se l'utente ha annullato con la X (jarvisVoiceCancelled), in tal
 * caso scarta il testo senza mandare nulla, vedi jarvisVoiceCancel. */
function jarvisVoiceUseText(text, emptyErrorMessage) {
  hideJarvisVoiceOverlay();
  if (jarvisVoiceCancelled) return;
  if (text) {
    handleJarvisRequest(text);
  } else {
    toast(emptyErrorMessage || "Non ho capito, riprova");
  }
}

/** X del popup dettatura — annulla senza inviare niente (mancava del
 * tutto, Vitto 2026-08-07: "occhio che il processo venga killato con
 * cura"). Ferma il riconoscimento nativo PRIMA di tutto — jarvisVoiceRequest
 * (già in corso, in attesa dell'evento listeningState "stopped") si sblocca
 * da solo appena stop() lo segnala, jarvisVoiceCancelled gli dice di
 * scartare il risultato invece di mandarlo. Nessuna logica di stop
 * duplicata qui: stessa strada del secondo tap sul microfono. */
async function jarvisVoiceCancel() {
  jarvisVoiceCancelled = true;
  const Speech = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.SpeechRecognition;
  if (!Speech) {
    hideJarvisVoiceOverlay();
    return;
  }
  try {
    await Speech.stop();
  } catch (_) {
    // rigetto atteso (vedi commenti su jarvisVoiceRequest) — il punto è
    // che il motore audio nativo si sia fermato, non l'esito della promise
  }
}

async function jarvisVoiceRequest() {
  const Speech = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.SpeechRecognition;
  debugLog("jarvis-voice-request-start", {
    hasCapacitor: !!window.Capacitor,
    hasPlugins: !!(window.Capacitor && window.Capacitor.Plugins),
    pluginNames: window.Capacitor && window.Capacitor.Plugins ? Object.keys(window.Capacitor.Plugins) : [],
    hasSpeech: !!Speech,
  });
  if (!Speech) {
    toast("Dettatura vocale disponibile solo nell'app iOS");
    return;
  }
  // secondo tap (sul microfono O sul cerchio del popup, vedi
  // jarvisVoiceCircle più sotto) mentre ascolta = ferma manualmente prima
  // del silenzio naturale — stop() dal plugin RIGETTA la promise di
  // start() invece di risolverla con un risultato (vedi Vitto 2026-08-07,
  // "Drake" mai partito: l'errore "Recognition stopped before final
  // results were produced" veniva trattato come fallimento e buttava via
  // tutto quello che aveva capito fino a quel momento). Il catch più sotto
  // ora usa jarvisVoicePartialText come rete di sicurezza proprio per
  // questo caso.
  if (npShuffle && npShuffle.classList.contains("listening")) {
    try {
      await Speech.stop();
    } catch (_) {}
    return;
  }
  try {
    // @capgo/capacitor-speech-recognition (non @capacitor-community, quello
    // NON ha Package.swift/non è SPM-compatibile — questo progetto usa solo
    // Swift Package Manager, niente CocoaPods, vedi crackify_ios_device_deploy)
    // ritorna un solo campo speechRecognition (combina già mic+dettatura su
    // iOS), non due separati — controllato sui type reali del pacchetto.
    const perm = await Speech.requestPermissions();
    debugLog("jarvis-voice-request-permission", { perm });
    if (perm.speechRecognition !== "granted") {
      toast("Permesso microfono/dettatura negato");
      return;
    }
  } catch (err) {
    debugLog("jarvis-voice-request-permission-error", { message: err && err.message, stack: err && err.stack });
    toast("Permesso vocale non disponibile: " + (err.message || err));
    return;
  }
  if (npShuffle) npShuffle.classList.add("listening");
  // popup "cerchio + testo sotto" (Vitto 2026-08-07, secondo giro: il
  // primo tentativo riusava la barra di testo, "non mi piace molto...
  // il classico popup con il cerchio") — vedi showJarvisVoiceOverlay.
  showJarvisVoiceOverlay();
  jarvisVoicePartialText = "";
  jarvisVoiceCancelled = false;
  // con partialResults:true la promise di start() risolve QUASI SUBITO
  // (documentato nel plugin), non a fine sessione — usare il suo esito per
  // decidere "quando è finita" avrebbe chiuso la richiesta un istante dopo
  // il tap, prima ancora che l'utente iniziasse a parlare. Il vero segnale
  // di fine sessione è l'evento listeningState con state:"stopped" —
  // emesso da finalizeFinishedSession in TUTTI i percorsi di uscita del
  // plugin (stop manuale, forceStop, errore). ATTENZIONE (Vitto 2026-08-07,
  // seconda segnalazione: "la registrazione continua dopo invio" — 30s
  // esatti nei log, il fallback sotto stava scattando): a differenza di
  // Siri, SFSpeechAudioBufferRecognitionRequest in streaming dal microfono
  // NON rileva da sola il silenzio e non finalizza mai da sola — bisogna
  // fermarla noi. Il timer sotto lo fa dopo una pausa nel parlato.
  let resolveSessionEnded;
  const sessionEnded = new Promise((resolve) => {
    resolveSessionEnded = resolve;
  });
  let partialListener = null;
  let stateListener = null;
  let silenceTimer = null;
  const SILENCE_STOP_MS = 1600; // pausa nel parlato prima di considerarla "fine frase"
  const armSilenceTimer = () => {
    clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => {
      Speech.stop().catch(() => {});
    }, SILENCE_STOP_MS);
  };
  try {
    partialListener = await Speech.addListener("partialResults", (data) => {
      const t = data && data.matches && data.matches[0];
      if (t) {
        jarvisVoicePartialText = t;
        if (jarvisVoiceText) jarvisVoiceText.textContent = t;
        armSilenceTimer();
      }
    });
    stateListener = await Speech.addListener("listeningState", (data) => {
      if (data && data.state === "stopped") resolveSessionEnded();
    });
  } catch (_) {
    // listener opzionali: se falliscono degrada sul timeout assoluto sotto
    // invece di restare appesi per sempre ad aspettare un evento che non
    // arriverà mai
  }
  try {
    if (!jarvisSessionActive) await startJarvisSession();
    debugLog("jarvis-voice-request-listening", {});
    Speech.start({ language: "it-IT", maxResults: 1, partialResults: true, popup: false }).catch((err) => {
      // errore nell'avvio vero e proprio, O il nostro stesso stop() per
      // silenzio/tap manuale (che rigetta SEMPRE questa promise, vedi
      // commento più sopra) — in entrambi i casi sblocca l'attesa sotto
      debugLog("jarvis-voice-request-start-error", { message: err && err.message, stack: err && err.stack });
      resolveSessionEnded();
    });
    // rete di sicurezza ASSOLUTA (nessuna parola detta per niente: il
    // timer sopra non parte mai perché non arriva nessun partialResults) —
    // ferma DAVVERO il microfono qui, non solo l'attesa, altrimenti stessa
    // segnalazione di Vitto ma dopo 30s invece che mai.
    const timeout = new Promise((resolve) => setTimeout(resolve, 30000)).then(() => {
      Speech.stop().catch(() => {});
    });
    await Promise.race([sessionEnded, timeout]);
    debugLog("jarvis-voice-request-result", { partialText: jarvisVoicePartialText });
    jarvisVoiceUseText(jarvisVoicePartialText);
  } catch (err) {
    debugLog("jarvis-voice-request-error", { message: err && err.message, stack: err && err.stack });
    jarvisVoiceUseText(jarvisVoicePartialText, "Dettatura non riuscita: " + (err.message || err));
  } finally {
    clearTimeout(silenceTimer);
    if (npShuffle) npShuffle.classList.remove("listening");
    if (partialListener) {
      try {
        partialListener.remove();
      } catch (_) {}
    }
    if (stateListener) {
      try {
        stateListener.remove();
      } catch (_) {}
    }
  }
}

/** Il play() vero del brano arriva minuti-anzi-secondi dopo il tap che apre
 * lo sheet (saluto + annuncio brano parlati nel mezzo) — troppo lontano dal
 * gesture originale per alcuni browser/WebView, che lo bloccano in
 * silenzio (bug segnalato da Vitto: "Lotus 72" annunciato ma mai partito).
 * Un play()+pause() SINCRONO dentro il click handler "sblocca" l'elemento
 * per il resto della sessione — tecnica standard per l'autoplay mobile. */
function unlockMainAudioForAutoplay() {
  if (!audio) return;
  try {
    const p = audio.play();
    if (p && p.catch) p.catch(() => {});
  } catch (_) {}
  audio.pause();
}

/** JARVIS ora vive dentro #nowPlayingSheet (vedi syncNowPlayingSheetMeta
 * per il toggle .jarvis-mode, openNowPlayingSheet/closeNowPlayingSheet per
 * i loop bassi/soundbar) — questo resta solo come punto di ingresso con
 * intento chiaro dal banner Home. startJarvisSession() PRIMA (non
 * awaited): imposta jarvisSessionStarting=true in modo sincrono, così
 * openNowPlayingSheet vede già "siamo in JARVIS" al suo primo giro e
 * mostra subito la soundbar invece di aspettare che saluto+pool finiscano. */
async function openDjSheet() {
  // log diagnostico TEMPORANEO (Vitto, 2026-08-02: "continua a non uscirmi
  // l'opzione" — il fix del rilevamento sessione stesso device non sembra
  // scattare, da capire con dati veri invece di teorie) — da togliere una
  // volta chiarita la causa.
  debugLog("open-dj-sheet-enter", {
    jarvisSessionActive,
    remoteMirror,
    remoteMirrorIsJarvis,
    audioSrc: !!(audio && audio.src),
    audioPaused: !!(audio && audio.paused),
  });
  if (!jarvisSessionActive) {
    // sessione JARVIS già viva su un ALTRO device (remoteMirror: questo
    // device sta solo specchiando lo stato di quello attivo, vedi
    // applyRemoteMirror) — startJarvisSession() la scarterebbe in
    // silenzio: nuovo saluto, nuova ricerca, nuovo audio locale che
    // reclama il posto di "active player" e spinge l'altro device in
    // mirror. Richiesta di Vitto, 2026-08-02: chiedere prima, non decidere
    // per lui. "Continua" apre il foglio così com'è, sullo stato già
    // mirrorato — NESSUNA chiamata a startJarvisSession, quindi niente
    // ricerca/audio nuovi.
    let treatAsActive = remoteMirror && remoteMirrorIsJarvis;
    let sameDeviceStale = false;
    // jarvisSessionActive è SOLO un flag in memoria JS — se si perde
    // (background prolungato, reload del webview) sullo STESSO device che
    // stava già suonando JARVIS, tornare qui vedeva "nessuna sessione" e
    // ripartiva da zero senza chiedere, anche con l'audio ancora vivo
    // sotto (Vitto, 2026-08-02: "il banner non rileva ancora jarvis
    // sotto", stesso device). /api/me/player è la stessa fonte usata per
    // il mirror multi-device — is_jarvis ci dice se l'ULTIMO stato noto
    // di QUESTO device (is_this_device) era davvero una sessione JARVIS
    // ancora in play, non solo "non me lo ricordo più".
    if (!treatAsActive) {
      try {
        const st = await apiJson("/api/me/player");
        debugLog("open-dj-sheet-player-check", {
          is_this_device: st.is_this_device,
          current_device_id: st.current_device_id,
          active: st.active
            ? {
                device_id: st.active.device_id,
                is_jarvis: st.active.is_jarvis,
                is_playing: st.active.is_playing,
                title: st.active.title,
              }
            : null,
        });
        if (st.is_this_device && st.active && st.active.is_jarvis && st.active.is_playing) {
          treatAsActive = true;
          sameDeviceStale = true;
        }
      } catch (err) {
        debugLog("open-dj-sheet-player-check-error", { message: err && err.message });
      }
    }
    if (treatAsActive) {
      const discard = confirm(
        sameDeviceStale
          ? "JARVIS sembra ancora in riproduzione. Vuoi ricominciare da zero? Annulla per continuare quella attuale."
          : "JARVIS ha già una sessione in corso su un altro dispositivo. Vuoi ricominciare da zero? Annulla per continuare quella attuale."
      );
      if (!discard) {
        // resync del flag perso — niente pool/jarvisActiveGroup da
        // recuperare (persi con lo stato locale), ma almeno non taglia la
        // riproduzione in corso e la sessione "sembra" JARVIS di nuovo
        if (sameDeviceStale) jarvisSessionActive = true;
        openNowPlayingSheet({ allowEmpty: true });
        return;
      }
    }
    // sessione VERA nuova in arrivo: overlay dedicato JARVIS (nero+arancione,
    // barre a riposo — vedi showJarvisLoadingOverlay) invece di aprire
    // subito lo sheet vuoto e lasciarlo popolarsi sotto gli occhi
    // dell'utente — richiesta di Vitto, 2026-08-03: arrivare sullo sheet con
    // JARVIS già lì pronto a parlare, con una schermata di attesa "più
    // bella" dello spinner generico riusato da artista/album.
    // reveal() è la rete di sicurezza: chiamata sia dal segnale "pronto" di
    // startJarvisSession (onReady, appena prima che JARVIS inizi a parlare)
    // sia dal .finally() qui sotto per ogni altro esito (pool vuoto, errore,
    // no-op perché nel frattempo è già partita un'altra sessione). Idempotente
    // (revealed/cancelledByUser) così non conta se scatta più volte o da più
    // fonti — cancelledByUser la disattiva del tutto quando la X annulla
    // (vedi cancelJarvisSessionStart): prima la X chiamava reveal() e finiva
    // comunque in fullscreen con JARVIS che parlava, bug segnalato da Vitto,
    // 2026-08-04.
    showJarvisLoadingOverlay();
    let revealed = false;
    let cancelledByUser = false;
    const reveal = () => {
      if (revealed || cancelledByUser) return;
      revealed = true;
      _jarvisLoadingSkip = null;
      hideJarvisLoadingOverlay();
      openNowPlayingSheet({ allowEmpty: true });
    };
    _jarvisLoadingSkip = () => {
      cancelledByUser = true;
      _jarvisLoadingSkip = null;
      hideJarvisLoadingOverlay();
      cancelJarvisSessionStart();
    };
    startJarvisSession(reveal).finally(reveal);
    return;
  }
  openNowPlayingSheet({ allowEmpty: true });
}

function lyricsCacheKey(artist, title) {
  return `${(artist || "").trim().toLowerCase()}|${(title || "").trim().toLowerCase()}`;
}

function stopKaraokeLoop() {
  if (lyricsRaf) {
    cancelAnimationFrame(lyricsRaf);
    lyricsRaf = 0;
  }
}

function startKaraokeLoop() {
  stopKaraokeLoop();
  if (!lyricsIsKaraoke) return;
  let last = 0;
  const tick = (now) => {
    // ~20fps basta e costa meno
    if (now - last > 50) {
      last = now;
      updateKaraokeLyrics(false);
    }
    lyricsRaf = requestAnimationFrame(tick);
  };
  lyricsRaf = requestAnimationFrame(tick);
}

function closeLyricsPanel() {
  if (!npLyricsPanel) return;
  stopKaraokeLoop();
  npLyricsPanel.hidden = true;
  npLyricsPanel.setAttribute("hidden", "");
  if (npSheet) npSheet.classList.remove("lyrics-open", "lyrics-karaoke");
  if (npLyricsNow) npLyricsNow.hidden = true;
  lyricsSyncedLines = [];
  lyricsActiveIdx = -1;
  lyricsActiveWordIdx = -1;
  lyricsIsKaraoke = false;
  lyricsIsWordMode = false;
  lyricsSourceLabel = "";
  lyricsEstimated = false;
}

function setLyricsBodyHtml(html) {
  if (npLyricsBody) npLyricsBody.innerHTML = html;
}

/** Pulisce titoli bot TG: "01. Artist - Title (Official)" → pezzi utili */
function cleanLyricsMeta(artist, title) {
  let a = (artist || "").trim();
  let t = (title || "").trim();
  // "Artist - Title" tutto nel title
  if ((!a || a === "—" || a === "Artista sconosciuto") && t.includes(" - ")) {
    const parts = t.split(/\s+-\s+/);
    if (parts.length >= 2) {
      a = parts[0].trim();
      t = parts.slice(1).join(" - ").trim();
    }
  }
  // "01 | Title" / "01. Title"
  t = t.replace(/^\d{1,3}\s*[.|)\-–—|:]\s*/, "");
  t = t.replace(/\s*[\(\[][^)\]]*(official|video|audio|lyrics|visualizer|hd|4k|remaster)[^)\]]*[\)\]]/gi, "");
  t = t.replace(/\s+/g, " ").trim();
  a = a.replace(/\s+/g, " ").trim();
  if (a === "—" || a === "Artista sconosciuto") a = "";
  return { artist: a, title: t };
}

/**
 * Parse LRC → [{ t: sec, text }]
 */
function parseLrc(lrc) {
  const out = [];
  if (!lrc) return out;
  const timeRe = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
  for (const raw of String(lrc).split(/\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^\[[a-z]{2,}:/i.test(line) && !/^\[\d/.test(line)) continue;
    const times = [];
    let m;
    timeRe.lastIndex = 0;
    let textStart = 0;
    while ((m = timeRe.exec(line)) !== null) {
      const min = parseInt(m[1], 10) || 0;
      const sec = parseInt(m[2], 10) || 0;
      let frac = m[3] || "0";
      let fracSec = 0;
      if (frac.length <= 2) fracSec = parseInt(frac.padEnd(2, "0"), 10) / 100;
      else fracSec = parseInt(frac.padEnd(3, "0").slice(0, 3), 10) / 1000;
      times.push(min * 60 + sec + fracSec);
      textStart = m.index + m[0].length;
    }
    if (!times.length) continue;
    let text = line
      .slice(textStart)
      .replace(/<\d{1,2}:\d{1,2}(?:[.:]\d{1,3})?>/g, "")
      .trim();
    if (!text) continue;
    for (const tt of times) out.push({ t: tt, text });
  }
  out.sort((a, b) => a.t - b.t);
  const dedup = [];
  const seen = new Set();
  for (const row of out) {
    const k = `${row.t.toFixed(2)}|${row.text}`;
    if (seen.has(k)) continue;
    seen.add(k);
    dedup.push(row);
  }
  return dedup;
}

/** Se non c’è LRC: distribuisce le righe sulla durata del brano */
function buildEstimatedSync(plain, durationSec) {
  const lines = String(plain || "")
    .split(/\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^\[/.test(l));
  if (lines.length < 2) return [];
  let dur = Number(durationSec);
  if (!Number.isFinite(dur) || dur < 15) {
    dur = Math.max(30, lines.length * 3.2);
  }
  const start = Math.min(12, dur * 0.1);
  const end = dur * 0.92;
  const span = Math.max(10, end - start);
  return lines.map((text, i) => ({
    t: start + (span * i) / Math.max(1, lines.length - 1),
    text,
    words: [],
    estimated: true,
  }));
}

/** Stima timing parole dentro una riga [t0, t1) */
function estimateWordsInLine(text, t0, t1) {
  const tokens = String(text).match(/\S+\s*/g) || [String(text)];
  if (!tokens.length) return [];
  const span = Math.max(0.25, (t1 || t0 + 2) - t0);
  return tokens.map((w, i) => ({
    t: t0 + (span * i) / tokens.length,
    text: w,
    duration: span / tokens.length,
  }));
}

/** Normalizza lines API / LRC e riempie words se mancano */
function normalizeKaraokeLines(lines, { forceWordEstimate = true } = {}) {
  if (!Array.isArray(lines) || !lines.length) return [];
  const sorted = lines
    .map((ln) => ({
      t: Number(ln.t) || 0,
      text: ln.text || "",
      words: Array.isArray(ln.words) ? ln.words.slice() : [],
    }))
    .filter((ln) => ln.text)
    .sort((a, b) => a.t - b.t);

  return sorted.map((ln, i) => {
    const t1 = sorted[i + 1] ? sorted[i + 1].t : ln.t + 2.5;
    let words = (ln.words || [])
      .map((w) => ({
        t: Number(w.t) || 0,
        text: w.text || "",
        duration: Number(w.duration) || 0,
      }))
      .filter((w) => w.text !== "");
    if (forceWordEstimate && words.length < 2) {
      words = estimateWordsInLine(ln.text, ln.t, t1);
    }
    return { t: ln.t, text: ln.text, words };
  });
}

function setLyricsModeLabel(karaoke, { estimated = false, word = false } = {}) {
  // badge PAROLE / fonte: nascosti (UI più pulita)
  if (npLyricsLabel) npLyricsLabel.hidden = true;
  if (npLyricsFoot) npLyricsFoot.textContent = "";
  if (npLyricsPanel) {
    npLyricsPanel.classList.toggle("is-karaoke", !!karaoke);
    npLyricsPanel.classList.toggle("is-estimated", !!estimated);
    npLyricsPanel.classList.toggle("is-word", !!word);
  }
  if (npSheet) npSheet.classList.toggle("lyrics-karaoke", !!karaoke);
}

function syncLyricsArt() {
  // riusa tema già calcolato da setCover; se manca, ricalcola
  const pick = (el) => {
    if (!el || !el.style.backgroundImage) return "";
    const m = el.style.backgroundImage.match(/url\(["']?([^"')]+)["']?\)/);
    return m ? m[1] : "";
  };
  const url = pick(npArt) || pick(coverEl);
  if (url) themeFromCoverUrl(url);
  if (npLyricsTrack) {
    npLyricsTrack.textContent =
      (nowPlaying && nowPlaying.title) ||
      (nowTitle && nowTitle.textContent) ||
      "—";
  }
  if (npLyricsArtist) {
    npLyricsArtist.textContent =
      (nowPlaying && nowPlaying.artist) ||
      (nowArtist && nowArtist.textContent) ||
      "—";
  }
}

function syncLyDock() {
  const cur = Number(audio.currentTime) || 0;
  const dur = Number(audio.duration);
  if (lyTimeCur) lyTimeCur.textContent = fmtTime(cur);
  if (lyTimeDur) {
    lyTimeDur.textContent =
      Number.isFinite(dur) && dur > 0 ? fmtTime(dur) : "0:00";
  }
  if (lySeekFill && Number.isFinite(dur) && dur > 0) {
    lySeekFill.style.width = `${Math.min(100, (cur / dur) * 100)}%`;
  }
  const playing = !audio.paused && !audio.ended;
  if (lyIcoPlay) lyIcoPlay.classList.toggle("hidden", playing);
  if (lyIcoPause) lyIcoPause.classList.toggle("hidden", !playing);
}

function mountKaraokeLines(synced, { estimated = false, word = false } = {}) {
  const lines = normalizeKaraokeLines(synced, { forceWordEstimate: true });
  if (lines.length < 2) return false;

  lyricsIsKaraoke = true;
  lyricsEstimated = !!estimated;
  lyricsIsWordMode = !!word || lines.some((l) => (l.words || []).length >= 2);
  lyricsSyncedLines = lines;
  lyricsActiveIdx = -1;
  lyricsActiveWordIdx = -1;
  setLyricsModeLabel(true, {
    estimated,
    word: lyricsIsWordMode && !estimated,
  });

  // costruisci lista con note tra gap lunghi
  let html = `<div class="ly-pad" aria-hidden="true"></div>`;
  for (let i = 0; i < lines.length; i++) {
    const row = lines[i];
    const prev = lines[i - 1];
    if (prev && row.t - prev.t > 4.5) {
      html += `<div class="ly-note" aria-hidden="true"></div>`;
    }
    const words = row.words || [];
    const inner =
      words.length >= 2
        ? words
            .map(
              (w, wi) =>
                `<span class="ly-w" data-wi="${wi}" data-wt="${w.t}">${escapeHtml(
                  w.text
                )}</span>`
            )
            .join("")
        : escapeHtml(row.text);
    html += `<button type="button" class="ly-line" data-i="${i}" data-t="${row.t}">${inner}</button>`;
  }
  html += `<div class="ly-pad" aria-hidden="true"></div>`;
  setLyricsBodyHtml(html);

  if (npLyricsBody) {
    npLyricsBody.classList.add("ly-scroll");
    npLyricsBody.querySelectorAll(".ly-line").forEach((el) => {
      el.addEventListener("click", () => {
        const tt = parseFloat(el.getAttribute("data-t") || "");
        if (!Number.isFinite(tt) || !audio.src) return;
        try {
          guardedSeek(Math.max(0, tt));
          audio.play().catch(() => {});
        } catch (_) {}
        updateKaraokeLyrics(true);
        syncLyDock();
      });
    });
  }

  if (npLyricsFoot) npLyricsFoot.textContent = "";
  updateKaraokeLyrics(true);
  syncLyDock();
  startKaraokeLoop();
  return true;
}

/** Rapporto durata-file-locale / durata-versione-dei-testi.
 * La libreria è piena di edit slowed: i testi arrivano quasi sempre con i
 * timing dell'ORIGINALE e sul file rallentato corrono in anticipo, sempre
 * peggio col passare del brano. Se le due durate sono note e diverse, i
 * timestamp vanno moltiplicati per questo rapporto. */
function lyricsLocalScale(data) {
  const src = Number(data && data.duration);
  const loc = Number(audio.duration);
  if (!Number.isFinite(src) || src <= 0) return 1;
  if (!Number.isFinite(loc) || loc <= 0) return 1;
  const ratio = loc / src;
  if (ratio < 0.4 || ratio > 2.5) return 1; // metadata sospetti: non toccare
  if (Math.abs(ratio - 1) <= 0.03) return 1; // stessa versione, solo rumore
  return ratio;
}

function scaleLyricsLines(lines, scale) {
  return (lines || []).map((ln) => ({
    ...ln,
    t: (Number(ln.t) || 0) * scale,
    words: (ln.words || []).map((w) => ({
      ...w,
      t: (Number(w.t) || 0) * scale,
      duration: (Number(w.duration) || 0) * scale,
    })),
  }));
}

function renderLyricsResult(data, artist, title) {
  stopKaraokeLoop();
  lyricsSyncedLines = [];
  lyricsActiveIdx = -1;
  lyricsActiveWordIdx = -1;
  lyricsIsKaraoke = false;
  lyricsIsWordMode = false;
  lyricsEstimated = false;
  lyricsSourceLabel = data.source || "";

  if (npLyricsTrack) {
    npLyricsTrack.textContent = [data.title || title, data.artist || artist]
      .filter(Boolean)
      .join(" · ");
  }
  if (data.instrumental) {
    setLyricsModeLabel(false);
    setLyricsBodyHtml(`<p class="ly-placeholder">Brano strumentale</p>`);
    return;
  }

  const tScale = lyricsLocalScale(data);

  // 1) lines da API (Lyrics+ word / LRCLIB line)
  if (Array.isArray(data.lines) && data.lines.length >= 2) {
    const isWord = data.mode === "word";
    const lines = tScale !== 1 ? scaleLyricsLines(data.lines, tScale) : data.lines;
    if (mountKaraokeLines(lines, { estimated: false, word: isWord })) return;
  }

  // 2) LRC string
  let synced = parseLrc(data.synced_lyrics || "");
  if (synced.length >= 2) {
    if (tScale !== 1) synced = scaleLyricsLines(synced, tScale);
    if (mountKaraokeLines(synced, { estimated: false, word: false })) return;
  }

  // 3) plain → stimato riga + parole
  const dur =
    Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;
  if (data.found && data.lyrics) {
    const est = buildEstimatedSync(data.lyrics, dur);
    if (est.length >= 2) {
      if (mountKaraokeLines(est, { estimated: true, word: true })) return;
    }
  }

  // 4) statico (no timing) — comunque layout Spotify
  setLyricsModeLabel(false);
  if (!data.found || !data.lyrics) {
    setLyricsBodyHtml(
      `<p class="ly-placeholder">Testo non trovato per<br><strong>${escapeHtml(
        title || "questo brano"
      )}</strong></p>`
    );
    return;
  }
  const staticLines = String(data.lyrics)
    .split(/\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  setLyricsBodyHtml(
    `<div class="ly-pad"></div>` +
      staticLines
        .map((t) => `<p class="ly-line passed" style="cursor:default">${escapeHtml(t)}</p>`)
        .join("") +
      `<div class="ly-pad"></div>`
  );
}

/** Evidenzia riga + parola (stile Spotify) + scroll */
function updateKaraokeLyrics(force) {
  if (!lyricsIsKaraoke || !lyricsSyncedLines.length) return;
  if (!npLyricsPanel || npLyricsPanel.hasAttribute("hidden")) return;
  if (!npLyricsBody) return;

  let t = Number(audio.currentTime);
  if (!Number.isFinite(t) || t < 0) t = 0;

  const look = t + 0.05;
  let idx = -1;
  for (let i = 0; i < lyricsSyncedLines.length; i++) {
    if (lyricsSyncedLines[i].t <= look) idx = i;
    else break;
  }

  let widx = -1;
  if (idx >= 0) {
    const words = lyricsSyncedLines[idx].words || [];
    for (let j = 0; j < words.length; j++) {
      if (words[j].t <= look + 0.02) widx = j;
      else break;
    }
  }

  if (!force && idx === lyricsActiveIdx && widx === lyricsActiveWordIdx) {
    syncLyDock();
    return;
  }
  lyricsActiveIdx = idx;
  lyricsActiveWordIdx = widx;

  const nodes = npLyricsBody.querySelectorAll(".ly-line");
  nodes.forEach((el, i) => {
    const on = i === idx;
    el.classList.toggle("is-active", on);
    el.classList.toggle("passed", idx >= 0 && i < idx);
    el.classList.toggle("upcoming", idx < 0 || i > idx);

    el.querySelectorAll(".ly-w").forEach((wEl, j) => {
      const won = on && j === widx;
      const wpass = on ? j < widx : i < idx;
      wEl.classList.toggle("is-active", won);
      wEl.classList.toggle("passed", wpass && !won);
    });
  });

  if (idx >= 0 && nodes[idx]) {
    const el = nodes[idx];
    const body = npLyricsBody;
    const br = el.getBoundingClientRect();
    const bb = body.getBoundingClientRect();
    const elTop = br.top - bb.top + body.scrollTop;
    const elH = br.height || 48;
    // Spotify: riga attiva ~1/3 dall'alto
    const target = elTop - body.clientHeight * 0.32 + elH / 2;
    const maxScroll = Math.max(0, body.scrollHeight - body.clientHeight);
    const next = Math.max(0, Math.min(maxScroll, target));
    if (Math.abs(body.scrollTop - next) > 4) body.scrollTop = next;
  }
  syncLyDock();
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function openLyricsPanel() {
  if (!npLyricsPanel) return;
  let title =
    (nowPlaying && nowPlaying.title) ||
    (nowTitle && nowTitle.textContent) ||
    "";
  let artist =
    (nowPlaying && nowPlaying.artist) ||
    (nowArtist && nowArtist.textContent) ||
    "";
  if (!title || title === "Nessun brano" || title === "…") {
    toast("Nessun brano in riproduzione");
    return;
  }
  const cleaned = cleanLyricsMeta(artist, title);
  artist = cleaned.artist;
  title = cleaned.title || title;

  npLyricsPanel.hidden = false;
  npLyricsPanel.removeAttribute("hidden");
  if (npSheet) npSheet.classList.add("lyrics-open");
  if (npLyricsTrack) {
    npLyricsTrack.textContent = `${title}${artist ? " · " + artist : ""}`;
  }
  syncLyricsArt();

  const key = lyricsCacheKey(artist, title);
  lyricsKeyCurrent = key;

  if (lyricsCache.has(key)) {
    renderLyricsResult(lyricsCache.get(key), artist, title);
    return;
  }

  setLyricsBodyHtml(`<p class="ly-placeholder loading">Cerco il testo…</p>`);
  if (npLyricsFoot) npLyricsFoot.textContent = "";
  if (lyricsLoading) return;
  lyricsLoading = true;
  try {
    const q = new URLSearchParams({
      title: title.slice(0, 200),
      artist: (artist || "").slice(0, 200),
    });
    const durLocal = Number(audio.duration);
    if (Number.isFinite(durLocal) && durLocal > 0) {
      q.set("duration", durLocal.toFixed(1));
    }
    const data = await apiJson(`/api/lyrics?${q}`);
    lyricsCache.set(key, data);
    if (lyricsKeyCurrent === key) renderLyricsResult(data, artist, title);
  } catch (err) {
    if (lyricsKeyCurrent === key) {
      setLyricsBodyHtml(
        `<p class="ly-placeholder">Errore: ${escapeHtml(err.message || String(err))}</p>`
      );
      if (npLyricsFoot) npLyricsFoot.textContent = "";
    }
  } finally {
    lyricsLoading = false;
  }
}

function buildLyricsSnippet(data) {
  if (!data || data.instrumental) return null;
  let text = data.lyrics || "";
  if (!text && Array.isArray(data.lines)) {
    text = data.lines
      .map((l) => (typeof l === "string" ? l : l.text || ""))
      .join("\n");
  }
  if (!text) return null;
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.slice(0, 4).join("\n") || null;
}

let lyricsPreviewKeyCurrent = "";

/** Anteprima "Testo" sotto ai controlli — scorrendo il full screen. */
async function loadLyricsPreview() {
  if (!npLyricsPreview || !npLyricsPreviewBody) return;
  let title =
    (nowPlaying && nowPlaying.title) || (nowTitle && nowTitle.textContent) || "";
  let artist =
    (nowPlaying && nowPlaying.artist) || (nowArtist && nowArtist.textContent) || "";
  if (!title || title === "Nessun brano" || title === "…") {
    npLyricsPreview.hidden = true;
    return;
  }
  const cleaned = cleanLyricsMeta(artist, title);
  artist = cleaned.artist;
  title = cleaned.title || title;
  const key = lyricsCacheKey(artist, title);
  lyricsPreviewKeyCurrent = key;

  const render = (data) => {
    const snippet = buildLyricsSnippet(data);
    if (!snippet) {
      npLyricsPreview.hidden = true;
      return;
    }
    npLyricsPreviewBody.textContent = snippet;
    npLyricsPreview.hidden = false;
  };

  if (lyricsCache.has(key)) {
    render(lyricsCache.get(key));
    return;
  }
  npLyricsPreview.hidden = true;
  try {
    const q = new URLSearchParams({
      title: title.slice(0, 200),
      artist: (artist || "").slice(0, 200),
    });
    const durLocal = Number(audio.duration);
    if (Number.isFinite(durLocal) && durLocal > 0) {
      q.set("duration", durLocal.toFixed(1));
    }
    const data = await apiJson(`/api/lyrics?${q}`);
    lyricsCache.set(key, data);
    if (lyricsPreviewKeyCurrent === key) render(data);
  } catch (_) {
    if (lyricsPreviewKeyCurrent === key) npLyricsPreview.hidden = true;
  }
}

// —— queue ——
function searchItemFromTrack(t) {
  return {
    qid: uid(),
    source: "search",
    title: t.title || t.label || "track",
    artist: t.artist || "",
    duration: t.duration || "",
    cover_url: proxiedCover(t.cover_url) || null,
    search_id: currentSearchId,
    index: t.index,
  };
}

function libraryItemFromTrack(t) {
  return {
    qid: uid(),
    source: "library",
    title: t.title || "track",
    artist: t.artist || "",
    duration: t.duration || "",
    // token in query per <audio>/<img> (Bearer non si applica)
    cover_url: t.cover_url ? mediaAuthUrl(t.cover_url, { bust: false }) : null,
    cover_hd_url: t.cover_hd_url
      ? mediaAuthUrl(t.cover_hd_url, { bust: false })
      : t.cover_url
        ? mediaAuthUrl(t.cover_url, { bust: false })
        : null,
    id: t.id,
    stream_url: t.stream_url
      ? mediaAuthUrl(t.stream_url, { bust: false })
      : null,
  };
}

/** Preview di un brano di un altro utente ("Aggiunte di recente al server") */
function recentItemFromTrack(t) {
  return {
    qid: uid(),
    source: "recent",
    ownerId: t.owner_id,
    title: t.title || "track",
    artist: t.artist || "",
    duration: t.duration || "",
    cover_url: t.cover_url ? mediaAuthUrl(t.cover_url, { bust: false }) : null,
    cover_hd_url: t.cover_hd_url
      ? mediaAuthUrl(t.cover_hd_url, { bust: false })
      : t.cover_url
        ? mediaAuthUrl(t.cover_url, { bust: false })
        : null,
    id: t.id,
    stream_url: t.stream_url ? mediaAuthUrl(t.stream_url, { bust: false }) : null,
  };
}

/** Cache liste per next/prev/shuffle (salvati e ultima ricerca = contesti tipo playlist) */
let libraryTracksCache = [];
let lastSearchTracks = [];

/**
 * Imposta la coda con un intero contesto (salvati / risultati / playlist)
 * e parte da startIndex. Così avanti/indietro/shuffle hanno senso.
 */
/** Con shuffle attivo, il "play" da fermo (playlist non ancora in coda) deve
 * partire da un brano a caso come su Spotify, non sempre dal primo — la
 * riproduzione successiva (playNext) segue comunque shuffleOrder a parte. */
function shuffleStartIndex(n) {
  return shuffleOn && n > 1 ? Math.floor(Math.random() * n) : 0;
}

async function playFromList(items, startIndex, toastMsg, fromJarvis) {
  if (!items || !items.length) return;
  const start = Math.max(0, Math.min(startIndex | 0, items.length - 1));
  // Contesto playlist/salvati/ricerca — non sono "aggiunti dall'utente"
  queue.items = items.map((it) => ({ ...it, userQueued: false }));
  queue.index = start;
  if (shuffleOn) rebuildShuffleOrder();
  else shuffleOrder = [];
  updateQueueUi();
  if (toastMsg) toast(toastMsg);
  // qualunque altra playlist/ricerca/libreria fatta partire da qui "esce"
  // dalla sessione JARVIS — il commentary parlato in playQueueIndex deve
  // attivarsi SOLO quando la coda è quella del DJ, non sempre
  jarvisSessionActive = !!fromJarvis;
  // se JARVIS sta parlando in quel momento e l'utente fa partire musica a
  // mano (non tramite JARVIS), fermalo subito — altrimenti la sua voce
  // continua a suonare sopra al nuovo brano (richiesta di Vitto,
  // 2026-08-01: stesso principio di speakJarvisText che mette in pausa
  // audio prima di parlare, ma nel verso opposto: qui è la musica che
  // deve azzittire JARVIS, non il contrario).
  if (!fromJarvis && jarvisSpeechAudio && !jarvisSpeechAudio.paused) {
    jarvisSpeechAudio.pause();
  }
  await playQueueIndex(start);
}

/**
 * Indice dove inserire un brano "In coda" (stile Spotify):
 * subito dopo il current, dopo gli altri già aggiunti dall'utente (FIFO).
 */
function userQueueInsertIndex() {
  if (queue.index < 0 || !queue.items.length) return queue.items.length;
  let at = queue.index + 1;
  while (at < queue.items.length && queue.items[at].userQueued) at++;
  return at;
}

/** Click su un salvato: tutta la libreria in coda come playlist */
function playLibraryTrack(t) {
  const list =
    libraryTracksCache.length > 0
      ? libraryTracksCache
      : t
        ? [t]
        : [];
  if (!list.length) return;
  const items = list.map(libraryItemFromTrack);
  let start = items.findIndex((x) => x.id === t.id);
  if (start < 0) start = 0;
  playFromList(items, start, null);
}

/** Click su risultato ricerca: tutta la pagina corrente in coda */
async function playSearchTrack(t) {
  const list =
    lastSearchTracks.length > 0
      ? lastSearchTracks
      : t
        ? [t]
        : [];
  if (!list.length) return;
  const items = list.map(searchItemFromTrack);
  let start = items.findIndex((x) => x.index === t.index);
  if (start < 0) start = 0;
  await playFromList(items, start, null);
}

/**
 * Salva un brano dalla ricerca: serve lo stream in cache (token),
 * quindi se non è già in play lo avvia e poi salva in crackify/.
 * @returns {Promise<boolean>} true se salvato (o già salvato)
 */
async function saveSearchTrack(t) {
  let playerFilling = false;
  try {
    const cur = queue.index >= 0 ? queue.items[queue.index] : null;
    const same =
      cur &&
      cur.source === "search" &&
      cur.index === t.index &&
      cur.search_id === currentSearchId &&
      nowPlaying.token;

    if (!same) {
      toast("Scarico e salvo…");
      await playSearchTrack(t);
    }
    if (!nowPlaying.token) {
      toast("Salva: riproduci il brano e riprova");
      return false;
    }
    // se era in undo-window, annulla la delete differita (file ancora lì)
    cancelPendingRemoveMatching({
      title: t.title,
      artist: t.artist,
    });
    // cuore player + sheet: fill in parallelo al download server
    startHeartFill(btnLike, npLike);
    playerFilling = true;
    const data = await apiJson("/api/library/save", { token: nowPlaying.token });
    if (data.track?.id) cancelPendingLibraryRemove(data.track.id, { toastMsg: false });
    endHeartFill(true, btnLike, npLike);
    playerFilling = false;
    setLikeUi(true);
    nowPlaying.libraryId = data.track?.id || null;
    // mini = thumb, full = HD se il save l’ha scaricata. /api/library/{id}/
    // cover richiede auth (route "propria libreria", non il token TG
    // effimero usato finora): senza mediaAuthUrl la richiesta va in 401 e
    // la cover del brano appena salvato sparisce (grigio) a metà ascolto.
    const tr = data.track || {};
    setCover(
      mediaAuthUrl(tr.cover_url, { bust: false }) || t.cover_url || null,
      mediaAuthUrl(tr.cover_hd_url, { bust: false }) ||
        t.cover_url ||
        mediaAuthUrl(tr.cover_url, { bust: false }) ||
        null
    );
    toast(
      data.already_saved
        ? "Già nei salvati"
        : `Salvato ♥  ${data.track?.title || t.title || ""}`
    );
    // aggiorna cache libreria se aperta
    if (!viewLibrary.classList.contains("hidden")) loadLibrary();
    return true;
  } catch (err) {
    if (playerFilling) endHeartFill(false, btnLike, npLike);
    toast("Salva: " + (err.message || err));
    return false;
  }
}

function updateQueueUi() {
  const upcoming = Math.max(0, queue.items.length - queue.index - 1);
  const total = queue.items.length;
  const userN =
    queue.index >= 0
      ? queue.items
          .slice(queue.index + 1)
          .filter((x) => x.userQueued).length
      : queue.items.filter((x) => x.userQueued).length;
  if (queueBadge) {
    queueBadge.textContent = String(userN);
    queueBadge.classList.toggle("on", userN > 0);
  }
  if (queueBadgeMobile) {
    queueBadgeMobile.textContent = String(userN);
    queueBadgeMobile.classList.toggle("on", userN > 0);
  }

  if (!total) {
    queueStatus.textContent = "Niente in coda — swipe o + su un brano";
    queueNowLabel.textContent = "";
    if (qsNowLabel) qsNowLabel.textContent = "Niente in coda";
  } else {
    queueStatus.textContent =
      userN > 0
        ? `${total} in lista · ${userN} in coda · trascina per riordinare`
        : `${total} in lista · ${upcoming} in arrivo · trascina per riordinare`;
    const cur = queue.items[queue.index];
    const nowText = cur
      ? `In riproduzione · ${cur.artist ? cur.artist + " — " : ""}${cur.title}`
      : "";
    queueNowLabel.textContent = nowText;
    if (qsNowLabel) qsNowLabel.textContent = nowText;
  }

  if (!viewQueue.classList.contains("hidden") || queueSheetOpen) renderQueueList();
  updateNavButtons();
  // la coda cambiata va agli altri device (debounced, solo se siamo noi a
  // suonare) — così un take-over riprende tutta la fila, non un brano solo
  if (typeof publishSharedQueue === "function") publishSharedQueue();
}

/** Sposta #queueList dentro lo sheet invece di duplicare rendering/drag-
 * reorder (già parecchio codice, vedi enableQueueDrag) — stesso nodo,
 * stesso stato, cambia solo il contenitore che lo ospita. closeQueueSheet
 * lo rimette SEMPRE in #viewQueue (ultimo figlio, posizione originale),
 * così la pagina "In coda" a schermo intero lo ritrova al suo posto anche
 * se non è lei ad aver aperto lo sheet. Richiesta di Vitto, 2026-08-03:
 * notifica "Apri" dopo un'aggiunta in coda → card in basso invece della
 * pagina intera. */
function openQueueSheet() {
  if (!queueSheet || !queueList || !queueSheetListWrap) return;
  queueSheetListWrap.appendChild(queueList);
  queueSheetOpen = true;
  setQueueSheetMax(false); // sempre "spawn" all'apertura, mai riparte da "max"
  renderQueueList();
  updateQueueUi();
  queueSheet.classList.add("open");
  queueSheet.setAttribute("aria-hidden", "false");
}
function closeQueueSheet() {
  if (!queueSheet || !queueSheetOpen) return;
  queueSheetOpen = false;
  queueSheet.classList.remove("open");
  queueSheet.setAttribute("aria-hidden", "true");
  if (viewQueue && queueList) viewQueue.appendChild(queueList);
}

function appendQueueSection(label) {
  const h = document.createElement("li");
  h.className = "queue-section";
  h.textContent = label;
  queueList.appendChild(h);
}

/**
 * Sposta un brano nella coda (riordino drag).
 * Mantiene il pezzo in play tramite qid.
 */
function moveQueueItem(from, to) {
  const n = queue.items.length;
  if (from === to || from < 0 || to < 0 || from >= n || to >= n) return;
  const playingQid =
    queue.index >= 0 && queue.items[queue.index]
      ? queue.items[queue.index].qid
      : null;

  const [item] = queue.items.splice(from, 1);
  // riordinato a mano → preferenza utente
  if (playingQid == null || item.qid !== playingQid) {
    item.userQueued = true;
  }
  queue.items.splice(to, 0, item);

  if (playingQid) {
    const ni = queue.items.findIndex((x) => x.qid === playingQid);
    queue.index = ni >= 0 ? ni : Math.min(queue.index, queue.items.length - 1);
  } else {
    queue.index = -1;
  }

  if (shuffleOn) rebuildShuffleOrder();
  // feedback drop: vibrazione (Android) + flash riga (tutti, utile su iPhone)
  hapticDrop();
  updateQueueUi();
  flashQueueRowByQid(item.qid);
}

function appendQueueRow(item, i, { draggable = false } = {}) {
  const li = document.createElement("li");
  li.className =
    "track" +
    (i === queue.index
      ? i === _queueResolvingIndex
        ? " queue-current resolving"
        : " queue-current playing"
      : "") +
    (item.userQueued ? " queue-user" : "") +
    (draggable ? " queue-draggable" : "");
  li.dataset.qi = String(i);
  if (item.qid) li.dataset.qid = String(item.qid);
  li.innerHTML = `
    <span class="num">${item.userQueued && i !== queue.index ? "↑" : i + 1}</span>
    <div class="art">⚡</div>
    <div class="info">
      <div class="title"></div>
      <div class="artist"></div>
    </div>
    <span class="dur"></span>
    <div class="track-actions">
      ${
        draggable
          ? `<button type="button" class="q-drag" title="Trascina per riordinare" aria-label="Riordina">
              <svg class="q-drag-ico" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
                <rect x="2" y="3" width="12" height="2" rx="1" fill="currentColor"/>
                <rect x="2" y="7" width="12" height="2" rx="1" fill="currentColor"/>
                <rect x="2" y="11" width="12" height="2" rx="1" fill="currentColor"/>
              </svg>
            </button>`
          : ""
      }
      <button type="button" class="q-rm" title="Togli dalla coda">✕</button>
    </div>
  `;
  li.querySelector(".title").textContent = item.title;
  const artistEl = li.querySelector(".artist");
  wireArtistName(artistEl, item.artist, item.artist_id);
  let suffix = "";
  if (item.userQueued && i !== queue.index) suffix = "in coda";
  else if (item.source === "library") suffix = "salvato";
  if (suffix) artistEl.textContent += ` · ${suffix}`;
  li.querySelector(".dur").textContent = item.duration || "";
  if (item.cover_url) {
    const art = li.querySelector(".art");
    lazyLoadCover(art, item.cover_url);
  }
  li.addEventListener("click", (e) => {
    if (e.target.closest(".track-actions")) return;
    if (li.classList.contains("q-drag-moved")) return;
    playQueueIndex(i);
  });
  li.querySelector(".q-rm").addEventListener("click", (e) => {
    e.stopPropagation();
    removeFromQueue(i);
  });
  if (draggable) {
    enableQueueDrag(li, i);
  }
  queueList.appendChild(li);
}

/**
 * Haptic leggero.
 * Nell'app nativa (Capacitor) usa il plugin Haptics (motore aptico vero,
 * unico modo di avere feedback tattile su iOS). Nel browser/PWA
 * `navigator.vibrate` NON esiste su iPhone/iPad Safari (limite Apple, mai
 * implementata) → no-op lì, ma funziona su Android Chrome.
 * @returns {boolean} true se il device ha (presumibilmente) accettato il feedback
 */
function haptic(pattern = 12) {
  try {
    const Haptics = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Haptics;
    if (Haptics && Haptics.impact) {
      const style = (Array.isArray(pattern) ? pattern.length : 1) > 1 ? "medium" : "light";
      Haptics.impact({ style });
      return true;
    }
  } catch (_) {}
  try {
    if (typeof navigator === "undefined" || typeof navigator.vibrate !== "function") {
      return false;
    }
    // iOS a volte espone la fn ma non fa nulla — evita chiamate inutili
    const ua = navigator.userAgent || "";
    if (/iPhone|iPad|iPod/i.test(ua)) return false;
    navigator.vibrate(0);
    return !!navigator.vibrate(pattern);
  } catch (_) {
    return false;
  }
}

function hapticDrop() {
  // un po' più “solido” del tick di drag
  return haptic([16, 35, 22]);
}

/** Flash visivo sulla riga spostata (fallback quando non c’è vibrazione) */
function flashQueueRowByQid(qid) {
  if (!qid || !queueList) return;
  requestAnimationFrame(() => {
    const row = queueList.querySelector(`.track[data-qid="${CSS.escape(String(qid))}"]`);
    if (!row) return;
    row.classList.remove("q-just-moved");
    // reflow per ri-triggerare animazione
    void row.offsetWidth;
    row.classList.add("q-just-moved");
    window.setTimeout(() => row.classList.remove("q-just-moved"), 480);
  });
}

/**
 * Drag-to-reorder coda (pointer events: mouse + touch).
 * Handle grip (3 linee) — non il pezzo in play.
 * moveQueueItem(from, to) mette l'item all'indice finale `to`.
 */
function enableQueueDrag(li, index) {
  const handle = li.querySelector(".q-drag");
  if (!handle) return;

  let dragging = false;
  let startY = 0;
  let startX = 0;
  let from = index;
  let ghost = null;
  let offsetY = 0;
  let lastTo = index;
  let moved = false;
  let liftHaptic = false;
  let slotHeight = 0;

  const clearIndicators = () => {
    queueList
      .querySelectorAll(".q-drop-before, .q-drop-after")
      .forEach((el) => {
        el.classList.remove("q-drop-before", "q-drop-after");
      });
  };

  /** Spinge via le righe già ora (riordino live), invece di aspettare il rilascio */
  const applyLiveShift = (nextTo) => {
    const rows = [...queueList.querySelectorAll(".track.queue-draggable")];
    rows.forEach((row) => {
      const qi = parseInt(row.dataset.qi, 10);
      if (Number.isNaN(qi) || qi === from || !slotHeight) {
        row.style.transform = "";
        return;
      }
      let shift = 0;
      if (from < nextTo && qi > from && qi <= nextTo) shift = -slotHeight;
      else if (from > nextTo && qi >= nextTo && qi < from) shift = slotHeight;
      row.style.transform = shift ? `translateY(${shift}px)` : "";
    });
  };

  /** Rimette tutte le righe al loro posto (drag annullato/rilasciato senza spostare) */
  const clearLiveShift = () => {
    queueList.querySelectorAll(".track.queue-draggable").forEach((row) => {
      row.style.transform = "";
    });
  };

  /** Indice finale desiderato in queue.items */
  const getDropTo = (clientY) => {
    const rows = [...queueList.querySelectorAll(".track.queue-draggable")];
    clearIndicators();
    if (!rows.length) return from;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const r = row.getBoundingClientRect();
      const mid = r.top + r.height / 2;
      const qi = parseInt(row.dataset.qi, 10);
      if (Number.isNaN(qi)) continue;
      if (clientY < mid) {
        row.classList.add("q-drop-before");
        let to = qi;
        if (from < qi) to = qi - 1;
        return Math.max(0, Math.min(queue.items.length - 1, to));
      }
    }
    const last = rows[rows.length - 1];
    last.classList.add("q-drop-after");
    const qi = parseInt(last.dataset.qi, 10);
    let to = Number.isNaN(qi) ? from : qi;
    if (from < to) to = qi;
    return Math.max(0, Math.min(queue.items.length - 1, to));
  };

  const onPointerDown = (e) => {
    if (e.button != null && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    dragging = true;
    moved = false;
    liftHaptic = false;
    from = parseInt(li.dataset.qi, 10);
    if (Number.isNaN(from)) from = index;
    lastTo = from;
    startY = e.clientY;
    startX = e.clientX;
    const rect = li.getBoundingClientRect();
    offsetY = e.clientY - rect.top;

    ghost = li.cloneNode(true);
    ghost.classList.add("q-ghost");
    ghost.style.width = `${rect.width}px`;
    ghost.style.height = `${rect.height}px`;
    ghost.style.left = `${rect.left}px`;
    ghost.style.top = `${rect.top}px`;
    document.body.appendChild(ghost);

    // altezza di uno "slot" (riga + gap) per il riordino live delle altre righe
    const rows = [...queueList.querySelectorAll(".track.queue-draggable")];
    slotHeight =
      rows.length >= 2
        ? rows[1].getBoundingClientRect().top - rows[0].getBoundingClientRect().top
        : rect.height;

    li.classList.add("q-dragging");
    try {
      handle.setPointerCapture(e.pointerId);
    } catch (_) {}
    document.body.classList.add("q-reorder-active");
  };

  const onPointerMove = (e) => {
    if (!dragging) return;
    e.preventDefault();
    if (Math.abs(e.clientY - startY) > 4 || Math.abs(e.clientX - startX) > 4) {
      if (!moved) {
        moved = true;
        // tick di “lift”
        if (!liftHaptic) {
          liftHaptic = true;
          haptic(10);
        }
      }
    }
    if (ghost) {
      ghost.style.top = `${e.clientY - offsetY}px`;
      ghost.style.left = `${li.getBoundingClientRect().left}px`;
    }
    const nextTo = getDropTo(e.clientY);
    applyLiveShift(nextTo);
    // tick leggero ogni volta che cambia lo slot di drop
    if (nextTo !== lastTo) {
      lastTo = nextTo;
      haptic(6);
    } else {
      lastTo = nextTo;
    }
  };

  const onPointerUp = (e) => {
    if (!dragging) return;
    dragging = false;
    try {
      handle.releasePointerCapture(e.pointerId);
    } catch (_) {}
    if (ghost) {
      ghost.remove();
      ghost = null;
    }
    clearIndicators();
    li.classList.remove("q-dragging");
    document.body.classList.remove("q-reorder-active");

    if (moved && lastTo !== from) {
      // haptic + flash dentro moveQueueItem (fresh re-render: pulisce da solo i transform live)
      moveQueueItem(from, lastTo);
    } else {
      // niente spostamento: rimetti tutte le righe al loro posto
      clearLiveShift();
      if (moved) haptic(8); // rilasciato senza spostare
    }
  };

  handle.addEventListener("pointerdown", onPointerDown);
  handle.addEventListener("pointermove", onPointerMove);
  handle.addEventListener("pointerup", onPointerUp);
  handle.addEventListener("pointercancel", onPointerUp);
}

function renderQueueList() {
  // pulizia difensiva: .q-ghost (il clone del drag, vedi enableQueueDrag)
  // vive fuori da #queueList — appeso a document.body, position:fixed —
  // quindi "queueList.innerHTML = ''" qui sotto NON lo tocca. Se per
  // qualunque motivo pointerup/pointercancel non fosse arrivato (gesto
  // interrotto in modo anomalo) restava incollato a schermo, letto come
  // "un residuo della canzone che muovi" (Vitto, 2026-08-03, screenshot).
  // Ogni render fresco lo spazza comunque via.
  document.querySelectorAll(".q-ghost").forEach((el) => el.remove());
  queueList.innerHTML = "";
  if (!queue.items.length) return;

  const cur = queue.index;
  const pastIdx = [];
  const nextIdx = [];

  for (let i = 0; i < queue.items.length; i++) {
    if (i === cur) continue;
    if (cur >= 0 && i < cur) pastIdx.push(i);
    else nextIdx.push(i);
  }

  if (cur >= 0) {
    appendQueueSection("In riproduzione");
    appendQueueRow(queue.items[cur], cur, { draggable: false });
  }

  // Prossimi in ordine reale array (drag-friendly, stile Spotify)
  if (nextIdx.length) {
    let lastSec = null;
    nextIdx.forEach((i) => {
      const sec = queue.items[i].userQueued ? "In coda" : "Successivi";
      if (sec !== lastSec) {
        appendQueueSection(sec);
        lastSec = sec;
      }
      appendQueueRow(queue.items[i], i, { draggable: true });
    });
  }

  if (pastIdx.length) {
    appendQueueSection("Già ascoltati");
    pastIdx.forEach((i) =>
      appendQueueRow(queue.items[i], i, { draggable: true })
    );
  }
}

/**
 * Aggiungi in coda stile Spotify: in alto dopo il brano attuale
 * (dopo gli altri già messi in coda dall'utente), non in fondo.
 */
/**
 * Swipe di un risultato di ricerca in coda: avvia subito il download reale
 * (stesso bridge.play() di un tap diretto, click sul bot Telegram incluso)
 * invece di aspettare che la coda arrivi al suo turno — quando ci arriva,
 * il brano è già pronto. Se fallisce, playQueueItem rifà /api/play da solo
 * quando serve davvero (stesso comportamento di prima di questa modifica).
 */
async function prefetchSearchQueueItem(entry) {
  try {
    const data = await apiJson("/api/play", {
      search_id: entry.search_id,
      index: entry.index,
      prefetch: true,
    });
    entry.token = data.token;
    entry.stream_url = data.stream_url;
    entry.saved = !!data.saved;
    entry.tg_cover_url = data.cover_url || null;
    // qui c'è vero anticipo (il brano non suona ancora): scarica ora,
    // fire-and-forget, così quando la coda arriva al suo turno è pronto.
    // Il server NON lo fa più in automatico su ogni /api/play — solo qui,
    // per non aggiungere un download in più anche ai tap diretti. HEAD
    // fa girare lo stesso ensure_local_file() ma senza trasferire l'audio.
    fetch(apiUrl(`/api/media/${data.token}`), { method: "HEAD" }).catch(() => {});
  } catch (err) {
    console.warn("prefetch coda fallito", err);
  }
}

function addToQueue(item, { playIfEmpty = false } = {}) {
  const entry = {
    ...item,
    qid: item.qid || uid(),
    userQueued: true,
  };
  if (entry.source === "search" && entry.search_id && entry.index != null) {
    prefetchSearchQueueItem(entry);
  }
  if (queue.index < 0 || !queue.items.length) {
    queue.items.push(entry);
    if (shuffleOn) rebuildShuffleOrder();
    updateQueueUi();
    if (playIfEmpty) {
      // qui il brano parte SUBITO in riproduzione, non resta "in coda" ad
      // aspettare — un "Apri coda" non avrebbe senso, è già davanti ai suoi
      // occhi nel mini player/np-sheet
      playQueueIndex(0);
      return;
    }
  } else {
    const at = userQueueInsertIndex();
    queue.items.splice(at, 0, entry);
    // indici dopo l'inserimento: current resta lo stesso
    if (shuffleOn) rebuildShuffleOrder();
    updateQueueUi();
  }
  // richiesta di Vitto, 2026-08-03: notifica con "Apri" che porta alla
  // coda (ora un bottom sheet, vedi openQueueSheet) invece di dover
  // navigare a mano. Prima scattava SOLO se la coda aveva già qualcosa in
  // play — ma con la coda vuota (es. dopo un riavvio dell'app, niente in
  // riproduzione) swipe/+ prendono il ramo sopra, che aggiungeva il brano
  // in silenzio: nessun feedback, "non apre il popup" (Vitto). Ora copre
  // entrambi i rami, tranne quando playIfEmpty fa partire subito il brano
  // (return sopra, prima di arrivare qui).
  toast(`${entry.title || "Brano"} aggiunto alla coda`, {
    duration: UNDO_MS,
    actionLabel: "Apri",
    onAction: () => openQueueSheet(),
  });
}

/** Chi deve gestire il "torna indietro" adesso, tra i due pannelli hero
 * (playlist singola dentro #viewPlaylists, oppure "Brani salvati" dentro
 * #viewLibrary) — riusa gli handler già cablati sui bottoni, solo nascosti
 * via CSS (vedi .pl-hero-back { display:none }). */
function triggerHeroBack() {
  if (viewArtist && !viewArtist.classList.contains("hidden")) {
    document.getElementById("btnArtistBack")?.click();
    return true;
  }
  if (viewLibrary && !viewLibrary.classList.contains("hidden")) {
    document.getElementById("btnLibBack")?.click();
    return true;
  }
  if (plHero && !plHero.classList.contains("hidden")) {
    document.getElementById("btnPlBack")?.click();
    return true;
  }
  return false;
}

/** Registra dove va l'utente: ogni funzione "apri" chiama questa all'inizio
 * (tipo + argomenti che bastano a rifarla). Stessa logica dello storico del
 * guscio Mac (shell.js): niente doppioni della tappa corrente, una tappa
 * nuova dopo essere tornati indietro taglia l'"avanti", tetto a 50. Mentre
 * lo swipe rifà una tappa non registra niente, come il back di un browser. */
function registraTappa(tipo, args) {
  if (_storico.inRiproduzione) return;
  const cur = _storico.pila[_storico.idx];
  if (cur && cur.tipo === tipo && JSON.stringify(cur.args) === JSON.stringify(args)) return;
  _storico.pila = _storico.pila.slice(0, _storico.idx + 1);
  _storico.pila.push({ tipo, args });
  if (_storico.pila.length > 50) _storico.pila.shift();
  _storico.idx = _storico.pila.length - 1;
}

/** La pagina artista sta sopra le altre viste e activatePlaylistsShell non
 * la nasconde: tornando a un mix o a una playlist resterebbe davanti. */
function chiudiPaginaArtista() {
  if (!viewArtist || viewArtist.classList.contains("hidden")) return;
  stopArtistCatalogFill();
  closeArtistTracksModal();
  viewArtist.classList.add("hidden");
}

/** Rifà una tappa chiamando la stessa funzione che l'aveva aperta — chart,
 * mix, playlist… vivono dentro "playlists" e la vista la apre chi tocca la
 * card, quindi qui va riaperta a mano (come fa il guscio Mac). */
function riproduciTappa(v, indietro) {
  _classeEntrata = indietro ? "back-enter" : "fwd-enter";
  _storico.inRiproduzione = true;
  try {
    if (v.tipo !== "dettaglio") chiudiPaginaArtista();
    const a = v.args;
    switch (v.tipo) {
      case "vista": showView(a[0]); break;
      case "chart": activatePlaylistsShell(); openChart(a[0]); break;
      case "mix": openDailyMix(a[0]); break;
      case "radio": openRadioStation(a[0]); break;
      case "discovery": openDiscoveryWeekly(); break;
      case "deezer": activatePlaylistsShell(); openDeezerPlaylist(a[0]); break;
      case "playlist": activatePlaylistsShell(); openPlaylist(a[0], { entrata: true }); break;
      case "playlistAltrui": activatePlaylistsShell(); openHomePlaylist(a[0], a[1]); break;
      case "dettaglio": openDetailPage(a[0], a[1]); break;
      case "salvati": openSavedLibrary(); break;
    }
  } finally {
    _storico.inRiproduzione = false;
    // tappa che carica (scheletro acceso): la classe la rimette a posto
    // hideLoadingOverlay, dopo l'entrata del contenuto arrivato
    if (!loadingOverlay || loadingOverlay.classList.contains("hidden")) _classeEntrata = "view-enter";
  }
}

function puoAndareAvanti() {
  return !appOfflineMode && _storico.idx < _storico.pila.length - 1;
}

/** Indietro dello swipe: la tappa precedente dello storico. Offline la Home
 * non si raggiunge (serve rete): lì restano i ← nascosti di sempre, e così
 * anche se lo storico non ha niente dietro. */
function navIndietro() {
  if (!appOfflineMode && _storico.idx > 0) {
    _storico.idx--;
    riproduciTappa(_storico.pila[_storico.idx], true);
    return;
  }
  triggerHeroBack();
}

function navAvanti() {
  if (!puoAndareAvanti()) return;
  _storico.idx++;
  riproduciTappa(_storico.pila[_storico.idx], false);
}

/** Il dito parte dentro qualcosa che scorre di lato (caroselli della Home…)
 * e che può ancora scorrere nella direzione dello swipe: è suo, non nostro. */
function scorreDiLato(el, lato) {
  for (let n = el; n && n !== document.body; n = n.parentElement) {
    if (n.scrollWidth <= n.clientWidth + 1) continue;
    const ox = getComputedStyle(n).overflowX;
    if (ox !== "auto" && ox !== "scroll") continue;
    // 8px di tolleranza: a riposo i caroselli della Home stanno a 4px
    // (aggancio delle card), e "all'inizio" deve contare come inizio
    if (lato === "sx" && n.scrollLeft > 8) return true;
    if (lato === "dx" && n.scrollLeft < n.scrollWidth - n.clientWidth - 8) return true;
  }
  return false;
}

const BORDO_SWIPE_PX = 24;
/** Lato del bordo da cui parte il dito ("sx"/"dx"), se fa navigazione. */
function bordoNavigazione(x) {
  if (x <= BORDO_SWIPE_PX) return "sx";
  if (x >= window.innerWidth - BORDO_SWIPE_PX) return "dx";
  return null;
}

/** Swipe dai bordi dello schermo = i chevron del desktop (03/10): dal bordo
 * sinistro torna alla pagina precedente dello storico, dal destro va avanti
 * (come Safari). Prima lo swipe premeva il ← nascosto della pagina aperta,
 * che portava in un posto fisso (da un mix sempre alla Home). Solo sul
 * contenuto delle pagine: player, sheet, finestre e menu hanno i loro gesti. */
function setupEdgeSwipeBack() {
  const THRESHOLD_PX = 80;
  let startX = 0;
  let startY = 0;
  let lato = null;
  // l'app parte già sulla Home (senza passare da showView): prima tappa
  if (_storico.idx < 0) registraTappa("vista", ["home"]);
  document.addEventListener(
    "touchstart",
    (e) => {
      lato = null;
      const t = e.touches[0];
      if (!t || e.touches.length !== 1) return;
      const l = bordoNavigazione(t.clientX);
      if (!l) return;
      if (!e.target.closest || !e.target.closest(".main")) return;
      if (l === "dx" && !puoAndareAvanti()) return;
      if (scorreDiLato(e.target, l)) return;
      lato = l;
      startX = t.clientX;
      startY = t.clientY;
    },
    { passive: true }
  );
  document.addEventListener(
    "touchend",
    (e) => {
      if (!lato) return;
      const l = lato;
      lato = null;
      const t = e.changedTouches[0];
      if (!t) return;
      const dx = t.clientX - startX;
      const dy = Math.abs(t.clientY - startY);
      if (dy >= 60) return;
      if (l === "sx" && dx > THRESHOLD_PX) navIndietro();
      else if (l === "dx" && -dx > THRESHOLD_PX) navAvanti();
    },
    { passive: true }
  );
}

/**
 * Swipe destra su una riga brano → aggiungi in coda (stile Spotify).
 * @param {HTMLElement} frontEl  — .track (superficie che slitta)
 * @param {() => object} getItem — factory item coda
 * @param {{ onTap?: () => void }} [opts]
 */
function enableSwipeToQueue(frontEl, getItem, opts = {}) {
  // <li> così resta valido dentro <ul class="track-list">
  const wrap = document.createElement("li");
  wrap.className = "track-swipe";
  const bg = document.createElement("div");
  bg.className = "track-swipe-bg";
  bg.setAttribute("aria-hidden", "true");
  bg.innerHTML = `
    <span class="swipe-ico" data-state="plus">
      <span class="swipe-ico-plus">+</span>
      <span class="swipe-ico-check">✓</span>
    </span>
    <span class="swipe-label">In coda</span>
  `;
  const parent = frontEl.parentNode;
  if (parent) parent.insertBefore(wrap, frontEl);
  wrap.appendChild(bg);
  // swipe a sinistra → rimuovi (solo se il chiamante lo abilita, es. dentro
  // una playlist — non ha senso per i risultati di ricerca)
  let bgLeft = null;
  if (opts.onSwipeLeft) {
    bgLeft = document.createElement("div");
    bgLeft.className = "track-swipe-bg-left";
    bgLeft.setAttribute("aria-hidden", "true");
    bgLeft.innerHTML = `
      <span class="swipe-label">Rimuovi</span>
      <span class="swipe-ico">
        <span class="swipe-ico-x">✕</span>
      </span>
    `;
    wrap.appendChild(bgLeft);
  }
  wrap.appendChild(frontEl);

  const THRESH = 68;
  const MAX = 132;
  let startX = 0;
  let startY = 0;
  let dx = 0;
  let rawX = 0;
  let active = false;
  let axis = null; // 'x' | 'y'
  let didSwipe = false;
  let armed = false;
  let lastX = 0;
  let lastT = 0;
  let vx = 0; // px/ms
  let commitTimer = null;

  /** Resistenza elastica oltre ~70% del max (feel nativo), simmetrica */
  const applyResist = (x) => {
    const sign = x < 0 ? -1 : 1;
    const ax = Math.abs(x);
    if (ax === 0) return 0;
    const soft = MAX * 0.72;
    if (ax <= soft) return sign * ax;
    const over = ax - soft;
    return sign * (soft + over * 0.28);
  };

  const setProgress = (x, { animate = false, forceArmed } = {}) => {
    if (animate) wrap.classList.remove("swiping");
    else wrap.classList.add("swiping");

    dx = x;
    const right = Math.max(0, x);
    const left = Math.max(0, -x);
    const p = Math.min(1, right / THRESH);
    const pMax = Math.min(1, right / MAX);
    const pL = Math.min(1, left / THRESH);
    const pmL = Math.min(1, left / MAX);
    wrap.style.setProperty("--swipe-x", `${x}px`);
    wrap.style.setProperty("--swipe-p", String(p));
    wrap.style.setProperty("--swipe-pm", String(pMax));
    wrap.style.setProperty("--swipe-p-l", String(pL));
    wrap.style.setProperty("--swipe-pm-l", String(pmL));

    frontEl.style.transform = x
      ? `translate3d(${x}px,0,0) scale(${1 - Math.max(pMax, pmL) * 0.015})`
      : "";

    const nowArmed =
      forceArmed != null ? forceArmed : Math.abs(x) >= THRESH * 0.92;
    if (nowArmed !== armed) {
      armed = nowArmed;
      wrap.classList.toggle("armed", armed);
      wrap.classList.toggle("armed-left", armed && x < 0);
      if (armed) haptic(8);
    }
  };

  const reset = () => {
    active = false;
    axis = null;
    rawX = 0;
    vx = 0;
    setProgress(0, { animate: true, forceArmed: false });
    wrap.classList.remove(
      "armed",
      "armed-left",
      "swiping",
      "queued-flash",
      "queued-ok"
    );
    armed = false;
  };

  const commitQueue = () => {
    didSwipe = true;
    active = false;
    axis = null;
    wrap.classList.add("queued-flash", "queued-ok");
    setProgress(96, { animate: true, forceArmed: true });
    haptic([10, 30, 12]);
    try {
      addToQueue(getItem());
    } catch (_) {}
    clearTimeout(commitTimer);
    commitTimer = setTimeout(() => {
      wrap.classList.remove("queued-flash");
      setProgress(0, { animate: true, forceArmed: false });
      wrap.classList.remove("queued-ok", "armed", "swiping");
      armed = false;
      setTimeout(() => {
        didSwipe = false;
      }, 100);
    }, 420);
  };

  const commitRemove = () => {
    didSwipe = true;
    active = false;
    axis = null;
    wrap.classList.add("removed-flash");
    setProgress(-96, { animate: true, forceArmed: true });
    haptic([10, 30, 12]);
    try {
      opts.onSwipeLeft();
    } catch (_) {}
    // la rimozione ricarica la lista dal chiamante: non serve fare reset
    // manuale qui, la riga sparirà col refresh
  };

  frontEl.addEventListener(
    "touchstart",
    (e) => {
      if (e.touches.length !== 1) return;
      if (e.target.closest(".track-actions, button, a")) return;
      if (wrap.classList.contains("queued-flash")) return;
      // dai bordi lo swipe è indietro/avanti (setupEdgeSwipeBack), non coda/
      // rimuovi: senza questo partivano tutti e due. Il destro solo se c'è
      // davvero un "avanti", altrimenti resta alla riga
      const bordo = bordoNavigazione(e.touches[0].clientX);
      if (bordo === "sx" || (bordo === "dx" && puoAndareAvanti())) return;
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      lastX = startX;
      lastT = performance.now();
      dx = 0;
      rawX = 0;
      vx = 0;
      active = true;
      axis = null;
      wrap.classList.add("swiping");
      wrap.classList.remove("queued-ok", "queued-flash");
    },
    { passive: true }
  );

  frontEl.addEventListener(
    "touchmove",
    (e) => {
      if (!active) return;
      const t = performance.now();
      const cx = e.touches[0].clientX;
      const cy = e.touches[0].clientY;
      const x = cx - startX;
      const y = cy - startY;
      const dt = Math.max(1, t - lastT);
      vx = (cx - lastX) / dt;
      lastX = cx;
      lastT = t;

      if (axis == null) {
        if (Math.abs(x) < 8 && Math.abs(y) < 8) return;
        axis = Math.abs(x) > Math.abs(y) * 1.2 ? "x" : "y";
        if (axis === "y") {
          active = false;
          reset();
          return;
        }
      }
      if (axis !== "x") return;
      // swipe destra sempre (coda); sinistra (rimuovi) solo se abilitato
      rawX = opts.onSwipeLeft ? x : Math.max(0, x);
      setProgress(applyResist(rawX), { animate: false });
      if (e.cancelable && Math.abs(dx) > 5) e.preventDefault();
    },
    { passive: false }
  );

  const end = () => {
    if (!active && axis !== "x") return;
    if (axis !== "x") {
      reset();
      return;
    }
    if (dx >= 0) {
      // soglia o flick veloce verso destra → coda
      const flick = vx > 0.45 && dx > THRESH * 0.45;
      if (dx >= THRESH || flick) {
        commitQueue();
      } else {
        reset();
      }
    } else if (opts.onSwipeLeft) {
      // soglia o flick veloce verso sinistra → rimuovi
      const flick = vx < -0.45 && -dx > THRESH * 0.45;
      if (-dx >= THRESH || flick) {
        commitRemove();
      } else {
        reset();
      }
    } else {
      reset();
    }
  };

  frontEl.addEventListener("touchend", end, { passive: true });
  frontEl.addEventListener("touchcancel", () => reset(), { passive: true });

  // blocca click se c’è stato swipe
  frontEl.addEventListener(
    "click",
    (e) => {
      if (didSwipe || dx > 10) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        dx = 0;
      }
    },
    true
  );

  if (opts.onTap) {
    frontEl.addEventListener("click", (e) => {
      if (e.target.closest(".track-actions, button, a")) return;
      if (didSwipe) return;
      opts.onTap(e);
    });
  }

  return wrap;
}

function removeFromQueue(i) {
  if (i < 0 || i >= queue.items.length) return;
  queue.items.splice(i, 1);
  if (queue.items.length === 0) {
    queue.index = -1;
  } else if (i < queue.index) {
    queue.index -= 1;
  } else if (i === queue.index) {
    if (queue.index >= queue.items.length) queue.index = queue.items.length - 1;
    if (shuffleOn) rebuildShuffleOrder();
    playQueueIndex(queue.index);
    return;
  }
  if (shuffleOn) rebuildShuffleOrder();
  updateQueueUi();
}

function clearQueue() {
  const keep = queue.index >= 0 ? queue.items[queue.index] : null;
  queue.items = keep ? [keep] : [];
  queue.index = keep ? 0 : -1;
  if (shuffleOn) rebuildShuffleOrder();
  updateQueueUi();
  toast(keep ? "Coda svuotata (resta il brano attuale)" : "Coda vuota");
}

/** Click su brano: diventa current, il resto della coda resta dopo */
function playNow(item) {
  const entry = { ...item, qid: item.qid || uid(), userQueued: false };
  if (queue.index >= 0) {
    queue.items.splice(queue.index + 1, 0, entry);
    if (shuffleOn) rebuildShuffleOrder();
    playQueueIndex(queue.index + 1);
  } else {
    queue.items.push(entry);
    if (shuffleOn) rebuildShuffleOrder();
    playQueueIndex(0);
  }
}

async function playQueueIndex(i) {
  if (i < 0 || i >= queue.items.length) return;
  if (playBusy) return;
  // playBusy diventa true solo DENTRO playQueueItem, troppo tardi per
  // coprire la fase "JARVIS sta parlando" — una seconda chiamata (skip
  // impaziente, comando da un altro device, ecc.) mentre l'annuncio è
  // ancora in corso non veniva bloccata, causava sessioni sovrapposte
  // (bug segnalato da Vitto: "regole più rigide" — un ciclo annuncio→
  // ricerca→riproduzione alla volta, il prossimo parte solo a fine
  // canzone o skip esplicito, mai in mezzo a uno già in corso)
  if (jarvisSessionActive) {
    if (jarvisTransitionBusy) return;
    jarvisTransitionBusy = true;
  }
  queue.index = i;
  _queueResolvingIndex = i; // non ancora confermato — vedi playQueueItem/appendQueueRow
  updateQueueUi();
  const item = queue.items[i];
  // unico punto di passaggio per skip manuale (playNext/playPrev) E
  // avanzamento automatico a fine brano (vedi audio "ended") — il posto
  // giusto per far parlare JARVIS prima che parta il prossimo brano,
  // senza duplicare l'aggancio in due posti diversi
  if (jarvisSessionActive) {
    // stesso motivo di startJarvisSession: rinnova il claim PRIMA di
    // parlare, non dopo aver suonato — ogni transizione (non solo la
    // prima) ha un'attesa TTS davanti che allarga la finestra in cui un
    // altro device potrebbe risultare ancora "attivo" agli occhi del poll
    // periodico. claimThisPlayer ha già il suo throttling interno, chiamarla
    // spesso è innocuo.
    claimThisPlayer(true);
    // skip manuale PRIMA della fine: il brano vecchio è ancora in
    // riproduzione e continuava a suonare sopra l'annuncio, perché
    // l'audio cambia src solo dentro playQueueItem, ben dopo la battuta
    // (bug segnalato da Vitto). A fine naturale audio è già fermo, questo
    // pause() è ridondante ma innocuo.
    audio.pause();
    if (jarvisSkipNextAnnounce) {
      // questo brano è il primo della sessione, già annunciato insieme al
      // saluto in un'unica battuta da startJarvisSession — vedi lì
      jarvisSkipNextAnnounce = false;
    } else {
      await speakJarvisLine(item);
    }
  }
  // copre il buco tra "JARVIS ha finito di parlare" e "il brano è pronto"
  // (resolve/streaming, vero traffico di rete) — senza, sembra bloccato
  if (jarvisSessionActive) setJarvisLoading(true);
  try {
    await playQueueItem(item);
  } finally {
    if (jarvisSessionActive) {
      setJarvisLoading(false);
      jarvisTransitionBusy = false;
    }
  }
}

function setJarvisLoading(on) {
  if (djLoading) djLoading.hidden = !on;
}

// remoteMirror / remoteMirrorIsJarvis / _mirrorPlaying / _mirrorDur /
// _mirrorServerAt / _mirrorBasePos sono dichiarate vicino a `audio`, in cima
// al file — vedi il commento lì per il perché.
let _playerHbTimer = null;
let _mirrorTickTimer = null;
let _lastMirrorPos = -1;
// URL dello stream che sta suonando l'ALTRO device (già senza il suo token):
// serve al take-over per i brani che non hanno library_id né media token
let _mirrorStreamUrl = "";
// firma della traccia mirrorata attualmente sullo schermo: applyRemoteMirror
// riscrive titolo/cover/tema solo quando cambia (vedi lì)
let _mirrorMetaKey = "";
let _claimBusy = false;
let _lastClaimAt = 0;
let _lastReclaimAt = 0;
let _lastRemoteToastAt = 0;
let _lastRemoteToastKey = "";

function parseDurationToSec(value) {
  if (value == null || value === "") return 0;
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, value);
  const s = String(value).trim();
  if (!s) return 0;
  const asNum = Number(s);
  if (Number.isFinite(asNum) && !s.includes(":")) return Math.max(0, asNum);
  const parts = s.split(/[:.]/).map((p) => Number(p));
  if (parts.some((n) => !Number.isFinite(n))) return 0;
  if (parts.length === 1) return Math.max(0, parts[0]);
  if (parts.length === 2) return Math.max(0, parts[0] * 60 + parts[1]);
  return Math.max(0, parts[0] * 3600 + parts[1] * 60 + parts[2]);
}

function formatTotalDuration(totalSec) {
  const totalMin = Math.round(totalSec / 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h} h ${m} min` : `${m} min`;
}

/** Riga meta stile Spotify: "Autore • N brani, X h Y min". */
function setHeroMetaText(el, tracks) {
  if (!el) return;
  const count = tracks.length;
  const totalSec = tracks.reduce((sum, t) => sum + parseDurationToSec(t.duration), 0);
  const owner =
    (authState.user && (authState.user.display_name || authState.user.username)) ||
    "CRACKIFY";
  const noun = count === 1 ? "brano" : "brani";
  el.textContent = count
    ? `${owner} • ${count} ${noun}, ${formatTotalDuration(totalSec)}`
    : `${owner} • nessun brano`;
}

/**
 * URL dello stream che stiamo suonando, ripulito dalle parti che valgono solo
 * per noi (token di sessione e cache-buster), così un altro device può
 * ri-firmarlo col suo token — vedi retokenUrl().
 *
 * Serve perché library_id e stream_token NON coprono tutti i brani: quelli
 * che arrivano da JARVIS o da un daily mix suonano da
 * /api/library/recent/{owner}/{id}/audio e hanno entrambi i campi vuoti. Chi
 * riceveva quello stato non aveva nulla da caricare: lo switch di dispositivo
 * mostrava il brano giusto e restava muto (Vitto, 2026-08-12, MONTAGEM
 * BATCHI passato dall'iPhone al Mac).
 */
function currentStreamPath() {
  const src = audio.src || "";
  if (!src || src.startsWith("blob:") || src.startsWith("data:")) return "";
  try {
    const url = new URL(src, location.origin);
    let apiOrigin = null;
    if (API_BASE) {
      try {
        apiOrigin = new URL(API_BASE, location.origin).origin;
      } catch (_) {}
    }
    // stream esterno (preview Deezer): niente da passare — il server accetta
    // solo path /api/ suoi, per non far scaricare a un device URL arbitrari
    if (url.origin !== location.origin && url.origin !== apiOrigin) return "";
    url.searchParams.delete("t");
    url.searchParams.delete("_");
    return url.pathname + (url.search || "");
  } catch (_) {
    return "";
  }
}

function playerSnapshot() {
  const dur = Number(audio.duration);
  let durationSec = Number.isFinite(dur) && dur > 0 ? dur : 0;
  if (!durationSec) {
    // fallback da label timeline (es. "2:40")
    durationSec = parseDurationToSec(timeDur?.textContent);
  }
  return {
    title: nowPlaying.title || nowTitle?.textContent || "",
    artist: nowPlaying.artist || nowArtist?.textContent || "",
    library_id: nowPlaying.libraryId || "",
    stream_token: nowPlaying.token || "",
    stream_url: currentStreamPath(),
    cover_url: _lastCoverThumb || "",
    position_sec: getCurrentPlaybackPosition(),
    duration_sec: durationSec,
    is_playing: !!(audio.src && !audio.paused),
    // altri device leggono questo per sapere se "quello che sto vedendo
    // nel mirror" è una sessione JARVIS continuabile, vedi openDjSheet
    is_jarvis: !!jarvisSessionActive,
  };
}

function toastRemotePlayingOnce(title, artist) {
  // max 1 toast ogni 12s per la stessa canzone (no spam da stop ripetuti)
  const key = `${title || ""}|${artist || ""}`;
  const now = Date.now();
  if (key === _lastRemoteToastKey && now - _lastRemoteToastAt < 12000) return;
  if (remoteMirror && now - _lastRemoteToastAt < 8000) return;
  _lastRemoteToastKey = key;
  _lastRemoteToastAt = now;
  const who = title ? " · " + title + (artist ? " — " + artist : "") : "";
  toast("Riproduzione su un altro device" + who, { duration: 2200 });
}

async function claimThisPlayer(force = false) {
  // un solo device in play per account — pubblichiamo SEMPRE lo stato
  // (anche se l'autoplay iOS è bloccato) così gli altri vedono la mini bar
  if (!authState.authenticated || !getSessionToken()) return;
  if (_claimBusy && !force) return;
  // se siamo già active da poco, basta un heartbeat (niente re-claim spam)
  const now = Date.now();
  if (
    !force &&
    connectThisIsActive &&
    !remoteMirror &&
    now - _lastClaimAt < 4000
  ) {
    pushPlayerState().catch(() => {});
    return;
  }
  remoteMirror = false;
  stopMirrorTicker();
  _lastMirrorPos = -1;
  _mirrorMetaKey = "";
  // canale aperto: il claim è un messaggio, non un round-trip HTTP —
  // gli altri device lo sanno prima che qui finisca la riga
  if (typeof syncSend === "function" && syncSend({ t: "claim", state: syncPatch() })) {
    _lastClaimAt = Date.now();
    _sync.wasMirror = false;
    setConnectIconState(true);
    startSyncHeartbeat();
    publishSharedQueue(true);
    return;
  }
  _claimBusy = true;
  try {
    await apiJson("/api/me/player/claim", playerSnapshot(), "POST");
    _lastClaimAt = Date.now();
    setConnectIconState(true);
    startPlayerHeartbeat();
    // push immediato stato (posizione/duration appena disponibili)
    pushPlayerState().catch(() => {});
  } catch (_) {
    /* non bloccare la riproduzione locale */
  } finally {
    _claimBusy = false;
  }
}

async function pushPlayerState() {
  if (remoteMirror) return null;
  if (!authState.authenticated || !getSessionToken()) return null;
  if (!audio.src && !(nowPlaying.libraryId || nowPlaying.token)) return null;
  // sul canale non c'è niente da recuperare: se non siamo più noi l'owner
  // il server ci rimanda lo stato giusto, senza il giro 409 → re-claim
  if (typeof syncSend === "function" && syncSend({ t: "state", state: syncPatch() })) {
    return null;
  }
  try {
    return await apiJson("/api/me/player/state", playerSnapshot(), "POST");
  } catch (e) {
    // 409 = non siamo più active: ri-claim throttled (evita stop storm)
    const now = Date.now();
    if (
      !remoteMirror &&
      audio.src &&
      !audio.paused &&
      now - _lastReclaimAt > 8000
    ) {
      _lastReclaimAt = now;
      await claimThisPlayer(true);
    }
    return null;
  }
}

let _playerHbTick = null;

function startPlayerHeartbeat() {
  const beat = () => {
    if (remoteMirror) return;
    // col canale aperto ci pensa startSyncHeartbeat (1 messaggio ogni 5s
    // invece di un POST al secondo): niente doppio flusso
    if (typeof syncIsOpen === "function" && syncIsOpen()) return;
    if (!authState.authenticated || !getSessionToken()) return;
    // pubblichiamo se abbiamo un brano caricato O eravamo active
    if (!audio.src && !nowPlaying.libraryId && !nowPlaying.token) return;
    if (!connectThisIsActive && audio.paused) return;
    pushPlayerState();
  };
  _playerHbTick = beat;
  if (_playerHbTimer) return;
  _playerHbTimer = setInterval(beat, 1000);
}

function applySeekBar(pos, dur, playing) {
  const p = Math.max(0, Number(pos) || 0);
  const d = Math.max(0, Number(dur) || 0);
  if (d > 0) {
    const ratio = Math.min(1, p / d);
    const v = Math.round(ratio * 1000);
    if (!seekDragging && !npSeekDragging) {
      seek.value = v;
      seekFill.style.width = `${ratio * 100}%`;
      if (npSeek) npSeek.value = v;
      if (npSeekFill) npSeekFill.style.width = `${ratio * 100}%`;
    }
    timeDur.textContent = fmtTime(d);
    if (npTimeDur) npTimeDur.textContent = fmtTime(d);
  }
  timeCur.textContent = fmtTime(p);
  if (npTimeCur) npTimeCur.textContent = fmtTime(p);
  setPlayingUi(!!playing);
}

function stopMirrorTicker() {
  if (_mirrorTickTimer) {
    clearInterval(_mirrorTickTimer);
    _mirrorTickTimer = null;
  }
  _mirrorPlaying = false;
}

function startMirrorTicker() {
  if (_mirrorTickTimer) return;
  _mirrorTickTimer = setInterval(() => {
    if (!remoteMirror || !_mirrorPlaying) return;
    if (seekDragging || npSeekDragging) return;
    const pos = mirrorPlaybackPosition();
    _lastMirrorPos = pos;
    applySeekBar(pos, _mirrorDur, true);
  }, 250);
}

function applyRemoteMirror(active) {
  if (!active || !active.device_id) {
    remoteMirror = false;
    remoteMirrorIsJarvis = false;
    _mirrorMetaKey = "";
    _mirrorStreamUrl = "";
    stopMirrorTicker();
    return;
  }
  remoteMirror = true;
  remoteMirrorIsJarvis = !!active.is_jarvis;
  _mirrorStreamUrl = active.stream_url || "";
  connectThisIsActive = false;
  setConnectIconState(false);

  // non far suonare audio locale in mirror
  if (!audio.paused) {
    try {
      audio.pause();
    } catch (_) {}
  }

  const title = active.title || "In riproduzione";
  const artist = active.artist || "altro dispositivo";
  // Il poll ci richiama ogni secondo con lo STESSO brano: rifare la meta ogni
  // volta significava ri-triggerare crossfade cover, marquee dei titoli e
  // l'estrazione del colore dominante (che fa fetch della cover HD con
  // cache:"no-store" — un download al secondo). Meta solo quando cambia
  // davvero; posizione/seek continuano ad aggiornarsi a ogni giro.
  const metaKey = [
    active.device_id,
    active.library_id || "",
    active.stream_token || "",
    title,
    artist,
    active.cover_url || "",
  ].join("|");
  if (metaKey !== _mirrorMetaKey) {
    _mirrorMetaKey = metaKey;
    nowPlaying = {
      token: active.stream_token || null,
      libraryId: active.library_id || null,
      title,
      artist,
      saved: !!active.library_id,
    };
    nowTitle.textContent = title;
    nowArtist.textContent = artist;
    // Spettro VERO del brano remoto: l'envelope è precalcolato dal server e
    // indicizzato per secondo, quindi vale per qualunque device lo stia
    // suonando — basta chiederlo per lo stesso brano e leggerlo alla
    // posizione remota (vedi envelopeBassLevel). Niente Web Audio, che
    // potrebbe solo analizzare il NOSTRO audio, qui in pausa.
    if (active.library_id) {
      loadEnvelopeFor(`/api/library/${active.library_id}/audio`);
    } else if (active.stream_token) {
      loadEnvelopeFor(`/api/media/${active.stream_token}`);
    } else if (active.stream_url) {
      // brani JARVIS / daily mix: nessuno dei due campi, ma l'URL dello
      // stream basta a chiedere l'envelope (…/audio → …/envelope) e la
      // soundbar del device in mirror smette di andare a vuoto
      loadEnvelopeFor(active.stream_url);
    } else {
      currentEnvelope = null;
      currentEnvelopeSrc = "";
    }
    if (active.cover_url) {
      const thumb = mediaAuthUrl(active.cover_url, { bust: false });
      // l'altro device manda solo il thumbnail nell'heartbeat — se conosciamo
      // il library_id possiamo chiedere noi l'HD (stesso endpoint di sempre)
      const hd = active.library_id
        ? mediaAuthUrl(`/api/library/${active.library_id}/cover/hd`, { bust: false })
        : thumb;
      setCover(thumb, hd);
    }
    setLikeUi(!!active.library_id);
    syncNowPlayingSheetMeta();
    setPlayerEnabled(true); // play = take over
    // assicura che la mini bar sia visibile (stesso chrome del player locale)
    if (playerBar) playerBar.classList.add("has-track");
  }

  let pos = Number(active.position_sec) || 0;
  let dur =
    Number(active.duration_sec) ||
    parseDurationToSec(active.duration) ||
    0;
  const playing = !!active.is_playing;

  // Evita gli scatti indietro da jitter (la posizione che arriva è una stima
  // del server, e l'heartbeat è ogni 5s), ma solo quelli PICCOLI: oltre la
  // soglia è un seek vero dell'altro device — o la ripartenza di un brano — e
  // ignorarlo lasciava le due barre sfasate per sempre, perché il nostro
  // ticker continuava ad avanzare mentre ogni correzione veniva scartata
  // (Vitto, 2026-08-12: "la barra sembra sfasata tra i due device").
  const back = _lastMirrorPos - pos;
  if (_lastMirrorPos >= 0 && playing && back > 1.25 && back < 3.5) {
    pos = _lastMirrorPos;
  }
  _lastMirrorPos = pos;
  _mirrorBasePos = pos;
  _mirrorDur = dur;
  _mirrorPlaying = playing;
  _mirrorServerAt = performance.now();
  applySeekBar(pos, dur, playing);
  if (playing) startMirrorTicker();
  else stopMirrorTicker();

  setStatus(
    playing
      ? "In riproduzione · altro device"
      : "In pausa · altro device"
  );
}

async function takeOverFromMirror() {
  // utente preme play su device mirror → diventa active e riprende
  if (!remoteMirror) return false;
  const libId = nowPlaying.libraryId;
  const token = nowPlaying.token;
  const stream = _mirrorStreamUrl || "";
  const pos = _lastMirrorPos > 0 ? _lastMirrorPos : getCurrentPlaybackPosition();
  const title = nowPlaying.title || "";
  const artist = nowPlaying.artist || "";
  // Niente da suonare: restiamo dov'eravamo. Prima il mirror veniva spento
  // qui in cima e poi la funzione poteva uscire con `false` senza aver
  // caricato niente: il player mostrava il brano giusto fermo, si dichiarava
  // device attivo, e il tap successivo su ▶ ripartiva col vecchio audio.src
  // — cioè col brano di prima (Vitto, 2026-08-12).
  if (!libId && !token && !stream && !_sharedQueue) {
    toast("Non riesco a riprendere questo brano da qui");
    return false;
  }
  remoteMirror = false;
  stopMirrorTicker();
  _lastMirrorPos = -1;
  _mirrorMetaKey = "";
  // se il device che stava suonando ci ha passato la sua coda, riprendiamo
  // da lì: stesso brano, stesso punto, ma con dietro tutta la fila invece
  // del solo brano corrente
  const adopted = adoptSharedQueue({ libraryId: libId, token, title });
  if (adopted) {
    adopted.resumeAt = pos;
    await playQueueItem(adopted);
    return true;
  }
  if (libId) {
    const item = {
      source: "library",
      id: libId,
      title,
      artist,
      duration: "",
      cover_url: _lastCoverThumb,
      cover_hd_url: _lastCoverHd || _lastCoverThumb,
      stream_url: mediaAuthUrl(`/api/library/${libId}/audio`, { bust: false }),
      resumeAt: pos,
    };
    queue.items = [item];
    queue.index = 0;
    updateQueueUi();
    await playQueueItem(item);
    return true;
  }
  if (token || stream) {
    nowPlaying = {
      token: token || null,
      libraryId: null,
      title,
      artist,
      saved: false,
    };
    // stream: URL del device che suonava, rifirmato col nostro token — è la
    // sola strada per i brani JARVIS / daily mix, che non hanno né
    // library_id né media token (vedi currentStreamPath)
    const streamUrl = token ? apiUrl(`/api/media/${token}`) : retokenUrl(stream);
    const fullSrc = streamUrl + (streamUrl.includes("?") ? "&" : "?") + "_=" + Date.now();
    audio.src = fullSrc;
    loadEnvelopeFor(fullSrc);
    setPlayerEnabled(true);
    if (pos > 0.25) await seekWhenReady(pos);
    await playWithRetry(fullSrc);
    claimThisPlayer();
    setConnectIconState(true);
    return true;
  }
  // arrivati qui non c'era davvero nulla di riproducibile: torniamo al
  // mirror invece di restare in un limbo "sono io ma non suono niente"
  remoteMirror = true;
  if (_sync.state) applySyncState(_sync.state);
  toast("Non riesco a riprendere questo brano da qui");
  return false;
}

/**
 * audio.play() dopo un await (fetch di rete, seek…) può venire rigettato da
 * WebKit perché il gesture dell'utente è ormai "scaduto" — è la causa del
 * bug "premo play ma parte solo al secondo tap" sui risultati di ricerca
 * (che aspettano /api/play prima di poter suonare). Un retry quando il
 * buffer è pronto recupera i casi di solo timing, senza servire un secondo
 * tap reale.
 */
async function playWithRetry(expectedSrc) {
  try {
    await audio.play();
    return true;
  } catch (err) {
    if (audio.src !== expectedSrc) return false; // src già cambiato: non insistere
    const retried = await new Promise((resolve) => {
      const onReady = async () => {
        audio.removeEventListener("canplay", onReady);
        clearTimeout(giveUp);
        if (audio.src !== expectedSrc) return resolve(false);
        try {
          await audio.play();
          resolve(true);
        } catch (_) {
          resolve(false);
        }
      };
      audio.addEventListener("canplay", onReady, { once: true });
      const giveUp = setTimeout(() => {
        audio.removeEventListener("canplay", onReady);
        resolve(false);
      }, 4000);
    });
    if (!retried) console.warn("play retry failed", err);
    return retried;
  }
}

// —— "buffer" preview Deezer per i chart/playlist: primo tap = 30s gratis,
// zero ricerche Telegram. Solo se l'utente resta ad ascoltare fino a
// PREVIEW_TRIGGER_SEC parte la ricerca vera in background; quando è pronta
// subentra al brano reale nello stesso punto (elapsed), senza aspettare che
// la preview finisca. Chi salta subito il brano non fa mai scattare nulla. ——
const PREVIEW_TRIGGER_SEC = 20;
let previewLock = null;
let _previewWarmAudio = null;

// —— toggle "anti-ban": UNO SOLO stato condiviso (non per-account, non per
// playlist) — ogni card chart/Deezer ne mostra un controllo ma agiscono
// tutti sullo stesso valore. OFF di default: il design "play pigro" già
// riduce le ricerche al minimo, questo è un cuscinetto extra per chi lo
// vuole più prudente, non un requisito per l'uso normale. Quando è ON, il
// trigger passivo (20s di ascolto) non scatta mai — solo un'azione
// esplicita dell'utente (seek in avanti o preview finita) avvia la ricerca
// vera, vedi guardedSeek/audio "ended"/triggerPreviewResolveNow. */
const ANTI_BAN_KEY = "crackify_anti_ban";

function isAntiBanEnabled() {
  // default ON: il "play pigro" (30s preview poi ricerca vera) è il
  // comportamento standard di chart/playlist Deezer — di default protetto,
  // OFF è l'opt-out esplicito per chi vuole la ricerca vera subito al tocco
  const v = localStorage.getItem(ANTI_BAN_KEY);
  return v === null ? true : v === "1";
}

function setAntiBanEnabled(v) {
  localStorage.setItem(ANTI_BAN_KEY, v ? "1" : "0");
  document.querySelectorAll(".pl-antiban-toggle").forEach((btn) => {
    btn.classList.toggle("on", v);
  });
}

/** Elemento <audio> nascosto e muto, riusato per precaricare i byte del
 * brano vero PRIMA dello swap — a differenza di un fetch() puro, questo fa
 * sì che al momento dello swap il decoder abbia già dati pronti (meno gap
 * udibile). Silenziato ed escluso dalla media session: non deve mai essere
 * percepito come una seconda sorgente audio. */
function warmAudioEl() {
  if (!_previewWarmAudio) {
    _previewWarmAudio = new Audio();
    _previewWarmAudio.muted = true;
    _previewWarmAudio.preload = "auto";
  }
  return _previewWarmAudio;
}

function cleanupWarmAudio() {
  if (!_previewWarmAudio) return;
  try {
    _previewWarmAudio.pause();
    _previewWarmAudio.removeAttribute("src");
    _previewWarmAudio.load();
  } catch (_) {}
}

function startPreviewLock(item) {
  previewLock = { item, triggered: false, resolved: null };
  return previewLock;
}

/** Chiamata dal listener "timeupdate": se siamo in preview e si è superata
 * la soglia, innesca la ricerca vera SENZA interrompere l'ascolto in corso.
 * (previewLock esiste solo con anti-ban ON — con anti-ban OFF playQueueItem
 * salta la preview del tutto, vedi più sotto). */
function maybeTriggerPreviewResolve() {
  if (!previewLock || previewLock.triggered) return;
  if (audio.currentTime < PREVIEW_TRIGGER_SEC) return;
  triggerPreviewResolveNow();
}

/** Nucleo della ricerca vera in background, comune al trigger passivo
 * (ascolto oltre soglia) e a quello esplicito (anti-ban: seek in avanti o
 * preview finita). Cattura QUESTO lock in una variabile locale (non rilegge
 * la globale dopo l'await): se nel frattempo l'utente passa a un altro
 * brano, previewLock punta a un lock diverso (o nullo) e lock!==previewLock
 * lo rileva subito — senza, il risultato di una ricerca vecchia potrebbe
 * finire applicato al brano sbagliato. */
function triggerPreviewResolveNow() {
  if (!previewLock || previewLock.triggered) return;
  const lock = previewLock;
  lock.triggered = true;
  resolveLazyItem(lock.item)
    .then(async (res) => {
      if (previewLock !== lock) return; // utente è andato altrove nel frattempo
      // il token è appena nato: su Telegram non è stato scaricato NIENTE
      // ancora (ensure_local_file parte solo al primo /api/media/{token}).
      // Scaldalo ORA in un <audio> nascosto e muto, con la STESSA URL che lo
      // swap userà dopo (una nuova sarebbe trattata come mai vista e il
      // vantaggio del preload andrebbe perso) — aspetta "canplay" così al
      // momento dello swap il decoder ha già dati pronti, non solo i byte
      // grezzi in un buffer fetch.
      if (res.kind === "search" && res.token) {
        res._warmSrc = apiUrl(`/api/media/${res.token}`) + `?_=${Date.now()}`;
        try {
          await new Promise((resolve) => {
            const el = warmAudioEl();
            const giveUp = setTimeout(() => {
              el.removeEventListener("canplay", onReady);
              resolve();
            }, 3000); // non aspettare all'infinito se Telethon è lento
            function onReady() {
              el.removeEventListener("canplay", onReady);
              clearTimeout(giveUp);
              resolve();
            }
            el.addEventListener("canplay", onReady, { once: true });
            el.src = res._warmSrc;
            el.load();
          });
        } catch (_) {}
      }
      if (previewLock !== lock) return; // ricontrolla: l'attesa potrebbe aver fatto saltare l'utente altrove
      lock.resolved = res;
      attemptPreviewHandoff();
    })
    .catch((err) => {
      if (previewLock === lock) {
        previewLock = null;
        toast("Ricerca fallita: " + (err.message || err));
      }
    });
}

/** Passaggio dalla preview al brano vero: stesso punto esatto (elapsed),
 * senza aspettare la fine dei 30s se la ricerca è già pronta prima. */
function attemptPreviewHandoff() {
  if (!previewLock || !previewLock.resolved) return;
  const elapsed = audio.currentTime;
  const real = previewLock.resolved;
  const origItem = previewLock.item;
  previewLock = null;
  applyResolvedRealTrack(real, elapsed, origItem);
}

/** Nucleo della risoluzione "play pigro": stesso endpoint/forma usati sia
 * per il play immediato (niente preview disponibile) sia per l'handoff in
 * background — un solo posto che sa come chiamare charts.py. */
async function resolveLazyItem(item, { checkOnly = false, prefetch = false } = {}) {
  let playUrl =
    item.source === "chart"
      ? `/api/charts/${item.chartSlug}/play/${item.chartIndex}`
      : item.source === "deezer_artist"
        ? `/api/deezer/artists/${item.artistId}/play/${item.chartIndex}`
        : item.source === "deezer_album"
          ? `/api/deezer/albums/${item.artistId}/play/${item.chartIndex}`
          : item.source === "discovery_weekly"
            ? `/api/discovery-weekly/play/${item.chartIndex}`
            : item.source === "daily_mix"
              ? `/api/daily-mixes/${item.mixIndex}/play/${item.chartIndex}`
              : item.source === "radio"
                ? `/api/radio-stations/${item.stationIndex}/play/${item.chartIndex}`
                : item.source === "deezer_radio"
                  ? `/api/deezer/artists/${item.artistId}/radio/play/${item.chartIndex}`
                  : `/api/deezer/playlists/${item.playlistId}/play/${item.chartIndex}`;
  const params = [];
  if (checkOnly) params.push("check_only=true");
  if (prefetch) params.push("prefetch=true");
  if (params.length) playUrl += "?" + params.join("&");
  return await apiJson(playUrl, null, "POST");
}

/** Cuoricino "salva" su una riga brano di chart/playlist Deezer/artista/
 * album — NON ancora tua per forza (stesso "play pigro" del tocco su play,
 * vedi resolveLazyItem, ma senza toccare il player/nowPlaying: qui si vuole
 * solo risolvere+salvare, non ascoltare). Se il brano risulta già di
 * qualcuno lo adotta (stesso /adopt di "recent", zero download); altrimenti
 * lo cerca/scarica davvero su Telegram e lo salva (stesso /api/library/save
 * di search-save). Blindato contro click ripetuti mentre è in corso — stesso
 * guard "filling"/"on" di search-save, così un doppio tap a cazzo non parte
 * con due ricerche/download in parallelo sullo stesso brano. */
async function likeLazyTrack(btn, item) {
  if (btn.classList.contains("filling") || btn.classList.contains("on")) return;
  btn.disabled = true;
  startHeartFill(btn);
  try {
    const res = await resolveLazyItem(item);
    if (res.kind === "recent") {
      const ownerId = res.owner_id;
      const trackId = res.track && res.track.id;
      if (!ownerId || !trackId) throw new Error("brano non disponibile");
      const data = await apiJson(`/api/library/recent/${ownerId}/${trackId}/adopt`, null, "POST");
      toast(data.already_saved ? "Già nella tua libreria" : "Aggiunto alla tua libreria");
    } else if (res.kind === "search" && res.token) {
      await apiJson("/api/library/save", { token: res.token });
      toast("Aggiunto alla tua libreria");
    } else {
      throw new Error("brano non trovato");
    }
    endHeartFill(true, btn);
    btn.classList.add("on");
  } catch (err) {
    endHeartFill(false, btn);
    toast("Errore: " + (err.message || "salvataggio fallito"));
  } finally {
    btn.disabled = false;
  }
}

/** Applica al player il brano vero appena risolto, mantenendo la stessa
 * posizione di ascolto della preview (LAVORO DI PRECISIONE): aspetta che la
 * durata del nuovo audio sia nota prima di riposizionare, poi riprende. */
function applyResolvedRealTrack(real, elapsed, origItem) {
  cleanupWarmAudio(); // i byte scaldati servivano solo a preparare il decoder, ora tocca all'audio vero
  let fullSrc;
  if (real.kind === "recent") {
    const t = real.track || {};
    nowPlaying = {
      token: null,
      libraryId: null,
      recentOwnerId: real.owner_id,
      recentTrackId: t.id,
      title: t.title || nowPlaying.title,
      artist: t.artist || nowPlaying.artist,
      // il backend calcola "saved" per l'utente corrente (vedi
      // _finalize_play_result in main.py) — prima era sempre false anche
      // per un brano tuo, es. "One Dance" col cuoricino vuoto dalla card
      // artista (bug segnalato da Vitto 2026-07-27)
      saved: !!t.saved,
    };
    setLikeUi(!!t.saved);
    const thumb = mediaAuthUrl(t.cover_url, { bust: false });
    setCover(thumb, mediaAuthUrl(t.cover_hd_url, { bust: false }) || thumb);
    fullSrc = mediaAuthUrl(t.stream_url, { bust: true });
  } else {
    nowPlaying = {
      token: real.token,
      libraryId: null,
      title: real.title || nowPlaying.title,
      artist: real.artist || nowPlaying.artist,
      saved: !!real.saved,
    };
    setLikeUi(real.saved);
    // Telegram spesso non ha una cover HD propria (bridge.play ritorna un
    // solo thumb) — quella Deezer del brano di partenza (item.cover_hd_url)
    // è già HD vera, meglio tenerla che far "scattare" la qualità in giù
    // proprio nel momento dell'innesto preview→brano vero.
    const thumb = real.cover_url || (origItem && origItem.cover_url) || null;
    const hd = (origItem && origItem.cover_hd_url) || real.cover_url || thumb;
    setCover(thumb, hd);
    // riusa la URL già "scaldata" da maybeTriggerPreviewResolve (stessi
    // byte già in corso di scaricamento/cache) — una nuova con un altro
    // cache-bust vanificherebbe il preload
    const sUrl = apiUrl(real.stream_url || "");
    fullSrc = real._warmSrc || sUrl + (sUrl.includes("?") ? "&" : "?") + "_=" + Date.now();
  }
  nowTitle.textContent = nowPlaying.title;
  nowArtist.textContent = nowPlaying.artist || "—";
  syncNowPlayingSheetMeta();
  const onReady = () => {
    audio.removeEventListener("loadedmetadata", onReady);
    try {
      const dur = Number.isFinite(audio.duration) ? audio.duration : elapsed + 1;
      audio.currentTime = Math.max(0, Math.min(elapsed, dur - 0.3));
    } catch (_) {}
    audio.play().catch(() => {});
  };
  audio.addEventListener("loadedmetadata", onReady, { once: true });
  audio.src = fullSrc;
  loadEnvelopeFor(fullSrc);
  setStatus("In riproduzione — brano completo");
  updateMediaSessionMetadata();
  setupMediaSessionActions();
}

/** Blocca lo scarto in avanti finché la ricerca vera non è partita (evita
 * di "barare" saltando dritti oltre PREVIEW_TRIGGER_SEC): indietro è sempre
 * permesso, non ha senso impedirlo. Ritorna true se il seek è stato fatto. */
function guardedSeek(newTime) {
  if (previewLock && !previewLock.triggered && newTime > audio.currentTime + 0.5) {
    const remain = Math.max(1, Math.ceil(PREVIEW_TRIGGER_SEC - audio.currentTime));
    toast(`Aspetta ${remain}s per sbloccare l'anteprima`, { duration: 2200 });
    return false;
  }
  audio.currentTime = newTime;
  return true;
}

/** Riempimento orizzontale (stile onda del cuore, ma lineare) sulle righe
 * #trackList/#libList mentre il brano cliccato è ancora in resolve/rete,
 * PRIMA che .playing scatti per davvero — richiesta di Vitto, 2026-08-04:
 * feedback per il buco morto tra tap e riproduzione vera, senza aggiungere
 * NESSUN ritardo reale (pura sovrapposizione visiva, vedi .track.resolving
 * in style.css — animazione "a rallentare" che non tocca mai il 100% da
 * sola, completata solo quando arriva .playing). item = l'oggetto ORIGINALE
 * cliccato (source/index o source/id) — playQueueItem lo riassegna a metà
 * strada per i brani chart/lazy, qui serve l'identità di partenza. */
/** Un solo matcher riga↔item per tutte le liste che possono innescare un
 * play (ricerca, salvati, playlist proprie/offline/di altri, artista/album,
 * chart/Deezer/Discovery Weekly/Daily Mix/radio) — usato sia per il
 * riempimento "resolving" sia per l'evidenziazione "playing" ad arrivo
 * confermato, così le due cose restano sempre in sincronia. Richiesta di
 * Vitto, 2026-08-04: "aggiungiamolo anche alle playlist e pagine artista".
 * dataset.index/dataset.id vanno impostati alla creazione di ogni riga,
 * vedi i vari punti che popolano #plTracks/#artistTracks. */
function trackRowMatchesItem(el, item) {
  if (item.source === "search" && Number(el.dataset.index) === item.index) return true;
  if ((item.source === "library" || item.source === "recent") && el.dataset.id === item.id) return true;
  if (
    (item.source === "chart" ||
      item.source === "deezer_playlist" ||
      item.source === "deezer_artist" ||
      item.source === "deezer_album" ||
      item.source === "discovery_weekly" ||
      item.source === "daily_mix" ||
      item.source === "radio" ||
      // stessa dimenticanza di playQueueItem (Vitto 2026-08-08): senza
      // "deezer_radio" le righe di Musica simile non si riempivano mai di
      // "resolving" e non si evidenziavano da "playing"
      item.source === "deezer_radio") &&
    Number(el.dataset.index) === item.chartIndex
  ) {
    return true;
  }
  return false;
}

// #artistTracksModalList: la finestra "tutti i brani" della pagina artista —
// mancava, quindi le sue righe non si riempivano mai di "resolving" e non si
// evidenziavano da "playing" (Vitto 2026-08-10)
const TRACK_ROW_LISTS_SELECTOR =
  "#trackList .track, #libList .track, #plTracks .track, #artistTracks .track, #artistTracksModalList .track";

function setTrackRowResolving(item, on) {
  document.querySelectorAll(TRACK_ROW_LISTS_SELECTOR).forEach((el) => {
    if (trackRowMatchesItem(el, item)) el.classList.toggle("resolving", on);
  });
}

async function playQueueItem(item) {
  // debug temporaneo — vedi Vitto 2026-07-31, conferma se questa funzione
  // viene raggiunta per il primo brano di un gruppo JARVIS
  debugLog("play-queue-item-start", { source: item && item.source, title: item && item.title, chartIndex: item && item.chartIndex, mixIndex: item && item.mixIndex });
  // identità ORIGINALE (prima che item venga riassegnato più sotto per i
  // brani chart/lazy) — vedi setTrackRowResolving
  const _clickedItem = item;
  // indice di coda che QUESTA chiamata sta risolvendo — se fallisce e non
  // c'è uno skip al prossimo brano (che ne imposterebbe già uno nuovo),
  // serve per sapere se toccare ancora a noi ripulire _queueResolvingIndex
  // nel finally, senza cancellare per sbaglio uno stato più recente
  const _myQueueIndex = queue.index;
  setTrackRowResolving(_clickedItem, true);
  _pendingRestoredTrack = null;
  saveLastTrack(item);
  playBusy = true;
  updateNavButtons();
  setPlayerEnabled(false);
  previewLock = null; // qualunque preview in corso per il brano precedente non conta più
  cleanupWarmAudio(); // interrompe un eventuale precaricamento abbandonato
  if (iconPlay && iconPause) {
    iconPlay.classList.add("hidden");
    iconPause.classList.add("hidden");
  }
  nowTitle.textContent = item.title || "…";
  nowArtist.textContent = item.artist || "Caricamento…";
  // thumb per mini; HD se c’è (search iTunes / library cover_hd)
  setCover(item.cover_url || null, item.cover_hd_url || item.cover_url || null);
  setLikeUi(false);
  syncNowPlayingSheetMeta();
  setStatus(`Preparo “${item.title}”…`);

  try {
    let isPreview = false;
    // "deezer_radio" (Musica simile) mancava da questo elenco: i suoi brani
    // finivano nel ramo "search" più sotto, dove senza search_id lanciano
    // "search scaduta — cerca di nuovo" e la coda scorre tutta a vuoto
    // (segnalato da Vitto 2026-08-08). resolveLazyItem lo gestiva già, con
    // /api/deezer/artists/{artistId}/radio/play/{index}: mancava solo qui.
    if (item.source === "chart" || item.source === "deezer_playlist" || item.source === "deezer_artist" || item.source === "deezer_album" || item.source === "discovery_weekly" || item.source === "daily_mix" || item.source === "radio" || item.source === "deezer_radio") {
      let knownNow = null;
      if (item.previewUrl && isAntiBanEnabled()) {
        // anche con anti-ban ON: se il brano è già noto (posseduto da
        // qualcuno, anche solo come riferimento evicted) recuperarlo per
        // davvero costa zero in più — non ha senso accontentarsi della
        // preview 30s in quel caso. Un solo controllo locale (mai una
        // ricerca vera, vedi check_only in charts.py), poi si decide.
        try {
          const check = await resolveLazyItem(item, { checkOnly: true });
          if (check && check.kind !== "unknown") knownNow = check;
        } catch (_) {
          // controllo fallito: si comporta come "sconosciuto", preview normale
        }
      }
      if (item.previewUrl && isAntiBanEnabled() && !knownNow) {
        // anti-ban ON (default): "buffer" gratuito, 30s da Deezer, niente
        // Telegram finché non si supera la soglia di ascolto — vedi
        // maybeTriggerPreviewResolve (agganciato al timeupdate) e
        // attemptPreviewHandoff. Con anti-ban OFF si salta dritti al ramo
        // sotto: ricerca vera subito al tocco, come una ricerca normale.
        isPreview = true;
        startPreviewLock(item);
        nowPlaying = {
          token: null,
          libraryId: null,
          title: item.title,
          artist: item.artist || "",
          saved: false,
        };
        setStatus("Anteprima Deezer — carico il brano completo…");
        audio.src = item.previewUrl;
        // preview diretta dalla CDN Deezer: nessun envelope nostro per
        // quell'URL, evita di mostrare ancora i bassi del brano precedente
        currentEnvelope = null;
        currentEnvelopeSrc = "";
        setPlayerEnabled(true);
        resetTimeline(null);
        const played = await playWithRetry(item.previewUrl);
        setStatus(played ? "Anteprima (30s)" : "Tocca ▶ per avviare");
        claimThisPlayer();
        setConnectIconState(true);
      } else {
        // "play pigro" senza preview disponibile (o già noto, vedi sopra):
        // risolvi SUBITO chi possiede già il brano o se serve una ricerca
        // vera — vedi charts.py resolve_*_track. Poi l'item diventa a tutti
        // gli effetti un item "recent" o "search" normale.
        // debug temporaneo — vedi Vitto 2026-07-31, conferma se questo
        // punto viene raggiunto per il primo brano di un gruppo JARVIS
        debugLog("resolve-lazy-item-start", { source: item.source, chartIndex: item.chartIndex, mixIndex: item.mixIndex, artist: item.artist, title: item.title });
        const res = knownNow || (await resolveLazyItem(item));
        if (res.kind === "recent") {
          const t = res.track || {};
          item = {
            ...item,
            source: "recent",
            id: t.id,
            ownerId: res.owner_id,
            stream_url: t.stream_url,
            cover_url: t.cover_url || item.cover_url,
            cover_hd_url: t.cover_hd_url || item.cover_hd_url,
            title: t.title || item.title,
            artist: t.artist || item.artist,
            duration: t.duration || item.duration,
            // il backend calcola "saved" per l'utente corrente (vedi
            // _finalize_play_result in main.py) — prima mancava qui, quindi
            // sotto "isMine" era sempre false anche per un brano tuo
            saved: !!t.saved,
            // ...e con "saved" arriva l'id della copia NOSTRA (t.id invece è
            // dell'altro utente): senza, il cuore restava pieno ma senza
            // niente da rimuovere (Vitto 2026-09-16, "Janice STFU")
            libraryId: t.library_id || null,
          };
        } else {
          item = {
            ...item,
            source: "search",
            token: res.token,
            stream_url: res.stream_url,
            tg_cover_url: res.cover_url || null,
            saved: !!res.saved,
            libraryId: res.library_id || null,
            title: res.title || item.title,
            artist: res.artist || item.artist,
          };
        }
      }
    }
    if (isPreview) {
      // niente altro da fare qui: audio già in play, il resto (evidenzia
      // liste, media session) gira comunque più sotto
    } else if (item.source === "library" || item.source === "recent") {
      const isMine = item.source === "library";
      // "recent" può comunque essere tuo (find_across_users lo trova anche
      // nella tua libreria): saved riflette quello, non solo la provenienza
      // "library" diretta — altrimenti il cuoricino risulta sempre vuoto
      // per un brano tuo riprodotto da un'altra pagina (bug: "One Dance")
      const saved = isMine || !!item.saved;
      // id della nostra copia: diretto se la riga viene dalla libreria,
      // altrimenti quello che il backend ci ha detto (item.libraryId). Con
      // questo il cuore può rimuovere anche un brano nostro riprodotto da
      // una superficie pigra, invece di restare pieno e inerte.
      const mineId = isMine ? item.id : item.libraryId || null;
      nowPlaying = {
        token: null,
        libraryId: mineId,
        // brano di un altro utente non ancora salvato: il tap sul cuore
        // deve "adottarlo" (copiarlo), non provare a rimuoverlo/risalvarlo
        recentOwnerId: mineId ? null : item.ownerId,
        recentTrackId: mineId ? null : item.id,
        title: item.title,
        artist: item.artist,
        saved,
      };
      setLikeUi(saved);
      // copertina offline se scaricata (playlist offline / rete assente),
      // altrimenti quella di rete come sempre
      const offlineCover = await getOfflineTrackCoverSrc(item.id);
      // /api/library/... richiede il token anche in query (niente header
      // custom possibile su un <img src>, vedi mediaAuthUrl) — senza,
      // il browser lo chiede senza auth e si becca un 401 (brano "recent"
      // di un altro utente, o proprio, ripreso da evicted: mancava qui,
      // l'audio la usava già giustamente).
      setCover(
        offlineCover || mediaAuthUrl(item.cover_url, { bust: false }) || null,
        offlineCover ||
          mediaAuthUrl(item.cover_hd_url, { bust: false }) ||
          mediaAuthUrl(item.cover_url, { bust: false }) ||
          null
      );
      // copia offline (playlist scaricata) se c'è: suona dal device, non
      // serve rete verso il Mac; altrimenti stream come sempre
      const offlineSrc = await getOfflineTrackSrc(item.id);
      // t= è il token auth (non timestamp!); cache-bust con _=
      audio.src = offlineSrc || mediaAuthUrl(item.stream_url, { bust: true });
      // l'envelope lo chiediamo sempre allo stream_url "vero" (il server ce
      // l'ha comunque, anche quando suoniamo dalla copia offline in locale)
      loadEnvelopeFor(item.stream_url);
      setPlayerEnabled(true);
      resetTimeline(item.duration);
      // handoff remote: riprendi dalla stessa posizione
      if (item.resumeAt > 0.25) await seekWhenReady(item.resumeAt);
      await audio.play().catch((err) => {
        console.warn("library play failed", err);
        setStatus("Audio non disponibile — riprova o ri-salva");
        // setStatus aggiorna un elemento della barra player normale,
        // invisibile mentre lo sheet di JARVIS copre tutto lo schermo —
        // senza questo, un autoplay bloccato dal browser sembrava che
        // l'app non avesse fatto proprio nulla (segnalato da Vitto,
        // "la prima canzone non è partita")
        if (jarvisSessionActive) toast("Tocca play per far partire il brano");
      });
      // a volte serve un secondo seek dopo play (Safari)
      if (item.resumeAt > 0.25) {
        try {
          if (Math.abs((audio.currentTime || 0) - item.resumeAt) > 1.5) {
            await seekWhenReady(item.resumeAt);
          }
        } catch (_) {}
      }
      if (audio.src) setStatus(isMine ? "In riproduzione · salvati" : "In riproduzione");
      // claim SEMPRE: gli altri device devono vedere la mini bar anche se iOS ha bloccato autoplay
      claimThisPlayer();
      setConnectIconState(true);
    } else {
      // search → fetch da Telegram, a meno che non sia già stato prefetchato
      // al momento dello swipe-in-coda (vedi prefetchSearchQueueItem)
      let data;
      if (item.token && item.stream_url) {
        data = {
          token: item.token,
          stream_url: item.stream_url,
          cover_url: item.tg_cover_url || null,
          saved: !!item.saved,
          library_id: item.libraryId || null,
        };
      } else {
        if (!item.search_id) throw new Error("search scaduta — cerca di nuovo");
        data = await apiJson("/api/play", {
          search_id: item.search_id,
          index: item.index,
        });
      }
      nowPlaying = {
        token: data.token,
        libraryId: data.library_id || null,
        title: data.title || item.title,
        artist: data.artist || item.artist || "",
        saved: !!data.saved,
      };
      nowTitle.textContent = nowPlaying.title;
      nowArtist.textContent = nowPlaying.artist || "—";
      // mini: TG se c’è, altrimenti iTunes; full: iTunes HD se c’è
      const thumb = data.cover_url || item.cover_url || null;
      const hd = item.cover_url || data.cover_url || null; // search cover_url = iTunes
      setCover(thumb, hd);
      setLikeUi(data.saved);
      syncNowPlayingSheetMeta();
      // stream Telegram: cache-bust con _= (non t=) — apiUrl() perché nell'app
      // nativa /api/media/... è relativo e punterebbe al WebView, non al Mac
      const sUrl = apiUrl(data.stream_url || "");
      const fullSrc =
        sUrl + (sUrl.includes("?") ? "&" : "?") + "_=" + Date.now();
      audio.src = fullSrc;
      // brano che possediamo già (riprodotto da chart/artista/mix): l'envelope
      // del file locale è precalcolato e in cache, quello dello stream TG
      // risponde 404 finché il download non è completo — e senza envelope
      // soundbar ed equalizzatore a cornice restano sul respiro di riserva,
      // che sembra "animazione che va per conto suo" (Vitto, 2026-09-16)
      loadEnvelopeFor(
        data.library_id ? `/api/library/${data.library_id}/audio` : data.stream_url
      );
      setPlayerEnabled(true);
      resetTimeline(item.duration);
      const played = await playWithRetry(fullSrc);
      setStatus(played ? "In riproduzione" : "Tocca ▶ per avviare");
      // debug temporaneo — vedi Vitto 2026-08-06, "trova la canzone giusta
      // ma non carica" (caso "Artie 5ive"): played=true con audio.paused
      // ancora true (o readyState basso) punterebbe a un problema diverso
      // dall'autoplay bloccato classico (quello dà played=false, già gestito
      // sotto col toast) — es. sorgente che non parte per davvero pur
      // "risolta" con successo lato JS.
      debugLog("jarvis-search-play-outcome", {
        jarvisSessionActive,
        title: item.title,
        artist: item.artist,
        played,
        audioPaused: audio.paused,
        audioReadyState: audio.readyState,
        audioErrorCode: audio.error && audio.error.code,
        audioCurrentTime: audio.currentTime,
      });
      // stesso motivo del ramo library sopra: invisibile dietro lo sheet
      // di JARVIS, altrimenti un autoplay bloccato sembra un'app rotta
      if (!played && jarvisSessionActive) toast("Tocca play per far partire il brano");
      claimThisPlayer();
      setConnectIconState(true);
    }
    // confermato per davvero: la riga in coda passa da "resolving" a
    // "playing" solo qui, mai al semplice cambio di queue.index (vedi
    // playQueueIndex/appendQueueRow)
    if (_queueResolvingIndex === queue.index) _queueResolvingIndex = -1;
    // highlight liste — _clickedItem, non item: per i brani chart/deezer/
    // artista/lazy "item" qui sopra è già stato riassegnato a source:
    // "search" durante il resolve, perderebbe l'identità con cui la riga
    // originale (in #plTracks/#artistTracks) era stata marcata
    document.querySelectorAll(TRACK_ROW_LISTS_SELECTOR).forEach((el) => {
      el.classList.toggle("playing", trackRowMatchesItem(el, _clickedItem));
    });
    updateMediaSessionMetadata();
    // iOS/WebKit resetta gli actionHandler della media session quando
    // audio.src cambia — vanno riregistrati ad ogni nuovo brano.
    setupMediaSessionActions();
  } catch (err) {
    setStatus("Play: " + err.message);
    // debug temporaneo — vedi Vitto 2026-07-31, "la prima canzone di
    // JARVIS non viene riprodotta"; esteso 2026-08-06 con l'indice calcolato
    // per lo skip (caso "Artie 5ive": vogliamo sapere se lo skip parte
    // davvero e verso quale indice, non solo che l'errore è avvenuto)
    const _niDebug = nextIndex();
    debugLog("play-queue-item-error", {
      source: item && item.source,
      message: err && err.message,
      stack: err && err.stack,
      queueIndex: queue.index,
      nextIndexComputed: _niDebug,
      queueLength: queue.items.length,
      jarvisSessionActive,
      jarvisTransitionBusy,
    });
    if (iconPlay) iconPlay.classList.remove("hidden");
    if (iconPause) iconPause.classList.add("hidden");
    const ni = _niDebug;
    if (ni >= 0 && ni !== queue.index) {
      toast("Skip — errore sul brano");
      playBusy = false;
      playQueueIndex(ni);
      return;
    }
  } finally {
    setTrackRowResolving(_clickedItem, false);
    // rete di sicurezza: errore senza skip al prossimo brano (nessun altro
    // in coda) lasciava la riga bloccata su "resolving" per sempre — pulisce
    // solo se nel frattempo nessuno l'ha già spostato su un indice più nuovo
    if (_queueResolvingIndex === _myQueueIndex) _queueResolvingIndex = -1;
    playBusy = false;
    updateNavButtons();
    if (!viewQueue.classList.contains("hidden") || queueSheetOpen) renderQueueList();
  }
}

function resetTimeline(durationLabel) {
  seek.value = 0;
  seekFill.style.width = "0%";
  seekBuf.style.width = "0%";
  timeCur.textContent = "0:00";
  if (durationLabel) timeDur.textContent = durationLabel;
}

function nextIndex() {
  const n = queue.items.length;
  if (n === 0 || queue.index < 0) return -1;

  if (repeatMode === 2) {
    return queue.index; // same track
  }

  // Sempre priorità: brani "In coda" dell'utente subito dopo current
  if (queue.index + 1 < n && queue.items[queue.index + 1].userQueued) {
    return queue.index + 1;
  }

  if (shuffleOn && n > 1) {
    if (!shuffleOrder.length || shuffleOrder.length !== n) rebuildShuffleOrder();
    const pos = shuffleOrder.indexOf(queue.index);
    if (pos >= 0 && pos < shuffleOrder.length - 1) {
      return shuffleOrder[pos + 1];
    }
    // fine ordine shuffle
    if (repeatMode === 1) {
      rebuildShuffleOrder();
      // evita stesso pezzo subito se possibile
      if (shuffleOrder[0] === queue.index && n > 1) {
        const j = 1 + Math.floor(Math.random() * (n - 1));
        [shuffleOrder[0], shuffleOrder[j]] = [shuffleOrder[j], shuffleOrder[0]];
      }
      return shuffleOrder[0];
    }
    return -1;
  }

  if (queue.index < n - 1) return queue.index + 1;
  if (repeatMode === 1) return 0; // loop tutta la coda
  return -1;
}

function prevIndex() {
  const n = queue.items.length;
  if (n === 0 || queue.index < 0) return -1;

  if (shuffleOn && n > 1) {
    if (!shuffleOrder.length || shuffleOrder.length !== n) rebuildShuffleOrder();
    const pos = shuffleOrder.indexOf(queue.index);
    if (pos > 0) return shuffleOrder[pos - 1];
    if (repeatMode === 1) return shuffleOrder[shuffleOrder.length - 1];
    return -1;
  }

  if (queue.index > 0) return queue.index - 1;
  if (repeatMode === 1) return n - 1;
  return -1;
}

function playNext() {
  if (repeatMode === 2) {
    audio.currentTime = 0;
    audio.play().catch(() => {});
    return;
  }
  jarvisHandleTrackLeft(true);
  const ni = nextIndex();
  if (ni >= 0) playQueueIndex(ni);
}

function playPrev() {
  // oltre 3s → restart (stile Spotify)
  if (audio.currentTime > 3) {
    audio.currentTime = 0;
    return;
  }
  const pi = prevIndex();
  if (pi >= 0) playQueueIndex(pi);
  else {
    audio.currentTime = 0;
  }
}

/** Libera la cache lato server di un brano da ricerca (token, non libreria)
 * appena finito di ascoltare — fire-and-forget, nessun bisogno di attendere. */
function releasePlayedMedia(token) {
  if (!token) return;
  fetch(apiUrl(`/api/media/${token}`), {
    method: "DELETE",
    headers: authHeaders(),
    keepalive: true,
  }).catch(() => {});
}

// —— audio events ——
audio.volume = 0.8;
updateVolUi();
setPlayerEnabled(false);
updateQueueUi();

// play/pause vanno agli altri device subito, non al prossimo battito: è la
// differenza tra "la barra sull'altro schermo si ferma quando premi" e "si
// ferma qualche secondo dopo"
audio.addEventListener("play", () => {
  setPlayingUi(true);
  syncPushNow();
});
audio.addEventListener("pause", () => {
  setPlayingUi(false);
  syncPushNow();
});
audio.addEventListener("ended", () => {
  setPlayingUi(false);
  seek.value = 0;
  seekFill.style.width = "0%";
  if (repeatMode === 2) {
    audio.currentTime = 0;
    audio.play().catch(() => {});
    return;
  }
  // rete di sicurezza: preview più corta di PREVIEW_TRIGGER_SEC (capita per
  // brani molto brevi) — il trigger passivo non ha ancora avuto modo di
  // scattare ma la preview è comunque finita, niente da guadagnare aspettando
  if (previewLock && !previewLock.triggered) {
    setStatus("Anteprima finita — cerco il brano completo…");
    triggerPreviewResolveNow();
    return;
  }
  // preview Deezer finita ma la ricerca vera non è ancora pronta: NON
  // passare al prossimo brano, aspetta l'handoff (parte da solo appena
  // resolveLazyItem torna, vedi maybeTriggerPreviewResolve/attemptPreviewHandoff)
  if (previewLock && previewLock.triggered && !previewLock.resolved) {
    setStatus("Ancora un attimo, sto cercando il brano completo…");
    return;
  }
  // brano da ricerca appena finito (non in repeat-one): libera subito la
  // cache lato server — non è salvato in libreria, non ha senso tenerlo su
  // disco oltre l'ascolto (il TTL lo pulirebbe comunque dopo un'ora)
  releasePlayedMedia(nowPlaying.token);
  jarvisHandleTrackLeft(false);
  const ni = nextIndex();
  if (ni >= 0) playQueueIndex(ni);
});
audio.addEventListener("timeupdate", () => {
  if (remoteMirror) return; // barra guidata dal server
  maybeTriggerPreviewResolve();
  updateSeekUi();
  updateKaraokeLyrics(false);
  if (npLyricsPanel && !npLyricsPanel.hasAttribute("hidden")) syncLyDock();
});
audio.addEventListener("seeked", () => {
  updateKaraokeLyrics(true);
  syncLyDock();
});
audio.addEventListener("play", () => syncLyDock());
audio.addEventListener("pause", () => syncLyDock());
audio.addEventListener("loadedmetadata", () => {
  updateSeekUi();
  // durata nota → push allo stato shared per la mini bar mirror
  if (!remoteMirror && connectThisIsActive) {
    pushPlayerState().catch(() => {});
  }
  // se karaoke era stimato senza durata, ricalcola quando arriva
  if (
    lyricsIsKaraoke &&
    lyricsEstimated &&
    npLyricsPanel &&
    !npLyricsPanel.hasAttribute("hidden") &&
    Number.isFinite(audio.duration) &&
    audio.duration > 15
  ) {
    const key = lyricsKeyCurrent;
    const data = lyricsCache.get(key);
    if (data && data.lyrics && !parseLrc(data.synced_lyrics || "").length) {
      const est = buildEstimatedSync(data.lyrics, audio.duration);
      if (est.length >= 2) mountKaraokeLines(est, { estimated: true });
    }
  }
});
audio.addEventListener("progress", updateSeekUi);
audio.addEventListener("durationchange", () => {
  updateSeekUi();
  if (!remoteMirror && connectThisIsActive) {
    pushPlayerState().catch(() => {});
  }
});
audio.addEventListener("volumechange", updateVolUi);

async function togglePlayPause() {
  // mirror: play = prendi il controllo e continua da qui
  if (remoteMirror) {
    const ok = await takeOverFromMirror();
    if (!ok) toast("Niente da riprendere");
    return;
  }
  // brano ripristinato al boot (solo titolo/cover, niente audio caricato
  // ancora): il primo tap lo risolve e lo fa partire per davvero
  if (!audio.src && _pendingRestoredTrack) {
    const item = _pendingRestoredTrack;
    _pendingRestoredTrack = null;
    await playQueueItem(item);
    return;
  }
  if (!audio.src) return;
  if (audio.paused) {
    try {
      await audio.play();
      claimThisPlayer();
      setConnectIconState(true);
    } catch (_) {
      // autoplay bloccato: claim comunque per sync meta
      claimThisPlayer();
    }
  } else {
    audio.pause();
    // aggiorna stato pausa per gli altri
    if (authState.authenticated) {
      pushPlayerState().catch(() => {});
    }
  }
}

btnPlay.addEventListener("click", (e) => {
  e.stopPropagation();
  togglePlayPause();
});

btnNext.addEventListener("click", (e) => {
  e.stopPropagation();
  playNext();
});
btnPrev.addEventListener("click", (e) => {
  e.stopPropagation();
  playPrev();
});
btnClearQueue.addEventListener("click", () => clearQueue());

/** Condivisa dal transport bar (btnShuffle) e dai bottoni shuffle nell'header
 * di playlist/libreria (btnPlShuffle/btnLibShuffle) — questi ultimi possono
 * essere toccati anche a coda vuota (si sta scegliendo la modalità PRIMA di
 * premere play), quindi qui non c'è il guard su queue.items.length che ha
 * btnShuffle: rebuildShuffleOrder ha già il suo n<=0 → shuffleOrder=[]. */
function toggleShuffle() {
  shuffleOn = !shuffleOn;
  if (shuffleOn) rebuildShuffleOrder();
  else shuffleOrder = [];
  updateShuffleRepeatUi();
  updateNavButtons();
  toast(shuffleOn ? "Shuffle on" : "Shuffle off");
}

btnShuffle.addEventListener("click", (e) => {
  e.stopPropagation();
  if (queue.items.length < 2) return;
  toggleShuffle();
});
if (btnLibShuffle) btnLibShuffle.addEventListener("click", () => toggleShuffle());
if (btnPlShuffle) btnPlShuffle.addEventListener("click", () => toggleShuffle());
if (btnArtistShuffle) btnArtistShuffle.addEventListener("click", () => toggleShuffle());
// stesso comportamento di btnPlPlay: con lo shuffle acceso parte da un brano
// a caso, altrimenti dal primo
if (btnArtistPlay) {
  btnArtistPlay.addEventListener("click", () => {
    if (!_artistTracks.length) return;
    playArtistFrom(shuffleStartIndex(_artistTracks.length));
  });
}

btnRepeat.addEventListener("click", (e) => {
  e.stopPropagation();
  // 0 → 1 → 2 → 0
  repeatMode = (repeatMode + 1) % 3;
  updateShuffleRepeatUi();
  updateNavButtons();
  const msg = ["Loop off", "Loop coda", "Loop brano"];
  toast(msg[repeatMode]);
});

updateShuffleRepeatUi();

// —— Coda: bottom sheet ——————————————————————————————————————————————
if (queueSheetBackdrop) queueSheetBackdrop.addEventListener("click", closeQueueSheet);
if (qsClear) qsClear.addEventListener("click", () => clearQueue());
// riusano il toggle vero (shuffleOn/repeatMode + toast già cablati su
// btnShuffle/btnRepeat) invece di duplicare la logica — updateShuffleRepeatUi
// tiene sincronizzato anche lo stato visivo di questi due
if (qsShuffle) qsShuffle.addEventListener("click", () => btnShuffle.click());
if (qsRepeat) qsRepeat.addEventListener("click", () => btnRepeat.click());

/** Sposta lo sheet tra "spawn" (altezza di apertura, default) e "max"
 * (quasi a schermo intero, vedi .queue-sheet.max in style.css) — sola
 * classe sul contenitore, l'altezza del pannello fa il resto via
 * transizione CSS. */
function setQueueSheetMax(on) {
  queueSheetMax = !!on;
  if (queueSheet) queueSheet.classList.toggle("max", queueSheetMax);
}

/** Swipe su/giù su tutto il pannello (non solo la maniglia — troppo
 * piccola per essere un bersaglio affidabile, Vitto 2026-08-03: "la
 * maniglia non swipa" poi "fai che è uno swipe sulla schermata non sulla
 * maniglia"), ESCLUSA la lista sotto (ha già scroll + drag-to-reorder,
 * enableQueueDrag) e i bottoni — un tap che parte lì deve restare un tap,
 * non essere rubato dal riconoscimento dello swipe.
 * Tre stati, un salto alla volta per gesto (richiesta di Vitto, 2026-08-03,
 * "animazioni sequenziali max-spawn-giù, per passare da max a giù devi fare
 * max spawn giù"): swipe su da spawn → max (da max, no-op, sei già in
 * cima); swipe giù da max → torna a spawn; swipe giù da spawn → chiude
 * davvero. Mai max→chiuso in un solo gesto.
 * Niente feedback live (transform) durante il drag: un rubber-band
 * dal vivo che poi deve tornare a 0 ESATTAMENTE mentre "height" comincia
 * la sua transizione produceva due animazioni sovrapposte, viste come un
 * piccolo rimbalzo prima dell'animazione vera (segnalato da Vitto,
 * 2026-08-04). Solo la direzione+ampiezza totale al rilascio decide lo
 * stato — l'unica animazione è quella (già scattante di suo) della
 * transizione "height" sullo stato committato. */
(function setupQueueSheetSwipe() {
  if (!queueSheet) return;
  const panel = queueSheet.querySelector(".queue-sheet-panel");
  if (!panel) return;
  const SWIPE_THRESH = 46;
  let startY = 0;
  let dy = 0;
  let dragging = false;
  let pointerId = null;
  const onDown = (e) => {
    if (e.target.closest(".queue-sheet-list-wrap") || e.target.closest("button")) return;
    dragging = true;
    dy = 0;
    startY = e.clientY;
    pointerId = e.pointerId;
    try {
      panel.setPointerCapture(e.pointerId);
    } catch (_) {}
  };
  const onMove = (e) => {
    if (!dragging || e.pointerId !== pointerId) return;
    dy = e.clientY - startY;
  };
  const onUp = (e) => {
    if (!dragging || e.pointerId !== pointerId) return;
    dragging = false;
    if (dy <= -SWIPE_THRESH) {
      if (!queueSheetMax) setQueueSheetMax(true);
    } else if (dy >= SWIPE_THRESH) {
      if (queueSheetMax) setQueueSheetMax(false);
      else closeQueueSheet();
    }
  };
  panel.addEventListener("pointerdown", onDown);
  panel.addEventListener("pointermove", onMove);
  panel.addEventListener("pointerup", onUp);
  panel.addEventListener("pointercancel", onUp);
})();

// Mini player: tap sul banner → full sheet (non sui bottoni)
const miniNow = playerBar ? playerBar.querySelector(".now") : null;
let _miniBarSwiped = false;
if (miniNow) {
  miniNow.addEventListener("click", (e) => {
    if (e.target.closest("button")) return;
    if (_miniBarSwiped) {
      _miniBarSwiped = false;
      return;
    }
    openNowPlayingSheet();
  });
  enableMiniPlayerSwipe(miniNow);
}

/** Swipe sx/dx sulla mini bar (solo touch) → prossimo/precedente, stile
 * Spotify mobile. Swipe verticale verso l'alto → apre il full screen. */
function enableMiniPlayerSwipe(el) {
  const THRESH = 60;
  const THRESH_Y = 44;
  const TAP_SLOP = 8;
  let dragging = false;
  let axis = null;
  let startX = 0;
  let startY = 0;
  let startT = 0;
  let dx = 0;
  let dy = 0;

  const setX = (x, animate) => {
    el.style.transition = animate
      ? "transform 0.22s cubic-bezier(.2,.8,.2,1), opacity 0.22s"
      : "none";
    el.style.transform = x ? `translate3d(${x}px,0,0)` : "";
    el.style.opacity = String(1 - Math.min(1, Math.abs(x) / 220) * 0.55);
  };
  el.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse") return;
    if (e.target.closest("button")) return;
    dragging = true;
    axis = null;
    startX = e.clientX;
    startY = e.clientY;
    startT = performance.now();
    dx = 0;
    dy = 0;
  });
  el.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const mx = e.clientX - startX;
    const my = e.clientY - startY;
    if (axis == null) {
      if (Math.abs(mx) < 6 && Math.abs(my) < 6) return;
      axis = Math.abs(mx) > Math.abs(my) ? "x" : "y";
    }
    if (axis === "x") {
      dx = mx;
      if (Math.abs(dx) > TAP_SLOP) _miniBarSwiped = true;
      setX(dx, false);
    } else {
      // verticale: solo per rilevare il gesto, niente movimento visivo del
      // contenuto (cover/titolo restano fermi nella mini bar)
      dy = Math.min(0, my);
      if (Math.abs(dy) > TAP_SLOP) _miniBarSwiped = true;
    }
  });
  const finish = () => {
    if (!dragging) return;
    dragging = false;
    if (axis === "y") {
      const dt = Math.max(1, performance.now() - startT);
      const vy = dy / dt; // px/ms, negativo = verso l'alto
      const flick = vy < -0.5 && dy < -18;
      if (-dy >= THRESH_Y || flick) {
        haptic(10);
        openNowPlayingSheet();
      }
      _miniBarSwiped = false;
      return;
    }
    if (Math.abs(dx) >= THRESH) {
      const goingNext = dx < 0;
      setX(goingNext ? -260 : 260, true);
      setTimeout(() => {
        if (goingNext) playNext();
        else playPrev();
        setX(0, false);
      }, 150);
    } else {
      setX(0, true);
    }
  };
  el.addEventListener("pointerup", finish);
  el.addEventListener("pointercancel", finish);
}
// desktop: anche titolo/artista
if (nowTitle) {
  nowTitle.style.cursor = "pointer";
  nowTitle.addEventListener("click", (e) => {
    e.stopPropagation();
    openNowPlayingSheet();
  });
}

if (npClose) npClose.addEventListener("click", () => closeNowPlayingSheet());
if (npPlay) npPlay.addEventListener("click", () => togglePlayPause());
if (npNext) npNext.addEventListener("click", () => playNext());
if (npPrev) npPrev.addEventListener("click", () => playPrev());

// condivisa da homeDjCard e dalle card "DJ" nei nav (sidebar desktop +
// mobile-nav, che prima erano il tab "Coda") — stessa dinamica ovunque.
function openJarvisFromNav() {
  // il trucco play()+pause() serve solo per sbloccare l'autoplay PRIMA di
  // avviare una sessione JARVIS nuova — se l'audio sta già suonando (JARVIS
  // già attivo, o anche un brano normale) è già sbloccato, e il pause()
  // incondizionato qui fermava la riproduzione in corso senza che nulla la
  // rimettesse in play (openDjSheet, se la sessione è già viva, si limita ad
  // aprire il foglio). Bug segnalato da Vitto, 2026-08-03: "clicco il
  // banner con JARVIS già attivo e mi si stoppa la musica".
  if (!(audio && audio.src && !audio.paused)) {
    unlockMainAudioForAutoplay();
  }
  openDjSheet();
}

if (homeDjCard) homeDjCard.addEventListener("click", openJarvisFromNav);
// niente più djClose/djPlay/djNext/djPrev: JARVIS riusa npClose/npPlay/
// npNext/npPrev, già cablati sugli stessi togglePlayPause/playNext/playPrev
if (djRequestForm) {
  djRequestForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const q = djRequestInput ? djRequestInput.value : "";
    if (djRequestInput) djRequestInput.value = "";
    handleJarvisRequest(q);
    // richiuso dopo l'invio — coerente col "nascosto finché non serve"
    // del resto (vedi toggleJarvisRequestOpen)
    toggleJarvisRequestOpen(false);
    dismissKeyboard();
  });
}
// tastiera: solleva il box richieste della sua altezza esatta (Vitto,
// 2026-08-01: "non si muove sopra la mia tastiera" — capacitor.config.json
// ha Keyboard.resize:"none", quindi nessun resize automatico del webview
// di cui approfittare, va fatto a mano) E lo richiude se l'utente esce
// dalla tastiera senza inviare (swipe giù, tap fuori, ecc. — non solo il
// bottone invia, già gestito sopra). keyboardDidHide invece di un blur
// sull'input: un blur scatta anche solo passando il focus al bottone
// invia, mentre l'evento nativo del plugin Keyboard rispecchia la
// tastiera vera.
try {
  const KeyboardPlugin = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Keyboard;
  if (KeyboardPlugin && KeyboardPlugin.addListener) {
    KeyboardPlugin.addListener("keyboardWillShow", (info) => {
      if (djRequestForm && info && typeof info.keyboardHeight === "number") {
        djRequestForm.style.bottom = `${info.keyboardHeight + 12}px`;
      }
      // altezza della tastiera anche per il CSS: il login da telefono si
      // ricentra nello spazio sopra di lei (06/10, vedi .tastiera-aperta).
      // Il prototipo non fa niente perché è una pagina che scorre da sola;
      // qui il webview non si ridimensiona e il login è fisso.
      if (info && typeof info.keyboardHeight === "number") {
        document.documentElement.style.setProperty("--kb-h", `${info.keyboardHeight}px`);
        document.documentElement.classList.add("tastiera-aperta");
      }
    });
    KeyboardPlugin.addListener("keyboardWillHide", () => {
      if (djRequestForm) djRequestForm.style.bottom = "";
      document.documentElement.classList.remove("tastiera-aperta");
    });
    KeyboardPlugin.addListener("keyboardDidHide", () => {
      if (npSheet && npSheet.classList.contains("request-open")) {
        toggleJarvisRequestOpen(false);
      }
    });
  }
} catch (_) {}
if (npShuffle)
  npShuffle.addEventListener("click", () => {
    // in JARVIS l'icona è un microfono (vedi CSS), non lo shuffle normale —
    // shuffle su una coda scelta da JARVIS ha poco senso, richiesta di
    // Vitto 2026-08-07: al suo posto la dettatura vocale della richiesta
    if (npSheet && npSheet.classList.contains("jarvis-mode")) {
      jarvisVoiceRequest();
      return;
    }
    btnShuffle.click();
  });
// tap sul cerchio del popup dettatura = stesso stop manuale del secondo
// tap sul microfono (jarvisVoiceRequest lo gestisce già lui stesso in base
// a npShuffle.classList.contains("listening"), nessuna logica duplicata)
if (jarvisVoiceCircle) jarvisVoiceCircle.addEventListener("click", () => jarvisVoiceRequest());
if (jarvisVoiceCancelBtn) jarvisVoiceCancelBtn.addEventListener("click", () => jarvisVoiceCancel());
if (npRepeat)
  npRepeat.addEventListener("click", () => {
    // in JARVIS l'icona è una chat (vedi CSS), non il repeat normale —
    // il repeat su una coda scelta da JARVIS ha poco senso comunque
    if (npSheet && npSheet.classList.contains("jarvis-mode")) {
      toggleJarvisRequestOpen();
      return;
    }
    btnRepeat.click();
  });
if (npLike)
  npLike.addEventListener("click", () => {
    if (!btnLike.disabled) btnLike.click();
  });
if (npAddPl)
  npAddPl.addEventListener("click", () => {
    if (!btnAddPl.disabled) btnAddPl.click();
  });

// —— menu ⋯ del player (Vitto 2026-08-07): action sheet con le azioni sul
// brano in riproduzione. La maggior parte riusa funzioni già esistenti
// (like, coda, playlist, artista) — la sola novità vera è "Musica simile"
// (openSimilarForCurrent, radio Deezer dell'artista corrente). ——
function openNpMenu() {
  if (!npMenuSheet || !nowPlaying || (npMore && npMore.disabled)) return;
  // specchia nel menu la cover, il titolo e l'artista già mostrati dal
  // player (nowPlaying non tiene la cover, la leggo da npArt)
  if (npMenuCover) {
    const bg = npArt ? getComputedStyle(npArt).backgroundImage : "none";
    if (bg && bg !== "none") {
      npMenuCover.style.backgroundImage = bg;
      npMenuCover.textContent = "";
    } else {
      npMenuCover.style.backgroundImage = "";
      npMenuCover.textContent = "▤";
    }
  }
  if (npMenuTitle) npMenuTitle.textContent = nowPlaying.title || "—";
  if (npMenuArtist) npMenuArtist.textContent = nowPlaying.artist || "—";
  // stato preferito: etichetta + cuore pieno/vuoto in base a nowPlaying.saved
  const liked = !!nowPlaying.saved;
  if (npMenuLikeRow) npMenuLikeRow.classList.toggle("liked", liked);
  if (npMenuLikeLabel) npMenuLikeLabel.textContent = liked ? "Togli dai preferiti" : "Aggiungi ai preferiti";
  // senza un artista noto, "Vai all'artista" e "Musica simile" non hanno
  // dove andare — disabilitati invece di fallire con un toast dopo il tap
  const hasArtist = !!(nowPlaying.artist && nowPlaying.artist.trim());
  if (npMenuArtistRow) npMenuArtistRow.disabled = !hasArtist;
  if (npMenuSimilar) npMenuSimilar.disabled = !hasArtist;
  // scegliere la copertina ha senso solo su un brano GIÀ in libreria: è il
  // suo file su disco che viene rifatto. Disabilitata invece che fallire
  // con un toast dopo il tap, come le due voci qui sopra.
  if (npMenuFixCover) npMenuFixCover.disabled = !(nowPlaying && nowPlaying.libraryId);
  npMenuSheet.classList.add("open");
  npMenuSheet.setAttribute("aria-hidden", "false");
}
function closeNpMenu() {
  if (!npMenuSheet) return;
  npMenuSheet.classList.remove("open");
  npMenuSheet.setAttribute("aria-hidden", "true");
}

/** L'artist_id Deezer del brano corrente, se il suo item di coda lo porta
 * (chart/playlist/artista/album/radio ce l'hanno); null per un brano
 * "search"/"library" dove si conosce solo il nome — in quel caso il
 * chiamante ripiega su artist-lookup per nome. */
function currentTrackArtistId() {
  const it = queue.items[queue.index];
  return (it && (it.artist_id || it.artistId)) || null;
}

/** "Musica simile": radio Deezer dell'artista del brano corrente, aperta
 * come una card radio. Chiude il player a tutto schermo così l'utente
 * atterra sulla card. */
function openSimilarForCurrent() {
  return apriMusicaSimile((nowPlaying && nowPlaying.artist) || "", currentTrackArtistId());
}

/** Radio Deezer di un artista qualsiasi. Era cucita addosso al brano in
 * riproduzione (openSimilarForCurrent); dal 22/09 la usa anche il menu "⋯"
 * delle righe, che parla di un brano che non sta suonando. */
async function apriMusicaSimile(name, artistIdIniziale) {
  let artistId = artistIdIniziale || null;
  closeNpMenu();
  closeNowPlayingSheet();
  const { signal, gen } = showLoadingOverlay();
  try {
    if (!artistId && name) {
      const look = await apiJson(
        `/api/deezer/artist-lookup?name=${encodeURIComponent(name)}`,
        null, undefined, undefined, signal
      );
      artistId = look.artist_id || null;
    }
    if (!artistId) {
      hideLoadingOverlay(gen);
      toast("Artista non trovato su Deezer");
      return;
    }
    const data = await apiJson(`/api/deezer/artists/${artistId}/radio`, null, undefined, undefined, signal);
    if (!(data.tracks || []).length) {
      hideLoadingOverlay(gen);
      toast("Nessun brano simile trovato");
      return;
    }
    activatePlaylistsShell();
    openLazyKind = "similar";
    openLazyId = artistId;
    _renderLazyTracklist(data.label || "Musica simile", data.tracks || [], false, null, {
      similarCoverUrl: data.cover_url || null,
    });
    if (btnPlAdopt) btnPlAdopt.classList.add("hidden");
  } catch (err) {
    if (!err.cancelled) toast("Errore musica simile: " + (err.message || err));
  } finally {
    hideLoadingOverlay(gen);
  }
}

// Pulsante "a schermo intero" nella barra del player (solo desktop, vedi
// .player .extra): apre lo stesso sheet "In ascolto" del tap sulla
// copertina. Resta spento finche' non c'e' un brano, altrimenti aprirebbe
// una schermata vuota.
const btnExpandPlayer = $("#btnExpandPlayer");
if (btnExpandPlayer) {
  btnExpandPlayer.addEventListener("click", () => {
    if (typeof openNowPlayingSheet === "function") openNowPlayingSheet();
  });
  const t = document.getElementById("nowTitle");
  const syncExpand = () => {
    btnExpandPlayer.disabled = !(nowPlaying && (nowPlaying.title || nowPlaying.artist));
  };
  syncExpand();
  if (t && typeof MutationObserver === "function") {
    new MutationObserver(syncExpand).observe(t, { childList: true, characterData: true, subtree: true });
  }
}

if (npMore) npMore.addEventListener("click", () => openNpMenu());
if (npMenuBackdrop) npMenuBackdrop.addEventListener("click", () => closeNpMenu());
if (npMenuSimilar) npMenuSimilar.addEventListener("click", () => openSimilarForCurrent());
if (npMenuLikeRow)
  npMenuLikeRow.addEventListener("click", () => {
    closeNpMenu();
    if (!btnLike.disabled) btnLike.click(); // stesso toggle preferiti del cuore
  });
if (npMenuQueue)
  npMenuQueue.addEventListener("click", () => {
    closeNpMenu();
    const it = queue.items[queue.index];
    if (it) addToQueue({ ...it, qid: uid() });
    else toast("Nessun brano da accodare");
  });
if (npMenuAddPl)
  npMenuAddPl.addEventListener("click", () => {
    closeNpMenu();
    if (!btnAddPl.disabled) btnAddPl.click(); // riusa openPlaylistPicker(nowPlaying)
  });
if (npMenuArtistRow)
  npMenuArtistRow.addEventListener("click", () => {
    closeNpMenu();
    // NON chiudere qui il player: openArtistByName → openDetailPage lo
    // chiude già lui al momento giusto (vedi "if (npOpen) closeNowPlayingSheet()"
    // in openDetailPage). Chiuderlo prima faceva partire un history.back()
    // che entrava in conflitto con la navigazione alla pagina artista →
    // sembrava "non funzionare" (Vitto 2026-08-07). Stessa strada del tap
    // sul nome artista nel player, che infatti non pre-chiude nulla.
    openArtistByName((nowPlaying && nowPlaying.artist) || "", currentTrackArtistId());
  });
if (npMenuGoQueue)
  npMenuGoQueue.addEventListener("click", () => {
    closeNpMenu();
    openQueueSheet();
  });
/** "Rigenera copertina" → selettore (Vitto 2026-10-06). Prima rilanciava il
 * recupero automatico, che sceglie da solo UNA copertina HD: se sbagliava
 * (succede spesso, i brani arrivano da bot, classifiche, edit caricate dai
 * canali) non c'era modo di correggerla. Ora il server cerca tutte le
 * copertine possibili (iTunes, Deezer, YouTube) e sceglie l'utente; la scelta
 * diventa sia la thumb (liste, mini player) sia la HD (player grande), vedi
 * api_library_cover_choose. Solo per brani in libreria: è il loro file su
 * disco che cambia (la voce è disabilitata negli altri casi, vedi
 * openNpMenu). Esisteva solo nell'app Mac fino al 28/08, l'id crkFixCover
 * resta il suo (vedi index.html). */
const coverPickModal = $("#coverPickModal");
const coverPickGrid = $("#coverPickGrid");
const coverPickTrack = $("#coverPickTrack");
const coverPickForm = $("#coverPickForm");
const coverPickQuery = $("#coverPickQuery");
const coverPickApply = $("#coverPickApply");
const coverPickClose = $("#coverPickClose");
/** Selettore aperto (null = chiuso). seq scarta le risposte di una ricerca
 * superata: riscritta e rilanciata mentre la prima girava ancora. */
let _coverPick = null;

function openCoverPicker() {
  if (!coverPickModal) return;
  const id = nowPlaying && nowPlaying.libraryId;
  if (!id) {
    toast("Solo per brani salvati");
    return;
  }
  closeNpMenu();
  _coverPick = { id: String(id), seq: 0, tiles: [], selected: -1, busy: false };
  coverPickTrack.textContent = `${nowPlaying.artist || ""} — ${nowPlaying.title || ""}`.replace(
    /^ — | — $/g,
    ""
  );
  coverPickQuery.value = "";
  coverPickModal.classList.remove("hidden");
  loadCoverCandidates("");
}

function closeCoverPicker() {
  if (!coverPickModal) return;
  if (document.activeElement === coverPickQuery) coverPickQuery.blur();
  coverPickModal.classList.add("hidden");
  _coverPick = null;
}

async function loadCoverCandidates(q) {
  const st = _coverPick;
  if (!st) return;
  const seq = ++st.seq;
  st.tiles = [];
  st.selected = -1;
  refreshCoverPickApply();
  renderCoverPickSkeleton();
  try {
    const qs = q ? `?q=${encodeURIComponent(q)}` : "";
    const d = await apiJson(`/api/library/${encodeURIComponent(st.id)}/cover/candidates${qs}`);
    if (_coverPick !== st || seq !== st.seq) return;
    // la ricerca usata, pronta da ritoccare se non trova quella giusta
    // (non sopra a quello che l'utente sta scrivendo nel frattempo)
    if (!coverPickQuery.value && document.activeElement !== coverPickQuery) {
      coverPickQuery.value = d.query || "";
    }
    st.tiles = buildCoverPickTiles(d);
    renderCoverPickGrid(!!q);
  } catch (err) {
    if (_coverPick !== st || seq !== st.seq) return;
    renderCoverPickMsg("Ricerca non riuscita: " + (err.message || err), () => loadCoverCandidates(q));
  }
}

/** In uso per prima (non selezionabile), poi l'originale del bot quando
 * nient'altro le somiglia, poi le candidate: il server mette in testa le
 * "Originale HD" (stessa immagine della thumb Telegram, ma grande). */
function buildCoverPickTiles(d) {
  const tiles = [];
  const cur = d.current || {};
  const curUrl = cur.cover_hd_url || cur.cover_url;
  if (curUrl) {
    tiles.push({
      kind: "current",
      img: proxiedCover(curUrl),
      badge: "In uso",
      src: cur.chosen ? "Scelta da te" : "Attuale",
      label: cur.matches_original ? "Uguale all'originale" : "",
      disabled: true,
    });
  }
  if (d.original) {
    tiles.push({
      kind: "original",
      img: d.original,
      badge: "Originale",
      src: "Telegram",
      label: "Arrivata col brano",
    });
  }
  for (const it of d.items || []) {
    tiles.push({
      kind: "url",
      url: it.url,
      img: proxiedCover(it.preview),
      badge: it.match ? "Originale HD" : "",
      match: !!it.match,
      src: it.source,
      label: it.album || it.artist || "",
    });
  }
  return tiles;
}

function renderCoverPickSkeleton() {
  releaseCoverPickGrid();
  for (let i = 0; i < 6; i++) {
    const el = document.createElement("div");
    el.className = "cover-pick-tile skel";
    el.innerHTML = '<span class="cover-pick-art"></span><span class="cover-pick-meta"><i></i><i></i></span>';
    coverPickGrid.appendChild(el);
  }
}

function releaseCoverPickGrid() {
  coverPickGrid.innerHTML = "";
  coverPickGrid.scrollTop = 0;
}

function renderCoverPickMsg(text, retry) {
  releaseCoverPickGrid();
  const msg = document.createElement("div");
  msg.className = "cover-pick-msg";
  msg.textContent = text;
  if (retry) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "page-btn";
    b.textContent = "Riprova";
    b.addEventListener("click", retry);
    msg.appendChild(document.createElement("br"));
    msg.appendChild(b);
  }
  coverPickGrid.appendChild(msg);
}

function renderCoverPickGrid(customQuery) {
  const st = _coverPick;
  if (!st) return;
  releaseCoverPickGrid();
  const frag = document.createDocumentFragment();
  st.tiles.forEach((t, i) => {
    const tile = document.createElement("button");
    tile.type = "button";
    tile.className = "cover-pick-tile";
    tile.dataset.i = String(i);
    if (t.disabled) tile.setAttribute("aria-disabled", "true");
    const art = document.createElement("span");
    art.className = "cover-pick-art";
    const img = document.createElement("img");
    img.alt = "";
    img.decoding = "async";
    if (i > 8) img.loading = "lazy";
    img.addEventListener("load", () => img.classList.add("ok"));
    img.addEventListener("error", () => {
      // anteprima che non si carica: via dalla griglia invece di un buco
      if (t.kind !== "url") return;
      if (_coverPick === st && st.selected === i) {
        st.selected = -1;
        refreshCoverPickApply();
      }
      tile.remove();
    });
    img.src = t.img;
    art.appendChild(img);
    if (t.badge) {
      const badge = document.createElement("span");
      badge.className = "cover-pick-badge" + (t.match || t.kind === "original" ? " match" : "");
      badge.textContent = t.badge;
      art.appendChild(badge);
    }
    const check = document.createElement("span");
    check.className = "cover-pick-check";
    check.setAttribute("aria-hidden", "true");
    check.innerHTML =
      '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
    art.appendChild(check);
    const meta = document.createElement("span");
    meta.className = "cover-pick-meta";
    const src = document.createElement("span");
    src.className = "cover-pick-src";
    src.textContent = t.src || "";
    const label = document.createElement("span");
    label.className = "cover-pick-album";
    label.textContent = t.label || " ";
    meta.append(src, label);
    tile.append(art, meta);
    tile.setAttribute("aria-label", [t.badge, t.src, t.label].filter(Boolean).join(", "));
    tile.addEventListener("click", () => selectCoverPickTile(i));
    frag.appendChild(tile);
  });
  coverPickGrid.appendChild(frag);
  if (!st.tiles.some((t) => !t.disabled)) {
    const msg = document.createElement("div");
    msg.className = "cover-pick-msg";
    msg.textContent = customQuery
      ? "Niente per questa ricerca. Prova con altre parole."
      : "Nessun'altra copertina trovata. Scrivi artista e titolo giusti qui sopra e premi Cerca.";
    coverPickGrid.appendChild(msg);
  }
}

function selectCoverPickTile(i) {
  const st = _coverPick;
  if (!st || st.busy) return;
  const t = st.tiles[i];
  if (!t || t.disabled) return;
  st.selected = st.selected === i ? -1 : i; // secondo tap = deseleziona
  coverPickGrid.querySelectorAll(".cover-pick-tile").forEach((el) => {
    el.classList.toggle("selected", Number(el.dataset.i) === st.selected);
  });
  refreshCoverPickApply();
}

function refreshCoverPickApply() {
  if (!coverPickApply) return;
  const st = _coverPick;
  const ready = !!st && st.selected >= 0 && !st.busy;
  coverPickApply.disabled = !ready;
  coverPickApply.textContent =
    st && st.busy ? "Applico…" : ready ? "Usa questa copertina" : "Scegli una copertina";
}

async function applyCoverPick() {
  const st = _coverPick;
  if (!st || st.busy || st.selected < 0) return;
  const t = st.tiles[st.selected];
  if (!t) return;
  st.busy = true;
  refreshCoverPickApply();
  try {
    const body = t.kind === "original" ? { original: true } : { url: t.url };
    const d = await apiJson(`/api/library/${encodeURIComponent(st.id)}/cover/choose`, body, "POST");
    applyNewTrackCover(st.id, d.cover_url, d.cover_hd_url);
    if (_coverPick === st) closeCoverPicker();
    toast("Copertina aggiornata");
  } catch (err) {
    console.warn("scelta copertina non riuscita:", err);
    toast("Questa copertina non si riesce a usare, provane un'altra");
    if (_coverPick === st) {
      st.busy = false;
      refreshCoverPickApply();
    }
  }
}

if (npMenuFixCover) npMenuFixCover.addEventListener("click", () => openCoverPicker());
if (coverPickModal) {
  coverPickClose.addEventListener("click", closeCoverPicker);
  coverPickModal.addEventListener("click", (e) => {
    if (e.target === coverPickModal) closeCoverPicker();
  });
  coverPickApply.addEventListener("click", applyCoverPick);
  coverPickForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const q = coverPickQuery.value.trim();
    coverPickQuery.blur(); // giù la tastiera, si vede la griglia
    loadCoverCandidates(q);
  });
  // Esc chiude il selettore e basta: in cattura arriva prima del listener
  // che chiuderebbe anche il player a tutto schermo lì sotto
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Escape" || !_coverPick) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      closeCoverPicker();
    },
    true
  );
}

/** Copertina di un brano della libreria cambiata: dal selettore qui, o da
 * un altro device (messaggio "copertina" del sync). Gli URL nuovi hanno un
 * ?v= nuovo, ma righe già disegnate, coda e cache in memoria tengono i
 * vecchi: si rimpiazzano dove si vedono, il resto lo sistema la revisione
 * che mediaAuthUrl aggiunge da qui in poi (vedi _coverRev). */
function applyNewTrackCover(id, coverUrl, coverHdUrl) {
  if (!id || !coverUrl) return;
  id = String(id);
  setCoverRev(id, Date.now().toString(36));
  const hdUrl = coverHdUrl || coverUrl;
  const tag = `/api/library/${id}/cover`;
  // URL vecchio → nuovo, thumb o HD come quello che sostituisce
  const swap = (u) => {
    if (typeof u !== "string") return null;
    const i = u.indexOf(tag);
    if (i < 0) return null;
    return u.startsWith("/hd", i + tag.length) ? hdUrl : coverUrl;
  };

  const t = libraryTracksCache.find((x) => x.id === id);
  if (t) {
    t.cover_url = coverUrl;
    t.cover_hd_url = hdUrl;
  }
  // voci di coda: tengono l'URL già autenticato (vedi libraryItemFromTrack)
  for (const it of queue.items || []) {
    if (!it) continue;
    const c = swap(it.cover_url);
    if (c) it.cover_url = mediaAuthUrl(c, { bust: false });
    const h = swap(it.cover_hd_url);
    if (h) it.cover_hd_url = mediaAuthUrl(h, { bust: false });
  }

  // righe e griglie già disegnate (salvati, playlist, coda, Home…). Il
  // player lo rifà setCover qui sotto, con la sua dissolvenza.
  const skip = new Set([coverEl, npArt, npBg]);
  const sel = `[data-lazy-cover*="${tag}"],[style*="${tag}"],img[src*="${tag}"]`;
  document.querySelectorAll(sel).forEach((el) => {
    if (skip.has(el)) return;
    if (el.dataset.lazyCover) {
      const n = swap(el.dataset.lazyCover);
      if (n) el.dataset.lazyCover = proxiedCover(n);
    }
    if (el.tagName === "IMG") {
      const n = swap(el.getAttribute("src"));
      if (n) el.src = proxiedCover(n);
      return;
    }
    const bg = el.style.backgroundImage;
    if (bg && bg.indexOf(tag) >= 0) {
      // in place: alcuni sfondi hanno gradienti sopra la copertina
      el.style.backgroundImage = bg.replace(/url\((["']?)(.*?)\1\)/g, (m, _q, u) => {
        const n = swap(u);
        return n ? `url("${proxiedCover(n)}")` : m;
      });
    }
  });

  if (
    (nowPlaying && nowPlaying.libraryId === id) ||
    String(_lastCoverThumb || "").indexOf(tag) >= 0
  ) {
    setCover(coverUrl, hdUrl);
    updateMediaSessionMetadata();
  }
  refreshOfflineTrackCover(id, coverUrl, hdUrl);
}

/** Copia offline (app iPhone) del brano: riscarica la copertina sullo
 * stesso file e cambia coverRev, così chi la mostra non riusa quella vecchia
 * dalla cache (vedi getOfflineTrackCoverSrc). Silenzioso: senza rete
 * resta quella di prima. */
async function refreshOfflineTrackCover(id, coverUrl, hdUrl) {
  if (!offlineFs() || !getOfflineTracks()[id]) return;
  const { path } = await downloadCoverOffline({ id, cover_url: coverUrl, cover_hd_url: hdUrl });
  if (!path) return;
  const map = getOfflineTracks(); // riletta: nel frattempo può essere cambiata
  if (!map[id]) return;
  map[id] = { ...map[id], coverPath: path, coverRev: Date.now() };
  setOfflineTracks(map);
}

if (npMenuTimer)
  npMenuTimer.addEventListener("click", () => {
    closeNpMenu();
    closeNowPlayingSheet();
    openAccountModal();
    showSettingsPanel("settingsSleepTimer");
  });

if (npQueueBtn)
  npQueueBtn.addEventListener("click", () => {
    closeNowPlayingSheet();
    showView("queue");
  });
if (npLyricsBtn)
  npLyricsBtn.addEventListener("click", () => {
    openLyricsPanel();
  });
if (npLyricsPreview)
  npLyricsPreview.addEventListener("click", () => {
    openLyricsPanel();
  });
if (npLyricsClose)
  npLyricsClose.addEventListener("click", () => {
    closeLyricsPanel();
  });
if (lyPlayBtn)
  lyPlayBtn.addEventListener("click", () => {
    if (!audio.src) return;
    if (audio.paused) audio.play().catch(() => {});
    else audio.pause();
    syncLyDock();
  });
if (lySeekTrack)
  lySeekTrack.addEventListener("click", (e) => {
    const dur = audio.duration;
    if (!Number.isFinite(dur) || dur <= 0) return;
    const rect = lySeekTrack.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    guardedSeek(ratio * dur);
    syncLyDock();
    updateKaraokeLyrics(true);
  });

// seek full sheet
if (npSeek) {
  npSeek.addEventListener("pointerdown", () => {
    npSeekDragging = true;
  });
  npSeek.addEventListener("pointerup", () => {
    npSeekDragging = false;
  });
  npSeek.addEventListener("input", () => {
    const dur = audio.duration;
    if (!Number.isFinite(dur) || dur <= 0) return;
    const ratio = Number(npSeek.value) / 1000;
    if (npSeekFill) npSeekFill.style.width = `${ratio * 100}%`;
    seekFill.style.width = `${ratio * 100}%`;
    seek.value = npSeek.value;
    const t = fmtTime(ratio * dur);
    if (npTimeCur) npTimeCur.textContent = t;
    timeCur.textContent = t;
  });
  npSeek.addEventListener("change", () => {
    const dur = audio.duration;
    if (!Number.isFinite(dur) || dur <= 0) return;
    if (!guardedSeek((Number(npSeek.value) / 1000) * dur)) updateSeekUi();
    npSeekDragging = false;
  });
}

// swipe down to close
if (npSheet) {
  npSheet.addEventListener(
    "touchstart",
    (e) => {
      if (!npOpen) return;
      npTouchStartY = e.touches[0].clientY;
    },
    { passive: true }
  );
  npSheet.addEventListener(
    "touchend",
    (e) => {
      if (npTouchStartY == null || !npOpen) return;
      const dy = e.changedTouches[0].clientY - npTouchStartY;
      npTouchStartY = null;
      if (dy > 80) closeNowPlayingSheet();
    },
    { passive: true }
  );
}

window.addEventListener("popstate", () => {
  if (npOpen) closeNowPlayingSheet(true);
});
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && npOpen) closeNowPlayingSheet();
});

seek.addEventListener("pointerdown", () => {
  seekDragging = true;
});
seek.addEventListener("pointerup", () => {
  seekDragging = false;
});
seek.addEventListener("input", () => {
  const dur = audio.duration;
  if (!Number.isFinite(dur) || dur <= 0) return;
  const ratio = Number(seek.value) / 1000;
  seekFill.style.width = `${ratio * 100}%`;
  timeCur.textContent = fmtTime(ratio * dur);
  if (npSeek) npSeek.value = seek.value;
  if (npSeekFill) npSeekFill.style.width = `${ratio * 100}%`;
  if (npTimeCur) npTimeCur.textContent = fmtTime(ratio * dur);
});
seek.addEventListener("change", () => {
  const dur = audio.duration;
  if (!Number.isFinite(dur) || dur <= 0) return;
  if (!guardedSeek((Number(seek.value) / 1000) * dur)) updateSeekUi();
  seekDragging = false;
});

volume.addEventListener("input", () => {
  const v = Number(volume.value) / 100;
  audio.muted = false;
  audio.volume = v;
  lastVolume = v || lastVolume;
  updateVolUi();
});

btnMute.addEventListener("click", () => {
  if (audio.muted || audio.volume === 0) {
    audio.muted = false;
    audio.volume = lastVolume || 0.8;
  } else {
    lastVolume = audio.volume;
    audio.muted = true;
  }
  updateVolUi();
});

// —— like ——
btnLike.addEventListener("click", async () => {
  if (btnLike.disabled) return;
  if (btnLike.classList.contains("filling")) return;

  if (nowPlaying.libraryId && nowPlaying.saved) {
    const id = nowPlaying.libraryId;
    const fromCache = libraryTracksCache.find((x) => x.id === id);
    const track = fromCache || {
      id,
      title: nowPlaying.title || nowTitle?.textContent || "Brano",
      artist: nowPlaying.artist || nowArtist?.textContent || "",
      cover_url: nowPlaying.cover || null,
    };
    scheduleLibraryRemove(track);
    setStatus("Rimosso dai salvati · Annulla nella notifica");
    return;
  }

  // se c’è un remove in undo window → solo annulla, NESSUN re-download
  if (
    cancelPendingRemoveMatching({
      id: nowPlaying.libraryId,
      title: nowPlaying.title,
      artist: nowPlaying.artist,
    })
  ) {
    setStatus("Di nuovo nei salvati");
    return;
  }

  // brano di un altro utente ("Aggiunte di recente al server") non ancora
  // salvato: il cuore lo adotta (copia dal disco dell'altro utente),
  // non tenta un save via token TG che qui non esiste.
  if (nowPlaying.recentTrackId && !nowPlaying.saved) {
    const ownerId = nowPlaying.recentOwnerId;
    const trackId = nowPlaying.recentTrackId;
    startHeartFill(btnLike, npLike);
    setStatus("Aggiungo alla libreria…");
    try {
      const data = await apiJson(
        `/api/library/recent/${ownerId}/${trackId}/adopt`,
        null,
        "POST"
      );
      endHeartFill(true, btnLike, npLike);
      setLikeUi(true);
      nowPlaying.libraryId = data.track?.id || null;
      nowPlaying.recentOwnerId = null;
      nowPlaying.recentTrackId = null;
      setStatus(
        data.already_saved ? "Già nei salvati" : `Salvato ♥  ${data.track?.title || ""}`
      );
      await refreshAfterLibraryChange();
    } catch (err) {
      endHeartFill(false, btnLike, npLike);
      setStatus("Salva: " + (err.message || err));
    }
    return;
  }

  // rete di sicurezza: brano nostro arrivato senza id (superficie pigra
  // vecchia, mirror da un altro device, risposta di un server non ancora
  // aggiornato...). Il cuore è pieno ed è giusto — è salvato — ma senza id il
  // ramo di rimozione qui sopra non scatta e il tap non fa NIENTE: l'id lo
  // ritroviamo per artista+titolo nella cache dei salvati, già in memoria.
  if (nowPlaying.saved && !nowPlaying.libraryId) {
    const norm = (x) => (x || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const mine = libraryTracksCache.find(
      (x) =>
        norm(x.title) === norm(nowPlaying.title) &&
        norm(x.artist) === norm(nowPlaying.artist)
    );
    if (mine) {
      nowPlaying.libraryId = mine.id;
      scheduleLibraryRemove(mine);
      setStatus("Rimosso dai salvati · Annulla nella notifica");
      return;
    }
  }

  if (!nowPlaying.token) {
    setStatus("Salva solo brani dalla ricerca (stream TG)");
    return;
  }

  startHeartFill(btnLike, npLike);
  setStatus("Salvo in crackify/…");
  try {
    const data = await apiJson("/api/library/save", { token: nowPlaying.token });
    // se nel frattempo era in pending remove sullo stesso id
    if (data.track?.id) cancelPendingLibraryRemove(data.track.id, { toastMsg: false });
    endHeartFill(true, btnLike, npLike);
    setLikeUi(true);
    nowPlaying.libraryId = data.track?.id || null;
    setStatus(
      data.already_saved ? "Già nei salvati" : `Salvato ♥  ${data.track?.title || ""}`
    );
    await refreshAfterLibraryChange();
  } catch (err) {
    endHeartFill(false, btnLike, npLike);
    setStatus("Salva: " + err.message);
  }
});

// —— views ——
/** Su mobile: nasconde la topbar "CRACKIFY" solo quando è aperta una playlist
 * specifica (o Brani salvati) — lì il pannello ha già il suo titolo. Visibile
 * nella grid "La tua libreria" come in tutte le altre tab. */
function setMobileTopbarVisible(visible) {
  const bar = document.querySelector(".mobile-topbar");
  if (bar) bar.classList.toggle("topbar-hidden", !visible);
}

/** Mostra una view con un piccolo fade-in — niente più scatto secco da
 * "pagina web" tra Home/Cerca/Coda/Libreria. */
function revealView(el) {
  chiudiRicercaBraniSeAperta(); // si va su un'altra pagina: la finestra "Brani" si chiude
  el.classList.remove("hidden");
  entraVista(el);
  // .main è un unico contenitore scrollabile condiviso da tutte le view
  // (home/search/libreria/coda/playlist/artista) — senza reset esplicito,
  // una nuova pagina apriva ereditando lo scroll di quella precedente
  // invece di partire dall'inizio (Vitto: "ti lascia lì dove eri")
  if (mainEl) mainEl.scrollTop = 0;
}

function showView(name) {
  registraTappa("vista", [name]);
  // tap ripetuto sulla tab già attiva: niente reload/re-animazione, altrimenti
  // fetch e transizioni si accavallano in corsa e sminchiano la UI
  const targetEl =
    name === "home" ? viewHome :
    name === "queue" ? viewQueue :
    name === "playlists" ? viewPlaylists :
    viewSearch;
  const activeLink = document.querySelector(`.nav-link[data-view="${name}"]`);
  if (activeLink && activeLink.classList.contains("active") && !targetEl.classList.contains("hidden")) {
    // eccezione per "Libreria": un tap mentre sei già dentro deve poter
    // fare da refresh manuale (Vitto 2026-07-29) — non riparte la
    // coreografia di cambio-vista, solo il fetch. loadPlaylists() ha il
    // suo guard interno (_loadingPlaylists) contro le sovrapposizioni, per
    // questo qui è sicuro farla ripartire anche se una è già in corso.
    // setMobileTopbarVisible(true) ci vuole anche qui: se il tap arriva da
    // dentro il dettaglio di una playlist (openPlaylist l'aveva nascosta),
    // senza questa riga lo shortcut "stessa tab" usciva subito e la barra
    // restava sparita anche tornando alla griglia (bug Vitto, 2026-08-04).
    setMobileTopbarVisible(true);
    if (name === "playlists") {
      // offline il "ricarica" non c'era: restava aperta la playlist sotto
      // la barra appena rimessa, metà e metà (Vitto, 06/10). Si torna alla
      // griglia delle scaricate, come fa loadPlaylists online.
      if (appOfflineMode) renderOfflinePlaylistsGrid();
      else loadPlaylists();
    }
    return;
  }

  viewHome.classList.add("hidden");
  viewSearch.classList.add("hidden");
  viewLibrary.classList.add("hidden");
  viewQueue.classList.add("hidden");
  viewPlaylists.classList.add("hidden");
  // Home coperta: il suo loop soundbar non ha senso girare a vuoto sotto
  // un'altra tab — vedi stopHomeDjSoundbarLoop, riacceso sotto se name è
  // "home"
  stopHomeDjSoundbarLoop();
  // se la pagina artista era aperta sopra (overlay, vedi openArtist): tap
  // su una tab in basso deve chiuderla, altrimenti resta impilata sotto/sopra
  // la view appena mostrata (visto letteralmente due schermate in una)
  if (viewArtist) viewArtist.classList.add("hidden");
  document.querySelectorAll(".nav-link").forEach((x) => x.classList.remove("active"));
  // due copie nel DOM (sidebar desktop + mobile-nav): querySelector prende
  // solo la prima e su mobile quella resta orfana (nascosta via CSS) senza
  // mai riavere ".active" — vanno aggiornate entrambe
  document
    .querySelectorAll(`.nav-link[data-view="${name}"]`)
    .forEach((x) => x.classList.add("active"));
  setMobileTopbarVisible(true);
  if (name === "home") {
    revealView(viewHome);
    startHomeDjSoundbarLoop();
    loadHomeCharts();
    loadHomeDailyMixes();
    loadHomeRadioStations();
    loadHomeRecommendedPlaylists();
    loadHomeQuickGrid();
  } else if (name === "queue") {
    // se lo sheet era aperto #queueList vive lì dentro — rimettilo in
    // #viewQueue PRIMA di mostrarla, altrimenti la pagina risulta vuota
    closeQueueSheet();
    revealView(viewQueue);
    renderQueueList();
    updateQueueUi();
  } else if (name === "playlists") {
    revealView(viewPlaylists);
    openPlaylistId = null;
    if (appOfflineMode) renderOfflinePlaylistsGrid();
    else loadPlaylists();
  } else {
    // pagina Cerca: unica superficie di ricerca dell'app (Deezer sopra,
    // brani da Telegram nella finestra del bottone "Brani"). Il cursore
    // parte nel campo, così la tab è subito operativa.
    revealView(viewSearch);
    // il fuoco solo da desktop: su telefono farebbe salire la tastiera a
    // ogni tocco sulla tab, coprendo mezza pagina
    const campo = document.getElementById("homeSearchInput");
    if (campo && window.innerWidth >= 901) {
      if (typeof homeSearchHistoryUI !== "undefined") homeSearchHistoryUI.salta();
      try { campo.focus(); campo.select(); } catch (_) {}
    }
    // "Aggiunte di recente al server" è il contenuto della pagina a riposo:
    // la ricarichiamo entrando (prima girava solo al boot con sessione già
    // valida, quindi dopo un login vero non compariva mai)
    if (!(campo && campo.value.trim())) {
      loadRecentServer();
      // se si entra da Cerca senza essere passati dalla Home, le
      // classifiche non sono ancora state chieste: le piastrelle per
      // genere vivono di quelle
      if (!_classifichePerGenere.length) loadHomeCharts();
      else renderGeneri(_classifichePerGenere);
    }
  }
}

/** Brani salvati: card fissata in cima a "La tua libreria" (stile Spotify). */
function openSavedLibrary() {
  registraTappa("salvati", []);
  // già dentro Brani salvati: non ripartire con reload/animazione
  if (!viewLibrary.classList.contains("hidden")) return;
  viewHome.classList.add("hidden");
  viewSearch.classList.add("hidden");
  viewQueue.classList.add("hidden");
  viewPlaylists.classList.add("hidden");
  if (viewArtist) viewArtist.classList.add("hidden");
  stopHomeDjSoundbarLoop();
  revealView(viewLibrary);
  document.querySelectorAll(".nav-link").forEach((x) => x.classList.remove("active"));
  document
    .querySelectorAll('.nav-link[data-view="playlists"]')
    .forEach((x) => x.classList.add("active"));
  setMobileTopbarVisible(false);
  loadLibrary();
}

document.querySelectorAll(".nav-link").forEach((a) => {
  a.addEventListener("click", (e) => {
    e.preventDefault();
    // cambiare tab vuol dire andare altrove: la finestra "Brani" non deve
    // restare aperta sopra la pagina nuova (Vitto, 05/10). Anche sulla tab
    // già attiva e sul DJ, che non passano da revealView
    chiudiRicercaBraniSeAperta();
    if (a.dataset.view === "dj") {
      openJarvisFromNav();
      return;
    }
    showView(a.dataset.view);
  });
});

// —— search ——
function setStatus(msg) {
  statusEl.textContent = msg || "";
}

function setSearching(on) {
  searchBtn.disabled = on;
  skeleton.classList.toggle("hidden", !on);
  if (on) {
    releaseLazyCovers(trackList);
    trackList.innerHTML = "";
    pager.classList.add("hidden");
  }
}

function applyPageState(data) {
  pageState = {
    page: data.page || 1,
    has_next: !!data.has_next,
    has_prev: !!data.has_prev,
  };
  pageLabel.textContent = `Pagina ${pageState.page}`;
  prevPageBtn.disabled = !pageState.has_prev || paging;
  nextPageBtn.disabled = !pageState.has_next || paging;
  const show = pageState.has_next || pageState.has_prev || pageState.page > 1;
  pager.classList.toggle("hidden", !show);
}

function renderTracks(tracks) {
  releaseLazyCovers(trackList);
  trackList.innerHTML = "";
  tracks.forEach((t) => {
    const li = document.createElement("div");
    li.className = "track";
    li.dataset.index = t.index;
    li.innerHTML = `
      <span class="num">${t.index}</span>
      <div class="art">⚡</div>
      <div class="info">
        <div class="title"></div>
        <div class="artist"></div>
      </div>
      <span class="dur"></span>
      <div class="track-actions">
        <button type="button" class="heart-row search-save heart-fillable" title="Salva in crackify">${heartFillMarkup(18)}</button>
      </div>
    `;
    li.querySelector(".title").textContent = t.title || t.label || "—";
    wireArtistName(li.querySelector(".artist"), t.artist, t.artist_id, "Artista sconosciuto");
    li.querySelector(".dur").textContent = t.duration || "";
    const cover = proxiedCover(t.cover_url);
    if (cover) {
      const art = li.querySelector(".art");
      lazyLoadCover(art, cover);
    }
    li.querySelector(".search-save").addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!currentSearchId) return;
      const btn = e.currentTarget;
      if (btn.classList.contains("filling") || btn.classList.contains("on")) return;
      btn.disabled = true;
      startHeartFill(btn);
      try {
        const ok = await saveSearchTrack(t);
        endHeartFill(ok, btn);
        if (ok) btn.classList.add("on");
      } catch (_) {
        endHeartFill(false, btn);
      } finally {
        btn.disabled = false;
      }
    });
    const wrap = enableSwipeToQueue(
      li,
      () => searchItemFromTrack(t),
      {
        onTap: () => {
          if (!currentSearchId) return;
          playSearchTrack(t);
        },
      }
    );
    trackList.appendChild(wrap);
  });
}

function showResults(data) {
  currentSearchId = data.search_id;
  lastSearchTracks = data.tracks || [];
  renderTracks(lastSearchTracks);
  applyPageState(data);
  const n = lastSearchTracks.length || 0;
  const via = data.bot_username ? ` via @${data.bot_username}` : "";
  setStatus(
    n
      ? `${n} brani${via} — tap play · swipe → coda`
      : `Nessun brano parsato${via}`
  );
}

/** Debug temporaneo (Vitto, 2026-07-31): manda un evento al log del server
 * invece che alla console del browser, che da qui non è visibile — usato
 * per capire perché certe cover di ricerca restano bianche pur risultando
 * valide lato server. Fire-and-forget, non deve mai bloccare/rompere nulla. */
function debugLog(tag, data) {
  try {
    apiJson("/api/debug/log", { tag, data: data || {} }, "POST").catch(() => {});
  } catch (_) {}
}

async function apiJson(url, body, method, _retry, externalSignal) {
  url = apiUrl(url);
  const opts = {
    method: method || (body != null ? "POST" : "GET"),
    headers: authHeaders(),
    credentials: "same-origin",
    // WKWebView può servire una risposta vecchia dalla cache HTTP per una
    // URL già vista (es. /api/charts/top50 è sempre la stessa) anche se i
    // dati lato server sono cambiati — stesso bug già trovato sulle cover
    // offline. Le API sono sempre dinamiche: mai cache.
    cache: "no-store",
  };
  if (body != null) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  if (method === "DELETE" || method === "PATCH") opts.method = method;

  const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const t = setTimeout(() => {
    try {
      ctrl && ctrl.abort();
    } catch (_) {}
  }, 90000);
  if (ctrl) opts.signal = ctrl.signal;
  // annullamento manuale (es. X sull'overlay di caricamento, vedi
  // cancelLoadingOverlay): stesso controller del timeout, ma segnaliamo la
  // provenienza per NON mostrare "timeout" quando è stato l'utente a fermarlo
  let userCancelled = false;
  if (ctrl && externalSignal) {
    if (externalSignal.aborted) {
      userCancelled = true;
      ctrl.abort();
    } else {
      externalSignal.addEventListener(
        "abort",
        () => {
          userCancelled = true;
          ctrl.abort();
        },
        { once: true }
      );
    }
  }

  let res;
  try {
    res = await fetch(url, opts);
  } catch (e) {
    clearTimeout(t);
    if (userCancelled) {
      const cancelErr = new Error("Annullato");
      cancelErr.cancelled = true;
      throw cancelErr;
    }
    // blip di rete su una GET (es. WiFi verso il Mac nell'app nativa):
    // ritenta un paio di volte prima di arrendersi, invece di lasciare la
    // UI silenziosamente incompleta (card mancanti finché non si ricarica).
    const isGet = !method || method === "GET";
    if (isGet && (_retry || 0) < 2 && e && e.name !== "AbortError") {
      await new Promise((r) => setTimeout(r, 300 * ((_retry || 0) + 1)));
      return apiJson(url, body, method, (_retry || 0) + 1, externalSignal);
    }
    const msg =
      e && e.name === "AbortError"
        ? "Timeout — il Mac non risponde (server/Telegram?)"
        : "Rete fallita verso il Mac (" + (e.message || "offline") + ")";
    throw new Error(msg);
  }
  clearTimeout(t);

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) {
      // sessione morta
      const eraDentro = authState.authenticated;
      if (eraDentro) {
        setSessionToken(null);
        authState.authenticated = false;
        authState.user = null;
        updateAccountUI();
      }
      // "Sessione scaduta" solo se una sessione c'era davvero: da fuori un
      // 401 di qualcosa in background non deve toccare il login già aperto
      if (authState.authRequired && eraDentro) {
        openLoginModal("Sessione scaduta — accedi di nuovo");
      }
    }
    const detail = data.detail || res.statusText;
    throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
  return data;
}

/** Cover esterne (iTunes) → proxy sul Mac, così l’iPhone senza DNS pubblico le vede */
function proxiedCover(url) {
  if (!url) return null;
  if (url.startsWith("data:")) return url;
  // URI locali del device (cover scaricate per l'offline): new URL() li
  // parsa con origin "null" (scheme non-standard), quindi senza questo
  // early-return finirebbero per sbaglio nel cover-proxy del server
  if (url.startsWith("capacitor:") || url.startsWith("blob:") || url.startsWith("file:")) {
    return url;
  }
  if (url.startsWith("/")) {
    // path protetti (libreria propria/altrui, playlist...) hanno bisogno
    // del token anche qui, non solo quando poi suona l'audio — altrimenti
    // la copertina resta vuota per i brani "ripasso" del Daily Mix (già in
    // libreria, url protetto) mentre quelli "scoperta" (Deezer, pubblici)
    // funzionano lo stesso: vedi mediaAuthUrl per i path che richiedono token.
    return mediaAuthUrl(url, { bust: false });
  }
  try {
    const u = new URL(url, location.origin);
    // "nostro" = stesso origin della pagina, OPPURE l'origin del backend
    // (API_BASE) nell'app nativa — altrimenti un url già risolto da
    // mediaAuthUrl() verrebbe scambiato per esterno e respinto dal
    // cover-proxy (whitelist non include l'IP del nostro stesso Mac).
    let apiOrigin = null;
    if (API_BASE) {
      try {
        apiOrigin = new URL(API_BASE, location.origin).origin;
      } catch (_) {}
    }
    // Un path /api/ è NOSTRO anche quando l'host non combacia: nel mirror il
    // device che comanda manda la copertina già assoluta col SUO host e il
    // SUO token (vedi sync.py), quindi l'iPhone dice
    // "http://100.75.125.16:8787/api/library/…" e il Mac, che sta su
    // "http://127.0.0.1:8787", non la riconosceva come propria e la spediva
    // al cover-proxy — che la respingeva con 403 (406 volte nei log,
    // copertine vuote nel mirror). Nessuna CDN esterna serve cover sotto
    // /api/, quindi il path da solo è un criterio sicuro.
    const isOurs =
      u.origin === location.origin ||
      (apiOrigin && u.origin === apiOrigin) ||
      u.pathname.startsWith("/api/");
    if (isOurs) {
      // via il token dell'ALTRO device: mediaAuthUrl rimette il nostro dove
      // serve, altrimenti si eredita una sessione che qui può essere scaduta
      u.searchParams.delete("t");
      return mediaAuthUrl(u.pathname + u.search, { bust: false });
    }
    return apiUrl("/api/cover-proxy?url=" + encodeURIComponent(url));
  } catch (_) {
    return url;
  }
}

// —— cronologia ricerche (legata all'account, sincronizzata su tutti i device) ——
let _searchHistoryCache = [];

async function addSearchHistory(query) {
  const q = (query || "").trim();
  if (!q) return;
  // ottimistico: aggiorna subito la cache locale, poi sincronizza
  _searchHistoryCache = [
    q,
    ..._searchHistoryCache.filter((x) => x.toLowerCase() !== q.toLowerCase()),
  ].slice(0, 6);
  try {
    const data = await apiJson("/api/me/search-history", { query: q }, "POST");
    if (Array.isArray(data.queries)) _searchHistoryCache = data.queries;
  } catch (_) {}
}

async function removeSearchHistory(query) {
  _searchHistoryCache = _searchHistoryCache.filter((x) => x !== query);
  renderSearchHistory();
  try {
    const data = await apiJson(
      `/api/me/search-history?query=${encodeURIComponent(query)}`,
      null,
      "DELETE"
    );
    if (Array.isArray(data.queries)) _searchHistoryCache = data.queries;
    renderSearchHistory();
  } catch (_) {}
}

async function clearSearchHistory() {
  _searchHistoryCache = [];
  hideSearchHistory();
  try {
    await apiJson("/api/me/search-history", null, "DELETE");
  } catch (_) {}
}

function hideSearchHistory() {
  if (searchHistoryEl) searchHistoryEl.classList.add("hidden");
}

/* All'apertura della finestra diamo il fuoco al campo, ma il fuoco apre la
 * cronologia, che copriva mezza card: saltiamo la tendina solo per quel
 * focus programmatico — al primo click sul campo riappare. */
let _saltaCronologia = false;
async function renderSearchHistory() {
  if (!searchHistoryEl) return;
  if (_saltaCronologia) {
    _saltaCronologia = false;
    hideSearchHistory();
    return;
  }
  if (!authState.authenticated) return;
  try {
    const data = await apiJson("/api/me/search-history");
    if (Array.isArray(data.queries)) _searchHistoryCache = data.queries;
  } catch (_) {}
  const list = _searchHistoryCache.slice(0, 6);
  if (!list.length) {
    hideSearchHistory();
    return;
  }
  searchHistoryEl.innerHTML = "";
  list.forEach((q) => {
    const row = document.createElement("div");
    row.className = "search-history-row";
    row.innerHTML = `
      <span class="search-history-ico" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="9"/>
          <path d="M12 7v5l3 3"/>
        </svg>
      </span>
      <span class="search-history-text"></span>
      <button type="button" class="search-history-remove" title="Rimuovi" aria-label="Rimuovi">✕</button>
    `;
    row.querySelector(".search-history-text").textContent = q;
    row.addEventListener("click", (e) => {
      if (e.target.closest(".search-history-remove")) return;
      queryInput.value = q;
      hideSearchHistory();
      form.requestSubmit();
    });
    row.querySelector(".search-history-remove").addEventListener("click", (e) => {
      e.stopPropagation();
      removeSearchHistory(q);
    });
    searchHistoryEl.appendChild(row);
  });
  const clearRow = document.createElement("div");
  clearRow.className = "search-history-clear";
  clearRow.textContent = "Cancella cronologia";
  clearRow.addEventListener("click", (e) => {
    e.stopPropagation();
    clearSearchHistory();
  });
  searchHistoryEl.appendChild(clearRow);
  searchHistoryEl.classList.remove("hidden");
}

// mostra sempre la cronologia al focus/click, anche se il campo contiene
// ancora il testo dell'ultima ricerca (resta lì dopo aver cercato) —
// altrimenti ricliccando la barra dopo una ricerca non si vede mai nulla.
queryInput.addEventListener("focus", () => {
  renderSearchHistory();
});
// autofocus sull'input: al primo caricamento il focus scatta da solo,
// quindi un tap successivo (già focused) non genera un nuovo evento
// "focus" — click copre anche quel caso.
queryInput.addEventListener("click", () => {
  renderSearchHistory();
});
queryInput.addEventListener("input", () => {
  updateSearchClearVisible();
  if (!queryInput.value.trim()) renderSearchHistory();
  else hideSearchHistory();
});
document.addEventListener("click", (e) => {
  if (!searchHistoryEl || searchHistoryEl.classList.contains("hidden")) return;
  if (e.target === queryInput || searchHistoryEl.contains(e.target)) return;
  hideSearchHistory();
});
queryInput.addEventListener("keydown", (e) => {
  if (e.key === "Escape") hideSearchHistory();
});

const YOUTUBE_URL_RE =
  /(?:https?:\/\/)?(?:www\.|m\.|music\.)?(?:youtube\.com\/(?:watch\?v=|shorts\/|live\/)|youtu\.be\/)[\w-]{6,}/i;

// —— "Aggiunte di recente al server": ultimi brani salvati da tutti gli
// utenti, già fisici sul disco — niente nuova ricerca/download da Telegram ——
const recentServerSection = $("#recentServerSection");
const recentServerList = $("#recentServerList");

function hideRecentServerSection() {
  if (recentServerSection) recentServerSection.classList.add("hidden");
}

async function loadRecentServer() {
  if (!recentServerList || !recentServerSection) return;
  try {
    const data = await apiJson("/api/library/recent");
    const tracks = data.tracks || [];
    if (!tracks.length) {
      hideRecentServerSection();
      return;
    }
    recentServerList.innerHTML = "";
    tracks.forEach((t) => recentServerList.appendChild(buildRecentServerRow(t)));
    // se nel frattempo si sta cercando, questa sezione non deve spuntare
    // sotto ai risultati: è il contenuto della pagina a riposo
    const cercando = !!(homeSearchInput && homeSearchInput.value.trim());
    recentServerSection.classList.toggle("hidden", cercando);
  } catch (_) {
    hideRecentServerSection();
  }
}

// —— X per pulire la barra e tornare dai risultati alla schermata iniziale ——
const searchClear = $("#searchClear");

function updateSearchClearVisible() {
  if (searchClear) searchClear.classList.toggle("hidden", !queryInput.value.trim());
}

function resetToSearchHome() {
  queryInput.value = "";
  currentSearchId = null;
  updateSearchClearVisible();
  if (resultsHead) resultsHead.classList.add("hidden");
  releaseLazyCovers(trackList);
  if (trackList) trackList.innerHTML = "";
  if (pager) pager.classList.add("hidden");
  if (skeleton) skeleton.classList.add("hidden");
  loadRecentServer();
  renderSearchHistory();
  queryInput.focus();
}

if (searchClear) {
  searchClear.addEventListener("click", () => resetToSearchHome());
}

function buildRecentServerRow(t) {
  const row = document.createElement("div");
  row.className = "track track-recent";
  row.innerHTML = `
    <div class="art">⚡</div>
    <div class="info">
      <div class="title"></div>
      <div class="artist">
        <span class="recent-artist-text"></span>
        <span class="recent-owner-chip">
          <span class="recent-owner-avatar"></span>
          <span class="recent-owner-name"></span>
        </span>
      </div>
    </div>
    <span class="dur"></span>
    <div class="track-actions">
      <button type="button" class="heart-row recent-add-btn heart-fillable" title="Aggiungi alla mia libreria">${heartFillMarkup(18)}</button>
    </div>
  `;
  row.querySelector(".title").textContent = t.title || "track";
  wireArtistName(row.querySelector(".recent-artist-text"), t.artist, t.artist_id, "Artista sconosciuto");
  row.querySelector(".recent-owner-name").textContent = t.owner_name || "?";
  applyAvatarToEl(row.querySelector(".recent-owner-avatar"), t.owner_avatar_url, "🎧");
  row.querySelector(".dur").textContent = t.duration || "";

  const cover = t.cover_url ? mediaAuthUrl(t.cover_url, { bust: false }) : null;
  if (cover) {
    const art = row.querySelector(".art");
    lazyLoadCover(art, cover);
  }

  const playOrToggle = () => {
    if ((nowPlaying.recentTrackId === t.id || nowPlaying.libraryId === t.id) && audio.src) {
      togglePlayPause();
    } else {
      playFromList([recentItemFromTrack(t)], 0);
    }
  };

  const addBtn = row.querySelector(".recent-add-btn");
  // già anche nella libreria di chi guarda (dedup artista+titolo lato
  // server): cuore pieno fin da subito, senza aspettare un click
  if (t.saved_by_me) addBtn.classList.add("on");
  addBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (addBtn.classList.contains("filling") || addBtn.classList.contains("on")) return;
    addBtn.disabled = true;
    startHeartFill(addBtn);
    try {
      const data = await apiJson(
        `/api/library/recent/${t.owner_id}/${t.id}/adopt`,
        null,
        "POST"
      );
      endHeartFill(true, addBtn);
      toast(
        data.already_saved
          ? "Già nella tua libreria"
          : "Aggiunto alla tua libreria"
      );
      if (!viewLibrary.classList.contains("hidden")) loadLibrary();
    } catch (err) {
      endHeartFill(false, addBtn);
      addBtn.disabled = false;
      toast("Errore: " + (err.message || "aggiunta fallita"));
    }
  });

  return enableSwipeToQueue(row, () => recentItemFromTrack(t), {
    onTap: playOrToggle,
  });
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const query = queryInput.value.trim();
  if (!query) return;

  // senza questo, con Keyboard.resize:"none" la tastiera nativa resta aperta
  // sopra il contenuto e copre la bottom nav — "nessun modo di tornare
  // indietro" perché la tab Libreria è lì ma irraggiungibile sotto la tastiera
  dismissKeyboard();
  hideSearchHistory();
  // click su una voce della cronologia: value settato via JS + requestSubmit(),
  // niente evento "input" nel mezzo — va aggiornata qui esplicitamente
  updateSearchClearVisible();

  if (YOUTUBE_URL_RE.test(query)) {
    addSearchHistory(query);
    openYoutubeModal(query);
    return;
  }

  hideRecentServerSection();
  if (resultsHead) resultsHead.classList.remove("hidden");
  addSearchHistory(query);
  setSearching(true);
  setStatus("Cerco…");
  resultsTitle.textContent = `Risultati · ${query}`;
  currentSearchId = null;
  ultimaQueryBrani = query;

  try {
    const data = await apiJson("/api/search", { query });
    showResults(data);
  } catch (err) {
    if (String(err.message || "").includes('"bridge_disconnected"')) {
      setStatus("📡 Bridge Telegram disconnesso — riconnessione automatica in corso, riprova tra poco");
      resultsTitle.textContent = "Bridge offline";
    } else {
      setStatus("Errore: " + err.message);
      resultsTitle.textContent = "Errore";
    }
  } finally {
    setSearching(false);
  }
});

// —— conversione link YouTube → mp3 ——
const ytModal = $("#ytModal");
const ytThumb = $("#ytThumb");
const ytMetaTitle = $("#ytMetaTitle");
const ytMetaSub = $("#ytMetaSub");
const ytFilename = $("#ytFilename");
const ytStatus = $("#ytStatus");
const ytProgressWrap = $("#ytProgressWrap");
const ytProgressBar = $("#ytProgressBar");
const ytCancelBtn = $("#ytCancel");
const ytConvertBtn = $("#ytConvertBtn");
let ytPendingUrl = null;
let ytPollTimer = null;

const YT_STATUS_LABEL = {
  queued: "In coda…",
  downloading: "Scarico audio…",
  converting: "Conversione in mp3…",
  saving: "Salvo in libreria…",
};

function stopYoutubePoll() {
  if (ytPollTimer) {
    clearTimeout(ytPollTimer);
    ytPollTimer = null;
  }
}

function setYoutubeProgress(percent, statusKey) {
  if (ytProgressWrap) ytProgressWrap.classList.remove("hidden");
  if (ytProgressBar) ytProgressBar.style.width = Math.max(0, Math.min(100, percent || 0)) + "%";
  if (ytStatus) ytStatus.textContent = YT_STATUS_LABEL[statusKey] || "In corso…";
}

function closeYoutubeModal() {
  stopYoutubePoll();
  dismissKeyboard();
  if (ytModal) ytModal.classList.add("hidden");
  if (ytProgressWrap) ytProgressWrap.classList.add("hidden");
  if (ytProgressBar) ytProgressBar.style.width = "0%";
  ytPendingUrl = null;
}

async function openYoutubeModal(rawQuery) {
  if (!ytModal) return;
  stopYoutubePoll();
  ytPendingUrl = rawQuery;
  ytThumb.style.backgroundImage = "";
  ytMetaTitle.textContent = "Carico info video…";
  ytMetaSub.textContent = "";
  ytFilename.value = "";
  ytStatus.textContent = "";
  if (ytProgressWrap) ytProgressWrap.classList.add("hidden");
  if (ytProgressBar) ytProgressBar.style.width = "0%";
  ytConvertBtn.disabled = true;
  ytModal.classList.remove("hidden");

  try {
    const info = await apiJson("/api/youtube/info", { url: rawQuery });
    if (ytPendingUrl !== rawQuery) return; // chiuso/cambiato nel frattempo
    ytPendingUrl = info.url || rawQuery;
    ytMetaTitle.textContent = info.title || "YouTube";
    ytMetaSub.textContent = [info.uploader, info.duration]
      .filter(Boolean)
      .join(" · ");
    ytFilename.value = info.title || "";
    if (info.thumbnail) {
      ytThumb.style.backgroundImage = `url(${proxiedCover(info.thumbnail)})`;
    }
    ytConvertBtn.disabled = false;
  } catch (err) {
    ytMetaTitle.textContent = "Errore";
    ytMetaSub.textContent = err.message || "impossibile leggere il video";
  }
}

ytCancelBtn.addEventListener("click", closeYoutubeModal);

async function pollYoutubeJob(jobId) {
  let job;
  try {
    job = await apiJson(`/api/youtube/convert/${jobId}`);
  } catch (err) {
    ytStatus.textContent = "Errore: " + (err.message || "poll fallito");
    ytConvertBtn.disabled = false;
    ytCancelBtn.disabled = false;
    return;
  }

  if (job.status === "done") {
    closeYoutubeModal();
    toast(
      job.already_saved
        ? "Già in libreria — in riproduzione"
        : "Convertito e salvato in libreria"
    );
    if (!viewLibrary.classList.contains("hidden")) loadLibrary();
    await playFromList([libraryItemFromTrack(job.track)], 0);
    return;
  }
  if (job.status === "error") {
    if (ytProgressWrap) ytProgressWrap.classList.add("hidden");
    ytStatus.textContent = "Errore: " + (job.error || "conversione fallita");
    ytConvertBtn.disabled = false;
    ytCancelBtn.disabled = false;
    return;
  }
  setYoutubeProgress(job.percent, job.status);
  ytPollTimer = setTimeout(() => pollYoutubeJob(jobId), 600);
}

ytConvertBtn.addEventListener("click", async () => {
  if (!ytPendingUrl) return;
  ytConvertBtn.disabled = true;
  ytCancelBtn.disabled = true;
  setYoutubeProgress(0, "queued");
  try {
    const { job_id } = await apiJson("/api/youtube/convert", {
      url: ytPendingUrl,
      filename: ytFilename.value.trim(),
    });
    pollYoutubeJob(job_id);
  } catch (err) {
    if (ytProgressWrap) ytProgressWrap.classList.add("hidden");
    ytStatus.textContent = "Errore: " + (err.message || "conversione fallita");
    ytConvertBtn.disabled = false;
    ytCancelBtn.disabled = false;
  }
});

async function changePage(direction) {
  if (!currentSearchId || paging) return;
  paging = true;
  prevPageBtn.disabled = true;
  nextPageBtn.disabled = true;
  setStatus(direction === "next" ? "Carico pagina successiva…" : "Carico pagina precedente…");
  skeleton.classList.remove("hidden");
  releaseLazyCovers(trackList);
  trackList.innerHTML = "";

  try {
    const data = await apiJson("/api/page", {
      search_id: currentSearchId,
      direction,
    });
    showResults(data);
  } catch (err) {
    setStatus("Pagina: " + err.message);
    applyPageState(pageState);
  } finally {
    paging = false;
    skeleton.classList.add("hidden");
    applyPageState(pageState);
  }
}

prevPageBtn.addEventListener("click", () => changePage("prev"));
nextPageBtn.addEventListener("click", () => changePage("next"));

// —— library ——
function normalizeLibQuery(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function filterLibraryTracks(tracks, query) {
  const q = normalizeLibQuery(query);
  if (!q) return tracks.slice();
  const parts = q.split(/\s+/).filter(Boolean);
  return tracks.filter((t) => {
    const hay = normalizeLibQuery(`${t.title || ""} ${t.artist || ""}`);
    return parts.every((p) => hay.includes(p));
  });
}

function updateLibSearchChrome() {
  if (!libSearch || !libSearchClear) return;
  const has = !!(libSearch.value && libSearch.value.trim());
  libSearchClear.classList.toggle("hidden", !has);
}

function renderLibraryTracks(tracks, { query = "" } = {}) {
  releaseLazyCovers(libList);
  libList.innerHTML = "";
  const total = libraryTracksCache.length;
  if (!total) {
    libStatus.textContent = "Nessun brano salvato — premi ♥ sul player";
    if (libSearchWrap) libSearchWrap.classList.add("hidden");
    return;
  }
  if (libSearchWrap) libSearchWrap.classList.remove("hidden");

  if (!tracks.length) {
    libStatus.textContent = query
      ? `Nessun risultato per “${query.trim()}” · ${total} salvati`
      : `${total} brani`;
    return;
  }

  // A riposo la riga non c'è: il conteggio sta già nell'intestazione sotto
  // il titolo, e il promemoria dei gesti («tap play · swipe → coda · cerca
  // ↑») che restava sul telefono l'ha tolto Vitto il 04/10 (da desktop era
  // già via dal 23/09). Mentre filtri resta: lì dice quanti ne restano.
  libStatus.textContent = query ? `${tracks.length} di ${total} · filtra i salvati` : "";

  tracks.forEach((t, i) => {
    const row = document.createElement("div");
    row.className = "track";
    row.dataset.id = t.id;
    row.innerHTML = `
      <span class="num">${i + 1}</span>
      <div class="art">⚡</div>
      <div class="info">
        <div class="title"></div>
        <div class="artist"></div>
      </div>
      <span class="dur"></span>
      <div class="track-actions">
        <button type="button" class="pl-add-btn" title="In playlist">${iconPlaylistAdd()}</button>
        <button type="button" class="heart-row on heart-filled" title="Rimuovi dai salvati">${iconHeart(true)}</button>
      </div>
    `;
    row.querySelector(".title").textContent = t.title || "—";
    wireArtistName(row.querySelector(".artist"), t.artist, t.artist_id);
    row.querySelector(".dur").textContent = t.duration || "";
    if (t.cover_url) {
      const art = row.querySelector(".art");
      lazyLoadCover(art, mediaAuthUrl(t.cover_url, { bust: false }));
    }
    row.querySelector(".pl-add-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      openPlaylistPicker({
        library_id: t.id,
        title: t.title,
        artist: t.artist,
      });
    });
    row.querySelector(".heart-row").addEventListener("click", (e) => {
      e.stopPropagation();
      scheduleLibraryRemove(t);
    });
    montaMenuRiga(row, {
      titolo: t.title, artista: t.artist, artistId: t.artist_id,
      libraryId: t.id, item: () => libraryItemFromTrack(t),
    });
    const wrap = enableSwipeToQueue(row, () => libraryItemFromTrack(t), {
      onTap: () => playLibraryTrack(t),
    });
    libList.appendChild(wrap);
  });
}

function applyLibraryFilter() {
  const q = libSearch ? libSearch.value : "";
  const filtered = filterLibraryTracks(libraryTracksCache, q);
  renderLibraryTracks(filtered, { query: q });
  updateLibSearchChrome();
}

async function loadLibrary() {
  if (libLoadingSpinner) libLoadingSpinner.classList.remove("hidden");
  libStatus.textContent = "Carico salvati…";
  releaseLazyCovers(libList);
  libList.innerHTML = "";
  try {
    const data = await apiJson("/api/library");
    // escludi remove ancora in finestra undo
    libraryTracksCache = (data.tracks || []).filter(
      (t) => !pendingLibraryRemoves.has(t.id)
    );
    applyAvatarToEl(libHeroAvatar, authState.user && authState.user.avatar_url, "⚡");
    setHeroMetaText(libHeroMetaText, libraryTracksCache);
    applyLibraryFilter();
    refreshLibOfflineButton();
  } catch (err) {
    libStatus.textContent = "Errore: " + err.message;
  } finally {
    if (libLoadingSpinner) libLoadingSpinner.classList.add("hidden");
  }
}

// —— playlist chart/Deezer salvate come segnalibro (vedi saved_playlists.py):
// il download in blocco vive nella action row del dettaglio (stessa
// posizione/icona del download offline delle playlist vere, plOfflineW),
// visibile solo dopo aver salvato il segnalibro col cuoricino. Primo tap =
// download in blocco lato server (ricerca vera per ogni brano mai
// posseduto, vedi playlist_downloads.py); a fine lavoro il segnalibro
// diventa una playlist vera (playlists.create) e si torna alla griglia. ——
async function loadSavedLazyPlaylists() {
  try {
    const data = await apiJson("/api/saved-playlists");
    const items = data.items || [];
    return items.filter((it) => !pendingSavedLazyRemoves.has(`${it.kind}:${it.ref_id}`));
  } catch (_) {
    return [];
  }
}

let _lazyDownloadPollTimer = null;

function stopLazyDownloadPoll() {
  clearInterval(_lazyDownloadPollTimer);
  _lazyDownloadPollTimer = null;
}

/** updatePlOfflineButtonUi riusata (anello/spunta) ma con testo corretto:
 * qui non è un download offline sul device, è una ricerca in blocco lato
 * server — il tooltip non deve dire "per l'ascolto offline". */
function updateLazyDownloadUi(state, pct) {
  updatePlOfflineButtonUi(state, pct, plOfflineW);
  // qui (lavoro sul server, niente foglio) il tasto resta bloccato mentre
  // gira: un secondo tocco rilancerebbe il download in blocco
  plOfflineW.btn.disabled = state === "busy";
  plOfflineW.btn.title =
    state === "busy" ? "Download in corso…" : "Scarica tutti i brani (ricerca Telegram in blocco)";
  plOfflineW.btn.setAttribute("aria-label", plOfflineW.btn.title);
}

/** Mostra/aggiorna plOfflineW per il chart/playlist lazy aperto ORA — solo
 * se già salvata (il download in blocco non ha senso su un segnalibro che
 * non esiste). Se un download era già in corso, riprende subito il poll. */
function refreshLazyDownloadButton(saved, download) {
  if (!plOfflineW.btn) return;
  stopLazyDownloadPoll();
  if (!saved) {
    plOfflineW.btn.classList.add("hidden");
    return;
  }
  plOfflineW.btn.classList.remove("hidden");
  const dl = download || {};
  if (dl.status === "running") {
    const pct = dl.total ? (100 * (dl.done || 0)) / dl.total : 0;
    updateLazyDownloadUi("busy", pct);
    startLazyDownloadPoll();
  } else {
    updateLazyDownloadUi("idle", 0);
  }
}

async function startLazyDownload() {
  if (!openLazyKind || plOfflineW.btn.disabled) return;
  try {
    const data = await apiJson(
      `/api/saved-playlists/${openLazyKind === "chart" ? "chart" : "deezer_playlist"}/${encodeURIComponent(openLazyId)}/download`,
      null,
      "POST"
    );
    updateLazyDownloadUi("busy", 0);
    startLazyDownloadPoll();
  } catch (err) {
    toast("Errore: " + (err.message || "avvio fallito"));
  }
}

/** Poll finché resti su questa vista lazy — si ferma da sola se cambi
 * brano/playlist/vista (guardia openLazyKind) o a fine lavoro. */
function startLazyDownloadPoll() {
  stopLazyDownloadPoll();
  const kind = openLazyKind;
  const refId = openLazyId;
  _lazyDownloadPollTimer = setInterval(async () => {
    if (openLazyKind !== kind || openLazyId !== refId) {
      stopLazyDownloadPoll();
      return;
    }
    let data;
    try {
      data = await apiJson(
        `/api/saved-playlists/${kind === "chart" ? "chart" : "deezer_playlist"}/${encodeURIComponent(refId)}/download`
      );
    } catch (_) {
      // 404 atteso a fine lavoro: il segnalibro è stato promosso a playlist
      // vera (o rimosso) — in entrambi i casi si torna alla griglia
      stopLazyDownloadPoll();
      toast("Download completato — ora è una playlist");
      btnPlBack.click();
      return;
    }
    const dl = data.download || {};
    if (dl.status === "running") {
      const pct = dl.total ? (100 * (dl.done || 0)) / dl.total : 0;
      updateLazyDownloadUi("busy", pct);
    } else if (dl.status === "error") {
      stopLazyDownloadPoll();
      updateLazyDownloadUi("idle", 0);
      toast("Download fallito: " + (dl.error || "errore sconosciuto"));
    } else if (dl.status === "done") {
      stopLazyDownloadPoll();
      btnPlBack.click();
    }
  }, 3000);
}

// Debounce del filtro libreria: applyLibraryFilter ricostruisce TUTTA la
// lista (innerHTML + una riga per brano, con listener e swipe), e senza
// attesa girava ad ogni singolo tasto premuto — su una libreria da
// centinaia di brani erano N ricostruzioni complete per una query di N
// lettere. updateLibSearchChrome resta invece immediata: è solo la "×" di
// cancellazione, ritardarla si vedrebbe.
let _libSearchDebounce = null;
if (libSearch) {
  libSearch.addEventListener("input", () => {
    updateLibSearchChrome();
    clearTimeout(_libSearchDebounce);
    _libSearchDebounce = setTimeout(applyLibraryFilter, 150);
  });
  libSearch.addEventListener("blur", () => {
    updateLibSearchChrome();
  });
}
if (libSearchClear) {
  libSearchClear.addEventListener("click", () => {
    if (!libSearch) return;
    libSearch.value = "";
    applyLibraryFilter();
    libSearch.focus();
  });
}

// —— ricerca locale nella tracklist aperta (playlist vera o chart/Deezer
// lazy): filtra le righe già renderizzate in #plTracks, funziona per
// entrambe visto che condividono lo stesso markup (.track > .title/.artist). ——
function applyPlTrackFilter() {
  if (!plTracks) return;
  const q = (plTrackSearch && plTrackSearch.value ? plTrackSearch.value : "").trim().toLowerCase();
  plTracks.querySelectorAll(".track").forEach((row) => {
    if (!q) {
      row.classList.remove("hidden");
      return;
    }
    const title = (row.querySelector(".title")?.textContent || "").toLowerCase();
    const artist = (row.querySelector(".artist")?.textContent || "").toLowerCase();
    row.classList.toggle("hidden", !title.includes(q) && !artist.includes(q));
  });
}

/** Filtro della pagina artista. Diverso da quello delle playlist perché qui
 * la lista è "accorciata": dopo i primi ARTIST_COLLAPSED_COUNT le righe sono
 * nascoste (il resto sta in "Mostra tutti"). Cercando si guarda TUTTA la
 * lista, compreso il catalogo che arriva dopo; a campo vuoto si torna ai
 * primi cinque e al tasto "Mostra tutti". */
function applyArtistTrackFilter() {
  if (!artistTracksEl) return;
  const q = (artistTrackSearch && artistTrackSearch.value ? artistTrackSearch.value : "").trim().toLowerCase();
  [...artistTracksEl.children].forEach((row, i) => {
    if (!q) {
      row.classList.toggle("hidden", i >= artistCollapsedCount());
      return;
    }
    const title = (row.querySelector(".title")?.textContent || "").toLowerCase();
    const artist = (row.querySelector(".artist")?.textContent || "").toLowerCase();
    row.classList.toggle("hidden", !title.includes(q) && !artist.includes(q));
  });
  if (artistShowAllBtn) {
    artistShowAllBtn.classList.toggle("hidden", !!q || _artistTracks.length <= artistCollapsedCount());
  }
}
/** Pagina nuova, ricerca vuota e lente chiusa. */
function resetArtistTrackFilter() {
  if (artistTrackSearch) artistTrackSearch.value = "";
  if (artistTrackSearchClear) artistTrackSearchClear.classList.add("hidden");
  const wrap = document.getElementById("artistTrackSearchWrap");
  if (wrap) wrap.classList.remove("crk-aperta");
}
if (artistTrackSearch) {
  artistTrackSearch.addEventListener("input", () => {
    if (artistTrackSearchClear) {
      artistTrackSearchClear.classList.toggle("hidden", !artistTrackSearch.value.trim());
    }
    applyArtistTrackFilter();
  });
}
if (artistTrackSearchClear) {
  artistTrackSearchClear.addEventListener("click", (e) => {
    // il click non deve arrivare al contenitore della lente
    e.stopPropagation();
    if (!artistTrackSearch) return;
    artistTrackSearch.value = "";
    artistTrackSearchClear.classList.add("hidden");
    applyArtistTrackFilter();
    artistTrackSearch.focus();
  });
}

/** Mostra la barra e la resetta — chiamata da chi apre UNA tracklist
 * (playlist vera o lazy), mai dalla griglia. */
function showPlTrackSearch() {
  if (plTrackSearchWrap) plTrackSearchWrap.classList.remove("hidden");
  if (plTrackSearch) plTrackSearch.value = "";
  if (plTrackSearchClear) plTrackSearchClear.classList.add("hidden");
}

function hidePlTrackSearch() {
  if (plTrackSearchWrap) plTrackSearchWrap.classList.add("hidden");
}

if (plTrackSearch) {
  plTrackSearch.addEventListener("input", () => {
    if (plTrackSearchClear) {
      plTrackSearchClear.classList.toggle("hidden", !plTrackSearch.value.trim());
    }
    applyPlTrackFilter();
  });
}
if (plTrackSearchClear) {
  plTrackSearchClear.addEventListener("click", () => {
    if (!plTrackSearch) return;
    plTrackSearch.value = "";
    plTrackSearchClear.classList.add("hidden");
    applyPlTrackFilter();
    plTrackSearch.focus();
  });
}

// —— ricerca locale nella griglia "La tua libreria" (#plList): filtra le
// righe già renderizzate via data-search-name, stesso pattern di
// applyPlTrackFilter sopra ma sulle .pl-row invece che sui .track. ——
function applyLibRowFilter() {
  if (!plList) return;
  const q = (plLibSearch && plLibSearch.value ? plLibSearch.value : "").trim().toLowerCase();
  plList.querySelectorAll(".pl-row").forEach((row) => {
    row.classList.toggle("hidden", !!q && !(row.dataset.searchName || "").includes(q));
  });
}

/** Da chiamare ogni volta che #plList viene ripopolato (cambio vista, refresh)
 * — svuota il filtro rimasto da una visita precedente, altrimenti righe nuove
 * che non combaciano restano nascoste senza motivo apparente. */
function resetPlLibSearch() {
  if (plLibSearch) plLibSearch.value = "";
  if (plLibSearchClear) plLibSearchClear.classList.add("hidden");
  // da desktop è una lente: campo vuoto = si richiude, a meno che non ci
  // stia scrivendo qualcuno proprio adesso
  if (plLibSearchWrap && document.activeElement !== plLibSearch) {
    plLibSearchWrap.classList.remove("crk-aperta");
  }
  applyLibRowFilter();
}

if (plLibSearch) {
  plLibSearch.addEventListener("input", () => {
    if (plLibSearchClear) {
      plLibSearchClear.classList.toggle("hidden", !plLibSearch.value.trim());
    }
    applyLibRowFilter();
  });
}
if (plLibSearchClear) {
  plLibSearchClear.addEventListener("click", () => {
    if (!plLibSearch) return;
    plLibSearch.value = "";
    plLibSearchClear.classList.add("hidden");
    applyLibRowFilter();
    plLibSearch.focus();
  });
}


document.addEventListener("keydown", (e) => {
  const tag = (e.target && e.target.tagName) || "";
  if (tag === "INPUT" || tag === "TEXTAREA" || e.target.isContentEditable) return;
  // dopo il primo via al gioco (Home da computer) lo spazio è suo: salta,
  // e non mette più in pausa la musica (Vitto 08/10)
  if (e.code === "Space" && dinoSpazio(e)) return;
  // nel minigioco del boss anche le frecce (senza Ctrl/Cmd: quelle cambiano brano)
  if (e.code.startsWith("Arrow") && dinoBossFreccia(e)) return;
  if (e.code === "Space") {
    if (btnPlay.disabled) return;
    e.preventDefault();
    btnPlay.click();
  } else if (e.code === "ArrowRight" && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    playNext();
  } else if (e.code === "ArrowLeft" && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    playPrev();
  }
});

// ─── PLAYLISTS ───────────────────────────────────────────────────

btnAddPl.addEventListener("click", () => {
  if (btnAddPl.disabled) return;
  openPlaylistPicker({
    library_id: nowPlaying.libraryId || null,
    token: nowPlaying.token || null,
    title: nowPlaying.title,
    artist: nowPlaying.artist,
  });
});

function openPlaylistPicker(payload) {
  pendingAddToPl = payload;
  plModalTrack.textContent = `${payload.artist || ""} — ${payload.title || ""}`.replace(
    /^ — | — $/g,
    ""
  );
  plModal.classList.remove("hidden");
  plModalNewName.value = "";
  refreshModalPlaylists();
}

function closePlaylistPicker() {
  plModal.classList.add("hidden");
  pendingAddToPl = null;
}

plModalClose.addEventListener("click", closePlaylistPicker);
plModal.addEventListener("click", (e) => {
  if (e.target === plModal) closePlaylistPicker();
});

async function refreshModalPlaylists() {
  plModalList.innerHTML = "";
  try {
    const data = await apiJson("/api/playlists");
    const list = data.playlists || [];
    if (!list.length) {
      plModalList.innerHTML =
        '<li class="pl-picker-empty">Nessuna playlist ancora — creane una qui sotto</li>';
      return;
    }
    list.forEach((p) => {
      const li = document.createElement("li");
      li.className = "pl-picker-row";
      li.innerHTML = `
        <div class="pl-picker-cover">▤</div>
        <div class="pl-picker-info">
          <div class="pl-picker-name"></div>
          <div class="pl-picker-count"></div>
        </div>
        <span class="pl-picker-add" aria-hidden="true">+</span>
      `;
      li.querySelector(".pl-picker-name").textContent = p.name;
      li.querySelector(".pl-picker-count").textContent = `${p.track_count || 0} brani`;
      // copertina della playlist (custom caricata, o auto dal primo brano) —
      // stessa via auth dei card della griglia playlist, vedi loadPlaylists
      if (p.cover_url) {
        const cov = li.querySelector(".pl-picker-cover");
        lazyLoadCover(cov, mediaAuthUrl(p.cover_url, { bust: false }));
      }
      li.addEventListener("click", () => addPendingToPlaylist(p.id, p.name));
      plModalList.appendChild(li);
    });
  } catch (err) {
    plModalList.innerHTML = `<li class="pl-picker-empty">Errore: ${escapeHtml(err.message)}</li>`;
  }
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ═══════════════════════════════════════════════════════════
// "Le tue playlist" nella sidebar — stessa roba della tab "La tua
// libreria", in forma compatta. Nessuna logica di apertura duplicata:
// ogni riga richiama la funzione che gia' esiste (openSavedLibrary,
// openDiscoveryWeekly, openArtist, openPlaylist, openChart...).
// ═══════════════════════════════════════════════════════════
let _sidebarLibBusy = false;

function _sideRow({ name, sub, coverUrl, round, fallback, onClick, coverClass, eager }) {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "side-item";
  row.innerHTML = `
    <span class="side-item-cover${round ? " round" : ""}"></span>
    <span class="side-item-text">
      <span class="side-item-name"></span>
      <span class="side-item-sub"></span>
    </span>
  `;
  const cov = row.querySelector(".side-item-cover");
  if (coverClass) cov.classList.add(coverClass);
  row.querySelector(".side-item-name").textContent = name || "—";
  row.querySelector(".side-item-sub").textContent = sub || "";
  if (coverUrl && eager) {
    // le due righe fisse in cima sono sempre a schermo: differirle non
    // serve a niente e si vedrebbe il buco al primo disegno
    cov.style.backgroundImage = `url(${coverUrl})`;
    cov.textContent = "";
  } else if (coverUrl) {
    lazyLoadCover(cov, coverUrl);
  } else {
    cov.textContent = fallback || "\u25a4";
  }
  row.addEventListener("click", onClick);
  return row;
}

async function renderSidebarLibrary() {
  const list = document.getElementById("sideLibList");
  if (!list || _sidebarLibBusy) return;
  // solo ad accesso fatto: da sloggati non c'e' niente da mostrare
  if (!(authState && authState.authenticated)) {
    list.innerHTML = "";
    return;
  }
  _sidebarLibBusy = true;
  try {
    releaseLazyCovers(list);
    const frag = document.createDocumentFragment();

    frag.appendChild(_sideRow({
      name: "Brani salvati",
      // niente conteggio: la sidebar si disegna appena fatto l'accesso,
      // quando libraryTracksCache e' ancora vuota, e mostrava "0 brani".
      // Tanto il numero vero si vede aprendola, che e' anche cio' che
      // fa caricare i dati.
      sub: "La tua scorta",
      fallback: "\u2665",
      coverClass: "saved",
      onClick: () => openSavedLibrary(),
    }));
    frag.appendChild(_sideRow({
      name: "Discovery Weekly",
      sub: "Solo per te",
      coverUrl: "/icons/discovery-weekly-cover.webp?v=2",
      eager: true,
      onClick: () => openDiscoveryWeekly(),
    }));

    // salvati (artisti, playlist Deezer, classifiche): stesso smistamento
    // per "kind" di buildSavedLazyCard, vedi li'
    const saved = await loadSavedLazyPlaylists();
    for (const item of saved) {
      const riga = frag.appendChild(_sideRow({
        name: item.label,
        sub: item.kind === "artist" ? "Artista" : `${libKindLabel(item.kind)} \u2022 ${item.track_count || 0} brani`,
        coverUrl: item.cover_url ? proxiedCover(item.cover_url) : null,
        round: item.kind === "artist",
        onClick: () => {
          if (item.kind === "artist") { openArtist(Number(item.ref_id)); return; }
          activatePlaylistsShell();
          if (item.kind === "chart") openChart(item.ref_id);
          else openDeezerPlaylist(Number(item.ref_id));
        },
      }));
      // stessa chiave delle righe della libreria (buildSavedLazyCard)
      riga.dataset.pinKey = `${item.kind}:${item.ref_id}`;
    }

    // playlist proprie
    try {
      const data = await apiJson("/api/playlists");
      for (const pl of data.playlists || []) {
        const riga = frag.appendChild(_sideRow({
          name: pl.name,
          sub: `${pl.track_count || 0} brani`,
          coverUrl: pl.cover_url ? mediaAuthUrl(pl.cover_url, { bust: false }) : null,
          onClick: () => { activatePlaylistsShell(); openPlaylist(pl.id); },
        }));
        riga.dataset.pinKey = `playlist:${pl.id}`;
      }
    } catch (_) {}

    list.innerHTML = "";
    list.appendChild(frag);
    ordinaPerPin(list, ".side-item[data-pin-key]");
  } catch (_) {
    // una sidebar vuota e' meglio di un errore a schermo: la tab
    // "La tua libreria" resta la strada principale
  } finally {
    _sidebarLibBusy = false;
  }
}

/** Aggiorna le view aperte senza hard refresh */
async function refreshAfterLibraryChange() {
  if (!viewLibrary.classList.contains("hidden")) {
    await loadLibrary();
  }
  renderSidebarLibrary();
}

async function refreshAfterPlaylistChange(pid) {
  renderSidebarLibrary();
  if (viewPlaylists.classList.contains("hidden")) return;
  if (pid && (openPlaylistId === pid || openPlaylistId == null)) {
    // se sei dentro quella playlist → ricarica i brani; se sei sulla griglia → ricarica card
    if (openPlaylistId === pid) {
      await openPlaylist(pid);
    } else {
      await loadPlaylists();
    }
  } else if (openPlaylistId) {
    await openPlaylist(openPlaylistId);
  } else {
    await loadPlaylists();
  }
}

async function addPendingToPlaylist(pid, name) {
  if (!pendingAddToPl) return;
  const body = {};
  if (pendingAddToPl.library_id) body.library_id = pendingAddToPl.library_id;
  else if (pendingAddToPl.token) body.token = pendingAddToPl.token;
  else {
    toast("Salva prima il brano con ♥");
    return;
  }
  try {
    const pl = await apiJson(`/api/playlists/${pid}/tracks`, body);
    toast(`+ ${name} (${pl.track_count || 0})`);

    // token → salvato anche in libreria: aggiorna cuore + id
    if (pl.added_library_id) {
      nowPlaying.libraryId = pl.added_library_id;
      setLikeUi(true);
    } else if (body.token) {
      setLikeUi(true);
    }

    closePlaylistPicker();
    await refreshAfterPlaylistChange(pid);
    if (body.token) await refreshAfterLibraryChange();
  } catch (err) {
    toast("Playlist: " + err.message);
  }
}

plModalCreate.addEventListener("click", async () => {
  const name = plModalNewName.value.trim() || "Nuova playlist";
  try {
    const pl = await apiJson("/api/playlists", { name });
    if (pendingAddToPl) {
      await addPendingToPlaylist(pl.id, pl.name);
    } else {
      toast(`Creata · ${pl.name}`);
      closePlaylistPicker();
      if (!viewPlaylists.classList.contains("hidden")) await loadPlaylists();
    }
  } catch (err) {
    toast("Crea: " + err.message);
  }
});

const newPlaylistModal = $("#newPlaylistModal");
const newPlaylistModalTitle = $("#newPlaylistModalTitle");
const newPlaylistName = $("#newPlaylistName");
const newPlaylistCancel = $("#newPlaylistCancel");
const newPlaylistConfirm = $("#newPlaylistConfirm");
/** null = crea nuova; stringa = id playlist da rinominare */
let _renamePlaylistTarget = null;

function openNewPlaylistModal() {
  if (!newPlaylistModal) return;
  _renamePlaylistTarget = null;
  if (newPlaylistModalTitle) newPlaylistModalTitle.textContent = "Nuova playlist";
  if (newPlaylistConfirm) newPlaylistConfirm.textContent = "Crea";
  newPlaylistName.value = "Nuova playlist";
  newPlaylistModal.classList.remove("hidden");
  setTimeout(() => {
    newPlaylistName.focus();
    newPlaylistName.select();
  }, 30);
}

function openRenamePlaylistModal(pid, currentName) {
  if (!newPlaylistModal) return;
  _renamePlaylistTarget = pid;
  if (newPlaylistModalTitle) newPlaylistModalTitle.textContent = "Rinomina playlist";
  if (newPlaylistConfirm) newPlaylistConfirm.textContent = "Salva";
  newPlaylistName.value = currentName || "";
  newPlaylistModal.classList.remove("hidden");
  setTimeout(() => {
    newPlaylistName.focus();
    newPlaylistName.select();
  }, 30);
}

function closeNewPlaylistModal() {
  dismissKeyboard();
  if (newPlaylistModal) newPlaylistModal.classList.add("hidden");
  _renamePlaylistTarget = null;
}

async function confirmNewPlaylist() {
  const name = (newPlaylistName.value || "").trim() || "Nuova playlist";
  const renameTarget = _renamePlaylistTarget;
  closeNewPlaylistModal();
  try {
    if (renameTarget) {
      const pl = await apiJson(`/api/playlists/${renameTarget}`, { name }, "PATCH");
      toast(`Rinominata · ${pl.name}`);
      if (openPlaylistId === renameTarget) openPlaylist(renameTarget);
      else loadPlaylists();
    } else {
      const pl = await apiJson("/api/playlists", { name });
      toast(`Creata · ${pl.name}`);
      openPlaylistId = null;
      loadPlaylists();
    }
  } catch (err) {
    toast("Salva: " + err.message);
  }
}

btnPlCreate.addEventListener("click", openNewPlaylistModal);
if (newPlaylistCancel) newPlaylistCancel.addEventListener("click", closeNewPlaylistModal);
if (newPlaylistConfirm) newPlaylistConfirm.addEventListener("click", confirmNewPlaylist);
if (newPlaylistModal) {
  newPlaylistModal.addEventListener("click", (e) => {
    if (e.target === newPlaylistModal) closeNewPlaylistModal();
  });
}
if (newPlaylistName) {
  newPlaylistName.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      confirmNewPlaylist();
    } else if (e.key === "Escape") {
      closeNewPlaylistModal();
    }
  });
}

/** Transizione "indietro" (swipe da bordo o freccetta): slide da sinistra,
 * stessa direzione dello swipe — al posto del fade+risalita usato in avanti. */
function playBackAnim(el) {
  if (!el) return;
  el.classList.remove("back-enter");
  void el.offsetWidth; // forza reflow: ri-attiva la keyframe
  el.classList.add("back-enter");
}

btnPlBack.addEventListener("click", () => {
  openPlaylistId = null;
  if (openLazyKind) {
    dimenticaListaPigra();
    showView("home");
    playBackAnim(viewHome);
    return;
  }
  // offline: "Home" non è raggiungibile (serve rete) — si torna sempre
  // alla grid delle playlist scaricate, a prescindere da chi le possiede
  if (appOfflineMode) {
    openPlaylistOwnerId = null;
    setMobileTopbarVisible(true);
    renderOfflinePlaylistsGrid();
    playBackAnim(plList);
    return;
  }
  if (openPlaylistOwnerId) {
    openPlaylistOwnerId = null;
    showView("home");
    playBackAnim(viewHome);
    return;
  }
  setMobileTopbarVisible(true);
  loadPlaylists();
  playBackAnim(plList);
});

if (btnLibBack) {
  btnLibBack.addEventListener("click", () => {
    showView("playlists");
    playBackAnim(plList);
  });
}

if (btnLibPlay) {
  btnLibPlay.addEventListener("click", () => {
    const q = queue.index >= 0 ? queue.items[queue.index] : null;
    if (q && q.source === "library") {
      // già sui salvati: pausa/riprendi da dove eri, non ricominciare
      togglePlayPause();
      return;
    }
    if (!libraryTracksCache.length) {
      toast("Nessun brano salvato");
      return;
    }
    const start = shuffleOn
      ? libraryTracksCache[Math.floor(Math.random() * libraryTracksCache.length)]
      : libraryTracksCache[0];
    playLibraryTrack(start);
  });
}

btnPlPlay.addEventListener("click", () => {
  if (openLazyKind) {
    playLazyFrom(shuffleStartIndex(_openLazyTracks.length));
    return;
  }
  if (!openPlaylistId) return;
  if (openPlaylistOwnerId) {
    playOpenHomePlaylist();
    return;
  }
  playOpenPlaylist();
});

async function uploadPlaylistCover(pid, blob) {
  const fd = new FormData();
  fd.append("file", blob, "cover.jpg");
  try {
    const res = await fetch(apiUrl(`/api/playlists/${pid}/cover`), {
      method: "POST",
      headers: authHeaders(),
      credentials: "same-origin",
      body: fd,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || "Upload fallito");
    toast("Copertina aggiornata");
    if (openPlaylistId === pid) openPlaylist(pid);
    else loadPlaylists();
  } catch (e) {
    toast("Copertina: " + (e.message || e));
  }
}

function openPlaylistCoverPicker(pid) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/png,image/jpeg,image/webp";
  input.addEventListener("change", () => {
    const file = input.files && input.files[0];
    if (file) openAvatarCropModal(file, (blob) => uploadPlaylistCover(pid, blob));
  });
  input.click();
}

/** Elimina con "Annulla" (stessa UX del rimuovi-brano-salvato): niente confirm() bloccante. */
const pendingPlaylistDeletes = new Map();

function schedulePlaylistDelete(pid, name) {
  if (pendingPlaylistDeletes.has(pid)) return;
  const timer = setTimeout(async () => {
    pendingPlaylistDeletes.delete(pid);
    try {
      await apiJson(`/api/playlists/${pid}`, null, "DELETE");
    } catch (err) {
      toast("Elimina: " + err.message);
    }
  }, UNDO_MS);
  pendingPlaylistDeletes.set(pid, { timer, name });
  loadPlaylists();
  toast(`Eliminata · ${name}`, {
    actionLabel: "Annulla",
    duration: UNDO_MS,
    onAction: () => {
      const entry = pendingPlaylistDeletes.get(pid);
      if (entry) clearTimeout(entry.timer);
      pendingPlaylistDeletes.delete(pid);
      loadPlaylists();
    },
  });
}

let _openPlCardMenu = null;
/* La riga che ha il menu aperto va sollevata sopra le altre: nel guscio Mac
 * le righe della libreria hanno backdrop-filter, che crea un contesto di
 * impilamento — lo z-index:20 del menu resta quindi prigioniero della sua
 * riga e le righe successive (più avanti nel DOM) gli passano sopra. Il
 * menu finiva "sotto i banner degli elementi" (Vitto 19/09). Alzando la
 * riga sale con lei anche il suo menu. */
function alzaRigaDelMenu(menu) {
  document
    .querySelectorAll(".pl-row-menu-open")
    .forEach((r) => r.classList.remove("pl-row-menu-open"));
  const riga = menu && menu.closest(".pl-row, .track");
  // se la riga sta dentro un contenitore di swipe è QUELLO che va marcato:
  // ha overflow:hidden (serve a nascondere lo sfondo mentre trascini) e
  // taglierebbe via il menu che esce sotto la riga
  const bersaglio = (riga && riga.closest(".track-swipe")) || riga;
  if (bersaglio) bersaglio.classList.add("pl-row-menu-open");
}

function closePlCardMenu() {
  if (_openPlCardMenu) {
    _openPlCardMenu.classList.remove("open");
    _openPlCardMenu = null;
  }
  chiudiSchedaRiga();
  document
    .querySelectorAll(".pl-row-menu-open")
    .forEach((r) => r.classList.remove("pl-row-menu-open"));
}

/* —— Scheda di una riga della libreria, sul telefono (05/10) ——
 * Vitto: «se tieni premuto, al posto di aprire la finestrella a cazzo, apri
 * una finestra sopra lo schermo con il nome della playlist, la sua icona e
 * sotto le sue impostazioni, sempre centrata; se l'utente clicca altrove
 * annulla». I tasti sono quelli della finestrella della riga (pin, rinomina,
 * copertina, elimina, rimuovi…): il nodo .pl-card-menu viene SPOSTATO qui
 * dentro, con i suoi gestori, e alla chiusura torna al suo posto. Ogni
 * tasto chiama già closePlCardMenu, che chiude anche la scheda.
 * Da desktop resta il "⋯" col menu sotto la card. */
let _schedaRiga = null;      // { velo, card, testa, corpo }
let _schedaRitorno = null;   // { menu, wrap } da rimettere a posto
let _schedaGiuSulVelo = false;

function costruisciSchedaRiga() {
  if (_schedaRiga) return _schedaRiga;
  const velo = document.createElement("div");
  velo.className = "lib-scheda";
  velo.setAttribute("role", "dialog");
  velo.setAttribute("aria-modal", "true");
  velo.innerHTML = `
    <div class="lib-scheda-card">
      <div class="lib-scheda-testa">
        <div class="lib-scheda-cover"></div>
        <div class="lib-scheda-testo">
          <div class="lib-scheda-nome"></div>
          <div class="lib-scheda-meta"></div>
        </div>
      </div>
      <div class="lib-scheda-corpo"></div>
    </div>
  `;
  document.body.appendChild(velo);
  const card = velo.querySelector(".lib-scheda-card");
  // "clicca altrove annulla" — ma solo se il dito è sceso sul velo DOPO
  // l'apertura: staccando il dito dal tieni-premuto iOS manda un click
  // proprio qui, sul velo appena comparso, e la scheda si richiuderebbe da sola
  velo.addEventListener("pointerdown", (e) => { _schedaGiuSulVelo = e.target === velo; });
  velo.addEventListener("click", (e) => {
    e.stopPropagation();
    if (e.target === velo && _schedaGiuSulVelo) closePlCardMenu();
    _schedaGiuSulVelo = false;
  });
  // dentro la card (fuori dai tasti) non si chiude
  card.addEventListener("click", (e) => e.stopPropagation());
  _schedaRiga = {
    velo,
    card,
    cover: velo.querySelector(".lib-scheda-cover"),
    nome: velo.querySelector(".lib-scheda-nome"),
    meta: velo.querySelector(".lib-scheda-meta"),
    corpo: velo.querySelector(".lib-scheda-corpo"),
  };
  return _schedaRiga;
}

function apriSchedaRiga(riga, menu) {
  const sc = costruisciSchedaRiga();
  // copertina: la stessa della riga (sfondo già caricato, tonda per gli artisti)
  sc.cover.innerHTML = "";
  const cov = riga.querySelector(".pl-row-cover");
  if (cov) sc.cover.appendChild(cov.cloneNode(true));
  const nome = riga.querySelector(".pl-row-name");
  sc.nome.textContent = nome ? nome.textContent : "";
  // innerText: solo il testo che si vede (c'è uno span che esiste solo da desktop)
  const meta = riga.querySelector(".pl-row-meta");
  sc.meta.textContent = meta ? meta.innerText.trim() : "";
  _schedaRitorno = { menu, wrap: menu.parentNode };
  menu.classList.remove("open", "centered");
  sc.corpo.appendChild(menu);
  _openPlCardMenu = menu;
  _schedaGiuSulVelo = false;
  sc.velo.classList.add("aperta");
}

function chiudiSchedaRiga() {
  if (!_schedaRiga || !_schedaRiga.velo.classList.contains("aperta")) return;
  _schedaRiga.velo.classList.remove("aperta");
  const r = _schedaRitorno;
  _schedaRitorno = null;
  // il menu torna nella sua riga dopo la dissolvenza, così non sparisce di colpo
  if (r && r.wrap) {
    setTimeout(() => {
      if (r.menu.parentNode !== r.wrap && !(_schedaRitorno && _schedaRitorno.menu === r.menu)) {
        r.wrap.appendChild(r.menu);
      }
    }, 220);
  }
}
document.addEventListener("click", (e) => {
  if (_openPlCardMenu && !e.target.closest(".pl-card-menu-wrap")) closePlCardMenu();
});

/** Cablaggio comune tieni-premuto (~2s) → apri menu ⋮, tap normale → onTap
 * — usato da tutte le righe di "La tua libreria" con un menu (playlist
 * proprie: rinomina/copertina/fissa/elimina; artisti/segnalibri: fissa/
 * rimuovi). Niente più "⋮" visibile, richiesta di Vitto 2026-08-04. */

/** true se il menu, nella sua posizione ancorata di default, sforerebbe lo
 * schermo (sotto il player/tab bar fissi, o ai lati) — il menu resta
 * sempre nel DOM (visibility, non display:none), quindi getBoundingClientRect
 * riflette già la posizione ancorata anche a menu ancora chiuso. Vedi
 * .pl-card-menu.centered in style.css per il fallback. */
function libMenuWouldOverflow(menu) {
  const rect = menu.getBoundingClientRect();
  // da desktop il menu delle righe brano, da chiuso, è schiacciato a 0 (vedi
  // "Stesso doppio scorrimento nelle playlist" in style.css): da aperto sarà
  // alto quanto il suo contenuto, non quanto il riquadro di adesso
  const bottom = rect.top + Math.max(rect.height, menu.scrollHeight);
  const dock = document.querySelector(".bottom-dock");
  const bottomLimit = dock ? dock.getBoundingClientRect().top : window.innerHeight;
  return bottom > bottomLimit - 8 || rect.right > window.innerWidth - 8 || rect.left < 8;
}

/* Menu "⋯" su una riga brano (Vitto, 22/09): al posto del solo "aggiungi a
 * playlist" che compariva al passaggio del mouse, un punto d'accesso a tutte
 * le azioni sul brano — come il "⋯" del player a schermo intero, ma per un
 * brano che non sta suonando. Le voci del player che NON hanno senso qui
 * (vai alla coda, timer di spegnimento, rigenera copertina) restano fuori:
 * sono azioni sul lettore, non sul brano.
 *
 * Riusa la stessa meccanica dei menu della libreria: .pl-card-menu-wrap,
 * closePlCardMenu, libMenuWouldOverflow e il rialzo della riga. Il cuore
 * resta dov'è, nella riga: è l'azione che Vitto usa di continuo.
 *
 * `dati` porta quel che serve: titolo, artista, artistId, libraryId (per la
 * playlist) e una funzione che costruisce l'elemento di coda — ogni lista ha
 * la sua (libraryItemFromTrack, artistItemFromTrack…). */
function montaMenuRiga(riga, dati) {
  if (!riga || riga.querySelector(":scope > .pl-card-menu-wrap")) return;
  const wrap = document.createElement("div");
  wrap.className = "pl-card-menu-wrap track-menu-wrap";
  const voci = [
    ["coda", "Aggiungi alla coda"],
    ["playlist", "Aggiungi a una playlist"],
    ["artista", "Vai all'artista"],
    ["simile", "Musica simile"],
  ];
  wrap.innerHTML =
    '<button type="button" class="pl-row-more track-more" title="Opzioni" aria-label="Opzioni">' +
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">' +
    '<circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>' +
    '</button><div class="pl-card-menu">' +
    voci.map(([a, t]) => '<button type="button" data-azione="' + a + '">' + t + '</button>').join("") +
    "</div>";
  riga.appendChild(wrap);

  const menu = wrap.querySelector(".pl-card-menu");
  wrap.querySelector(".track-more").addEventListener("click", (e) => {
    e.stopPropagation();
    const apri = _openPlCardMenu !== menu;
    closePlCardMenu();
    if (!apri) return;
    alzaRigaDelMenu(menu);
    menu.classList.toggle("centered", libMenuWouldOverflow(menu));
    menu.classList.add("open");
    _openPlCardMenu = menu;
  });
  menu.addEventListener("click", (e) => {
    const b = e.target.closest("[data-azione]");
    if (!b) return;
    e.stopPropagation();
    closePlCardMenu();
    const a = b.dataset.azione;
    if (a === "coda") {
      const item = typeof dati.item === "function" ? dati.item() : null;
      if (item) addToQueue(item);
    } else if (a === "playlist") {
      openPlaylistPicker({
        library_id: dati.libraryId || null,
        title: dati.titolo || "",
        artist: dati.artista || "",
      });
    } else if (a === "artista") {
      if (dati.artista) openArtistByName(dati.artista, dati.artistId || null);
    } else if (a === "simile") {
      apriMusicaSimile(dati.artista || "", dati.artistId || null);
    }
  });
}

function wireLibRowLongPress(card, menu, onTap) {
  // "⋯" visibile accanto alla riga: tieni-premuto resta (è come si fa da
  // telefono), ma col mouse non è un gesto naturale e le opzioni restavano
  // invisibili. Il bottone era già esistito e fu tolto il 04/08 insieme al
  // "⋮": qui torna solo da desktop, vedi .pl-row-more in style.css.
  // Richiesta di Vitto, 19/09.
  const wrap = menu && menu.parentNode;
  if (wrap && wrap.classList.contains("pl-card-menu-wrap") && !wrap.querySelector(".pl-row-more")) {
    const piu = document.createElement("button");
    piu.type = "button";
    piu.className = "pl-row-more";
    piu.title = "Opzioni";
    piu.setAttribute("aria-label", "Opzioni");
    piu.innerHTML =
      '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">' +
      '<circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>';
    piu.addEventListener("click", (e) => {
      // il click sul wrap è già escluso dal tap della riga (vedi sotto):
      // qui serve solo a non farlo risalire al document, che chiuderebbe
      e.stopPropagation();
      const apri = _openPlCardMenu !== menu;
      closePlCardMenu();
      if (apri) {
        alzaRigaDelMenu(menu);
        menu.classList.toggle("centered", libMenuWouldOverflow(menu));
        menu.classList.add("open");
        _openPlCardMenu = menu;
      }
    });
    wrap.insertBefore(piu, wrap.firstChild);
  }
  let pressTimer = null;
  let longPressFired = false;
  let pressStartX = 0;
  let pressStartY = 0;
  const cancelPress = () => {
    if (pressTimer) {
      clearTimeout(pressTimer);
      pressTimer = null;
    }
  };
  card.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (e.target.closest(".pl-card-menu-wrap")) return;
    // ogni nuovo dito riparte pulito: con la scheda centrata (05/10) il
    // click di rilascio del tieni-premuto cade sul suo velo, non sulla riga,
    // e il segnale restava acceso mangiandosi il tocco successivo
    longPressFired = false;
    pressStartX = e.clientX;
    pressStartY = e.clientY;
    cancelPress();
    pressTimer = setTimeout(() => {
      pressTimer = null;
      longPressFired = true;
      haptic(12); // navigator.vibrate non esiste su iOS, vedi haptic()
      const willOpen = _openPlCardMenu !== menu;
      closePlCardMenu();
      // sul telefono: scheda centrata sopra lo schermo (05/10)
      if (willOpen && window.innerWidth < 901) {
        apriSchedaRiga(card, menu);
        return;
      }
      if (willOpen) {
        alzaRigaDelMenu(menu);
        menu.classList.toggle("centered", libMenuWouldOverflow(menu));
        menu.classList.add("open");
        _openPlCardMenu = menu;
      }
    }, PL_ROW_LONG_PRESS_MS);
  });
  card.addEventListener("pointermove", (e) => {
    if (!pressTimer) return;
    if (
      Math.abs(e.clientX - pressStartX) > PL_ROW_LONG_PRESS_MOVE_TOLERANCE ||
      Math.abs(e.clientY - pressStartY) > PL_ROW_LONG_PRESS_MOVE_TOLERANCE
    ) {
      cancelPress();
    }
  });
  card.addEventListener("pointerup", cancelPress);
  card.addEventListener("pointercancel", cancelPress);
  card.addEventListener("click", (e) => {
    if (e.target.closest(".pl-card-menu-wrap")) return;
    if (longPressFired) {
      longPressFired = false;
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    onTap();
  });
}

/** "Brani salvati"/"Discovery Weekly" sono le uniche due righe SEMPRE fisse
 * in cima (nessun data-pin-key: reorderLibRowsByPin le ignora e le lascia
 * dove sono) — tieni-premuto apre comunque una finestra, coerente con le
 * altre righe, ma dice solo che qui non c'è nulla da fissare/rimuovere.
 * Richiesta di Vitto, 2026-08-04. */
function wireFixedLibRowMenu(card, onTap) {
  const wrap = document.createElement("div");
  wrap.className = "pl-card-menu-wrap";
  wrap.innerHTML = `
    <div class="pl-card-menu">
      <p class="pl-card-menu-empty">Qui non puoi fare nulla, resta fissa in cima</p>
    </div>
  `;
  card.appendChild(wrap);
  wireLibRowLongPress(card, wrap.querySelector(".pl-card-menu"), onTap);
}

/** "Fissa" playlist/artista in "La tua libreria" — solo un ordinamento
 * locale (nessun endpoint dedicato lato server, non serve sincronizzarlo
 * tra device): un pin-key per riga, "playlist:<id>" per le playlist
 * proprie, "<kind>:<ref_id>" (artist/chart/deezer_playlist) per i
 * segnalibri — stesso formato usato da data-pin-key/reorderLibRowsByPin.
 * Richiesta di Vitto, 2026-08-04: disponibile su tutte le playlist. */
const PINNED_LIB_KEY = "crackify.pinnedLibItems";
// Ordine dei pin: dal 04/10 il primo fissato resta in cima e i successivi
// vanno sotto (Vitto). Prima il più recente andava in testa: la lista già
// salvata con quell'ordine si capovolge una volta sola, segnata da questa chiave.
const PINNED_LIB_ORDINE_KEY = "crackify.pinnedLibOrdine";
function getPinnedLibItems() {
  const list = _loadJson(PINNED_LIB_KEY) || [];
  try {
    if (localStorage.getItem(PINNED_LIB_ORDINE_KEY) !== "primo-in-cima") {
      list.reverse();
      _saveJson(PINNED_LIB_KEY, list);
      localStorage.setItem(PINNED_LIB_ORDINE_KEY, "primo-in-cima");
    }
  } catch (_) {}
  return list;
}
function isLibItemPinned(kind, id) {
  return getPinnedLibItems().includes(`${kind}:${id}`);
}
function toggleLibItemPinned(kind, id) {
  const key = `${kind}:${id}`;
  const list = getPinnedLibItems();
  const idx = list.indexOf(key);
  if (idx >= 0) list.splice(idx, 1);
  else list.push(key); // appena fissata: in fondo al gruppo dei pinnati
  _saveJson(PINNED_LIB_KEY, list);
  inviaPinAlServer();
  return idx < 0; // true se ora è pinnata
}

/* —— Pin sincronizzati con l'account (04/10, Vitto: «pin sincronizzati tra
 * desktop app e mobile app») ——
 * Il localStorage resta la copia per disegnare subito (e offline); la
 * verità sta sul server (/api/me/pins, app/pins.py). Ogni modifica parte
 * verso il server, che la gira agli altri device sul canale di sync
 * (messaggio "pin", vedi handleSyncMessage); al (ri)collegamento del canale
 * e a ogni apertura della libreria si rilegge la lista dell'account.
 * Al primo allineamento di un device i suoi pin locali si aggiungono in
 * coda a quelli dell'account invece di sparire. */
const PIN_SINCRO_KEY = "crackify.pinSincronizzati";
let _pinInvioTimer = null;
let _pinDaInviare = false; // modifica locale non ancora arrivata al server: vince lei
let _pinSincroInCorso = null;

function pinSincronizzabili() {
  return !appOfflineMode && !!(authState && authState.authenticated);
}

function inviaPinAlServer() {
  if (!pinSincronizzabili()) return;
  _pinDaInviare = true;
  clearTimeout(_pinInvioTimer);
  // 300ms: più tocchi di fila partono in un colpo solo
  _pinInvioTimer = setTimeout(async () => {
    try {
      await apiJson("/api/me/pins", { items: getPinnedLibItems() }, "PUT");
      _pinDaInviare = false;
    } catch (_) {
      // resta da inviare: riparte al prossimo sincronizzaPin
    }
  }, 300);
}

/** Lista arrivata dal server (lettura o messaggio "pin"): la copia locale
 * diventa quella e libreria + barra laterale si riordinano. Se c'è una
 * modifica nostra ancora in viaggio, la lista del server è più vecchia. */
function applicaPinDalServer(lista) {
  if (_pinDaInviare || !Array.isArray(lista)) return;
  const pulita = lista.filter((x) => typeof x === "string");
  if (JSON.stringify(pulita) === JSON.stringify(getPinnedLibItems())) return;
  _saveJson(PINNED_LIB_KEY, pulita);
  reorderLibRowsByPin();
}

function sincronizzaPin() {
  if (!pinSincronizzabili()) return Promise.resolve();
  if (_pinSincroInCorso) return _pinSincroInCorso;
  _pinSincroInCorso = (async () => {
    try {
      if (_pinDaInviare) {
        // un invio fallito prima: riprova, poi vale quello che c'è sul server
        await apiJson("/api/me/pins", { items: getPinnedLibItems() }, "PUT");
        _pinDaInviare = false;
      }
      const srv = await apiJson("/api/me/pins");
      let lista = Array.isArray(srv && srv.items) ? srv.items : [];
      let primaVolta = true;
      try { primaVolta = localStorage.getItem(PIN_SINCRO_KEY) !== "1"; } catch (_) {}
      if (primaVolta) {
        const locali = getPinnedLibItems();
        const unione = lista.concat(locali.filter((k) => !lista.includes(k)));
        if (unione.length !== lista.length || srv.updated_at == null) {
          const salvata = await apiJson("/api/me/pins", { items: unione }, "PUT");
          lista = (salvata && salvata.items) || unione;
        }
        try { localStorage.setItem(PIN_SINCRO_KEY, "1"); } catch (_) {}
      }
      applicaPinDalServer(lista);
    } catch (_) {
      // server irraggiungibile o versione vecchia senza /api/me/pins:
      // restano i pin locali, si riprova al prossimo giro
    } finally {
      _pinSincroInCorso = null;
    }
  })();
  return _pinSincroInCorso;
}

/** Porta le righe pinnate in cima a #plList (nell'ordine di pin, la prima
 * fissata in alto), lasciando "Brani salvati" (nessun data-pin-key) sempre
 * per prima. Array.sort è stabile (ES2019+): le righe non pinnate
 * mantengono l'ordine originale tra loro. */
function reorderLibRowsByPin() {
  // anche "Le tue playlist" nella barra laterale del desktop (04/10, Vitto:
  // «se qualcosa viene pinnato nella libreria va pinnato anche nella sidebar,
  // niente simbolo») — stesso ordine, nessuna puntina
  const laterale = document.getElementById("sideLibList");
  if (laterale) ordinaPerPin(laterale, ".side-item[data-pin-key]");
  if (!plList) return;
  const pinned = getPinnedLibItems();
  ordinaPerPin(plList, ".pl-row[data-pin-key]").forEach((r) => {
    segnaPinRiga(r, pinned.includes(r.dataset.pinKey));
  });
}

/** Porta in cima a `contenitore` le righe fissate (ordine di pin, la prima
 * fissata in alto); le altre restano nel loro ordine (sort stabile) e le righe
 * senza data-pin-key (Brani salvati, Discovery Weekly) non si muovono. */
function ordinaPerPin(contenitore, selettore) {
  const pinned = getPinnedLibItems();
  const rows = Array.from(contenitore.querySelectorAll(selettore));
  rows.sort((a, b) => {
    const ai = pinned.indexOf(a.dataset.pinKey);
    const bi = pinned.indexOf(b.dataset.pinKey);
    if (ai >= 0 && bi >= 0) return ai - bi;
    if (ai >= 0) return -1;
    if (bi >= 0) return 1;
    return 0;
  });
  rows.forEach((r) => contenitore.appendChild(r));
  return rows;
}

/** Simbolo del pin in fondo a destra delle righe fissate (04/10, Vitto: «una
 * volta che qualcosa viene pinnato, simbolo del pin in fondo a dx»). Lo
 * accende reorderLibRowsByPin, che gira già dopo ogni "Fissa"/"Rimuovi pin"
 * e a ogni caricamento: così vale per tutti i costruttori di riga senza
 * toccarli. Ultimo figlio della riga, quindi sta davvero sul bordo destro. */
const PIN_RIGA_SVG =
  '<svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">' +
  // puntina "push_pin" di Material Icons (Apache 2.0), inclinata in CSS
  '<path fill="currentColor" d="M16 9V4h1c.55 0 1-.45 1-1s-.45-1-1-1H7c-.55 0-1 .45-1 1s.45 1 1 1h1v5c0 1.66-1.34 3-3 3v2h5.97v7l1 1 1-1v-7H19v-2c-1.66 0-3-1.34-3-3z"/>' +
  "</svg>";
function segnaPinRiga(r, fissata) {
  r.classList.toggle("pl-row-fissata", fissata);
  let ico = r.querySelector(":scope > .pl-row-pin");
  if (!fissata) return;
  if (!ico) {
    ico = document.createElement("span");
    ico.className = "pl-row-pin";
    ico.title = "Fissata in cima";
    ico.innerHTML = PIN_RIGA_SVG;
  }
  r.appendChild(ico); // sempre in coda, anche se la riga ha preso altri figli
}

/** Rimozione segnalibro artista/chart/playlist Deezer con "Annulla", stessa
 * UX di schedulePlaylistDelete — la DELETE vera (/api/saved-playlists)
 * parte solo se non annulli entro UNDO_MS. */
const pendingSavedLazyRemoves = new Map(); // "<kind>:<ref_id>" -> timer

function scheduleSavedLazyRemove(item) {
  const key = `${item.kind}:${item.ref_id}`;
  if (pendingSavedLazyRemoves.has(key)) return;
  const timer = setTimeout(async () => {
    pendingSavedLazyRemoves.delete(key);
    try {
      await apiJson(
        `/api/saved-playlists?kind=${item.kind}&ref_id=${encodeURIComponent(item.ref_id)}`,
        null,
        "DELETE"
      );
    } catch (err) {
      toast("Rimuovi: " + err.message);
    }
  }, UNDO_MS);
  pendingSavedLazyRemoves.set(key, timer);
  loadPlaylists();
  toast(`Rimossa · ${item.label}`, {
    actionLabel: "Annulla",
    duration: UNDO_MS,
    onAction: () => {
      const t = pendingSavedLazyRemoves.get(key);
      if (t) clearTimeout(t);
      pendingSavedLazyRemoves.delete(key);
      loadPlaylists();
    },
  });
}

/** Classifiche Deezer (metadati soltanto — vedi charts.py): card identiche
 * alle playlist normali, ma aprono openChart() invece di openPlaylist(). */
let _homeChartsHaveData = false; // per ripristinare la visibilità giusta quando si svuota la ricerca
let _allCharts = []; // ultima lista completa ricevuta, per il modal "Mostra tutte" (chartsModal)
/* Le 26 classifiche COSÌ COME ARRIVANO, senza il filtro track_count > 0 che
 * usa la Home: track_count conta i brani già in cache sul server, non quanto
 * è grande il chart, e oggi 25 su 26 hanno la cache vuota. Le piastrelle per
 * genere devono esserci comunque — aprirle rifà il fetch da Deezer — ed è
 * quello che fa anche il prototipo, che non filtra affatto. */
let _classifichePerGenere = [];

/** Copertina "in tema Crackify" (non la cover di un brano a caso, che
 * cambia ogni settimana e non rappresenta il mix) — riusata nell'hero del
 * dettaglio, vedi _renderLazyTracklist. Era l'icona vera dell'app al posto
 * di un'illustrazione disegnata a mano (Vitto 2026-07-29); ora la cover
 * dedicata generata (Vitto 2026-08-04), stessa immagine di Home/libreria. */
function discoveryCoverHtml() {
  return `<img src="/icons/discovery-weekly-cover.webp?v=2" alt="" class="discovery-cover-icon" />`;
}

/** Griglia fissa 2 colonne in cima alla Home (scorciatoie stile Spotify).
 * Slot 1/2 sempre presenti (statici). 3/4/5 preferiscono la cronologia
 * locale (vedi recordPlaylistOpen/recordArtistOpen) ma non restano MAI
 * vuoti: se non c'è nulla da mostrare, scelgono da soli in base alle
 * preferenze dell'utente (playlist proprie/seguite, Daily Mix, classifiche
 * personalizzate) e per un utente nuovissimo senza segnali propri ripiegano
 * sulla popolarità (Top 50 Globale) — Vitto: "non nascondere i pezzi dalla
 * griglia... se nuovo utente puoi fillare per popolarità intanto". */
async function loadHomeQuickGrid() {
  const grid = document.getElementById("homeQuickGrid");
  if (!grid) return;

  const [chartsData, homeData, dailyMixData] = await Promise.all([
    apiJson("/api/charts").catch(() => ({ charts: [] })),
    apiJson("/api/home/playlists").catch(() => ({ mine: [], others: [] })),
    apiJson("/api/daily-mixes").catch(() => ({ mixes: [] })),
  ]);
  const allCharts = (chartsData.charts || []).filter((c) => c.track_count > 0);
  const top50 = allCharts.find((c) => c.slug === "top50") || allCharts[0] || null;
  const personalizedCharts = allCharts.filter((c) => !top50 || c.slug !== top50.slug);
  const ownPlaylists = homeData.mine || [];
  const otherPlaylists = homeData.others || [];
  const mixes = dailyMixData.mixes || [];

  const lastOpened = _loadJson(LAST_OPENED_PLAYLIST_KEY);
  const lastSearched = _loadJson(LAST_SEARCHED_PLAYLIST_KEY);
  const lastArtistStored = _loadJson(LAST_ARTIST_KEY);

  // evita di ripetere la stessa playlist/classifica in più slot della
  // stessa griglia — NOTA: lo slot 6 (Top 50) va calcolato PER ULTIMO,
  // dopo aver visto cosa hanno preso davvero 3/4 (dato reale O fallback),
  // altrimenti resta comunque doppio quando lastOpened/lastSearched sono
  // GIÀ "top50" per davvero (es. utente ha cliccato un duplicato prima di
  // questo fix — bug segnalato due volte da Vitto: "doppia top 50")
  const usedIds = new Set();
  const markUsed = (kind, id) => usedIds.add(`${kind}:${id}`);
  const isUsed = (kind, id) => usedIds.has(`${kind}:${id}`);
  if (lastOpened) markUsed(lastOpened.kind, lastOpened.id);

  function fallbackPlaylistSlot() {
    for (const p of ownPlaylists) {
      if (!isUsed("playlist", p.id)) {
        markUsed("playlist", p.id);
        return { kind: "playlist", id: p.id, title: p.name, coverUrl: p.cover_url };
      }
    }
    for (const p of otherPlaylists) {
      if (!isUsed("playlist", p.id)) {
        markUsed("playlist", p.id);
        return { kind: "playlist", id: p.id, title: p.name, coverUrl: p.cover_url };
      }
    }
    // prima di arrivare alle classifiche generiche, prova un Daily Mix
    // libero — è già personalizzato sui gusti reali (affinità pesate, vedi
    // _collect_seed_weights), un fallback molto migliore delle chart per
    // chi ha "una buona pool di dati" ma poche playlist proprie/seguite
    // (bug segnalato da Vitto: vedeva Top 50 E Top Latina insieme pur
    // avendo dati veri — mine/others erano vuoti e si saltava dritti alle
    // chart senza mai provare i mix)
    for (const m of mixes) {
      if (!isUsed("daily_mix", m.mix_index)) {
        markUsed("daily_mix", m.mix_index);
        return { kind: "daily_mix", id: m.mix_index, title: m.label || "Daily Mix", coverUrl: m.cover_url };
      }
    }
    for (const c of personalizedCharts) {
      if (!isUsed("chart", c.slug)) {
        markUsed("chart", c.slug);
        return { kind: "chart", id: c.slug, title: c.label, coverUrl: c.cover_url, special: c.cover_url ? undefined : "chart" };
      }
    }
    return null;
  }

  // una classifica (Top 50, Top Latina...) NON conta come "ultima playlist
  // aperta" qui — ha già il suo slot dedicato (6) e la sua sezione (Top
  // SHIT): lasciarla vincere questo slot crea un loop (la tocchi una volta
  // per curiosità e resta incollata lì) anche per chi ha una libreria vera
  // (bug segnalato da Vitto: vedeva Top 50 E Top Latina insieme). Resta
  // comunque "used" (vedi markUsed sopra) così non raddoppia nemmeno se
  // capita di nuovo in fallbackPlaylistSlot/slot6.
  const slot3 = lastOpened && lastOpened.kind !== "chart"
    ? { kind: lastOpened.kind, id: lastOpened.id, title: lastOpened.title, coverUrl: lastOpened.coverUrl }
    : fallbackPlaylistSlot();

  const searchedSameAsOpened =
    lastOpened && lastSearched && lastOpened.kind === lastSearched.kind && lastOpened.id === lastSearched.id;
  let slot4;
  if (lastSearched && lastSearched.kind !== "chart" && !searchedSameAsOpened) {
    slot4 = { kind: lastSearched.kind, id: lastSearched.id, title: lastSearched.title, coverUrl: lastSearched.coverUrl };
    markUsed(lastSearched.kind, lastSearched.id);
  } else {
    slot4 = fallbackPlaylistSlot();
  }

  // ultimo artista aperto, altrimenti il più "pesante" del primo Daily Mix
  // (già ordinato per affinità), altrimenti l'artista del primo brano in
  // Top 50 (utente nuovo, riempie per popolarità) — serve un lookup Deezer
  // per risalire a id/cover dato solo il nome, stessa via di openArtistByName
  let slot5 = null;
  if (lastArtistStored) {
    slot5 = {
      kind: "artist",
      id: lastArtistStored.id,
      title: lastArtistStored.name,
      coverUrl: lastArtistStored.coverUrl,
      round: true,
    };
  } else {
    let fallbackName = null;
    if (mixes.length && mixes[0].subtitle) {
      fallbackName = mixes[0].subtitle.split(",")[0].trim();
    } else if (top50) {
      try {
        const top50Detail = await apiJson(`/api/charts/${top50.slug}`);
        fallbackName = top50Detail.tracks && top50Detail.tracks[0] && top50Detail.tracks[0].artist;
      } catch (_) {}
    }
    if (fallbackName) {
      try {
        const lookup = await apiJson(`/api/deezer/artist-lookup?name=${encodeURIComponent(fallbackName)}`);
        if (lookup.artist_id) {
          // artist-lookup dà solo l'id (serve solo a rendere cliccabile un
          // nome, vedi la sua doc) — la cover va presa a parte
          let coverUrl = null;
          try {
            const artistDetail = await apiJson(`/api/deezer/artists/${lookup.artist_id}`);
            coverUrl = artistDetail.cover_url || null;
          } catch (_) {}
          slot5 = {
            kind: "artist",
            id: lookup.artist_id,
            title: fallbackName,
            coverUrl,
            round: true,
          };
        }
      } catch (_) {}
    }
  }

  // calcolato per ultimo apposta: se slot 3 o 4 sono GIÀ "top50" per davvero
  // (dato reale in lastOpened/lastSearched, non un fallback), niente
  // doppione — prova la prima classifica personalizzata libera, altrimenti
  // nasconde lo slot piuttosto che ripetere lo stesso contenuto due volte
  let slot6 = null;
  if (top50 && !isUsed("chart", top50.slug)) {
    markUsed("chart", top50.slug);
    slot6 = { kind: "chart", id: top50.slug, title: top50.label, coverUrl: top50.cover_url, special: top50.cover_url ? undefined : "chart" };
  } else {
    for (const c of personalizedCharts) {
      if (!isUsed("chart", c.slug)) {
        markUsed("chart", c.slug);
        slot6 = { kind: "chart", id: c.slug, title: c.label, coverUrl: c.cover_url, special: c.cover_url ? undefined : "chart" };
        break;
      }
    }
  }

  const slots = [
    { special: "saved", title: "Brani salvati" },
    { special: "discovery", title: "Discovery Weekly" },
    slot3,
    slot4,
    slot5,
    slot6,
  ];

  // una ricerca può essere partita nel frattempo (risposta lenta): non
  // riesumare la griglia sopra ai risultati di ricerca, vedi isHomeSearchActive
  grid.classList.toggle("hidden", isHomeSearchActive());
  if (homeDjSection) homeDjSection.classList.toggle("hidden", isHomeSearchActive());
  grid.innerHTML = "";
  slots.forEach((slot) => {
    if (!slot) return;
    const el = document.createElement("div");
    el.className = "home-quick-item";
    const thumb = document.createElement("div");
    thumb.className = "home-quick-thumb";
    if (slot.round) thumb.classList.add("home-quick-thumb-round");
    if (slot.special === "saved") {
      thumb.classList.add("home-quick-thumb-saved");
      thumb.textContent = "♥";
    } else if (slot.special === "discovery") {
      thumb.classList.add("home-quick-thumb-discovery");
      thumb.innerHTML = '<img src="/icons/discovery-weekly-cover.webp?v=2" alt="" class="discovery-cover-icon" />';
    } else if (slot.special === "chart") {
      thumb.classList.add("home-quick-thumb-chart");
      thumb.textContent = "▤";
    } else if (slot.coverUrl) {
      // <img> invece di background-image: solo così esiste un evento
      // "non è caricata" da agganciare. Questi slot arrivano spesso da uno
      // snapshot in localStorage (lastOpened/lastSearched, vedi
      // recordPlaylistOpen) preso al momento dell'apertura — se nel
      // frattempo la playlist su Deezer cambia cover, quell'URL specifico
      // può smettere di funzionare anche se la playlist esiste ancora
      // (segnalato da Vitto: "Phonk Estralando" senza copertina). Al primo
      // fallimento prova a ripescare una cover fresca (auto-refresh, idea
      // di Vitto) invece di arrendersi subito al placeholder "▤".
      const img = document.createElement("img");
      img.alt = "";
      img.style.width = "100%";
      img.style.height = "100%";
      img.style.objectFit = "cover";
      img.style.display = "block";
      let triedRefresh = false;
      img.onerror = async () => {
        if (triedRefresh) {
          debugLog("quick-cover-refresh-also-failed", { kind: slot.kind, id: slot.id, title: slot.title });
          img.remove();
          thumb.textContent = "▤";
          return;
        }
        triedRefresh = true;
        debugLog("quick-cover-fail", { kind: slot.kind, id: slot.id, title: slot.title, cover_url: slot.coverUrl });
        const fresh = await refreshSlotCoverUrl(slot);
        if (fresh) {
          debugLog("quick-cover-refreshed", { kind: slot.kind, id: slot.id, title: slot.title, fresh });
          updateStoredSlotCover(slot, fresh);
          img.src = proxiedCover(fresh);
        } else {
          debugLog("quick-cover-refresh-unsupported-or-failed", { kind: slot.kind, id: slot.id, title: slot.title });
          img.remove();
          thumb.textContent = "▤";
        }
      };
      img.src = proxiedCover(slot.coverUrl);
      thumb.appendChild(img);
    } else {
      thumb.textContent = "▤";
    }
    const label = document.createElement("span");
    label.className = "home-quick-label";
    label.textContent = slot.title || "";
    el.appendChild(thumb);
    el.appendChild(label);
    el.addEventListener("click", () => {
      if (slot.special === "saved") openSavedLibrary();
      else if (slot.special === "discovery") openDiscoveryWeekly();
      else if (slot.kind === "artist") openArtistByName(slot.title, slot.id);
      // daily_mix si attiva la shell da solo (come discovery), a differenza
      // di chart/deezer/playlist — vedi openDailyMix
      else if (slot.kind === "daily_mix") openDailyMix(slot.id);
      else {
        // chart/deezer/playlist si aspettano che sia il chiamante ad attivare
        // la shell Playlist prima (come fa buildChartCard) — non lo fanno da
        // soli, a differenza di discovery/daily mix. Senza questo, la vista
        // restava su Home ma con la topbar nascosta (bug: "torna in home
        // senza la top bar" segnalato da Vitto)
        activatePlaylistsShell();
        if (slot.kind === "chart") openChart(slot.id);
        else if (slot.kind === "deezer") openDeezerPlaylist(slot.id);
        else if (slot.kind === "playlist") openPlaylist(slot.id, { entrata: true });
      }
    });
    grid.appendChild(el);
  });
}

/** Daily Mix — più card distinte per affinità (stile Spotify), a
 * differenza di Discovery Weekly ce ne sono N, rigenerate ogni giorno, e
 * contengono anche brani già tuoi (il "ripasso"). Vedi openDailyMix per
 * il dettaglio, stesso "play pigro". */
let _homeDailyMixHasData = false; // per ripristinare la visibilità giusta quando si svuota la ricerca

async function loadHomeDailyMixes() {
  if (!homeDailyMixGrid) return;
  try {
    const data = await apiJson("/api/daily-mixes");
    const mixes = data.mixes || [];
    releaseLazyCovers(homeDailyMixGrid);
    homeDailyMixGrid.innerHTML = "";
    _homeDailyMixHasData = mixes.length > 0;
    if (!mixes.length) {
      if (homeDailyMixSection) homeDailyMixSection.classList.add("hidden");
      return;
    }
    if (homeDailyMixSection) {
      homeDailyMixSection.classList.toggle("hidden", isHomeSearchActive());
    }
    const DAILY_MIX_COLORS = 6;
    mixes.forEach((m) => {
      const num = String(m.mix_index + 1).padStart(2, "0");
      const colorClass = `daily-mix-c${m.mix_index % DAILY_MIX_COLORS}`;
      const card = document.createElement("div");
      card.className = "pl-card";
      card.innerHTML = `
        <div class="pl-card-cover daily-mix-cover ${colorClass}">
          <div class="daily-mix-badge">
            <span class="daily-mix-badge-label">Daily Mix</span>
            <span class="daily-mix-badge-num"></span>
          </div>
        </div>
        <div class="pl-card-name"></div>
      `;
      card.querySelector(".daily-mix-badge-num").textContent = num;
      // niente "Daily Mix" ripetuto qui sotto: la copertina lo dice già,
      // qui solo i nomi degli artisti (vedi Vitto 2026-07-27)
      card.querySelector(".pl-card-name").textContent = m.subtitle || "";
      if (m.cover_url) {
        lazyLoadCover(card.querySelector(".daily-mix-cover"), proxiedCover(m.cover_url), { clearText: false });
      }
      card.addEventListener("click", () => openDailyMix(m.mix_index));
      homeDailyMixGrid.appendChild(card);
    });
  } catch (_) {
    _homeDailyMixHasData = false;
    if (homeDailyMixSection) homeDailyMixSection.classList.add("hidden");
  }
}

/** Stazioni radio personalizzate — una per artista "seme" (stessi pesi di
 * affinità di Daily Mix, vedi _build_radio_stations lato server), ma senza
 * clustering: l'algoritmo radio di Deezer varia già da solo. Rigenerate
 * ogni giorno (RADIO_TTL_SEC). Stessa impaginazione di Daily Mix. */
let _homeRadioHasData = false;

async function loadHomeRadioStations() {
  if (!homeRadioGrid) return;
  try {
    const data = await apiJson("/api/radio-stations");
    const stations = data.stations || [];
    releaseLazyCovers(homeRadioGrid);
    homeRadioGrid.innerHTML = "";
    _homeRadioHasData = stations.length > 0;
    if (!stations.length) {
      if (homeRadioSection) homeRadioSection.classList.add("hidden");
      return;
    }
    if (homeRadioSection) {
      homeRadioSection.classList.toggle("hidden", isHomeSearchActive());
    }
    const RADIO_COLORS = 5;
    stations.forEach((s, i) => {
      const colorClass = `radio-c${i % RADIO_COLORS}`;
      const num = String(i + 1).padStart(2, "0");
      const card = document.createElement("div");
      card.className = "pl-card";
      card.innerHTML = `
        <div class="pl-card-cover daily-mix-cover ${colorClass}">
          <div class="daily-mix-badge">
            <span class="daily-mix-badge-label">Radio</span>
            <span class="daily-mix-badge-num"></span>
          </div>
        </div>
        <div class="pl-card-name"></div>
      `;
      card.querySelector(".daily-mix-badge-num").textContent = num;
      // niente "Radio {nome}" ripetuto qui sotto: la copertina lo dice già,
      // qui solo il nome dell'artista (stesso pattern di Daily Mix)
      card.querySelector(".pl-card-name").textContent = s.subtitle || s.label || "Radio";
      if (s.cover_url) {
        lazyLoadCover(card.querySelector(".daily-mix-cover"), proxiedCover(s.cover_url), { clearText: false });
      }
      card.addEventListener("click", () => openRadioStation(s.station_index));
      homeRadioGrid.appendChild(card);
    });
  } catch (_) {
    _homeRadioHasData = false;
    if (homeRadioSection) homeRadioSection.classList.add("hidden");
  }
}

/** Playlist Deezer VERE suggerite in base ai gusti (stessi pesi di affinità
 * di Daily Mix/Radio, una ricerca per artista seme lato server) — a
 * differenza di Daily Mix/Radio qui riusiamo buildDeezerPlaylistCard e
 * openDeezerPlaylist così come sono: sono playlist reali, non mix sintetici,
 * zero "play pigro" dedicato da scrivere. Rigenerate ogni giorno. */
let _homeRecommendedHasData = false;

async function loadHomeRecommendedPlaylists() {
  if (!homeRecommendedGrid) return;
  try {
    const data = await apiJson("/api/recommended-playlists");
    const playlists = data.playlists || [];
    homeRecommendedGrid.innerHTML = "";
    _homeRecommendedHasData = playlists.length > 0;
    if (!playlists.length) {
      if (homeRecommendedSection) homeRecommendedSection.classList.add("hidden");
      return;
    }
    if (homeRecommendedSection) {
      homeRecommendedSection.classList.toggle("hidden", isHomeSearchActive());
    }
    playlists.forEach((p) => homeRecommendedGrid.appendChild(buildDeezerPlaylistCard(p)));
  } catch (_) {
    _homeRecommendedHasData = false;
    if (homeRecommendedSection) homeRecommendedSection.classList.add("hidden");
  }
}

async function loadHomeCharts() {
  if (!homeChartsGrid) return;
  try {
    const data = await apiJson("/api/charts");
    _classifichePerGenere = data.charts || [];
    const charts = _classifichePerGenere.filter((c) => c.track_count > 0);
    homeChartsGrid.innerHTML = "";
    _allCharts = charts;
    _homeChartsHaveData = charts.length > 0;
    // una ricerca può essere partita nel frattempo (risposta lenta): non
    // riesumare la sezione sopra ai risultati, vedi isHomeSearchActive
    if (homeChartsSection) {
      homeChartsSection.classList.toggle("hidden", !_homeChartsHaveData || isHomeSearchActive());
    }
    charts.forEach((c) => homeChartsGrid.appendChild(buildChartCard(c)));
    // stessa lista, secondo uso: le piastrelle per genere della pagina
    // Cerca. Nessuna richiesta in più.
    renderGeneri(_classifichePerGenere);
  } catch (_) {
    _homeChartsHaveData = false;
    if (homeChartsSection) homeChartsSection.classList.add("hidden");
  }
}

function buildChartCard(c) {
  const card = document.createElement("div");
  card.className = "pl-card";
  card.innerHTML = `
    <div class="pl-card-cover">▤</div>
    <div class="pl-card-name"></div>
    <div class="pl-card-meta"></div>
  `;
  card.querySelector(".pl-card-name").textContent = c.label;
  card.querySelector(".pl-card-meta").textContent = `${c.track_count} brani`;
  if (c.cover_url) {
    const cov = card.querySelector(".pl-card-cover");
    lazyLoadCover(cov, proxiedCover(c.cover_url));
  }
  card.addEventListener("click", () => {
    activatePlaylistsShell();
    openChart(c.slug);
  });
  return card;
}

/** "Mostra tutte" accanto al titolo Classifiche: stesso pattern di
 * artistTracksModal (finestra sopra la Home, tap fuori per uscire) ma con
 * una griglia di card invece di una tracklist — riusa _allCharts, già
 * popolata dall'ultima loadHomeCharts(), zero richieste aggiuntive. */
function openChartsModal() {
  if (!chartsModal || !chartsModalGrid) return;
  chartsModalGrid.innerHTML = "";
  _allCharts.forEach((c) => {
    const card = buildChartCard(c);
    card.addEventListener("click", () => closeChartsModal());
    chartsModalGrid.appendChild(card);
  });
  chartsModal.classList.remove("hidden");
}

function closeChartsModal() {
  if (chartsModal) chartsModal.classList.add("hidden");
}

if (chartsModal) {
  chartsModal.addEventListener("click", (e) => {
    if (e.target === chartsModal) closeChartsModal();
  });
}
if (btnChartsShowAll) {
  btnChartsShowAll.addEventListener("click", openChartsModal);
}

/** Vero se c'è del testo nella barra di ricerca Home in questo momento —
 * i 3 loader sotto (playlist/charts/discovery) partono insieme all'apertura
 * di Home mm sono asincroni: se uno risolve DOPO che l'utente ha già
 * iniziato a digitare, non deve comunque riesumare la propria sezione
 * sopra ai risultati di ricerca (vedi renderHomeGrids/applyHomeSearchFilter). */
/** Testo che ha senso solo col dito: da desktop torna vuoto e la riga di
 * stato si richiude da sola. */
function soloTelefono(testo) {
  return window.innerWidth >= 901 ? "" : testo;
}

function isHomeSearchActive() {
  // dal 19/09 la ricerca ha una pagina sua (#viewSearch): la Home non entra
  // più in "modalità ricerca", quindi i suoi loader non devono più
  // trattenersi dal mostrare le proprie sezioni.
  return false;
}

/** Card di un chart/playlist Deezer salvato come segnalibro — stessa forma
 * delle card normali, apre la stessa vista pigra di sempre (niente brani
 * copiati, vedi saved_playlists.py). Il download in blocco vive nella
 * action row del dettaglio (plOfflineW), non qui — vedi refreshLazyDownloadButton. */
function libKindLabel(kind) {
  if (kind === "artist") return "Artista";
  if (kind === "chart") return "Classifica";
  return "Playlist";
}

function buildSavedLazyCard(item) {
  const card = document.createElement("div");
  card.className = "pl-row";
  card.dataset.searchName = (item.label || "").toLowerCase();
  card.dataset.pinKey = `${item.kind}:${item.ref_id}`;
  const kindLabel = libKindLabel(item.kind);
  const pinNoun = item.kind === "artist" ? "artista" : "playlist";
  card.innerHTML = `
    <div class="pl-row-cover${item.kind === "artist" ? " pl-row-cover-round" : ""}">▤</div>
    <div class="pl-row-text">
      <div class="pl-row-name"></div>
      <div class="pl-row-meta"><span></span></div>
    </div>
    <div class="pl-card-menu-wrap">
      <div class="pl-card-menu">
        <button type="button" data-action="pin"></button>
        <button type="button" data-action="remove" class="pl-card-menu-danger">Rimuovi</button>
      </div>
    </div>
  `;
  card.querySelector(".pl-row-name").textContent = item.label;
  card.querySelector(".pl-row-meta span").textContent =
    item.kind === "artist" ? kindLabel : `${kindLabel} • ${item.track_count || 0} brani`;
  if (item.cover_url) {
    const cov = card.querySelector(".pl-row-cover");
    lazyLoadCover(cov, proxiedCover(item.cover_url));
  }
  const menu = card.querySelector(".pl-card-menu");
  const pinBtn = menu.querySelector('[data-action="pin"]');
  const refreshPinBtnLabel = () => {
    pinBtn.textContent = isLibItemPinned(item.kind, item.ref_id) ? "Rimuovi pin" : `Fissa ${pinNoun}`;
  };
  refreshPinBtnLabel();
  pinBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    closePlCardMenu();
    toggleLibItemPinned(item.kind, item.ref_id);
    refreshPinBtnLabel();
    reorderLibRowsByPin();
  });
  menu.querySelector('[data-action="remove"]').addEventListener("click", (e) => {
    e.stopPropagation();
    closePlCardMenu();
    scheduleSavedLazyRemove(item);
  });
  wireLibRowLongPress(card, menu, () => {
    if (item.kind === "artist") {
      openArtist(Number(item.ref_id));
      return;
    }
    activatePlaylistsShell();
    if (item.kind === "chart") openChart(item.ref_id);
    else openDeezerPlaylist(Number(item.ref_id));
  });
  return card;
}

/** "Le tue playlist"/"Playlist di altri tossici" sono state rimosse dalla
 * Home (restano nel tab Playlist, vedi loadPlaylists) — questa funzione
 * resta solo per nascondere/ripristinare le sezioni "per te" (charts/Daily
 * Mix/radio/consigliate) quando parte una ricerca Home, vedi
 * searchDeezerPlaylistsDebounced. */
/* renderHomeGrids è stato rimosso il 19/09: nascondeva le sezioni della
 * Home mentre si cercava, ma ora la ricerca ha una pagina sua e la Home non
 * viene più invasa. Chi mostra le sezioni sono i rispettivi loader. */

/** Card di risultato ricerca playlist Deezer (stessa forma delle card
 * normali) — apre openDeezerPlaylist(), non una playlist Crackify vera. */
function buildDeezerPlaylistCard(p) {
  const card = document.createElement("div");
  card.className = "pl-card";
  card.innerHTML = `
    <div class="pl-card-cover">▤</div>
    <div class="pl-card-name"></div>
    <div class="pl-card-meta"></div>
  `;
  card.querySelector(".pl-card-name").textContent = p.title;
  card.querySelector(".pl-card-meta").textContent =
    `${p.track_count} brani` + (p.creator ? ` · ${p.creator}` : "");
  if (p.cover_url) {
    const cov = card.querySelector(".pl-card-cover");
    const proxied = proxiedCover(p.cover_url);
    // sonda separata: un background-image CSS non dà nessun evento di
    // successo/fallimento osservabile, questa serve solo a scoprirlo e
    // riportarlo (debug temporaneo, vedi debugLog — Vitto: "Phonk
    // Estralando" a volte bianca pur risultando valida lato server)
    const probe = new Image();
    probe.onload = () => debugLog("pl-cover-ok", { title: p.title, id: p.id, cover_url: p.cover_url });
    probe.onerror = () => debugLog("pl-cover-fail", { title: p.title, id: p.id, cover_url: p.cover_url, proxied });
    probe.src = proxied;
    lazyLoadCover(cov, proxied);
  } else {
    debugLog("pl-cover-missing", { title: p.title, id: p.id });
  }
  card.addEventListener("click", () => {
    activatePlaylistsShell();
    openDeezerPlaylist(p.id);
  });
  return card;
}

function buildDeezerArtistCard(a) {
  const card = document.createElement("div");
  card.className = "pl-card";
  card.innerHTML = `
    <div class="pl-card-cover">🎤</div>
    <div class="pl-card-name"></div>
  `;
  card.querySelector(".pl-card-name").textContent = a.name;
  if (a.cover_url) {
    const cov = card.querySelector(".pl-card-cover");
    lazyLoadCover(cov, proxiedCover(a.cover_url));
  }
  card.addEventListener("click", () => openArtist(a.id));
  return card;
}

function buildDeezerAlbumCard(a) {
  const card = document.createElement("div");
  card.className = "pl-card";
  card.innerHTML = `
    <div class="pl-card-cover">▤</div>
    <div class="pl-card-name"></div>
    <div class="pl-card-meta"></div>
  `;
  card.querySelector(".pl-card-name").textContent = a.title;
  card.querySelector(".pl-card-meta").textContent = a.artist || "";
  if (a.cover_url) {
    const cov = card.querySelector(".pl-card-cover");
    lazyLoadCover(cov, proxiedCover(a.cover_url));
  }
  card.addEventListener("click", () => openAlbum(a.id));
  return card;
}

let _deezerSearchDebounce = null;
let _deezerSearchSeq = 0;

// —— filtro Tutte/Artisti/Album/Playlist sui risultati di ricerca Home:
// tre richieste indipendenti restano tali (una fallita non rompe le altre),
// ma quale sezione è VISIBILE dipende anche da questo, non solo dal fatto
// che abbia risultati — vedi applyHomeSearchFilter. ——
let _homeSearchFilter = "all"; // "all" | "artist" | "album" | "playlist"
let _homeSearchCounts = { playlist: 0, artist: 0, album: 0 };

function applyHomeSearchFilter() {
  const f = _homeSearchFilter;
  if (homeDeezerSection) {
    homeDeezerSection.classList.toggle(
      "hidden",
      !((f === "all" || f === "playlist") && _homeSearchCounts.playlist)
    );
  }
  if (homeArtistsSection) {
    homeArtistsSection.classList.toggle(
      "hidden",
      !((f === "all" || f === "artist") && _homeSearchCounts.artist)
    );
  }
  if (homeAlbumsSection) {
    homeAlbumsSection.classList.toggle(
      "hidden",
      !((f === "all" || f === "album") && _homeSearchCounts.album)
    );
  }
}

function setHomeSearchFilter(f) {
  _homeSearchFilter = f;
  if (homeSearchFilterRow) {
    homeSearchFilterRow.querySelectorAll("[data-filter]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.filter === f);
    });
  }
  applyHomeSearchFilter();
}

if (homeSearchFilterRow) {
  homeSearchFilterRow.querySelectorAll("[data-filter]").forEach((btn) => {
    btn.addEventListener("click", () => setHomeSearchFilter(btn.dataset.filter));
  });
}
// quinto chip, come nel prototipo: non è un filtro, è l'altra profondità di
// ricerca — apre la finestra dei brani con la query già scritta
{
  const chip = document.getElementById("homeSearchTracksChip");
  if (chip) chip.addEventListener("click", () => openTrackSearchModal());
}

/** Ricerca playlist+artisti+album su Deezer in parallelo, debounced — non ha
 * senso una chiamata di rete per ogni tocco di tasto. _deezerSearchSeq
 * scarta risposte arrivate in ordine sbagliato (query più vecchia risolta
 * dopo una più recente). Ogni sezione si nasconde da sola se vuota o se
 * esclusa dal filtro attivo (vedi applyHomeSearchFilter) — sono tre
 * richieste indipendenti (Promise.allSettled), una che fallisce non deve
 * rompere le altre due. */
function searchDeezerPlaylistsDebounced(query) {
  clearTimeout(_deezerSearchDebounce);
  const q = (query || "").trim();
  if (!q) {
    [homeDeezerSection, homeArtistsSection, homeAlbumsSection].forEach(
      (s) => s && s.classList.add("hidden")
    );
    [homeDeezerGrid, homeArtistsGrid, homeAlbumsGrid].forEach((g) => g && (g.innerHTML = ""));
    if (homeSearchFilterRow) homeSearchFilterRow.classList.add("hidden");
    _homeSearchCounts = { playlist: 0, artist: 0, album: 0 };
    return;
  }
  if (homeSearchFilterRow) homeSearchFilterRow.classList.remove("hidden");
  const seq = ++_deezerSearchSeq;
  _deezerSearchDebounce = setTimeout(async () => {
    homeSearchHistoryUI.add(q); // ricerca vera partita: idem a addSearchHistory sul submit brani

    const [playlists, artists, albums] = await Promise.allSettled([
      apiJson(`/api/deezer/playlists/search?q=${encodeURIComponent(q)}`),
      apiJson(`/api/deezer/artists/search?q=${encodeURIComponent(q)}`),
      apiJson(`/api/deezer/albums/search?q=${encodeURIComponent(q)}`),
    ]);
    if (seq !== _deezerSearchSeq) return; // superata da una ricerca più recente

    if (homeDeezerGrid) {
      const results = playlists.status === "fulfilled" ? playlists.value.playlists || [] : [];
      homeDeezerGrid.innerHTML = "";
      _homeSearchCounts.playlist = results.length;
      if (homeDeezerTitle) homeDeezerTitle.textContent = `Playlist trovate (${results.length})`;
      results.forEach((p) => homeDeezerGrid.appendChild(buildDeezerPlaylistCard(p)));
    }
    if (homeArtistsGrid) {
      const results = artists.status === "fulfilled" ? artists.value.artists || [] : [];
      homeArtistsGrid.innerHTML = "";
      _homeSearchCounts.artist = results.length;
      if (homeArtistsTitle) homeArtistsTitle.textContent = `Artisti (${results.length})`;
      results.forEach((a) => homeArtistsGrid.appendChild(buildDeezerArtistCard(a)));
    }
    if (homeAlbumsGrid) {
      const results = albums.status === "fulfilled" ? albums.value.albums || [] : [];
      homeAlbumsGrid.innerHTML = "";
      _homeSearchCounts.album = results.length;
      if (homeAlbumsTitle) homeAlbumsTitle.textContent = `Album (${results.length})`;
      results.forEach((a) => homeAlbumsGrid.appendChild(buildDeezerAlbumCard(a)));
    }
    applyHomeSearchFilter();
  }, 400);
}

/** Cronologia ricerche generica (account, sync multi-device) — stessa
 * interazione della cronologia ricerca brani (queryInput/searchHistoryEl)
 * ma riusabile per altre barre di ricerca: kind separa le liste lato server
 * (vedi search_history.py), el/input/onPick puntano alla barra giusta. */
function createSearchHistory({ kind, el, input, onPick }) {
  let cache = [];
  // il fuoco messo dal codice (entrando nella pagina Cerca) fa scattare il
  // focus handler e la tendina si apre coprendo mezza pagina: "salta()" la
  // zittisce per quella volta sola, al primo click dell'utente torna
  let salta = false;

  function hide() {
    if (el) el.classList.add("hidden");
  }

  async function render() {
    if (!el) return;
    if (salta) {
      salta = false;
      hide();
      return;
    }
    if (!authState.authenticated) return;
    try {
      const data = await apiJson(`/api/me/search-history?kind=${kind}`);
      if (Array.isArray(data.queries)) cache = data.queries;
    } catch (_) {}
    if (!cache.length) {
      hide();
      return;
    }
    el.innerHTML = "";
    cache.slice(0, 6).forEach((q) => {
      const row = document.createElement("div");
      row.className = "search-history-row";
      row.innerHTML = `
        <span class="search-history-ico" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="9"/>
            <path d="M12 7v5l3 3"/>
          </svg>
        </span>
        <span class="search-history-text"></span>
        <button type="button" class="search-history-remove" title="Rimuovi" aria-label="Rimuovi">✕</button>
      `;
      row.querySelector(".search-history-text").textContent = q;
      row.addEventListener("click", (e) => {
        if (e.target.closest(".search-history-remove")) return;
        hide();
        onPick(q);
      });
      row.querySelector(".search-history-remove").addEventListener("click", async (e) => {
        e.stopPropagation();
        cache = cache.filter((x) => x !== q);
        render();
        try {
          const data = await apiJson(
            `/api/me/search-history?kind=${kind}&query=${encodeURIComponent(q)}`,
            null,
            "DELETE"
          );
          if (Array.isArray(data.queries)) cache = data.queries;
          render();
        } catch (_) {}
      });
      el.appendChild(row);
    });
    const clearRow = document.createElement("div");
    clearRow.className = "search-history-clear";
    clearRow.textContent = "Cancella cronologia";
    clearRow.addEventListener("click", async (e) => {
      e.stopPropagation();
      cache = [];
      hide();
      try {
        await apiJson(`/api/me/search-history?kind=${kind}`, null, "DELETE");
      } catch (_) {}
    });
    el.appendChild(clearRow);
    el.classList.remove("hidden");
  }

  async function add(query) {
    const q = (query || "").trim();
    if (!q) return;
    cache = [q, ...cache.filter((x) => x.toLowerCase() !== q.toLowerCase())].slice(0, 6);
    try {
      const data = await apiJson(`/api/me/search-history?kind=${kind}`, { query: q }, "POST");
      if (Array.isArray(data.queries)) cache = data.queries;
    } catch (_) {}
  }

  if (input) {
    input.addEventListener("focus", () => render());
    input.addEventListener("click", () => render());
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") hide();
    });
    document.addEventListener("click", (e) => {
      if (!el || el.classList.contains("hidden")) return;
      if (e.target === input || el.contains(e.target)) return;
      hide();
    });
  }

  return { render, hide, add, salta: () => { salta = true; } };
}

const homeSearchHistoryUI = createSearchHistory({
  kind: "playlists",
  el: $("#homeSearchHistory"),
  input: homeSearchInput,
  onPick: (q) => {
    homeSearchInput.value = q;
    updateHomeSearchClearVisible();
    aggiornaIntestazioneCerca(q);
    searchDeezerPlaylistsDebounced(q);
  },
});

const homeSearchClear = $("#homeSearchClear");

function updateHomeSearchClearVisible() {
  if (homeSearchClear) homeSearchClear.classList.toggle("hidden", !homeSearchInput.value.trim());
}

if (homeSearchClear) {
  homeSearchClear.addEventListener("click", () => {
    homeSearchInput.value = "";
    updateHomeSearchClearVisible();
    aggiornaIntestazioneCerca("");
    searchDeezerPlaylistsDebounced("");
    homeSearchHistoryUI.render();
    homeSearchInput.focus();
  });
}

/* La barra della Home è una porta d'ingresso, non una seconda ricerca: al
 * primo carattere apre la pagina Cerca, ci travasa il testo e le passa il
 * fuoco. Da lì in poi si scrive nella barra di quella pagina — una ricerca
 * sola, che è il punto di tutto il giro (Vitto 2026-09-19). */
function collegaPortaRicerca(idCampo, idBottone) {
  const porta = document.getElementById(idCampo);
  if (porta) {
    porta.addEventListener("input", () => {
      const q = porta.value;
      porta.value = "";
      showView("search");
      if (!homeSearchInput) return;
      homeSearchInput.value = q;
      homeSearchHistoryUI.salta();
      try {
        homeSearchInput.focus();
        const n = homeSearchInput.value.length;
        homeSearchInput.setSelectionRange(n, n);
      } catch (_) {}
      homeSearchInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    // NIENTE salto al click: cliccare la barra deve solo darle il fuoco e
    // lasciarti dove sei (Vitto, 19/09 — "non mi piace che ogni volta che
    // clicchi ti porta nella card cerca"). Il passaggio alla pagina Cerca
    // avviene al primo carattere, dove i risultati hanno dove comparire.
  }
  const bottone = document.getElementById(idBottone);
  if (bottone) bottone.addEventListener("click", () => openTrackSearchModal());
}
collegaPortaRicerca("homeSearchEntry", "homeTrackSearchBtn");
// la fascia c'è anche in cima a "La tua libreria": stessa porta
collegaPortaRicerca("libSearchEntry", "libTrackSearchBtn");
// in "Brani salvati" la fascia è a scomparsa, ma la barra fa lo stesso lavoro
collegaPortaRicerca("savedSearchEntry", "savedTrackSearchBtn");
collegaPortaRicerca("artistSearchEntry", "artistTrackSearchBtn");

/* La fascia che si TIRA GIÙ (Vitto, 19/09). Non compare a scatto: sta
 * appoggiata SOPRA la pagina, fuori dalla vista, e il gesto la trascina giù
 * — la vedi scendere mentre tiri, e la pagina scende con lei. Sei già in
 * cima, continui a scorrere verso l'alto (il gesto che lì non porta da
 * nessuna parte) e la tiri fuori; a fine gesto si assesta da sola, aperta o
 * chiusa a seconda di quanto l'hai tirata. Al primo scorrimento in giù
 * torna su.
 *
 * Su desktop non c'è touchstart: il gesto è la rotella/trackpad, quindi si
 * accumula il deltaY negativo mentre lo scroller è già a fondo corsa. E non
 * c'è nemmeno un "dito alzato", quindi la fine del gesto la si deduce da
 * una pausa di 140ms senza eventi.
 *
 * A muoversi è la VISTA (transform), non la fascia: scendendo si porta
 * dietro sia la fascia (che è in absolute sopra il bordo) sia la copertina.
 * Vedi il blocco in style.css per la geometria. */
const ALTEZZA_FASCIA = 74;

function collegaFasciaARivelazione(idVista, soloSe) {
  const vista = document.getElementById(idVista);
  const barra = vista && vista.querySelector(":scope > .top");
  if (!vista || !barra) return;
  const scroller = document.querySelector(".main");
  if (!scroller) return;

  // il colore della cima della pagina, fuso col fondo della colonna: così
  // la fascia è opaca e sembra il pezzo di pagina che era lì prima
  const FONDO = [18, 18, 20]; // --chrome
  // Solo una velatura, non la tinta piena: la hero parte a 0,82 ma quello
  // su una fascia larga tutta la colonna diventa uno slabbrone arancione
  // illeggibile (provato il 19/09). Basta che si senta di che playlist sei.
  const VELO = 0.22;
  let ultimoColore = "";
  const sistemaColore = () => {
    const grezzo = getComputedStyle(vista).getPropertyValue("--pl-hero-rgb").trim();
    if (!grezzo || grezzo === ultimoColore) return;
    const n = grezzo.split(",").map((x) => parseInt(x, 10));
    if (n.length !== 3 || n.some((x) => isNaN(x))) return;
    ultimoColore = grezzo;
    const mix = n.map((v, i) => Math.round(v * VELO + FONDO[i] * (1 - VELO)));
    barra.style.setProperty("--crk-top-bg", `rgb(${mix[0]}, ${mix[1]}, ${mix[2]})`);
  };

  let tiro = 0;          // quanto è scesa, 0 → chiusa, ALTEZZA_FASCIA → aperta
  let timerFine = null;
  const attiva = () =>
    window.innerWidth >= 901 &&
    !vista.classList.contains("hidden") &&
    (!soloSe || soloSe(vista));

  const scrivi = (v) => {
    const prima = tiro;
    tiro = Math.max(0, Math.min(ALTEZZA_FASCIA, v));
    vista.style.setProperty("--crk-tiro", tiro + "px");
    // la vista si sposta solo a fascia fuori: a riposo niente transform,
    // altrimenti i menu position:fixed al suo interno finiscono fuori
    // schermo (vedi .crk-tirata in style.css)
    vista.classList.toggle("crk-tirata", tiro > 0);
    barra.classList.toggle("crk-visibile", tiro >= ALTEZZA_FASCIA - 0.5);
    // il gestore del rientro è NON passivo, perché deve poter fermare lo
    // scorrimento della pagina finché la fascia non è rientrata: lo
    // attacchiamo solo mentre la fascia è fuori, così nel caso normale
    // .main resta con soli ascoltatori passivi
    if (prima <= 0 && tiro > 0) {
      scroller.addEventListener("wheel", suRuotaRientro, { passive: false });
    } else if (prima > 0 && tiro <= 0) {
      scroller.removeEventListener("wheel", suRuotaRientro, { passive: false });
    }
  };
  /* Il rientro segue il gesto come l'uscita: scorrendo verso il basso la
   * fascia risale un pezzo alla volta, e la pagina NON scorre finché non è
   * rientrata del tutto — per questo qui serve preventDefault, quindi un
   * ascoltatore non passivo. Prima tornava su di scatto mentre la pagina
   * partiva a scorrere, e si vedeva lo strappo (Vitto, 19/09). */
  const suRuotaRientro = (e) => {
    if (!attiva() || tiro <= 0 || e.deltaY <= 0) return;
    e.preventDefault();
    vista.classList.remove("crk-assestando");
    scrivi(tiro - e.deltaY * 0.55);
    if (timerFine) clearTimeout(timerFine);
    timerFine = setTimeout(() => assesta(tiro > ALTEZZA_FASCIA * 0.45), 140);
  };

  const assesta = (aperta) => {
    if (timerFine) { clearTimeout(timerFine); timerFine = null; }
    vista.classList.add("crk-assestando");
    scrivi(aperta ? ALTEZZA_FASCIA : 0);
  };

  scroller.addEventListener(
    "wheel",
    (e) => {
      if (!attiva()) return;
      sistemaColore();
      // il verso il basso lo gestisce suRuotaRientro quando la fascia è
      // fuori; qui interessa solo il tiro verso l'alto a fondo corsa
      if (e.deltaY >= 0 || scroller.scrollTop > 0) return;
      // trascinamento: segue il gesto, nessuna transizione di mezzo.
      // 0,55 è un freno: senza, un colpo di trackpad la spalanca di botto
      vista.classList.remove("crk-assestando");
      scrivi(tiro + -e.deltaY * 0.55);
      if (timerFine) clearTimeout(timerFine);
      // niente dito da alzare: la fine del gesto è una pausa
      timerFine = setTimeout(() => assesta(tiro > ALTEZZA_FASCIA * 0.45), 140);
    },
    { passive: true }
  );
  scroller.addEventListener(
    "scroll",
    () => {
      if (scroller.scrollTop > 4 && tiro > 0) assesta(false);
    },
    { passive: true }
  );
  // entrando e uscendo dalla vista si riparte sempre chiusi
  if (typeof MutationObserver === "function") {
    new MutationObserver(() => {
      sistemaColore();
      if (!attiva() && tiro > 0) { vista.classList.remove("crk-assestando"); scrivi(0); }
    }).observe(vista, { attributes: true, attributeFilter: ["class", "style"] });
  }
  window.addEventListener("resize", () => {
    if (!attiva() && tiro > 0) { vista.classList.remove("crk-assestando"); scrivi(0); }
  }, { passive: true });
  sistemaColore();
}
/* Barra di ricerca da tirare giù, sul telefono. Nata per "Cerca nei
 * salvati" (04/10, Vitto: «spostare la barra di ricerca brani sopra lo
 * schermo come per la versione desktop con la barra classica, ma più
 * delicato e ottimizzato per mobile, e una visione unita con la pagina
 * sotto, niente cambio colore»), poi estesa a Discovery Weekly (05/10).
 * Il campo sta sopra la copertina, fuori schermo. Stando in cima, col dito
 * verso il basso la pagina intera scende (transform sulla vista, mai sul
 * layout: niente reflow di 150 righe a ogni tocco) e il campo compare
 * sfumando; lasciato oltre il 40% si assesta aperto, altrimenti torna su.
 * Il fondo dietro è lo stesso colore della cima della copertina, quindi
 * sembra la pagina che continua. Da aperto il campo scorre via con la
 * pagina come un pezzo di lei; si richiude tirando su stando in cima (non
 * se c'è un filtro scritto: lì il dito scorre la lista) o uscendo.
 * Da desktop il campo resta la lente nella riga dei comandi.
 * o.attivoSe: quando vale nella vista (la pagina delle playlist è una per
 * tutte: lì solo per Discovery Weekly); o.osserva: un elemento che cambia
 * a ogni apertura, per riposizionare il campo. */
function collegaRicercaDaTirare(o) {
  const vista = o.vista;
  const tiro = o.tiro;
  const campo = tiro && tiro.querySelector(".lib-tiro-campo");
  const wrap = o.wrap;
  const input = o.input;
  const scroller = document.querySelector(".main");
  if (!vista || !tiro || !campo || !wrap || !input || !scroller) return;
  const ALTO = 56; // quanto scende la pagina: campo da 40 + 8 sopra e sotto
  const telefono = () => window.innerWidth < 901;
  const attivo = () =>
    telefono() && !vista.classList.contains("hidden") && (!o.attivoSe || o.attivoSe());
  const casa = wrap.parentNode;
  const dopo = wrap.nextSibling;

  // il colore della cima della copertina, fuso col fondo come fa il suo
  // gradiente (0,8 sopra --chrome): il fondo dietro il campo è quello
  const sistemaColore = () => {
    const n = (getComputedStyle(vista).getPropertyValue("--pl-hero-rgb") || "255, 106, 0")
      .split(",").map((x) => parseInt(x, 10));
    if (n.length !== 3 || n.some((x) => isNaN(x))) return;
    const fondo = [18, 18, 20];
    const mix = n.map((v, i) => Math.round(v * 0.8 + fondo[i] * 0.2));
    vista.style.setProperty("--lib-tiro-bg", `rgb(${mix[0]}, ${mix[1]}, ${mix[2]})`);
  };

  let d = 0;
  let nonPassivo = false;
  const scrivi = (v, anima) => {
    d = Math.max(0, v);
    vista.classList.toggle("lib-tiro-assesta", !!anima);
    vista.style.setProperty("--lib-tiro", d.toFixed(1) + "px");
    vista.style.setProperty("--lib-tiro-p", Math.min(1, d / ALTO).toFixed(3));
    // transform solo a campo fuori: a riposo niente, come la fascia desktop
    vista.classList.toggle("lib-tirata", d > 0);
    vista.classList.toggle("lib-tiro-aperta", d >= ALTO - 0.5);
    // l'ascoltatore che può fermare lo scorrimento (per richiudere) c'è
    // solo a campo fuori: nel caso normale .main resta tutto passivo
    if (d > 0 && !nonPassivo) {
      scroller.addEventListener("touchmove", muoviBloccante, { passive: false });
      nonPassivo = true;
    } else if (d <= 0 && nonPassivo) {
      scroller.removeEventListener("touchmove", muoviBloccante, { passive: false });
      nonPassivo = false;
    }
  };
  const azzera = () => { if (d > 0 || nonPassivo) scrivi(0, false); };

  // il campo sta sopra la pagina solo dove vale; altrove torna nella riga
  // dei comandi (e la classe tiro-attivo accende contenitore e fondo)
  const sistemaNodo = () => {
    const si = attivo();
    vista.classList.toggle("tiro-attivo", si);
    if (si && wrap.parentNode !== campo) campo.insertBefore(wrap, campo.querySelector(".lib-tiro-annulla"));
    else if (!si && wrap.parentNode !== casa) {
      esciRicerca(true);
      casa.insertBefore(wrap, dopo);
      azzera();
    }
  };

  /* Modalità ricerca (05/10, Vitto, con lo screenshot di Spotify «Trova in
   * questa pagina»): toccando il campo la pagina si riduce al campo in cima,
   * con «Annulla» accanto, e sotto i brani che si filtrano mentre scrivi —
   * copertina, titolo e comandi spariscono. Il campo resta esattamente dov'era
   * (8px sotto la barra di stato), cambia solo quello che ha sotto.
   * «Annulla» svuota il filtro e riporta la pagina; il tasto "cerca" della
   * tastiera chiude solo la tastiera e lascia i risultati. */
  const annulla = document.createElement("button");
  annulla.type = "button";
  annulla.className = "lib-tiro-annulla";
  annulla.textContent = "Annulla";
  campo.appendChild(annulla);
  /* Transizione (05/10, Vitto: «una transizione più pulita»): il campo
   * non si muove mai. Entrando: copertina e comandi sfumano mentre «Annulla»
   * entra da destra e il campo si stringe (.ricerca-annulla/.ricerca-veli),
   * poi la pagina si riduce (.in-ricerca) e l'elenco scivola su fino sotto
   * il campo. Uscendo il contrario, e la barra resta tirata giù. */
  const lista = o.lista;
  const CURVA = "cubic-bezier(0.2, 0.8, 0.2, 1)";
  const ridotto = () => !!(window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches);
  let timerRicerca = null;
  // FLIP: l'elenco parte da dove stava prima del cambio e scivola dov'è ora
  // (un solo transform, niente ricalcoli di layout durante il movimento)
  const scivolaLista = (primaTop) => {
    if (!lista || ridotto()) return;
    const dy = primaTop - lista.getBoundingClientRect().top;
    if (Math.abs(dy) < 1) return;
    lista.style.transition = "none";
    lista.style.transform = `translateY(${dy}px)`;
    void lista.offsetHeight;
    lista.style.transition = `transform 0.34s ${CURVA}`;
    lista.style.transform = "";
    const pulisci = (e) => {
      if (e && e.target !== lista) return;
      lista.style.transition = "";
      lista.removeEventListener("transitionend", pulisci);
    };
    lista.addEventListener("transitionend", pulisci);
  };
  const inRicerca = () => vista.classList.contains("ricerca-annulla");
  function entraRicerca() {
    // solo toccando la barra tirata giù sopra lo schermo, e solo sul
    // telefono (attivo() lo è già): un fuoco dato in altro modo non la apre
    if (!attivo() || inRicerca() || !vista.classList.contains("lib-tiro-aperta")) return;
    clearTimeout(timerRicerca);
    // 1) copertina e comandi sfumano, «Annulla» entra, il campo si stringe
    vista.classList.add("ricerca-annulla", "ricerca-veli");
    timerRicerca = setTimeout(() => {
      timerRicerca = null;
      if (!inRicerca()) return;
      // 2) la pagina si riduce e l'elenco sale fino sotto il campo
      const primaTop = lista ? lista.getBoundingClientRect().top : 0;
      azzera(); // via il transform del tiro: da qui il campo sta nel flusso
      vista.classList.add("in-ricerca");
      scroller.scrollTop = 0;
      scivolaLista(primaTop);
    }, ridotto() ? 0 : 180);
  }
  function esciRicerca(silenzioso) {
    if (!inRicerca()) return;
    clearTimeout(timerRicerca);
    timerRicerca = null;
    const ridotta = vista.classList.contains("in-ricerca");
    const primaTop = lista ? lista.getBoundingClientRect().top : 0;
    if (input.value) {
      input.value = "";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    if (document.activeElement === input) input.blur();
    vista.classList.remove("ricerca-annulla", "in-ricerca");
    if (silenzioso) {
      vista.classList.remove("ricerca-veli");
      if (lista) { lista.style.transition = ""; lista.style.transform = ""; }
      return;
    }
    // la barra resta tirata giù: il campo non si muove, la pagina gli
    // ritorna sotto (l'elenco scende) e poi copertina, comandi e arancio
    // riappaiono sfumando
    scrivi(ALTO, false);
    scroller.scrollTop = 0;
    if (ridotta) scivolaLista(primaTop);
    timerRicerca = setTimeout(() => {
      timerRicerca = null;
      vista.classList.remove("ricerca-veli");
    }, ridotto() ? 0 : 160);
  }
  input.addEventListener("focus", entraRicerca);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && inRicerca()) {
      e.preventDefault();
      input.blur();
    }
  });
  annulla.addEventListener("click", (e) => {
    e.stopPropagation();
    esciRicerca(false);
  });
  sistemaNodo();

  const filtroInUso = () => !!input.value.trim() || document.activeElement === input;
  let inGesto = false;
  let asse = null;
  let x0 = 0;
  let y0 = 0;
  let d0 = 0;
  let mosso = false;

  scroller.addEventListener("touchstart", (e) => {
    sistemaNodo();
    // in modalità ricerca niente tiro: il campo è già lì
    inGesto = attivo() && !inRicerca() && e.touches.length === 1;
    if (!inGesto) return;
    asse = null;
    mosso = false;
    x0 = e.touches[0].clientX;
    y0 = e.touches[0].clientY;
    d0 = d;
    sistemaColore();
  }, { passive: true });

  const muovi = (e, puoBloccare) => {
    if (!inGesto) return;
    const t = e.touches[0];
    if (!t) return;
    const dy = t.clientY - y0;
    const dx = t.clientX - x0;
    if (!asse) {
      if (Math.abs(dy) < 6 && Math.abs(dx) < 6) return;
      asse = Math.abs(dy) > Math.abs(dx) ? "y" : "x";
    }
    if (asse !== "y" || scroller.scrollTop > 0) return;
    if (d0 <= 0 && dy <= 0) {
      // chiuso e si va su: è la lista (se si era già tirato un po',
      // il campo torna su insieme al dito invece di restare a metà)
      if (d > 0) { mosso = true; scrivi(0, false); }
      return;
    }
    if (d0 > 0 && dy < 0 && filtroInUso()) return; // filtro attivo: scorre la lista
    // in apertura un po' di freno; oltre il campo un elastico più duro
    let v = d0 + dy * (d0 > 0 ? 1 : 0.6);
    if (v > ALTO) v = ALTO + (v - ALTO) * 0.3;
    if (puoBloccare && e.cancelable && dy < 0) e.preventDefault();
    mosso = true;
    scrivi(Math.min(v, ALTO + 24), false);
  };
  // aperto ci pensa quello bloccante, così i due non contano doppio
  scroller.addEventListener("touchmove", (e) => { if (d0 <= 0 && !nonPassivo) muovi(e, false); }, { passive: true });
  function muoviBloccante(e) { muovi(e, true); }

  const fine = () => {
    if (!inGesto) return;
    inGesto = false;
    if (!mosso) return;
    // a metà strada si decide: aprendo basta il 40%, richiudendo il 60%
    const aperto = d0 > 0 ? d > ALTO * 0.6 : d > ALTO * 0.4;
    scrivi(aperto ? ALTO : 0, true);
  };
  scroller.addEventListener("touchend", fine, { passive: true });
  scroller.addEventListener("touchcancel", fine, { passive: true });

  // entrando e uscendo dalla pagina si riparte chiusi; a ogni apertura
  // (la lista si ricostruisce) si rivede dove deve stare il campo
  if (typeof MutationObserver === "function") {
    new MutationObserver(() => {
      if (vista.classList.contains("hidden")) {
        esciRicerca(true);
        azzera();
      }
      sistemaNodo();
    }).observe(vista, { attributes: true, attributeFilter: ["class"] });
    if (o.osserva) {
      new MutationObserver(() => { azzera(); sistemaNodo(); })
        .observe(o.osserva, { childList: true });
    }
  }
  window.addEventListener("resize", () => {
    sistemaNodo();
    if (!telefono()) azzera();
  }, { passive: true });
  sistemaColore();
}
collegaRicercaDaTirare({
  vista: viewLibrary,
  tiro: document.getElementById("libTiro"),
  wrap: document.getElementById("libSearchWrap"),
  input: document.getElementById("libSearch"),
  lista: document.getElementById("libList"),
});
// Le pagine delle playlist (05/10): prima solo Discovery Weekly, poi Vitto
// «pagine playlist invece spostare la searchbar sopra la pagina» → tutte
// quelle con la copertina in cima (mix, classifiche, radio, Deezer, le
// proprie e quelle degli altri). Nella griglia della libreria no.
collegaRicercaDaTirare({
  vista: viewPlaylists,
  tiro: document.getElementById("plTiro"),
  wrap: document.getElementById("plTrackSearchWrap"),
  input: document.getElementById("plTrackSearch"),
  attivoSe: () => !!plHero && !plHero.classList.contains("hidden"),
  osserva: plTracks,
  lista: plTracks,
});

/* Da desktop il tasto "Connect — dispositivi" sta a destra, subito prima
 * del volume, invece che a sinistra accanto al cuore (Vitto, 22/09). È uno
 * spostamento di nodo e non di ordine: i due gruppi del player (.now a
 * sinistra, .extra a destra) sono contenitori flex diversi, quindi "order"
 * non li attraversa. Sotto i 901px torna dov'era: lì .extra è nascosto e il
 * tasto sparirebbe del tutto. */
{
  const tasto = document.getElementById("btnConnect");
  const destra = document.querySelector(".player .extra") || document.querySelector(".extra");
  const volume = document.getElementById("btnMute");
  if (tasto && destra && volume) {
    const casa = tasto.parentNode;
    const dopo = tasto.nextSibling;
    const sistema = () => {
      const aDestra = window.innerWidth >= 901;
      if (aDestra && tasto.parentNode !== destra) destra.insertBefore(tasto, volume);
      else if (!aDestra && tasto.parentNode !== casa) casa.insertBefore(tasto, dopo);
    };
    sistema();
    window.addEventListener("resize", sistema, { passive: true });
  }
}

/* La ricerca dentro una playlist parte chiusa, come una lente, e si apre in
 * un campo compatto al click — riferimento: la registrazione di Spotify che
 * mi ha lasciato Vitto (22/09). Si richiude da sola quando perde il fuoco ed
 * è vuota, così non resta un campo largo per niente in mezzo ai comandi.
 * Solo desktop: da telefono la ricerca sta su una riga sua e va bene aperta. */
/* opts.ancheTelefono: lente anche sotto i 901px (solo "Cerca nella tua
 * libreria", dal 04/10 — Vitto l'ha voluta come da desktop). */
function collegaRicercaALente(idWrap, idInput, opts) {
  const wrap = document.getElementById(idWrap);
  const input = document.getElementById(idInput);
  if (!wrap || !input) return;
  const ancheTelefono = !!(opts && opts.ancheTelefono);
  // il nome resta "desktop" per non toccare il resto: vuol dire "fa da lente"
  const desktop = () => ancheTelefono || window.innerWidth >= 901;
  wrap.addEventListener("click", () => {
    if (!desktop() || wrap.classList.contains("crk-aperta")) return;
    wrap.classList.add("crk-aperta");
    try { input.focus(); } catch (_) {}
  });
  const chiudiSeVuota = () => {
    if (!input.value.trim()) wrap.classList.remove("crk-aperta");
  };
  input.addEventListener("blur", chiudiSeVuota);
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.blur();
    wrap.classList.remove("crk-aperta");
  });
  window.addEventListener("resize", () => {
    if (!desktop()) wrap.classList.remove("crk-aperta");
  }, { passive: true });
}
collegaRicercaALente("plTrackSearchWrap", "plTrackSearch");
collegaRicercaALente("libSearchWrap", "libSearch");
collegaRicercaALente("artistTrackSearchWrap", "artistTrackSearch");
collegaRicercaALente("plLibSearchWrap", "plLibSearch", { ancheTelefono: true });

/* "Cerca nella tua libreria" non è più la barra larga sotto la testata:
 * diventa un quadrato gemello del "+", alla sua sinistra, che al click si
 * apre come la lente delle playlist (Vitto, 02/10 da desktop). Dal 04/10
 * anche sul telefono, quindi il nodo sta sempre nella riga del titolo
 * (prima ci andava solo sopra i 901px, con un ascoltatore su resize). */
{
  const riga = document.querySelector("#plGridHead .pl-lib-head-top");
  const piu = document.getElementById("btnPlCreate");
  if (plLibSearchWrap && riga && piu) riga.insertBefore(plLibSearchWrap, piu);
}

/* Chip Tutto / Playlist / Artisti sopra la griglia della libreria (solo
 * desktop, 02/10). Il filtro è un attributo su #plList che applica la CSS
 * (gli artisti sono le righe con data-pin-key "artist:…"): così vale anche
 * per le righe che loadPlaylists ricostruisce a ogni visita e si somma alla
 * lente senza toccarne la logica. Se in libreria c'è un solo tipo i chip
 * non servono a niente: spariscono e si torna su "Tutto". */
{
  const fila = document.getElementById("libChips");
  if (fila && plList) {
    const scegli = (tipo) => {
      fila.querySelectorAll("[data-tipo]").forEach((b) => {
        const su = b.dataset.tipo === tipo;
        b.classList.toggle("active", su);
        b.setAttribute("aria-pressed", su ? "true" : "false");
      });
      plList.dataset.tipo = tipo;
    };
    fila.addEventListener("click", (e) => {
      const chip = e.target.closest("[data-tipo]");
      if (chip) scegli(chip.dataset.tipo);
    });
    const sistemaChip = () => {
      const righe = [...plList.children].filter((r) => r.classList.contains("pl-row"));
      const artisti = righe.filter((r) => (r.dataset.pinKey || "").startsWith("artist:")).length;
      const misti = artisti > 0 && artisti < righe.length;
      fila.classList.toggle("hidden", !misti);
      if (!misti && plList.dataset.tipo && plList.dataset.tipo !== "tutto") scegli("tutto");
    };
    scegli("tutto");
    sistemaChip();
    if (typeof MutationObserver === "function") {
      new MutationObserver(sistemaChip).observe(plList, { childList: true });
    }
  }
}

collegaFasciaARivelazione("viewLibrary");
collegaFasciaARivelazione("viewArtist");

/* Dentro una playlist la fascia di "La tua libreria" deve comportarsi come
 * quella dei preferiti: nascosta sopra la pagina e da tirare giù, col
 * colore della copertina. Sulla griglia delle playlist invece resta la
 * barra normale in cima. La differenza la fa #plHero, che è il pannello
 * del dettaglio: quando si mostra, marchiamo la vista. */
{
  const vista = document.getElementById("viewPlaylists");
  const hero = document.getElementById("plHero");
  if (vista && hero && typeof MutationObserver === "function") {
    const segna = () =>
      vista.classList.toggle("crk-dettaglio", !hero.classList.contains("hidden"));
    new MutationObserver(segna).observe(hero, {
      attributes: true, attributeFilter: ["class"],
    });
    segna();
  }
}
collegaFasciaARivelazione("viewPlaylists", (v) => v.classList.contains("crk-dettaglio"));

/* L'intestazione di colonna si accende quando la lista ha righe. Un
 * osservatore invece di una chiamata dentro ogni costruttore: #plTracks lo
 * riempiono QUATTRO funzioni diverse (openPlaylist, openHomePlaylist,
 * openOfflinePlaylist, _renderLazyTracklist) e prima o poi una se la
 * sarebbe dimenticata. Le colonne le copia dalla riga vera: l'ultima (le
 * azioni) è larga 0, 36 o 66 a seconda di chi ha riempito la lista, e con
 * una griglia scritta a mano le etichette scivolavano di una ventina di px. */
function collegaTestaColonne(idTesta, idLista) {
  const testa = idTesta ? document.getElementById(idTesta) : null;
  const lista = document.getElementById(idLista);
  if (!lista) return; // l'intestazione è facoltativa (la pagina artista non ce l'ha)
  /* L'artista torna anche sotto il titolo, in piccolo, ma SENZA link: il
   * link vive nella sua colonna (Vitto, 19/09 — è lo stesso doppione che
   * usa il prototipo). Sta fuori da .title e non dentro, altrimenti il
   * titolo perde i puntini di sospensione: con un blocco dentro, il testo
   * finisce in una scatola anonima che non eredita l'overflow. */
  const sistemaSottotitoli = () => {
    lista.querySelectorAll(".track").forEach((riga) => {
      const artista = riga.querySelector(".artist");
      if (!artista) return;
      const nome = (artista.textContent || "").trim();
      let sotto = riga.querySelector(":scope > .track-sub");
      if (!nome || nome === "—") {
        if (sotto) sotto.remove();
        return;
      }
      if (!sotto) {
        sotto = document.createElement("small");
        sotto.className = "track-sub";
        sotto.setAttribute("aria-hidden", "true"); // è un doppione
        riga.appendChild(sotto);
      }
      if (sotto.textContent !== nome) sotto.textContent = nome;
    });
  };

  const aggiorna = () => {
    const piena = lista.children.length > 0 && !lista.classList.contains("hidden");
    if (testa) testa.classList.toggle("hidden", !piena);
    if (!piena) return;
    sistemaSottotitoli();
    if (!testa) return;
    const riga = lista.querySelector(".track");
    if (!riga) return;
    const colonne = getComputedStyle(riga).gridTemplateColumns;
    if (colonne && colonne !== "none") testa.style.gridTemplateColumns = colonne;
  };
  if (typeof MutationObserver === "function") {
    new MutationObserver(aggiorna).observe(lista, {
      childList: true, attributes: true, attributeFilter: ["class"],
    });
  }
  aggiorna();
}
collegaTestaColonne("plTracksHead", "plTracks");
collegaTestaColonne("libTracksHead", "libList");
// dal 30/09 anche la pagina artista ha l'intestazione (Vitto: "non hanno
// ancora la griglia"), sopra la lista e sotto il suo "N brani"
collegaTestaColonne("artistTracksHead", "artistTracks");

if (homeSearchInput) {
  aggiornaIntestazioneCerca("");
  const onHomeSearchChange = () => {
    updateHomeSearchClearVisible();
    aggiornaIntestazioneCerca(homeSearchInput.value);
    searchDeezerPlaylistsDebounced(homeSearchInput.value);
    if (!homeSearchInput.value.trim()) homeSearchHistoryUI.render();
    else homeSearchHistoryUI.hide();
  };
  homeSearchInput.addEventListener("input", onHomeSearchChange);
  // iOS Safari: la "x" nativa di clear su input[type=search] a volte non
  // scatena "input" in modo affidabile — copriamo anche "search"/"change".
  homeSearchInput.addEventListener("search", onHomeSearchChange);
  homeSearchInput.addEventListener("change", onHomeSearchChange);
}

function buildHomePlaylistCard(p, isOther) {
  const card = document.createElement("div");
  card.className = "pl-card";
  card.innerHTML = `
    <div class="pl-card-cover">▤</div>
    <div class="pl-card-name"></div>
    <div class="pl-card-meta"></div>
  `;
  card.querySelector(".pl-card-name").textContent = p.name;
  card.querySelector(".pl-card-meta").textContent = `${p.track_count || 0} brani`;
  if (p.cover_url) {
    const c = card.querySelector(".pl-card-cover");
    lazyLoadCover(c, mediaAuthUrl(p.cover_url, { bust: false }));
  }
  if (isOther) {
    const owner = document.createElement("div");
    owner.className = "pl-card-owner";
    owner.innerHTML = `
      <span class="pl-card-owner-avatar"></span>
      <span class="pl-card-owner-name"></span>
    `;
    owner.querySelector(".pl-card-owner-name").textContent = p.owner_name || "?";
    applyAvatarToEl(owner.querySelector(".pl-card-owner-avatar"), p.owner_avatar_url, "🎧");
    card.appendChild(owner);
    card.addEventListener("click", () => {
      activatePlaylistsShell();
      openHomePlaylist(p.owner_id, p.id);
    });
  } else {
    card.addEventListener("click", () => {
      activatePlaylistsShell();
      openPlaylist(p.id, { entrata: true });
    });
  }
  return card;
}

/** Rende visibile #viewPlaylists senza rifare il fetch della griglia
 * (serve solo per mostrare il dettaglio aperto da Home). */
function activatePlaylistsShell() {
  viewHome.classList.add("hidden");
  viewSearch.classList.add("hidden");
  viewLibrary.classList.add("hidden");
  viewQueue.classList.add("hidden");
  // anche la pagina artista: sta sopra le altre viste e qui non veniva
  // nascosta, quindi da un artista un clic su PHONK nella barra laterale
  // apriva la playlist SOTTO l'artista e sembrava andare a vuoto (Vitto,
  // 04/10). Dalla Home funzionava solo perché lì l'artista non è aperto.
  chiudiPaginaArtista();
  stopHomeDjSoundbarLoop();
  revealView(viewPlaylists);
  document.querySelectorAll(".nav-link").forEach((x) => x.classList.remove("active"));
  document
    .querySelectorAll('.nav-link[data-view="playlists"]')
    .forEach((x) => x.classList.add("active"));
  setMobileTopbarVisible(false);
}

// —— ascolto offline (solo app nativa): scarica i brani di una playlist sul
// device via Filesystem, così suonano senza bisogno del Mac in rete. Un
// brano può appartenere a più playlist scaricate: si tiene un conteggio
// (crackify_offline_playlists) per non cancellare un file ancora in uso
// da un'altra playlist quando se ne rimuove una.
const OFFLINE_TRACKS_KEY = "crackify_offline_tracks";
const OFFLINE_PLAYLISTS_KEY = "crackify_offline_playlists";
const OFFLINE_DIR = "offline_tracks";

function offlineFs() {
  return window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Filesystem;
}

function getOfflineTracks() {
  try {
    return JSON.parse(localStorage.getItem(OFFLINE_TRACKS_KEY) || "{}");
  } catch (_) {
    return {};
  }
}
function setOfflineTracks(map) {
  localStorage.setItem(OFFLINE_TRACKS_KEY, JSON.stringify(map));
}
function getOfflinePlaylists() {
  let raw;
  try {
    raw = JSON.parse(localStorage.getItem(OFFLINE_PLAYLISTS_KEY) || "{}");
  } catch (_) {
    return {};
  }
  // scarta voci non nella forma { pl: {...}, ownerId } — es. dal vecchio
  // formato (array di soli id) usato prima del refactor: altrimenti un
  // crash silenzioso su un brano interrompeva il rendering dell'intera grid
  let changed = false;
  const clean = {};
  for (const [pid, entry] of Object.entries(raw || {})) {
    if (entry && typeof entry === "object" && entry.pl && Array.isArray(entry.pl.tracks)) {
      clean[pid] = entry;
    } else {
      changed = true;
    }
  }
  if (changed) setOfflinePlaylists(clean);
  return clean;
}
function setOfflinePlaylists(map) {
  localStorage.setItem(OFFLINE_PLAYLISTS_KEY, JSON.stringify(map));
}

function isPlaylistOffline(pid) {
  return !!getOfflinePlaylists()[pid];
}

/** URI locale riproducibile se il brano è stato scaricato, altrimenti null. */
async function getOfflineTrackSrc(trackId) {
  const fs = offlineFs();
  if (!fs || !trackId) return null;
  const tracks = getOfflineTracks();
  const entry = tracks[trackId];
  if (!entry) return null;
  try {
    const res = await fs.getUri({ directory: "DATA", path: entry.path });
    return window.Capacitor.convertFileSrc(res.uri);
  } catch (_) {
    return null;
  }
}

/** Copertina scaricata per l'ascolto offline, se c'è — altrimenti null
 * (niente errore: la UI resta sul placeholder ▤). */
async function getOfflineTrackCoverSrc(trackId) {
  const fs = offlineFs();
  if (!fs || !trackId) return null;
  const entry = getOfflineTracks()[trackId];
  if (!entry || !entry.coverPath) return null;
  try {
    const res = await fs.getUri({ directory: "DATA", path: entry.coverPath });
    const src = window.Capacitor.convertFileSrc(res.uri);
    // copertina riscaricata sullo stesso file dopo una scelta nel selettore
    // (refreshOfflineTrackCover): URL diverso = niente immagine vecchia dalla
    // cache della WebView. Il guscio iOS serve il file guardando solo il
    // path (WebViewAssetHandler usa url.path), la query non dà fastidio.
    return entry.coverRev ? `${src}?r=${entry.coverRev}` : src;
  } catch (_) {
    return null;
  }
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const s = reader.result || "";
      const i = s.indexOf(",");
      resolve(i >= 0 ? s.slice(i + 1) : s);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

/** Copertina di un brano offline: best-effort, non deve mai far fallire il
 * download del brano stesso (se manca la rete torna solo null). */
/** Ritorna { path, error }: solo uno dei due è valorizzato. L'errore serve
 * a mostrare la causa vera in un toast diagnostico, non solo "fallito". */
async function downloadCoverOffline(track) {
  const fs = offlineFs();
  const coverUrl = track.cover_hd_url || track.cover_url;
  if (!coverUrl) {
    return { path: null, error: "brano senza cover_url" };
  }
  let fullUrl;
  try {
    fullUrl = mediaAuthUrl(coverUrl, { bust: false });
    // prima il download nativo dritto su disco (vedi scaricaSuDisco); il
    // tipo non si conosce prima, ma le copertine sono jpg (png se lo dice
    // l'indirizzo)
    const extNativa = /\.png(\?|$)/i.test(coverUrl) ? "png" : "jpg";
    const coverPathNativo = `${OFFLINE_DIR}/${track.id}_cover.${extNativa}`;
    if (await scaricaSuDisco(fullUrl, coverPathNativo)) {
      return { path: coverPathNativo, error: null };
    }
    // blip di rete transitorio (tipico appena dopo il boot, Tailscale/WiFi
    // non ancora stabili): ritenta un paio di volte prima di segnare
    // davvero fallito, invece di perdere la copertina per un singolo hiccup
    let cRes;
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        // no-store OBBLIGATORIO: la stessa URL è già in cache HTTP della
        // WebView come risposta no-CORS (img/CSS della UI) e una fetch CORS
        // sulla stessa entry muore subito con "Load failed" invece di
        // riscaricare (bug/comportamento WebKit, verificato empiricamente)
        cRes = await fetch(fullUrl, { cache: "no-store" });
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        if (attempt < 2) await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
      }
    }
    if (lastErr) throw lastErr;
    if (!cRes.ok) {
      return { path: null, error: `HTTP ${cRes.status} su ${fullUrl}` };
    }
    const cBlob = await cRes.blob();
    const cBase64 = await blobToBase64(cBlob);
    const ext = cBlob.type && cBlob.type.includes("png") ? "png" : "jpg";
    const coverPath = `${OFFLINE_DIR}/${track.id}_cover.${ext}`;
    await fs.writeFile({
      directory: "DATA",
      path: coverPath,
      data: cBase64,
      recursive: true,
    });
    return { path: coverPath, error: null };
  } catch (err) {
    return {
      path: null,
      error: `${err.name || "err"}: ${err.message || err}`,
    };
  }
}

/** Ripara in background le copertine mancanti di una playlist GIÀ scaricata
 * — nessuna UI, nessun toast: la prossima volta che apri offline quella
 * playlist le copertine ci sono, senza dover rimuovere/riscaricare a mano. */
async function backfillOfflineCovers(pid, tracks) {
  if (!offlineFs()) return;
  if (!isPlaylistOffline(pid)) return; // non scaricata: niente da riparare
  if (!tracks || !tracks.length) return;
  const tracksMap = getOfflineTracks();
  let ok = 0;
  for (const t of tracks) {
    const entry = tracksMap[t.id];
    if (entry && !entry.coverPath) {
      const { path } = await downloadCoverOffline(t);
      if (path) {
        tracksMap[t.id] = { ...entry, coverPath: path };
        ok++;
      }
    }
  }
  if (ok) setOfflineTracks(tracksMap);
}

/** Scarica un file dritto su disco col download nativo di iOS (05/10, Vitto:
 * «via Tailscale è molto lento, non possiamo renderlo più veloce?»). Prima
 * ogni brano passava tutto in memoria nella pagina, diventava base64 (+33%)
 * e attraversava il ponte verso il nativo come una stringa enorme, che poi
 * lo riscriveva: per un mp3 da 9 MB decine di MB copiate avanti e indietro.
 * downloadFile (Filesystem, deprecato dalla 7.1 ma presente nella 8) lo fa
 * fare a URLSession direttamente sul file. Stessa cartella "DATA" di
 * writeFile, quindi i percorsi salvati restano validi. Ritorna false se il
 * download nativo non c'è o fallisce: il chiamante ripiega sul vecchio modo. */
// Avanzamento in byte dei download nativi (06/10): il plugin manda un
// evento "progress" ~ogni 0,1 s con l'url, e qui lo si gira a chi l'ha
// chiesto. Serve al tasto del Travel mode e all'anello delle playlist per
// scorrere anche DENTRO un brano invece di saltare un brano alla volta.
const _avanzamentiDownload = new Map(); // url → (frazione 0..1) => void
let _ascoltoAvanzamento = false;
function ascoltaAvanzamentoDownload(fs) {
  if (_ascoltoAvanzamento || typeof fs.addListener !== "function") return;
  _ascoltoAvanzamento = true;
  try {
    fs.addListener("progress", (ev) => {
      const cb = ev && _avanzamentiDownload.get(ev.url);
      if (cb && ev.contentLength > 0) cb(Math.min(1, ev.bytes / ev.contentLength));
    });
  } catch (_) {}
}

async function scaricaSuDisco(url, path, suAvanzamento) {
  const fs = offlineFs();
  if (!fs || typeof fs.downloadFile !== "function") return false;
  const conAvanzamento = typeof suAvanzamento === "function";
  if (conAvanzamento) {
    ascoltaAvanzamentoDownload(fs);
    _avanzamentiDownload.set(url, suAvanzamento);
  }
  try {
    await fs.downloadFile({
      url,
      path,
      directory: "DATA",
      recursive: true,
      ...(conAvanzamento ? { progress: true } : {}),
    });
    return true;
  } catch (err) {
    console.warn("download nativo fallito, ripiego", err);
    return false;
  } finally {
    if (conAvanzamento) _avanzamentiDownload.delete(url);
  }
}

/** "Fast download" (05/10, interruttore nelle impostazioni → Offline mode):
 * il Mac manda una copia AAC 160 kbps in .m4a (leggero.py sul server) invece
 * dell'originale, quasi sempre a 320: file a metà peso, fuori casa scarica
 * circa il doppio più veloce. Solo per i brani della libreria (/api/library/),
 * gli altri indirizzi non sanno convertire. Vale per i prossimi download. */
const OFFLINE_VELOCE_KEY = "crackify_offline_veloce";
function fastDownloadAttivo() {
  try {
    return localStorage.getItem(OFFLINE_VELOCE_KEY) === "1";
  } catch (_) {
    return false;
  }
}

async function downloadTrackOffline(track, suAvanzamento) {
  const fs = offlineFs();
  const url = mediaAuthUrl(track.stream_url, { bust: false });
  const tentativi = [];
  if (fastDownloadAttivo() && /\/api\/library\//.test(track.stream_url || "")) {
    const leggero = url + (url.includes("?") ? "&" : "?") + "qualita=160";
    tentativi.push({ url: leggero, percorso: `${OFFLINE_DIR}/${track.id}.m4a` });
  }
  // qualità piena: sempre, e anche come ripiego se la conversione fallisce
  // (il server risponde 502 invece di mandare l'originale sotto nome .m4a)
  tentativi.push({ url, percorso: `${OFFLINE_DIR}/${track.id}.mp3` });
  let ultimoErrore = null;
  // col download nativo (l'app) un errore è rete o server: rifarlo uguale
  // via fetch+base64 raddoppiava solo i tentativi lenti (ricontrollo del
  // 06/10). La fetch resta per chi il nativo non ce l'ha.
  const nativo = typeof (fs && fs.downloadFile) === "function";
  for (const { url: daDove, percorso } of tentativi) {
    if (nativo) {
      if (await scaricaSuDisco(daDove, percorso, suAvanzamento)) {
        const { path: coverPath } = await downloadCoverOffline(track);
        return { path: percorso, coverPath };
      }
      ultimoErrore = new Error("download non riuscito");
      continue;
    }
    try {
      // no-store: stessa classe di bug delle copertine (entry no-CORS in cache
      // HTTP che uccide la fetch CORS sulla stessa URL) + niente doppio caching
      // di file audio grossi nella cache della WebView
      const res = await fetch(daDove, { cache: "no-store" });
      if (!res.ok) throw new Error("download fallito");
      const blob = await res.blob();
      const base64 = await blobToBase64(blob);
      await fs.writeFile({
        directory: "DATA",
        path: percorso,
        data: base64,
        recursive: true,
      });
      const { path: coverPath } = await downloadCoverOffline(track);
      return { path: percorso, coverPath };
    } catch (err) {
      ultimoErrore = err;
    }
  }
  throw ultimoErrore || new Error("download fallito");
}

/** pct: 0-100, solo per state "busy" (percentuale mostrata nell'anello). */
function updatePlOfflineButtonUi(state, pct, w = plOfflineW) {
  if (!w.btn) return;
  w.icoDownload.classList.toggle("hidden", state !== "idle");
  w.ring.classList.toggle("hidden", state !== "busy");
  w.progress.classList.toggle("hidden", state !== "busy");
  if (state === "busy") {
    const p = Math.max(0, Math.min(100, pct || 0));
    w.progress.textContent = `${Math.round(p)}%`;
    w.ringFg.style.strokeDashoffset = String(
      RING_CIRCUMFERENCE * (1 - p / 100)
    );
  }
  if (state === "done") showOfflineDoneStatic(w);
  else w.icoDone.classList.add("hidden");
  w.btn.classList.toggle("is-done", state === "done");
  // 07/10: il tasto non si blocca più durante il download, il tocco apre il
  // foglio del download (apriFoglioDownload). mostraLavoroSulTasto rimette
  // "in-pausa" subito dopo, se il lavoro è fermo.
  w.btn.classList.remove("in-pausa");
  w.btn.disabled = false;
  w.btn.title =
    state === "done"
      ? "Scaricata per offline — tocca per aggiornarla o eliminarla"
      : state === "busy"
        ? "Download in corso — tocca per le opzioni"
        : "Scarica per l'ascolto offline";
  w.btn.setAttribute("aria-label", w.btn.title);
}

/** Stato del tasto ↓ per la playlist pid: anello con la percentuale finché
 * esiste un lavoro (spento se è in pausa o fallito), spunta se è scaricata. */
function mostraLavoroSulTasto(w, pid) {
  const l = lavoroDownload(pid);
  if (l) {
    updatePlOfflineButtonUi("busy", l.pct, w);
    w.btn.classList.toggle("in-pausa", !lavoroAttivo(l));
  } else {
    updatePlOfflineButtonUi(isPlaylistOffline(pid) ? "done" : "idle", 0, w);
  }
}

/** Lunghezza vera del path della spunta (misurata dal DOM, non indovinata). */
function fidCheckLen(w) {
  if (w.checkLen == null) {
    try {
      w.checkLen = w.fidCheck.getTotalLength();
    } catch (_) {
      w.checkLen = 20;
    }
  }
  return w.checkLen;
}

/** Mostra lo stato "già scaricata" di colpo, senza disegnarlo — usato
 * quando semplicemente riapri una playlist già scaricata in precedenza. */
function showOfflineDoneStatic(w = plOfflineW) {
  w.icoDone.classList.remove("fid-animate");
  w.fidCircle.style.strokeDasharray = "";
  w.fidCircle.style.strokeDashoffset = "";
  w.fidCheck.style.strokeDasharray = "";
  w.fidCheck.style.strokeDashoffset = "";
  w.icoDone.classList.remove("hidden");
}

/** "Sblocco Face ID": disegna il cerchio, poi la spunta, poi un piccolo pop.
 * Importante: lo stroke-dasharray/offset "nascosto" va impostato PRIMA di
 * rivelare l'icona, altrimenti per un istante si vede il segno già intero
 * (stato di default, non disegnato) prima che parta l'animazione. */
function playOfflineFidAnimation(w = plOfflineW) {
  const len = fidCheckLen(w);
  // Tratteggio "lungo + buco più lungo" e partenza spostata di 3 oltre
  // l'inizio (07/10, Vitto: «un puntino in alto a dx» mentre si disegna):
  // con dasharray = len e offset = len il trattino successivo cominciava
  // ESATTAMENTE alla fine del tracciato, lungo zero, e con le punte tonde
  // diventava un puntino sulla fine della spunta (28.5,10.5) finché non si
  // disegnava. Così nessun trattino tocca il tracciato prima del tempo.
  const C = RING_CIRCUMFERENCE;
  w.fidCircle.style.strokeDasharray = `${C} ${C + 6}`;
  w.fidCircle.style.strokeDashoffset = String(C + 3);
  w.fidCheck.style.strokeDasharray = `${len} ${len + 6}`;
  w.fidCheck.style.strokeDashoffset = String(len + 3);
  w.icoDone.style.setProperty("--fid-circle-len", String(C + 3));
  w.icoDone.style.setProperty("--fid-check-len", String(len + 3));
  w.icoDone.classList.remove("fid-animate");
  w.icoDone.classList.remove("hidden");
  void w.icoDone.offsetWidth; // forza reflow prima di far partire l'animazione
  w.icoDone.classList.add("fid-animate");
}

/** Mostra/nasconde e aggiorna lo stato del bottone offline per la playlist
 * aperta ora — solo app nativa, solo se ci sono brani, e non in modalità
 * offline (lì si può solo rimuovere, dalla vista dedicata). */
function refreshPlOfflineButton(pid, hasTracks) {
  if (!plOfflineW.btn) return;
  if (!isNativeShell() || !hasTracks || appOfflineMode) {
    plOfflineW.btn.classList.add("hidden");
    return;
  }
  plOfflineW.btn.classList.remove("hidden");
  mostraLavoroSulTasto(plOfflineW, pid);
}

/** Come sopra ma per la pseudo-playlist "Brani salvati" (vista dedicata). */
const OFFLINE_SAVED_PID = "__saved__";
function refreshLibOfflineButton() {
  if (!libOfflineW.btn) return;
  if (!isNativeShell() || !libraryTracksCache.length || appOfflineMode) {
    libOfflineW.btn.classList.add("hidden");
    return;
  }
  libOfflineW.btn.classList.remove("hidden");
  mostraLavoroSulTasto(libOfflineW, OFFLINE_SAVED_PID);
}

// —— GESTORE DEI DOWNLOAD OFFLINE (06/10). Vitto: «starto un download
// pesante in travel mode, voglio poter uscire dalla schermata e non essere
// rinchiuso lì finché non finisce; i download li mostriamo nella pagina
// offline con pausa, riprendi, interrompi» + «anche quelli delle playlist».
// Ogni download (playlist, Brani salvati, viaggio) è un lavoro in una coda
// unica: ne gira uno alla volta (dentro, 3 brani in parallelo come prima),
// gli altri aspettano "in coda". La coda è salvata: se l'app si chiude a
// metà, alla riapertura il lavoro torna "in pausa" e Riprendi riparte da dove
// era (i brani arrivati restano e non si riscaricano). Pausa e Interrompi non
// troncano i brani già partiti (il download nativo non si annulla): il lavoro
// si ferma appena finiscono quelli in volo. ——
const DOWNLOAD_CODA_KEY = "crackify_download_coda";
const downloadLavori = []; // { pid, pl, ownerId, stato, fatti, totale, pct, falliti, interrotto, annulla }
let _lavoroInCorso = null;
const _attesaLavori = new Map(); // pid → [resolve] di chi aspetta la fine
let _foglioDlPid = null; // playlist mostrata dal foglio del download, se aperto

function salvaCodaDownload() {
  try {
    localStorage.setItem(
      DOWNLOAD_CODA_KEY,
      JSON.stringify(
        downloadLavori.map((l) => ({
          pid: l.pid,
          pl: l.pl,
          ownerId: l.ownerId,
          stato: l.stato,
          fatti: l.fatti,
          totale: l.totale,
          pct: l.pct,
          falliti: l.falliti,
        }))
      )
    );
  } catch (_) {}
}

/** All'avvio: niente riparte da solo, quello che girava torna "in pausa". */
function caricaCodaDownload() {
  try {
    const arr = JSON.parse(localStorage.getItem(DOWNLOAD_CODA_KEY) || "[]");
    (Array.isArray(arr) ? arr : []).forEach((l) => {
      if (!l || !l.pid || !l.pl || !Array.isArray(l.pl.tracks)) return;
      if (lavoroDownload(l.pid)) return;
      const girava = l.stato === "corso" || l.stato === "coda";
      // percentuale vera da quello che è già sul telefono (la coda salvata
      // la aggiorna solo ai cambi di stato, non a ogni pezzo)
      const gia = getOfflineTracks();
      const arrivati = l.pl.tracks.filter((t) => gia[t.id]).length;
      // playlist già scaricata: resta in coda solo un aggiornamento (07/10)
      // che ha ancora brani da prendere
      if (isPlaylistOffline(l.pid) && arrivati === l.pl.tracks.length) return;
      downloadLavori.push({
        ...l,
        fatti: arrivati,
        totale: l.pl.tracks.length,
        pct: l.pl.tracks.length ? (arrivati / l.pl.tracks.length) * 100 : 0,
        stato: l.stato === "errore" ? "errore" : "pausa",
        interrotto: girava,
        annulla: false,
      });
    });
  } catch (_) {}
}

function lavoroDownload(pid) {
  return downloadLavori.find((l) => l.pid === pid) || null;
}
function lavoroAttivo(l) {
  return !!l && (l.stato === "corso" || l.stato === "coda");
}

function nomeLavoroDownload(l) {
  return nomePlaylistOffline(l.pid, { pl: l.pl });
}

/** Il tasto ↓ che mostra questo lavoro, se è sullo schermo adesso: Brani
 * salvati ha il suo, le playlist SOLO se è aperta proprio quella (prima la
 * percentuale di A finiva sul tasto di B se aprivi un'altra playlist). */
function widgetDelLavoro(pid) {
  if (pid === OFFLINE_SAVED_PID) return libOfflineW;
  let pigra = null;
  try {
    pigra = openLazyKind;
  } catch (_) {}
  if (pid === openPlaylistId && !pigra) return plOfflineW;
  return null;
}

let _notificaChiesta = false;
/** Avvisa tutti quelli che mostrano un lavoro. cambioStato = ridisegna le
 * righe; senza, aggiorna solo numeri e barre (più leggero, gira a ogni
 * pezzo di brano). */
function notificaLavoro(l, cambioStato) {
  const w = widgetDelLavoro(l.pid);
  if (w && (cambioStato || lavoroAttivo(l))) mostraLavoroSulTasto(w, l.pid);
  if (cambioStato) {
    disegnaDownloadOffline();
    aggiornaCardOffline();
    if (_foglioDlPid) aggiornaFoglioDownload();
  } else if (!_notificaChiesta) {
    _notificaChiesta = true;
    requestAnimationFrame(() => {
      _notificaChiesta = false;
      downloadLavori.forEach(aggiornaRigaDownload);
      if (_foglioDlPid) aggiornaFoglioDownload();
    });
  }
  if (l.pid === viaggio.pid) viaggioAggiornaIndicatore();
}

function _risolviAttese(pid) {
  (_attesaLavori.get(pid) || []).forEach((r) => r());
  _attesaLavori.delete(pid);
}

/** pl = risposta completa /api/playlists/{pid} (o /api/home/playlists/...):
 * si salva per intero, non solo gli id, così in modalità offline si può
 * mostrare nome/brani senza bisogno di rete. Mette il download in coda (o
 * riprende quello in pausa della stessa playlist) e risolve a lavoro finito. */
function downloadPlaylistOffline(pid, pl, ownerId) {
  // un brano senza indirizzo audio falliva sempre e la playlist non
  // finiva mai: si scarica (e si registra) solo quello che si può suonare
  const tracks = ((pl && pl.tracks) || []).filter((t) => t && t.id && t.stream_url);
  if (!offlineFs() || !tracks.length) return Promise.resolve();
  pl = { ...pl, tracks };
  let l = lavoroDownload(pid);
  if (l) {
    if (!lavoroAttivo(l)) riprendiLavoro(pid);
  } else {
    l = {
      pid,
      pl,
      ownerId: ownerId || null,
      stato: "coda",
      fatti: 0,
      totale: tracks.length,
      pct: 0,
      falliti: 0,
      interrotto: false,
      annulla: false,
    };
    downloadLavori.push(l);
    salvaCodaDownload();
    if (_lavoroInCorso) toast("In coda: parte appena finisce il download in corso");
    notificaLavoro(l, true);
    avviaProssimoLavoro();
  }
  return new Promise((r) => {
    if (!_attesaLavori.has(pid)) _attesaLavori.set(pid, []);
    _attesaLavori.get(pid).push(r);
  });
}

async function avviaProssimoLavoro() {
  if (_lavoroInCorso || appOfflineMode) return;
  const l = downloadLavori.find((x) => x.stato === "coda");
  if (!l) return;
  _lavoroInCorso = l;
  l.stato = "corso";
  l.interrotto = false;
  l.falliti = 0;
  salvaCodaDownload();
  notificaLavoro(l, true);
  let ultimoErrore = null;
  try {
    ultimoErrore = await eseguiLavoro(l);
  } catch (err) {
    ultimoErrore = err;
  }
  _lavoroInCorso = null;
  if (l.annulla) {
    await scartaLavoro(l);
  } else if (l.stato === "corso") {
    if (l.falliti && l.vistoNascosto && (l.autoRiprese || 0) < 2) {
      // fallito mentre l'app era in background (iOS la sospende e i
      // download cadono): si riprova da solo quando torna davanti
      l.stato = "errore";
      l.riprovaAlRitorno = true;
      if (document.visibilityState === "visible") {
        l.autoRiprese = (l.autoRiprese || 0) + 1;
        l.riprovaAlRitorno = false;
        l.vistoNascosto = false;
        l.stato = "coda";
      }
    } else if (l.falliti) {
      l.stato = "errore";
      toast(
        `${l.falliti} ${l.falliti === 1 ? "brano non scaricato" : "brani non scaricati"}: riprova da Offline mode` +
          (ultimoErrore && ultimoErrore.message ? ` (${ultimoErrore.message})` : "")
      );
    } else {
      completaLavoro(l);
    }
  }
  // "pausa": fermato a metà; "coda": ripreso mentre finiva i brani in volo
  salvaCodaDownload();
  if (lavoroDownload(l.pid)) notificaLavoro(l, true);
  avviaProssimoLavoro();
}

async function eseguiLavoro(l) {
  const tracks = l.pl.tracks || [];
  l.totale = tracks.length;
  // 3 brani alla volta invece di uno (05/10): fuori casa ogni richiesta fa
  // il giro dal relay di Tailscale, e in fila le attese si sommavano.
  // Misurato dal MacBook via relay: 4 brani 71s uno dopo l'altro, 42s
  // insieme. Più di 3 non serve: il tetto è l'upload di casa (~15 Mbit).
  // Un brano che fallisce non ferma gli altri: chi è arrivato resta
  // salvato e riprovando si scarica solo quello che manca.
  const ALLA_VOLTA = 3;
  let prossimo = 0;
  let fatti = 0;
  let ultimoErrore = null;
  // tempo stimato del foglio (07/10): si misura sui brani scaricati DAVVERO.
  // La percentuale non va bene: i brani già sul telefono (ripresa, brani in
  // comune con altre playlist) la fanno saltare avanti in un attimo e il
  // ritmo sembrerebbe altissimo.
  const presenti = getOfflineTracks();
  l._daScaricare = tracks.filter((t) => !presenti[t.id]).length;
  l._scaricati = 0;
  l._ritmo = [{ t: Date.now(), v: 0 }];
  l._eta = null;
  let veri = 0;
  // brani in volo → frazione già arrivata: la percentuale conta anche i
  // pezzi di brano, non solo quelli finiti (06/10, «il tasto segua
  // progressivamente il download»)
  const inVolo = new Map();
  const mostra = () => {
    let parziale = 0;
    inVolo.forEach((f) => (parziale += f));
    l.fatti = fatti;
    // mai all'indietro: ripresa dopo una pausa riparte da 0 ma ripassa in
    // un attimo i brani già arrivati
    l.pct = Math.max(l.pct || 0, Math.min(100, ((fatti + parziale) / tracks.length) * 100));
    l._scaricati = veri + parziale;
    campionaRitmoDownload(l);
    notificaLavoro(l, false);
  };
  const operaio = async () => {
    while (prossimo < tracks.length && l.stato === "corso" && !l.annulla) {
      const t = tracks[prossimo++];
      let vero = false;
      try {
        const gia = getOfflineTracks()[t.id];
        if (!gia) {
          vero = true;
          inVolo.set(t.id, 0);
          // fino a 3 tentativi per brano: un intoppo del relay non deve far
          // fallire tutta la playlist (ricontrollo del 06/10)
          let esito = null;
          for (let prova = 0; prova < 3 && !esito; prova++) {
            if (prova) {
              await new Promise((r) => setTimeout(r, prova === 1 ? 2000 : 5000));
              if (l.annulla || l.stato !== "corso") break;
              inVolo.set(t.id, 0);
            }
            try {
              esito = await downloadTrackOffline(t, (f) => {
                if (!inVolo.has(t.id)) return;
                inVolo.set(t.id, f);
                mostra();
              });
            } catch (err) {
              if (prova === 2) throw err;
            }
          }
          if (!esito) throw new Error("download fermato");
          const { path, coverPath } = esito;
          // mappa riletta qui e non tenuta da inizio lavoro: nel frattempo
          // qualcuno può aver rimosso altro (o eliminato tutto)
          const m = getOfflineTracks();
          m[t.id] = { path, coverPath };
          setOfflineTracks(m); // salva via via: un crash a metà non perde quanto fatto
          veri++;
        } else if (!gia.coverPath) {
          // scaricato prima che esistesse la cache delle copertine: recupera
          // solo quella, senza riscaricare l'audio già presente
          const { path: coverPath } = await downloadCoverOffline(t);
          if (coverPath) {
            const m = getOfflineTracks();
            if (m[t.id]) {
              m[t.id] = { ...m[t.id], coverPath };
              setOfflineTracks(m);
            }
          }
        }
      } catch (err) {
        l.falliti++;
        ultimoErrore = err;
        // non arriverà più: fuori dal conto del tempo stimato
        if (vero) l._daScaricare = Math.max(0, (l._daScaricare || 0) - 1);
      }
      inVolo.delete(t.id);
      fatti++;
      mostra();
    }
  };
  await Promise.all(Array.from({ length: Math.min(ALLA_VOLTA, tracks.length) }, operaio));
  // fermato da pausa/interrompi prima della fine: non è un errore
  if (prossimo < tracks.length) l.falliti = 0;
  return ultimoErrore;
}

function completaLavoro(l) {
  const playlists = getOfflinePlaylists();
  const vecchia = playlists[l.pid] || null; // c'era già: era un aggiornamento
  playlists[l.pid] = { pl: l.pl, ownerId: l.ownerId || null };
  setOfflinePlaylists(playlists);
  downloadLavori.splice(downloadLavori.indexOf(l), 1);
  salvaCodaDownload();
  // aggiornamento: i brani tolti dalla playlist dopo la copia offline se ne
  // vanno anche dal telefono (se nient'altro li usa)
  if (vecchia) {
    const ora = new Set((l.pl.tracks || []).map((t) => t.id));
    eliminaBraniOfflineOrfani(
      ((vecchia.pl && vecchia.pl.tracks) || []).filter((t) => !ora.has(t.id))
    );
  }
  const w = widgetDelLavoro(l.pid);
  if (w) {
    updatePlOfflineButtonUi("done", 0, w);
    playOfflineFidAnimation(w);
  }
  toast(
    vecchia
      ? `Copia offline di «${nomeLavoroDownload(l)}» aggiornata`
      : `«${nomeLavoroDownload(l)}» scaricata per l'ascolto offline`
  );
  if (l.pid === viaggio.pid) viaggioFinito(true);
  if (appOfflineMode) renderOfflinePlaylistsGrid();
  disegnaDownloadOffline();
  aggiornaCardOffline();
  if (!document.getElementById("settingsOffline")?.classList.contains("hidden")) aggiornaPannelloOffline();
  // foglio aperto su questa playlist: passa da sé alla versione "finita"
  if (_foglioDlPid === l.pid) aggiornaFoglioDownload();
  _risolviAttese(l.pid);
}

function pausaLavoro(pid) {
  const l = lavoroDownload(pid);
  if (!lavoroAttivo(l)) return;
  l.stato = "pausa"; // se gira, si ferma appena finiscono i brani in volo
  salvaCodaDownload();
  notificaLavoro(l, true);
  if (_lavoroInCorso !== l) avviaProssimoLavoro();
}

function riprendiLavoro(pid) {
  const l = lavoroDownload(pid);
  if (!l || lavoroAttivo(l)) return;
  if (appOfflineMode) {
    toast("Per scaricare serve la connessione al Mac");
    return;
  }
  l.stato = "coda";
  l.falliti = 0;
  l.interrotto = false;
  salvaCodaDownload();
  notificaLavoro(l, true);
  avviaProssimoLavoro();
}

/** Interrompi = annulla: il lavoro sparisce e i brani che aveva già
 * scaricato si cancellano (se nessuna playlist scaricata o altro download li
 * usa). Se sta girando, lo fa appena finiscono i brani in volo. */
async function interrompiLavoro(pid) {
  const l = lavoroDownload(pid);
  if (!l) return;
  l.annulla = true;
  if (_lavoroInCorso === l) {
    notificaLavoro(l, true);
    return;
  }
  await scartaLavoro(l);
  avviaProssimoLavoro();
}

/** Cancella dal telefono (audio + copertina) i brani di questa lista che
 * nessuna playlist scaricata e nessun download ancora in coda usa più. */
async function eliminaBraniOfflineOrfani(tracks) {
  if (!tracks.length) return;
  const usati = new Set();
  Object.values(getOfflinePlaylists()).forEach((e) =>
    ((e.pl && e.pl.tracks) || []).forEach((t) => usati.add(t.id))
  );
  downloadLavori.forEach((x) => (x.pl.tracks || []).forEach((t) => usati.add(t.id)));
  const fs = offlineFs();
  const m = getOfflineTracks();
  const via = tracks.filter((t) => !usati.has(t.id) && m[t.id]);
  if (!via.length) return;
  for (const t of via) {
    for (const p of [m[t.id].path, m[t.id].coverPath]) {
      if (!p || !fs) continue;
      try {
        await fs.deleteFile({ directory: "DATA", path: p });
      } catch (_) {}
    }
  }
  // mappa riletta dopo le cancellazioni (await): nel frattempo un download
  // può averci scritto altri brani
  const ora = getOfflineTracks();
  via.forEach((t) => delete ora[t.id]);
  setOfflineTracks(ora);
}

async function scartaLavoro(l) {
  const i = downloadLavori.indexOf(l);
  if (i >= 0) downloadLavori.splice(i, 1);
  salvaCodaDownload();
  await eliminaBraniOfflineOrfani(l.pl.tracks || []);
  const w = widgetDelLavoro(l.pid);
  if (w) updatePlOfflineButtonUi(isPlaylistOffline(l.pid) ? "done" : "idle", 0, w);
  if (l.pid === viaggio.pid) viaggioFinito(false);
  // cancellato l'aggiornamento di una playlist già scaricata: il foglio
  // torna alla versione "finita"; altrimenti non ha più niente da mostrare
  if (_foglioDlPid === l.pid) {
    if (isPlaylistOffline(l.pid)) aggiornaFoglioDownload();
    else chiudiFoglioDownload();
  }
  toast(`Download di «${nomeLavoroDownload(l)}» interrotto`);
  disegnaDownloadOffline();
  aggiornaCardOffline();
  if (!document.getElementById("settingsOffline")?.classList.contains("hidden")) aggiornaPannelloOffline();
  _risolviAttese(l.pid);
}

function testoStatoLavoro(l) {
  const pct = Math.floor(l.pct || 0);
  if (l.annulla) return "Interrompo…";
  if (l.stato === "corso") return `Scarico · ${l.fatti || 0} di ${l.totale} brani · ${pct}%`;
  if (l.stato === "coda") return `In coda · ${l.totale} brani`;
  if (l.stato === "errore") {
    return `${l.falliti} ${l.falliti === 1 ? "brano non scaricato" : "brani non scaricati"} · ${pct}%`;
  }
  if (appOfflineMode) return `In pausa · ${pct}% · riprende quando torni online`;
  return `In pausa · ${pct}%` + (l.interrotto ? " · fermato alla chiusura dell'app" : "");
}

function aggiornaRigaDownload(l) {
  const li = document.querySelector(`#offlineDlLista li[data-pid="${CSS.escape(l.pid)}"]`);
  if (!li) return;
  const stato = li.querySelector(".offline-dl-stato");
  if (stato) stato.textContent = testoStatoLavoro(l);
  const barra = li.querySelector(".offline-dl-barra-pieno");
  if (barra) barra.style.width = `${l.pct || 0}%`;
}

const _ICONA_PAUSA =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>';
const _ICONA_RIPRENDI =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.2-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/></svg>';
const _ICONA_RIPROVA =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>';

/** Sezione "Download" del pannello Offline mode: una riga per lavoro con
 * stato, barra e i comandi (pausa/riprendi o riprova, e interrompi). */
function disegnaDownloadOffline() {
  const lista = document.getElementById("offlineDlLista");
  const titolo = document.getElementById("offlineDlTitolo");
  if (!lista) return;
  if (titolo) titolo.classList.toggle("hidden", !downloadLavori.length);
  lista.innerHTML = "";
  const tracce = getOfflineTracks();
  downloadLavori.forEach((l) => {
    const li = document.createElement("li");
    li.className = "offline-dl-riga";
    li.dataset.pid = l.pid;
    const cover = document.createElement("span");
    cover.className = "offline-lista-cover";
    cover.textContent =
      l.pid === OFFLINE_SAVED_PID ? "♥" : l.pid.startsWith("__viaggio_") ? "✈" : "♪";
    const testo = document.createElement("span");
    testo.className = "offline-lista-testo";
    const nome = document.createElement("strong");
    nome.textContent = nomeLavoroDownload(l);
    const stato = document.createElement("span");
    stato.className = "offline-dl-stato";
    stato.textContent = testoStatoLavoro(l);
    testo.append(nome, stato);
    const comandi = document.createElement("span");
    comandi.className = "offline-dl-comandi";
    if (!l.annulla) {
      const primo = document.createElement("button");
      primo.type = "button";
      primo.className = "offline-dl-btn";
      if (lavoroAttivo(l)) {
        primo.innerHTML = _ICONA_PAUSA;
        primo.setAttribute("aria-label", "Pausa");
        primo.addEventListener("click", () => pausaLavoro(l.pid));
      } else {
        primo.innerHTML = l.stato === "errore" ? _ICONA_RIPROVA : _ICONA_RIPRENDI;
        primo.setAttribute("aria-label", l.stato === "errore" ? "Riprova" : "Riprendi");
        primo.disabled = appOfflineMode;
        primo.addEventListener("click", () => riprendiLavoro(l.pid));
      }
      const ferma = document.createElement("button");
      ferma.type = "button";
      ferma.className = "offline-dl-btn offline-dl-ferma";
      ferma.setAttribute("aria-label", "Interrompi");
      ferma.textContent = "×";
      let confermaTimer = null;
      ferma.addEventListener("click", () => {
        // doppio tocco: interrompere cancella anche quello già scaricato
        if (!ferma.classList.contains("conferma")) {
          ferma.classList.add("conferma");
          ferma.textContent = "Interrompi?";
          confermaTimer = setTimeout(() => {
            ferma.classList.remove("conferma");
            ferma.textContent = "×";
          }, 3000);
          return;
        }
        clearTimeout(confermaTimer);
        interrompiLavoro(l.pid);
      });
      comandi.append(primo, ferma);
    }
    const barra = document.createElement("span");
    barra.className = "offline-dl-barra";
    const pieno = document.createElement("span");
    pieno.className = "offline-dl-barra-pieno";
    pieno.style.width = `${l.pct || 0}%`;
    barra.appendChild(pieno);
    li.classList.toggle("in-pausa", !lavoroAttivo(l));
    li.append(cover, testo, comandi, barra);
    lista.appendChild(li);
    const conCover = (l.pl.tracks || []).find((t) => tracce[t.id] && tracce[t.id].coverPath);
    if (conCover && l.pid !== OFFLINE_SAVED_PID) {
      getOfflineTrackCoverSrc(conCover.id).then((src) => {
        if (!src) return;
        const img = document.createElement("img");
        img.className = "offline-lista-cover";
        img.alt = "";
        img.src = src;
        img.onload = () => cover.replaceWith(img);
      });
    }
  });
}

// —— FOGLIO DEL DOWNLOAD (07/10). Vitto: «al primo click deve far partire
// il download come fa adesso, e una volta che è in corso con un secondo
// click sull'icona apre una finestra con tempo stimato / sospendi riprendi
// cancella» + «una volta che ha terminato, se ci clicchi di nuovo chiede una
// conferma per eliminare i brani salvati o includere nella copia offline le
// canzoni aggiunte dopo». Un solo foglio con due facce: "lavoro" (esiste un
// download: in corso, in coda, in pausa o fallito) e "finita" (playlist
// scaricata, nessun download). ——
const dlSheet = document.getElementById("dlSheet");
let _foglioDlTimer = null;
let _foglioDlConferma = null;

/** Ritmo dei brani scaricati davvero, campionato a ogni pezzo: finestra
 * degli ultimi 40 s, così una frenata del relay si vede presto nella stima. */
function campionaRitmoDownload(l) {
  const c = l._ritmo;
  if (!c) return;
  const ora = Date.now();
  if (ora - c[c.length - 1].t < 500) return;
  c.push({ t: ora, v: l._scaricati || 0 });
  while (c.length > 2 && ora - c[0].t > 40000) c.shift();
}

/** Secondi che mancano, o null finché non c'è abbastanza da misurare. Il
 * ritmo si calcola fino ad ADESSO, non all'ultimo pezzo arrivato: se il
 * download si pianta la stima cresce invece di restare ferma. */
function stimaSecondiDownload(l) {
  const c = l._ritmo;
  if (!c || l.stato !== "corso" || l.annulla) return null;
  const resto = Math.max(0, (l._daScaricare || 0) - (l._scaricati || 0));
  if (resto <= 0) return 0;
  const dt = (Date.now() - c[0].t) / 1000;
  const fatto = (l._scaricati || 0) - c[0].v;
  if (dt < 4 || fatto <= 0) return null;
  const sec = resto / (fatto / dt);
  // media mobile leggera: niente minuti che ballano a ogni secondo
  l._eta = l._eta == null ? sec : l._eta * 0.7 + sec * 0.3;
  return l._eta;
}

function testoTempoRimanente(sec) {
  if (sec == null) return "Calcolo il tempo rimanente…";
  if (sec < 10) return "Quasi finito";
  if (sec < 55) return `Mancano circa ${Math.round(sec / 5) * 5} s`;
  const min = Math.max(1, Math.round(sec / 60));
  if (min < 60) return min === 1 ? "Manca circa 1 min" : `Mancano circa ${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `Mancano circa ${h} h${m ? ` ${m} min` : ""}`;
}

/** La playlist com'è adesso (per aggiornare la copia offline), solo se è
 * quella sullo schermo: Brani salvati o la playlist vera aperta. */
function playlistAttualePerOffline(pid) {
  let pl = null;
  if (pid === OFFLINE_SAVED_PID) {
    if (libraryTracksCache.length) pl = { name: "Brani salvati", tracks: libraryTracksCache.slice() };
  } else if (pid === openPlaylistId && !openLazyKind) {
    pl = openPlaylistOwnerId ? _openHomePlaylistFull : _openPlaylistFull;
  }
  if (!pl) return null;
  return { pl, ownerId: pid === OFFLINE_SAVED_PID ? null : openPlaylistOwnerId || null };
}

/** Differenza fra la copia offline e la playlist di adesso. */
function differenzaCopiaOffline(pid) {
  const entry = getOfflinePlaylists()[pid];
  const attuale = playlistAttualePerOffline(pid);
  if (!entry || !attuale) return null;
  const vecchi = new Set(((entry.pl && entry.pl.tracks) || []).map((t) => t.id));
  const adesso = (attuale.pl.tracks || []).filter((t) => t && t.id && t.stream_url);
  const ids = new Set(adesso.map((t) => t.id));
  return {
    nuovi: adesso.filter((t) => !vecchi.has(t.id)).length,
    tolti: [...vecchi].filter((id) => !ids.has(id)).length,
    totale: vecchi.size,
    attuale,
  };
}

function azzeraConfermaCancellaDl() {
  clearTimeout(_foglioDlConferma);
  _foglioDlConferma = null;
  document.getElementById("dlSheetCancella")?.classList.remove("conferma");
}

function aggiornaFoglioDownload() {
  if (!dlSheet || !_foglioDlPid) return;
  const pid = _foglioDlPid;
  const l = lavoroDownload(pid);
  const finita = !l && isPlaylistOffline(pid);
  if (!l && !finita) {
    chiudiFoglioDownload();
    return;
  }
  const $id = (x) => document.getElementById(x);
  const conferma = $id("dlSheetCancella")?.classList.contains("conferma");
  dlSheet.classList.toggle("finita", finita);
  dlSheet.classList.toggle("fermo", !!l && !lavoroAttivo(l));
  $id("dlSheetBarra").parentElement.classList.toggle("hidden", finita);
  $id("dlSheetPct").classList.toggle("hidden", finita);
  $id("dlSheetPausa").classList.toggle("hidden", finita || (l && l.annulla));
  $id("dlSheetAggiorna").classList.toggle("hidden", !finita);
  $id("dlSheetCancella").classList.toggle("hidden", !!(l && l.annulla));

  if (finita) {
    const entry = getOfflinePlaylists()[pid];
    const n = ((entry.pl && entry.pl.tracks) || []).length;
    $id("dlSheetNome").textContent = nomePlaylistOffline(pid, entry);
    $id("dlSheetBrani").textContent = `Scaricata · ${n} ${n === 1 ? "brano" : "brani"}`;
    const diff = differenzaCopiaOffline(pid);
    const agg = $id("dlSheetAggiorna");
    const aggSub = $id("dlSheetAggiornaSub");
    let stato;
    if (!diff) {
      stato = "Copia offline sul telefono";
      agg.disabled = true;
      aggSub.textContent = "";
    } else if (!diff.nuovi && !diff.tolti) {
      stato = "Copia offline aggiornata: ci sono tutti i brani";
      agg.disabled = true;
      aggSub.textContent = "Nessun brano nuovo";
    } else {
      const pezzi = [];
      if (diff.nuovi) pezzi.push(`${diff.nuovi} ${diff.nuovi === 1 ? "brano nuovo" : "brani nuovi"}`);
      if (diff.tolti) pezzi.push(`${diff.tolti} ${diff.tolti === 1 ? "tolto" : "tolti"}`);
      stato = `${pezzi.join(", ")} dopo il download`;
      agg.disabled = appOfflineMode;
      aggSub.textContent = diff.nuovi
        ? `Scarica ${diff.nuovi === 1 ? "il brano nuovo" : `i ${diff.nuovi} brani nuovi`}`
        : "Togli dal telefono i brani non più in playlist";
    }
    $id("dlSheetTempo").textContent = stato;
    if (!conferma) {
      $id("dlSheetCancellaLabel").textContent = "Elimina download";
      $id("dlSheetCancellaSub").textContent = "";
    }
  } else {
    $id("dlSheetNome").textContent = nomeLavoroDownload(l);
    $id("dlSheetBrani").textContent = `${l.fatti || 0} di ${l.totale} brani`;
    const pct = Math.floor(l.pct || 0);
    $id("dlSheetPct").textContent = `${pct}%`;
    $id("dlSheetBarra").style.width = `${l.pct || 0}%`;
    let stato;
    if (l.annulla) stato = "Cancello…";
    else if (l.stato === "corso") stato = testoTempoRimanente(stimaSecondiDownload(l));
    else if (l.stato === "coda") {
      stato = _lavoroInCorso
        ? `In coda · parte dopo «${nomeLavoroDownload(_lavoroInCorso)}»`
        : "In coda";
    } else if (l.stato === "errore") {
      stato = `${l.falliti} ${l.falliti === 1 ? "brano non scaricato" : "brani non scaricati"}`;
    } else if (appOfflineMode) stato = "In pausa · riprende quando torni online";
    else stato = l.interrotto ? "In pausa · fermato alla chiusura dell'app" : "In pausa";
    $id("dlSheetTempo").textContent = stato;
    const attivo = lavoroAttivo(l);
    $id("dlSheetPausaIco").innerHTML = attivo
      ? _ICONA_PAUSA
      : l.stato === "errore"
        ? _ICONA_RIPROVA
        : _ICONA_RIPRENDI;
    $id("dlSheetPausaLabel").textContent = attivo
      ? "Sospendi"
      : l.stato === "errore"
        ? "Riprova i brani mancanti"
        : "Riprendi";
    $id("dlSheetPausa").disabled = !attivo && appOfflineMode;
    if (!conferma) {
      // aggiornamento di una playlist già scaricata: si annulla solo il
      // nuovo, la copia offline di prima resta
      $id("dlSheetCancellaLabel").textContent = isPlaylistOffline(pid)
        ? "Annulla aggiornamento"
        : "Cancella download";
      $id("dlSheetCancellaSub").textContent = "";
    }
  }
}

function apriFoglioDownload(pid) {
  if (!dlSheet || (!lavoroDownload(pid) && !isPlaylistOffline(pid))) return;
  _foglioDlPid = pid;
  azzeraConfermaCancellaDl();
  const cover = document.getElementById("dlSheetCover");
  cover.style.backgroundImage = "";
  cover.textContent = pid === OFFLINE_SAVED_PID ? "♥" : pid.startsWith("__viaggio_") ? "✈" : "♪";
  // copertina: quella di un brano già sul telefono, come nel pannello Offline
  const l = lavoroDownload(pid);
  const entry = getOfflinePlaylists()[pid];
  const tracce = getOfflineTracks();
  const lista = (l && l.pl.tracks) || (entry && entry.pl && entry.pl.tracks) || [];
  const conCover = lista.find((t) => tracce[t.id] && tracce[t.id].coverPath);
  if (conCover && pid !== OFFLINE_SAVED_PID) {
    getOfflineTrackCoverSrc(conCover.id).then((src) => {
      if (!src || _foglioDlPid !== pid) return;
      // solo a immagine caricata: se il file non si apre resta la nota
      const img = new Image();
      img.onload = () => {
        if (_foglioDlPid !== pid) return;
        cover.style.backgroundImage = `url("${src}")`;
        cover.textContent = "";
      };
      img.src = src;
    });
  }
  aggiornaFoglioDownload();
  // il tempo stimato si muove anche senza nuovi pezzi (download piantato)
  clearInterval(_foglioDlTimer);
  _foglioDlTimer = setInterval(aggiornaFoglioDownload, 1000);
  dlSheet.classList.add("open");
  dlSheet.setAttribute("aria-hidden", "false");
}

function chiudiFoglioDownload() {
  if (!dlSheet) return;
  clearInterval(_foglioDlTimer);
  _foglioDlTimer = null;
  azzeraConfermaCancellaDl();
  _foglioDlPid = null;
  dlSheet.classList.remove("open");
  dlSheet.setAttribute("aria-hidden", "true");
}

if (dlSheet) {
  document.getElementById("dlSheetBackdrop")?.addEventListener("click", chiudiFoglioDownload);
  document.getElementById("dlSheetPausa")?.addEventListener("click", () => {
    const l = lavoroDownload(_foglioDlPid);
    if (!l) return;
    if (lavoroAttivo(l)) pausaLavoro(l.pid);
    else riprendiLavoro(l.pid);
  });
  document.getElementById("dlSheetAggiorna")?.addEventListener("click", () => {
    const pid = _foglioDlPid;
    const diff = pid && differenzaCopiaOffline(pid);
    if (!diff || (!diff.nuovi && !diff.tolti)) return;
    // stesso giro di un download nuovo: i brani già sul telefono si saltano,
    // a fine lavoro la copia offline prende la lista nuova (completaLavoro)
    downloadPlaylistOffline(pid, diff.attuale.pl, diff.attuale.ownerId);
    aggiornaFoglioDownload();
  });
  document.getElementById("dlSheetTutti")?.addEventListener("click", () => {
    chiudiFoglioDownload();
    openAccountModal();
    showSettingsPanel("settingsOffline");
  });
  document.getElementById("dlSheetCancella")?.addEventListener("click", async () => {
    const pid = _foglioDlPid;
    if (!pid) return;
    const btn = document.getElementById("dlSheetCancella");
    const l = lavoroDownload(pid);
    // doppio tocco, come la × del pannello Offline mode: si butta via
    // anche quello che è già sul telefono
    if (!btn.classList.contains("conferma")) {
      btn.classList.add("conferma");
      document.getElementById("dlSheetCancellaLabel").textContent = "Tocca di nuovo per confermare";
      let sotto;
      if (l && isPlaylistOffline(pid)) sotto = "La copia offline di prima resta";
      else if (l) {
        const tracce = getOfflineTracks();
        const arrivati = (l.pl.tracks || []).filter((t) => tracce[t.id]).length;
        sotto = arrivati
          ? `Elimina anche ${arrivati === 1 ? "il brano già scaricato" : `i ${arrivati} brani già scaricati`}`
          : "Non è ancora arrivato nessun brano";
      } else {
        const entry = getOfflinePlaylists()[pid];
        const n = ((entry && entry.pl && entry.pl.tracks) || []).length;
        sotto = `Toglie ${n === 1 ? "il brano" : `i ${n} brani`} dal telefono`;
      }
      document.getElementById("dlSheetCancellaSub").textContent = sotto;
      _foglioDlConferma = setTimeout(() => {
        azzeraConfermaCancellaDl();
        aggiornaFoglioDownload();
      }, 4000);
      return;
    }
    azzeraConfermaCancellaDl();
    if (l) {
      // se gira, si ferma appena finiscono i brani in volo ("Cancello…")
      interrompiLavoro(pid);
      aggiornaFoglioDownload();
      return;
    }
    chiudiFoglioDownload();
    const w = pid === OFFLINE_SAVED_PID ? libOfflineW : plOfflineW;
    await removePlaylistOffline(pid, w);
  });
}

async function removePlaylistOffline(pid, w = plOfflineW) {
  const fs = offlineFs();
  const playlists = getOfflinePlaylists();
  const entry = playlists[pid];
  if (!entry) return;
  const ids = (entry.pl.tracks || []).map((t) => t.id);
  delete playlists[pid];
  setOfflinePlaylists(playlists);
  // un brano si cancella solo se nessun'altra playlist scaricata lo referenzia più
  const stillUsed = new Set();
  Object.values(playlists).forEach((e) =>
    (e.pl.tracks || []).forEach((t) => stillUsed.add(t.id))
  );
  const tracksMap = getOfflineTracks();
  for (const id of ids) {
    if (stillUsed.has(id)) continue;
    const tEntry = tracksMap[id];
    if (tEntry && fs) {
      // anche la copertina (05/10): prima restava sul telefono per sempre
      for (const p of [tEntry.path, tEntry.coverPath]) {
        if (!p) continue;
        try {
          await fs.deleteFile({ directory: "DATA", path: p });
        } catch (_) {}
      }
    }
    delete tracksMap[id];
  }
  setOfflineTracks(tracksMap);
  updatePlOfflineButtonUi("idle", 0, w);
  if (appOfflineMode) renderOfflinePlaylistsGrid();
  toast("Copia offline rimossa");
}

if (plOfflineW.btn) {
  plOfflineW.btn.addEventListener("click", async () => {
    if (openLazyKind) {
      await startLazyDownload();
      return;
    }
    if (!openPlaylistId || plOfflineW.btn.disabled) return;
    // primo tocco = scarica; poi (download esistente o playlist già
    // scaricata) il tocco apre il foglio del download
    if (lavoroDownload(openPlaylistId) || isPlaylistOffline(openPlaylistId)) {
      apriFoglioDownload(openPlaylistId);
      return;
    }
    const pl = openPlaylistOwnerId ? _openHomePlaylistFull : _openPlaylistFull;
    if (!pl) return;
    await downloadPlaylistOffline(openPlaylistId, pl, openPlaylistOwnerId || null);
  });
}

if (libOfflineW.btn) {
  libOfflineW.btn.addEventListener("click", async () => {
    if (libOfflineW.btn.disabled) return;
    if (lavoroDownload(OFFLINE_SAVED_PID) || isPlaylistOffline(OFFLINE_SAVED_PID)) {
      apriFoglioDownload(OFFLINE_SAVED_PID);
      return;
    }
    if (!libraryTracksCache.length) return;
    // pseudo-playlist: stesso formato del manifest delle playlist vere, così
    // tutta la pipeline offline (grid, dettaglio, play) funziona invariata
    const pl = { name: "Brani salvati", tracks: libraryTracksCache.slice() };
    await downloadPlaylistOffline(OFFLINE_SAVED_PID, pl, null, libOfflineW);
  });
}

/** Visibile solo per playlist di un altro utente, con brani, e non offline
 * (serve rete: copia i file e crea la playlist lato server). */
function refreshPlAdoptButton(hasTracks) {
  // playlist vera aperta (propria o di un tossico): il toggle anti-ban
  // riguarda solo il "play pigro" chart/Deezer, qui non ha senso — vedi
  // _renderLazyTracklist per dove invece torna visibile
  if (plAntiBanGroup) plAntiBanGroup.classList.add("hidden");
  if (!btnPlAdopt) return;
  if (!openPlaylistOwnerId || !hasTracks || appOfflineMode) {
    btnPlAdopt.classList.add("hidden");
    return;
  }
  btnPlAdopt.classList.remove("hidden");
  // reset: niente stato residuo di una playlist aperta in precedenza
  btnPlAdopt.classList.remove("on", "filling", "busy", "fill-done", "fill-fail", "fill-pop");
  btnPlAdopt.disabled = false;
}

/** Segnalibro chart/Deezer (riusa il cuoricino di btnPlAdopt): a differenza
 * dell'adozione di una playlist vera, qui NON si copia nessun file — solo
 * un puntatore (vedi saved_playlists.py) — quindi è un toggle reversibile,
 * non un'azione one-shot. */
async function toggleLazyBookmark() {
  if (btnPlAdopt.classList.contains("filling")) return;
  const wasSaved = btnPlAdopt.classList.contains("on");
  startHeartFill(btnPlAdopt);
  try {
    if (wasSaved) {
      await apiJson(
        `/api/saved-playlists?kind=${openLazyKind === "chart" ? "chart" : "deezer_playlist"}&ref_id=${encodeURIComponent(openLazyId)}`,
        null,
        "DELETE"
      );
      btnPlAdopt.classList.remove("filling", "busy", "on", "fill-done", "fill-pop");
      btnPlAdopt.title = "Salva tra le tue playlist";
      btnPlAdopt.setAttribute("aria-label", btnPlAdopt.title);
      toast("Rimossa dai segnalibri");
      refreshLazyDownloadButton(false); // niente download in blocco senza segnalibro
    } else {
      await apiJson(
        "/api/saved-playlists",
        { kind: openLazyKind === "chart" ? "chart" : "deezer_playlist", ref_id: String(openLazyId) },
        "POST"
      );
      endHeartFill(true, btnPlAdopt);
      btnPlAdopt.title = "Rimuovi dai segnalibri";
      btnPlAdopt.setAttribute("aria-label", btnPlAdopt.title);
      toast("Salvata tra le tue playlist");
      refreshLazyDownloadButton(true);
    }
  } catch (err) {
    endHeartFill(false, btnPlAdopt);
    btnPlAdopt.classList.toggle("on", wasSaved); // torna allo stato di prima, il toggle non è andato a segno
    toast("Errore: " + (err.message || "operazione fallita"));
  }
}

if (btnPlAdopt) {
  btnPlAdopt.addEventListener("click", async () => {
    if (openLazyKind) {
      toggleLazyBookmark();
      return;
    }
    if (!openPlaylistId || !openPlaylistOwnerId) return;
    if (btnPlAdopt.classList.contains("filling") || btnPlAdopt.classList.contains("on")) return;
    startHeartFill(btnPlAdopt);
    try {
      // dedup lato server per artista+titolo (stesso path del cuore singolo):
      // niente doppioni dei brani già posseduti, anche cliccando più volte
      const data = await apiJson(
        `/api/home/playlists/${openPlaylistOwnerId}/${openPlaylistId}/adopt`,
        null,
        "POST"
      );
      endHeartFill(true, btnPlAdopt);
      const parts = [];
      if (data.added) parts.push(`${data.added} nuovi`);
      if (data.already_owned) parts.push(`${data.already_owned} già in libreria`);
      toast(`Playlist aggiunta alla tua libreria (${parts.join(", ") || "0 brani"})`);
    } catch (err) {
      endHeartFill(false, btnPlAdopt);
      toast("Errore: " + (err.message || "aggiunta fallita"));
    }
  });
}

if (plAntiBan) {
  plAntiBan.addEventListener("click", () => {
    const next = !isAntiBanEnabled();
    setAntiBanEnabled(next);
    toast(
      next
        ? "Anti-ban attivo: anteprima gratis, la ricerca vera parte solo se resti in ascolto"
        : "Anti-ban disattivato: ricerca vera subito al tocco, come una ricerca normale"
    );
  });
}
if (plAntiBanInfo && plAntiBanPopover) {
  plAntiBanInfo.addEventListener("click", (e) => {
    e.stopPropagation();
    plAntiBanPopover.classList.toggle("open");
  });
  plAntiBanPopover.addEventListener("click", (e) => e.stopPropagation());
  document.addEventListener("click", (e) => {
    if (
      plAntiBanPopover.classList.contains("open") &&
      !e.target.closest(".pl-antiban-info-wrap")
    ) {
      plAntiBanPopover.classList.remove("open");
    }
  });
}
if (artistAntiBan) {
  artistAntiBan.addEventListener("click", () => {
    const next = !isAntiBanEnabled();
    setAntiBanEnabled(next);
    artistAntiBan.classList.toggle("on", next);
    toast(
      next
        ? "Anti-ban attivo: anteprima gratis, la ricerca vera parte solo se resti in ascolto"
        : "Anti-ban disattivato: ricerca vera subito al tocco, come una ricerca normale"
    );
  });
}
if (artistAntiBanInfo && artistAntiBanPopover) {
  artistAntiBanInfo.addEventListener("click", (e) => {
    e.stopPropagation();
    artistAntiBanPopover.classList.toggle("open");
  });
  artistAntiBanPopover.addEventListener("click", (e) => e.stopPropagation());
  document.addEventListener("click", (e) => {
    if (
      artistAntiBanPopover.classList.contains("open") &&
      !e.target.closest(".pl-antiban-info-wrap")
    ) {
      artistAntiBanPopover.classList.remove("open");
    }
  });
}
if (npArtist) {
  // ascoltatore statico sul contenitore esterno del marquee (non sul testo
  // interno, che viene sostituito ad ogni brano da setNpMarqueeText) — letto
  // da nowPlaying al momento del tap, sempre aggiornato senza doverlo
  // ri-agganciare ogni volta.
  npArtist.classList.add("artist-link");
  addPressFeedback(npArtist);
  npArtist.addEventListener("click", (e) => {
    e.stopPropagation();
    if (nowPlaying && nowPlaying.artist) openArtistByName(nowPlaying.artist, null);
  });
}

// —— rilevamento server irraggiungibile all'avvio + vista offline ristretta ——
let appOfflineMode = false;

async function checkServerReachable(timeoutMs) {
  try {
    const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const t = ctrl && setTimeout(() => ctrl.abort(), timeoutMs || 3500);
    // no-store: stessa classe di bug delle cover/audio — senza, la WebView
    // può servire una vecchia risposta 200 dalla cache invece di tentare la
    // rete vera, e il passaggio a offline non scatta mai a VPN spenta
    const res = await fetch(apiUrl("/api/health"), {
      ...(ctrl ? { signal: ctrl.signal } : {}),
      cache: "no-store",
    });
    clearTimeout(t);
    return res.ok;
  } catch (_) {
    return false;
  }
}

/** Mondo grande delle schermate di rete (06/10, Vitto: «il vecchio cerchio
 * attorno alla nuova icona già circolare non dà un bell'effetto… falla più
 * bella»). Niente anello: tratto sottile con la sfumatura del marchio e un
 * alone dietro. "offline": il meridiano gira, rallenta, si ferma e cade il
 * bollino con la ×; "online" (verde): bollino con la ✓ subito e il mondo
 * riparte a girare. Il bollino si stacca dal mondo con un bordo del colore
 * della card, senza maschere (animate in Safari non sono affidabili). */
function iconaReteIntro(tipo) {
  const online = tipo === "online";
  const g = online ? "crkReteOn" : "crkReteOff";
  const segno = online
    ? '<path d="m15.7 18.1 1.6 1.6 3-3.2" class="rete-segno"/>'
    : '<path d="m16.2 16.2 3.6 3.6m0-3.6-3.6 3.6" class="rete-segno"/>';
  return `<svg class="rete-globo rete-${online ? "on" : "off"}" viewBox="0 0 24 24" width="80" height="80" fill="none" stroke="url(#${g})" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
    <defs><linearGradient id="${g}" x1="3" y1="3" x2="20" y2="20" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#fff"/><stop offset="1" class="rete-stop"/></linearGradient></defs>
    <circle cx="11" cy="11" r="8.6"/>
    <path d="M2.95 8h16.1M2.95 14h16.1"/>
    <ellipse class="rete-meridiano" cx="11" cy="11" rx="8.6" ry="8.6"/>
    <g class="rete-bollino"><circle cx="18" cy="18" r="5.2" class="rete-bollino-fondo"/>${segno}</g>
  </svg>`;
}

/** Schermata transitoria stile login (stessa card, stesso respiro arancione)
 * mostrata all'accesso in modalità offline — sparisce da sola dopo un paio
 * di secondi e lascia vedere l'app già pronta sotto. */
function showOfflineIntro(motivo) {
  if (document.getElementById("offlineIntro")) return;
  const sotto =
    motivo === "scelta"
      ? "Hai scelto di restare offline — si ascoltano solo le playlist scaricate"
      : "Nessuna connessione al Mac — puoi ascoltare solo le playlist già scaricate";
  const el = document.createElement("div");
  el.id = "offlineIntro";
  el.className = "offline-intro";
  el.innerHTML = `
    <div class="offline-intro-card">
      <span class="offline-intro-brand" aria-hidden="true">${iconaReteIntro("offline")}</span>
      <h2>Modalità offline</h2>
      <p class="offline-intro-sub">${sotto}</p>
      <div class="offline-intro-dots" aria-hidden="true"><span></span><span></span><span></span></div>
    </div>
  `;
  document.body.appendChild(el);
  setTimeout(() => {
    el.classList.add("fade-out");
    setTimeout(() => el.remove(), 500);
  }, 2200);
}

/** Pannello gemello di showOfflineIntro ma verde con icona dati: il Mac è
 * tornato raggiungibile — breve animazione, poi reload per rifare il boot
 * online da zero (auth, playlist, player: tutto il flusso normale). */
function showOnlineReturnIntro() {
  if (document.getElementById("onlineReturnIntro")) return;
  const el = document.createElement("div");
  el.id = "onlineReturnIntro";
  el.className = "offline-intro online-return";
  el.innerHTML = `
    <div class="offline-intro-card">
      <span class="offline-intro-brand" aria-hidden="true">${iconaReteIntro("online")}</span>
      <h2>Connessione ripristinata</h2>
      <p class="offline-intro-sub">Il Mac è di nuovo raggiungibile — torno alla modalità online</p>
      <div class="offline-intro-dots" aria-hidden="true"><span></span><span></span><span></span></div>
    </div>
  `;
  document.body.appendChild(el);
  setTimeout(() => location.reload(), 2200);
}

/** In modalità offline: sonda ogni tanto il Mac e, appena risponde, rientra
 * online via showOnlineReturnIntro. Mai mentre un brano sta suonando — il
 * reload lo interromperebbe di colpo. */
let _offlineReconnectTimer = null;
let _offlineReconnectBusy = false;
async function _offlineReconnectAttempt() {
  if (!appOfflineMode || _offlineReconnectBusy) return;
  if (offlineForzato()) return; // "Resta offline" acceso nelle impostazioni
  if (audio && audio.src && !audio.paused) return;
  // il rientro ricarica l'app: non a metà partita (07/10), si riprova al
  // prossimo giro
  if (dinoInGioco()) return;
  _offlineReconnectBusy = true;
  try {
    const ok = await checkServerReachable(3000);
    if (ok && appOfflineMode) {
      if (_offlineReconnectTimer) {
        clearInterval(_offlineReconnectTimer);
        _offlineReconnectTimer = null;
      }
      showOnlineReturnIntro();
    }
  } finally {
    _offlineReconnectBusy = false;
  }
}
function startOfflineReconnectWatch() {
  if (_offlineReconnectTimer) return;
  _offlineReconnectTimer = setInterval(_offlineReconnectAttempt, 15000);
  // tornando in foreground (es. dopo aver riacceso VPN/WiFi) controlla
  // subito invece di aspettare il prossimo giro
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") _offlineReconnectAttempt();
  });
}

/** Il gemello inverso: in modalità ONLINE sonda il Mac e, se sparisce per
 * due giri di fila (niente falsi allarmi da un singolo blip di rete), passa
 * da solo in modalità offline con lo stesso pannello dell'ingresso. Solo se
 * c'è almeno una playlist scaricata — senza, l'offline non offre nulla. */
let _onlineDropTimer = null;
let _onlineDropFails = 0;
let _onlineDropBusy = false;
async function _onlineDropCheck() {
  if (appOfflineMode || _onlineDropBusy) return;
  if (!Object.keys(getOfflinePlaylists()).length) return;
  _onlineDropBusy = true;
  try {
    const ok = await checkServerReachable(3500);
    if (ok) {
      _onlineDropFails = 0;
      return;
    }
    _onlineDropFails++;
    if (_onlineDropFails >= 2 && !appOfflineMode) {
      _onlineDropFails = 0;
      if (_onlineDropTimer) {
        clearInterval(_onlineDropTimer);
        _onlineDropTimer = null;
      }
      // uno stream online senza più rete è condannato: fermalo pulito
      // (un file locale offline — src capacitor:// — continua indisturbato)
      try {
        if (audio && !audio.paused && /^https?:/i.test(audio.src || "")) audio.pause();
      } catch (_) {}
      enterOfflineMode();
    }
  } finally {
    _onlineDropBusy = false;
  }
}
function startOnlineDropWatch() {
  if (_onlineDropTimer || !isNativeShell() || !API_BASE) return;
  _onlineDropTimer = setInterval(_onlineDropCheck, 10000);
}

/** Grid "La tua libreria" quando siamo offline: solo playlist scaricate,
 * niente rete — sostituisce loadPlaylists() in questa modalità. */
function renderOfflinePlaylistsGrid() {
  if (!plList) return;
  // di nuovo sulla griglia: il cabinato riappare, ridisegna (da nascosto il
  // canvas può essere rimasto vuoto) e riaccendi l'atmosfera
  requestAnimationFrame(() => {
    if (dinoMisura()) {
      dinoDisegna();
      dinoAvvia();
    }
  });
  openPlaylistId = null;
  openPlaylistOwnerId = null;
  dimenticaListaPigra();
  // senza rete la libreria è solo quel che è scaricato (Vitto 07/10:
  // «tipo La tua libreria offline, non si possono creare playlist da lì»)
  plTitle.textContent = "La tua libreria offline";
  if (plStatus.parentElement) plStatus.parentElement.classList.remove("hidden");
  if (plGridHead) plGridHead.classList.remove("hidden");
  if (plLibSearchWrap) plLibSearchWrap.classList.remove("hidden");
  if (plHero) plHero.classList.add("hidden");
  if (plActionRow) plActionRow.classList.add("hidden");
  btnPlPlay.classList.add("hidden");
  btnPlCreate.classList.add("hidden"); // creare/rinominare/eliminare serve rete
  plTracks.classList.add("hidden");
  plTracks.innerHTML = "";
  hidePlTrackSearch();
  resetPlLibSearch();
  plList.classList.remove("hidden");
  plList.innerHTML = "";
  // segnalibri/download in blocco: servono rete, niente senso offline

  const playlists = getOfflinePlaylists();
  const entries = Object.entries(playlists);
  if (!entries.length) {
    plStatus.textContent = "Nessuna playlist scaricata — connettiti al Mac per scaricarne una";
    return;
  }
  plStatus.textContent = `${entries.length} playlist offline`;
  entries.forEach(([pid, entry]) => {
    const p = entry.pl;
    const isSaved = pid === OFFLINE_SAVED_PID;
    const card = document.createElement("div");
    card.className = "pl-row";
    card.dataset.id = pid;
    card.dataset.searchName = (p.name || "playlist").toLowerCase();
    card.innerHTML = `
      <div class="pl-row-cover${isSaved ? " pl-row-cover-saved" : ""}">${isSaved ? "♥" : "▤"}</div>
      <div class="pl-row-text">
        <div class="pl-row-name"></div>
        <div class="pl-row-meta"><span></span></div>
      </div>
    `;
    card.querySelector(".pl-row-name").textContent = p.name || "Playlist";
    card.querySelector(".pl-row-meta span").textContent = `${(p.tracks || []).length} brani · offline`;
    // copertina offline del primo brano, se scaricata (niente rete: solo
    // file già sul device) — aggiorna il placeholder quando è pronta.
    // Brani salvati tiene il cuore, come la card online.
    const firstId = !isSaved && p.tracks && p.tracks[0] && p.tracks[0].id;
    if (firstId) {
      getOfflineTrackCoverSrc(firstId).then((src) => {
        if (!src) return;
        const cov = card.querySelector(".pl-row-cover");
        lazyLoadCover(cov, src);
      });
    }
    card.addEventListener("click", () => openOfflinePlaylist(pid));
    plList.appendChild(card);
  });
}

/** Apre il dettaglio di una playlist scaricata, tutto da cache locale. */
function openOfflinePlaylist(pid) {
  const entry = getOfflinePlaylists()[pid];
  if (!entry) return;
  const pl = entry.pl;
  const tracks = pl.tracks || [];
  openPlaylistId = pid;
  openPlaylistOwnerId = entry.ownerId || null;
  setMobileTopbarVisible(false);
  plTitle.textContent = pl.name || "Playlist";
  plStatus.textContent = `${tracks.length} brani · offline`;
  if (plGridHead) plGridHead.classList.add("hidden");
  if (plLibSearchWrap) plLibSearchWrap.classList.add("hidden");
  if (plHero) {
    plHero.classList.remove("hidden");
    if (plHeroTitle) plHeroTitle.textContent = pl.name || "Playlist";
    if (plHeroCover) {
      const isSaved = pid === OFFLINE_SAVED_PID;
      plHeroCover.style.backgroundImage = "";
      plHeroCover.classList.toggle("pl-hero-cover-saved", isSaved);
      plHeroCover.textContent = isSaved ? "♥" : "▤";
      // copertina offline del primo brano scaricato, se c'è (async: niente
      // rete qui, solo file già sul device — aggiorna quando è pronta).
      // Brani salvati tiene il cuore, come la vista online.
      const heroCoverId = !isSaved && tracks[0] && tracks[0].id;
      if (heroCoverId) {
        getOfflineTrackCoverSrc(heroCoverId).then((src) => {
          if (!src || openPlaylistId !== pid) return;
          plHeroCover.style.backgroundImage = `url(${src})`;
          plHeroCover.textContent = "";
          applyHeroColor(plHero, src);
        });
      }
    }
    applyHeroColor(plHero, null);
    if (plHeroMetaText) plHeroMetaText.textContent = `${tracks.length} brani · offline`;
  }
  if (plActionRow) plActionRow.classList.remove("hidden");
  btnPlPlay.classList.toggle("hidden", !tracks.length);
  if (btnPlShuffle) btnPlShuffle.classList.toggle("hidden", !tracks.length);
  refreshPlOfflineButton(pid, !!tracks.length);
  refreshPlAdoptButton(!!tracks.length);
  btnPlCreate.classList.add("hidden");
  plList.classList.add("hidden");
  plTracks.classList.remove("hidden");
  plTracks.innerHTML = "";
  showPlTrackSearch();

  if (!tracks.length) {
    plStatus.textContent = "Playlist vuota";
    return;
  }
  tracks.forEach((t, i) => {
    const row = document.createElement("div");
    row.className = "track";
    row.dataset.id = t.id;
    row.innerHTML = `
      <span class="num">${i + 1}</span>
      <div class="art">▤</div>
      <div class="info">
        <div class="title"></div>
        <div class="artist"></div>
      </div>
      <span class="dur"></span>
    `;
    row.querySelector(".title").textContent = t.title || "—";
    wireArtistName(row.querySelector(".artist"), t.artist, t.artist_id);
    row.querySelector(".dur").textContent = t.duration || "";
    if (t.id) {
      getOfflineTrackCoverSrc(t.id).then((src) => {
        if (!src) return;
        const art = row.querySelector(".art");
        lazyLoadCover(art, src);
      });
    }
    row.addEventListener("click", () => playPlaylistFrom(tracks, i));
    plTracks.appendChild(row);
  });
}

function enterOfflineMode(motivo) {
  appOfflineMode = true;
  document.documentElement.classList.add("offline-mode");
  // niente /api/me raggiungibile: non blocchiamo dietro al gate di login,
  // le playlist scaricate si sfogliano comunque senza verificarlo di nuovo
  document.documentElement.classList.remove("need-login");
  setAuthGate(false);
  closeLoginModal();
  showOfflineIntro(motivo);
  showView("playlists");
  startOfflineReconnectWatch();
  cartelloOffline();
  dinoSistema();
  // il gioco al posto della barra di ricerca: primo fotogramma appena la
  // vista ha le sue misure
  requestAnimationFrame(() => dinoPrepara());
}

/** Scritta «OFFLINE MODE» a pixel sopra il gioco (07/10, Vitto: «pixelata,
 * più grande, tipo la dimensione di La tua libreria», centrata; l'onda
 * continua «dà fastidio» → ferma, con un glitch ogni tanto; lettere più
 * spesse). SVG fatto una volta col carattere del gioco su una griglia di
 * mezze celle: ogni cella piena è un quadrato da 3 mezze celle, che sborda
 * di una sul vicino e ingrassa i tratti. Dal 08/10 sta nel cabinato, un po'
 * più stretta: mezza cella da 5/3 di px = 5 pixel veri sull'iPhone 15 (3x),
 * così i quadretti restano netti. Sfumatura dal bianco all'arancio come i
 * titoli col marchio.
 * Strati per il glitch (solo CSS, vedi style.css): due fantasmi a tinta
 * unita (ciano e rosso) dietro, la scritta vera, e due fette orizzontali
 * della scritta (<use> ritagliate) che scattano di lato. */
function cartelloOffline() {
  const box = document.getElementById("offlineCartello");
  // in Home da computer (online) il banner dice CRACKIFY (Vitto 08/10)
  const testo = !appOfflineMode && dinoInHome() ? "CRACKIFY" : "OFFLINE MODE";
  if (!box || box.dataset.testo === testo) return;
  box.dataset.testo = testo;
  box.setAttribute("aria-label", testo === "CRACKIFY" ? "Crackify" : "Offline mode");
  box.innerHTML = "";
  const MEZZA = 5 / 3; // px per mezza cella (5 pixel veri a 3x)
  const BORDO = 4; // mezze celle libere ai lati, per le fette che scattano
  const lettere = [...testo];
  const glifi = lettere.map((ch) => DINO_FONT[ch] || DINO_FONT[" "]);
  // passo fra le lettere: larghezza + 1 cella + 1 mezza (il grassetto ne
  // mangia una, così fra lettera e lettera restano 2 mezze celle)
  let tot = 0;
  glifi.forEach((g, i) => { tot += g[0].length * 2 + (i < glifi.length - 1 ? 3 : 1); });
  const W = tot + BORDO * 2;
  const H = 7 * 2 + 1;
  const sfuma = (t) => {
    // bianco → #ff8c33 (--orange-2)
    const m = (a, b) => Math.round(a + (b - a) * t);
    return `rgb(255,${m(255, 140)},${m(255, 51)})`;
  };
  let x = BORDO;
  let tutto = "";
  let vera = "";
  glifi.forEach((g, i) => {
    let d = "";
    g.forEach((riga, r) => {
      for (let c = 0; c < riga.length; c++) {
        if (riga[c] === "#") d += `M${x + c * 2} ${r * 2}h3v3h-3z`;
      }
    });
    if (d) {
      const t = Math.min(1, ((x - BORDO + g[0].length) / tot) * 1.15);
      vera += `<path fill="${sfuma(t)}" d="${d}"/>`;
      tutto += d;
    }
    x += g[0].length * 2 + 3;
  });
  // fette: righe 2-3 e 5-6 del carattere (in mezze celle)
  box.innerHTML =
    `<svg viewBox="0 0 ${W} ${H}" width="${(W * MEZZA).toFixed(2)}" height="${H * MEZZA}" aria-hidden="true">` +
    `<defs><clipPath id="ocFetta1"><rect x="0" y="4" width="${W}" height="4"/></clipPath>` +
    `<clipPath id="ocFetta2"><rect x="0" y="10" width="${W}" height="3"/></clipPath></defs>` +
    `<path class="oc-fantasma oc-ciano" d="${tutto}"/>` +
    `<path class="oc-fantasma oc-rosso" d="${tutto}"/>` +
    `<g id="ocVera" class="oc-vera">${vera}</g>` +
    `<g class="oc-fetta oc-fetta1" clip-path="url(#ocFetta1)"><use href="#ocVera"/></g>` +
    `<g class="oc-fetta oc-fetta2" clip-path="url(#ocFetta2)"><use href="#ocVera"/></g>` +
    `</svg>`;
}

// —— DINO (07/10, Vitto): «nella modalità offline si vede ancora la barra di
// ricerca: toglierla, senza internet non cerchi su Deezer/Telegram, e mettere
// il giochino del dinosauro offline al posto della barra, in stile Crackify».
// Il dinosauro di Chrome in arancio e con le cuffie; gli ostacoli sono i
// mixer (i cactus di Chrome) e, più avanti, fantasmini con le cuffie che
// volano (bassi = salta, alti = resta giù). Un tocco = salto. Difficoltà,
// salto e ritmo degli ostacoli sono quelli del T-Rex di Chrome (08/10).
// Dal 08/10 il gioco è tutto il banner del cabinato, scritta OFFLINE MODE
// compresa, e da fermo fa atmosfera (Vitto: «un unico banner tutto animato
// con un po' di ambiance»): cielo al tramonto con stelle, stelle cadenti,
// nuvole e sole, il dinosauro che tiene il tempo con la testa e notine che
// escono dalle cuffie. Il ciclo gira solo col cabinato sullo schermo e l'app
// in primo piano: aprendo una playlist si ferma (e la partita va in pausa).
// Lo schermo intero in orizzontale c'è stato dal 07 al 08/10, tolto. Record
// in localStorage, solo su questo telefono. ——
// chiave nuova dal 08/10: con la difficoltà di Chrome i punti valgono il 27%
// in meno, il record vecchio non si batterebbe più alla pari
const DINO_RECORD_KEY = "crackify_dino_record2";

// Il boss battle (costanti, motore, minigiochi) vive in boss.js, caricato
// PRIMA di app.js: qui ci sono solo gli agganci (cerca «dinoBoss» e «dino.boss»).
// Dal 08/10 (Vitto: «resta più fedele al primo dino, solo un po' più
// definito», scelto fra tre) è il dinosauro di prima, 14 x 14 celle da 2,
// raddoppiato cella per cella: 28 x 28 celle da 1, stessa sagoma e stesso
// ingombro, con in più luce sui bordi in alto e ombra su quelli in basso,
// l'occhio col riflesso, la narice, le cuffie con le ombre e la zampa di
// dietro più scura. Lettere: # corpo, l luce, d ombra, e/w occhio e
// riflesso, n narice, h/H archetto, C/c/k padiglione (bordo, faccia, luce).
// 24 righe di corpo, poi le zampe (4 righe) in due pose che si alternano
// mentre corre. Godzilla ha uno sprite suo (GODZILLA_SPRITE).
const DINO_SPRITE = [
  "............hhhhhhhhhh......",
  "............HHHHHHHHHH......",
  "..........hh##########hh....",
  "..........HH##########HH....",
  ".........CCCC###########lll.",
  "........CkkccC###########n#l",
  "........CkcccC####we########",
  "........CccccC####ee########",
  "........CccccC##############",
  ".........CCCC###############",
  "..........##################",
  "..........##########dddddddd",
  "..........##########........",
  "..........##########........",
  "ll......ll##########llll....",
  "##......############dddd....",
  "##ll..ll############........",
  "####..############dd........",
  "####ll############..........",
  "dd##############dd..........",
  "..##############............",
  "..dd############............",
  "....############............",
  "....############............",
];
const DINO_ZAMPE = [
  [
    "......dddd..####............",
    "......dddd..####............",
    "......dd......##............",
    "......ddd.....###...........",
  ],
  [
    "......dddd....##............",
    "......dddd....##............",
    "......dd......####..........",
    "......ddd.....#####.........",
  ],
];
// Fantasmino al posto delle note che volavano (08/10, Vitto: «al posto delle
// note proviamo con dei fantasmini arancio con delle cuffiette come quella
// del nostro dino»): 13 x 14 celle, grande quanto il dinosauro come lo
// pterodattilo di Chrome. h/c = cuffie come le sue, w/k = occhi che guardano
// verso di lui. La gonna ha due pose che si alternano in volo, come le ali
// dello pterodattilo.
const FANTASMA_TESTA = [
  "....hhhhh....",
  "...h#####h...",
  "..h#######h..",
  ".h#########h.",
  "cc#########cc",
  "cc#kw###kw#cc",
  "cc#kw###kw#cc",
  "..#########..",
  "..#########..",
  "..#########..",
  "..#########..",
];
const FANTASMA_GONNA = [
  ["..#########..", "..##.###.##..", "..#...#...#.."],
  ["..#########..", "..#.###.###..", "....#...#...."],
];
const FANTASMA_ARANCIO = "#ff8a2a"; // più chiaro del dinosauro: è un altro
// Mixer (08/10, Vitto: «bella idea ma sono poco grossi, le strutture da 3 su
// mobile dinosauro chrome sono diverse»): come i cactus di Chrome, piccoli e
// grandi, da 1 a 3 canali fitti su un'unica base, così un gruppo da 3 è un
// blocco solo e non tre stecchini. Misure in celle; l'altezza conta anche la
// base (2 celle), che sporge di una cella per lato.
const MIXER_PICCOLO = { canale: 4, min: 9, max: 11 };
const MIXER_GRANDE = { canale: 6, min: 14, max: 16 };
// Pulsante «riprova» a fine partita (07/10, Vitto: «un piccolo pulsante
// centrale alla morte per riprovare»): il tondo arancio del play di Crackify
// con la ↻ scura, a pixel come il resto. 15 x 15 celle.
const RIPROVA_SPRITE = [
  ".....ooooo.....",
  "...oooookooo...",
  "..ooooookkooo..",
  ".ooookkkkkkooo.",
  ".oookoookkoooo.",
  "oookooookoooooo",
  "oookoooooookooo",
  "oookoooooookooo",
  "oookoooooookooo",
  "oookoooooookooo",
  ".oookoooookooo.",
  ".ooookkkkkoooo.",
  "..ooooooooooo..",
  "...ooooooooo...",
  ".....ooooo.....",
];
// Carattere a pixel, 5 x 7 celle come il GAME OVER di Chrome (07/10, Vitto:
// «la scritta Schiantato pixelata come il resto»; dal 08/10 tutte le scritte
// del cabinato, anche OFFLINE MODE). Solo le lettere che servono.
const DINO_FONT = {
  A: [".###.", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  B: ["####.", "#...#", "#...#", "####.", "#...#", "#...#", "####."],
  X: ["#...#", "#...#", ".#.#.", "..#..", ".#.#.", "#...#", "#...#"],
  // J per JETPACK, Q già che c'ero
  J: ["..###", "...#.", "...#.", "...#.", "#..#.", "#..#.", ".##.."],
  Q: [".###.", "#...#", "#...#", "#...#", "#.#.#", "#..#.", ".##.#"],
  // Y per CRAZY MODE, K e W già che c'ero
  Y: ["#...#", "#...#", ".#.#.", "..#..", "..#..", "..#..", "..#.."],
  K: ["#...#", "#..#.", "#.#..", "##...", "#.#..", "#..#.", "#...#"],
  W: ["#...#", "#...#", "#...#", "#.#.#", "#.#.#", "#.#.#", ".#.#."],
  // le cifre, per il conto alla rovescia dei poteri
  0: [".###.", "#...#", "#..##", "#.#.#", "##..#", "#...#", ".###."],
  1: ["..#..", ".##..", "..#..", "..#..", "..#..", "..#..", ".###."],
  2: [".###.", "#...#", "....#", "...#.", "..#..", ".#...", "#####"],
  3: ["####.", "....#", "....#", ".###.", "....#", "....#", "####."],
  4: ["...#.", "..##.", ".#.#.", "#..#.", "#####", "...#.", "...#."],
  5: ["#####", "#....", "####.", "....#", "....#", "#...#", ".###."],
  6: [".###.", "#....", "#....", "####.", "#...#", "#...#", ".###."],
  7: ["#####", "....#", "...#.", "..#..", ".#...", ".#...", ".#..."],
  8: [".###.", "#...#", "#...#", ".###.", "#...#", "#...#", ".###."],
  9: [".###.", "#...#", "#...#", ".####", "....#", "....#", ".###."],
  C: [".####", "#....", "#....", "#....", "#....", "#....", ".####"],
  D: ["####.", "#...#", "#...#", "#...#", "#...#", "#...#", "####."],
  E: ["#####", "#....", "#....", "####.", "#....", "#....", "#####"],
  H: ["#...#", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  I: ["###", ".#.", ".#.", ".#.", ".#.", ".#.", "###"],
  F: ["#####", "#....", "#....", "####.", "#....", "#....", "#...."],
  G: [".####", "#....", "#....", "#.###", "#...#", "#...#", ".###."],
  L: ["#....", "#....", "#....", "#....", "#....", "#....", "#####"],
  M: ["#...#", "##.##", "#.#.#", "#.#.#", "#...#", "#...#", "#...#"],
  N: ["#...#", "##..#", "#.#.#", "#.#.#", "#..##", "#...#", "#...#"],
  O: [".###.", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
  P: ["####.", "#...#", "#...#", "####.", "#....", "#....", "#...."],
  R: ["####.", "#...#", "#...#", "####.", "#.#..", "#..#.", "#...#"],
  S: [".####", "#....", "#....", ".###.", "....#", "....#", "####."],
  T: ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "..#.."],
  U: ["#...#", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
  V: ["#...#", "#...#", "#...#", "#...#", ".#.#.", ".#.#.", "..#.."],
  Z: ["#####", "....#", "...#.", "..#..", ".#...", "#....", "#####"],
  "!": ["#", "#", "#", "#", "#", ".", "#"],
  " ": ["..", "..", "..", "..", "..", "..", ".."],
};
// Il piccolo, 3 x 5 celle (08/10, Vitto: «reworka bene le scritte del banner
// gioco»): punteggio, suggerimenti e la schermata di fine. Cifre come quelle
// del punteggio di Chrome, alfabeto intero; la O è tonda per non confondersi
// con lo zero, M e W sono larghe 5 (a 3 sembravano H: «HINDOHS»).
const DINO_FONT_PICCOLO = {
  0: ["###", "#.#", "#.#", "#.#", "###"],
  1: [".#.", "##.", ".#.", ".#.", "###"],
  2: ["###", "..#", "###", "#..", "###"],
  3: ["###", "..#", ".##", "..#", "###"],
  4: ["#.#", "#.#", "###", "..#", "..#"],
  5: ["###", "#..", "###", "..#", "###"],
  6: ["###", "#..", "###", "#.#", "###"],
  7: ["###", "..#", "..#", ".#.", ".#."],
  8: ["###", "#.#", "###", "#.#", "###"],
  9: ["###", "#.#", "###", "..#", "###"],
  A: [".#.", "#.#", "###", "#.#", "#.#"],
  B: ["##.", "#.#", "##.", "#.#", "##."],
  C: [".##", "#..", "#..", "#..", ".##"],
  D: ["##.", "#.#", "#.#", "#.#", "##."],
  E: ["###", "#..", "##.", "#..", "###"],
  F: ["###", "#..", "##.", "#..", "#.."],
  G: [".##", "#..", "#.#", "#.#", ".##"],
  H: ["#.#", "#.#", "###", "#.#", "#.#"],
  I: ["###", ".#.", ".#.", ".#.", "###"],
  J: ["..#", "..#", "..#", "#.#", ".#."],
  K: ["#.#", "#.#", "##.", "#.#", "#.#"],
  L: ["#..", "#..", "#..", "#..", "###"],
  M: ["#...#", "##.##", "#.#.#", "#...#", "#...#"],
  N: ["##.", "#.#", "#.#", "#.#", "#.#"],
  O: [".#.", "#.#", "#.#", "#.#", ".#."],
  P: ["##.", "#.#", "##.", "#..", "#.."],
  Q: [".#.", "#.#", "#.#", "##.", ".##"],
  R: ["##.", "#.#", "##.", "#.#", "#.#"],
  S: [".##", "#..", ".#.", "..#", "##."],
  T: ["###", ".#.", ".#.", ".#.", ".#."],
  U: ["#.#", "#.#", "#.#", "#.#", "###"],
  V: ["#.#", "#.#", "#.#", "#.#", ".#."],
  W: ["#...#", "#...#", "#.#.#", "##.##", "#...#"],
  X: ["#.#", "#.#", ".#.", "#.#", "#.#"],
  Y: ["#.#", "#.#", ".#.", ".#.", ".#."],
  Z: ["###", "..#", ".#.", "#..", "###"],
  "+": ["...", ".#.", "###", ".#.", "..."],
  "!": ["#", "#", "#", ".", "#"],
  ".": [".", ".", ".", ".", "#"],
  " ": ["..", "..", "..", "..", ".."],
};
// Notine che escono dalle cuffie mentre il dinosauro ascolta (08/10): ♪ e ♫.
const NOTINA_SPRITE = [
  ["..#..", "..##.", "..#.#", "..#..", "###..", "###.."],
  ["..#####", "..#...#", "..#...#", "..#...#", "###.###", "###.###"],
];
// canali dei mixer a gradini, dall'alto: bianco → arancio
const EQ_GRADINI = ["#ffffff", "#ffd8b0", "#ffb066", "#ff8a2a", "#ff6a00"];
const DINO_CELLA = 2;
// Il mondo del gioco si disegna ingrandito (08/10, banner unico: Vitto
// trovava dinosauro e ostacoli piccoli, «libero arbitrio» su come
// sistemarli). Le misure qui sotto, la fisica e la difficoltà di Chrome
// restano in unità del mondo; sullo schermo una cella da 2 diventa 7/3 di px,
// cioè 7 pixel veri sull'iPhone 15 (3x), quindi resta netta. Prima era 4/3,
// ma la strada davanti sembrava «troppo corta»: con 7/6 se ne vedono ~310
// unità invece di 362, e a velocità massima un ostacolo si vede arrivare
// ~580 ms prima (Chrome ~650).
const DINO_SCALA = 7 / 6;
// riga del punteggio: 51 px, 10 sotto la scritta OFFLINE MODE (16-41 px),
// in unità del mondo
const DINO_Y_PUNTEGGIO = 51 / DINO_SCALA;
const DINO_W = 14 * DINO_CELLA;
const DINO_H = 14 * DINO_CELLA;
const DINO_ARANCIO = "#ff6a00";
// Difficoltà del T-Rex di Chrome (08/10: analisi di un'altra sessione su
// richiesta di Vitto, dai sorgenti di chromium components/neterror/resources/
// dino_game, verificata con 200 partite simulate). Chrome ragiona in px suoi
// per fotogramma a 60 fps; qui tutto si scala sul nostro dinosauro, largo 28
// px contro i suoi 44 (i mixer hanno già le misure dei suoi cactus in questa
// scala). Velocità 6 → 13, +0,001 a fotogramma: il massimo arriva dopo ~117
// s, ~1660 punti. Primi 3 s senza ostacoli.
const DINO_K = 28 / 44;
const DINO_FOTOGRAMMA = 1000 / 60; // ms
const DINO_VEL_INIZIO = 6;
const DINO_VEL_MAX = 13;
const DINO_ACCELERA = 0.001; // a fotogramma
const DINO_SGOMBRO = 3000; // ms di corsa senza ostacoli
// I tre ostacoli come cactus piccolo, cactus grande e pterodattilo: largo
// (px suoi, serve al distacco), gruppi da quella velocità in su (i
// fantasmini mai), distacco minimo, velocità da cui compaiono (fantasmini da
// 8,5: ~42 s, ~450 punti) e, per i fantasmini, lo scarto di velocità
// rispetto al terreno (a caso un po' più svelti o più lenti).
// Dal 08/10 anche due «cattivi» di Vitto: la mina a terra (bassa, lucina
// rossa) e la mina col paracadute, che scende e tocca terra prima di
// arrivare al dinosauro. Chrome sceglie il tipo alla pari; qui ogni tipo ha
// un peso, così le mine restano più rare dei mixer.
const DINO_TIPI = {
  piccolo: { largo: 17, gruppi: 4, distacco: 120, da: 0, peso: 1 },
  grande: { largo: 25, gruppi: 7, distacco: 120, da: 0, peso: 1 },
  // fantasmini da velocità 7 (~17 s) e più spessi degli altri (Vitto 08/10:
  // «spawnano pochi fantasmini, in tutte le mod»; prima da 8,5 e peso 1)
  fantasma: { largo: 46, gruppi: 999, distacco: 150, da: 7, scarto: 0.8, peso: 1.6 },
  mina: { largo: 17, gruppi: 999, distacco: 120, da: 7, peso: 0.45 },
  paracadute: { largo: 28, gruppi: 999, distacco: 150, da: 8, peso: 0.35 },
};
// Modalità di gioco (08/10, Vitto: «NORMALE (spawn di drop/bonus/debuff
// sensati), CRAZY MODE (2 o 3 volte lo spawn della normale) e DEFAULT DINO
// (senza tutti i buff e i debuff)»). Per ognuna: fra quanti ms di corsa il
// primo oggetto e poi ogni quanto (a caso fra i due), lo stesso per l'icona
// di Windows (null = mai), e come cambiano i cattivi di DINO_TIPI (null =
// mai). Ognuna ha il suo record: coi poteri si fanno più punti. boss: a
// quanti punti il primo e poi ogni quanti (null = mai; in Crazy più spesso).
const DINO_MODI = {
  normale: {
    nome: "Normale",
    colore: "#ff8c33",
    record: DINO_RECORD_KEY,
    oggetti: [[12000, 18000], [22000, 32000]],
    errore: [[30000, 45000], [40000, 60000]],
    boss: { primo: 1000, ogni: 1000 },
    tipi: {},
  },
  crazy: {
    nome: "Crazy mode",
    colore: "#ff5fd2",
    record: "crackify_dino_record_crazy",
    oggetti: [[4000, 6000], [6000, 10000]],
    errore: [[10000, 15000], [14000, 22000]],
    boss: { primo: 800, ogni: 800 },
    tipi: { mina: { da: 6, peso: 1.1 }, paracadute: { da: 6.5, peso: 0.9 } },
  },
  classico: {
    nome: "Default dino",
    colore: "#c9c9ce",
    record: "crackify_dino_record_classico",
    oggetti: null,
    errore: null,
    boss: null,
    tipi: { mina: null, paracadute: null },
  },
};
const DINO_MODO_KEY = "crackify_dino_modo";
function dinoModo() {
  return DINO_MODI[dino.modo] || DINO_MODI.normale;
}
function dinoTra([a, b]) {
  return a + Math.random() * (b - a);
}
/** Il tipo di ostacolo come lo vuole la modalità (null: non esce). */
function dinoTipo(n) {
  const m = dinoModo().tipi;
  if (!(n in m)) return DINO_TIPI[n];
  return m[n] && { ...DINO_TIPI[n], ...m[n] };
}
// Dove escono gli oggetti (08/10, Vitto: «attenzione, molti sono jump
// suicida per raccogliere i bonus»). Simulando tutti i salti possibili su
// 40 partite: col vecchio piazzamento la finestra comoda per prenderli era
// ~170 ms e quasi uno su dieci voleva il salto al fotogramma (fra l'altro
// l'ostacolo dopo poteva partire attaccato all'oggetto, se quello prima
// usciva dallo schermo prima del suo distacco: ora decide la coda, vedi
// dinoPasso). Ora l'oggetto vuole un tratto libero di OGGETTO_PRIMA ms
// prima e OGGETTO_DOPO dopo (tempi e non px: il salto dura uguale a ogni
// velocità), in due schemi a caso: RADURA, sospeso a OGGETTO_RADURA nel
// tratto libero, e SOPRA, sospeso sopra un ostacolo basso da solo (mixer
// piccolo o mina): lo prendi col salto che fai comunque. Finestra comoda
// 400-530 ms, mai uno impossibile né al fotogramma.
const OGGETTO_PRIMA = 650;
const OGGETTO_DOPO = 800;
const OGGETTO_RADURA = 30;
const OGGETTO_SOPRA = 44;
// Salto di Chrome: spinta 10 + velocità/10, gravità 0,6 a fotogramma, e
// oltre 63 px (suoi) la salita si taglia a 5. ~545 ms in aria, picco ~54 px.
const DINO_G = (0.6 * DINO_K) / DINO_FOTOGRAMMA ** 2; // px/ms²
const DINO_TAGLIO_SOPRA = 63 * DINO_K; // px
const DINO_TAGLIO_VY = (5 * DINO_K) / DINO_FOTOGRAMMA; // px/ms
// nuvola del tramonto: una striscia lunga e sottile, accesa d'arancio (una
// nuvola tonda con la base piatta sembrava una collinetta)
const NUVOLA_SPRITE = [
  ".....######...........",
  "..################....",
  "######################",
  "....##########........",
];
// —— Oggetti da prendere (08/10, Vitto: «oggetti che l'utente può prendere:
// una scaglia radioattiva che trasforma il dino in Godzilla, spacca tutto e
// spara raggi laser, la stella dorata di Mario», e fra le mie proposte le
// cuffie antirumore, «con anche un fascio di luce come scudo»; poi «drop del
// basso (onda che spazza lo schermo) e pozione rimpicciolente (mini-dino
// 8 s, sprite dedicato)»). Compaiono di rado (il primo dopo 20-30 s di
// corsa, poi ogni 25-40 s) al posto di un ostacolo, sospesi dove si arriva
// solo saltando; uno alla volta, e mai mentre un potere è attivo.
// Barile radioattivo (Godzilla; dal 08/10 al posto della scaglia verde,
// Vitto: «non mi piace per niente l'item»): fusto giallo con le fasce
// scure, il simbolo della radioattività e la melma verde che cola e bolle.
// Il barile radioattivo di Godzilla (ridisegnato il 08/10, Vitto: «rendere
// più definita l'immagine dell'item, il barilozzo radioattivo»): 20 x 27
// celle da 1 unità (item.cella = 1: si disegna via dinoTela), cilindro
// giallo con luce a sinistra e ombra a destra, due anelli di rinforzo, il
// trifoglio nero al centro e la melma verde che trabocca dal coperchio.
const SCAGLIA_SPRITE = [
"....................",
  "....###########.....",
  ".###yYYYYYYYYYY###..",
  "#ZyyyYGGgggggYYYYZ#.",
  "ZZyGGGGGggggggggYZZ#",
  "ZZygggggggggggggYZZ#",
  "#ZyyyYgggggggYYYYZZ#",
  "#yGgyyyyZZZZZZZGgZZ#",
  "#kkkkkkkkkkkkkkkkkk#",
  "#KKKKKKKKKKKKKKKKKK#",
  "#YYyyyykkkkkYzzGgZZ#",
  "#YYyyyykkkkkYzzzZZZ#",
  "#YYyyyyykkkYYzzzZZZ#",
  "#YYyyyyyYYYYYzzzZZZ#",
  "#YYyyyyykkkYYzzzZZZ#",
  "#YYykkkkkkkkkkkzZZZ#",
  "#YYykkkkYYYkkkkzZZZ#",
  "#YYyykkkYYYkkkzzZZZ#",
  "#YYyykkkYYYkkkzzZZZ#",
  "#YYyyykyYYYYkzzzZZZ#",
  "#YYyyyyyYYYYYzzzZZZ#",
  "#yyyyyyyZZZZZZZZZZZ#",
  "#kkkkkkkkkkkkkkkkkk#",
  "#KKKKKKKKKKKKKKKKKK#",
  "#YYyyyyyYYYYYzzzZZ#.",
  "#YYyyyyyYYYYYzzzZZ#.",
  ".####yyyYYYYYz####..",
];
// Stella dorata, con gli occhi come quella di Mario.
const STELLA_SPRITE = [
  ".....#.....",
  "....###....",
  "....###....",
  "###########",
  ".#########.",
  "..##k#k##..",
  "..##k#k##..",
  "..#######..",
  ".####.####.",
  ".###...###.",
  "##.......##",
];
// Scudo blu (dal 08/10 al posto delle cuffie, Vitto: «cambiamo l'oggetto
// con uno scudo blu»): bordo scuro, metà sinistra chiara e destra in ombra,
// riflesso in alto a sinistra, rombo bianco al centro.
// Scudo (rifatto il 08/10, Vitto: «rifare icona scudo, migliorare grafica»):
// scudo araldico 13 x 15, contorno blu notte, bordo d'argento (chiaro a
// sinistra, in ombra a destra), campo a faccette dal celeste al blu scuro e
// la croce d'oro al centro, con un lampo di luce in alto a sinistra.
const CUFFIE_SPRITE = [
"..ooooooooo..",
  ".orrrrrrrrro.",
  "orwwmmmbbddRo",
  "orwlmmmbbddRo",
  "orwlmmybbddRo",
  "orllmyyYbddRo",
  "orllyyYYYddRo",
  "orllmyYYbddRo",
  ".orlmmYbbdRo.",
  ".ormmmbbbbRo.",
  "..ormmbbbRo..",
  "...ormbbRo...",
  "....orbRo....",
  ".....oRo.....",
  "......o......",
];
// Jetpack (bonus nuovo, 08/10, idea di Vitto: «il volo è in base a quanto
// tieni premuto, con un cap di altezza»): due serbatoi argento col cono rosso
// e le fasce arancio, collegati da una barra, con la fiamma sotto gli ugelli;
// 18 x 24 celle da 1 unità (item.cella = 1). JETPACK_ZAINO è quello che il
// dino porta sulla schiena, un serbatoio di lato; la fiamma vera la disegna
// dinoDisegna mentre spinge.
const JETPACK_SPRITE = [
"..................",
  "...ooo......ooo...",
  "..orRRo....orRRo..",
  ".orrRRRo..orrRRRo.",
  ".oaabbco..oaabbco.",
  ".oaabbco..oaabbco.",
  ".oaabbcooooaabbco.",
  ".osssssobbossssso.",
  ".oSSSSSoccoSSSSSo.",
  ".oaabbcoddoaabbco.",
  ".oaabbcooooaabbco.",
  ".oaabbco..oaabbco.",
  ".oaabbco..oaabbco.",
  ".oaabbco..oaabbco.",
  ".oaabbco..oaabbco.",
  ".oaabbco..oaabbco.",
  "..oNNNo....oNNNo..",
  "..ooooo....ooooo..",
  "...FFF......FFF...",
  "...FfF......FfF...",
  "....f........f....",
  "....u........u....",
  "..................",
  "..................",
];
const JETPACK_ZAINO = [
"..oo..",
  ".oRRo.",
  "orRRRo",
  "oaabco",
  "oaabco",
  "osssso",
  "oSSSSo",
  "oaabco",
  "oaabco",
  "oaabco",
  "oaabco",
  ".oNNo.",
  ".oooo.",
];
const JETPACK_COLORI = { o: "#101520", a: "#f4f8ff", b: "#c9d6e8", c: "#9fb2cc", d: "#6f84a3", e: "#46566f", r: "#ff5a3a", R: "#c43a22", s: "#ff9a2e", S: "#8a4a10", n: "#2a2f3a", N: "#4a5262", f: "#ffe27a", F: "#ff8a2a", u: "#ff4a2a" };
// Boombox (il drop del basso; dal 08/10 al posto della cassa, Vitto: «mi
// sembrano troppo banali l'item e l'effetto»): lo stereo anni '80 col
// manico, due casse, la cassetta in mezzo e i led. In due pose che si
// alternano a tempo (250 ms): i coni pompano e i led si scambiano.
const BASSO_SPRITE = [
  "....hhhhhhhhh....",
  "....h.......h....",
  ".###############.",
  "#BBBBBBBBBBBBBBB#",
  "##sss#lglgl#sss##",
  "#scccs#####scccs#",
  "#sckcswtwtwsckcs#",
  "#scccswwwwwscccs#",
  "##sss##b#b##sss##",
  ".###############.",
  "..##.........##..",
];
const BASSO_POSE = [
  BASSO_SPRITE,
  BASSO_SPRITE.map((r, i) => (i === 4 ? r.replace("lglgl", "glglg") : i >= 5 && i <= 7 ? r.replace(/c/g, "C") : r)),
];
// Pozione rimpicciolente: ampolla col tappo e le bollicine.
const POZIONE_SPRITE = [
  "...kkk...",
  "...g.g...",
  "...g.g...",
  "..g...g..",
  ".g.....g.",
  "gpppppppg",
  "gpbpppbpg",
  "gppppbppg",
  ".gpppppg.",
  "..ggggg..",
];
// Il mini-dinosauro della pozione, con uno sprite suo (Vitto: «sprite
// dedicato»): 9 x 7 celle più le zampe, con le cuffie anche lui.
const MINI_SPRITE = [
  "....hhh..",
  "...h###h.",
  "..cc##e##",
  "..cc#####",
  "#..###...",
  "######...",
  ".####....",
];
const MINI_ZAMPE = [["..#..#..."], [".#..#...."]];
// Mina a terra (rifatta il 08/10, Vitto: «poco visibile»; era un cupolino
// grigio): fascia a strisce gialle e nere, piastra di metallo chiara col
// riflesso, lucina rossa che lampeggia (r) con l'alone e un riverbero rosso
// per terra. A celle da 1 unità: 18 x 10, lo stesso ingombro di prima.
// o contorno, w riflesso, m piastra, n metallo scuro, y/k strisce.
const MINA_SPRITE = [
  "........rr........",
  ".......orro.......",
  "....oooooooooo....",
  "...owwwmmmmmmmo...",
  ".onnnnnnnnnnnnnno.",
  "okkyykkyykkyykkyyo",
  "okyykkyykkyykkyyko",
  "oyykkyykkyykkyykko",
  "onnnnnnnnnnnnnnnno",
  ".oooooooooooooooo.",
];
// L'icona dell'errore di Windows XP (08/10, Vitto: «deve essere anche lui un
// item malefico»): cerchio rosso con la X bianca, luce in alto a sinistra.
// 18 x 18 celle da 1. o bordo, R/r/d rosso chiaro/medio/scuro, g riflesso,
// w la X. Galleggia bassa sulla strada (VIRUS_SOPRA): va saltata; se la
// tocchi non muori, ti apre le finestre d'errore (dinoInfetta).
const VIRUS_SPRITE = [
  "........oo........",
  ".....oooooooo.....",
  "...ooRgRRRRrroo...",
  "..ooRggRRRrrrroo..",
  "..oRggRRRrrrrrro..",
  ".oRggwwRrrrwwrrro.",
  ".oRRRwwwrrwwwrrro.",
  ".oRRRRwwwwwwrrrdo.",
  "ooRRRrrwwwwrrrddoo",
  "ooRRrrrwwwwrrdddoo",
  ".oRrrrwwwwwwddddo.",
  ".orrrwwwrrwwwdddo.",
  ".orrrwwrrrdwwdddo.",
  "..orrrrrrddddddo..",
  "..oorrrrddddddoo..",
  "...oorrddddddoo...",
  ".....oooooooo.....",
  "........oo........",
];
const VIRUS_COLORI = { o: "#5a0a00", R: "#ff6a55", r: "#e8250c", d: "#a81500", g: "#ffd0c8", w: "#ffffff" };
const VIRUS_SOPRA = 12; // unità da terra: chi corre la prende, chi salta no
const VIRUS_RINASCE = 3; // chiusure che fanno spuntare un'altra finestra
const VIRUS_DURA = 9000; // ms: dopo, le finestre spariscono da sole
// i messaggi, uno più assurdo dell'altro a ogni finestra che rinasce
const VIRUS_TESTI = [
  'L\'istruzione a "0x0d1n0000" ha fatto riferimento alla memoria a "0x00000000". La memoria non poteva essere "read".',
  "dino.exe ha riscontrato un problema e deve essere chiuso. Ci scusiamo per l'inconveniente.",
  "Impossibile chiudere la finestra. Memoria insufficiente per chiudere la finestra.",
  "Errore durante la chiusura dell'errore precedente. Riprovare più tardi.",
];
const MINA_COLORI = { o: "#141414", w: "#f4f4f5", m: "#b9bcc6", n: "#4a4d57", y: "#ffd23f", k: "#1a1a1a" };
// Mina col paracadute: la classica con le spine (s), riflesso (l), lucina (r).
const MINA_AEREA_SPRITE = [
  "....s....",
  ".s.###.s.",
  "..#####..",
  ".##l####.",
  "s###r###s",
  ".#######.",
  "..#####..",
  ".s.###.s.",
  "....s....",
];
const PARACADUTE_SPRITE = [
  "....#####....",
  "..#########..",
  ".###########.",
  "#############",
  "w.w.w.w.w.w.w",
];
// placche sulla schiena di Godzilla (riga, colonna sulla griglia del
// dinosauro), nelle celle vuote dietro collo e schiena
// Godzilla (rifatto il 08/10, Vitto: «sembra un dino verde», poi
// «facciamolo sempre arancio»): mostro in piedi, 52 x 54 celle da 1 (il
// doppio del dinosauro), arancio come lui, con la cresta di placche color
// osso sulla schiena, la coda grossa che tocca terra, la pancia a righe e le
// braccine con gli artigli. Lettere: o contorno, # corpo, l luce, d ombra e
// squame, b/B pancia, e/E occhio e riflesso, D arcata, bocca e narice,
// w denti e unghie, p/P placche (alternate), q bordo delle placche, x la
// bocca aperta che brilla. Le ultime 6 righe sono le zampe, in due pose
// (passo pesante); GODZILLA_APERTA sono le righe 12-18 a bocca aperta,
// mentre spara.
const GODZILLA_SPRITE = [
  "....................................................",
  "....................................................",
  "....................................................",
  "....................................................",
  ".......................................oooooooo.....",
  "......................................ollllllllo....",
  "................................q....ol########lo...",
  ".........................q......q...ol######DDD#lo..",
  ".........................qq...qqpqq.o#######eE###lo.",
  "..........................qq..qppppql#############D.",
  ".........................qPPqqPpplll#########dddddo.",
  "..................q.....qPPPPPPol###########doooooo.",
  "..................qq.....qPPPPPl###########DDDDDDD..",
  "...................qqqqq..qPPPl#############wowowo..",
  "...................qppppq.qPPl##########dddddoooo...",
  "...................qpppppq.oll#########dooooo.......",
  "...................qppppppqll##########o............",
  "....................qqppppll##########do............",
  "...........q......q...qplll##########do.............",
  "............qqqqqqPqqollll####d#####do..............",
  "..............qPPPPPPlll##d###bbbbb#o...............",
  "...............qPPPPll#########BBBBBlooo............",
  "...............qPPPPl#############bbbbbloo..........",
  "................qqPl################bbbbblo.........",
  "..................ol##d########d####BBBBB#lo........",
  "..............qqqql#################bbbbb##lo.......",
  "..............qpppl#################bbbbb###o.......",
  "............qqpppp##d##########d####BBBBB###lo......",
  "........qqqqpppppp#################bbbbobd##dw......",
  "............qppppp#####d########bbbbb#o.ooddw.......",
  ".............qpppo##########ddddBBBBB#o...ow........",
  "..............qPPo##############bbbbbdo.............",
  "............qqPPPo###d##########bbbbb#o.............",
  "............qPPPPP##############BBBBB#o.............",
  "............qPPPPP#######d######bbbbb#o.............",
  "...........qPPPPPl##d###########bbbbb#o.............",
  ".........qqqPPPPll#d############BBBBBdo.............",
  "........qq..qPPll##############bbbbb#o..............",
  "...........qppll################bbbbblo.............",
  "...........qpll#d###############BBBBB#o.............",
  ".........q.qll#########d########bbbbb#o.............",
  ".......qqPqll######d##########d#bbbbb#o.............",
  "........qPll############d#######BBBBB#o.............",
  "........qll#####################bbbbbdo.............",
  ".....q.oll#####################bbbbb#o..............",
  "....qpqll######d########d########d##do..............",
  "....qpll###d###############d########o...............",
  "....qll###################dod######do...............",
];
const GODZILLA_ZAMPE = [
  [
    "...oll#######d##dd######ddo.od######o...............",
    "..oll####d###dddood######o...o######o...............",
    ".oll######dddooo..o######o...o######o...............",
    "olldddddddooo.....o##ddddo...o######o...............",
    "oooooooooo.......olddddddloowlddddddlow.............",
    ".................oooooooooooooooooooooo.............",
  ],
  [
    "...oll#######d##d#######ddo.od######o...............",
    "..oll####d###dddod#######o...o######o...............",
    ".oll######dddooo.odddddddloo.o######o...............",
    "olldddddddooo....ooooooooooo.o######o...............",
    "oooooooooo..................wlddddddlow.............",
    "............................ooooooooooo.............",
  ],
];
const GODZILLA_APERTA = [
  "..................qq.....qPPPPPl###########DwDwDwD..",
  "...................qqqqq..qPPPl##########Dxxxxxxxx..",
  "...................qppppq.qPPl##########dDxxxxxxxx..",
  "...................qpppppq.oll#########doDxxxxxxxx..",
  "...................qppppppqll##########o..##wowowo..",
  "....................qqppppll##########do..dddoooo...",
  "...........q......q...qplll##########do...ooo.......",
];
const GODZILLA_W = 52;
const GODZILLA_H = 54;
const GODZILLA_BOCCA = [50, 14]; // da qui parte il soffio (bocca aperta)
// disegnato più grande delle sue celle (Vitto 08/10: «un pelo più
// grande», poi «ingrandisci pure del 35»): 70 x 73 unità
const GODZILLA_SCALA = 1.35;
const GODZILLA_COLORI = {
  o: "#3d1604",
  "#": "#ff6a00",
  l: "#ff9a4d",
  d: "#c94f00",
  b: "#ffc48a",
  B: "#ffb070",
  e: "#141414",
  E: "#ffffff",
  D: "#3d1604",
  w: "#fff4e6",
  p: "#ffe9d1",
  P: "#f5d3b0",
  q: "#d9a77a",
  x: "#e6fbff",
};
// la trasformazione, a scatti come il fungo di Mario (un passo ogni 75 ms):
// 0 = il dinosauro, poi Godzilla sempre più grande; e al contrario quando
// il potere finisce
const MUTA_PASSO = 75;
const MUTA_CRESCE = [0, 0.55, 0, 0.75, 0.55, 1, 0.75, 1];
const MUTA_TORNA = [1, 0.75, 1, 0.55, 0.75, 0, 0.55, 0];
const STELLA_COLORI = ["#ffd23f", "#ff8a2a", "#ff3b6b", "#b26bff", "#39c6ff", "#f4f4f5"];

// nome (annunciato a centro scena), durata in ms di corsa, peso
// nell'estrazione (Godzilla il più raro), colore di alone e barretta
// (durata 0 = effetto immediato: il drop del basso)
const OGGETTI = {
  scaglia: { nome: "Godzilla!", sotto: "Spacca tutto", durata: 8000, peso: 0.12, colore: "#7dff4a", cella: 1, sprite: SCAGLIA_SPRITE, colori: { "#": "#1a1405", y: "#fff0a0", Y: "#ffd23f", z: "#e8b020", Z: "#b9830f", q: "#7a5508", k: "#141414", K: "#4a3a10", g: "#58e02a", G: "#c6ff9a" } },
  stella: { nome: "Stella!", sotto: "Invincibile", durata: 8000, peso: 0.17, colore: "#ffd23f", sprite: STELLA_SPRITE, colori: { "#": "#ffd23f", k: "#141414" } },
  cuffie: { nome: "Scudo!", sotto: "Para un colpo", durata: 15000, peso: 0.2, colore: "#4fb0ff", sprite: CUFFIE_SPRITE, colori: { o: "#0a1d4a", r: "#eaf4ff", R: "#7f9bc8", w: "#ffffff", l: "#8fd0ff", m: "#4fa5f5", b: "#2272dc", d: "#154ba6", y: "#ffe27a", Y: "#e0a21a" } },
  basso: {
    nome: "Boombox!",
    sotto: "Bass drop",
    durata: 0,
    peso: 0.16,
    colore: "#ff5fd2",
    sprite: BASSO_SPRITE,
    pose: BASSO_POSE,
    colori: { "#": "#2b2b33", B: "#4a4a55", h: "#c9c9ce", s: "#8c8c96", c: "#ff6a00", C: "#ffb066", k: "#141414", w: "#9fd8ff", t: "#26262c", l: "#ff8a2a", g: "#7dff4a", b: "#c9c9ce" },
  },
  pozione: { nome: "Mini!", sotto: "Piccolo piccolo", durata: 8000, peso: 0.16, colore: "#d14bff", sprite: POZIONE_SPRITE, colori: { k: "#b07040", g: "#e6e6f0", p: "#d14bff", b: "#f5c6ff" } },
  jetpack: { nome: "Jetpack!", sotto: "Tieni premuto e vola", durata: 9000, peso: 0.19, colore: "#ff7a2a", cella: 1, sprite: JETPACK_SPRITE, colori: JETPACK_COLORI },
};

const dino = {
  stato: "riposo", // riposo | corsa | pausa | fine
  y: 0, // altezza del salto (0 = a terra, positivo = in aria)
  vy: 0,
  velocita: 0,
  punti: 0,
  record: 0,
  // { tipo: "mixer" | "fantasma", x, w, h, sopra, canali, lc, fase, scarto,
  // distacco }: sopra = quanto sta sollevato dal terreno, non la y; canali =
  // altezze in px dei canali del mixer, lc = loro larghezza; distacco =
  // spazio da lasciargli dietro prima del prossimo
  ostacoli: [],
  storia: [], // tipi degli ultimi due ostacoli: mai tre uguali di fila
  corsa: 0, // ms di corsa della partita (ostacoli solo dopo DINO_SGOMBRO)
  // oggetti e poteri (08/10)
  oggetto: null, // { tipo, x, w, h, sopra } sospeso in aria, si prende saltando
  prossimoOggetto: 0, // ms di corsa da cui può comparire il prossimo
  potere: null, // { tipo, fine, durata } in corso (fine in ms di corsa)
  grazia: 0, // ms di corsa fino a cui non si muore (potere finito, scudo rotto)
  carica: null, // { inizio, tacche } Godzilla carica il soffio (dito giù)
  soffio: null, // { inizio, forza, a0, a1, spazza, dura, angolo, x2, y2, colpiti, scintille, aTerra } il soffio atomico
  tieni: false, // dito (o tasto) ancora giù
  bruciature: [], // { x, vita } la strada bruciata dal soffio, scorre col terreno
  muta: null, // { verso: 1 cresce | -1 torna dinosauro, inizio, botto } la trasformazione
  particelle: [], // schegge degli ostacoli spaccati, scintille, luce dello scudo
  scritte: [], // i «+10» che salgono
  annuncio: null, // { testo, sotto, colore, inizio, fino } il nome del potere appena preso (dinoCartellone)
  scossa: 0, // ms di mondo che trema
  drop: null, // { inizio, cx, cy, fronte, colpiti, battiti, botto } il drop della boombox
  lanciati: [], // { o, vx, vy, giro, vg, dx, dy, vita } ostacoli sparati in aria dal drop
  noteDrop: [], // { x, y, vx, vy, tipo, vita } notine che esplodono dal dinosauro al drop
  lampo: null, // { cx, cy, inizio } la bolla dello scudo che va in pezzi
  virus: null, // { inizio, fino, chiusure, prossimo, finestre: [{ id, x, y, testo }] } le finestre di Windows aperte (px del banner)
  prossimoErrore: 0, // ms di corsa da cui può comparire la prossima icona di Windows
  doppio: false, // il mini ha già fatto il secondo salto in aria
  taglio: DINO_TAGLIO_SOPRA, // quota oltre la quale la salita rallenta di colpo (alzata dal secondo salto del mini)
  cento: -1e9, // ms di corsa dell'ultima centinaia superata
  fuoco: null, // { testo, l, w, h, griglia, sorgenti, ultimo, vampata } il punteggio in fiamme (dinoPunteggio)
  margine: 0, // a schermo intero: unità coperte dall'isola a sinistra (dinoX)
  margineDx: 0, // a schermo intero: unità coperte a destra (safe area), per centrare il minigioco del boss
  zoom: 1, // a schermo intero: quanto è ingrandito il banner (CSS transform)
  modo: "normale", // normale | crazy | classico (DINO_MODI)
  coda: null, // { x, w, distacco, scarto } l'ultima cosa partita: quando è entrata col suo distacco, parte la prossima
  boss: null, // { fase, tipo, livello, t, corsa0, velocita, esito, gioco } il boss in corso (vedi BOSS in cima)
  prossimoBoss: 1e12, // punti da cui parte il prossimo boss (1e12 = mai)
  bossVisti: 0, // boss incontrati in questa partita: decide quale tocca e il livello
  pausaSfondo: 0, // Date.now() di quando il background ha messo in pausa (dinoInGioco)
  causa: "", // cosa ti ha preso, per la schermata di fine
  terreno: [], // sassolini del terreno che scorrono
  passo: 0,
  fineAlle: 0,
  nuovoRecord: false,
  ultimo: 0,
  raf: 0,
  attesa: 0, // timer del prossimo fotogramma da fermo (ritmo ridotto)
  w: 0,
  h: 0,
  ctx: null,
  // atmosfera (08/10): tempo che scorre anche da fermi, stelle e nuvole del
  // cielo, la stella cadente di turno, notine che escono dalle cuffie
  amb: { tempo: 0, stelle: [], nuvole: [], note: [], prossimaNota: 600, cadente: null, prossimaCadente: 2500 },
};
window.__dino = dino; // per i test (Playwright)

function dinoCampo() {
  return document.getElementById("dinoCampo");
}

/** Allinea il canvas alla misura del riquadro (e ai pixel veri dello
 * schermo). dino.w e dino.h sono in unità del mondo (px / DINO_SCALA).
 * false se il riquadro non è sullo schermo. */
function dinoMisura() {
  const campo = dinoCampo();
  const cv = document.getElementById("dinoCanvas");
  if (!campo || !cv || !cv.offsetParent) return false;
  if (!campo.clientWidth || !campo.clientHeight) return false;
  const w = campo.clientWidth / DINO_SCALA;
  const h = campo.clientHeight / DINO_SCALA;
  // a schermo intero il banner è ingrandito di dino.zoom (transform): i pixel
  // veri sono di più, e il canvas li ha tutti (niente sgranato)
  const dpr = (window.devicePixelRatio || 1) * dino.zoom;
  const pw = Math.round(campo.clientWidth * dpr);
  const ph = Math.round(campo.clientHeight * dpr);
  if (dino.w !== w || dino.h !== h || cv.width !== pw || cv.height !== ph) {
    cv.width = pw;
    cv.height = ph;
    dino.w = w;
    dino.h = h;
    dino.ctx = cv.getContext("2d");
    dino.ctx.setTransform(dpr * DINO_SCALA, 0, 0, dpr * DINO_SCALA, 0, 0);
    dino.ctx.imageSmoothingEnabled = false;
    // sassolini rifatti sulla larghezza nuova (scorrono e ricominciano a w+40)
    dino.terreno = [];
    for (let x = 0; x < w + 40; x += 18 + Math.random() * 30) {
      dino.terreno.push({ x, y: 4 + Math.random() * 10, w: 1 + Math.round(Math.random() * 3) });
    }
    dinoCieloNuovo();
  }
  return true;
}

/** Stelle e nuvole a celle intere, rifatte a ogni cambio di misura (unità
 * del mondo; sullo schermo la scritta OFFLINE MODE copre 16-41 px, poi il
 * punteggio, poi gli inviti e lo schianto nella fascia centrale sopra il
 * terreno). Le stelle mai dietro le scritte né sopra il sole; le nuvole
 * basse, appena sopra il sole, e gli passano davanti. */
function dinoCieloNuovo() {
  const w = dino.w;
  const terra = dinoTerra();
  const stelle = [];
  for (let i = 0; i < 160 && stelle.length < 18; i++) {
    const x = DINO_CELLA * Math.floor((4 + Math.random() * (w - 8)) / DINO_CELLA);
    const y = DINO_CELLA * Math.floor((4 + Math.random() * (terra - 44)) / DINO_CELLA);
    const lato = Math.abs(x - w / 2);
    if (lato < 134 / DINO_SCALA && y < 45 / DINO_SCALA) continue; // OFFLINE MODE
    if (lato < 60 && y < DINO_Y_PUNTEGGIO + 14) continue; // punteggio
    if (lato < 100 && y > terra - 72 && y < terra - 12) continue; // inviti, schianto
    stelle.push({ x, y, periodo: 1800 + Math.random() * 2600, fase: Math.random() * 6.28 });
  }
  dino.amb.stelle = stelle;
  dino.amb.nuvole = [0, 1].map((i) => ({
    x: (i + Math.random() * 0.6) * w * 0.5,
    y: DINO_CELLA * Math.round((terra - 44 + Math.random() * 8) / DINO_CELLA),
  }));
}

/** Partita in corso o schermo intero aperto: il rientro online (che
 * ricarica l'app) aspetta, come aspetta un brano che suona. Anche la partita
 * messa in pausa dal background (magari a metà boss), per DINO_PAUSA_TUTELA:
 * chi torna la ritrova e la riprende; dopo tanto tempo vince il rientro. */
const DINO_PAUSA_TUTELA = 5 * 60 * 1000; // ms veri
function dinoInGioco() {
  const sfondo = dino.stato === "pausa" && dino.pausaSfondo && Date.now() - dino.pausaSfondo < DINO_PAUSA_TUTELA;
  return dino.stato === "corsa" || sfondo || dinoSchermoAperto();
}

// —— SCHERMO INTERO (c'era il 07/10, tolto, rimesso il 08/10: Vitto
// «possiamo rimettere al volo la full screen»). L'app gira in orizzontale
// (OrientamentoPlugin.swift) e il banner del gioco intero, scritta e
// finestre di Windows comprese, si sposta nell'overlay #dinoSchermo e si
// ingrandisce con un transform: largo quanto lo schermo diviso lo zoom, così
// il mondo di gioco resta largo più o meno come nel banner (stessa vista
// davanti, stessa difficoltà), solo più grande. Lo zoom è un multiplo di
// 1/7: celle da 2 unità = 7 px veri × zoom × 3, tutti interi. ——

/** Plugin nativo che gira l'app (OrientamentoPlugin.swift); null fuori
 * dall'app iOS: allora il tasto schermo intero non compare. */
function pluginOrientamento() {
  try {
    const C = window.Capacitor;
    if (!isNativeShell() || C.getPlatform() !== "ios") return null;
    if (!C.isPluginAvailable("Orientamento")) return null;
    return C.Plugins.Orientamento || C.registerPlugin("Orientamento");
  } catch (_) {
    return null;
  }
}

let _dinoPosto = null; // dove stava il banner nella pagina { padre, dopo }
function dinoSchermoAperto() {
  return !!_dinoPosto;
}

function apriSchermoDino() {
  const el = document.getElementById("dinoSchermo");
  const area = document.getElementById("dinoSchermoArea");
  const cab = document.getElementById("offlineCabinato");
  const o = pluginOrientamento();
  if (!el || !area || !cab || !o || _dinoPosto) return;
  if (dino.stato === "corsa") dino.stato = "pausa";
  _dinoPosto = { padre: cab.parentNode, dopo: cab.nextSibling };
  area.appendChild(cab);
  el.classList.remove("hidden");
  el.setAttribute("aria-hidden", "false");
  o.orizzontale().catch(() => {});
  // le misure vere arrivano con la rotazione: adatta adesso e a ogni resize
  adattaSchermoDino();
}

function chiudiSchermoDino() {
  const el = document.getElementById("dinoSchermo");
  const cab = document.getElementById("offlineCabinato");
  if (!el || !cab || !_dinoPosto) return;
  if (dino.stato === "corsa") dino.stato = "pausa";
  dinoSuonoRiposa(0);
  _dinoPosto.padre.insertBefore(cab, _dinoPosto.dopo);
  _dinoPosto = null;
  ["width", "left", "top", "transform"].forEach((k) => (cab.style[k] = ""));
  dino.zoom = 1;
  dino.margine = 0;
  dino.margineDx = 0;
  el.classList.add("hidden");
  el.setAttribute("aria-hidden", "true");
  const o = pluginOrientamento();
  if (o) o.verticale().catch(() => {});
  requestAnimationFrame(() => {
    if (dinoMisura()) dinoDisegna();
  });
}

/** Ingrandisce il banner a tutto lo spazio dell'overlay (in orizzontale lo
 * riempie in altezza, la larghezza segue) e lo centra. */
function adattaSchermoDino() {
  const area = document.getElementById("dinoSchermoArea");
  const cab = document.getElementById("offlineCabinato");
  if (!_dinoPosto || !area || !cab) return;
  const W = area.clientWidth;
  const H = area.clientHeight;
  if (!W || !H) return;
  // schermo pieno davvero (Vitto 08/10: «la full screen falla completa, non
  // banner dentro schermo pieno»): il gioco riempie tutto, senza cornice.
  // Ingrandito di k/7 (ogni cella su pixel veri), alto un multiplo di 7 px
  // (il terreno resta su un'unità pari): i pochi px che avanzano stanno in
  // cima, dove il cielo è già quasi nero come il fondo
  cab.style.transform = "";
  const zoom = Math.max(1, Math.floor(Math.min(H / 189, W / 300) * 7) / 7);
  const largo = Math.ceil(W / zoom);
  const alto = Math.floor(H / zoom / 7) * 7;
  cab.style.width = `${largo}px`;
  cab.style.setProperty("--alto-schermo", `${alto}px`);
  cab.style.left = "0px";
  // l'isola e gli angoli: quanto coprono ai lati (in px del banner)
  let sonda = document.getElementById("dinoSonda");
  if (!sonda) {
    sonda = document.createElement("div");
    sonda.id = "dinoSonda";
    sonda.style.cssText = "position:fixed;visibility:hidden;pointer-events:none;padding-left:env(safe-area-inset-left,0px);padding-right:env(safe-area-inset-right,0px)";
    document.body.appendChild(sonda);
  }
  const cs = getComputedStyle(sonda);
  const sx = parseFloat(cs.paddingLeft) || 0;
  const ddx = parseFloat(cs.paddingRight) || 0;
  cab.style.setProperty("--margine-sx", `${sx / zoom}px`);
  cab.style.setProperty("--margine-dx", `${ddx / zoom}px`);
  dino.margine = sx / zoom / DINO_SCALA;
  dino.margineDx = ddx / zoom / DINO_SCALA;
  cab.style.top = `${Math.round(H - alto * zoom)}px`;
  cab.style.transform = `scale(${zoom})`;
  const sc = document.getElementById("dinoSchermo");
  if (sc) sc.style.setProperty("--zoom", String(zoom));
  dino.zoom = zoom;
  if (dinoMisura()) dinoDisegna();
}

// il terreno: 26 unità dal fondo, in CSS 26px × DINO_SCALA (lo sfondo del
// campo, style.css, ci mette l'orizzonte)
function dinoTerra() {
  return dino.h - 26;
}
function dinoX() {
  // a schermo intero la mappa arriva fino ai bordi, anche sotto l'isola:
  // il dinosauro si sposta di quanto copre l'isola a sinistra
  return 22 + dino.margine;
}

/** Ogni ingresso in modalità offline riparte pulito (una partita in pausa
 * di ore prima non ha senso); il record resta. */
function dinoPrepara() {
  try {
    dino.record = parseInt(localStorage.getItem(dinoModo().record) || "0", 10) || 0;
  } catch (_) {}
  if (dino.stato !== "corsa") {
    dino.stato = "riposo";
    dino.ostacoli = [];
    dino.punti = 0;
    dino.y = 0;
    dino.vy = 0;
    dino.oggetto = null;
    dino.potere = null;
    dino.carica = null;
    dino.soffio = null;
    dino.bruciature = [];
    dino.muta = null;
    dino.particelle = [];
    dino.scritte = [];
    dino.annuncio = null;
    dino.drop = null;
    dino.lanciati = [];
    dino.noteDrop = [];
    dino.virus = null;
    dino.boss = null;
  }
  if (dinoMisura()) {
    dinoDisegna();
    dinoAvvia();
  }
}

function dinoNuovaPartita() {
  dino.stato = "corsa";
  dino.y = 0;
  dino.vy = 0;
  dino.velocita = DINO_VEL_INIZIO;
  dino.punti = 0;
  dino.corsa = 0;
  dino.ostacoli = [];
  dino.storia = [];
  dino.amb.note = [];
  dino.oggetto = null;
  dino.coda = null;
  dino.cento = -1e9;
  dino.doppio = false;
  dino.taglio = DINO_TAGLIO_SOPRA;
  dino.fuoco = null;
  const modo = dinoModo();
  dino.prossimoOggetto = modo.oggetti ? dinoTra(modo.oggetti[0]) : 1e12;
  dino.potere = null;
  dino.grazia = 0;
  dino.carica = null;
  dino.soffio = null;
  dino.tieni = false;
  dino.bruciature = [];
  dino.muta = null;
  dino.particelle = [];
  dino.scritte = [];
  dino.annuncio = null;
  dino.scossa = 0;
  dino.lampo = null;
  dino.drop = null;
  dino.lanciati = [];
  dino.noteDrop = [];
  dino.virus = null;
  dino.prossimoErrore = modo.errore ? dinoTra(modo.errore[0]) : 1e12;
  dino.boss = null;
  dino.prossimoBoss = modo.boss && BOSS_ACCESO ? modo.boss.primo : 1e12;
  dino.bossVisti = 0;
  dino.pausaSfondo = 0;
  dino.causa = "";
}

/** Spinta del salto in px/ms: come in Chrome cresce un po' con la velocità. */
function dinoSpinta() {
  const v = ((10 + dino.velocita / 10) * DINO_K) / DINO_FOTOGRAMMA;
  return dinoMini() ? v * MINI_SALTO_V : v;
}
// Il mini (08/10, Vitto: «sembra più un debuff che un buff»): un salto
// agile, alto e veloce: picco ~56 (il dino normale 58) ma in ~380 ms invece
// di 550, e abbastanza in alto da scavalcare i fantasmini alti senza
// rischiare l'atterraggio. I fantasmini bassi si alzano perché ci passi
// sotto camminando (dinoPasso, MINI_VARCO). Prendendo la pozione (o
// finendo l'effetto) a mezz'aria la velocità si riscala con la radice del
// cambio di gravità, così la quota resta continua: prima, con la gravità
// dimezzata e la spinta intera, si volava altissimo.
// Il jetpack (08/10): tieni premuto e sali, rilasci e scendi piano. Un tocco
// breve è un saltello (JET_DECOLLO ≈ 42 unità di picco, abbastanza per mine,
// mixer e cristalli); tenendo premuto spinge fino a JET_SALITA e si ferma a
// JET_TETTO (sotto il punteggio: sopra i cristalli e le mine, ma i fantasmini
// alti, che occupano 41-69, restano da evitare volando sotto i 19). Il
// «serbatoio» è il tempo del potere: spingere ne brucia JET_CONSUMO volte più
// in fretta, così la barra a tacche sopra la testa è anche il carburante.
const JET_DECOLLO = 0.34; // px/ms
const JET_SALITA = 0.19;
const JET_ACCEL = 0.0045; // px/ms², oltre alla gravità
const JET_CADUTA = 0.22; // velocità massima di discesa (plana)
const JET_TETTO = 56;
const JET_CONSUMO = 1.3;
function dinoJet() {
  return !!(dino.potere && dino.potere.tipo === "jetpack");
}
/** Sta spingendo adesso: dito giù, carburante, partita in corsa. */
function dinoJetSpinge() {
  return dinoJet() && dino.tieni && dino.potere.fine > dino.corsa && dino.stato === "corsa";
}
const MINI_GRAVITA = 1.87;
const MINI_SALTO_V = 1.55;
const MINI_RADICE = Math.sqrt(MINI_GRAVITA);
const MINI_VARCO = 17;
const MINI_DOPPIO = 18; // di quante unità sale in più il secondo salto
const MINI_TETTO = 68; // oltre questa quota (unità) il secondo salto rallenta di colpo
function dinoMini() {
  return !!(dino.potere && dino.potere.tipo === "pozione");
}

/** Il tocco: parte, salta, riparte dopo lo schianto, riprende dalla pausa. */
function dinoTocca() {
  if (!dinoMisura()) return;
  dinoSuonoSveglia(); // dentro il gesto: iOS fa partire l'audio solo qui
  if (dino.stato === "riposo" || dino.stato === "fine") {
    // dopo uno schianto un attimo di respiro: un tocco nervoso non deve
    // far ripartire subito la partita
    if (dino.stato === "fine" && performance.now() - dino.fineAlle < 450) return;
    dinoNuovaPartita();
    dino.vy = dinoSpinta(); // la prima partenza è già un salto, come in Chrome
    dinoSuono("salto");
  } else if (dino.stato === "pausa") {
    dino.stato = "corsa";
    dino.pausaSfondo = 0;
    dinoBossMolla(); // dita e tasti lasciati durante la pausa
  } else if (dinoBossTocca()) {
    // il boss è arrivato: il tocco è del minigioco (o di nessuno), niente salti
  } else if (dino.potere && dino.potere.tipo === "scaglia") {
    // Godzilla non salta: tieni premuto per caricare il soffio, lascia
    // per sparare (dinoLascia)
    dino.tieni = true;
    if (!dino.carica && !dino.soffio) {
      dino.carica = { inizio: dino.corsa, tacche: 0 };
      dino.potere.provato = true; // basta il suggerimento
    }
  } else if (dinoJet()) {
    // jetpack: tieni premuto e sali (dinoPasso); da terra parte con un
    // saltello, così anche un tocco breve scavalca un ostacolo
    dino.tieni = true;
    if (dino.y === 0) {
      dino.vy = JET_DECOLLO;
      dinoSuono("salto");
    }
  } else if (dino.y === 0) {
    dino.vy = dinoSpinta();
    dinoSuono("salto");
  } else if (dinoMini() && !dino.doppio) {
    // il mini è agile (08/10, Vitto: «renderlo più agile»): un secondo
    // salto in aria, per correggere il tempo o scavalcare due ostacoli
    // di fila. Un colpetto di fumo viola sotto i piedi
    dino.doppio = true;
    // spinta per salire di MINI_DOPPIO unità sopra dov'è (mai meno di quella
    // che ha già se sta ancora salendo)
    dino.vy = Math.max(dino.vy, Math.sqrt(2 * DINO_G * MINI_GRAVITA * MINI_DOPPIO));
    // la salita rallenta di colpo (come in Chrome) più in alto di dove
    // sei: così il secondo salto sale di ~MINI_DOPPIO senza sfondare il cielo
    dino.taglio = Math.max(DINO_TAGLIO_SOPRA, Math.min(MINI_TETTO, dino.y + MINI_DOPPIO - 8));
    if (dino.potere) dino.potere.provato = true;
    dinoSuono("salto");
    dinoVibra("LIGHT");
    for (let i = 0; i < 6; i++) {
      dino.particelle.push({
        x: dinoX() + 3 + Math.random() * 10,
        y: dinoTerra() - dino.y + Math.random() * 2,
        vx: (Math.random() - 0.5) * 0.1,
        vy: -0.01 + Math.random() * 0.02,
        vita: 0,
        durata: 380,
        colore: Math.random() < 0.5 ? "#d14bff" : "#f5c6ff",
      });
    }
  }
  dinoAvvia();
}

/** Il ciclo: a pieno ritmo mentre corri; da fermo (riposo, pausa, dopo lo
 * schianto) ~14 fotogrammi al secondo per l'atmosfera, che è lenta e a
 * scatti: bastano, e la batteria ringrazia. Con «riduci movimento» da fermo
 * non gira proprio. Si spegne da solo se il cabinato non è sullo schermo
 * (playlist aperta) o l'app va in background; lo riaccendono il
 * ResizeObserver (cabinato di nuovo visibile) e il ritorno in primo piano. */
function dinoAvvia() {
  if (dino.raf) return;
  clearTimeout(dino.attesa);
  dino.attesa = 0;
  dino.raf = requestAnimationFrame(dinoGiro);
}

function dinoGiro(ora) {
  dino.raf = 0;
  // cabinato sparito (playlist aperta, tornati online) o app in background:
  // pausa, niente ciclo che gira a vuoto
  if (!(appOfflineMode || dinoInHome()) || !dinoMisura() || document.visibilityState !== "visible") {
    if (dino.stato === "corsa") dino.stato = "pausa";
    dinoSuonoRiposa(0);
    dino.ultimo = 0;
    return;
  }
  const trascorso = dino.ultimo ? ora - dino.ultimo : 16;
  dino.ultimo = ora;
  if (dino.stato === "corsa") dinoAvanza(Math.min(40, trascorso)); // un intoppo non teletrasporta
  dinoAmbiente(Math.min(200, trascorso));
  dinoDisegna();
  if (dino.stato === "corsa") {
    dino.raf = requestAnimationFrame(dinoGiro);
  } else if (!dinoMotoRidotto()) {
    dino.attesa = setTimeout(() => {
      dino.attesa = 0;
      dino.raf = requestAnimationFrame(dinoGiro);
    }, 70);
  } else {
    dino.ultimo = 0;
  }
}

function dinoMotoRidotto() {
  return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
}

/** L'atmosfera va avanti anche da fermi: il tempo (stelle, sole, battito)
 * e le notine che escono dalle cuffie mentre il dinosauro aspetta. */
function dinoAmbiente(dt) {
  const a = dino.amb;
  a.tempo += dt;
  if (dino.stato === "riposo" && a.tempo >= a.prossimaNota) {
    a.note.push({ vita: 0, tipo: Math.random() < 0.6 ? 0 : 1, fase: Math.random() * 6.28 });
    a.prossimaNota = a.tempo + 1000 + Math.random() * 900;
  }
  a.note.forEach((n) => (n.vita += dt));
  a.note = a.note.filter((n) => n.vita < 2600);
  // nuvole che passano piano (5 px al secondo), anche da fermi
  a.nuvole.forEach((n) => {
    n.x -= dt * 0.005;
    if (n.x < -46) n.x = dino.w + 4;
  });
  // ogni 6-14 s una stella cadente: parte di fianco al punteggio, sotto la
  // scritta OFFLINE MODE, e scappa quasi in piano verso il bordo, sopra gli
  // inviti (in alto finiva dietro la scritta e sembrava una manciata di
  // puntini)
  if (a.cadente) {
    a.cadente.vita += dt;
    if (a.cadente.vita > 900) a.cadente = null;
  } else if (a.tempo >= a.prossimaCadente) {
    const verso = Math.random() < 0.5 ? -1 : 1;
    const x = dino.w * (verso > 0 ? 0.74 + Math.random() * 0.14 : 0.12 + Math.random() * 0.14);
    a.cadente = { x, y: DINO_Y_PUNTEGGIO - 4 + Math.random() * 10, verso, vita: 0 };
    a.prossimaCadente = a.tempo + 6000 + Math.random() * 8000;
  }
  // schegge e scintille volano e ricadono, anche a partita finita
  dino.particelle.forEach((p) => {
    p.vita += dt;
    p.x += p.vx * dt;
    p.y -= p.vy * dt;
    p.vy -= 0.0009 * dt;
  });
  dino.particelle = dino.particelle.filter((p) => p.vita < p.durata);
  dino.scritte.forEach((s) => {
    s.vita += dt;
    s.y -= dt * 0.03;
  });
  dino.scritte = dino.scritte.filter((s) => s.vita < 800);
  dino.scossa = Math.max(0, dino.scossa - dt);
  // il jetpack spinge: fumo che scende e scintille arancio dall'ugello
  if (dinoJetSpinge() && Math.random() < dt / 28) {
    const y0 = dinoTerra() - dino.y - DINO_H;
    dino.particelle.push({
      x: dinoX() + 3 + Math.random() * 5,
      y: y0 + 24 + Math.random() * 4,
      vx: -0.05 - Math.random() * 0.06,
      vy: -0.04 - Math.random() * 0.06,
      vita: 0,
      durata: 420,
      colore: Math.random() < 0.55 ? "#9a9aa5" : Math.random() < 0.5 ? "#ffb02e" : "#ff6a1a",
    });
  }
  // il mini lascia scintille viola dai piedi (un buff si deve vedere)
  if (dino.stato === "corsa" && dinoMini() && Math.random() < dt / 90) {
    dino.particelle.push({
      x: dinoX() + 4 + Math.random() * 8,
      y: dinoTerra() - dino.y - Math.random() * 14,
      vx: -0.05 - Math.random() * 0.04,
      vy: 0.02 + Math.random() * 0.04,
      vita: 0,
      durata: 450,
      colore: Math.random() < 0.5 ? "#d14bff" : "#f5c6ff",
    });
  }
  // la stella lascia una scia di scintille dorate
  if (dino.stato === "corsa" && dino.potere && dino.potere.tipo === "stella" && Math.random() < dt / 70) {
    dino.particelle.push({
      x: dinoX() + 2 + Math.random() * 8,
      y: dinoTerra() - dino.y - Math.random() * DINO_H,
      vx: -0.06 - Math.random() * 0.04,
      vy: 0.02 + Math.random() * 0.04,
      vita: 0,
      durata: 500,
      colore: Math.random() < 0.5 ? "#ffd23f" : "#fff3b0",
    });
  }
}

/** Avanza la partita di dt ms, a passi di al massimo un fotogramma di
 * Chrome (16,7 ms): coi fotogrammi lenti un passo lungo faceva salire il
 * salto più del dovuto (fino a ~65 unità invece di ~58, e il fantasmino alto
 * si scavalcava) e poteva saltare un urto. Così il salto è sempre lo stesso. */
function dinoAvanza(dt) {
  while (dt > 0 && dino.stato === "corsa") {
    const passo = Math.min(dt, DINO_FOTOGRAMMA);
    // col boss la corsa gira solo finché lui non è arrivato (vedi BOSS in
    // cima): dall'incontro in poi corsa, velocità e punti restano fermi
    if (dinoBossCorre()) dinoPasso(passo);
    if (dino.stato === "corsa") dinoBossPasso(passo);
    dt -= passo;
  }
}

function dinoPasso(dt) {
  const fot = dt / DINO_FOTOGRAMMA; // fotogrammi di Chrome in questo passo
  // jetpack: la spinta (e il carburante che brucia), suono e vibrazione
  const spinge = dinoJetSpinge();
  if (spinge) {
    const p = dino.potere;
    p.fine -= dt * JET_CONSUMO;
    p.provato = true;
    if (dino.y >= JET_TETTO) {
      dino.y = JET_TETTO;
      dino.vy = Math.min(dino.vy, 0);
    } else if (dino.vy < JET_SALITA) {
      dino.vy = Math.min(JET_SALITA, dino.vy + (JET_ACCEL + DINO_G) * dt);
    }
    if (dino.corsa - (p.ultimoJet || -1e9) > 85) {
      p.ultimoJet = dino.corsa;
      dinoSuono("jet");
      if (dino.corsa - (p.ultimaVibra || -1e9) > 170) {
        p.ultimaVibra = dino.corsa;
        dinoVibra("LIGHT");
      }
    }
  }
  if (dino.y > 0 || dino.vy > 0) {
    dino.y += dino.vy * dt;
    dino.vy -= DINO_G * (dinoMini() ? MINI_GRAVITA : 1) * dt;
    // il jetpack plana: la discesa ha una velocità massima
    if (dinoJet() && dino.vy < -JET_CADUTA) dino.vy = -JET_CADUTA;
    // oltre 63 px (suoi) la salita rallenta di colpo, come in Chrome
    if (!dinoJet() && dino.y > dino.taglio && dino.vy > DINO_TAGLIO_VY) dino.vy = DINO_TAGLIO_VY;
    if (dino.y <= 0) {
      dino.y = 0;
      dino.vy = 0;
      dino.doppio = false;
      dino.taglio = DINO_TAGLIO_SOPRA;
    }
  }
  dino.velocita = Math.min(DINO_VEL_MAX, dino.velocita + DINO_ACCELERA * fot);
  // lo scenario scorre di velocità − 0,5: Chrome arrotonda per difetto i px
  // di ogni fotogramma e in media ne perde mezzo. I punti contano invece la
  // velocità intera, 0,025 a px suo, come in Chrome
  const dx = (dino.velocita - 0.5) * fot * DINO_K;
  const centinaia = Math.floor(dino.punti / 100);
  dino.punti += dino.velocita * fot * 0.025;
  if (Math.floor(dino.punti / 100) > centinaia) {
    dinoSuono("cento");
    dino.cento = dino.corsa; // il punteggio lampeggia (dinoPunteggio)
  }
  dino.passo += dt;
  dino.corsa += dt;
  dino.terreno.forEach((t) => {
    t.x -= dx;
    if (t.x < -6) t.x += dino.w + 40;
  });
  dino.ostacoli.forEach((o) => {
    const passo = o.scarto ? (dino.velocita + o.scarto - 0.5) * fot * DINO_K : dx;
    o.x -= passo;
    // i fantasmini bassi si alzano per far passare il mini, e tornano giù
    if (o.tipo === "fantasma") {
      if (o.base === undefined) o.base = o.sopra;
      if (o.base < DINO_H) {
        const meta = dinoMini() ? Math.max(o.base, MINI_VARCO) : o.base;
        o.sopra += (meta - o.sopra) * Math.min(1, 0.12 * fot);
        if (Math.abs(meta - o.sopra) < 0.05) o.sopra = meta;
      }
    }
    // la mina col paracadute scende di pari passo con la strada che fa
    if (o.tipo === "paracadute" && o.sopra > 0) {
      o.sopra = Math.max(0, o.sopra - o.discesa * passo);
      if (o.sopra === 0) dinoAtterra(o);
    }
  });
  // la coda scorre come l'ultima cosa partita, anche quando quella è già
  // uscita, spaccata o presa
  const coda = dino.coda;
  if (coda) coda.x -= coda.scarto ? (dino.velocita + coda.scarto - 0.5) * fot * DINO_K : dx;
  dino.ostacoli = dino.ostacoli.filter((o) => o.x + o.w > -10);
  dinoDropPasso(dt);
  // le finestre di Windows: dopo VIRUS_DURA spariscono da sole
  if (dino.virus && dino.corsa > dino.virus.fino) dino.virus = null;
  // l'oggetto sospeso e le schegge scorrono col terreno
  if (dino.oggetto) {
    dino.oggetto.x -= dx;
    if (dino.oggetto.x + dino.oggetto.w < -10) dino.oggetto = null; // perso
  }
  dino.particelle.forEach((p) => (p.x -= dx));
  dino.bruciature.forEach((b) => {
    b.x -= dx;
    b.vita += dt;
  });
  if (dino.bruciature.length) dino.bruciature = dino.bruciature.filter((b) => b.vita < 1600 && b.x > -4);
  // il prossimo parte quando la coda (l'ultima cosa partita, ostacolo o
  // oggetto), col distacco che si porta dietro, è entrata tutta nel
  // riquadro; nei primi 3 s niente. Se tocca a un oggetto decide lui
  // (dinoNuovoOggetto), anche di far aspettare. Col boss in arrivo solo
  // ostacoli finché aspetta (attesa), poi più niente (vedi BOSS)
  if (dino.corsa > DINO_SGOMBRO && (!dino.boss || dino.boss.fase === "attesa") && (!coda || coda.x + coda.w + coda.distacco < dino.w)) {
    if (!dinoNuovoOggetto()) dinoNuovoOstacolo();
  }
  const terra = dinoTerra();
  const d = dinoScatolaDino(terra);
  const tocca = (r) => d.x < r.x + r.w && d.x + d.w > r.x && d.y < r.y + r.h && d.y + d.h > r.y;
  // l'oggetto si prende toccandolo
  const it = dino.oggetto;
  if (it && tocca({ x: it.x + 2, y: terra - it.sopra - it.h + 2, w: it.w - 4, h: it.h - 4 })) dinoPrendi(it);
  // potere finito: per un attimo non si muore, se ci si ritrova dentro un
  // ostacolo
  if (dino.potere && dino.potere.durata && dino.potere.fine - dino.corsa < 3000) {
    const n = Math.ceil((dino.potere.fine - dino.corsa) / 1000);
    if (n !== dino.potere.tic && n > 0) {
      dino.potere.tic = n;
      dinoVibra("LIGHT");
    }
  }
  if (dino.potere && dino.corsa >= dino.potere.fine) {
    // la barra del tempo va in pezzi
    const t = dinoPostoTimer(dino.potere);
    for (let i = 0; i < 12; i++) {
      dino.particelle.push({
        x: t.x + Math.random() * t.w,
        y: t.y,
        vx: (Math.random() - 0.5) * 0.14,
        vy: 0.04 + Math.random() * 0.1,
        vita: 0,
        durata: 420,
        colore: Math.random() < 0.6 ? OGGETTI[dino.potere.tipo].colore : "#ffffff",
      });
    }
    if (dino.potere.tipo === "pozione") {
      if (dino.y > 0) dino.vy /= MINI_RADICE;
      dinoSbuffo("#d14bff");
    }
    if (dino.potere.tipo === "scaglia") {
      // torna dinosauro a scatti, in uno sbuffo di fumo
      dino.muta = { verso: -1, inizio: dino.corsa };
      dino.carica = null;
      dino.soffio = null;
      dinoFumo();
      dinoSuono("torna");
    }
    dino.potere = null;
    dino.grazia = dino.corsa + 800;
  }
  dinoCaricaPasso();
  dinoSoffioPasso(dt);
  dinoMutaPasso();
  // urto: rettangoli un po' più stretti dei disegni, come in Chrome
  let urtati = dino.ostacoli.filter((o) => dinoScatole(o, terra).some(tocca));
  if (!urtati.length) return;
  const potere = dino.potere && dino.potere.tipo;
  // l'icona di Windows non uccide: sparisce e ti apre le finestre. Godzilla,
  // la stella e lo scudo la spaccano come un ostacolo qualunque
  if (potere !== "scaglia" && potere !== "stella" && potere !== "cuffie" && urtati.some((o) => o.tipo === "virus")) {
    dino.ostacoli = dino.ostacoli.filter((o) => o.tipo !== "virus" || !urtati.includes(o));
    urtati = urtati.filter((o) => o.tipo !== "virus");
    dinoInfetta();
    if (!urtati.length) return;
  }
  if (potere === "scaglia" || potere === "stella") {
    // Godzilla e la stella spaccano tutto quello che toccano
    urtati.forEach((o) => dinoDistruggi(o));
    if (potere === "scaglia") dino.scossa = 160;
  } else if (potere === "cuffie") {
    // la bolla para il colpo: l'ostacolo va in pezzi, la bolla pure e per
    // un attimo non si muore
    urtati.forEach((o) => dinoDistruggi(o));
    dinoScudoRotto();
  } else if (dino.corsa >= dino.grazia && !(dino.drop && dino.corsa - dino.drop.inizio < DROP_SALITA + 150)) {
    // (mentre sale il drop non si muore: si aspetta la botta)
    dinoSchianto(urtati[0]);
  }
}

// —— LE FINESTRE DI WINDOWS (rifatto il 08/10; Vitto: «deve essere anche lui
// un item malefico: il simbolo di errore lo prendi e spawna una schermata;
// quando l'utente prova a cliccare la x ne spawna un'altra, sempre con il
// rumore»). Toccando l'icona si apre la finestra d'errore, sulla strada
// davanti (mai sul dinosauro). La × o OK la chiudono, ma ne spunta subito
// un'altra altrove, col suono e un messaggio sempre più assurdo, per
// VIRUS_RINASCE volte; poi la chiusura vale. Dopo VIRUS_DURA spariscono da
// sole. Il resto della finestra è trasparente ai tocchi: si salta lo
// stesso. Il drop della boombox le spazza via. ——
function dinoInfetta() {
  dino.virus = { inizio: dino.corsa, fino: dino.corsa + VIRUS_DURA, chiusure: 0, prossimo: 1, finestre: [] };
  dinoNuovaFinestra();
}

/** Una finestra nuova, a caso nella strada davanti (px del banner). */
function dinoNuovaFinestra() {
  const v = dino.virus;
  const cab = document.getElementById("offlineCabinato");
  const largo = cab ? cab.clientWidth : dino.w * DINO_SCALA;
  const alto = cab ? cab.clientHeight : dino.h * DINO_SCALA;
  const xMin = Math.round((dinoX() + DINO_W + 6) * DINO_SCALA);
  const xMax = Math.max(xMin, largo - 176 - 6);
  // mai uguale alla precedente: deve sembrare che scappi
  const prima = v.finestre[v.finestre.length - 1];
  let x;
  let y;
  let giri = 0;
  do {
    x = Math.round(xMin + Math.random() * (xMax - xMin));
    // sotto scritta e punteggio: sulla strada, dove nasconde gli ostacoli
    y = Math.round(40 + Math.random() * Math.max(0, alto - 132));
  } while (prima && Math.abs(x - prima.x) < 40 && Math.abs(y - prima.y) < 24 && ++giri < 12);
  v.finestre.push({ id: v.prossimo++, x, y, testo: Math.min(VIRUS_TESTI.length - 1, v.chiusure) });
  dinoSuono("errore");
  dinoVibra("LIGHT");
}

/** Provi a chiuderla (× o OK): se ne apre un'altra, finché ne ha voglia. */
function dinoChiudiFinestra(id) {
  const v = dino.virus;
  if (!v || dino.stato !== "corsa") return;
  v.finestre = v.finestre.filter((f) => f.id !== id);
  v.chiusure++;
  if (v.chiusure <= VIRUS_RINASCE) dinoNuovaFinestra();
  else if (!v.finestre.length) dino.virus = null;
}

/** Morto contro `o`. La causa va nella schermata di fine; se c'erano le
 * finestre di Windows XP aperte, la colpa è loro. Una mina esplode davvero. */
function dinoSchianto(o) {
  // DEBUG boss: da togliere (il trucco «Immortale» del pannello Debug)
  if (_dinoDebugImmortale) {
    dinoDebugScampato(o);
    return;
  }
  // /DEBUG boss
  const mina = o && (o.tipo === "mina" || o.tipo === "paracadute");
  if (o && o.tipo === "boss") dino.causa = "Battuto dal boss";
  else if (dino.virus) dino.causa = "Colpa di Windows XP";
  else if (mina) dino.causa = "Boom! Era una mina";
  else if (o && o.tipo === "fantasma") dino.causa = "Preso da un fantasmino";
  else dino.causa = "Schiantato su un mixer";
  if (mina) {
    dinoEsplodi(o, ["#ff3b3b", "#ff8a2a", "#6b6b75", "#ffd23f"], 22);
    dino.ostacoli = dino.ostacoli.filter((x) => x !== o);
    dino.scossa = 260;
    dinoSuono("scoppio");
  }
  dino.stato = "fine";
  dino.boss = null; // morto mentre il boss aspettava (attesa, sgombro)
  dino.fineAlle = performance.now();
  const p = Math.floor(dino.punti);
  // festa solo se batti un record che c'era: la prima partita no
  dino.nuovoRecord = dino.record > 0 && p > dino.record;
  if (p > dino.record) {
    dino.record = p;
    try {
      localStorage.setItem(dinoModo().record, String(p));
    } catch (_) {}
  }
  if (navigator.vibrate) navigator.vibrate(30);
  dinoSuono("schianto");
  if (dino.nuovoRecord) dinoSuono("record");
  dinoSuonoRiposa(1600); // finiti i suoni, l'audio si spegne
}

/** Il rettangolo d'urto del dinosauro, un po' più stretto del disegno come
 * in Chrome. Godzilla è grande il doppio, il mini (pozione) molto più
 * piccolo; con lo scudo gli ostacoli toccano prima la bolla attorno a lui
 * (davanti; sopra no, i fantasmini alti passano senza romperla). */
function dinoScatolaDino(terra) {
  const p = dino.potere && dino.potere.tipo;
  if (p === "scaglia") {
    // il corpo, braccia e testa (la coda e la cresta dietro non contano)
    const g = GODZILLA_SCALA;
    return { x: dinoX() + 16 * g, y: terra - dino.y - (GODZILLA_H - 6) * g, w: 30 * g, h: (GODZILLA_H - 8) * g };
  }
  if (p === "pozione") {
    // mini: 18 x 16, un po' più stretto del disegno anche lui
    return { x: dinoX() + 6 + 3, y: terra - dino.y - 16 + 3, w: 12, h: 12 };
  }
  const d = { x: dinoX() + 5, y: terra - dino.y - DINO_H + 6, w: DINO_W - 10, h: DINO_H - 8 };
  if (p === "cuffie") d.w += 12; // fino al bordo davanti della bolla
  return d;
}

/** Tocca a un oggetto? Se sì lo piazza (RADURA o SOPRA, vedi
 * OGGETTO_PRIMA) e dice true; true anche mentre aspetta il tratto libero
 * davanti, così intanto non parte nient'altro. Quale: a caso coi pesi di
 * OGGETTI. Mai con un potere in corso, le finestre di Windows aperte (lo
 * coprirebbero), il drop che spazza o un boss in arrivo. */
function dinoNuovoOggetto() {
  const m = dinoModo();
  if (!m.oggetti || dino.oggetto || dino.potere || dino.virus || dino.drop || dino.boss || dino.corsa <= dino.prossimoOggetto) return false;
  const pxms = ((dino.velocita - 0.5) * DINO_K) / DINO_FOTOGRAMMA; // px di strada a ms
  const coda = dino.coda;
  if (coda && coda.x + coda.w + OGGETTO_PRIMA * pxms >= dino.w) return true;
  let caso = Math.random();
  let tipo = "cuffie";
  for (const [nome, def] of Object.entries(OGGETTI)) {
    if (caso < def.peso) {
      tipo = nome;
      break;
    }
    caso -= def.peso;
  }
  const sprite = OGGETTI[tipo].sprite;
  const cella = OGGETTI[tipo].cella || DINO_CELLA;
  const w = sprite[0].length * cella;
  const h = sprite.length * cella;
  let it;
  if (Math.random() < 0.5) {
    // SOPRA: un mixer piccolo o una mina, da solo, con l'oggetto centrato
    // sopra e il tratto libero dopo
    const o = dinoNuovoOstacolo({ soli: ["piccolo", "mina"], uno: true });
    o.distacco = dino.coda.distacco = Math.max(o.distacco, OGGETTO_DOPO * pxms);
    it = { tipo, x: o.x + o.w / 2 - w / 2, w, h, sopra: Math.min(OGGETTO_SOPRA, Math.max(OGGETTO_RADURA, o.h + 22)) };
  } else {
    // RADURA: da solo, e la coda è lui
    it = { tipo, x: dino.w + 10, w, h, sopra: OGGETTO_RADURA };
    dino.coda = { x: it.x, w, distacco: OGGETTO_DOPO * pxms, scarto: 0 };
  }
  dino.oggetto = it;
  dino.prossimoOggetto = dino.corsa + dinoTra(m.oggetti[1]);
  return true;
}

/** Preso: parte il potere, col suo nome a centro scena. */
function dinoPrendi(it) {
  const def = OGGETTI[it.tipo];
  dino.oggetto = null;
  dino.annuncio = { testo: def.nome, sotto: def.sotto, colore: def.colore, inizio: dino.corsa, fino: dino.corsa + ANNUNCIO_DURA };
  if (it.tipo === "basso") {
    // il drop: prima sale (DROP_SALITA), poi la botta (dinoDropPasso)
    dino.drop = { inizio: dino.corsa, cx: dinoX() + DINO_W / 2, cy: dinoTerra() - dino.y - DINO_H / 2, fronte: 0, colpiti: 0, battiti: 0, botto: false };
    dinoSuono("drop");
    return;
  }
  dino.potere = { tipo: it.tipo, fine: dino.corsa + def.durata, durata: def.durata };
  if (it.tipo === "pozione") {
    if (dino.y > 0) dino.vy *= MINI_RADICE;
    dinoSbuffo("#d14bff");
    dinoSuono("pozione");
  } else if (it.tipo === "scaglia") {
    // diventa Godzilla a scatti, fra scintille radioattive
    dino.muta = { verso: 1, inizio: dino.corsa, botto: false };
    dino.carica = null;
    dino.soffio = null;
    dinoScintille();
    dinoSuono("trasforma");
  } else {
    dinoSuono("oggetto");
  }
}

/** Sbuffo di bollicine attorno al dinosauro (quando si rimpicciolisce e
 * quando torna grande). */
function dinoSbuffo(colore) {
  const terra = dinoTerra();
  for (let i = 0; i < 16; i++) {
    dino.particelle.push({
      x: dinoX() + Math.random() * DINO_W,
      y: terra - dino.y - Math.random() * DINO_H,
      vx: (Math.random() - 0.5) * 0.12,
      vy: 0.05 + Math.random() * 0.12,
      vita: 0,
      durata: 500,
      colore: Math.random() < 0.5 ? colore : "#f5c6ff",
    });
  }
}

/** Schegge che volano via da un ostacolo, nei colori dati. */
// —— IL DROP DELLA BOOMBOX (rifatto il 08/10: Vitto «bello il drop ma non mi
// fa impazzire il nome; graficamente troppo banali l'item e l'effetto»).
// Prima sale (DROP_SALITA: rullante che accelera, la scena si scurisce e un
// anello si stringe sul dinosauro, che intanto non muore), poi la botta:
// un'onda sonora disegnata come un oscilloscopio (anima bianca, bordi
// magenta e ciano sfasati) corre verso destra e lancia in aria tutto quello
// che prende, che gira su sé stesso ed esplode (punti in combo, come il
// soffio di Godzilla); dietro di lei la strada diventa un equalizzatore che
// pompa a tempo con altri due colpi di cassa (DROP_BATTITO), e dal
// dinosauro esplode un ventaglio di notine. ——
const DROP_SALITA = 350; // ms dal tocco alla botta
const DROP_VEL = 0.42; // unità al ms dell'onda
const DROP_BATTITO = 250; // ms fra un colpo di cassa e l'altro
const DROP_DURA = 1500; // ms in tutto

function dinoDropPasso(dt) {
  const d = dino.drop;
  // gli ostacoli lanciati: salgono girando, poi esplodono
  dino.lanciati.forEach((l) => {
    l.vita += dt;
    l.dx += l.vx * dt;
    l.dy += l.vy * dt;
    l.vy -= 0.0007 * dt;
    l.giro += l.vg * dt;
  });
  dino.lanciati = dino.lanciati.filter((l) => {
    if (l.vita < 480) return true;
    const o = { ...l.o, x: l.o.x + l.dx, sopra: l.o.sopra + l.dy };
    dinoEsplodi(o, o.tipo === "mixer" ? EQ_GRADINI : o.tipo === "fantasma" ? [FANTASMA_ARANCIO, "#f4f4f5", "#ff5fd2"] : ["#ff3b3b", "#ff8a2a", "#6b6b75", "#ff5fd2"], 14);
    dinoSuono("scoppio");
    return false;
  });
  dino.noteDrop.forEach((n) => {
    n.vita += dt;
    n.x += n.vx * dt;
    n.y += n.vy * dt;
    n.vy += 0.0004 * dt;
  });
  dino.noteDrop = dino.noteDrop.filter((n) => n.vita < 800);
  if (!d) return;
  const k = dino.corsa - d.inizio;
  if (k > DROP_DURA) {
    dino.drop = null;
    return;
  }
  if (k < DROP_SALITA) return;
  if (!d.botto) {
    d.botto = true;
    dino.scossa = 320;
    dinoVibra("HEAVY");
    for (let i = 0; i < 9; i++) {
      const a = -Math.PI * 0.85 + (Math.PI * 1.2 * i) / 8;
      const v = 0.12 + Math.random() * 0.06;
      dino.noteDrop.push({ x: d.cx, y: d.cy, vx: Math.cos(a) * v, vy: Math.sin(a) * v, tipo: i % 2, vita: 0 });
    }
  }
  const battito = Math.floor((k - DROP_SALITA) / DROP_BATTITO);
  if (battito > d.battiti && battito <= 2) {
    d.battiti = battito;
    dino.scossa = Math.max(dino.scossa, 140);
    dinoVibra("MEDIUM");
  }
  d.fronte = d.cx + (k - DROP_SALITA) * DROP_VEL;
  // chiude anche la finestra di Windows, se ci passa sopra
  if (dino.virus) {
    dino.virus.finestre = dino.virus.finestre.filter((f) => f.x / DINO_SCALA > d.fronte);
    if (!dino.virus.finestre.length) dino.virus = null;
  }
  // fuori dal bordo l'onda non prende più niente (gli ostacoli nuovi
  // nascono lì)
  if (d.fronte > dino.w + 12) return;
  dino.ostacoli
    .filter((o) => o.x < d.fronte && o.x + o.w > d.cx - 10)
    .forEach((o) => {
      d.colpiti++;
      dinoLancia(o, 10 * d.colpiti);
    });
}

/** Il drop prende un ostacolo: punti subito, e lo spara in aria girando
 * (esplode dopo, in dinoDropPasso). */
function dinoLancia(o, punti) {
  const terra = dinoTerra();
  dino.ostacoli = dino.ostacoli.filter((x) => x !== o);
  dino.lanciati.push({ o, vx: 0.05 + Math.random() * 0.05, vy: 0.16 + Math.random() * 0.08, giro: 0, vg: (Math.random() < 0.5 ? -1 : 1) * (0.008 + Math.random() * 0.008), dx: 0, dy: 0, vita: 0 });
  const centinaia = Math.floor(dino.punti / 100);
  dino.punti += punti;
  if (Math.floor(dino.punti / 100) > centinaia) {
    dinoSuono("cento");
    dino.cento = dino.corsa; // il punteggio lampeggia (dinoPunteggio)
  }
  dino.scritte.push({ x: o.x + o.w / 2, y: terra - o.sopra - o.h - 8, vita: 0, testo: `+${punti}` });
}

function dinoEsplodi(o, colori, quante) {
  const terra = dinoTerra();
  for (let i = 0; i < quante; i++) {
    dino.particelle.push({
      x: o.x + Math.random() * o.w,
      y: terra - o.sopra - Math.random() * o.h,
      vx: (Math.random() - 0.2) * 0.2,
      vy: 0.1 + Math.random() * 0.2,
      vita: 0,
      durata: 650,
      colore: colori[Math.floor(Math.random() * colori.length)],
    });
  }
}

/** La mina col paracadute tocca terra: il paracadute si affloscia in uno
 * sbuffo e resta la mina. */
function dinoAtterra(o) {
  const terra = dinoTerra();
  for (let i = 0; i < 10; i++) {
    dino.particelle.push({
      x: o.x - 4 + Math.random() * (o.w + 8),
      y: terra - o.h - 14 - Math.random() * 10,
      vx: (Math.random() - 0.5) * 0.08,
      vy: Math.random() * 0.05,
      vita: 0,
      durata: 450,
      colore: Math.random() < 0.6 ? "#ff8a2a" : "#ffd8b0",
    });
  }
}

/** Un ostacolo spaccato (Godzilla, stella, scudo, soffio): schegge dei suoi
 * colori, +10 punti che salgono, botto. */
function dinoDistruggi(o, punti = 10) {
  const terra = dinoTerra();
  dino.ostacoli = dino.ostacoli.filter((x) => x !== o);
  const colori =
    o.tipo === "mixer"
      ? EQ_GRADINI
      : o.tipo === "fantasma"
        ? [FANTASMA_ARANCIO, "#f4f4f5", "#c9c9ce"]
        : ["#ff3b3b", "#ff8a2a", "#6b6b75", "#c9c9ce"];
  dinoEsplodi(o, colori, o.tipo === "mixer" || o.tipo === "fantasma" ? 12 : 18);
  const centinaia = Math.floor(dino.punti / 100);
  dino.punti += punti;
  if (Math.floor(dino.punti / 100) > centinaia) {
    dinoSuono("cento");
    dino.cento = dino.corsa; // il punteggio lampeggia (dinoPunteggio)
  }
  dino.scritte.push({ x: o.x + o.w / 2, y: terra - o.sopra - o.h - 8, vita: 0, testo: `+${punti}` });
  dinoSuono("scoppio");
}

/** Il fascio di luce ha parato un colpo: si spegne in una pioggia di luce. */
function dinoScudoRotto() {
  // schegge da tutto il bordo della bolla, verso fuori, e un anello di luce
  // che si allarga (dinoDisegna)
  const { cx, cy, rx, ry } = dinoBolla();
  for (let i = 0; i < 26; i++) {
    const a = (i / 26) * Math.PI * 2 + Math.random() * 0.2;
    if (cy + Math.sin(a) * ry > dinoTerra()) continue; // sotto terra no
    const v = 0.06 + Math.random() * 0.12;
    dino.particelle.push({
      x: cx + Math.cos(a) * rx,
      y: cy + Math.sin(a) * ry,
      vx: Math.cos(a) * v,
      vy: -Math.sin(a) * v + 0.04,
      vita: 0,
      durata: 450 + Math.random() * 200,
      colore: Math.random() < 0.6 ? "#4fb0ff" : "#e6f6ff",
    });
  }
  dino.lampo = { cx, cy, inizio: dino.corsa };
  dino.potere = null;
  dino.grazia = dino.corsa + 700;
  dinoSuono("scudo");
}

/** La bolla dello scudo attorno al dinosauro: un'ellisse un po' più larga
 * che alta, centrata sul corpo, che finisce poco sotto i piedi (lì la taglia
 * la terra: da fermo è una cupola, in salto una bolla intera). */
function dinoBolla() {
  const terra = dinoTerra();
  return { cx: dinoX() + 14, cy: Math.round(terra - dino.y - 13), rx: 20, ry: 17 };
}

// —— IL SOFFIO ATOMICO di Godzilla (rifatto il 08/10; Vitto: «non mi
// convince ancora il beam, cosa faresti te per renderlo più integrato col
// gioco e l'esperienza del click»). Prima era un raggio tenuto premuto; ora
// è il gesto dei film: tieni premuto e la cresta si accende dalla coda alla
// testa (6 tacche, ognuna col suo bip che sale e una vibrazione leggera; a
// carica piena la bocca si apre e brilla), lasci e parte il soffio. Parte
// sulla strada appena davanti e spazza in avanti fino all'orizzonte in ~0,5
// s: brucia la strada dove passa (dino.bruciature) e spacca tutto quello che
// tocca, in combo (+10, +20, +30... nello stesso soffio). Lasciato a metà è
// più corto e spazza meno; sotto un terzo di carica sbuffa solo fumo. ——
const SOFFIO_CARICA = 700; // ms per la carica piena
const SOFFIO_MINIMO = 0.35; // sotto, lasciando, sfiata
const SOFFIO_SPAZZA = 520; // ms dalla strada all'orizzonte, a carica piena
const SOFFIO_CODA = 200; // ms in fondo, fermo all'orizzonte, mentre si spegne

/** Vibrazione (plugin Haptics dell'app; nel browser niente). */
function dinoVibra(forza) {
  try {
    const H = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Haptics;
    if (H && H.impact) H.impact({ style: forza });
  } catch (_) {}
}

/** Dito su (o tasto): se Godzilla stava caricando, spara o sfiata. */
function dinoLascia() {
  const k = dino.carica;
  if (!k) return;
  dino.carica = null;
  const forza = Math.min(1, (dino.corsa - k.inizio) / SOFFIO_CARICA);
  if (forza < SOFFIO_MINIMO) dinoSfiata();
  else dinoSoffia(forza);
}

/** La carica: tacche dalla coda alla testa, ognuna col suo bip e un colpetto. */
function dinoCaricaPasso() {
  const k = dino.carica;
  if (!k) return;
  if (!dino.potere || dino.potere.tipo !== "scaglia" || dino.soffio) {
    dino.carica = null;
    return;
  }
  if (!dino.tieni) {
    dinoLascia(); // il dito si è perso per strada: vale come lasciare
    return;
  }
  const tacche = Math.floor(Math.min(1, (dino.corsa - k.inizio) / SOFFIO_CARICA) * 6);
  if (tacche > k.tacche) {
    k.tacche = tacche;
    dinoSuono(`carica${tacche}`);
    dinoVibra(tacche === 6 ? "MEDIUM" : "LIGHT");
  }
}

function dinoSoffia(forza) {
  const b = dinoBocca();
  const terra = dinoTerra();
  // da poco davanti ai piedi fino all'orizzonte (a metà carica, meno)
  const a0 = Math.atan2(terra - b.y, 30);
  const a1 = a0 + (-0.06 - a0) * forza;
  const spazza = SOFFIO_SPAZZA * (0.55 + 0.45 * forza);
  dino.soffio = { inizio: dino.corsa, forza, a0, a1, spazza, dura: spazza + SOFFIO_CODA, angolo: a0, x2: b.x, y2: b.y, colpiti: 0, scintille: 0, aTerra: false };
  dino.scossa = Math.max(dino.scossa, 220);
  dinoSuono("soffio");
  dinoVibra("HEAVY");
}

/** Lasciato troppo presto: un filo di fumo dalla bocca. */
function dinoSfiata() {
  const b = dinoBocca();
  for (let i = 0; i < 8; i++) {
    dino.particelle.push({
      x: b.x,
      y: b.y,
      vx: 0.02 + Math.random() * 0.06,
      vy: 0.03 + Math.random() * 0.05,
      vita: 0,
      durata: 380,
      colore: Math.random() < 0.6 ? "rgba(210, 205, 200, 0.6)" : "#7fe3ff",
    });
  }
  dinoSuono("sfiata");
}

/** Dove parte il soffio: la bocca aperta di Godzilla. */
function dinoBocca() {
  const g = GODZILLA_SCALA;
  return { x: dinoX() + GODZILLA_BOCCA[0] * g, y: dinoTerra() - dino.y - (GODZILLA_H - GODZILLA_BOCCA[1]) * g };
}

function dinoSoffioPasso(dt) {
  const s = dino.soffio;
  if (!s) return;
  const k = dino.corsa - s.inizio;
  if (!dino.potere || dino.potere.tipo !== "scaglia" || k >= s.dura) {
    dino.soffio = null;
    return;
  }
  // spazza in avanti rallentando verso la fine (ease-out)
  const p = Math.min(1, k / s.spazza);
  s.angolo = s.a0 + (s.a1 - s.a0) * (1 - Math.pow(1 - p, 3));
  const terra = dinoTerra();
  const b = dinoBocca();
  const scatole = dino.ostacoli.map((o) => [o, dinoScatole(o, terra)]);
  const cos = Math.cos(s.angolo);
  const sin = Math.sin(s.angolo);
  // nei primi 60 ms il soffio esce dalla bocca e si allunga
  const lungo = Math.min(700, 20 + k * 8);
  let x = b.x;
  let y = b.y;
  let colpito = null;
  for (let l = 0; l < lungo && !colpito; l += 2) {
    x = b.x + cos * l;
    y = b.y + sin * l;
    if (x > dino.w + 8 || y >= terra) break;
    const su = scatole.find(([, qs]) => qs.some((q) => x >= q.x && x <= q.x + q.w && y >= q.y && y <= q.y + q.h));
    if (su) colpito = su[0];
  }
  s.x2 = x;
  s.y2 = Math.min(y, terra);
  s.aTerra = y >= terra;
  if (colpito) {
    s.colpiti++;
    dinoDistruggi(colpito, 10 * s.colpiti);
    dinoVibra("MEDIUM");
  }
  // la strada brucia dove picchia
  if (s.aTerra) {
    const ultima = dino.bruciature[dino.bruciature.length - 1];
    if (!ultima || Math.abs(ultima.x - s.x2) >= 2) dino.bruciature.push({ x: Math.round(s.x2), vita: 0 });
  }
  if (dino.corsa >= s.scintille) {
    s.scintille = dino.corsa + 30;
    for (let i = 0; i < 3; i++) {
      dino.particelle.push({
        x: s.x2,
        y: s.y2 - 1,
        vx: -0.06 + Math.random() * 0.14,
        vy: 0.05 + Math.random() * 0.14,
        vita: 0,
        durata: 260 + Math.random() * 200,
        colore: s.aTerra && i === 0 ? "#ff8a2a" : Math.random() < 0.5 ? "#7fe3ff" : "#e6fbff",
      });
    }
  }
  if (k < s.spazza) dino.scossa = Math.max(dino.scossa, 60);
}

/** La trasformazione: quando Godzilla arriva grande del tutto la terra
 * trema e i piedi alzano polvere; finiti i passi, finita la trasformazione. */
function dinoMutaPasso() {
  const m = dino.muta;
  if (!m) return;
  const k = dino.corsa - m.inizio;
  if (m.verso > 0 && !m.botto && k >= 5 * MUTA_PASSO) {
    m.botto = true;
    dino.scossa = 280;
    const terra = dinoTerra();
    for (let i = 0; i < 12; i++) {
      dino.particelle.push({
        x: dinoX() + 14 + Math.random() * 26,
        y: terra - 2,
        vx: (Math.random() - 0.5) * 0.16,
        vy: 0.03 + Math.random() * 0.08,
        vita: 0,
        durata: 420,
        colore: Math.random() < 0.5 ? "rgba(255, 214, 180, 0.7)" : "#ff8a2a",
      });
    }
  }
  if (k >= MUTA_CRESCE.length * MUTA_PASSO) dino.muta = null;
}

/** La fase della trasformazione da disegnare: { scala } di Godzilla (0 = il
 * dinosauro) e { bianco } a passi alterni, il lampo. Null se non c'è. */
function dinoMutaFase() {
  const m = dino.muta;
  if (!m || dino.stato === "fine") return null;
  const seq = m.verso > 0 ? MUTA_CRESCE : MUTA_TORNA;
  const k = Math.floor((dino.corsa - m.inizio) / MUTA_PASSO);
  if (k < 0 || k >= seq.length) return null;
  return { scala: seq[k], bianco: k % 2 === 1 && seq[k] > 0 };
}

/** Scintille radioattive attorno al dinosauro che diventa Godzilla. */
function dinoScintille() {
  const terra = dinoTerra();
  for (let i = 0; i < 22; i++) {
    const a = Math.random() * Math.PI * 2;
    const v = 0.05 + Math.random() * 0.12;
    dino.particelle.push({
      x: dinoX() + 14 + Math.cos(a) * 10,
      y: terra - dino.y - 16 + Math.sin(a) * 10,
      vx: Math.cos(a) * v,
      vy: -Math.sin(a) * v + 0.03,
      vita: 0,
      durata: 500,
      colore: Math.random() < 0.5 ? "#7dff4a" : Math.random() < 0.5 ? "#d6ffb0" : "#ff8a2a",
    });
  }
}

/** Sbuffo di fumo quando Godzilla torna dinosauro. */
function dinoFumo() {
  const terra = dinoTerra();
  for (let i = 0; i < 20; i++) {
    dino.particelle.push({
      x: dinoX() + 8 + Math.random() * 38,
      y: terra - dino.y - Math.random() * 46,
      vx: (Math.random() - 0.5) * 0.1,
      vy: 0.03 + Math.random() * 0.07,
      vita: 0,
      durata: 520,
      colore: Math.random() < 0.6 ? "rgba(210, 200, 195, 0.6)" : "#ff8a2a",
    });
  }
}

/** Rettangoli d'urto di un ostacolo, un po' più stretti del disegno. Il
 * mixer ne ha uno per canale (come i cactus di Chrome): accanto a un canale
 * alto, il vuoto sopra uno basso non ti prende. Il fantasmino: corpo e
 * fascia delle cuffie. */
function dinoScatole(o, terra) {
  const cl = DINO_CELLA;
  if (o.tipo === "mixer" && o.cristallo) {
    // il cristallo: il corpo fino alle spalle e la punta stretta (gli
    // angoli vuoti accanto alla punta non prendono); le schegge di lato
    // sono solo decorazione
    return o.canali.flatMap((h, i) => {
      const x = o.x + cl + i * (o.lc + cl);
      const t = o.inclina ? o.inclina[i] : 0;
      return [
        { x: x + 2, y: terra - h + 8, w: o.lc - 4, h: h - 8 },
        { x: x + 4 + t, y: terra - h + 2, w: 4, h: 8 },
      ];
    });
  }
  if (o.tipo === "mixer") {
    return o.canali.map((h, i) => ({ x: o.x + cl + i * (o.lc + cl) + 1, y: terra - h + 2, w: o.lc - 2, h: h - 2 }));
  }
  if (o.tipo === "virus") {
    return [{ x: o.x + 2, y: terra - o.sopra - o.h + 2, w: o.w - 4, h: o.h - 4 }];
  }
  if (o.tipo === "mina") {
    // la cupola (la lucina in cima non conta)
    return [{ x: o.x + 2, y: terra - o.h + cl + 1, w: o.w - 4, h: o.h - cl - 1 }];
  }
  if (o.tipo === "paracadute") {
    // la palla, spine escluse (il paracadute sopra non conta)
    return [{ x: o.x + cl + 1, y: terra - o.sopra - o.h + cl + 1, w: o.w - 2 * cl - 2, h: o.h - 2 * cl - 2 }];
  }
  const y = terra - o.sopra - o.h;
  return [
    { x: o.x + 2 * cl + 1, y: y + cl + 1, w: 9 * cl - 2, h: 13 * cl - 2 },
    { x: o.x + 2, y: y + 4 * cl + 1, w: o.w - 4, h: 3 * cl - 2 },
  ];
}

/** Un ostacolo nuovo al bordo destro, scelto come in Chrome: a caso fra i
 * tipi ammessi adesso (fantasmini solo da velocità 8,5, e mai un tipo per la
 * terza volta di fila), in gruppi da 1 a 3 dove il tipo lo permette, col
 * distacco = larghezza × velocità + minimo × 0,6, poi a caso fino a ×1,5. */
function dinoNuovoOstacolo(opz = {}) {
  // ogni tanto (DINO_MODI) al posto di un ostacolo l'icona di Windows, a
  // distanza da fantasmino (va saltata come lui); non con un oggetto in giro
  const modo = dinoModo();
  if (!opz.soli && modo.errore && dino.corsa > dino.prossimoErrore && !dino.virus && !dino.oggetto && !dino.boss && !dino.ostacoli.some((o) => o.tipo === "virus")) {
    dino.prossimoErrore = dino.corsa + dinoTra(modo.errore[1]);
    const minimo = Math.round(18 * dino.velocita + 150 * 0.6);
    const distacco = (minimo + Math.random() * minimo * 0.5) * DINO_K;
    dino.storia = ["virus", dino.storia[0]];
    const v = { tipo: "virus", x: dino.w + 10, w: VIRUS_SPRITE[0].length, h: VIRUS_SPRITE.length, sopra: VIRUS_SOPRA, fase: Math.random() * 6.28, distacco };
    dino.ostacoli.push(v);
    dino.coda = { x: v.x, w: v.w, distacco, scarto: 0 };
    return v;
  }
  const esce = (n) => {
    const t = dinoTipo(n);
    return !!t && dino.velocita >= t.da;
  };
  let ammessi = Object.keys(DINO_TIPI).filter((n) => esce(n) && !(dino.storia[0] === n && dino.storia[1] === n));
  if (opz.soli) {
    // l'ostacolo sotto un oggetto: solo quelli; se la storia li esclude
    // tutti, uno di loro comunque (il mixer piccolo c'è sempre)
    const soli = ammessi.filter((n) => opz.soli.includes(n));
    ammessi = soli.length ? soli : opz.soli.filter(esce);
  }
  let caso = Math.random() * ammessi.reduce((somma, n) => somma + dinoTipo(n).peso, 0);
  let tipo = ammessi[ammessi.length - 1];
  for (const n of ammessi) {
    caso -= dinoTipo(n).peso;
    if (caso < 0) {
      tipo = n;
      break;
    }
  }
  const t = dinoTipo(tipo);
  dino.storia = [tipo, dino.storia[0]];
  let n = 1 + Math.floor(Math.random() * 3);
  if ((n > 1 && t.gruppi > dino.velocita) || opz.uno) n = 1;
  const minimo = Math.round(t.largo * n * dino.velocita + t.distacco * 0.6);
  const distacco = (minimo + Math.random() * minimo * 0.5) * DINO_K;
  let o;
  if (tipo === "mina") {
    o = { tipo: "mina", x: dino.w + 10, w: MINA_SPRITE[0].length, h: MINA_SPRITE.length, sopra: 0, distacco };
  } else if (tipo === "paracadute") {
    // parte a 46 unità da terra e scende in linea retta fino a toccarla fra
    // il 40 e il 65% del riquadro: da lì è una mina da saltare. In aria non
    // arriva mai al dinosauro, è solo spettacolo
    const quota = 46;
    const tocca = dino.w * (0.4 + Math.random() * 0.25);
    o = {
      tipo: "paracadute",
      x: dino.w + 10,
      w: 9 * DINO_CELLA,
      h: 9 * DINO_CELLA,
      sopra: quota,
      discesa: quota / (dino.w + 10 - tocca),
      distacco,
    };
  } else if (tipo === "fantasma") {
    const w = FANTASMA_TESTA[0].length * DINO_CELLA;
    const h = (FANTASMA_TESTA.length + FANTASMA_GONNA[0].length) * DINO_CELLA;
    // basso: si salta; alto: passa sopra la testa se resti a terra e ti
    // prende se salti. Solo queste due, come lo pterodattilo di Chrome sul
    // telefono. L'alto sta a DINO_H + 14: a DINO_H + 4 col salto più alto
    // (picco ~58 unità, di più coi fotogrammi lenti) gli si passava sopra
    // (Vitto 08/10: «si possono saltare i fantasmini alti»)
    const sopra = Math.random() < 0.5 ? DINO_H + 14 : 4;
    const scarto = Math.random() < 0.5 ? t.scarto : -t.scarto;
    o = { tipo: "fantasma", x: dino.w + 10, w, h, sopra, fase: Math.floor(Math.random() * 2), scarto, distacco };
  } else {
    // mixer piccolo o grande da n canali (i cactus piccoli e grandi)
    const m = tipo === "grande" ? MIXER_GRANDE : MIXER_PICCOLO;
    const canali = [];
    for (let i = 0; i < n; i++) {
      // altezze a celle intere (a metà cella il pixel art si sfoca), e mai
      // due canali vicini alla pari: il gruppo deve leggersi come un mixer
      let a;
      do a = m.min + Math.floor(Math.random() * (m.max - m.min + 1));
      while (a * DINO_CELLA === canali[i - 1]);
      canali.push(a * DINO_CELLA);
    }
    const lc = m.canale * DINO_CELLA;
    // canali, una cella fra l'uno e l'altro e la base che sporge di una per lato
    const w = n * lc + (n + 1) * DINO_CELLA;
    o = { tipo: "mixer", x: dino.w + 10, w, h: Math.max(...canali), sopra: 0, canali, lc, distacco };
    // i grandi sono cristalli arancioni (dinoCristalli), ognuno inclinato a modo suo
    if (tipo === "grande") {
      o.cristallo = true;
      o.inclina = canali.map(() => Math.floor(Math.random() * 3) - 1);
    }
  }
  dino.ostacoli.push(o);
  dino.coda = { x: o.x, w: o.w, distacco, scarto: o.scarto || 0 };
  return o;
}

function dinoDisegna() {
  const c = dino.ctx;
  if (!c) return;
  const W = dino.w;
  const H = dino.h;
  const terra = dinoTerra();
  const t = dino.amb.tempo;
  c.clearRect(0, 0, W, H);
  dinoDom();
  // il minigioco del boss (o il nero della tendina) al posto del mondo
  if (dinoBossCopre()) {
    dinoBossScena(c, W, H);
    if (dino.stato === "pausa") {
      c.fillStyle = "rgba(8, 8, 12, 0.6)";
      c.fillRect(0, 0, W, H);
      dinoScrittePausa(c, W, terra);
    }
    return;
  }

  // atmosfera, sotto a tutto (il cielo al tramonto è lo sfondo CSS del
  // campo): stelle che brillano piano, ogni tanto una stella cadente, due
  // nuvole che passano e il sole dietro l'orizzonte. Lontani e spenti:
  // davanti ci passano gli ostacoli, che restano la cosa più chiara
  dino.amb.stelle.forEach((s) => {
    const v = Math.sin((t / s.periodo) * 6.283 + s.fase);
    c.fillStyle = `rgba(255, 236, 214, ${v > 0.55 ? 0.6 : v > -0.25 ? 0.28 : 0.1})`;
    c.fillRect(s.x, s.y, DINO_CELLA, DINO_CELLA);
  });
  const sc = dino.amb.cadente;
  if (sc) {
    // testa e scia di sette celle all'indietro e in su; sparisce negli
    // ultimi 270 ms
    const svanisce = sc.vita > 630 ? (900 - sc.vita) / 270 : 1;
    const hx = sc.x + sc.verso * sc.vita * 0.2;
    const hy = sc.y + sc.vita * 0.035;
    for (let i = 0; i < 7; i++) {
      c.fillStyle = `rgba(255, 240, 225, ${((1 - i / 7) * 0.85 * svanisce).toFixed(2)})`;
      c.fillRect(DINO_CELLA * Math.round((hx - sc.verso * i * 3) / DINO_CELLA), DINO_CELLA * Math.round((hy - i) / DINO_CELLA), DINO_CELLA, DINO_CELLA);
    }
  }
  dinoSole(c, Math.round(W * 0.78), terra, 30, t);
  // nuvole dopo il sole: al tramonto gli passano davanti
  dino.amb.nuvole.forEach((n) => {
    dinoPixel(c, NUVOLA_SPRITE, DINO_CELLA * Math.round(n.x / DINO_CELLA), n.y, { "#": "rgba(255, 140, 80, 0.14)" });
  });

  // il mondo trema quando Godzilla spacca o spara (le scritte no)
  c.save();
  if (dino.scossa > 0) {
    c.translate(DINO_CELLA * Math.round(Math.random() * 2 - 1), DINO_CELLA * Math.round(Math.random() * 2 - 1));
  }
  // il drop: a ogni colpo di cassa la scena fa un piccolo tuffo in giù
  if (dino.drop && dino.corsa - dino.drop.inizio >= DROP_SALITA && (dino.corsa - dino.drop.inizio - DROP_SALITA) % DROP_BATTITO < 70) {
    c.translate(0, DINO_CELLA);
  }

  // terreno: una riga sottile e sassolini che scorrono
  c.fillStyle = "rgba(255, 255, 255, 0.16)";
  c.fillRect(0, terra, W, 1);
  c.fillStyle = "rgba(255, 255, 255, 0.1)";
  dino.terreno.forEach((tr) => c.fillRect(Math.round(tr.x), terra + tr.y, tr.w, 1));

  // ostacoli
  const posa = Math.floor(dino.passo / 160) % 2; // ondeggio della gonna
  const lucina = Math.floor(dino.corsa / 400) % 2 === 0 ? "#ff3b3b" : "#6b1d1d"; // delle mine
  dino.ostacoli.forEach((o) => dinoDisegnaOstacolo(c, o, terra, posa, lucina));
  // il boss che arriva sulla strada e aspetta il dino
  dinoBossStrada(c, terra);
  // quelli lanciati dal drop: spostati e girati attorno al loro centro
  dino.lanciati.forEach((l) => {
    const cx = l.o.x + l.o.w / 2 + l.dx;
    const cy = terra - l.o.sopra - l.o.h / 2 - l.dy;
    c.save();
    c.translate(cx, cy);
    c.rotate(l.giro);
    c.translate(-(l.o.x + l.o.w / 2), -(terra - l.o.sopra - l.o.h / 2));
    dinoDisegnaOstacolo(c, l.o, terra, posa, lucina);
    c.restore();
  });

  // notine dalle cuffie: salgono ondeggiando e si spengono a scatti,
  // piegando appena a sinistra per restare nella colonna del dinosauro (più
  // a destra entravano nell'invito TOCCA PER GIOCARE)
  dino.amb.note.forEach((n) => {
    const k = n.vita / 2600;
    const x = dinoX() - n.vita * 0.006 + Math.sin(n.vita / 380 + n.fase) * 3;
    const y = terra - DINO_H - 8 - n.vita * 0.016;
    c.globalAlpha = k < 0.45 ? 0.9 : k < 0.75 ? 0.55 : 0.25;
    dinoPixel(c, NOTINA_SPRITE[n.tipo], DINO_CELLA * Math.round(x / DINO_CELLA), DINO_CELLA * Math.round(y / DINO_CELLA), {
      "#": "#ffb066",
    });
  });
  c.globalAlpha = 1;

  // dinosauro: zampe ferme in aria, alternate di corsa. Fermo ad ascoltare
  // tiene il tempo con la testa (il corpo scende di una cella a battiti
  // alterni, 100 bpm) e ogni tanto sbatte l'occhio. Coi poteri cambia:
  // Godzilla (sprite suo, la trasformazione a scatti in dinoMutaFase); la
  // stella coi colori che girano; le cuffie azzurre dentro la bolla dello
  // scudo. Nell'ultimo secondo e mezzo il potere lampeggia (Godzilla
  // sbiadisce a sprazzi, poi torna dinosauro a scatti); poi, finché dura la
  // grazia, il dinosauro sfarfalla.
  const potere = dino.potere;
  const finisce = potere && potere.fine - dino.corsa < 1500 && Math.floor(dino.corsa / 120) % 2 === 0;
  const forma = potere && (!finisce || potere.tipo === "scaglia") ? potere.tipo : null;
  const muta = dinoMutaFase();
  const sfarfalla = !potere && !muta && dino.corsa < dino.grazia && Math.floor(dino.corsa / 80) % 2 === 0;
  const x0 = dinoX();
  const y0 = Math.round(terra - dino.y - DINO_H);
  const corre = dino.stato === "corsa" && dino.y === 0;
  const ascolta = dino.stato === "riposo";
  const giu = ascolta && Math.floor(t / 300) % 2 === 1 ? 2 : 0;
  const sbatte = ascolta && t % 3700 < 150;
  if (dinoBossNascondeDino()) {
    // la gag del boss sulla strada disegna lei il dino (boss.js)
  } else if (muta ? muta.scala > 0 : forma === "scaglia") {
    dinoDisegnaGodzilla(c, { x0, terra, scala: muta ? muta.scala : 1, bianco: !!(muta && muta.bianco), sbiadito: !!(finisce && forma === "scaglia"), corre });
  } else if (forma !== "pozione") {
    dinoDisegnaDino(c, { x0, y0, forma: forma === "scaglia" ? null : forma, corre, giu, sbatte, sfarfalla });
  } else if (!sfarfalla) {
    // il mini-dinosauro col suo sprite, sei unità più avanti
    const colori = { "#": DINO_ARANCIO, h: "#f4f4f5", c: "#c9c9ce", e: dino.stato === "fine" ? "#f4f4f5" : "#141414" };
    const mz = MINI_ZAMPE[corre ? Math.floor(dino.passo / 90) % 2 : 0];
    const my = DINO_CELLA * Math.round((terra - dino.y - (MINI_SPRITE.length + 1) * DINO_CELLA) / DINO_CELLA);
    dinoPixel(c, MINI_SPRITE, x0 + 6, my, colori);
    dinoPixel(c, mz, x0 + 6, my + MINI_SPRITE.length * DINO_CELLA, colori);
  }
  if (forma === "jetpack" && !sfarfalla) dinoDisegnaJetpack(c, x0, y0);
  if (forma === "cuffie") {
    // lo scudo: bolla di energia blu attorno al dinosauro (Vitto 08/10: il
    // fascio di luce davanti «non sembra nemmeno uno scudo»). Si somma alla
    // luce del cielo (lighter), il riflesso gira lungo il bordo, pulsa piano;
    // sotto i piedi la taglia la terra
    const { cx, cy, rx, ry } = dinoBolla();
    const giro = Math.floor(dino.corsa / 70) % 16;
    c.save();
    c.beginPath();
    c.rect(0, 0, dino.w, terra + 1);
    c.clip();
    c.globalCompositeOperation = "lighter";
    c.globalAlpha = 0.85 + 0.15 * Math.sin(dino.corsa / 160);
    c.imageSmoothingEnabled = false;
    c.drawImage(dinoTelaBolla(rx, ry, giro), cx - rx - 3, cy - ry - 3);
    c.restore();
  }
  // la bolla che va in pezzi: anello che si allarga e sbiadisce in 260 ms
  const lampo = dino.lampo;
  if (lampo) {
    const k = (dino.corsa - lampo.inizio) / 260;
    if (k >= 1 || dino.stato !== "corsa") dino.lampo = null;
    else {
      c.save();
      c.globalCompositeOperation = "lighter";
      c.globalAlpha = 1 - k;
      c.imageSmoothingEnabled = false;
      const t = dinoTelaBolla(20 + Math.round(k * 14), 17 + Math.round(k * 12), -1);
      c.drawImage(t, lampo.cx - t.width / 2, lampo.cy - t.height / 2);
      c.restore();
    }
  }

  // l'oggetto sospeso: bagliore che segue la sua forma (ogni cella piena
  // ne accende tre per tre attorno, piano) e pulsa; su e giù di una cella
  const it = dino.oggetto;
  if (it) {
    const def = OGGETTI[it.tipo];
    const cl = def.cella || DINO_CELLA;
    const ox = DINO_CELLA * Math.round(it.x / DINO_CELLA);
    const oy = terra - it.sopra - it.h - (Math.sin(dino.corsa / 220) > 0 ? DINO_CELLA : 0);
    const sprite = def.pose ? def.pose[Math.floor(dino.corsa / 250) % def.pose.length] : def.sprite;
    c.globalAlpha = 0.07 + 0.04 * Math.sin(dino.corsa / 160);
    c.fillStyle = def.colore;
    // l'alone: con celle da 1 unità i quadrati attorno sono da 2 ogni 2 celle
    const passo = cl === 1 ? 2 : 1;
    for (let r = 0; r < sprite.length; r += passo) {
      const riga = sprite[r];
      for (let col = 0; col < riga.length; col += passo) {
        if (riga[col] !== ".") c.fillRect(ox + col * cl - DINO_CELLA, oy + r * cl - DINO_CELLA, 3 * DINO_CELLA, 3 * DINO_CELLA);
      }
    }
    c.globalAlpha = 1;
    if (cl === 1) {
      c.imageSmoothingEnabled = false;
      c.drawImage(dinoTela(`ogg|${it.tipo}`, sprite, def.colori), ox, oy, it.w, it.h);
      c.imageSmoothingEnabled = true;
    } else dinoPixel(c, sprite, ox, oy, def.colori);
  }
  // la strada bruciata dal soffio: brace che passa dal bianco all'arancio al
  // rosso e si spegne, con qualche fiammella sopra
  dino.bruciature.forEach((br) => {
    const k = br.vita / 1600;
    c.fillStyle = k < 0.12 ? "#fff3c4" : k < 0.35 ? "#ffb347" : k < 0.65 ? "#ff6a00" : "rgba(160, 40, 10, 0.7)";
    c.fillRect(br.x, terra - 1, 2, 2);
    if (k < 0.5 && Math.random() < 0.3) {
      c.fillStyle = "rgba(255, 170, 60, 0.75)";
      c.fillRect(br.x, terra - 2 - Math.floor(Math.random() * 4), 1, 1);
    }
  });
  // il soffio di Godzilla: dalla bocca a dove picchia, a quadretti che si
  // sommano alla luce (alone blu largo, banda azzurra, anima bianca), con
  // anelli chiari che corrono verso fuori; più grosso a carica piena, si
  // assottiglia spegnendosi. In bocca il lampo, dove picchia lo scoppio;
  // appena parte, un lampo azzurro su tutta la scena
  const soffio = dino.soffio;
  if (soffio) {
    const b = dinoBocca();
    const k = dino.corsa - soffio.inizio;
    const spegne = k > soffio.spazza ? 1 - (k - soffio.spazza) / SOFFIO_CODA : 1;
    const grosso = (0.7 + 0.3 * soffio.forza) * (0.4 + 0.6 * spegne);
    if (k < 140) {
      c.fillStyle = `rgba(150, 220, 255, ${(0.22 * (1 - k / 140)).toFixed(2)})`;
      c.fillRect(0, 0, W, H);
    }
    const lun = Math.max(1, Math.hypot(soffio.x2 - b.x, soffio.y2 - b.y));
    const cos = (soffio.x2 - b.x) / lun;
    const sin = (soffio.y2 - b.y) / lun;
    c.save();
    c.globalCompositeOperation = "lighter";
    for (let l = 0; l <= lun; l += 2) {
      const x = Math.round(b.x + cos * l);
      const y = Math.round(b.y + sin * l);
      const anello = (l - dino.corsa * 0.5) % 22 > -4 && (l - dino.corsa * 0.5) % 22 < 0;
      const largo = Math.round((anello ? 8 : 6) * grosso);
      c.fillStyle = "rgba(40, 110, 255, 0.08)";
      c.fillRect(x - largo, y - largo, 2 * largo, 2 * largo);
      const banda = Math.max(1, Math.round((anello ? 4 : 3) * grosso));
      c.fillStyle = anello ? "rgba(150, 230, 255, 0.45)" : "rgba(80, 200, 255, 0.32)";
      c.fillRect(x - banda, y - banda, 2 * banda, 2 * banda);
      const anima = Math.max(1, Math.round(1.5 * grosso));
      c.fillStyle = "rgba(240, 253, 255, 0.7)";
      c.fillRect(x - anima, y - anima, 2 * anima, 2 * anima);
    }
    const pulsa = 0.6 + 0.4 * Math.sin(dino.corsa / 30);
    [
      [b.x, b.y, Math.round(7 * grosso)],
      [soffio.x2, soffio.y2, Math.round(9 * grosso)],
    ].forEach(([px, py, r]) => {
      c.fillStyle = `rgba(80, 200, 255, ${(0.4 * pulsa).toFixed(2)})`;
      c.fillRect(Math.round(px) - r, Math.round(py) - r, 2 * r, 2 * r);
      c.fillStyle = "rgba(240, 253, 255, 0.9)";
      c.fillRect(Math.round(px) - 3, Math.round(py) - 3, 6, 6);
    });
    c.restore();
  }
  // il drop della boombox (vedi DROP_SALITA): mentre sale la scena si
  // scurisce e un anello si stringe sul dinosauro; alla botta un lampo
  // magenta, l'equalizzatore sulla strada dietro l'onda (barre a led che
  // pompano a ogni colpo di cassa e si spengono) e l'onda a oscilloscopio con
  // due echi dietro
  const drop = dino.drop;
  if (drop) {
    const k = dino.corsa - drop.inizio;
    if (k < DROP_SALITA) {
      const q = k / DROP_SALITA;
      c.fillStyle = `rgba(6, 4, 14, ${(0.35 * q).toFixed(2)})`;
      c.fillRect(0, 0, W, H);
      const r = Math.round(70 * (1 - q) + 6);
      c.fillStyle = Math.floor(k / 50) % 2 ? "rgba(255, 95, 210, 0.85)" : "rgba(120, 230, 255, 0.85)";
      const passi = Math.max(20, Math.floor((Math.PI * 2 * r) / DINO_CELLA));
      for (let i = 0; i < passi; i++) {
        const a = (Math.PI * 2 * i) / passi;
        const ay = drop.cy + r * Math.sin(a);
        if (ay > terra) continue;
        c.fillRect(DINO_CELLA * Math.round((drop.cx + r * Math.cos(a)) / DINO_CELLA), DINO_CELLA * Math.round(ay / DINO_CELLA), DINO_CELLA, DINO_CELLA);
      }
    } else {
      const kd = k - DROP_SALITA;
      if (kd < 160) {
        c.fillStyle = `rgba(255, 95, 210, ${(0.3 * (1 - kd / 160)).toFixed(2)})`;
        c.fillRect(0, 0, W, H);
      }
      const spegne = Math.max(0, 1 - Math.max(0, k - 1100) / 400);
      // l'equalizzatore: barre ogni 6 unità dal dinosauro in là, alte a
      // caso (sempre uguali per colonna), che salgono quando passa l'onda,
      // ricadono piano e ribalzano a ogni colpo di cassa
      const colpo = 0.55 + 0.45 * (1 - (kd % DROP_BATTITO) / DROP_BATTITO);
      for (let x = drop.cx + 4, i = 0; x < W; x += 6, i++) {
        const passato = kd - (x - drop.cx) / DROP_VEL;
        if (passato < 0) break;
        const picco = 16 + ((i * 37) % 29) + ((i * 11) % 9);
        const alto = picco * Math.min(1, passato / 70) * Math.exp(-passato / 650) * colpo * spegne;
        const blocchi = Math.floor(alto / 3);
        for (let b = 0; b < blocchi; b++) {
          c.fillStyle = EQ_GRADINI[Math.max(0, EQ_GRADINI.length - 1 - Math.floor((b * EQ_GRADINI.length) / 8))];
          c.globalAlpha = 0.8 * spegne;
          c.fillRect(Math.round(x), terra - 3 * (b + 1), 4, 2);
        }
      }
      c.globalAlpha = 1;
      // l'onda: tre fronti (quello vero e due echi), ognuno un'onda verticale
      // sfasata in magenta e ciano attorno all'anima bianca, dal punteggio
      // in giù fino alla strada
      c.save();
      c.globalCompositeOperation = "lighter";
      [
        [0, 1],
        [16, 0.45],
        [32, 0.2],
      ].forEach(([dietro, forza]) => {
        const fx = drop.fronte - dietro;
        if (fx > W + 10 || fx < drop.cx) return;
        const amp = 6 * forza * (1 - (0.5 * (fx - drop.cx)) / W);
        for (let y = DINO_Y_PUNTEGGIO + 16; y < terra; y += 2) {
          const off = Math.sin(y / 3.4 - kd / 28) * amp + Math.sin(y / 9 + kd / 60) * amp * 0.5;
          const x = Math.round(fx + off);
          c.globalAlpha = 0.55 * forza;
          c.fillStyle = "#ff5fd2";
          c.fillRect(x - 3, y, 2, 2);
          c.fillStyle = "#5fe3ff";
          c.fillRect(x + 1, y, 2, 2);
          c.globalAlpha = 0.9 * forza;
          c.fillStyle = "#ffffff";
          c.fillRect(x - 1, y, 2, 2);
        }
      });
      c.restore();
    }
  }
  // le notine del drop, a ventaglio dal dinosauro, che si spengono a scatti
  dino.noteDrop.forEach((n) => {
    const k = n.vita / 800;
    c.globalAlpha = k < 0.5 ? 1 : k < 0.8 ? 0.6 : 0.3;
    dinoPixel(c, NOTINA_SPRITE[n.tipo], DINO_CELLA * Math.round(n.x / DINO_CELLA), DINO_CELLA * Math.round(n.y / DINO_CELLA), { "#": n.tipo ? "#ff5fd2" : "#5fe3ff" });
  });
  c.globalAlpha = 1;
  // schegge e scintille, che si spengono a scatti
  dino.particelle.forEach((p) => {
    const k = p.vita / p.durata;
    c.globalAlpha = k < 0.5 ? 1 : k < 0.8 ? 0.6 : 0.3;
    c.fillStyle = p.colore;
    c.fillRect(DINO_CELLA * Math.round(p.x / DINO_CELLA), DINO_CELLA * Math.round(p.y / DINO_CELLA), DINO_CELLA, DINO_CELLA);
  });
  c.globalAlpha = 1;
  c.restore();

  // punteggio centrato sotto la scritta OFFLINE MODE (che sta in cima al
  // banner, 16-41 px), come nei cabinati: record spento, punti in arancio.
  // Prima della prima partita solo il record, se c'è
  const pad = (n) => String(Math.floor(n)).padStart(5, "0");
  const hi = dino.record && dino.stato !== "fine" ? `HI ${pad(dino.record)}` : "";
  const punti = dino.stato !== "riposo" && dino.stato !== "fine" ? pad(dino.punti) : "";
  const lHi = hi ? dinoMisuraScritta(hi, DINO_FONT_PICCOLO) : 0;
  const stacco = hi && punti ? 4 * DINO_CELLA : 0;
  const lPunti = punti ? dinoMisuraScritta(punti, DINO_FONT_PICCOLO) : 0;
  const xp = W / 2 - (lHi + stacco + lPunti) / 2;
  if (hi) dinoScrittaDa(c, hi, xp, DINO_Y_PUNTEGGIO, "rgba(255, 255, 255, 0.4)", DINO_FONT_PICCOLO);
  if (punti) dinoPunteggio(c, punti, xp + lHi + stacco, lPunti);
  // potere in corso: il tempo che resta, sopra la testa (dinoTimerPotere)
  dinoTimerPotere(c, terra);
  // i +10 degli ostacoli spaccati
  dino.scritte.forEach((s) => {
    c.globalAlpha = s.vita < 500 ? 1 : 0.5;
    dinoScritta(c, s.testo || "+10", s.x, DINO_CELLA * Math.round(s.y / DINO_CELLA), "#ffd23f", DINO_FONT_PICCOLO);
  });
  c.globalAlpha = 1;
  // il nome del potere appena preso, a centro scena
  // il nome del potere: il cartellone al posto della scritta OFFLINE MODE
  if (dino.annuncio && dino.corsa < dino.annuncio.fino && dino.stato !== "fine") {
    dinoCartellone(c, W);
  }
  if (dino.potere && dino.potere.tipo === "pozione" && !dino.potere.provato && dino.stato === "corsa" && Math.floor(dino.corsa / 450) % 3 !== 2) {
    // il mini: finché non ci provi, come si fa il secondo salto
    dinoScritta(c, "Tocca ancora in aria", W / 2, terra - 70, "#f5c6ff", DINO_FONT_PICCOLO);
  }
  if (dino.potere && dino.potere.tipo === "jetpack" && !dino.potere.provato && dino.stato === "corsa" && Math.floor(dino.corsa / 450) % 3 !== 2) {
    // il jetpack: finché non ci provi, come si vola
    dinoScritta(c, "Tieni premuto per volare", W / 2, terra - 72, "#ffd2a8", DINO_FONT_PICCOLO);
  }
  if (dino.potere && dino.potere.tipo === "scaglia" && !dino.potere.provato && dino.stato === "corsa") {
    // Godzilla: finché non ci provi, come si spara
    // nello spazio davanti alla sua testa
    if (Math.floor(dino.corsa / 450) % 3 !== 2) dinoScritta(c, "Tieni premuto e lascia", (dinoX() + 74 + W) / 2, terra - 60, "#bdf6ff", DINO_FONT_PICCOLO);
  }

  // il titolo del boss e la tendina a nero, sopra la scena
  dinoBossSopra(c, W, H);

  // fine partita, rifatta per il banner grande (Vitto 08/10: «va rifatto il
  // death screen, quello era per il minibanner; forse ci starebbe la
  // scritta game over»): la scena si scurisce, GAME OVER grande con l'ombra
  // arancio, sotto cosa ti ha preso, i punti (o il record nuovo, che
  // lampeggia) e il pulsante per riprovare. Si riparte toccando il pulsante
  // o anche il resto del banner (mirare sarebbe scomodo). Posizioni a
  // distanze pari dal terreno: pixel interi sullo schermo
  if (dino.stato === "fine") {
    c.fillStyle = "rgba(8, 8, 12, 0.6)";
    c.fillRect(0, 0, W, H);
    const grande = 2 * DINO_CELLA;
    const yg = terra - 98;
    dinoScritta(c, "Game over", W / 2 + DINO_CELLA, yg + DINO_CELLA, DINO_ARANCIO, DINO_FONT, grande);
    dinoScritta(c, "Game over", W / 2, yg, "#f4f4f5", DINO_FONT, grande);
    if (dino.causa) dinoScritta(c, dino.causa, W / 2, terra - 64, "rgba(255, 255, 255, 0.6)", DINO_FONT_PICCOLO);
    if (dino.nuovoRecord) {
      if (dinoMotoRidotto() || t % 800 < 520) {
        dinoScritta(c, `Nuovo record ${pad(dino.punti)}`, W / 2, terra - 50, "#ffd23f", DINO_FONT_PICCOLO);
      }
    } else {
      dinoScritta(c, `Punti ${pad(dino.punti)}   HI ${pad(dino.record)}`, W / 2, terra - 50, dinoFascia().colore, DINO_FONT_PICCOLO);
    }
    const lato = 15 * DINO_CELLA;
    const bx = DINO_CELLA * Math.round((W / 2 - lato / 2) / DINO_CELLA);
    dinoPixel(c, RIPROVA_SPRITE, bx, terra - 34, { o: DINO_ARANCIO, k: "#141414" });
    return;
  }

  // l'invito lampeggia come il PRESS START delle sale giochi (con «riduci
  // movimento» resta acceso)
  const acceso = dinoMotoRidotto() || t % 1100 < 750;
  if (dino.stato === "riposo") {
    if (acceso) dinoScritta(c, "Tocca per giocare", W / 2, terra - 60, "#f4f4f5");
    // la modalità, se non è la normale (si cambia dalle impostazioni)
    if (dino.modo !== "normale") dinoScritta(c, dinoModo().nome, W / 2, terra - 40, dinoModo().colore, DINO_FONT_PICCOLO);
  } else if (dino.stato === "pausa") {
    dinoScrittePausa(c, W, terra);
  }
}

/** «Pausa», e sotto l'invito che lampeggia (anche sopra il minigioco). */
function dinoScrittePausa(c, W, terra) {
  dinoScritta(c, "Pausa", W / 2, terra - 66, "#f4f4f5");
  const acceso = dinoMotoRidotto() || dino.amb.tempo % 1100 < 750;
  if (acceso) dinoScritta(c, "Tocca per continuare", W / 2, terra - 44, "rgba(255, 255, 255, 0.55)", DINO_FONT_PICCOLO);
}

// Il punteggio in fiamme (08/10, Vitto: «l'intero punteggio che si infiamma
// tutto, come nei giochi quando inizi a prendere i moltiplicatori»; tre
// gradazioni: 1000-2000, 2000-3000, da 3000). Sotto i 1000 le cifre arancio
// di sempre. Da 1000 il numero brucia davvero: un fuoco a celle (quello
// classico di Doom) che ha per sorgente le celle accese delle cifre stesse,
// così le fiamme salgono da tutto il numero, dentro e fra le cifre; sopra,
// le cifre roventi col contorno scuro. Più punti, fiamme più alte; da 3000
// fuoco blu, il più caldo, e il numero trema. Passando di livello una
// vampata. A ogni centinaio il lampo bianco col saltino resta.
const FUOCO_ROSSO = ["", "#3a0a02", "#5c1204", "#7f1d06", "#a12a07", "#c23a08", "#df4e0a", "#f0660f", "#f78418", "#fca024", "#ffbb33", "#ffd04d", "#ffe27a", "#fff0a8", "#fff8d6", "#ffffff"];
const FUOCO_BLU = ["", "#0a1640", "#0f2266", "#14308c", "#1a42b0", "#2257d1", "#2c6fe8", "#3a8af5", "#4fa5ff", "#68bdff", "#86d2ff", "#a6e3ff", "#c5f0ff", "#def8ff", "#f0fcff", "#ffffff"];
const PUNTEGGIO_FUOCHI = [
  { da: 1000, calo: 6, tavola: FUOCO_ROSSO, righe: 6, cifre: ["#ffffff", "#fff3b8", "#ffd23f", "#ffb02e", "#ff8a2a"], colore: "#ffb02e" },
  { da: 2000, calo: 4, tavola: FUOCO_ROSSO, righe: 9, cifre: ["#ffffff", "#fff8d6", "#ffe27a", "#ffbb33", "#ff7a1a"], colore: "#ff5a1a", alone: "255, 90, 20" },
  { da: 3000, calo: 3, tavola: FUOCO_BLU, righe: 11, cifre: ["#ffffff", "#f0fcff", "#c5f0ff", "#86d2ff", "#4fa5ff"], colore: "#7fd8ff", alone: "60, 150, 255", trema: true },
];
function dinoLivelloFuoco() {
  let l = -1;
  PUNTEGGIO_FUOCHI.forEach((f, i) => {
    if (dino.punti >= f.da) l = i;
  });
  return l;
}
/** Il colore del punteggio fuori dal tabellone (game over). */
function dinoFascia() {
  const l = dinoLivelloFuoco();
  return { colore: l < 0 ? "#ff9a3c" : PUNTEGGIO_FUOCHI[l].colore };
}
/** Celle accese delle cifre (DINO_FONT_PICCOLO), in celle da sinistra. */
function dinoCelleCifre(testo) {
  const celle = [];
  let x0 = 0;
  [...testo].forEach((ch) => {
    const g = DINO_FONT_PICCOLO[ch] || DINO_FONT_PICCOLO[" "];
    g.forEach((riga, r) => {
      for (let k = 0; k < riga.length; k++) if (riga[k] === "#") celle.push([x0 + k, r]);
    });
    x0 += g[0].length + 1;
  });
  return { celle, larghe: x0 - 1 };
}
/** Un passo del fuoco: ogni cella passa il suo calore a quella sopra (un
 * po' di lato, a caso), perdendone un po'; le cifre sono sorgenti piene. */
function dinoFuocoPasso(f, liv, vampata) {
  const { w, h, griglia, sorgenti } = f;
  sorgenti.forEach((i) => (griglia[i] = 15));
  const calo = vampata ? Math.max(1, liv.calo - 3) : liv.calo;
  for (let y = 1; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = griglia[y * w + x];
      const dx = Math.floor(Math.random() * 3) - 1;
      const xx = Math.min(w - 1, Math.max(0, x + dx));
      const giu = Math.round(Math.random() * calo);
      const sopra = (y - 1) * w + xx;
      // il calore sale nella cella sopra (un po' di lato), perdendone un po'
      griglia[sopra] = Math.max(0, v - giu);
    }
  }
  sorgenti.forEach((i) => (griglia[i] = 15));
}
function dinoPunteggio(c, testo, x, larghezza) {
  const t = dino.corsa;
  const cl = DINO_CELLA;
  const l = dinoLivelloFuoco();
  let y = DINO_Y_PUNTEGGIO;
  const k = t - dino.cento;
  const lampo = k >= 0 && k < 420 && Math.floor(k / 70) % 2 === 0;
  if (k >= 0 && k < 140) y -= cl;
  if (l < 0) {
    dino.fuoco = null;
    dinoScrittaDa(c, testo, x, y, lampo ? "#ffffff" : "#ff9a3c", DINO_FONT_PICCOLO);
    return;
  }
  const liv = PUNTEGGIO_FUOCHI[l];
  // la griglia del fuoco: il numero più due celle per lato, e sopra le righe
  // delle fiamme. Si rifà quando cambiano cifre o livello
  const { celle, larghe } = dinoCelleCifre(testo);
  const w = larghe + 4;
  const h = liv.righe + 5;
  let f = dino.fuoco;
  if (!f || f.testo !== testo || f.l !== l) {
    const vecchia = f && f.w === w && f.h === h ? f.griglia : null;
    const sorgenti = new Set(celle.map(([cx, cy]) => (liv.righe + cy) * w + cx + 2));
    f = { testo, l, w, h, griglia: vecchia || new Uint8Array(w * h), sorgenti, ultimo: f ? f.ultimo : t, vampata: f && f.l < l ? t : f ? f.vampata : t };
    dino.fuoco = f;
  }
  const passi = Math.min(4, Math.floor((t - f.ultimo) / 45));
  for (let i = 0; i < passi; i++) dinoFuocoPasso(f, liv, t - f.vampata < 500);
  if (passi > 0) f.ultimo += passi * 45;
  if (t < f.ultimo) f.ultimo = t; // partita nuova
  // da 3000 il numero trema
  const tr = liv.trema ? [-1, 0, 1, 0][Math.floor(t / 55) % 4] : 0;
  const gx = cl * Math.round(x / cl) - 2 * cl + tr;
  const gy = y - liv.righe * cl;
  // alone dietro
  if (liv.alone) {
    const cx = gx + (w * cl) / 2;
    const cy = y + 2 * cl;
    const g = c.createRadialGradient(cx, cy, 2, cx, cy, w * cl * 0.7);
    g.addColorStop(0, `rgba(${liv.alone}, ${0.3 + 0.08 * Math.sin(t / 90)})`);
    g.addColorStop(1, `rgba(${liv.alone}, 0)`);
    c.save();
    c.globalCompositeOperation = "lighter";
    c.fillStyle = g;
    c.fillRect(gx - w * cl, gy - 10, w * cl * 3, h * cl + 30);
    c.restore();
  }
  // le fiamme
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const v = f.griglia[j * w + i];
      if (v < 2) continue;
      c.globalAlpha = v < 4 ? 0.45 : v < 6 ? 0.75 : 1;
      c.fillStyle = liv.tavola[v];
      c.fillRect(gx + i * cl, gy + j * cl, cl, cl);
    }
  }
  c.globalAlpha = 1;
  // le cifre roventi: contorno scuro e righe dal bianco (in alto) al colore
  const x0 = gx + 2 * cl;
  c.fillStyle = l === 2 ? "#06102e" : "#2a0802";
  celle.forEach(([cx, cy]) => {
    c.fillRect(x0 + cx * cl - 1, y + cy * cl, cl + 2, cl);
    c.fillRect(x0 + cx * cl, y + cy * cl - 1, cl, cl + 2);
  });
  celle.forEach(([cx, cy]) => {
    c.fillStyle = lampo ? "#ffffff" : liv.cifre[cy];
    c.fillRect(x0 + cx * cl, y + cy * cl, cl, cl);
  });
}

/** Un mixer: la base grigia con le manopole arancio, larga quanto il gruppo,
 * e sopra i canali squadrati, a gradini di colore di due celle. */
// I «mixer grandi» diventano cristalli arancioni (08/10, Vitto: «quelli alti
// non mi fanno impazzire», scelto il grappolo fra tre stili): per canale un
// cristallo a punta sfaccettato (faccia chiara a sinistra della cresta,
// scura a destra, cima più chiara) e due schegge piccole alla base, col
// contorno scuro attorno a tutto il grappolo. Celle da 1 unità, su una tela
// a parte per ostacolo (o.tela), disegnata una volta sola.
const CRISTALLO_COLORI = { o: "#2a0e02", L: "#ffe6c7", l: "#ffa04a", m: "#ff7a1a", d: "#d65200", D: "#8f3200", c: "#ffc58f" };
function dinoCristalliTela(o) {
  const pad = 4;
  const W = o.w + 2 * pad;
  const H = o.h + 2;
  const b = H - 1; // la base, una riga sopra il fondo per il contorno
  const celle = new Map();
  const dentro = (pts, x, y) => {
    let ok = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i];
      const [xj, yj] = pts[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) ok = !ok;
    }
    return ok;
  };
  const scheggia = (x0, x1, s0, s1, tx, ty) => {
    const pts = [[x0, b], [x0, s0], [tx, ty], [x1, s1], [x1, b]];
    const mx = (x0 + x1) / 2;
    for (let y = Math.floor(ty); y < b; y++) {
      for (let x = Math.floor(x0); x < x1; x++) {
        const cx = x + 0.5;
        const cy = y + 0.5;
        if (!dentro(pts, cx, cy)) continue;
        const rx = tx + (mx - tx) * ((cy - ty) / (b - ty));
        let k = cx < rx ? (cx < rx - 2.2 ? "l" : "L") : cx < rx + 1.2 ? "m" : cx > x1 - 1.6 ? "D" : "d";
        if (cy < Math.min(s0, s1) && k !== "L") k = cx < rx ? "c" : "m";
        celle.set(`${x},${y}`, k);
      }
    }
  };
  const cl = DINO_CELLA;
  o.canali.forEach((h, i) => {
    const x = pad + cl + i * (o.lc + cl);
    const t = o.inclina ? o.inclina[i] : 0;
    scheggia(x + 1, x + 11, b - h + 7 - t, b - h + 7 + t, x + 6 + t * 1.5, b - h);
    scheggia(x - 2, x + 4, b - 8, b - 6, x - 3, b - 12);
    scheggia(x + 8, x + 14, b - 7, b - 9, x + 15, b - 14);
  });
  const tela = document.createElement("canvas");
  tela.width = W;
  tela.height = H;
  const g = tela.getContext("2d");
  g.fillStyle = CRISTALLO_COLORI.o;
  celle.forEach((_, k) => {
    const [x, y] = k.split(",").map(Number);
    [[1, 0], [-1, 0], [0, -1]].forEach(([a, z]) => {
      if (!celle.has(`${x + a},${y + z}`)) g.fillRect(x + a, y + z, 1, 1);
    });
  });
  celle.forEach((k, xy) => {
    const [x, y] = xy.split(",").map(Number);
    g.fillStyle = CRISTALLO_COLORI[k];
    g.fillRect(x, y, 1, 1);
  });
  return { tela, pad, H };
}
function dinoCristalli(c, o, ox, terra) {
  if (!o.tela) o.tela = dinoCristalliTela(o);
  const { tela, pad, H } = o.tela;
  c.imageSmoothingEnabled = false;
  c.drawImage(tela, ox - pad, terra - H + 1, tela.width, H);
  c.imageSmoothingEnabled = true;
}
function dinoMixer(c, o, ox, terra) {
  if (o.cristallo) {
    dinoCristalli(c, o, ox, terra);
    return;
  }
  const cl = DINO_CELLA;
  const base = 2 * cl;
  o.canali.forEach((h, i) => {
    const x = ox + cl + i * (o.lc + cl);
    for (let y = 0; y < h - base; y += cl) {
      c.fillStyle = EQ_GRADINI[Math.min(EQ_GRADINI.length - 1, Math.floor(y / (cl * 2)))];
      c.fillRect(x, terra - h + y, o.lc, cl);
    }
  });
  c.fillStyle = "#8a8a92";
  c.fillRect(ox, terra - base, o.w, cl);
  c.fillStyle = "#4a4a52";
  c.fillRect(ox, terra - cl, o.w, cl);
  c.fillStyle = DINO_ARANCIO;
  o.canali.forEach((_, i) => c.fillRect(ox + cl + i * (o.lc + cl) + o.lc / 2 - cl, terra - cl, 2 * cl, cl));
}

/** Il sole al tramonto dietro l'orizzonte, a celle: mezzo disco sfumato
 * dall'arancio scuro (giù) all'oro (su) e, nella metà bassa, una riga vuota
 * ogni quattro che scende piano verso l'orizzonte, come i tramonti delle
 * copertine anni '80. */
function dinoSole(c, cx, terra, r, t) {
  const cl = DINO_CELLA;
  const scorri = Math.floor(t / 260) % 4;
  for (let dy = cl; dy <= r; dy += cl) {
    if (dy <= r * 0.6 && (dy / cl + scorri) % 4 === 0) continue;
    const mezza = Math.sqrt(Math.max(0, r * r - (dy - cl / 2) ** 2));
    const x1 = cl * Math.round((cx - mezza) / cl);
    const x2 = cl * Math.round((cx + mezza) / cl);
    const k = dy / r; // 0 all'orizzonte, 1 in cima
    c.fillStyle = `rgba(255, ${Math.round(61 + 118 * k)}, ${Math.round(71 * k)}, 0.28)`;
    c.fillRect(x1, terra - dy, x2 - x1, cl);
  }
}

/** Larghezza in px di una scritta a pixel: lettere del carattere scelto
 * (DINO_FONT o DINO_FONT_PICCOLO) con una cella di spazio fra l'una e
 * l'altra. */
// —— IL NOME DEL POTERE E IL SUO TEMPO (rifatti il 08/10; Vitto: «le scritte
// dei buff fanno un po' cagare, fai qualcosa di più complesso; anche la
// scadenza non mi piace ed è poco pratica», free will). ——
// Il cartellone: quando prendi un potere, la scritta OFFLINE MODE si spegne
// (dinoDom, .annuncio) e al suo posto entra il nome, da sala giochi: lettere
// a celle da 3 col contorno scuro, il rilievo sotto e la sfumatura dal
// bianco al colore del potere; entra di colpo (più grande e si assesta), poi
// ci passa sopra un riflesso; dietro, raggi di luce che girano; sotto, una
// riga su cosa fa. Sta nel cielo in alto: non copre mai la strada.
const ANNUNCIO_DURA = 1600;
const _dinoCartelli = new Map();
/** La scritta del cartellone su una tela a 1 px per cella (in cache):
 * rilievo, contorno, poi le lettere sfumate riga per riga. bianca = solo la
 * sagoma in bianco, per il riflesso. */
function dinoTelaCartello(testo, colore, bianca) {
  const chiave = `${testo}|${colore}|${bianca ? 1 : 0}`;
  let tela = _dinoCartelli.get(chiave);
  if (tela) return tela;
  const larghe = dinoMisuraScritta(testo, DINO_FONT, 1);
  tela = document.createElement("canvas");
  tela.width = larghe + 4;
  tela.height = 7 + 5;
  const g = tela.getContext("2d");
  const lettere = (fn) => {
    let x = 0;
    [...testo.toUpperCase()].forEach((ch) => {
      const gl = DINO_FONT[ch] || DINO_FONT[" "];
      gl.forEach((riga, r) => {
        for (let k = 0; k < riga.length; k++) if (riga[k] === "#") fn(x + k, r);
      });
      x += gl[0].length + 1;
    });
  };
  if (bianca) {
    g.fillStyle = "#ffffff";
    lettere((x, y) => g.fillRect(x + 1, y + 1, 1, 1));
  } else {
    const scuro = "#140a05";
    const rilievo = dinoMescola(colore, "#000000", 0.6);
    // rilievo: la sagoma ripetuta due celle più giù, scura; poi un filo di
    // contorno attorno a ogni lettera (in diagonale no: resta a pixel)
    g.fillStyle = rilievo;
    lettere((x, y) => g.fillRect(x + 1, y + 2, 1, 2));
    g.fillStyle = scuro;
    lettere((x, y) => {
      g.fillRect(x, y + 1, 3, 1);
      g.fillRect(x + 1, y, 1, 3);
    });
    lettere((x, y) => g.fillRect(x + 1, y + 4, 1, 1));
    const righe = ["#ffffff", dinoMescola(colore, "#ffffff", 0.65), dinoMescola(colore, "#ffffff", 0.35), colore, colore, dinoMescola(colore, "#000000", 0.15), dinoMescola(colore, "#000000", 0.3)];
    lettere((x, y) => {
      g.fillStyle = righe[y];
      g.fillRect(x + 1, y + 1, 1, 1);
    });
  }
  _dinoCartelli.set(chiave, tela);
  return tela;
}

// a e k (ms dall'inizio) di serie quelli del potere preso; il boss passa il
// suo titolo e il suo orologio (dino.corsa è fermo durante l'incontro)
function dinoCartellone(c, W, a = dino.annuncio, k = dino.corsa - a.inizio) {
  const esce = Math.max(0, (k - (ANNUNCIO_DURA - 220)) / 220);
  const alfa = 1 - esce;
  const cx = W / 2;
  const cy = 22 - 5 * esce;
  // raggi di luce dietro, che girano piano; tagliati sopra il punteggio
  c.save();
  c.beginPath();
  c.rect(0, 0, W, DINO_Y_PUNTEGGIO - 2);
  c.clip();
  c.globalCompositeOperation = "lighter";
  c.fillStyle = a.colore;
  c.globalAlpha = 0.1 * alfa * Math.min(1, k / 120);
  const giro = k / 1400;
  for (let i = 0; i < 14; i++) {
    const a0 = giro + (i * Math.PI * 2) / 14;
    c.beginPath();
    c.moveTo(cx, cy);
    c.lineTo(cx + Math.cos(a0) * 260, cy + Math.sin(a0) * 260);
    c.lineTo(cx + Math.cos(a0 + 0.16) * 260, cy + Math.sin(a0 + 0.16) * 260);
    c.closePath();
    c.fill();
  }
  c.restore();
  // la scritta: entra più grande (celle da 4,5) e si assesta a 3
  const pop = Math.max(0, 1 - k / 170);
  const cella = 3 * (1 + 0.5 * pop * pop);
  const tela = dinoTelaCartello(a.testo, a.colore, false);
  const w = tela.width * cella;
  const h = tela.height * cella;
  const x = Math.round(cx - w / 2 + cella);
  const y = Math.round(cy - h / 2 + cella);
  c.save();
  c.globalAlpha = alfa;
  c.imageSmoothingEnabled = false;
  c.drawImage(tela, x, y, w, h);
  // il riflesso: una banda bianca obliqua che attraversa le lettere
  if (k > 260 && k < 700) {
    const q = (k - 260) / 440;
    const bx = x - 20 + q * (w + 40);
    c.beginPath();
    c.moveTo(bx, y);
    c.lineTo(bx + 10, y);
    c.lineTo(bx - 4, y + h);
    c.lineTo(bx - 14, y + h);
    c.closePath();
    c.clip();
    c.globalAlpha = 0.85 * alfa;
    c.drawImage(dinoTelaCartello(a.testo, a.colore, true), x, y, w, h);
  }
  c.restore();
  // cosa fa, sotto, in piccolo
  if (a.sotto && k > 120) {
    c.globalAlpha = alfa * Math.min(1, (k - 120) / 120);
    dinoScritta(c, a.sotto, cx, Math.round(cy + 13), "#f4f4f5", DINO_FONT_PICCOLO, 1);
    c.globalAlpha = 1;
  }
}

/** Dove sta la barra del tempo di un potere: sopra la testa di chi corre
 * (dinosauro, mini o Godzilla), centrata. */
function dinoPostoTimer(p) {
  const terra = dinoTerra();
  const alto = p.tipo === "scaglia" ? GODZILLA_H * GODZILLA_SCALA : p.tipo === "pozione" ? 18 : DINO_H;
  const cx = dinoX() + (p.tipo === "scaglia" ? 34 : p.tipo === "pozione" ? 15 : 16);
  const w = 8 * 3 + 7;
  return { x: Math.round(cx - w / 2), y: Math.round(terra - dino.y - alto - 10), w };
}

/** Il tempo del potere: 8 tacche del suo colore che si svuotano, sopra la
 * testa, dove si guarda giocando; negli ultimi 3 s lampeggiano e accanto
 * c'è il conto alla rovescia, che a ogni secondo entra di colpo. */
function dinoTimerPotere(c, terra) {
  const p = dino.potere;
  if (!p || !p.durata || dino.stato === "fine") return;
  const resta = Math.max(0, p.fine - dino.corsa);
  const pieno = (resta / p.durata) * 8;
  const colore = OGGETTI[p.tipo].colore;
  const { x, y, w } = dinoPostoTimer(p);
  const ultimi = resta < 3000;
  const lampo = ultimi && Math.floor(dino.corsa / 140) % 2 === 0;
  c.fillStyle = "rgba(10, 6, 14, 0.75)";
  c.fillRect(x - 2, y - 2, w + 4, 7);
  for (let i = 0; i < 8; i++) {
    const tx = x + i * 4;
    c.fillStyle = "rgba(255, 255, 255, 0.14)";
    c.fillRect(tx, y, 3, 3);
    const q = Math.min(1, Math.max(0, pieno - i));
    if (q <= 0) continue;
    const h = Math.max(1, Math.round(3 * q));
    c.fillStyle = lampo ? "#ffffff" : colore;
    c.fillRect(tx, y + 3 - h, 3, h);
  }
  if (ultimi && resta > 0) {
    const n = String(Math.ceil(resta / 1000));
    const dentro = 1000 - (resta % 1000);
    const cella = dentro < 120 ? 3 : 2;
    const nx = x + w + 5;
    const ny = Math.round(y + 1.5 - (7 * cella) / 2);
    dinoScrittaDa(c, n, nx + 1, ny + 1, "#140a05", DINO_FONT, cella);
    dinoScrittaDa(c, n, nx, ny, lampo ? colore : "#ffffff", DINO_FONT, cella);
  }
}

function dinoMisuraScritta(testo, font = DINO_FONT, cella = DINO_CELLA) {
  return [...testo.toUpperCase()].reduce((n, ch) => n + ((font[ch] || font[" "])[0].length + 1) * cella, -cella);
}

/** Scritta a pixel che parte da x (celle da `cella`, di solito DINO_CELLA). */
function dinoScrittaDa(c, testo, x, y, colore, font = DINO_FONT, cella = DINO_CELLA) {
  let xl = cella * Math.round(x / cella);
  [...testo.toUpperCase()].forEach((ch) => {
    const g = font[ch] || font[" "];
    dinoPixel(c, g, xl, y, { "#": colore }, cella);
    xl += (g[0].length + 1) * cella;
  });
}

/** Scritta a pixel centrata su xCentro. */
function dinoScritta(c, testo, xCentro, y, colore, font = DINO_FONT, cella = DINO_CELLA) {
  dinoScrittaDa(c, testo, xCentro - dinoMisuraScritta(testo, font, cella) / 2, y, colore, font, cella);
}

/** Le parti del gioco che stanno nel DOM, allineate a ogni fotogramma.
 * Le finestre di Windows XP (#dinoErrore; sopra il canvas e sotto il vetro
 * del monitor): una per ogni dino.virus.finestre, fatte dal modello del
 * markup (collegaDino), solo a partita in corso o in pausa. A partita finita
 * la scritta OFFLINE MODE si abbassa, così il GAME OVER resta l'unico
 * titolo. */
let _dinoFinestraModello = null;
let _tastoSchermo = "";
function dinoDom() {
  const cab = document.getElementById("offlineCabinato");
  if (cab) {
    cab.classList.toggle("finita", dino.stato === "fine");
    cab.classList.toggle("annuncio", !!(dino.annuncio && dino.corsa < dino.annuncio.fino && dino.stato !== "fine"));
    // OFFLINE MODE (che è sopra il canvas) lascia il posto al titolo del boss,
    // poi alla tendina, e il minigioco ha tutta l'altezza
    const bf = dino.boss && dino.boss.fase;
    cab.classList.toggle("boss", bf === "incontro" || bf === "entra" || bf === "gioco" || bf === "esito" || bf === "esce");
  }
  // il tasto schermo intero: c'è solo nell'app che sa girarsi, e sparisce
  // mentre corri (tocca le classi solo quando cambia)
  const tasto = (pluginOrientamento() ? "p" : "-") + (dino.stato === "corsa" ? "c" : "-");
  if (tasto !== _tastoSchermo) {
    _tastoSchermo = tasto;
    const b = document.getElementById("dinoGrandeBtn");
    if (b) {
      b.classList.toggle("hidden", tasto[0] !== "p");
      b.classList.toggle("in-corsa", tasto[1] === "c");
    }
    const m = document.getElementById("dinoMenuBtn");
    if (m) m.classList.toggle("in-corsa", tasto[1] === "c");
    const sc = document.getElementById("dinoSchermo");
    if (sc) sc.classList.toggle("in-corsa", tasto[1] === "c");
  }
  const el = document.getElementById("dinoErrore");
  if (!el || !_dinoFinestraModello) return;
  const v = dino.virus;
  const vedi = !!(v && (dino.stato === "corsa" || dino.stato === "pausa"));
  el.classList.toggle("visibile", vedi);
  const finestre = vedi ? v.finestre : [];
  const resta = new Set(finestre.map((f) => String(f.id)));
  [...el.children].forEach((n) => {
    if (!resta.has(n.dataset.id)) n.remove();
  });
  finestre.forEach((f) => {
    if (el.querySelector(`[data-id="${f.id}"]`)) return;
    const n = _dinoFinestraModello.cloneNode(true);
    n.dataset.id = String(f.id);
    n.querySelector("p").textContent = VIRUS_TESTI[f.testo];
    n.style.left = `${f.x}px`;
    n.style.top = `${f.y}px`;
    el.appendChild(n);
  });
}

/** Disegna uno sprite a celle: ogni carattere della riga è una cella da
 * `cella` unità (DINO_CELLA, il doppio per Godzilla), colori = { carattere:
 * colore } (gli altri restano vuoti). */
/** Un ostacolo: mixer, mina, mina col paracadute (finché è in aria, col
 * paracadute e le corde) o fantasmino (la gonna che ondeggia e sale e
 * scende di una cella). */
function dinoDisegnaOstacolo(c, o, terra, posa, lucina) {
  // x a cella intera: niente pixel a metà mentre scorrono
  const ox = DINO_CELLA * Math.round(o.x / DINO_CELLA);
  if (o.tipo === "mixer") {
    dinoMixer(c, o, ox, terra);
  } else if (o.tipo === "virus") {
    // l'icona di Windows: sale e scende di una cella, con un alone rosso che
    // pulsa e un'ombra rossa sulla strada
    const su = Math.sin(dino.corsa / 200 + o.fase) > 0 ? 1 : 0;
    const vy = terra - o.sopra - o.h - su;
    c.save();
    c.globalCompositeOperation = "lighter";
    c.globalAlpha = 0.22 + 0.12 * Math.sin(dino.corsa / 130);
    c.fillStyle = "#ff2a10";
    // tondo: tre rettangoli sovrapposti
    c.fillRect(ox - 3, vy + 5, o.w + 6, o.h - 10);
    c.fillRect(ox + 5, vy - 3, o.w - 10, o.h + 6);
    c.fillRect(ox - 1, vy - 1, o.w + 2, o.h + 2);
    c.globalAlpha = 0.16;
    c.fillRect(ox + 2, terra, o.w - 4, 1);
    c.restore();
    c.imageSmoothingEnabled = false;
    c.drawImage(dinoTela("virus", VIRUS_SPRITE, VIRUS_COLORI), ox, vy, o.w, o.h);
    c.imageSmoothingEnabled = true;
  } else if (o.tipo === "mina") {
    // a lucina accesa: alone attorno e riverbero rosso sulla strada
    const accesa = lucina === "#ff3b3b";
    if (accesa) {
      c.save();
      c.globalCompositeOperation = "lighter";
      c.fillStyle = "rgba(255, 50, 50, 0.16)";
      c.fillRect(ox + 4, terra - o.h - 5, 10, 8);
      c.fillStyle = "rgba(255, 50, 50, 0.3)";
      c.fillRect(ox + 6, terra - o.h - 3, 6, 4);
      c.fillStyle = "rgba(255, 40, 40, 0.22)";
      c.fillRect(ox - 4, terra, o.w + 8, 1);
      c.fillRect(ox, terra + 1, o.w, 1);
      c.restore();
    }
    c.imageSmoothingEnabled = false;
    c.drawImage(dinoTela(`mina|${accesa}`, MINA_SPRITE, { ...MINA_COLORI, r: lucina }), ox, terra - o.h, o.w, o.h);
    c.imageSmoothingEnabled = true;
  } else if (o.tipo === "paracadute") {
    const my = DINO_CELLA * Math.round((terra - o.sopra - o.h) / DINO_CELLA);
    if (o.sopra > 0) {
      const px = ox - 2 * DINO_CELLA;
      const py = my - 12 - PARACADUTE_SPRITE.length * DINO_CELLA;
      dinoPixel(c, PARACADUTE_SPRITE, px, py, { "#": "#ff8a2a", w: "#ffd8b0" });
      c.fillStyle = "rgba(244, 244, 245, 0.6)";
      const cimaX = ox + 4 * DINO_CELLA + 1;
      [0, 6, 12].forEach((col) => {
        const sx = px + col * DINO_CELLA + 1;
        const sy = py + PARACADUTE_SPRITE.length * DINO_CELLA;
        for (let i = 0; i <= 6; i++) {
          c.fillRect(Math.round(sx + ((cimaX - sx) * i) / 6), Math.round(sy + ((my - sy) * i) / 6), 1, DINO_CELLA);
        }
      });
    }
    dinoPixel(c, MINA_AEREA_SPRITE, ox, my, { s: "#c9c9ce", "#": "#4a4a52", l: "#8a8a92", r: lucina });
  } else {
    const p = (posa + o.fase) % 2;
    const y = terra - o.sopra - o.h - p * DINO_CELLA;
    const colori = { "#": FANTASMA_ARANCIO, h: "#f4f4f5", c: "#c9c9ce", w: "#f4f4f5", k: "#141414" };
    dinoPixel(c, FANTASMA_TESTA, ox, y, colori);
    dinoPixel(c, FANTASMA_GONNA[p], ox, y + FANTASMA_TESTA.length * DINO_CELLA, colori);
  }
}

/** Lo zaino sulla schiena e, se spinge, la fiamma sotto l'ugello: arancio
 * fuori, giallo dentro, punta rossa, che guizza. */
function dinoDisegnaJetpack(c, x0, y0) {
  const px = x0 + 2;
  const py = y0 + 9;
  c.imageSmoothingEnabled = false;
  c.drawImage(dinoTela("zaino", JETPACK_ZAINO, JETPACK_COLORI), px, py, JETPACK_ZAINO[0].length, JETPACK_ZAINO.length);
  c.imageSmoothingEnabled = true;
  if (!dinoJetSpinge()) return;
  const t = dino.corsa;
  const cx = px + 3; // sotto l'ugello
  const by = py + JETPACK_ZAINO.length; // il fondo dello zaino
  const lung = 5 + ((Math.floor(t / 35) * 7) % 5);
  for (let r = 0; r < lung; r++) {
    const k = r / lung;
    const ancora = r < lung - 1;
    c.fillStyle = k < 0.45 ? "#ff9a2e" : k < 0.8 ? "#ff6a1a" : "#ff3b1a";
    c.fillRect(cx - (k < 0.6 ? 1 : 0), by + r, k < 0.6 ? 3 : 1, 1);
    if (ancora && k < 0.7) {
      c.fillStyle = "#ffe27a";
      c.fillRect(cx, by + r, 1, 1);
    }
  }
}

/** Il dinosauro (DINO_SPRITE). Le celle da 1 unità sono 3,5 px veri sul
 * telefono: a rettangoli verrebbero le righine fra una cella e l'altra,
 * quindi lo sprite si compone a 1 px per cella su una tela a parte (in
 * cache) e si ingrandisce senza sfumare. La stella cambia la tinta, e luce,
 * ombra e narice ne derivano. */
function dinoDisegnaDino(c, { x0, y0, forma, corre, giu, sbatte, sfarfalla }) {
  if (sfarfalla) return;
  const posa = corre ? Math.floor(dino.passo / 90) % 2 : 0;
  const morto = dino.stato === "fine";
  const tinta = forma === "stella" ? STELLA_COLORI[Math.floor(dino.corsa / 80) % STELLA_COLORI.length] : DINO_ARANCIO;
  // occhio bianco quando ti schianti, come il dinosauro di Chrome
  const colori = dinoColori(tinta, sbatte ? tinta : morto ? "#f4f4f5" : "#141414", sbatte ? tinta : morto ? "#141414" : "#ffffff");
  // cuffie azzurre col potere delle cuffie
  if (forma === "cuffie") Object.assign(colori, { h: "#c9f1ff", H: "#5fb8d9", C: "#3f9cc4", c: "#7fd8ff", k: "#e6f9ff" });
  const righe = dinoRighe(posa, giu);
  c.imageSmoothingEnabled = false;
  c.drawImage(dinoTela(`${posa}|${giu}|${Object.values(colori).join()}`, righe, colori), x0, y0, DINO_SPRITE[0].length, righe.length);
  c.imageSmoothingEnabled = true;
}

/** I colori del dinosauro (DINO_SPRITE) per una tinta: luce, ombra e narice
 * ne derivano; occhio e riflesso a parte. */
function dinoColori(tinta, occhio = "#141414", riflesso = "#ffffff") {
  return {
    "#": tinta,
    l: dinoMescola(tinta, "#ffffff", 0.3),
    d: dinoMescola(tinta, "#000000", 0.2),
    n: dinoMescola(tinta, "#000000", 0.55),
    e: occhio,
    w: riflesso,
    h: "#f4f4f5",
    H: "#a9a9b1",
    C: "#9a9aa2",
    c: "#c9c9ce",
    k: "#f4f4f5",
  };
}

/** Godzilla (GODZILLA_SPRITE), a 1 px per cella su una tela in cache come il
 * dinosauro. Passo pesante (zampe ogni 150 ms). Caricando il soffio la
 * cresta si accende d'azzurro dalla coda alla testa, con un alone; a carica
 * piena e mentre soffia la bocca è aperta. scala < 1 e bianco servono alla
 * trasformazione; sbiadito è il lampeggio degli ultimi secondi. */
function dinoDisegnaGodzilla(c, { x0, terra, scala, bianco, sbiadito, corre }) {
  const s = dino.soffio;
  const k = dino.carica;
  // quanto è carico: dalla coda alla testa; mentre soffia, tutto
  const carica = s ? 1 : k ? Math.min(1, (dino.corsa - k.inizio) / SOFFIO_CARICA) : 0;
  const aperta = !!s || carica >= 1;
  const posa = corre ? Math.floor(dino.passo / 150) % 2 : 0;
  const righe = dinoGodzillaRighe(posa, aperta);
  const g = GODZILLA_SCALA * scala;
  const w = Math.round(GODZILLA_W * g);
  const h = Math.round(GODZILLA_H * g);
  const x = x0;
  const y = Math.round(terra - dino.y - h);
  const colori = bianco ? Object.fromEntries(Object.keys(GODZILLA_COLORI).map((ch) => [ch, "#ffffff"])) : GODZILLA_COLORI;
  c.save();
  c.imageSmoothingEnabled = false;
  if (sbiadito) c.globalAlpha = 0.45;
  c.drawImage(dinoTela(`godz|${posa}|${aperta}|${bianco ? "b" : ""}`, righe, colori), x, y, w, h);
  if (carica > 0 && !bianco) {
    // le placche accese, solo sotto la linea che sale con la carica (la
    // cresta va dalla riga 4 alla 54); a carica piena pulsano
    const piena = carica >= 1;
    const taglio = Math.round((4 + (1 - carica) * 50) * g);
    c.beginPath();
    c.rect(x - 4, y + taglio, w + 8, h - taglio + 4);
    c.clip();
    const alone = dinoTela(`godz-alone|${posa}|${aperta}`, righe, { p: "#38c8ff", P: "#38c8ff", q: "#38c8ff" });
    c.globalCompositeOperation = "lighter";
    c.globalAlpha = (piena ? 0.4 + 0.15 * Math.sin(dino.corsa / 50) : 0.35) * (sbiadito ? 0.45 : 1);
    [
      [-2, 0],
      [2, 0],
      [0, -2],
      [-1, -1],
    ].forEach(([dx, dy]) => c.drawImage(alone, x + dx, y + dy, w, h));
    c.globalCompositeOperation = "source-over";
    c.globalAlpha = sbiadito ? 0.45 : 1;
    c.drawImage(dinoTela(`godz-luce|${posa}|${aperta}`, righe, { p: "#e6fcff", P: "#b8f2ff", q: "#38c8ff" }), x, y, w, h);
  }
  c.restore();
  // a carica piena, prima di lasciare: la bocca che brilla
  if (carica >= 1 && !s) {
    const b = dinoBocca();
    const r = 3 + Math.round(1.5 + 1.5 * Math.sin(dino.corsa / 45));
    c.save();
    c.globalCompositeOperation = "lighter";
    c.fillStyle = "rgba(80, 200, 255, 0.45)";
    c.fillRect(Math.round(b.x) - r, Math.round(b.y) - r, 2 * r, 2 * r);
    c.fillStyle = "rgba(240, 253, 255, 0.9)";
    c.fillRect(Math.round(b.x) - 1, Math.round(b.y) - 1, 3, 3);
    c.restore();
  }
}

/** Le righe di Godzilla per posa delle zampe e bocca, in cache. */
const _godzillaRighe = new Map();
function dinoGodzillaRighe(posa, aperta) {
  const chiave = `${posa}|${aperta}`;
  let righe = _godzillaRighe.get(chiave);
  if (righe) return righe;
  righe = [...GODZILLA_SPRITE, ...GODZILLA_ZAMPE[posa]];
  if (aperta) righe.splice(12, GODZILLA_APERTA.length, ...GODZILLA_APERTA);
  _godzillaRighe.set(chiave, righe);
  return righe;
}

/** Corpo e zampe in una griglia sola; tenendo il tempo il corpo scende di
 * giu celle, sopra le zampe. In cache. */
const _dinoRighe = new Map();
function dinoRighe(posa, giu) {
  const chiave = `${posa}|${giu}`;
  let righe = _dinoRighe.get(chiave);
  if (righe) return righe;
  righe = [...DINO_SPRITE.map((r) => ".".repeat(r.length)), ...DINO_ZAMPE[posa]];
  DINO_SPRITE.forEach((riga, r) => {
    const dove = r + giu;
    righe[dove] = [...riga].map((ch, i) => (ch !== "." ? ch : righe[dove][i])).join("");
  });
  _dinoRighe.set(chiave, righe);
  return righe;
}

/** Sprite a 1 px per cella su una tela a parte, in cache per chiave. */
const _dinoTele = new Map();
function dinoTela(chiave, righe, colori) {
  let tela = _dinoTele.get(chiave);
  if (tela) return tela;
  if (_dinoTele.size > 160) _dinoTele.clear();
  tela = document.createElement("canvas");
  tela.width = righe[0].length;
  tela.height = righe.length;
  dinoPixel(tela.getContext("2d"), righe, 0, 0, colori, 1);
  _dinoTele.set(chiave, tela);
  return tela;
}

/** La bolla dello scudo a 1 px per unità (in cache): bordo blu chiaro con
 * un alone fuori (due giri), dentro un velo più forte verso il bordo, un
 * riflesso fisso in alto a sinistra e uno che gira (giro 0-15; -1 = solo
 * il bordo, per l'anello di quando si rompe). */
function dinoTelaBolla(rx, ry, giro) {
  const chiave = `bolla|${rx}|${ry}|${giro}`;
  let tela = _dinoTele.get(chiave);
  if (tela) return tela;
  tela = document.createElement("canvas");
  tela.width = 2 * rx + 7;
  tela.height = 2 * ry + 7;
  const g = tela.getContext("2d");
  const cx = rx + 3;
  const cy = ry + 3;
  const media = (rx + ry) / 2;
  const gira = (giro / 16) * Math.PI * 2;
  for (let y = 0; y < tela.height; y++) {
    for (let x = 0; x < tela.width; x++) {
      const dx = (x + 0.5 - cx) / rx;
      const dy = (y + 0.5 - cy) / ry;
      const e = (Math.hypot(dx, dy) - 1) * media; // unità dal bordo, fuori > 0
      const a = Math.atan2(dy, dx);
      let colore = null;
      // il riflesso che gira accende di bianco il bordo dove passa
      const luce = giro >= 0 && Math.abs(Math.atan2(Math.sin(a - gira), Math.cos(a - gira))) < 0.45;
      if (e > -1 && e <= 0) colore = luce ? "rgba(240, 250, 255, 1)" : "rgba(130, 205, 255, 0.95)";
      else if (e > -2 && e <= -1) colore = luce ? "rgba(190, 230, 255, 0.8)" : "rgba(70, 160, 255, 0.6)";
      else if (e > 0 && e <= 1.2) colore = "rgba(50, 130, 255, 0.5)";
      else if (e > 1.2 && e <= 2.4) colore = "rgba(40, 110, 255, 0.2)";
      else if (giro >= 0 && e > -3.4 && e <= -2 && a > -2.7 && a < -1.65) colore = "rgba(230, 246, 255, 0.8)"; // riflesso fisso
      else if (giro >= 0 && e <= -2) colore = e > -5 ? "rgba(60, 150, 255, 0.26)" : "rgba(60, 150, 255, 0.12)";
      if (!colore) continue;
      g.fillStyle = colore;
      g.fillRect(x, y, 1, 1);
    }
  }
  _dinoTele.set(chiave, tela);
  return tela;
}

/** Due colori #rrggbb mescolati (k = quanto del secondo). */
function dinoMescola(a, b, k) {
  const x = parseInt(a.slice(1), 16);
  const y = parseInt(b.slice(1), 16);
  const ch = (s) => Math.round(((x >> s) & 255) * (1 - k) + ((y >> s) & 255) * k);
  return `#${((1 << 24) | (ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).slice(1)}`;
}

function dinoPixel(c, righe, x0, y0, colori, cella = DINO_CELLA) {
  for (let r = 0; r < righe.length; r++) {
    const riga = righe[r];
    for (let col = 0; col < riga.length; col++) {
      const colore = colori[riga[col]];
      if (!colore) continue;
      c.fillStyle = colore;
      c.fillRect(x0 + col * cella, y0 + r * cella, cella, cella);
    }
  }
}

// —— SUONI DEL GIOCO (07/10, Vitto: «diamo al mini game un soundpack; occhio:
// se Crackify sta facendo partire musica niente suono del gioco, se la musica
// non è in riproduzione suono sì»). Bip a 8 bit: salto, doppio bip ogni 100
// punti, schianto, fanfara del record; dal 08/10 anche oggetto preso, soffio
// di Godzilla, ostacolo spaccato, scudo che para, drop del basso, pozione e
// la finestra d'errore di Windows.
// Sull'iPhone li suona il NATIVO (NativeAudioPlugin.suonoGioco, AVAudioEngine):
// la prima versione in Web Audio dentro la WebView arrivava a sprazzi («un
// paio di bip ogni tanto, non come pianificato»), e Vitto: «l'audio dovrebbe
// essere nativo iOS, non WebKit». Lì si controlla anche la regola, nel
// momento esatto del bip (musica di Crackify che suona o parte, o un'altra
// app). Qui sotto resta il Web Audio solo per il browser (i test). ——
let _dinoAudio = null;
let _dinoAudioRiposo = null;
let _dinoRumore = null;
const DINO_DIAG = true; // TEMPORANEO: logga ogni bip, da spegnere a prova finita

/** Musica di Crackify che suona o sta partendo (play() mette subito
 * paused = false): il gioco tace. Sull'iPhone lo ricontrolla il nativo. */
function dinoMusicaAttiva() {
  try {
    return !!(audio && audio.src && !audio.paused);
  } catch (_) {
    return false;
  }
}

/** Al tocco (solo browser): crea o risveglia il contesto Web Audio, che i
 * browser concedono solo dentro un gesto. Sull'iPhone non serve: suona il
 * nativo. */
function dinoSuonoSveglia() {
  if (_nativeAudioPlugin || dinoMusicaAttiva()) return;
  try {
    if (!_dinoAudio) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      _dinoAudio = new AC();
    }
    if (_dinoAudio.state === "suspended") _dinoAudio.resume().catch(() => {});
  } catch (_) {}
}

/** Spegne l'audio del gioco fra `dopo` ms (0 = subito). */
function dinoSuonoRiposa(dopo) {
  clearTimeout(_dinoAudioRiposo);
  _dinoAudioRiposo = setTimeout(() => {
    _dinoAudioRiposo = null;
    if (_dinoAudio && _dinoAudio.state === "running" && dino.stato !== "corsa") {
      _dinoAudio.suspend().catch(() => {});
    }
  }, dopo);
}

function dinoSuono(nome) {
  if (dinoMusicaAttiva()) return;
  if (_nativeAudioPlugin) {
    _nativeAudioPlugin
      .suonoGioco({ nome })
      .then((r) => {
        // nella console nativa (build di debug): perché un bip non è partito.
        // DINO_DIAG = true stampa anche quelli suonati (prova del 07/10)
        if (r && r.suonato === false) console.log(`[DINO] ${nome} non suonato: ${r.motivo}`);
        else if (DINO_DIAG) console.log(`[DINO] ${nome} suonato`);
      })
      .catch((e) => console.log(`[DINO] ${nome} errore: ${e && e.message}`));
    return;
  }
  const ctx = _dinoAudio;
  if (!ctx) return;
  clearTimeout(_dinoAudioRiposo);
  _dinoAudioRiposo = null;
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  const t = ctx.currentTime + 0.01;
  const uscita = ctx.createGain();
  uscita.gain.value = 0.14; // bip, non concerto
  uscita.connect(ctx.destination);
  // onda quadra (il suono degli 8 bit), da f1 a f2, con attacco secco
  const tono = (f1, f2, inizio, durata, vol = 1) => {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = "square";
    o.frequency.setValueAtTime(f1, t + inizio);
    if (f2 !== f1) o.frequency.exponentialRampToValueAtTime(f2, t + inizio + durata);
    g.gain.setValueAtTime(0.0001, t + inizio);
    g.gain.exponentialRampToValueAtTime(vol, t + inizio + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + inizio + durata);
    o.connect(g);
    g.connect(uscita);
    o.start(t + inizio);
    o.stop(t + inizio + durata + 0.02);
  };
  // rintocco di campana: sinusoidi sulla fondamentale e su due armonici, che
  // si smorzano (non è un 8 bit: serve al suono dell'errore di Windows)
  const campana = (f, inizio, durata, vol) => {
    [
      [1, 1],
      [2, 0.3],
      [3.01, 0.12],
    ].forEach(([k, a]) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "sine";
      o.frequency.setValueAtTime(f * k, t + inizio);
      g.gain.setValueAtTime(0.0001, t + inizio);
      g.gain.exponentialRampToValueAtTime(vol * a, t + inizio + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + inizio + durata);
      o.connect(g);
      g.connect(uscita);
      o.start(t + inizio);
      o.stop(t + inizio + durata + 0.02);
    });
  };
  // colpo di rumore passato da un passa-basso, che si smorza (il «bonk»
  // dello schianto, il botto di un ostacolo spaccato)
  const rumore = (durata, taglio, inizio = 0, vol = 0.7) => {
    if (!_dinoRumore) {
      _dinoRumore = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.25), ctx.sampleRate);
      const d = _dinoRumore.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    const r = ctx.createBufferSource();
    const filtro = ctx.createBiquadFilter();
    const g = ctx.createGain();
    r.buffer = _dinoRumore;
    filtro.type = "lowpass";
    filtro.frequency.value = taglio;
    g.gain.setValueAtTime(vol, t + inizio);
    g.gain.exponentialRampToValueAtTime(0.0001, t + inizio + durata);
    r.connect(filtro);
    filtro.connect(g);
    g.connect(uscita);
    r.start(t + inizio);
  };
  if (BOSS_SUONI[nome]) {
    BOSS_SUONI[nome](tono, campana, rumore); // i suoni del boss (boss.js)
  } else if (nome === "salto") {
    tono(620, 980, 0, 0.09, 0.8);
  } else if (nome === "cento") {
    tono(1046, 1046, 0, 0.07, 0.7);
    tono(1046, 1046, 0.1, 0.1, 0.7);
  } else if (nome === "schianto") {
    tono(260, 70, 0, 0.28);
    rumore(0.14, 900);
  } else if (nome === "record") {
    // do-mi-sol-do dopo lo schianto
    [523, 659, 784, 1046].forEach((f, i) => tono(f, f, 0.34 + i * 0.09, 0.1, 0.75));
  } else if (nome === "oggetto") {
    // oggetto preso: arpeggio che sale, sol-do-mi-sol
    [784, 1046, 1318, 1568].forEach((f, i) => tono(f, f, i * 0.06, i === 3 ? 0.14 : 0.06, 0.6));
  } else if (nome.startsWith("carica")) {
    // una tacca della carica del soffio: bip che sale a ogni tacca (1-6),
    // l'ultima doppia
    const n = Number(nome.slice(6)) || 1;
    const f = 330 * Math.pow(1.19, n);
    tono(f, f * 1.06, 0, 0.06, 0.5);
    if (n === 6) tono(f * 1.5, f * 1.5, 0.07, 0.08, 0.5);
  } else if (nome === "soffio") {
    // il soffio atomico: botto grave, ruggito di rumore e fischio che scende
    tono(90, 40, 0, 0.6, 1);
    tono(1400, 500, 0, 0.5, 0.3);
    rumore(0.7, 1800);
  } else if (nome === "sfiata") {
    // lasciato troppo presto: uno sbuffo
    tono(300, 150, 0, 0.12, 0.35);
    rumore(0.15, 1200);
  } else if (nome === "trasforma") {
    // diventa Godzilla: sale, poi il ruggito (rumore grave)
    tono(110, 440, 0, 0.42, 0.9);
    tono(220, 880, 0.05, 0.38, 0.45);
    rumore(0.5, 500);
  } else if (nome === "torna") {
    // torna dinosauro: scende, con lo sbuffo
    tono(660, 165, 0, 0.34, 0.6);
    rumore(0.2, 2200);
  } else if (nome === "scoppio") {
    // ostacolo spaccato: botto basso col rumore
    tono(180, 50, 0, 0.2, 0.9);
    rumore(0.2, 1400);
  } else if (nome === "scudo") {
    // lo scudo para il colpo e si spegne: due note di vetro che scendono
    tono(2093, 1046, 0, 0.16, 0.6);
    tono(1568, 784, 0.02, 0.14, 0.4);
  } else if (nome === "drop") {
    // il drop della boombox: rullante che accelera e sale (0,35 s), poi la
    // botta che sprofonda nel grave e altri due colpi di cassa a tempo
    [0, 0.09, 0.17, 0.23, 0.28, 0.32].forEach((q, i) => {
      rumore(0.04, 3500, q, 0.25 + i * 0.08);
      tono(300 * Math.pow(1.3, i), 330 * Math.pow(1.3, i), q, 0.04, 0.2 + i * 0.05);
    });
    tono(110, 32, 0.35, 0.6, 1);
    rumore(0.35, 260, 0.35);
    tono(100, 35, 0.6, 0.25, 0.6);
    tono(100, 35, 0.85, 0.25, 0.4);
  } else if (nome === "jet") {
    // jetpack: un soffio di propulsore, ripetuto finché spinge
    rumore(0.1, 1100, 0, 0.3);
  } else if (nome === "pozione") {
    // pozione: scivolata in giù, ci si rimpicciolisce
    tono(1568, 392, 0, 0.3, 0.6);
    tono(1175, 294, 0.05, 0.25, 0.4);
  } else if (nome === "errore") {
    // l'errore di Windows XP (Vitto: «col suo indimenticabile suono»):
    // ricostruito a orecchio, non il file di Microsoft. Due rintocchi di
    // campana che scendono, il secondo con l'ottava sotto, e un'eco corta
    campana(659, 0, 0.6, 0.9);
    campana(494, 0.12, 0.85, 0.9);
    campana(247, 0.12, 0.85, 0.35);
    campana(659, 0.07, 0.5, 0.22);
    campana(494, 0.19, 0.7, 0.22);
  }
}

// —— IMPOSTAZIONI DEL GIOCO (08/10, Vitto: «un pulsante di impostazioni dove
// puoi scegliere la modalità di gioco NORMALE, CRAZY MODE e DEFAULT DINO, e
// una leggenda oggetti e ostacoli per utenti; basta che sia una UI bella
// visivamente»). Il foglio #dinoMenu (index.html) sta sopra a tutto, anche
// allo schermo intero. Scritte a pixel e icone le disegna il gioco stesso,
// con gli sprite veri ingranditi di un numero intero di pixel veri (niente
// celle sfocate o disuguali); la modalità scelta ha l'icona che corre. ——
let _dinoMenuGiro = 0;
// DEBUG boss: da togliere (Vitto 08/10, per provare tutto dal telefono). Il
// pannello «Debug» del menu (#dinoDebug, index.html) ha un bottone per ogni
// boss (BOSS_ORDINE), i trucchi (immortale, vinci/perdi il boss, veloce/
// lento), ogni potere (OGGETTI), ogni cattivo (DINO_TIPI e l'icona di
// Windows) e i punteggi appena sotto i fuochi (999/1999/2999):
// data-debug="tipo:valore[:variante]", lo esegue dinoDebug
let _dinoDebugImmortale = false; // lo legge dinoSchianto
const DINO_DEBUG_LENTO = 2; // la velocità più bassa di «Lento»
const DINO_DEBUG_NOMI = { piccolo: "Mixer", grande: "Cristalli", fantasma: "Fantasma", mina: "Mina", paracadute: "Paracadute" };
function dinoDebugRiempi(menu) {
  const griglia = menu.querySelector("#dinoDebug .dino-debug-griglia");
  if (!griglia) return;
  if (!griglia.childElementCount) {
    const stile = "min-width:0;padding:7px 2px;border:1px solid rgba(255,122,42,.55);border-radius:8px;background:rgba(255,122,42,.14);color:#ffb27a;font:inherit;font-size:.66rem;font-weight:800;letter-spacing:.03em;line-height:1.15;text-transform:uppercase;white-space:normal;overflow-wrap:anywhere";
    const cattivi = [];
    for (const n of Object.keys(DINO_TIPI)) {
      const nome = DINO_DEBUG_NOMI[n] || n;
      // il fantasmino esce basso (si salta) o alto (si passa sotto): uno per verso
      if (n === "fantasma") cattivi.push([`cattivo:${n}:basso`, `${nome} basso`], [`cattivo:${n}:alto`, `${nome} alto`]);
      else cattivi.push([`cattivo:${n}`, nome]);
    }
    cattivi.push(["cattivo:virus", "Windows"]);
    const gruppi = [
      ["Boss", (typeof BOSS_ORDINE !== "undefined" ? BOSS_ORDINE : []).map((n) => [`boss:${n}`, BOSS_GIOCHI[n].titolo.replace(/!/g, "")])],
      ["Trucchi", [["trucco:immortale", "Immortale"], ["trucco:vinci", "Vinci boss"], ["trucco:perdi", "Perdi boss"], ["trucco:veloce", "Veloce"], ["trucco:lento", "Lento"]]],
      ["Poteri", Object.keys(OGGETTI).map((k) => [`potere:${k}`, OGGETTI[k].nome.replace(/!/g, "")])],
      ["Cattivi", cattivi],
      ["Punti", [999, 1999, 2999].map((v) => [`punti:${v}`, String(v)])],
    ];
    for (const [titolo, voci] of gruppi) {
      const t = document.createElement("div");
      t.textContent = titolo;
      t.style.cssText = "grid-column:1/-1;margin-top:2px;font-size:.6rem;opacity:.75";
      griglia.appendChild(t);
      for (const [cosa, etichetta] of voci) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.dataset.debug = cosa;
        btn.textContent = etichetta;
        btn.style.cssText = stile;
        griglia.appendChild(btn);
      }
    }
  }
  dinoDebugEtichette(menu);
}
/** L'interruttore «Immortale» dice com'è messo, e acceso si vede. */
function dinoDebugEtichette(menu) {
  const b = menu && menu.querySelector('[data-debug="trucco:immortale"]');
  if (!b) return;
  b.textContent = `Immortale: ${_dinoDebugImmortale ? "sì" : "no"}`;
  b.setAttribute("aria-pressed", String(_dinoDebugImmortale));
  b.style.background = _dinoDebugImmortale ? "rgba(255,122,42,.55)" : "rgba(255,122,42,.14)";
  b.style.color = _dinoDebugImmortale ? "#1a0c02" : "#ffb27a";
}
/** In corsa (stesso schema di window.__dinoBoss in boss.js): dalla pausa
 * riprende, altrimenti (se `nuova`) parte una partita nuova. */
function dinoDebugCorsa(nuova) {
  if (dino.stato === "corsa") return true;
  if (dino.stato === "pausa") dino.stato = "corsa";
  else if (nuova) {
    dinoNuovaPartita();
    dino.stato = "corsa";
    dino.corsa = DINO_SGOMBRO; // via subito, senza i primi 3 s vuoti
  } else return false;
  dinoAvvia();
  return true;
}
function dinoDebug(cosa) {
  const [tipo, valore, variante] = cosa.split(":");
  // l'interruttore lascia il menu aperto: si vede subito «sì/no»
  if (cosa === "trucco:immortale") {
    _dinoDebugImmortale = !_dinoDebugImmortale;
    dinoDebugEtichette(document.getElementById("dinoMenu"));
    return;
  }
  chiudiMenuDino();
  // dopo l'uscita del menu (200 ms), sennò il primo tocco del minigioco
  // cadrebbe sul foglio che sta scendendo
  setTimeout(() => {
    if (cosa === "trucco:vinci" || cosa === "trucco:perdi") {
      // solo con un boss nel minigioco: l'esito lo legge dinoBossPasso
      const b = dino.boss;
      if (!b || b.fase !== "gioco") return;
      dinoDebugCorsa(false);
      b.esito = cosa === "trucco:vinci" ? "vinto" : "perso";
      dinoBossFase(b, "esito");
      return;
    }
    dinoDebugCorsa(true);
    if (tipo === "boss") {
      if (window.__dinoBoss) window.__dinoBoss(valore);
    } else if (tipo === "potere") {
      if (!OGGETTI[valore]) return;
      dino.potere = null;
      dinoPrendi({ tipo: valore, x: 0, w: 18, h: 24, sopra: 30 });
    } else if (tipo === "cattivo") {
      dinoDebugCattivo(valore, variante);
    } else if (tipo === "punti") {
      dino.punti = Number(valore) || 0;
    } else if (cosa === "trucco:veloce") {
      // oltre DINO_VEL_MAX il passo la riporterebbe giù da sola
      dino.velocita = Math.min(DINO_VEL_MAX, dino.velocita + 2);
    } else if (cosa === "trucco:lento") {
      dino.velocita = Math.max(DINO_DEBUG_LENTO, dino.velocita - 2);
    }
  }, 220);
}
/** Il cattivo `tipo` subito al bordo destro (fuori schermo: arriva in 1-2 s),
 * dopo quelli già in strada. dinoNuovoOstacolo sceglie a caso fra i tipi che
 * modalità e velocità ammettono: per un attimo li ammette tutti e gli dà solo
 * questo, poi tutto com'era. L'icona di Windows la fa qui, come lui. */
function dinoDebugCattivo(tipo, variante) {
  let o;
  if (tipo === "virus") {
    const minimo = Math.round(18 * dino.velocita + 150 * 0.6);
    o = { tipo: "virus", x: dino.w + 10, w: VIRUS_SPRITE[0].length, h: VIRUS_SPRITE.length, sopra: VIRUS_SOPRA, fase: Math.random() * 6.28, distacco: (minimo + Math.random() * minimo * 0.5) * DINO_K };
    dino.ostacoli.push(o);
  } else {
    if (!DINO_TIPI[tipo]) return;
    const { modo, velocita } = dino;
    dino.modo = "normale";
    dino.velocita = Math.max(velocita, 9);
    dino.storia = [];
    try {
      o = dinoNuovoOstacolo({ soli: [tipo], uno: true });
    } finally {
      dino.modo = modo;
      dino.velocita = velocita;
    }
    if (!o) return;
    if (tipo === "fantasma" && variante) o.sopra = variante === "alto" ? DINO_H + 14 : 4;
  }
  // quelli non ancora in vista gli lasciano il posto; da uno appena entrato
  // sta al distacco minimo (distacco / 1,5), così arriva comunque in 1-2 s
  dino.ostacoli = dino.ostacoli.filter((v) => v === o || v.x < dino.w);
  const prima = dino.ostacoli.filter((v) => v !== o).reduce((m, v) => Math.max(m, v.x + v.w), -Infinity);
  const minimo = o.distacco / 1.5;
  if (prima + minimo > o.x) {
    const d = prima + minimo - o.x;
    o.x += d;
    if (o.tipo === "paracadute") o.discesa = o.sopra / (o.sopra / o.discesa + d);
  }
  dino.coda = { x: o.x, w: o.w, distacco: o.distacco, scarto: o.scarto || 0 };
  return o;
}
/** Immortale: niente morte. Il boss perso fa come se la sconfitta non
 * uccidesse: la soglia del prossimo va avanti (sennò ritorna subito). */
function dinoDebugScampato(o) {
  if (!o || o.tipo !== "boss") return;
  const m = dinoModo();
  const ogni = m.boss ? m.boss.ogni : 1e12;
  if (dino.prossimoBoss < 1e12) {
    do dino.prossimoBoss += ogni;
    while (dino.prossimoBoss <= dino.punti);
  }
}
// /DEBUG boss
let _dinoMenuPronto = false;

/** Un <canvas> del menu da w × h unità, s pixel veri per unità. */
function dinoMenuTela(cv, w, h, s, disegna) {
  const dpr = window.devicePixelRatio || 1;
  cv.width = Math.round(w * s);
  cv.height = Math.round(h * s);
  cv.style.width = `${(w * s) / dpr}px`;
  cv.style.height = `${(h * s) / dpr}px`;
  const c = cv.getContext("2d");
  c.setTransform(s, 0, 0, s, 0, 0);
  c.imageSmoothingEnabled = false;
  c.clearRect(0, 0, w, h);
  disegna(c);
}
/** Pixel veri per unità (interi) perché w × h stia in un quadrato di lato
 * px CSS; con px fisso, quei px CSS per unità arrotondati. */
function dinoMenuScala(w, h, lato, px) {
  const dpr = window.devicePixelRatio || 1;
  if (px) return Math.max(1, Math.round(px * dpr));
  return Math.max(1, Math.floor(Math.min(lato / w, lato / h) * dpr));
}
/** Scritta a pixel del menu, celle da cella px CSS: come il cartellone
 * sfumata dal bianco al colore, ma col solo rilievo di una cella sotto a
 * destra (il contorno scuro, così piccolo, sporcava le lettere). */
function dinoMenuScritta(cv, testo, colore, cella) {
  const lettere = (fn) => {
    let x = 0;
    [...testo.toUpperCase()].forEach((ch) => {
      const gl = DINO_FONT[ch] || DINO_FONT[" "];
      gl.forEach((riga, r) => {
        for (let k = 0; k < riga.length; k++) if (riga[k] === "#") fn(x + k, r);
      });
      x += gl[0].length + 1;
    });
  };
  const righe = ["#ffffff", dinoMescola(colore, "#ffffff", 0.6), dinoMescola(colore, "#ffffff", 0.3), colore, colore, dinoMescola(colore, "#000000", 0.12), dinoMescola(colore, "#000000", 0.25)];
  dinoMenuTela(cv, dinoMisuraScritta(testo, DINO_FONT, 1) + 1, 8, dinoMenuScala(0, 0, 0, cella), (c) => {
    c.fillStyle = dinoMescola(colore, "#000000", 0.7);
    lettere((x, y) => c.fillRect(x + 1, y + 1, 1, 1));
    lettere((x, y) => {
      c.fillStyle = righe[y];
      c.fillRect(x, y, 1, 1);
    });
  });
}

// la leggenda: [larghezza, altezza in unità, disegno]
const DINO_ICONE = {
  mixer: [22, 22, (c) => dinoMixer(c, { w: 22, canali: [18, 22], lc: 8 }, 0, 22)],
  cristallo: [34, 34, (c) => dinoMixer(c, { w: 26, h: 32, canali: [32], lc: 12, cristallo: true, inclina: [0] }, 4, 33)],
  fantasma: [26, 28, (c) => dinoDisegnaOstacolo(c, { tipo: "fantasma", x: 0, w: 26, h: 28, sopra: 0, fase: 0 }, 28, 0)],
  mina: [
    26,
    20,
    (c) => {
      c.translate(4, 6);
      dinoDisegnaOstacolo(c, { tipo: "mina", x: 0, w: 18, h: 10 }, 10, 0, "#ff3b3b");
    },
  ],
  paracadute: [26, 40, (c) => dinoDisegnaOstacolo(c, { tipo: "paracadute", x: 4, w: 18, h: 18, sopra: 1 }, 41, 0, "#ff3b3b")],
  virus: [26, 26, (c) => dinoDisegnaOstacolo(c, { tipo: "virus", x: 4, w: 18, h: 18, sopra: 0, fase: 0 }, 22, 0)],
};
Object.entries(OGGETTI).forEach(([k, def]) => {
  const righe = def.pose ? def.pose[0] : def.sprite;
  const cl = def.cella || DINO_CELLA;
  DINO_ICONE[k] = [righe[0].length * cl, righe.length * cl, (c) => dinoPixel(c, righe, 0, 0, def.colori, cl)];
});

// i boss nella leggenda (fase 5): l'icona è lo sprite vero del minigioco
// (boss.js e i suoi due file); se quel file non c'è o lo sprite ha cambiato
// forma, uno di questi di riserva (celle da 1 unità, stessi colori)
const DINO_LEG_GRANCHIO = ["..#.....#..", "...#...#...", "..#######..", ".##.###.##.", "###########", "#.#######.#", "#.#.....#.#", "...##.##..."];
const DINO_LEG_SCIMMIONE = [
  "....oooooo....",
  "..ooBBBBBBoo..",
  ".oBBBBBBBBBBo.",
  "oBBBBBBBBBBBBo",
  "oBffffBBffffBo",
  "oBoooffffoooBo",
  "oBfwweffewwfBo",
  "oBffffccffffBo",
  "oBfccoccoccfBo",
  "oBcmmmmmmmmcBo",
  ".oBmwmmmmwmBo.",
  "..oBccccccBo..",
  "...oooooooo...",
];
const DINO_LEG_SCIMMIONE_COLORI = { o: "#1c0a04", B: "#8a3a12", f: "#f2b27a", c: "#e89a5c", w: "#ffffff", e: "#141414", m: "#4a1206" };
// il fantasma rosso, 14 x 14 come nel cabinato, che guarda a sinistra
const DINO_LEG_FANTASMA = [
  ".....####.....",
  "...########...",
  "..##########..",
  ".##ww####ww##.",
  ".#wwww##wwww#.",
  ".#bbww##bbww#.",
  "##bbww##bbww##",
  "###ww####ww###",
  "##############",
  "##############",
  "##############",
  "##############",
  "##.###..###.##",
  "#...##..##...#",
];
const DINO_LEG_FANTASMA_COLORI = { "#": "#ff0000", w: "#ffffff", b: "#2121ff" };

/** Uno sprite a 1 px per unità su una tela a parte, o null se il disegno
 * fallisce o resta vuoto (un file dei boss mancante o cambiato). */
function dinoLegTela(w, h, disegna) {
  if (!(w > 0 && h > 0 && w <= 64 && h <= 64)) return null;
  const tela = document.createElement("canvas");
  tela.width = w;
  tela.height = h;
  const c = tela.getContext("2d");
  c.imageSmoothingEnabled = false;
  try {
    disegna(c);
    const d = c.getImageData(0, 0, w, h).data;
    for (let i = 3; i < d.length; i += 4) if (d[i]) return tela;
  } catch (_) {}
  return null;
}
const _dinoIconeBoss = new Map();
/** L'icona di un boss, [w, h, disegno] come DINO_ICONE: l'alieno granchio
 * che arriva sulla strada (nel colore del cartellone), lo scimmione, il
 * fantasma rosso; di riserva quelli qui sopra. */
function dinoIconaBoss(tipo) {
  if (_dinoIconeBoss.has(tipo)) return _dinoIconeBoss.get(tipo);
  const gioco = typeof BOSS_GIOCHI !== "undefined" && BOSS_GIOCHI[tipo];
  const colore = (gioco && gioco.colore) || "#ff8c33";
  // righe valide: stringhe tutte lunghe uguali
  const valide = (r) => (Array.isArray(r) && r.length && typeof r[0] === "string" && r.every((x) => typeof x === "string" && x.length === r[0].length) ? r : null);
  const sprite = (r, colori) => (r ? dinoLegTela(r[0].length, r.length, (c) => dinoPixel(c, r, 0, 0, colori, 1)) : null);
  let tela = null;
  try {
    if (tipo === "invasori" && typeof INV_GRANCHIO !== "undefined") tela = sprite(valide(INV_GRANCHIO[0]), { "#": colore });
    if (tipo === "scimmione" && typeof SC_SCIMMIA !== "undefined" && typeof SC_SCIMMIA_COLORI !== "undefined") tela = sprite(valide(SC_SCIMMIA[0]), SC_SCIMMIA_COLORI);
    if (tipo === "labirinto" && typeof LAB_FANT !== "undefined" && typeof labFantasma === "function") {
      const r = valide(LAB_FANT[0]);
      const rosso = (typeof LAB_FANTASMI !== "undefined" && LAB_FANTASMI[0] && LAB_FANTASMI[0].colore) || "#ff0000";
      const sx = typeof LAB_SINISTRA !== "undefined" ? LAB_SINISTRA : 1;
      if (r) tela = dinoLegTela(r[0].length, r.length, (c) => labFantasma(c, 0, 0, { colore: rosso, dir: sx }, 0, 1));
    }
  } catch (_) {
    tela = null;
  }
  if (!tela) {
    const riserva = { invasori: [DINO_LEG_GRANCHIO, { "#": colore }], scimmione: [DINO_LEG_SCIMMIONE, DINO_LEG_SCIMMIONE_COLORI], labirinto: [DINO_LEG_FANTASMA, DINO_LEG_FANTASMA_COLORI] }[tipo];
    if (riserva) tela = sprite(riserva[0], riserva[1]);
  }
  const ic = tela ? [tela.width, tela.height, (c) => c.drawImage(tela, 0, 0)] : null;
  _dinoIconeBoss.set(tipo, ic);
  return ic;
}

/** Le righe dei boss coi valori veri: nell'ordine di BOSS_ORDINE (badge 1°,
 * 2°, 3°), nome e colore del cartellone, i numeri del labirinto se il suo
 * file li ha, e la nota da DINO_MODI[modo].boss, BOSS_PREMIO, BOSS_REGALO e
 * BOSS_SCONFITTA (mai nomi dei giochi originali). */
function dinoMenuBoss(menu) {
  const ul = menu.querySelector(".dino-leg-boss");
  if (!ul || typeof BOSS_ORDINE === "undefined") return;
  BOSS_ORDINE.forEach((tipo, i) => {
    const li = ul.querySelector(`li[data-boss="${tipo}"]`);
    if (!li) return;
    ul.appendChild(li);
    const g = BOSS_GIOCHI[tipo] || {};
    if (g.titolo) li.querySelector("b").textContent = g.titolo.replace(/!/g, "").trim();
    if (g.colore) li.style.setProperty("--c", g.colore);
    const em = li.querySelector("em");
    if (em) em.textContent = `${i + 1}°`;
  });
  ul.querySelectorAll("li[data-boss]").forEach((li) => {
    if (!BOSS_ORDINE.includes(li.dataset.boss)) li.remove();
  });
  const lab = ul.querySelector('li[data-boss="labirinto"] span');
  // si vince solo a puntini (09/10); BOSS_TEMPO c'è di sicuro: sta in boss.js con BOSS_ORDINE
  if (lab && typeof LAB_PUNTINI === "number") lab.textContent = `Mangia ${LAB_PUNTINI} puntini entro ${Math.round(BOSS_TEMPO / 1000)} secondi.`;
  const nota = menu.querySelector(".dino-leg-nota");
  if (!nota) return;
  const quando = (b) => (b.primo === b.ogni ? `ogni ${b.ogni} punti` : `a ${b.primo} punti, poi ogni ${b.ogni}`);
  const altri = Object.entries(DINO_MODI).filter(([k, m]) => k !== "normale" && m.boss);
  const senza = Object.values(DINO_MODI).filter((m) => !m.boss).map((m) => m.nome);
  const regali = { scaglia: "Godzilla", stella: "la Stella", cuffie: "lo Scudo", basso: "il Boombox", jetpack: "il Jetpack", pozione: "Mini" };
  const regalo = BOSS_REGALO && OGGETTI[BOSS_REGALO] ? ` e ${regali[BOSS_REGALO] || OGGETTI[BOSS_REGALO].nome.replace(/!/g, "")}` : "";
  const persa = BOSS_SCONFITTA === "muori" ? "game over" : BOSS_PENALITA ? `si riparte con ${BOSS_PENALITA} punti in meno` : "si riparte";
  const n = DINO_MODI.normale.boss;
  const prima = n ? `Arrivano ${quando(n)}${altri.length ? ` (${altri.map(([, m]) => `${m.nome.replace(/ mode$/i, "")}: ${quando(m.boss).replace(/ punti$/, "")}`).join("; ")})` : ""}, in quest'ordine. ` : "";
  const pezzi = [[prima], ["Vinci:", "vinci"], [` +${BOSS_PREMIO}${regalo}. `], ["Perdi:", "perdi"], [` ${persa}.`], senza.length ? [` In ${senza.join(" e ")} niente boss.`] : null];
  nota.textContent = "";
  pezzi.filter(Boolean).forEach(([testo, classe]) => {
    if (!classe) return nota.appendChild(document.createTextNode(testo));
    const b = document.createElement("b");
    b.className = classe;
    b.textContent = testo;
    nota.appendChild(b);
  });
}

/** A schermo intero (orizzontale e basso) il foglio ha le righe compatte. La
 * prima volta si mette in ascolto: girando il telefono a foglio aperto,
 * icone e scenette si rifanno della misura giusta. */
let _dinoMenuMq = null;
function dinoMenuOrizzontale() {
  if (!window.matchMedia) return false;
  if (!_dinoMenuMq) {
    _dinoMenuMq = window.matchMedia("(orientation: landscape) and (max-height: 540px)");
    const gira = () => {
      const m = document.getElementById("dinoMenu");
      if (m && dinoMenuAperto()) dinoMenuRiempi(m);
    };
    if (_dinoMenuMq.addEventListener) _dinoMenuMq.addEventListener("change", gira);
    else if (_dinoMenuMq.addListener) _dinoMenuMq.addListener(gira);
  }
  return _dinoMenuMq.matches;
}
/** Le icone della leggenda (sprite veri e boss) a celle intere: in un
 * quadrato da 40 px, 34 a schermo intero; rifatte solo se la misura cambia. */
function dinoMenuIcone(menu) {
  const lato = dinoMenuOrizzontale() ? 34 : 40;
  if (menu.dataset.lato === String(lato)) return;
  menu.dataset.lato = String(lato);
  menu.querySelectorAll(".dino-leg li[data-icona], .dino-leg li[data-boss]").forEach((li) => {
    const ic = li.dataset.boss ? dinoIconaBoss(li.dataset.boss) : DINO_ICONE[li.dataset.icona];
    const cv = li.querySelector("canvas");
    if (ic && cv) dinoMenuTela(cv, ic[0], ic[1], dinoMenuScala(ic[0], ic[1], lato), ic[2]);
  });
}

// le tre modalità: una scenetta ciascuna (posa = passo della corsa)
const DINO_ICONE_MODI = {
  normale: {
    w: 54,
    h: 35,
    px: 4 / 3,
    disegna(c, posa) {
      dinoMenuSuolo(c, 58, 34);
      c.drawImage(dinoTela(`menu|${posa}`, dinoRighe(posa, 0), dinoColori(DINO_ARANCIO)), 2, 6);
      dinoPixel(c, CUFFIE_SPRITE, 32, 0, OGGETTI.cuffie.colori);
    },
  },
  crazy: {
    w: 54,
    h: 55,
    px: 1,
    disegna(c, posa) {
      dinoMenuSuolo(c, 54, 54);
      c.drawImage(dinoTela(`godz|${posa}|true|`, dinoGodzillaRighe(posa, true), GODZILLA_COLORI), 1, 0);
    },
  },
  classico: {
    w: 52,
    h: 35,
    px: 4 / 3,
    disegna(c, posa) {
      dinoMenuSuolo(c, 52, 34);
      c.drawImage(dinoTela(`menu|${posa}`, dinoRighe(posa, 0), dinoColori(DINO_ARANCIO)), 2, 6);
      dinoMixer(c, { w: 12, canali: [20], lc: 8 }, 38, 34);
    },
  },
};
function dinoMenuSuolo(c, w, y) {
  c.fillStyle = "rgba(255, 255, 255, 0.16)";
  c.fillRect(0, y, w, 1);
}

function dinoMenuIconaModo(b, posa) {
  const ic = DINO_ICONE_MODI[b.dataset.modo];
  const cv = b.querySelector(".dino-modo-icona");
  // a schermo intero (orizzontale) le schede sono grandi: scenetta al doppio
  const grande = window.matchMedia && window.matchMedia("(orientation: landscape) and (max-height: 540px)").matches;
  if (ic && cv) dinoMenuTela(cv, ic.w, ic.h, dinoMenuScala(0, 0, 0, ic.px * (grande ? 2 : 1)), (c) => ic.disegna(c, posa));
}

/** Prepara il foglio: la prima volta scritte e icone, ogni volta record e
 * modalità scelta. */
function dinoMenuRiempi(menu) {
  if (!_dinoMenuPronto) {
    _dinoMenuPronto = true;
    menu.querySelectorAll("canvas.dino-px").forEach((cv) => dinoMenuScritta(cv, cv.dataset.px, cv.dataset.colore, Number(cv.dataset.cella) || 2));
    menu.querySelectorAll(".dino-leg li[data-icona]").forEach((li) => {
      const def = OGGETTI[li.dataset.icona];
      if (def) li.style.setProperty("--c", def.colore);
    });
    dinoMenuBoss(menu);
  }
  dinoMenuIcone(menu);
  const pad = (n) => String(n).padStart(5, "0");
  menu.querySelectorAll(".dino-modo").forEach((b) => {
    let r = 0;
    try {
      r = parseInt(localStorage.getItem(DINO_MODI[b.dataset.modo].record) || "0", 10) || 0;
    } catch {}
    b.querySelector(".dino-modo-hi").textContent = r ? `HI ${pad(r)}` : "HI —";
    b.setAttribute("aria-checked", String(b.dataset.modo === dino.modo));
    dinoMenuIconaModo(b, 0);
  });
  menu.dataset.modo = dino.modo;
}

/** In orizzontale (schermo intero) il foglio ha due schede: modalità e
 * leggenda; in verticale si vedono una sotto l'altra. */
function dinoMenuScheda(menu, scheda) {
  menu.dataset.scheda = scheda;
  menu.querySelectorAll(".dino-schede [data-scheda]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.scheda === scheda)));
}

function dinoMenuAperto() {
  const m = document.getElementById("dinoMenu");
  return !!m && !m.classList.contains("hidden");
}
function apriMenuDino() {
  const menu = document.getElementById("dinoMenu");
  if (!menu) return;
  if (dino.stato === "corsa") dino.stato = "pausa";
  dinoMenuRiempi(menu);
  dinoDebugRiempi(menu); // DEBUG boss: da togliere
  dinoMenuScheda(menu, "modi");
  menu.querySelectorAll(".dino-menu-corpo, .dino-menu-col").forEach((el) => (el.scrollTop = 0));
  menu.classList.remove("hidden", "esce");
  menu.setAttribute("aria-hidden", "false");
  // la modalità scelta corre (con «riduci movimento» resta ferma)
  clearInterval(_dinoMenuGiro);
  if (!dinoMotoRidotto()) {
    _dinoMenuGiro = setInterval(() => {
      const b = menu.querySelector(`.dino-modo[data-modo="${dino.modo}"]`);
      if (b) dinoMenuIconaModo(b, Math.floor(performance.now() / (dino.modo === "crazy" ? 150 : 100)) % 2);
    }, 50);
  }
  const sel = menu.querySelector('.dino-modo[aria-checked="true"]');
  if (sel) sel.focus({ preventScroll: true });
}
function chiudiMenuDino() {
  const menu = document.getElementById("dinoMenu");
  if (!menu || menu.classList.contains("hidden") || menu.classList.contains("esce")) return;
  clearInterval(_dinoMenuGiro);
  _dinoMenuGiro = 0;
  // esce in giù (style.css), poi sparisce
  menu.classList.add("esce");
  setTimeout(() => {
    menu.classList.add("hidden");
    menu.classList.remove("esce");
    menu.setAttribute("aria-hidden", "true");
    const b = document.getElementById("dinoMenuBtn");
    if (b && !dinoSchermoAperto()) b.focus({ preventScroll: true });
  }, 200);
}

/** Cambia modalità: la partita (in pausa o finita) si chiude, le regole sono
 * cambiate; record e invito sono quelli della modalità nuova. */
function dinoImpostaModo(m) {
  if (!DINO_MODI[m] || m === dino.modo) return;
  dino.modo = m;
  try {
    localStorage.setItem(DINO_MODO_KEY, m);
  } catch {}
  dino.stato = "riposo";
  dinoPrepara();
  const b = document.getElementById("dinoMenuBtn");
  if (b) b.dataset.modo = m;
  const menu = document.getElementById("dinoMenu");
  if (menu) dinoMenuRiempi(menu);
  dinoVibra("LIGHT");
}

function collegaMenuDino() {
  const btn = document.getElementById("dinoMenuBtn");
  const menu = document.getElementById("dinoMenu");
  if (!btn || !menu) return;
  btn.dataset.modo = dino.modo;
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    apriMenuDino();
  });
  menu.addEventListener("click", (e) => {
    const scheda = e.target.closest(".dino-schede [data-scheda]");
    if (scheda) {
      dinoMenuScheda(menu, scheda.dataset.scheda);
      return;
    }
    const modo = e.target.closest(".dino-modo");
    if (modo) {
      dinoImpostaModo(modo.dataset.modo);
      return;
    }
    // DEBUG boss: da togliere (il contenitore #dinoDebug ha data-debug vuoto)
    const debug = e.target.closest("[data-debug]");
    if (debug) {
      if (debug.dataset.debug) dinoDebug(debug.dataset.debug);
      return;
    }
    if (e.target.closest("[data-chiudi]")) chiudiMenuDino();
  });
  // frecce fra le modalità, Esc chiude
  menu.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      chiudiMenuDino();
      return;
    }
    const modi = [...menu.querySelectorAll(".dino-modo")];
    const i = modi.indexOf(document.activeElement);
    if (i < 0 || !["ArrowDown", "ArrowUp", "ArrowRight", "ArrowLeft"].includes(e.key)) return;
    e.preventDefault();
    const dopo = modi[(i + (e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : modi.length - 1)) % modi.length];
    dopo.focus();
    dinoImpostaModo(dopo.dataset.modo);
  });
}

// —— Il gioco anche sul desktop (08/10, Vitto: «mettilo nella home sotto
// tutto a mo' di banner»): da computer e online il banner intero
// (#offlineCabinato) si sposta in fondo alla Home (#homeDinoSlot); offline o
// sul telefono torna al suo posto sopra le playlist. Gira solo mentre la Home
// è visibile (dinoMisura vuole il riquadro a schermo). ——
let _dinoOrigine = null;
function dinoInHome() {
  const cab = document.getElementById("offlineCabinato");
  return !!cab && !!cab.closest("#homeDinoSlot");
}
/** Lo spazio va al gioco? Sì se è partito almeno una volta e il banner è a
 * schermo (Home da computer, o la vista offline). Se il campo non ha il
 * fuoco glielo dà e salta da qui (poi tasti e rilascio li gestisce lui). */
function dinoSpazio(e) {
  // col menu aperto lo spazio è del bottone che ha il fuoco: senza, la
  // partita (o il minigioco del boss) ripartiva dietro il menu
  if (dinoMenuAperto()) return true;
  const campo = dinoCampo();
  if (!campo || dino.stato === "riposo" || !dinoMisura()) return false;
  if (!(appOfflineMode || dinoInHome())) return false;
  if (e.target !== campo) {
    e.preventDefault();
    campo.focus({ preventScroll: true });
    if (!e.repeat) dinoTocca();
  }
  return true;
}
function dinoSistema() {
  const cab = document.getElementById("offlineCabinato");
  const slot = document.getElementById("homeDinoSlot");
  if (!cab || !slot || _dinoPosto) return;
  const casa = !appOfflineMode && !IS_MOBILE && window.matchMedia("(min-width: 901px)").matches;
  document.documentElement.classList.toggle("dino-home", casa);
  if (casa && cab.parentNode !== slot) {
    _dinoOrigine = { padre: cab.parentNode, dopo: cab.nextSibling };
    slot.appendChild(cab);
    cartelloOffline();
    requestAnimationFrame(() => dinoPrepara());
  } else if (!casa && cab.parentNode === slot && _dinoOrigine) {
    _dinoOrigine.padre.insertBefore(cab, _dinoOrigine.dopo);
    cartelloOffline();
    cab.style.transform = "";
    cab.style.width = "";
    slot.style.height = "";
    dino.zoom = 1;
  }
  adattaHomeDino();
}
/** In Home il banner è largo (anche 1500 px): ingrandito di k/7 come a schermo
 * intero (celle su pixel veri), fino a 10/7, così il mondo resta sui ~900
 * di larghezza e dino e ostacoli non sono minuscoli. */
function adattaHomeDino() {
  const cab = document.getElementById("offlineCabinato");
  const slot = document.getElementById("homeDinoSlot");
  if (!cab || !slot || !dinoInHome()) return;
  const W = slot.clientWidth;
  if (!W) return;
  const zoom = Math.min(10 / 7, Math.max(1, Math.floor((W / 900) * 7) / 7));
  cab.style.transform = zoom > 1 ? `scale(${zoom})` : "";
  cab.style.transformOrigin = "0 0";
  cab.style.width = `${W / zoom}px`;
  slot.style.height = `${Math.ceil((cab.offsetHeight || 192) * zoom)}px`;
  dino.zoom = zoom;
}

(function collegaDino() {
  // un ricaricamento a schermo intero (es. torna la rete) non deve lasciare
  // l'app girata in orizzontale: a ogni avvio si torna al solo verticale
  const orient = pluginOrientamento();
  if (orient) orient.verticale().catch(() => {});
  const campo = dinoCampo();
  if (!campo) return;
  try {
    const m = localStorage.getItem(DINO_MODO_KEY);
    if (DINO_MODI[m]) dino.modo = m;
  } catch {}
  // schermo intero: lo stesso tasto apre e (a schermo intero) richiude
  const grandeBtn = document.getElementById("dinoGrandeBtn");
  if (grandeBtn) {
    grandeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (dinoSchermoAperto()) chiudiSchermoDino();
      else apriSchermoDino();
    });
  }
  collegaMenuDino();
  dinoSistema();
  window.matchMedia("(min-width: 901px)").addEventListener("change", dinoSistema);
  const esciBtn = document.getElementById("dinoSchermoChiudi");
  if (esciBtn) {
    esciBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      chiudiSchermoDino();
    });
  }
  // a schermo intero si salta toccando anche i margini neri attorno
  const schermo = document.getElementById("dinoSchermo");
  if (schermo) {
    schermo.addEventListener("pointerdown", (e) => {
      if (e.target.closest("#dinoSchermoChiudi, #dinoCampo, .dino-tasto")) return;
      e.preventDefault();
      if (dinoBossPuntatore("giu", e)) return;
      dinoTocca();
    });
    schermo.addEventListener("touchstart", (e) => {
      if (!e.target.closest("#dinoSchermoChiudi, .dino-tasto")) e.preventDefault();
    }, { passive: false });
  }
  // le finestre di Windows: quella nel markup fa da modello (dinoDom ne fa
  // una per finestra aperta). La × e OK provano a chiuderla (e ne spunta
  // un'altra): il tocco lì non arriva al gioco, niente salto
  const errori = document.getElementById("dinoErrore");
  const finestra = errori && errori.querySelector(".dino-errore");
  if (finestra) {
    _dinoFinestraModello = finestra.cloneNode(true);
    finestra.remove();
    errori.addEventListener("pointerdown", (e) => {
      const tasto = e.target.closest(".dino-errore-chiudi, .dino-errore-tasti b");
      if (!tasto) return;
      e.preventDefault();
      e.stopPropagation();
      const f = tasto.closest(".dino-errore");
      if (f) dinoChiudiFinestra(Number(f.dataset.id));
    });
  }
  // pointerdown e non click: sul telefono il click arriva dopo, e in un
  // gioco a salti quel ritardo si sente
  campo.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    if (e.pointerType === "mouse") campo.focus({ preventScroll: true });
    // nel minigioco del boss conta dove tocchi (zone, trascinare)
    if (dinoBossPuntatore("giu", e)) return;
    dinoTocca();
  });
  // dito su: Godzilla, se stava caricando, spara il soffio (dinoLascia).
  // Anche fuori dal campo e se iOS annulla il tocco
  const lascia = () => {
    dino.tieni = false;
    dinoLascia();
  };
  ["pointerup", "pointercancel"].forEach((ev) =>
    window.addEventListener(ev, (e) => {
      dinoBossPuntatore("su", e);
      lascia();
    }),
  );
  // il dito che scorre (solo il minigioco del boss lo usa)
  window.addEventListener("pointermove", (e) => dinoBossPuntatore("muovi", e));
  // finestra che perde il fuoco (Alt-Tab): i keyup non arrivano più. A metà
  // minigioco, che è a tempo, anche pausa
  window.addEventListener("blur", () => {
    dinoBossMolla();
    if (dino.boss && dino.boss.fase === "gioco" && dino.stato === "corsa") dino.stato = "pausa";
  });
  // i rilasci dei tasti del minigioco anche se il fuoco è passato altrove
  window.addEventListener("keyup", (e) => dinoBossTasto(e, false));
  // tenendo premuto iOS apriva la lente per spostare il cursore nel testo
  // (Vitto 08/10): fermare il pointerdown non basta, il gesto lungo lo
  // ferma solo il touchstart (non passivo). Il salto resta sul pointerdown.
  campo.addEventListener("touchstart", (e) => e.preventDefault(), { passive: false });
  // su iOS il gesto che sblocca l'audio è la fine del tocco, non l'inizio:
  // il primo bip aspetta lì (qualche centesimo), poi tutto parte al tocco
  campo.addEventListener("touchend", () => {
    if (_dinoAudio && _dinoAudio.state === "suspended" && dino.stato === "corsa" && !dinoMusicaAttiva()) {
      _dinoAudio.resume().catch(() => {});
    }
  });
  try {
    audio.addEventListener("play", () => dinoSuonoRiposa(0));
  } catch (_) {}
  campo.addEventListener("keydown", (e) => {
    // nel minigioco del boss anche le frecce (e niente salti)
    if (dinoBossTasto(e, true)) return;
    if (e.key === " " || e.key === "Enter" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!e.repeat || dino.tieni) dinoTocca();
    }
  });
  campo.addEventListener("keyup", lascia);
  // cabinato di nuovo visibile (tornando alla griglia) o app di nuovo in
  // primo piano: ridisegna e riaccendi l'atmosfera. Il ResizeObserver scatta
  // quando il riquadro ha davvero la misura nuova, anche passando da
  // nascosto a visibile; il resize resta per i cambi di larghezza
  const riaccendi = () => {
    adattaHomeDino();
    if (_dinoPosto) {
      adattaSchermoDino();
      dinoAvvia();
      return;
    }
    if ((appOfflineMode || dinoInHome()) && dinoMisura()) {
      dinoDisegna();
      dinoAvvia();
    }
  };
  window.addEventListener("resize", riaccendi);
  if (window.ResizeObserver) {
    const ro = new ResizeObserver(riaccendi);
    ro.observe(campo);
    const area = document.getElementById("dinoSchermoArea");
    if (area) ro.observe(area);
    const slot = document.getElementById("homeDinoSlot");
    if (slot) ro.observe(slot);
  }
  // in background la partita (e il boss) va in pausa: il rAF in sospeso
  // ripartirebbe da solo al ritorno, senza la schermata Pausa
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") riaccendi();
    else if (dino.stato === "corsa") {
      dino.stato = "pausa";
      dino.pausaSfondo = Date.now(); // il rientro online aspetta (dinoInGioco)
    }
  });
})();

/** Dettaglio playlist di un ALTRO utente (sola lettura + adozione brani) */
// —— classifiche Deezer fisse + playlist Deezer cercate a mano ("play
// pigro", vedi charts.py): stessa identica vista, due sole differenze —
// da dove si scaricano i metadati e quale endpoint risolve il play. ——
let openLazyKind = null; // "chart" | "deezer" | null
let openLazyId = null; // slug (chart) o id numerico (playlist Deezer)
let _openLazyTracks = [];

/** Chi apre una playlist vera (o torna alla griglia) deve dimenticare la
 * classifica/playlist Deezer vista prima: play, scarica e cuore della riga
 * comandi guardano openLazyKind PRIMA di openPlaylistId. Da telefono ci
 * pensava la freccia ← dell'intestazione; da desktop la ← non c'è e si
 * cambia pagina dalla barra laterale, quindi il play di "PHONK" suonava la
 * classifica aperta prima (Vitto, 02/10). */
function dimenticaListaPigra() {
  openLazyKind = null;
  openLazyId = null;
  _openLazyTracks = [];
}

function _renderLazyTracklist(label, tracks, saved, download, extra = {}) {
  openPlaylistId = null;
  openPlaylistOwnerId = null;
  _openLazyTracks = tracks;
  setMobileTopbarVisible(false);
  plTitle.textContent = label;
  plStatus.textContent = `${tracks.length} brani`;
  if (plGridHead) plGridHead.classList.add("hidden");
  if (plLibSearchWrap) plLibSearchWrap.classList.add("hidden");
  if (plHero) {
    plHero.classList.remove("hidden");
    if (plHeroTitle) plHeroTitle.textContent = label;
    if (plHeroCover) {
      plHeroCover.classList.remove("pl-hero-cover-saved");
      // ripulisce le classi/badge di un kind precedente (es. si passa da un
      // Daily Mix a una classifica): senza, colore/badge restavano appiccicati
      plHeroCover.classList.remove(
        "discovery-cover",
        "daily-mix-cover",
        "daily-mix-c0",
        "daily-mix-c1",
        "daily-mix-c2",
        "daily-mix-c3",
        "daily-mix-c4",
        "daily-mix-c5",
        "radio-c0",
        "radio-c1",
        "radio-c2",
        "radio-c3",
        "radio-c4"
      );
      if (openLazyKind === "discovery") {
        // copertina fissa "in tema Crackify", non quella del primo brano
        // (che cambia ogni settimana e non c'entra niente col mix) — vedi
        // discoveryCoverHtml, stessa card usata in Home
        plHeroCover.classList.add("discovery-cover");
        plHeroCover.style.backgroundImage = "";
        plHeroCover.innerHTML = discoveryCoverHtml();
        applyHeroColor(plHero, null);
      } else if (openLazyKind === "daily_mix") {
        // stessa card/badge colorato della Home (Vitto: mancavano le scritte
        // colorate qui) — copertina del mix (non tracks[0]): è quella che il
        // backend rigenera ogni giorno insieme al mix, resta coerente con la
        // card Home e cambia da sola quando il Daily Mix si rinnova
        const idx = extra.dailyMixIndex ?? openLazyId ?? 0;
        const colorClass = `daily-mix-c${idx % 5}`;
        plHeroCover.classList.add("daily-mix-cover", colorClass);
        const num = String(idx + 1).padStart(2, "0");
        plHeroCover.innerHTML = `
          <div class="daily-mix-badge">
            <span class="daily-mix-badge-label">Daily Mix</span>
            <span class="daily-mix-badge-num">${num}</span>
          </div>
        `;
        const rawCover =
          extra.dailyMixCoverUrl || (tracks[0] && (tracks[0].cover_hd_url || tracks[0].cover_url));
        const url = rawCover ? proxiedCover(rawCover) : null;
        plHeroCover.style.backgroundImage = url ? `url(${url})` : "";
        applyHeroColor(plHero, url);
      } else if (openLazyKind === "radio") {
        // stesso badge colorato di Daily Mix ma con tavolozza diversa
        // (Vitto: "colori diversi da quelli già presi da daily mix") —
        // copertina della stazione (foto dell'artista seed) invece del
        // primo brano, coerente con la card Home
        const idx = extra.radioIndex ?? openLazyId ?? 0;
        const colorClass = `radio-c${idx % 5}`;
        plHeroCover.classList.add("daily-mix-cover", colorClass);
        const num = String(idx + 1).padStart(2, "0");
        plHeroCover.innerHTML = `
          <div class="daily-mix-badge">
            <span class="daily-mix-badge-label">Radio</span>
            <span class="daily-mix-badge-num">${num}</span>
          </div>
        `;
        const rawCover =
          extra.radioCoverUrl || (tracks[0] && (tracks[0].cover_hd_url || tracks[0].cover_url));
        const url = rawCover ? proxiedCover(rawCover) : null;
        plHeroCover.style.backgroundImage = url ? `url(${url})` : "";
        applyHeroColor(plHero, url);
      } else if (openLazyKind === "similar") {
        // "Musica simile" (dal menu ⋯ del player): stesso badge colorato
        // della Radio ma etichetta "Simili" e nessun numero (non è una
        // delle N stazioni cache-ate, è una radio one-shot per l'artista
        // del brano corrente). openLazyId è l'artist_id (numero grande) —
        // ok per la rotazione colore % 5.
        const idx = Number(openLazyId) || 0;
        plHeroCover.classList.add("daily-mix-cover", `radio-c${idx % 5}`);
        plHeroCover.innerHTML = `
          <div class="daily-mix-badge">
            <span class="daily-mix-badge-label">Simili</span>
          </div>
        `;
        const rawCover =
          extra.similarCoverUrl || (tracks[0] && (tracks[0].cover_hd_url || tracks[0].cover_url));
        const url = rawCover ? proxiedCover(rawCover) : null;
        plHeroCover.style.backgroundImage = url ? `url(${url})` : "";
        applyHeroColor(plHero, url);
      } else {
        // solo tracks[0] a volte risulta senza cover pur avendone una vera
        // (verificato: la riga della stessa traccia più sotto la mostra
        // giusta) — probabile intermittenza della singola chiamata Deezer
        // per quel campo specifico, non un dato davvero assente. Difesa:
        // scorri le prime tracce finché non trovi una cover valida invece
        // di arrenderti al primo tentativo (Vitto, 2026-07-31).
        const heroTrackWithCover = tracks.slice(0, 5).find((t) => t.cover_hd_url || t.cover_url);
        const heroCoverRaw = heroTrackWithCover && (heroTrackWithCover.cover_hd_url || heroTrackWithCover.cover_url);
        if (heroCoverRaw) {
          const url = proxiedCover(heroCoverRaw);
          // stesso debug temporaneo della lista (Vitto, 2026-07-31): qui è
          // la pagina di dettaglio dopo il click sulla card, dove ha
          // segnalato "nada" nonostante lista/ricerca risultino a posto —
          // sonda separata per scoprire se il problema è di dati o di CSS
          const probe = new Image();
          probe.onload = () => debugLog("hero-cover-ok", { label, kind: openLazyKind, url: heroCoverRaw });
          probe.onerror = () => debugLog("hero-cover-fail", { label, kind: openLazyKind, url: heroCoverRaw, proxied: url });
          probe.src = url;
          plHeroCover.style.backgroundImage = `url(${url})`;
          plHeroCover.textContent = "";
          applyHeroColor(plHero, url);
        } else {
          debugLog("hero-cover-missing", { label, kind: openLazyKind });
          plHeroCover.style.backgroundImage = "";
          plHeroCover.textContent = "▤";
          applyHeroColor(plHero, null);
        }
      }
    }
    if (plHeroMetaText) plHeroMetaText.textContent = `${tracks.length} brani · CRACKIFY`;
  }
  if (plActionRow) plActionRow.classList.remove("hidden");
  btnPlPlay.classList.toggle("hidden", !tracks.length);
  if (btnPlShuffle) btnPlShuffle.classList.toggle("hidden", !tracks.length);
  // pulsante offline riusato per il download in blocco lato server (vedi
  // refreshLazyDownloadButton) — visibile solo se già salvata col cuoricino
  refreshLazyDownloadButton(saved, download);
  // cuoricino riusato come SEGNALIBRO (non copia file, vedi saved_playlists.py):
  // salva solo il puntatore al chart/playlist, i brani restano pigri
  if (btnPlAdopt) {
    btnPlAdopt.classList.toggle("hidden", !tracks.length);
    btnPlAdopt.classList.remove("filling", "busy", "fill-done", "fill-fail", "fill-pop");
    btnPlAdopt.classList.toggle("on", !!saved);
    btnPlAdopt.disabled = false;
    btnPlAdopt.title = saved ? "Rimuovi dai segnalibri" : "Salva tra le tue playlist";
    btnPlAdopt.setAttribute("aria-label", btnPlAdopt.title);
  }
  // anti-ban ha senso solo qui (play pigro chart/Deezer) — lato opposto di
  // btnPlPlay nella stessa riga, vedi .pl-antiban-group in style.css
  if (plAntiBanGroup) plAntiBanGroup.classList.remove("hidden");
  if (plAntiBan) plAntiBan.classList.toggle("on", isAntiBanEnabled());
  if (plAntiBanPopover) plAntiBanPopover.classList.remove("open");
  btnPlCreate.classList.add("hidden");
  plList.classList.add("hidden");
  plTracks.classList.remove("hidden");
  plTracks.innerHTML = "";
  showPlTrackSearch();
  tracks.forEach((t, i) => {
    const row = document.createElement("div");
    row.className = "track";
    row.dataset.index = t.index;
    row.innerHTML = `
      <span class="num">${i + 1}</span>
      <div class="art">▤</div>
      <div class="info">
        <div class="title"></div>
        <div class="artist"></div>
      </div>
      <span class="dur"></span>
      <div class="track-actions">
        <button type="button" class="heart-row lazy-track-like heart-fillable" title="Aggiungi alla mia libreria">${heartFillMarkup(16)}</button>
      </div>
    `;
    row.querySelector(".title").textContent = t.title || "—";
    wireArtistName(row.querySelector(".artist"), t.artist, t.artist_id);
    row.querySelector(".dur").textContent = t.duration ? fmtTime(t.duration) : "";
    if (t.cover_url) {
      const art = row.querySelector(".art");
      lazyLoadCover(art, proxiedCover(t.cover_url));
    }
    const likeBtn = row.querySelector(".lazy-track-like");
    // già salvato (charts.py/main.py annotano "saved" per traccia su
    // chart/playlist/Discovery Weekly/Daily Mix/Radio) — cuore pieno subito,
    // senza aspettare un click (bug segnalato da Vitto: non si vedeva mai)
    if (t.saved) likeBtn.classList.add("on");
    likeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      likeLazyTrack(e.currentTarget, lazyItemFromTrack(t));
    });
    montaMenuRiga(row, {
      titolo: t.title, artista: t.artist, artistId: t.artist_id,
      libraryId: t.library_id || null, item: () => lazyItemFromTrack(t),
    });
    row.addEventListener("click", () => playLazyFrom(i));
    plTracks.appendChild(row);
  });
}

async function openChart(slug) {
  registraTappa("chart", [slug]);
  const { signal, gen } = showLoadingOverlay();
  try {
    const data = await apiJson(`/api/charts/${slug}`, null, undefined, undefined, signal);
    openLazyKind = "chart";
    openLazyId = slug;
    _renderLazyTracklist(data.label || "Classifica", data.tracks || [], !!data.saved, data.download);
    const firstTrack = (data.tracks || [])[0];
    recordPlaylistOpen({
      kind: "chart",
      id: slug,
      title: data.label || "Classifica",
      subtitle: "Classifica",
      coverUrl: (firstTrack && (firstTrack.cover_hd_url || firstTrack.cover_url)) || null,
    });
  } catch (err) {
    if (!err.cancelled) toast("Errore classifica: " + (err.message || err));
  } finally {
    hideLoadingOverlay(gen);
  }
}

/** Un Daily Mix (tra i tanti, vedi loadHomeDailyMixes) — stessa vista/
 * stesso "play pigro" di Discovery Weekly, ma openLazyId porta l'indice
 * del mix (ce ne sono N) invece di essere sempre null. Niente cuoricino
 * segnalibro: come Discovery Weekly, non è un chart/playlist da adottare. */
async function openDailyMix(mixIndex) {
  registraTappa("mix", [mixIndex]);
  activatePlaylistsShell();
  const { signal, gen } = showLoadingOverlay();
  try {
    const data = await apiJson("/api/daily-mixes", null, undefined, undefined, signal);
    const mix = (data.mixes || []).find((m) => m.mix_index === mixIndex);
    if (!mix) {
      toast("Daily Mix non trovato");
      return;
    }
    openLazyKind = "daily_mix";
    openLazyId = mixIndex;
    _renderLazyTracklist(mix.label || "Daily Mix", mix.tracks || [], false, null, {
      dailyMixIndex: mixIndex,
      dailyMixCoverUrl: mix.cover_url || null,
    });
    if (btnPlAdopt) btnPlAdopt.classList.add("hidden");
  } catch (err) {
    if (!err.cancelled) toast("Errore Daily Mix: " + (err.message || err));
  } finally {
    hideLoadingOverlay(gen);
  }
}

/** Una stazione radio (tra le tante, vedi loadHomeRadioStations) — stesso
 * "play pigro" di Daily Mix, ma openLazyId porta l'indice della stazione.
 * Niente cuoricino segnalibro: come Daily Mix, non è un chart/playlist da
 * adottare, è generata al volo dall'algoritmo radio di Deezer. */
async function openRadioStation(stationIndex) {
  registraTappa("radio", [stationIndex]);
  activatePlaylistsShell();
  const { signal, gen } = showLoadingOverlay();
  try {
    const data = await apiJson("/api/radio-stations", null, undefined, undefined, signal);
    const station = (data.stations || []).find((s) => s.station_index === stationIndex);
    if (!station) {
      toast("Stazione radio non trovata");
      return;
    }
    openLazyKind = "radio";
    openLazyId = stationIndex;
    // niente "Radio" nel titolo: la copertina lo dice già col badge (stesso
    // pattern di Daily Mix, "niente ripetuto sotto" — Vitto 2026-07-29)
    _renderLazyTracklist(station.subtitle || station.label || "Radio", station.tracks || [], false, null, {
      radioIndex: stationIndex,
      radioCoverUrl: station.cover_url || null,
    });
    if (btnPlAdopt) btnPlAdopt.classList.add("hidden");
  } catch (err) {
    if (!err.cancelled) toast("Errore stazione radio: " + (err.message || err));
  } finally {
    hideLoadingOverlay(gen);
  }
}

/** Mix personale "per te" — stessa vista/stesso "play pigro" di chart e
 * playlist Deezer (vedi _renderLazyTracklist), ma niente cuoricino
 * segnalibro né download in blocco: non è un chart/playlist esterno da
 * "adottare", è già sempre tuo e si rigenera da solo (vedi charts.py). */
async function openDiscoveryWeekly() {
  registraTappa("discovery", []);
  activatePlaylistsShell();
  const { signal, gen } = showLoadingOverlay();
  try {
    const data = await apiJson("/api/discovery-weekly", null, undefined, undefined, signal);
    openLazyKind = "discovery";
    openLazyId = null;
    _renderLazyTracklist(data.label || "Discovery Weekly", data.tracks || [], false, null);
    if (btnPlAdopt) btnPlAdopt.classList.add("hidden");
  } catch (err) {
    if (!err.cancelled) toast("Errore Discovery Weekly: " + (err.message || err));
  } finally {
    hideLoadingOverlay(gen);
  }
}

async function openDeezerPlaylist(id) {
  registraTappa("deezer", [id]);
  const { signal, gen } = showLoadingOverlay();
  try {
    const data = await apiJson(`/api/deezer/playlists/${id}`, null, undefined, undefined, signal);
    openLazyKind = "deezer";
    openLazyId = id;
    _renderLazyTracklist(data.label || "Playlist", data.tracks || [], !!data.saved, data.download);
    const firstTrack = (data.tracks || [])[0];
    recordPlaylistOpen({
      kind: "deezer",
      id,
      title: data.label || "Playlist",
      subtitle: "Playlist",
      coverUrl: (firstTrack && (firstTrack.cover_hd_url || firstTrack.cover_url)) || null,
    });
  } catch (err) {
    if (!err.cancelled) toast("Errore playlist: " + (err.message || err));
  } finally {
    hideLoadingOverlay(gen);
  }
}

function lazyItemFromTrack(t) {
  const cover = t.cover_url ? proxiedCover(t.cover_url) : null;
  const coverHd = t.cover_hd_url
    ? proxiedCover(t.cover_hd_url)
    : t.cover_url
      ? proxiedCover(t.cover_url)
      : null;
  const base = {
    qid: uid(),
    chartIndex: t.index,
    title: t.title || "track",
    artist: t.artist || "",
    artist_id: t.artist_id || null,
    duration: t.duration || 0,
    cover_url: cover,
    cover_hd_url: coverHd,
    previewUrl: t.preview_url || null,
  };
  if (openLazyKind === "chart") return { ...base, source: "chart", chartSlug: openLazyId };
  if (openLazyKind === "discovery") return { ...base, source: "discovery_weekly" };
  if (openLazyKind === "daily_mix") return { ...base, source: "daily_mix", mixIndex: openLazyId };
  if (openLazyKind === "radio") return { ...base, source: "radio", stationIndex: openLazyId };
  // "Musica simile": openLazyId è l'artist_id seme (vedi openSimilarForCurrent)
  if (openLazyKind === "similar") return { ...base, source: "deezer_radio", artistId: openLazyId };
  return { ...base, source: "deezer_playlist", playlistId: openLazyId };
}

function playLazyFrom(startIndex) {
  if (!_openLazyTracks.length) return;
  const items = _openLazyTracks.map((t) => lazyItemFromTrack(t));
  playFromList(items, startIndex, null);
}

/** Pagina artista: cover + nome + top track, "play pigro" come chart/playlist
 * ma vista dedicata volutamente minimale — niente offline/adotta/anti-ban,
 * non hanno senso per un singolo artista (vedi discussione in sessione). */
async function openArtist(artistId) {
  await openDetailPage("artist", artistId);
}

async function openAlbum(albumId) {
  await openDetailPage("album", albumId);
}

/** Una riga brano della pagina artista/album — condivisa dalla lista
 * inline (collassata a ARTIST_COLLAPSED_COUNT) e dalla finestra "tutti i
 * brani" (vedi openArtistTracksModal): stesso markup, stesso comportamento,
 * legge _detailKind (già impostato da openDetailPage) invece di prendere
 * un parametro, così funziona identica da entrambi i chiamanti. */
/* ── Completamento del catalogo artista ───────────────────────────────
 * La pagina artista si apre in ~1s con i brani popolari (6 chiamate a
 * Deezer); il catalogo profondo — quello che si trova solo aprendo album per
 * album — arriva DOPO, un pezzo alla volta, mentre l'utente è già lì a
 * guardare, con barra e tempo stimato (idea di Vitto 2026-08-28). Prima si
 * facevano 102 chiamate in blocco all'apertura: 5s di attesa, metà rifiutate
 * da Deezer per quota, e nel frattempo le canzoni non partivano.
 *
 * REGOLA DA NON ROMPERE: i brani nuovi si APPENDONO in fondo, mai inseriti
 * in mezzo. L'indice della riga finisce in playArtistFrom → play/{index}
 * lato server: riordinare la lista sotto le righe già a schermo vorrebbe
 * dire far partire la canzone sbagliata. Il server rispetta lo stesso patto
 * (vedi _fill_artist_catalog in charts.py). */
function stopArtistCatalogFill() {
  if (_artistFillTimer) {
    clearTimeout(_artistFillTimer);
    _artistFillTimer = null;
  }
  _artistFillId = null;
  if (artistFill) artistFill.classList.add("hidden");
  if (artistFill) artistFill.classList.remove("artist-fill-svanisce");
}

function renderArtistFillProgress(state) {
  if (!artistFill) return;
  const total = state.total || 0;
  const done = Math.min(state.done || 0, total);
  const pct = total ? Math.round((done / total) * 100) : 0;
  artistFill.classList.remove("hidden", "artist-fill-svanisce");
  // mai 0%: una barra completamente vuota sembra rotta, non "in corso"
  if (artistFillBar) artistFillBar.style.width = `${Math.max(4, pct)}%`;
  if (artistFillLabel) {
    const eta = Math.max(1, Math.round(state.eta_sec || 0));
    // corto: dal 04/10 sta nell'angolo in alto a destra dell'intestazione
    artistFillLabel.textContent = `Catalogo · ${done}/${total} album · ~${eta}s`;
  }
}

function refreshArtistTracksCount() {
  // niente più «N brani · in ordine di popolarità»: da desktop dal 30/09
  // (c'è la tabella con l'intestazione), dal 05/10 anche dal telefono (Vitto)
  artistStatus.textContent = "";
  if (artistShowAllBtn && _artistTracks.length > artistCollapsedCount()) {
    artistShowAllBtn.textContent = `Mostra tutti (${_artistTracks.length})`;
    artistShowAllBtn.classList.remove("hidden");
  }
  const modalOpen = artistTracksModal && !artistTracksModal.classList.contains("hidden");
  if (modalOpen && artistTracksModalTitle) {
    artistTracksModalTitle.textContent = `Tutti i brani (${_artistTracks.length})`;
  }
}

function appendArtistTracks(tracks) {
  if (!tracks || !tracks.length) return;
  const modalOpen = artistTracksModal && !artistTracksModal.classList.contains("hidden");
  tracks.forEach((t) => {
    const i = _artistTracks.length;
    _artistTracks.push(t);
    const row = buildArtistTrackRow(t, i);
    row.addEventListener("click", () => playArtistFrom(i));
    if (i >= artistCollapsedCount()) row.classList.add("hidden");
    artistTracksEl.appendChild(row);
    // "Tutti i brani" aperto mentre arrivano: tienilo allineato invece di
    // farlo ripartire da capo (perderebbe la ricerca digitata)
    if (modalOpen && artistTracksModalList) {
      const mrow = buildArtistTrackRow(t, i);
      mrow.addEventListener("click", () => playArtistFrom(i));
      artistTracksModalList.appendChild(mrow);
    }
  });
  refreshArtistTracksCount();
  if (modalOpen) applyArtistTracksModalFilter();
  if (artistTrackSearch && artistTrackSearch.value.trim()) applyArtistTrackFilter();
}

function startArtistCatalogFill(artistId, state) {
  stopArtistCatalogFill();
  if (!state || state.complete || !state.total) return;
  _artistFillId = artistId;
  renderArtistFillProgress(state);
  const tick = async () => {
    _artistFillTimer = null;
    // pagina chiusa o cambiata sotto: smettere è anche il segnale al server
    // di mettere in pausa il completamento (vedi ARTIST_FILL_IDLE_STOP)
    if (_artistFillId !== artistId || openArtistId !== artistId || _detailKind !== "artist") {
      stopArtistCatalogFill();
      return;
    }
    try {
      const data = await apiJson(
        `/api/deezer/artists/${artistId}/catalog?since=${_artistTracks.length}`
      );
      if (_artistFillId !== artistId || openArtistId !== artistId) return;
      appendArtistTracks(data.tracks || []);
      if (data.complete) {
        if (artistFillBar) artistFillBar.style.width = "100%";
        if (artistFillLabel)
          artistFillLabel.textContent = `Catalogo completo · ${_artistTracks.length} brani`;
        // resta a schermo qualche secondo, poi si dissolve (Vitto 04/10)
        // invece di sparire di scatto
        _artistFillTimer = setTimeout(() => {
          if (_artistFillId !== artistId) return;
          if (artistFill) artistFill.classList.add("artist-fill-svanisce");
          _artistFillTimer = setTimeout(() => {
            _artistFillTimer = null;
            if (_artistFillId === artistId) stopArtistCatalogFill();
          }, 700);
        }, 2500);
        return;
      }
      renderArtistFillProgress(data);
      _artistFillTimer = setTimeout(tick, 1000);
    } catch (err) {
      // niente toast: è un extra, se non arriva la pagina resta valida
      stopArtistCatalogFill();
    }
  };
  _artistFillTimer = setTimeout(tick, 700);
}

function buildArtistTrackRow(t, i) {
  const row = document.createElement("li");
  row.className = "track";
  row.dataset.index = t.index;
  row.innerHTML = `
    <span class="num">${i + 1}</span>
    <div class="art">▤</div>
    <div class="info">
      <div class="title"></div>
      <div class="artist"></div>
    </div>
    <span class="dur"></span>
    <div class="track-actions">
      <button type="button" class="heart-row artist-track-like heart-fillable" title="Aggiungi alla mia libreria">${heartFillMarkup(16)}</button>
    </div>
  `;
  row.querySelector(".title").textContent = t.title || "—";
  // nella pagina artista sarebbe un link a se stessa, inutile — solo
  // nell'album (dove si può arrivare da un altro punto) ha senso
  if (_detailKind === "album") wireArtistName(row.querySelector(".artist"), t.artist, t.artist_id);
  else row.querySelector(".artist").textContent = t.artist || "—";
  row.querySelector(".dur").textContent = t.duration ? fmtTime(t.duration) : "";
  if (t.cover_url) {
    const art = row.querySelector(".art");
    lazyLoadCover(art, proxiedCover(t.cover_url));
    // copertina cliccabile verso l'album — solo dalla pagina artista
    // (dentro l'album stesso sarebbe un link a se stesso, inutile)
    if (_detailKind === "artist" && t.album_id) {
      art.classList.add("artist-link");
      addPressFeedback(art);
      art.addEventListener("click", (e) => {
        e.stopPropagation();
        openAlbum(t.album_id);
      });
    }
  }
  const likeBtn = row.querySelector(".artist-track-like");
  if (t.saved) likeBtn.classList.add("on");
  likeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    likeLazyTrack(e.currentTarget, artistItemFromTrack(t));
  });
  montaMenuRiga(row, {
    titolo: t.title, artista: t.artist, artistId: t.artist_id,
    libraryId: t.library_id || null, item: () => artistItemFromTrack(t),
  });
  return row;
}

/** Tutti i brani dell'artista/album in una finestra sopra la card corrente
 * (non più espansione inline, "fa schifo" con tante righe) — ricerca
 * locale, tap fuori per uscire (stile crackify, stesso pattern di plModal:
 * .modal è il backdrop, click sul backdrop stesso chiude). */
/** Finestra della ricerca brani (Telegram). Il contenuto è lo stesso di
 * prima — form, risultati, tasti pagina — solo spostato qui dentro in
 * index.html: nessuna logica di ricerca è cambiata. */
function openTrackSearchModal() {
  const modal = document.getElementById("trackSearchModal");
  if (!modal) return;
  modal.classList.remove("hidden");
  const campo = document.getElementById("query");
  if (!campo) return;
  // quello che hai già scritto nella barra della Home È la ricerca che vuoi:
  // la finestra si apre con i risultati già in arrivo, non vuota
  const daHome = ((homeSearchInput && homeSearchInput.value) || "").trim();
  if (daHome) {
    campo.value = daHome;
    updateSearchClearVisible();
    hideSearchHistory();
    // stessa query di poco fa: i risultati sono ancora lì, inutile bruciare
    // un'altra richiesta ai bot
    if (daHome.toLowerCase() !== ultimaQueryBrani.toLowerCase()) {
      if (typeof form.requestSubmit === "function") form.requestSubmit();
      else form.dispatchEvent(new Event("submit", { cancelable: true }));
    }
    return;
  }
  // barra vuota: si parte dal campo, ma senza tendina in faccia
  _saltaCronologia = true;
  try { campo.focus(); campo.select(); } catch (_) {}
}

function closeTrackSearchModal() {
  const modal = document.getElementById("trackSearchModal");
  if (modal) modal.classList.add("hidden");
  hideSearchHistory();
}

/** Chiude la finestra "Brani" solo se è aperta: la chiamano il tocco su una
 * tab e revealView, cioè ogni volta che si va su un'altra pagina (anche dai
 * risultati stessi, es. il nome di un artista). I risultati restano lì per
 * quando la si riapre. */
function chiudiRicercaBraniSeAperta() {
  const modal = document.getElementById("trackSearchModal");
  if (modal && !modal.classList.contains("hidden")) closeTrackSearchModal();
}

{
  const apri = document.getElementById("btnTrackSearch");
  if (apri) apri.addEventListener("click", openTrackSearchModal);
  const chiudi = document.getElementById("trackSearchClose");
  if (chiudi) chiudi.addEventListener("click", closeTrackSearchModal);
  const modal = document.getElementById("trackSearchModal");
  if (modal) {
    // tap fuori dalla card: stessa uscita di artistTracksModal
    modal.addEventListener("click", (e) => {
      if (e.target === modal) closeTrackSearchModal();
    });
  }
  // in cattura: deve girare PRIMA dell'handler sul campo, che chiude la
  // tendina della cronologia — altrimenti un solo Esc chiuderebbe entrambe
  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const m = document.getElementById("trackSearchModal");
    if (!m || m.classList.contains("hidden")) return;
    const cronologia = document.getElementById("searchHistory");
    if (cronologia && !cronologia.classList.contains("hidden")) return;
    closeTrackSearchModal();
  }, true);
}

function openArtistTracksModal() {
  if (!artistTracksModal || !artistTracksModalList) return;
  artistTracksModalList.innerHTML = "";
  _artistTracks.forEach((t, i) => {
    const row = buildArtistTrackRow(t, i);
    row.addEventListener("click", () => {
      // il modale NON si chiude più al tocco: chiudendolo subito il brano
      // partiva "al buio", senza il riempimento "resolving" sulla riga né
      // l'evidenziazione a play confermato (Vitto 2026-08-10). Si chiude con
      // la X o toccando fuori, quando l'utente ha finito di scegliere.
      playArtistFrom(i);
    });
    artistTracksModalList.appendChild(row);
  });
  if (artistTracksModalTitle) {
    artistTracksModalTitle.textContent = `Tutti i brani (${_artistTracks.length})`;
  }
  if (artistTracksModalSearch) artistTracksModalSearch.value = "";
  if (artistTracksModalClear) artistTracksModalClear.classList.add("hidden");
  artistTracksModal.classList.remove("hidden");
}

function closeArtistTracksModal() {
  if (artistTracksModal) artistTracksModal.classList.add("hidden");
}

function applyArtistTracksModalFilter() {
  if (!artistTracksModalList) return;
  const q = (
    artistTracksModalSearch && artistTracksModalSearch.value ? artistTracksModalSearch.value : ""
  )
    .trim()
    .toLowerCase();
  artistTracksModalList.querySelectorAll(".track").forEach((row) => {
    if (!q) {
      row.classList.remove("hidden");
      return;
    }
    const title = (row.querySelector(".title")?.textContent || "").toLowerCase();
    const artist = (row.querySelector(".artist")?.textContent || "").toLowerCase();
    row.classList.toggle("hidden", !title.includes(q) && !artist.includes(q));
  });
}

if (artistTracksModal) {
  artistTracksModal.addEventListener("click", (e) => {
    if (e.target === artistTracksModal) closeArtistTracksModal();
  });
}
if (artistTracksModalSearch) {
  artistTracksModalSearch.addEventListener("input", () => {
    if (artistTracksModalClear) {
      artistTracksModalClear.classList.toggle("hidden", !artistTracksModalSearch.value.trim());
    }
    applyArtistTracksModalFilter();
  });
}
if (artistTracksModalClear) {
  artistTracksModalClear.addEventListener("click", () => {
    if (!artistTracksModalSearch) return;
    artistTracksModalSearch.value = "";
    artistTracksModalClear.classList.add("hidden");
    applyArtistTracksModalFilter();
    artistTracksModalSearch.focus();
  });
}

/** Pagina di dettaglio condivisa da artista e album (stessa forma: cover +
 * nome + tracklist + anti-ban) — cambia solo endpoint, etichetta, e se ha
 * senso il cuoricino "segui" (solo artista, non album). */
async function openDetailPage(kind, id) {
  if (!id) return;
  registraTappa("dettaglio", [kind, id]);
  // overlay: a differenza delle altre view NON nasconde viewHome sotto di
  // sé (vedi revealView(viewArtist) più sotto) — se si arriva da Home il
  // suo loop soundbar restava acceso, invisibile, sotto la pagina artista
  stopHomeDjSoundbarLoop();
  const { signal, gen } = showLoadingOverlay({ tonda: kind !== "album" });
  // se si arriva da un ALTRO dettaglio già aperto (es. album toccato dalla
  // pagina artista): ricorda dove tornare con "indietro" — un solo livello,
  // non una pila vera, ma copre il caso reale (artista -> album -> indietro)
  const wasDetailOpen = viewArtist && !viewArtist.classList.contains("hidden");
  _detailPrevKind = wasDetailOpen ? _detailKind : null;
  _detailPrevId = wasDetailOpen ? openArtistId : null;
  _detailKind = kind;
  // il player a tutto schermo è un overlay sopra tutto il resto: se resta
  // aperto, la pagina si carica correttamente ma sotto, invisibile — vedi
  // tap su npArtist
  if (npOpen) closeNowPlayingSheet();
  // un completamento catalogo della pagina precedente non deve continuare ad
  // appendere righe su questa
  stopArtistCatalogFill();
  try {
    const data = await apiJson(
      `/api/deezer/${kind === "album" ? "albums" : "artists"}/${id}`,
      null,
      undefined,
      undefined,
      signal
    );
    openArtistId = id;
    _artistTracks = data.tracks || [];
    if (kind === "artist") {
      recordArtistOpen({ id, name: data.name || "Artista", coverUrl: data.cover_url || null });
    }
    if (artistKicker) artistKicker.textContent = kind === "album" ? "Album" : "Artista";
    // la copertina grande è tonda solo per un artista: un album resta
    // quadrato, è una copertina di disco (Vitto, 20/09). Stessa convenzione
    // delle righe della libreria, che usano già .pl-row-cover-round
    if (artistHeroCover) {
      artistHeroCover.classList.toggle("pl-hero-cover-round", kind !== "album");
    }
    artistHeroTitle.textContent = data.name || (kind === "album" ? "Album" : "Artista");
    // niente conteggio (desktop dal 30/09, telefono dal 05/10, Vitto)
    artistStatus.textContent = "";
    if (artistAntiBan) artistAntiBan.classList.toggle("on", isAntiBanEnabled());
    if (artistAntiBanPopover) artistAntiBanPopover.classList.remove("open");
    if (btnArtistFollow) {
      // seguire ha senso solo per un artista, non per un singolo album
      btnArtistFollow.classList.toggle("hidden", kind === "album");
      btnArtistFollow.classList.remove("filling", "busy", "fill-done", "fill-fail", "fill-pop");
      btnArtistFollow.classList.toggle("on", !!data.saved);
      btnArtistFollow.title = data.saved ? "Rimuovi dai seguiti" : "Segui artista";
      btnArtistFollow.setAttribute("aria-label", btnArtistFollow.title);
    }
    if (artistHeroCover) {
      if (data.cover_url) {
        const url = proxiedCover(data.cover_url);
        artistHeroCover.style.backgroundImage = `url(${url})`;
        artistHeroCover.textContent = "";
        applyHeroColor(artistHeroCover.closest(".pl-hero"), url);
      } else {
        artistHeroCover.style.backgroundImage = "";
        artistHeroCover.textContent = kind === "album" ? "▤" : "🎤";
        applyHeroColor(artistHeroCover.closest(".pl-hero"), null);
      }
    }
    artistTracksEl.innerHTML = "";
    resetArtistTrackFilter();
    _artistTracks.forEach((t, i) => {
      const row = buildArtistTrackRow(t, i);
      row.addEventListener("click", () => playArtistFrom(i));
      if (i >= artistCollapsedCount()) row.classList.add("hidden");
      artistTracksEl.appendChild(row);
    });
    if (artistShowAllBtn) {
      const rest = _artistTracks.length - artistCollapsedCount();
      if (rest > 0) {
        artistShowAllBtn.textContent = `Mostra tutti (${_artistTracks.length})`;
        artistShowAllBtn.classList.remove("hidden");
      } else {
        artistShowAllBtn.classList.add("hidden");
      }
    }
    // discografia: solo sulla pagina artista, un album non ha una sua
    // "discografia" di album al suo interno
    const albums = kind === "artist" ? data.albums || [] : [];
    if (artistAlbumsSection && artistAlbumsGrid) {
      artistAlbumsSection.classList.toggle("hidden", !albums.length);
      artistAlbumsGrid.innerHTML = "";
      albums.forEach((a) => {
        const card = document.createElement("div");
        card.className = "pl-card";
        card.innerHTML = `
          <div class="pl-card-cover">▤</div>
          <div class="pl-card-name"></div>
          <div class="pl-card-meta"></div>
        `;
        card.querySelector(".pl-card-name").textContent = a.title || "Album";
        card.querySelector(".pl-card-meta").textContent = (a.release_date || "").slice(0, 4);
        if (a.cover_url) {
          const cov = card.querySelector(".pl-card-cover");
          lazyLoadCover(cov, proxiedCover(a.cover_url));
        }
        card.addEventListener("click", () => openAlbum(a.id));
        artistAlbumsGrid.appendChild(card);
      });
    }
    // resta un overlay sopra la view corrente (niente showView): tornare
    // indietro deve solo nascondersi, senza ricaricare/perdere lo stato di
    // dove si era (ricerca, dettaglio chart/playlist, ecc.) — ECCEZIONE:
    // Brani salvati (viewLibrary) ha una sua inizializzazione dedicata
    // (openSavedLibrary: nav-active, ricerca, scroll...) che un semplice
    // "rimuovi hidden" salta, lasciandola in uno stato inconsistente.
    _artistPrevView = [viewHome, viewSearch, viewLibrary, viewQueue, viewPlaylists].find(
      (v) => v && !v.classList.contains("hidden")
    );
    const bar = document.querySelector(".mobile-topbar");
    _artistPrevTopbarVisible = bar ? !bar.classList.contains("topbar-hidden") : true;
    [viewHome, viewSearch, viewLibrary, viewQueue, viewPlaylists].forEach((v) => v && v.classList.add("hidden"));
    setMobileTopbarVisible(false);
    revealView(viewArtist);
    if (kind === "artist") startArtistCatalogFill(id, data.fill);
  } catch (err) {
    if (!err.cancelled) toast("Errore artista: " + (err.message || err));
  } finally {
    hideLoadingOverlay(gen);
  }
}

function closeArtistView() {
  stopArtistCatalogFill();
  closeArtistTracksModal(); // mai lasciarla aperta e orfana sopra la view dove si torna
  if (_detailPrevId) {
    // torna al dettaglio da cui si era arrivati (es. l'artista da cui si
    // era toccato l'album) invece di uscire del tutto
    const kind = _detailPrevKind;
    const id = _detailPrevId;
    _detailPrevKind = null;
    _detailPrevId = null;
    openDetailPage(kind, id);
    return;
  }
  viewArtist.classList.add("hidden");
  if (_artistPrevView === viewLibrary) {
    // riapre "Brani salvati" con la sua inizializzazione vera, non un
    // semplice show — vedi commento in openArtist
    openSavedLibrary();
  } else if (_artistPrevView) {
    _artistPrevView.classList.remove("hidden");
    setMobileTopbarVisible(_artistPrevTopbarVisible);
  } else {
    viewHome.classList.remove("hidden");
    startHomeDjSoundbarLoop();
    setMobileTopbarVisible(true);
  }
}

function artistItemFromTrack(t) {
  const cover = t.cover_url ? proxiedCover(t.cover_url) : null;
  const coverHd = t.cover_hd_url ? proxiedCover(t.cover_hd_url) : cover;
  return {
    qid: uid(),
    source: _detailKind === "album" ? "deezer_album" : "deezer_artist",
    artistId: openArtistId,
    chartIndex: t.index,
    title: t.title || "track",
    artist: t.artist || "",
    artist_id: t.artist_id || null,
    duration: t.duration || 0,
    cover_url: cover,
    cover_hd_url: coverHd,
    previewUrl: t.preview_url || null,
  };
}

function playArtistFrom(startIndex) {
  if (!_artistTracks.length) return;
  const items = _artistTracks.map((t) => artistItemFromTrack(t));
  playFromList(items, startIndex, null);
}

if (btnArtistBack) btnArtistBack.addEventListener("click", closeArtistView);
if (btnArtistFollow) {
  btnArtistFollow.addEventListener("click", async () => {
    if (!openArtistId || btnArtistFollow.classList.contains("filling")) return;
    const wasSaved = btnArtistFollow.classList.contains("on");
    startHeartFill(btnArtistFollow);
    try {
      if (wasSaved) {
        await apiJson(`/api/saved-playlists?kind=artist&ref_id=${openArtistId}`, null, "DELETE");
        btnArtistFollow.classList.remove("filling", "busy", "on", "fill-done", "fill-pop");
        btnArtistFollow.title = "Segui artista";
        btnArtistFollow.setAttribute("aria-label", btnArtistFollow.title);
        toast("Artista rimosso dai seguiti");
      } else {
        await apiJson("/api/saved-playlists", { kind: "artist", ref_id: String(openArtistId) }, "POST");
        endHeartFill(true, btnArtistFollow);
        btnArtistFollow.title = "Rimuovi dai seguiti";
        btnArtistFollow.setAttribute("aria-label", btnArtistFollow.title);
        toast("Artista seguito — lo trovi in La tua libreria");
      }
    } catch (err) {
      endHeartFill(false, btnArtistFollow);
      btnArtistFollow.classList.toggle("on", wasSaved);
      toast("Errore: " + (err.message || "operazione fallita"));
    }
  });
}
if (artistShowAllBtn) {
  artistShowAllBtn.addEventListener("click", () => {
    openArtistTracksModal();
  });
}

/** Apre la pagina di un artista dato il nome — usa l'id Deezer se già noto
 * (chart/playlist, zero attesa), altrimenti lo cerca per nome al tap (brani
 * da ricerca manuale/bot Telegram, che non hanno un id Deezer). Nessuna
 * gestione di omonimie: primo risultato secondo Deezer. */
async function openArtistByName(name, knownId) {
  if (knownId) {
    openArtist(knownId);
    return;
  }
  if (!name) return;
  // mostra l'overlay SUBITO, prima ancora del lookup per nome — altrimenti
  // (caso comune: artist_id non noto sul brano, es. tap dal player a tutto
  // schermo) l'utente vede secondi di nulla prima che parta persino la
  // richiesta che apre poi openDetailPage/il suo overlay
  const { signal, gen } = showLoadingOverlay({ tonda: true });
  try {
    const data = await apiJson(
      `/api/deezer/artist-lookup?name=${encodeURIComponent(name)}`,
      null,
      undefined,
      undefined,
      signal
    );
    if (data.artist_id) {
      // openArtist -> openDetailPage tiene l'overlay acceso e lo nasconde
      // lui stesso a fine caricamento (suo try/finally) — nessun flicker
      openArtist(data.artist_id);
    } else {
      hideLoadingOverlay(gen);
      toast("Artista non trovato su Deezer");
    }
  } catch (err) {
    hideLoadingOverlay(gen);
    if (!err.cancelled) toast("Errore ricerca artista");
  }
}

/** Da chiamare al posto di un assegnamento diretto a .textContent su un
 * elemento ".artist" già nel DOM: stesso testo, ma cliccabile verso la
 * pagina dell'artista (vedi openArtistByName). artistId opzionale (se già
 * noto da Deezer, salta la ricerca per nome). */
/** Feedback visivo al tocco esplicito via classe invece del :active CSS —
 * su elementi annidati in WKWebView :active spesso non scatta in modo
 * affidabile (vedi npArtist nel player a tutto schermo). */
function addPressFeedback(el) {
  const on = () => el.classList.add("is-pressed");
  const off = () => el.classList.remove("is-pressed");
  el.addEventListener("touchstart", on, { passive: true });
  el.addEventListener("touchend", off, { passive: true });
  el.addEventListener("touchcancel", off, { passive: true });
}

function wireArtistName(artistEl, name, artistId, fallbackText) {
  if (!artistEl) return;
  artistEl.textContent = name || fallbackText || "—";
  if (!name) return;
  artistEl.classList.add("artist-link");
  addPressFeedback(artistEl);
  artistEl.addEventListener("click", (e) => {
    e.stopPropagation();
    openArtistByName(name, artistId);
  });
}

async function openHomePlaylist(ownerId, pid) {
  registraTappa("playlistAltrui", [ownerId, pid]);
  // si apre solo toccando una card della Home: sempre un'entrata
  const carica = window.innerWidth < 901 ? showLoadingOverlay() : null;
  try {
    const pl = await apiJson(`/api/home/playlists/${ownerId}/${pid}`, null, undefined, undefined, carica && carica.signal);
    openPlaylistId = pid;
    openPlaylistOwnerId = ownerId;
    dimenticaListaPigra();
    plTitle.textContent = pl.name;
    plStatus.textContent = `${pl.track_count || 0} brani · di ${pl.owner_name || "?"}`;
    setMobileTopbarVisible(false);
    if (plGridHead) plGridHead.classList.add("hidden");
    if (plLibSearchWrap) plLibSearchWrap.classList.add("hidden");
    if (plHero) {
      plHero.classList.remove("hidden");
      if (plHeroTitle) plHeroTitle.textContent = pl.name;
      if (plHeroCover) {
        plHeroCover.classList.remove("pl-hero-cover-saved");
        if (pl.cover_url) {
          plHeroCover.style.backgroundImage = `url(${mediaAuthUrl(pl.cover_url, { bust: false })})`;
          plHeroCover.textContent = "";
        } else {
          plHeroCover.style.backgroundImage = "";
          plHeroCover.textContent = "▤";
        }
      }
      applyHeroColor(plHero, pl.cover_url);
      applyAvatarToEl(plHeroAvatar, pl.owner_avatar_url, "🎧");
      setHeroMetaText(plHeroMetaText, pl.tracks || []);
      if (plHeroMetaText) {
        plHeroMetaText.textContent = `${pl.owner_name || "?"} · ${plHeroMetaText.textContent || ""}`;
      }
    }
    if (plActionRow) plActionRow.classList.remove("hidden");
    btnPlPlay.classList.toggle("hidden", !(pl.tracks && pl.tracks.length));
    // lo shuffle nasce nascosto e lo accendevano solo classifiche e offline:
    // qui si vedeva solo se restava acceso dalla classifica aperta prima
    if (btnPlShuffle) btnPlShuffle.classList.toggle("hidden", !(pl.tracks && pl.tracks.length));
    _openHomePlaylistFull = pl;
    refreshPlOfflineButton(pid, !!(pl.tracks && pl.tracks.length));
    refreshPlAdoptButton(!!(pl.tracks && pl.tracks.length));
    backfillOfflineCovers(pid, pl.tracks || []);
    btnPlCreate.classList.add("hidden");
    plList.classList.add("hidden");
    plTracks.classList.remove("hidden");
    plTracks.innerHTML = "";
    showPlTrackSearch();
    // sempre un'entrata: parte dall'inizio come openPlaylist
    if (mainEl) mainEl.scrollTop = 0;

    if (!pl.tracks || !pl.tracks.length) {
      plStatus.textContent = "Playlist vuota";
      return;
    }

    plStatus.textContent = `${pl.tracks.length} brani · di ${pl.owner_name || "?"}`;
    pl.tracks.forEach((t0, i) => {
      const t = { ...t0, owner_id: ownerId };
      const row = document.createElement("div");
      row.className = "track";
      row.dataset.id = t.id;
      row.innerHTML = `
        <span class="num">${i + 1}</span>
        <div class="art">⚡</div>
        <div class="info">
          <div class="title"></div>
          <div class="artist"></div>
        </div>
        <span class="dur"></span>
        <div class="track-actions">
          <button type="button" class="q-add" title="In coda">+</button>
          <button type="button" class="heart-row home-track-add heart-fillable" title="Aggiungi alla mia libreria">${heartFillMarkup(16)}</button>
        </div>
      `;
      row.querySelector(".title").textContent = t.title || "—";
      wireArtistName(row.querySelector(".artist"), t.artist, t.artist_id);
      row.querySelector(".dur").textContent = t.duration || "";
      if (t.cover_url) {
        const art = row.querySelector(".art");
        lazyLoadCover(art, mediaAuthUrl(t.cover_url, { bust: false }));
      }
      row.querySelector(".q-add").addEventListener("click", (e) => {
        e.stopPropagation();
        addToQueue(recentItemFromTrack(t));
      });
      const addBtn = row.querySelector(".home-track-add");
      if (t.saved_by_me) addBtn.classList.add("on");
      addBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (addBtn.classList.contains("filling") || addBtn.classList.contains("on")) return;
        startHeartFill(addBtn);
        try {
          await apiJson(`/api/library/recent/${ownerId}/${t.id}/adopt`, null, "POST");
          endHeartFill(true, addBtn);
          toast("Aggiunto alla tua libreria");
        } catch (err) {
          endHeartFill(false, addBtn);
          toast("Errore: " + (err.message || "aggiunta fallita"));
        }
      });
      const wrap = enableSwipeToQueue(row, () => recentItemFromTrack(t), {
        onTap: () =>
          playFromList(
            pl.tracks.map((x) => recentItemFromTrack({ ...x, owner_id: ownerId })),
            i
          ),
      });
      plTracks.appendChild(wrap);
    });
  } catch (err) {
    if (!err.cancelled) plStatus.textContent = "Errore: " + err.message;
  } finally {
    if (carica) hideLoadingOverlay(carica.gen);
  }
}

async function playOpenHomePlaylist() {
  if (!openPlaylistId || !openPlaylistOwnerId) return;
  try {
    const pl = await apiJson(`/api/home/playlists/${openPlaylistOwnerId}/${openPlaylistId}`);
    if (!pl.tracks || !pl.tracks.length) {
      toast("Playlist vuota");
      return;
    }
    const items = pl.tracks.map((t) =>
      recentItemFromTrack({ ...t, owner_id: openPlaylistOwnerId })
    );
    playFromList(items, shuffleStartIndex(items.length), null);
  } catch (err) {
    toast(err.message);
  }
}

// true mentre una loadPlaylists() è già in volo — un tap su "Libreria"
// mentre sei già dentro deve poter fare da refresh manuale (vedi showView),
// ma due fetch sovrapposte finirebbero per pestarsi i piedi sullo stesso
// plList (Vitto 2026-07-29: "aspettiamo che il caricamento finisca").
let _loadingPlaylists = false;

async function loadPlaylists() {
  if (_loadingPlaylists) return;
  _loadingPlaylists = true;
  // griglia di tutte le playlist (reset dettaglio)
  openPlaylistId = null;
  openPlaylistOwnerId = null;
  dimenticaListaPigra();
  if (plLoadingSpinner) plLoadingSpinner.classList.remove("hidden");
  plTitle.textContent = "La tua libreria";
  plStatus.textContent = "Crea e organizza i tuoi pezzi";
  if (plStatus.parentElement) plStatus.parentElement.classList.remove("hidden");
  if (plGridHead) plGridHead.classList.remove("hidden");
  if (plLibSearchWrap) plLibSearchWrap.classList.remove("hidden");
  if (plHero) plHero.classList.add("hidden");
  if (plActionRow) plActionRow.classList.add("hidden");
  btnPlPlay.classList.add("hidden");
  btnPlCreate.classList.remove("hidden");
  plTracks.classList.add("hidden");
  plTracks.innerHTML = "";
  hidePlTrackSearch();
  resetPlLibSearch();
  plList.classList.remove("hidden");
  plList.innerHTML = "";

  // card fissata in cima, stile Spotify "Brani che ti piacciono"
  const meName = (authState.user && (authState.user.display_name || authState.user.username)) || "te";
  const savedCard = document.createElement("div");
  savedCard.className = "pl-row";
  savedCard.dataset.searchName = "brani salvati";
  savedCard.innerHTML = `
    <div class="pl-row-cover pl-row-cover-saved">♥</div>
    <div class="pl-row-text">
      <div class="pl-row-name">Brani salvati</div>
      <div class="pl-row-meta"><span class="pl-row-meta-desk">La tua scorta</span><span></span></div>
    </div>
  `;
  // da desktop la card della griglia è stretta e "Playlist • <nome>" si
  // troncava: lì vale lo span .pl-row-meta-desk, con le stesse parole della
  // barra laterale (vedi "La tua libreria a griglia" in style.css)
  savedCard.querySelector(".pl-row-meta span:not(.pl-row-meta-desk)").textContent = `Playlist • ${meName}`;
  wireFixedLibRowMenu(savedCard, () => openSavedLibrary());
  plList.appendChild(savedCard);

  // Discovery Weekly: fissa subito dopo "Brani salvati" — richiesta di
  // Vitto, 2026-08-04. Niente data-pin-key su nessuna delle due: restano
  // sempre in cima, reorderLibRowsByPin le ignora e basta.
  const discoveryCard = document.createElement("div");
  discoveryCard.className = "pl-row";
  discoveryCard.dataset.searchName = "discovery weekly";
  discoveryCard.innerHTML = `
    <div class="pl-row-cover pl-row-cover-discovery"><img class="discovery-cover-icon" src="/icons/discovery-weekly-cover.webp?v=2" alt="" /></div>
    <div class="pl-row-text">
      <div class="pl-row-name">Discovery Weekly</div>
      <div class="pl-row-meta"><span class="pl-row-meta-desk">Solo per te</span><span></span></div>
    </div>
  `;
  discoveryCard.querySelector(".pl-row-meta span:not(.pl-row-meta-desk)").textContent = `Playlist • Solo per ${meName}`;
  wireFixedLibRowMenu(discoveryCard, () => openDiscoveryWeekly());
  plList.appendChild(discoveryCard);

  // chart/playlist Deezer salvati come segnalibro (vedi saved_playlists.py):
  // stessa card di navigazione di Home, ma con l'icona di download in
  // blocco (vedi buildSavedLazyCard) — solo qui in "La tua libreria"
  const savedLazy = await loadSavedLazyPlaylists();
  savedLazy.forEach((item) => plList.appendChild(buildSavedLazyCard(item)));

  try {
    const data = await apiJson("/api/playlists");
    const list = data.playlists || [];
    const visible = list.filter((p) => !pendingPlaylistDeletes.has(p.id));
    if (!visible.length) {
      // niente scritta: il "+" è lì accanto al titolo e si vede
      // (richiesta di Vitto, 19/09 — come già per "1 playlist" il 04/08)
      plStatus.textContent = "";
      if (plStatus.parentElement) plStatus.parentElement.classList.add("hidden");
      return;
    }
    // niente più conteggio "N playlist" qui — richiesta di Vitto,
    // 2026-08-04 ("la scritta 1 playlist va rimossa")
    plStatus.textContent = "";
    if (plStatus.parentElement) plStatus.parentElement.classList.add("hidden");
    visible.forEach((p) => {
      const card = document.createElement("div");
      card.className = "pl-row";
      card.dataset.id = p.id;
      card.dataset.searchName = (p.name || "").toLowerCase();
      card.dataset.pinKey = `playlist:${p.id}`;
      card.innerHTML = `
        <div class="pl-row-cover">▤</div>
        <div class="pl-row-text">
          <div class="pl-row-name"></div>
          <div class="pl-row-meta"><span></span></div>
        </div>
        <div class="pl-card-menu-wrap">
          <div class="pl-card-menu">
            <button type="button" data-action="pin"></button>
            <button type="button" data-action="rename">Rinomina</button>
            <button type="button" data-action="cover">Imposta copertina</button>
            <button type="button" data-action="delete" class="pl-card-menu-danger">Elimina</button>
          </div>
        </div>
      `;
      card.querySelector(".pl-row-name").textContent = p.name;
      card.querySelector(".pl-row-meta span").textContent = `Playlist • ${p.track_count || 0} brani`;
      if (p.cover_url) {
        const c = card.querySelector(".pl-row-cover");
        lazyLoadCover(c, mediaAuthUrl(p.cover_url, { bust: false }));
      }
      const menu = card.querySelector(".pl-card-menu");
      const pinBtn = menu.querySelector('[data-action="pin"]');
      const refreshPinBtnLabel = () => {
        pinBtn.textContent = isLibItemPinned("playlist", p.id) ? "Rimuovi pin" : "Fissa playlist";
      };
      refreshPinBtnLabel();
      pinBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        closePlCardMenu();
        toggleLibItemPinned("playlist", p.id);
        refreshPinBtnLabel();
        reorderLibRowsByPin();
      });
      menu.querySelector('[data-action="rename"]').addEventListener("click", (e) => {
        e.stopPropagation();
        closePlCardMenu();
        openRenamePlaylistModal(p.id, p.name);
      });
      menu.querySelector('[data-action="cover"]').addEventListener("click", (e) => {
        e.stopPropagation();
        closePlCardMenu();
        openPlaylistCoverPicker(p.id);
      });
      menu.querySelector('[data-action="delete"]').addEventListener("click", (e) => {
        e.stopPropagation();
        closePlCardMenu();
        schedulePlaylistDelete(p.id, p.name);
      });
      // niente più "⋮" visibile: tieni premuto ~2s sulla riga per aprire il
      // menu — richiesta di Vitto, 2026-08-04.
      wireLibRowLongPress(card, menu, () => openPlaylist(p.id, { entrata: true }));
      plList.appendChild(card);
    });
  } catch (err) {
    plStatus.textContent = "Errore: " + err.message;
    if (plStatus.parentElement) plStatus.parentElement.classList.remove("hidden");
  } finally {
    if (plLoadingSpinner) plLoadingSpinner.classList.add("hidden");
    _loadingPlaylists = false;
    reorderLibRowsByPin();
    sincronizzaPin();
  }
}

/** opts.entrata: ci si sta entrando (tocco su card/riga), non è il
 * rinfresco della playlist già aperta — da telefono passa dallo scheletro
 * come mix e classifiche (vedi showLoadingOverlay), mai nei rinfreschi. */
async function openPlaylist(pid, opts) {
  // solo gli ingressi veri: i rinfreschi possono arrivare anche mentre sei
  // su un'altra tab (openPlaylistId resta valorizzato) e sporcherebbero lo storico
  if (opts && opts.entrata) registraTappa("playlist", [pid]);
  const carica = opts && opts.entrata && window.innerWidth < 901 ? showLoadingOverlay() : null;
  try {
    const pl = await apiJson(`/api/playlists/${pid}`, null, undefined, undefined, carica && carica.signal);
    openPlaylistId = pid;
    openPlaylistOwnerId = null;
    dimenticaListaPigra();
    plTitle.textContent = pl.name;
    plStatus.textContent = `${pl.track_count || 0} brani`;
    recordPlaylistOpen({
      kind: "playlist",
      id: pid,
      title: pl.name || "Playlist",
      subtitle: `${pl.track_count || 0} brani`,
      coverUrl: pl.cover_url || null,
    });
    setMobileTopbarVisible(false);
    if (plGridHead) plGridHead.classList.add("hidden");
    if (plLibSearchWrap) plLibSearchWrap.classList.add("hidden");
    if (plHero) {
      plHero.classList.remove("hidden");
      if (plHeroTitle) plHeroTitle.textContent = pl.name;
      if (plHeroCover) {
        plHeroCover.classList.remove("pl-hero-cover-saved");
        if (pl.cover_url) {
          plHeroCover.style.backgroundImage = `url(${mediaAuthUrl(pl.cover_url, { bust: false })})`;
          plHeroCover.textContent = "";
        } else {
          plHeroCover.style.backgroundImage = "";
          plHeroCover.textContent = "▤";
        }
      }
      applyHeroColor(plHero, pl.cover_url);
      applyAvatarToEl(plHeroAvatar, authState.user && authState.user.avatar_url, "⚡");
      setHeroMetaText(plHeroMetaText, pl.tracks || []);
    }
    if (plActionRow) plActionRow.classList.remove("hidden");
    btnPlPlay.classList.toggle("hidden", !(pl.tracks && pl.tracks.length));
    // lo shuffle nasce nascosto e lo accendevano solo classifiche e offline:
    // qui si vedeva solo se restava acceso dalla classifica aperta prima
    if (btnPlShuffle) btnPlShuffle.classList.toggle("hidden", !(pl.tracks && pl.tracks.length));
    _openPlaylistFull = pl;
    refreshPlOfflineButton(pid, !!(pl.tracks && pl.tracks.length));
    refreshPlAdoptButton(!!(pl.tracks && pl.tracks.length));
    backfillOfflineCovers(pid, pl.tracks || []);
    btnPlCreate.classList.add("hidden");
    plList.classList.add("hidden");
    plTracks.classList.remove("hidden");
    plTracks.innerHTML = "";
    showPlTrackSearch();
    // la griglia «La tua libreria» e la playlist sono la stessa vista, quindi
    // qui non si passa da revealView: scorsa la griglia fino in fondo, la
    // playlist si apriva a metà (Vitto 07/10). Solo agli ingressi veri: i
    // rinfreschi della playlist già aperta non devono riportarti su.
    if (opts && opts.entrata && mainEl) mainEl.scrollTop = 0;

    if (!pl.tracks || !pl.tracks.length) {
      plStatus.textContent = "Vuota — aggiungi brani con ▤+ sul player o dai Salvati";
      if (plHeroMetaText) plHeroMetaText.textContent = "Vuota — aggiungi brani con ▤+ sul player o dai Salvati";
      return;
    }

    plStatus.textContent = soloTelefono(
      `${pl.tracks.length} brani · tap play · swipe → coda/rimuovi`
    );
    pl.tracks.forEach((t, i) => {
      const row = document.createElement("div");
      row.className = "track";
      row.dataset.id = t.id;
      row.innerHTML = `
        <span class="num">${i + 1}</span>
        <div class="art">⚡</div>
        <div class="info">
          <div class="title"></div>
          <div class="artist"></div>
        </div>
        <span class="dur"></span>
      `;
      row.querySelector(".title").textContent = t.title || "—";
      wireArtistName(row.querySelector(".artist"), t.artist, t.artist_id);
      row.querySelector(".dur").textContent = t.duration || "";
      if (t.cover_url) {
        const art = row.querySelector(".art");
        lazyLoadCover(art, mediaAuthUrl(t.cover_url, { bust: false }));
      }
      montaMenuRiga(row, {
        titolo: t.title, artista: t.artist, artistId: t.artist_id,
        libraryId: t.id, item: () => libraryItemFromTrack(t),
      });
      const wrap = enableSwipeToQueue(row, () => libraryItemFromTrack(t), {
        onTap: () => playPlaylistFrom(pl.tracks, i),
        onSwipeLeft: () => schedulePlaylistTrackRemove(pid, t, wrap),
      });
      plTracks.appendChild(wrap);
    });
  } catch (err) {
    if (!err.cancelled) plStatus.textContent = "Errore: " + err.message;
  } finally {
    if (carica) hideLoadingOverlay(carica.gen);
  }
}

function playPlaylistFrom(tracks, startIndex) {
  const items = tracks.map(libraryItemFromTrack);
  playFromList(items, startIndex || 0, null);
}

async function playOpenPlaylist() {
  if (!openPlaylistId) return;
  try {
    const pl = await apiJson(`/api/playlists/${openPlaylistId}`);
    if (!pl.tracks || !pl.tracks.length) {
      toast("Playlist vuota");
      return;
    }
    playPlaylistFrom(pl.tracks, shuffleStartIndex(pl.tracks.length));
  } catch (err) {
    toast(err.message);
  }
}

// ═══════════════════════════════════════════════════════════
// ACCOUNT · LOGIN · DEVICES
// ═══════════════════════════════════════════════════════════

/** "Aggiorna app": pulisce SW/cache residui e forza una navigazione di rete pulita. */
async function forceAppUpdate() {
  toast("Aggiorno l'app…");
  try {
    if ("serviceWorker" in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
    if (window.caches && caches.keys) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } catch (_) {}
  setTimeout(() => {
    location.href = location.pathname + "?_upd=" + Date.now();
  }, 250);
}

function applyAvatarToEl(el, avatarUrl, fallback) {
  if (!el) return;
  if (avatarUrl) {
    const img = new Image();
    img.alt = "";
    img.src = mediaAuthUrl(avatarUrl, { bust: false });
    el.innerHTML = "";
    el.appendChild(img);
  } else {
    // stringa vuota esplicita = niente emoji, resta il cerchio col
    // gradiente da solo (usato per la card account, vedi updateAccountUI)
    el.textContent = fallback !== undefined ? fallback : "⚡";
  }
}

// —— card "tossici online" ——
let _onlineUsersPollTimer = null;
let _onlineUsersOpen = false;

function renderOnlineUsersList(users) {
  const list = document.getElementById("onlineUsersList");
  const empty = document.getElementById("onlineUsersEmpty");
  if (!list) return;
  list.innerHTML = "";
  empty.classList.toggle("hidden", !!(users && users.length));
  for (const u of users || []) {
    const row = document.createElement("div");
    row.className = "online-user-row" + (u.is_playing ? "" : " paused");
    row.innerHTML = `
      <div class="online-user-avatar-wrap">
        <div class="online-user-avatar"></div>
        <span class="online-user-dot${u.is_playing ? "" : " paused"}"></span>
      </div>
      <div class="online-user-info">
        <div class="online-user-name"></div>
        <div class="online-user-track"></div>
      </div>
      <div class="online-user-eq" aria-hidden="true"><span></span><span></span><span></span></div>
    `;
    applyAvatarToEl(row.querySelector(".online-user-avatar"), u.avatar_url, "🎧");
    row.querySelector(".online-user-name").textContent = u.display_name || "?";
    const track = [u.title, u.artist].filter(Boolean).join(" · ");
    row.querySelector(".online-user-track").textContent = track || "—";
    list.appendChild(row);
  }
}

async function loadOnlineUsers() {
  // da fuori (login) o offline il server risponde 401: girava ogni 20 s e
  // ogni 401 riapriva il login con "Sessione scaduta" e la tastiera
  // (Vitto, 06/10)
  if (!authState.authenticated || appOfflineMode) return;
  const badge = document.getElementById("onlineUsersBadge");
  try {
    const data = await apiJson("/api/home/online");
    const users = data.users || [];
    if (badge) {
      badge.classList.toggle("hidden", users.length === 0);
      badge.textContent = String(users.length);
    }
    if (_onlineUsersOpen) renderOnlineUsersList(users);
  } catch (_) {
    // silenzioso: non è critico, riprova al prossimo giro
  }
}

function closeOnlineUsersPanel() {
  const panel = document.getElementById("onlineUsersPanel");
  if (panel) panel.classList.add("hidden");
  _onlineUsersOpen = false;
}

function toggleOnlineUsersPanel() {
  const panel = document.getElementById("onlineUsersPanel");
  if (!panel) return;
  _onlineUsersOpen = panel.classList.contains("hidden");
  panel.classList.toggle("hidden");
  if (_onlineUsersOpen) loadOnlineUsers();
}

function initOnlineUsersWidget() {
  const btn = document.getElementById("btnOnlineUsers");
  if (!btn) return;
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleOnlineUsersPanel();
  });
  document.addEventListener("click", (e) => {
    const panel = document.getElementById("onlineUsersPanel");
    if (_onlineUsersOpen && panel && !panel.contains(e.target) && e.target !== btn) {
      closeOnlineUsersPanel();
    }
  });
  // badge sempre aggiornato (poll leggero), lista solo quando il pannello è aperto
  if (!_onlineUsersPollTimer) {
    _onlineUsersPollTimer = setInterval(loadOnlineUsers, 20000);
  }
  if (authState.authenticated) loadOnlineUsers();
}

function updateAccountUI() {
  const chip = document.getElementById("accountChip");
  const nameEl = document.getElementById("accountName");
  const subEl = document.getElementById("guestNote");
  const avatarEl = document.getElementById("accountAvatar");
  const mobileBtn = document.getElementById("btnAccountMobile");
  if (!chip) return;

  if (authState.authenticated && authState.user) {
    chip.classList.add("logged-in");
    const u = authState.user;
    if (nameEl) {
      nameEl.textContent = u.display_name || u.username || "User";
    }
    if (subEl) {
      subEl.classList.remove("hidden");
      subEl.textContent = "Impostazioni · @" + (u.username || "");
    }
    applyAvatarToEl(avatarEl, u.avatar_url, "");
    applyAvatarToEl(mobileBtn, u.avatar_url, "");
  } else {
    chip.classList.remove("logged-in");
    if (nameEl) nameEl.textContent = "Accedi";
    if (subEl) {
      subEl.classList.remove("hidden");
      subEl.textContent = "Tocca per entrare";
    }
    applyAvatarToEl(avatarEl, null, "");
    applyAvatarToEl(mobileBtn, null, "");
  }
}

function setAuthGate(locked) {
  document.body.classList.toggle("auth-locked", !!locked);
  document.body.classList.remove("auth-checking");
  document.documentElement.classList.toggle("need-login", !!locked);
  const modal = document.getElementById("loginModal");
  const closeBtn = document.getElementById("loginClose");
  if (modal) {
    modal.classList.toggle("login-gate", true);
  }
  // Chiudi solo se guest mode (AUTH_REQUIRED=false)
  if (closeBtn) {
    const canClose = !locked && !authState.authRequired;
    closeBtn.classList.toggle("hidden", !canClose);
  }
}

function openLoginModal(msg) {
  const modal = document.getElementById("loginModal");
  if (!modal) return;
  const err = document.getElementById("loginErr");
  if (err) {
    if (msg) {
      err.textContent = msg;
      err.hidden = false;
    } else {
      err.hidden = true;
      err.textContent = "";
    }
  }
  // Gate: blocca app finché non sei loggato (auth required)
  const gate = authState.authRequired !== false && !authState.authenticated;
  setAuthGate(gate);
  const giaAperto = !modal.classList.contains("hidden");
  modal.classList.remove("hidden");
  // nascondi intro — login prima di tutto
  try {
    const splash = document.getElementById("introSplash");
    if (splash && gate) {
      splash.classList.add("hide");
      document.body.classList.remove("intro-lock");
    }
  } catch (_) {}
  // il fuoco (quindi la tastiera) solo alla prima apertura: se il login è
  // già lì e l'utente ha chiuso la tastiera, non va riaperta da sola
  const user = document.getElementById("loginUser");
  if (user && !giaAperto) setTimeout(() => user.focus(), 80);
}

function closeLoginModal() {
  if (authState.authRequired && !authState.authenticated) {
    // non si può chiudere senza login
    return;
  }
  const modal = document.getElementById("loginModal");
  dismissKeyboard();
  if (modal) modal.classList.add("hidden");
  setAuthGate(false);
}

function showSettingsPanel(id) {
  // Travel mode: entrando dal pannello Offline le rotelle ripartono da 0 h
  // 0 min (Vitto, 05/10); tornando indietro dalla scelta dei brani no
  const daSceltaBrani =
    document.getElementById("settingsTravelPick")?.classList.contains("hidden") === false;
  const viaggioNuovo = id === "settingsTravel" && !daSceltaBrani;
  const panels = [
    "settingsHome",
    "settingsAccount",
    "settingsDevices",
    "settingsAppearance",
    "settingsSleepTimer",
    "settingsOffline",
    "settingsTravel",
    "settingsTravelPick",
  ];
  panels.forEach((pid) => {
    const el = document.getElementById(pid);
    if (el) el.classList.toggle("hidden", pid !== id);
  });
  if (id === "settingsDevices") loadDevices();
  if (id === "settingsAppearance") syncThemePicker();
  if (id === "settingsSleepTimer") syncSleepTimerPanel();
  if (id === "settingsHome") aggiornaCardOffline();
  if (id === "settingsOffline") aggiornaPannelloOffline();
  const scheda = document.querySelector("#accountModal .settings-card");
  if (scheda) {
    // scelta dei brani del viaggio: la scheda sta ferma ad altezza fissa e
    // scorre solo l'elenco (Vitto: «la card si stretcha mentre scorri»)
    scheda.classList.toggle("scheda-viaggio", id === "settingsTravelPick");
    // si arriva qui anche da metà pannello (la riga Travel mode sta in basso)
    if (id === "settingsOffline" || id === "settingsTravel" || id === "settingsTravelPick") {
      scheda.scrollTop = 0;
    }
  }
  if (id === "settingsTravel") {
    if (viaggioNuovo) viaggio.minuti = 0;
    viaggio.brani = []; // ricaricati al passo 2: i salvati possono essere cambiati
    viaggioPreparaRotelle();
  }
  if (id === "settingsTravelPick") viaggioApriScelta();
}

// —— TRAVEL MODE (05/10, Vitto): «selezionare un tot di minuti/ore da
// installare: se il volo dura 3h e mezzo l'utente deve poter installare in
// base al tempo d'ascolto e non a playlist». Passo 1: durata con le rotelle
// del timer di spegnimento. Passo 2: i brani salvati da spuntare, con in
// cima il conto di quanto manca (somma delle durate, che ci sono su tutti i
// salvati: verificato 158 su 158, formato "m:ss"). L'obiettivo è la durata
// × 1,3: Vitto stima un 30% di skip. Il risultato è una playlist offline
// come le altre ("Viaggio 6 ott · 3 h 30 min"), quindi Fast download, Resta
// offline, Rimuovi e la griglia offline valgono anche per lei. ——
const VIAGGIO_MARGINE_SKIP = 1.3;
const viaggio = {
  minuti: 0,
  brani: [],
  scelti: new Set(), // id, nell'ordine in cui li hai spuntati
  pid: null, // stessa playlist fra un tentativo e l'altro se qualcosa fallisce
  rotellePronte: false,
  filtro: "", // ricerca per nome nell'elenco (la riga "Cerca un brano")
};

/** Il download del viaggio, se ce n'è uno (in corso, in coda, in pausa o
 * fallito): finché c'è, la scelta resta bloccata e il tasto ne mostra lo stato. */
function viaggioLavoro() {
  return viaggio.pid ? lavoroDownload(viaggio.pid) : null;
}

/** Fine del download del viaggio: completato si riparte da zero per il
 * prossimo; interrotto si tiene la scelta, così la si può correggere. */
function viaggioFinito(completato) {
  viaggio.pid = null;
  if (completato) {
    viaggio.scelti.clear();
    viaggio.filtro = "";
    const qui = document.getElementById("settingsTravelPick");
    if (qui && !qui.classList.contains("hidden")) showSettingsPanel("settingsOffline");
  }
  viaggioAggiornaIndicatore();
  const lista = document.getElementById("viaggioLista");
  if (lista && completato) viaggioDisegnaLista();
}

function viaggioObiettivoSec() {
  return Math.round(viaggio.minuti * 60 * VIAGGIO_MARGINE_SKIP);
}

function viaggioPreparaRotelle() {
  const ore = document.getElementById("viaggioOreWheel");
  const min = document.getElementById("viaggioMinutiWheel");
  if (!ore || !min) return;
  if (!viaggio.rotellePronte) {
    sleepTimerBuildWheel(ore, 23, 1);
    sleepTimerBuildWheel(min, 55, 5);
    [ore, min].forEach((el) =>
      el.addEventListener(
        "scroll",
        () => {
          sleepTimerSyncWheelHighlight(el);
          viaggio.minuti =
            sleepTimerWheelValue(ore) * 60 + sleepTimerWheelValue(min);
          viaggioAggiornaMargine();
        },
        { passive: true }
      )
    );
    viaggio.rotellePronte = true;
  }
  // scrollTop si può impostare solo a pannello visibile (qui lo è già)
  const minuti = viaggio.minuti;
  ore.scrollTop = Math.floor(minuti / 60) * SLEEP_TIMER_WHEEL_ITEM_H;
  min.scrollTop = Math.round((minuti % 60) / 5) * SLEEP_TIMER_WHEEL_ITEM_H;
  sleepTimerSyncWheelHighlight(ore);
  sleepTimerSyncWheelHighlight(min);
  viaggioAggiornaMargine();
}

function viaggioAggiornaMargine() {
  const testo = document.getElementById("viaggioMargine");
  const avanti = document.getElementById("viaggioAvanti");
  if (avanti) avanti.disabled = viaggio.minuti <= 0;
  if (!testo) return;
  testo.textContent =
    viaggio.minuti > 0
      ? `Con il 30% in più per gli skip scarichi ${formatTotalDuration(viaggioObiettivoSec())} di musica`
      : "Scegli la durata del viaggio";
}

async function viaggioApriScelta() {
  const carico = document.getElementById("viaggioCarico");
  viaggioAggiornaIndicatore();
  if (!viaggio.brani.length) {
    let brani = libraryTracksCache.slice();
    if (!brani.length) {
      if (carico) {
        carico.textContent = "Carico i brani salvati…";
        carico.classList.remove("hidden");
      }
      try {
        const data = await apiJson("/api/library");
        brani = data.tracks || [];
      } catch (err) {
        if (carico) carico.textContent = "Non riesco a caricare i brani salvati: " + (err.message || err);
        return;
      }
    }
    viaggio.brani = brani.filter((t) => t && t.id && t.stream_url);
    // chi non è più fra i salvati esce anche dalla scelta
    const ci = new Set(viaggio.brani.map((t) => t.id));
    [...viaggio.scelti].forEach((id) => ci.has(id) || viaggio.scelti.delete(id));
  }
  if (carico) {
    carico.classList.toggle("hidden", !!viaggio.brani.length);
    if (!viaggio.brani.length) carico.textContent = "Nessun brano salvato: metti il cuore a qualche brano e torna qui";
  }
  viaggioDisegnaLista();
  viaggioAggiornaIndicatore();
}

function viaggioDisegnaLista() {
  const lista = document.getElementById("viaggioLista");
  if (!lista) return;
  releaseLazyCovers(lista);
  lista.innerHTML = "";
  const offline = getOfflineTracks();
  const frag = document.createDocumentFragment();
  // Ricerca per nome "camuffata da brano" (Vitto, 05/10): prima riga
  // dell'elenco, stessa forma delle altre, lente al posto della copertina e
  // campo al posto del titolo. Filtra titolo/artista come i salvati.
  if (viaggio.brani.length) {
    const cerca = document.createElement("li");
    cerca.className = "viaggio-riga viaggio-cerca";
    const lente = document.createElement("span");
    lente.className = "viaggio-cover viaggio-cerca-lente";
    lente.innerHTML =
      '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>';
    const testo = document.createElement("span");
    testo.className = "viaggio-testo";
    const campo = document.createElement("input");
    campo.type = "search";
    campo.id = "viaggioCerca";
    campo.className = "viaggio-cerca-campo";
    campo.placeholder = "Cerca un brano";
    campo.autocomplete = "off";
    campo.setAttribute("autocorrect", "off");
    campo.setAttribute("autocapitalize", "off");
    campo.setAttribute("enterkeyhint", "search");
    campo.value = viaggio.filtro;
    const sotto = document.createElement("span");
    sotto.textContent = "Titolo o artista";
    testo.append(campo, sotto);
    const pulisci = document.createElement("button");
    pulisci.type = "button";
    pulisci.className = "viaggio-cerca-pulisci";
    pulisci.setAttribute("aria-label", "Cancella ricerca");
    pulisci.textContent = "×";
    cerca.append(lente, testo, pulisci);
    campo.addEventListener("input", () => {
      viaggio.filtro = campo.value;
      viaggioApplicaFiltro();
    });
    campo.addEventListener("keydown", (e) => {
      if (e.key === "Enter") campo.blur(); // giù la tastiera, resta il filtro
    });
    pulisci.addEventListener("click", (e) => {
      e.stopPropagation();
      campo.value = "";
      viaggio.filtro = "";
      viaggioApplicaFiltro();
    });
    frag.appendChild(cerca);
  }
  viaggio.brani.forEach((t) => {
    const scelto = viaggio.scelti.has(t.id);
    const li = document.createElement("li");
    li.className = "viaggio-riga" + (scelto ? " scelto" : "");
    li.dataset.id = t.id;
    li.setAttribute("role", "checkbox");
    li.setAttribute("aria-checked", String(scelto));
    const cover = document.createElement("span");
    cover.className = "viaggio-cover";
    cover.textContent = "♪";
    if (t.cover_url) lazyLoadCover(cover, mediaAuthUrl(t.cover_url, { bust: false }));
    const testo = document.createElement("span");
    testo.className = "viaggio-testo";
    const titolo = document.createElement("strong");
    titolo.textContent = t.title || "Senza titolo";
    const sotto = document.createElement("span");
    sotto.textContent = (t.artist || "") + (offline[t.id] ? " · già sul telefono" : "");
    testo.append(titolo, sotto);
    // niente durata sulla riga (Vitto: «un po' invasiva, tanto la vedi sopra»)
    const spunta = document.createElement("span");
    spunta.className = "viaggio-spunta";
    spunta.setAttribute("aria-hidden", "true");
    spunta.innerHTML =
      '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
    li.append(cover, testo, spunta);
    frag.appendChild(li);
  });
  if (viaggio.brani.length) {
    const vuota = document.createElement("li");
    vuota.className = "viaggio-nessuno hidden";
    vuota.textContent = "Nessun brano con questo nome";
    frag.appendChild(vuota);
  }
  lista.appendChild(frag);
  viaggioApplicaFiltro();
}

/** Nasconde le righe che non c'entrano col filtro senza ridisegnare
 * l'elenco: il campo resta lo stesso nodo, quindi tastiera e cursore non
 * saltano mentre scrivi. La scelta (e il contatore) non cambia. */
function viaggioApplicaFiltro() {
  const lista = document.getElementById("viaggioLista");
  if (!lista) return;
  const q = (viaggio.filtro || "").trim();
  const ok = q ? new Set(filterLibraryTracks(viaggio.brani, q).map((t) => t.id)) : null;
  let visibili = 0;
  lista.querySelectorAll(".viaggio-riga:not(.viaggio-cerca)").forEach((li) => {
    const si = !ok || ok.has(li.dataset.id);
    li.classList.toggle("fuori-filtro", !si);
    if (si) visibili++;
  });
  lista.querySelector(".viaggio-cerca")?.classList.toggle("con-testo", !!q);
  lista.querySelector(".viaggio-nessuno")?.classList.toggle("hidden", !q || visibili > 0);
}

function viaggioAggiornaIndicatore() {
  const ind = document.getElementById("viaggioIndicatore");
  const mancano = document.getElementById("viaggioMancano");
  const scelti = document.getElementById("viaggioScelti");
  const barra = document.getElementById("viaggioBarra");
  const nota = document.getElementById("viaggioNota");
  const btn = document.getElementById("viaggioScarica");
  const obiettivo = viaggioObiettivoSec();
  const perId = new Map(viaggio.brani.map((t) => [t.id, t]));
  const offline = getOfflineTracks();
  const veloce = fastDownloadAttivo();
  let sec = 0;
  let n = 0;
  let byte = 0;
  viaggio.scelti.forEach((id) => {
    const t = perId.get(id);
    if (!t) return;
    const d = parseDurationToSec(t.duration);
    sec += d;
    n++;
    // stima di quanto si scarica davvero: i brani già sul telefono non contano
    if (!offline[id]) byte += veloce ? d * 20000 : Number(t.size) || d * 40000;
  });
  const manca = obiettivo - sec;
  const coperto = manca <= 0;
  if (ind) ind.classList.toggle("completo", coperto);
  if (mancano) {
    mancano.textContent = coperto
      ? "Viaggio coperto"
      : `Mancano ${formatTotalDuration(Math.ceil(manca / 60) * 60)}`;
  }
  if (scelti) scelti.textContent = `${n} ${n === 1 ? "brano" : "brani"} · ${formatTotalDuration(sec)}`;
  if (barra) barra.style.width = `${obiettivo ? Math.min(100, (sec / obiettivo) * 100) : 0}%`;
  if (nota) {
    nota.textContent =
      "Durata viaggio + possibili skip" + // testo scelto da Vitto (05/10)
      (coperto && manca < -59 ? ` · ${formatTotalDuration(-manca)} di scorta` : "");
  }
  const lav = viaggioLavoro();
  const esci = document.getElementById("viaggioEsci");
  if (esci) esci.classList.toggle("hidden", !lav);
  if (btn) {
    btn.classList.toggle("in-corso", !!lav);
    btn.style.setProperty("--avanz", `${lav ? lav.pct || 0 : 0}%`);
    if (lav) {
      const p = Math.floor(lav.pct || 0);
      // in pausa o fallito il tasto riprende; mentre scarica è spento
      btn.disabled = lavoroAttivo(lav) || !!lav.annulla;
      btn.textContent = lav.annulla
        ? "Interrompo…"
        : lav.stato === "corso"
          ? `Scarico… ${p}%`
          : lav.stato === "coda"
            ? "In coda…"
            : lav.stato === "errore"
              ? `Riprova · ${lav.falliti} non scaricati`
              : `Riprendi · ${p}%`;
    } else if (!n) {
      btn.disabled = true;
      btn.textContent = "Scegli almeno un brano";
    } else {
      btn.disabled = false;
      btn.textContent =
        `Scarica ${n} ${n === 1 ? "brano" : "brani"}` + (byte ? ` · ~${formattaSpazio(byte)}` : "");
    }
  }
}

function viaggioScarica() {
  const lav = viaggioLavoro();
  if (lav) {
    // il tasto in pausa/fallito riprende
    if (!lavoroAttivo(lav)) riprendiLavoro(lav.pid);
    return;
  }
  if (!viaggio.scelti.size) return;
  const perId = new Map(viaggio.brani.map((t) => [t.id, t]));
  const tracks = [...viaggio.scelti].map((id) => perId.get(id)).filter(Boolean);
  if (!tracks.length) return;
  viaggio.pid = `__viaggio_${Date.now()}`;
  const giorno = new Date().toLocaleDateString("it-IT", { day: "numeric", month: "short" });
  const pl = { name: `Viaggio ${giorno} · ${formatTotalDuration(viaggio.minuti * 60)}`, tracks };
  // non si aspetta: il download va avanti anche uscendo da qui (Vitto,
  // 06/10) e si segue/gestisce dal pannello Offline mode
  downloadPlaylistOffline(viaggio.pid, pl, null);
  viaggioAggiornaIndicatore();
}

// —— OFFLINE MODE nelle impostazioni (05/10, Vitto: «una card con scritto
// OFFLINE MODE, così da poter gestire meglio i contenuti»). Solo app iPhone:
// serve il Filesystem nativo. Dentro: interruttore "Resta offline" (entra
// in modalità offline anche con la rete e non rientra da solo, nemmeno alla
// riapertura), spazio occupato, playlist scaricate una per una con
// "Rimuovi", ed "Elimina tutti i download". ——
const OFFLINE_RESTA_KEY = "crackify_offline_resta";

function offlineForzato() {
  try {
    return localStorage.getItem(OFFLINE_RESTA_KEY) === "1";
  } catch (_) {
    return false;
  }
}
function impostaOfflineForzato(on) {
  try {
    if (on) localStorage.setItem(OFFLINE_RESTA_KEY, "1");
    else localStorage.removeItem(OFFLINE_RESTA_KEY);
  } catch (_) {}
}

function formattaSpazio(byte) {
  if (!byte) return "0 MB";
  const mb = (byte || 0) / 1048576;
  if (mb >= 1024) return (mb / 1024).toFixed(1).replace(".", ",") + " GB";
  if (mb >= 10) return Math.round(mb) + " MB";
  return mb.toFixed(1).replace(".", ",") + " MB";
}

/** Peso vero dei file scaricati, letto dalla cartella (non stimato):
 * percorso → byte, più il totale (orfani compresi). */
async function pesiOffline() {
  const fs = offlineFs();
  const perPercorso = new Map();
  let totale = 0;
  if (!fs) return { perPercorso, totale };
  try {
    const res = await fs.readdir({ directory: "DATA", path: OFFLINE_DIR });
    for (const f of res.files || []) {
      if (!f || typeof f !== "object") continue;
      const byte = Number(f.size) || 0;
      perPercorso.set(`${OFFLINE_DIR}/${f.name}`, byte);
      totale += byte;
    }
  } catch (_) {
    // cartella mai creata = niente scaricato
  }
  return { perPercorso, totale };
}

function nomePlaylistOffline(pid, entry) {
  if (pid === OFFLINE_SAVED_PID) return "Brani salvati";
  return (entry && entry.pl && entry.pl.name) || "Playlist";
}

async function aggiornaCardOffline() {
  const card = document.getElementById("settingsOfflineCard");
  const sub = document.getElementById("settingsOfflineSub");
  if (!card) return;
  const fs = offlineFs();
  card.classList.toggle("hidden", !fs);
  if (!fs || !sub) return;
  const n = Object.keys(getOfflinePlaylists()).length;
  const corre = downloadLavori.find((l) => l.stato === "corso");
  const prima =
    (appOfflineMode ? "Attiva · " : "") +
    (corre
      ? `Download ${Math.floor(corre.pct || 0)}% · `
      : downloadLavori.length
        ? `${downloadLavori.length} ${downloadLavori.length === 1 ? "download fermo" : "download fermi"} · `
        : "");
  if (!n) {
    sub.textContent = prima + "Nessuna playlist scaricata";
    return;
  }
  const base = prima + `${n} playlist`;
  sub.textContent = base;
  const { totale } = await pesiOffline();
  if (totale) sub.textContent = `${base} · ${formattaSpazio(totale)}`;
}

let _offlineEliminaTimer = null;
function azzeraConfermaEliminaTutto() {
  const btn = document.getElementById("offlineEliminaTutto");
  const titolo = document.getElementById("offlineEliminaTitolo");
  const sotto = document.getElementById("offlineEliminaSub");
  if (_offlineEliminaTimer) clearTimeout(_offlineEliminaTimer);
  _offlineEliminaTimer = null;
  if (btn) btn.classList.remove("conferma");
  if (titolo) titolo.textContent = "Elimina tutti i download";
  if (sotto) sotto.textContent = "Libera lo spazio sul telefono";
}

async function aggiornaPannelloOffline() {
  const lista = document.getElementById("offlineLista");
  if (!lista) return;
  const vuoto = document.getElementById("offlineVuoto");
  const spazio = document.getElementById("offlineSpazio");
  const brani = document.getElementById("offlineBrani");
  const resta = document.getElementById("offlineResta");
  const stato = document.getElementById("offlineStato");
  const elimina = document.getElementById("offlineEliminaTutto");
  azzeraConfermaEliminaTutto();
  disegnaDownloadOffline();
  const playlists = getOfflinePlaylists();
  const tracce = getOfflineTracks();
  // "Brani salvati" sempre in cima, poi nell'ordine in cui sono state scaricate
  const voci = Object.entries(playlists).sort(
    (a, b) => (b[0] === OFFLINE_SAVED_PID) - (a[0] === OFFLINE_SAVED_PID)
  );
  if (stato) {
    stato.textContent = !appOfflineMode
      ? "Le playlist scaricate si ascoltano anche senza rete"
      : offlineForzato()
        ? "Sei offline per scelta: si ascoltano solo i brani scaricati"
        : "Il Mac non risponde: si ascoltano solo i brani scaricati";
  }
  if (resta) {
    resta.checked = offlineForzato();
    // senza niente di scaricato la modalità offline non avrebbe nulla da offrire
    resta.disabled = !voci.length && !resta.checked;
  }
  if (brani) brani.textContent = String(Object.keys(tracce).length);
  const rigaViaggio = document.getElementById("offlineViaggioRiga");
  const subViaggio = document.getElementById("offlineViaggioSub");
  if (rigaViaggio) rigaViaggio.disabled = appOfflineMode; // scaricare vuole il Mac
  if (subViaggio) {
    subViaggio.textContent = appOfflineMode
      ? "Serve la connessione al Mac"
      : "Scarica in base alla durata del viaggio";
  }
  const veloce = document.getElementById("offlineVeloce");
  if (veloce) veloce.checked = fastDownloadAttivo();
  // fino al conto dei file si decide sulle mappe; dopo (più sotto) sui file veri
  const qualcosa = voci.length || Object.keys(tracce).length;
  if (elimina) elimina.classList.toggle("hidden", !qualcosa);
  if (vuoto) vuoto.classList.toggle("hidden", !!qualcosa);
  lista.innerHTML = "";
  const righe = voci.map(([pid, entry]) => {
    const ts = (entry.pl && entry.pl.tracks) || [];
    const li = document.createElement("li");
    li.dataset.pid = pid;
    const cover = document.createElement("span");
    cover.className = "offline-lista-cover";
    cover.textContent =
      pid === OFFLINE_SAVED_PID ? "♥" : pid.startsWith("__viaggio_") ? "✈" : "♪";
    const testo = document.createElement("span");
    testo.className = "offline-lista-testo";
    const nome = document.createElement("strong");
    nome.textContent = nomePlaylistOffline(pid, entry);
    const info = document.createElement("span");
    info.textContent = `${ts.length} ${ts.length === 1 ? "brano" : "brani"}`;
    testo.append(nome, info);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "offline-lista-rimuovi";
    btn.textContent = "Rimuovi";
    let confermaTimer = null;
    btn.addEventListener("click", async () => {
      // doppio tocco: riscaricare una playlist fuori casa costa minuti
      if (!btn.classList.contains("conferma")) {
        btn.classList.add("conferma");
        btn.textContent = "Sicuro?";
        confermaTimer = setTimeout(() => {
          btn.classList.remove("conferma");
          btn.textContent = "Rimuovi";
        }, 3000);
        return;
      }
      clearTimeout(confermaTimer);
      btn.disabled = true;
      const w =
        pid === OFFLINE_SAVED_PID ? libOfflineW : pid === openPlaylistId ? plOfflineW : {};
      await removePlaylistOffline(pid, w);
      aggiornaPannelloOffline();
    });
    li.append(cover, testo, btn);
    lista.appendChild(li);
    // copertina del primo brano che ne ha una scaricata (offline non c'è rete)
    const conCover = ts.find((t) => tracce[t.id] && tracce[t.id].coverPath);
    if (conCover) {
      getOfflineTrackCoverSrc(conCover.id).then((src) => {
        if (!src) return;
        const img = document.createElement("img");
        img.className = "offline-lista-cover";
        img.alt = "";
        img.src = src;
        img.onload = () => cover.replaceWith(img);
      });
    }
    return { info, ts };
  });
  if (spazio) spazio.textContent = "…";
  const { perPercorso, totale } = await pesiOffline();
  if (spazio) spazio.textContent = formattaSpazio(totale);
  // Brani rimasti senza playlist: un download interrotto o con qualche brano
  // fallito non registra la playlist, ma i brani arrivati restano sul
  // telefono (riprovando si riparte da lì). Prima non comparivano da nessuna
  // parte e non c'era modo di toglierli (Vitto, 05/10).
  const orfani = brani_orfani(playlists, tracce, perPercorso);
  if (orfani.brani || orfani.file.length) {
    const li = document.createElement("li");
    li.className = "offline-lista-orfani";
    const ico = document.createElement("span");
    ico.className = "offline-lista-cover";
    ico.textContent = "↓";
    const testo = document.createElement("span");
    testo.className = "offline-lista-testo";
    const nome = document.createElement("strong");
    nome.textContent = "Non completati";
    const info = document.createElement("span");
    // brani nelle mappe + file audio sconosciuti (le copertine non contano)
    const n = orfani.brani + orfani.file.filter((p) => !/_cover\./.test(p)).length || 1;
    info.textContent = `${n} ${n === 1 ? "brano" : "brani"} · ${formattaSpazio(orfani.byte)}`;
    testo.append(nome, info);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "offline-lista-rimuovi";
    btn.textContent = "Rimuovi";
    let confermaTimer = null;
    btn.addEventListener("click", async () => {
      if (!btn.classList.contains("conferma")) {
        btn.classList.add("conferma");
        btn.textContent = "Sicuro?";
        confermaTimer = setTimeout(() => {
          btn.classList.remove("conferma");
          btn.textContent = "Rimuovi";
        }, 3000);
        return;
      }
      clearTimeout(confermaTimer);
      btn.disabled = true;
      await eliminaOrfaniOffline();
      toast("Download non completati rimossi");
      aggiornaPannelloOffline();
    });
    li.append(ico, testo, btn);
    lista.appendChild(li);
  }
  const suDisco = qualcosa || totale > 0;
  if (elimina) elimina.classList.toggle("hidden", !suDisco);
  if (vuoto) vuoto.classList.toggle("hidden", !!suDisco);
  righe.forEach(({ info, ts }) => {
    let byte = 0;
    ts.forEach((t) => {
      const e = tracce[t.id];
      if (!e) return;
      byte += perPercorso.get(e.path) || 0;
      if (e.coverPath) byte += perPercorso.get(e.coverPath) || 0;
    });
    if (byte) info.textContent += ` · ${formattaSpazio(byte)}`;
  });
}

/** Brani scaricati che nessuna playlist registrata usa più, e file nella
 * cartella che le mappe non conoscono nemmeno (es. un brano a metà). */
function brani_orfani(playlists, tracce, perPercorso) {
  const usati = new Set();
  Object.values(playlists).forEach((e) =>
    ((e.pl && e.pl.tracks) || []).forEach((t) => usati.add(t.id))
  );
  // i brani di un download in corso/in pausa non sono "non completati":
  // sono suoi, e li gestisce la sezione Download
  downloadLavori.forEach((l) => (l.pl.tracks || []).forEach((t) => usati.add(t.id)));
  const ids = Object.keys(tracce).filter((id) => !usati.has(id));
  const noti = new Set();
  Object.values(tracce).forEach((e) => {
    if (e.path) noti.add(e.path);
    if (e.coverPath) noti.add(e.coverPath);
  });
  const file = [...perPercorso.keys()].filter((p) => !noti.has(p));
  let byte = 0;
  ids.forEach((id) => {
    byte += perPercorso.get(tracce[id].path) || 0;
    if (tracce[id].coverPath) byte += perPercorso.get(tracce[id].coverPath) || 0;
  });
  file.forEach((p) => (byte += perPercorso.get(p) || 0));
  return { ids, brani: ids.length, file, byte };
}

async function eliminaOrfaniOffline() {
  const fs = offlineFs();
  const tracce = getOfflineTracks();
  const { perPercorso } = await pesiOffline();
  const { ids, file } = brani_orfani(getOfflinePlaylists(), tracce, perPercorso);
  const daCancellare = [...file];
  ids.forEach((id) => {
    if (tracce[id].path) daCancellare.push(tracce[id].path);
    if (tracce[id].coverPath) daCancellare.push(tracce[id].coverPath);
    delete tracce[id];
  });
  if (fs) {
    for (const p of daCancellare) {
      try {
        await fs.deleteFile({ directory: "DATA", path: p });
      } catch (_) {}
    }
  }
  setOfflineTracks(tracce);
}

async function eliminaTuttiOffline() {
  const fs = offlineFs();
  // anche i download: quelli fermi spariscono subito, quello che gira si
  // ferma appena finiscono i brani in volo e cancella quello che arriva
  downloadLavori.slice().forEach((l) => {
    l.annulla = true;
    if (_lavoroInCorso !== l) {
      downloadLavori.splice(downloadLavori.indexOf(l), 1);
      if (l.pid === viaggio.pid) viaggioFinito(false);
      _risolviAttese(l.pid);
    }
  });
  salvaCodaDownload();
  // un brano scaricato che suona ora perderebbe il file sotto i piedi
  try {
    if (audio && !audio.paused && audio.src && !/^https?:/i.test(audio.src)) audio.pause();
  } catch (_) {}
  if (fs) {
    let fatto = false;
    try {
      await fs.rmdir({ directory: "DATA", path: OFFLINE_DIR, recursive: true });
      fatto = true;
    } catch (_) {}
    if (!fatto) {
      for (const e of Object.values(getOfflineTracks())) {
        for (const p of [e.path, e.coverPath]) {
          if (!p) continue;
          try {
            await fs.deleteFile({ directory: "DATA", path: p });
          } catch (_) {}
        }
      }
    }
  }
  setOfflineTracks({});
  setOfflinePlaylists({});
  updatePlOfflineButtonUi("idle", 0, plOfflineW);
  updatePlOfflineButtonUi("idle", 0, libOfflineW);
  // offline senza niente di scaricato non serve: l'interruttore si spegne
  // e se il Mac risponde si torna online
  impostaOfflineForzato(false);
  if (appOfflineMode) {
    renderOfflinePlaylistsGrid();
    _offlineReconnectAttempt();
  }
  toast("Download eliminati");
}

async function cambiaRestaOffline(acceso) {
  const resta = document.getElementById("offlineResta");
  if (acceso) {
    if (!Object.keys(getOfflinePlaylists()).length) {
      if (resta) resta.checked = false;
      toast("Scarica prima almeno una playlist");
      return;
    }
    impostaOfflineForzato(true);
    if (appOfflineMode) {
      aggiornaPannelloOffline();
      return;
    }
    closeAccountModal();
    // uno stream dal Mac non ha senso in modalità offline: fermalo pulito
    try {
      if (audio && !audio.paused && /^https?:/i.test(audio.src || "")) audio.pause();
    } catch (_) {}
    if (_onlineDropTimer) {
      clearInterval(_onlineDropTimer);
      _onlineDropTimer = null;
    }
    enterOfflineMode("scelta");
    return;
  }
  impostaOfflineForzato(false);
  if (!appOfflineMode) {
    aggiornaPannelloOffline();
    return;
  }
  if (resta) resta.disabled = true;
  const ok = await checkServerReachable(3500);
  if (resta) resta.disabled = false;
  if (ok) {
    closeAccountModal();
    showOnlineReturnIntro();
  } else {
    // il giro di controllo è ancora attivo: rientra da solo appena il Mac risponde
    toast("Il Mac non risponde: torno online appena c'è rete");
    aggiornaPannelloOffline();
  }
}

// —— timer spegnimento ("Spegni musica tra") — richiesta di Vitto,
// 2026-08-07: come il timer di Spotify (ferma la musica dopo N minuti,
// utile per addormentarsi con la musica in sottofondo) ma con rotelle
// libere ore/minuti stile Timer di iOS invece di preset fissi. ——
const SLEEP_TIMER_STORAGE_KEY = "crackify_sleep_timer_end_at";
const SLEEP_TIMER_WHEEL_ITEM_H = 44;
const SLEEP_TIMER_MAX_HOURS = 5;
let sleepTimerEndAt = null; // epoch ms, null = non attivo
let sleepTimerTimeoutId = null;
let sleepTimerDisplayInterval = null;

/** Riempie una rotella (0..max, passo step) con l'imbottitura sopra/sotto
 * di un elemento vuoto — trucco standard dei wheel-picker: senza, il primo
 * e l'ultimo valore vero non potrebbero mai arrivare al centro (sotto la
 * fascia), solo avvicinarsi al bordo. */
function sleepTimerBuildWheel(container, max, step) {
  if (!container) return;
  container.innerHTML = "";
  const spacer = () => {
    const s = document.createElement("div");
    s.style.height = `${SLEEP_TIMER_WHEEL_ITEM_H}px`;
    s.setAttribute("aria-hidden", "true");
    return s;
  };
  container.appendChild(spacer());
  for (let v = 0; v <= max; v += step) {
    const item = document.createElement("div");
    item.className = "sleep-timer-wheel-item";
    item.textContent = String(v).padStart(2, "0");
    item.dataset.value = String(v);
    container.appendChild(item);
  }
  container.appendChild(spacer());
}

/** Valore centrato SOTTO la fascia in questo momento (scroll live, non
 * solo a fine gesto) — item più vicino a scrollTop una volta tolta
 * l'imbottitura iniziale. Usata sia per l'highlight in tempo reale sia per
 * leggere la scelta finale al tap su "Avvia". */
function sleepTimerWheelValue(container) {
  if (!container) return 0;
  const idx = Math.round(container.scrollTop / SLEEP_TIMER_WHEEL_ITEM_H);
  const item = container.children[idx + 1]; // +1 per lo spacer iniziale
  return item ? Number(item.dataset.value || 0) : 0;
}

// indice dell'ultimo tick aptico per rotella (elemento → indice) — serve a
// far scattare haptic() solo quando il valore CENTRATO cambia davvero, non
// a ogni pixel di scroll (altrimenti sarebbe un ronzio continuo invece dei
// tick discreti di una rotella vera, richiesta di Vitto 2026-08-07: "ok
// spacca aggiungia la vibrazione quando scelgi il tempo")
const _sleepTimerLastTickIdx = new WeakMap();
function sleepTimerSyncWheelHighlight(container) {
  if (!container) return;
  const idx = Math.round(container.scrollTop / SLEEP_TIMER_WHEEL_ITEM_H) + 1;
  Array.from(container.children).forEach((el, i) => {
    if (el.classList) el.classList.toggle("centered", i === idx);
  });
  const lastIdx = _sleepTimerLastTickIdx.get(container);
  if (lastIdx !== undefined && lastIdx !== idx) haptic(6);
  _sleepTimerLastTickIdx.set(container, idx);
}

function sleepTimerInitWheels() {
  const hoursEl = document.getElementById("sleepTimerHoursWheel");
  const minutesEl = document.getElementById("sleepTimerMinutesWheel");
  sleepTimerBuildWheel(hoursEl, SLEEP_TIMER_MAX_HOURS, 1);
  sleepTimerBuildWheel(minutesEl, 59, 1);
  // parte già su 0h 15min — un timer a 0/0 non avrebbe senso da avviare
  if (minutesEl) minutesEl.scrollTop = 15 * SLEEP_TIMER_WHEEL_ITEM_H;
  [hoursEl, minutesEl].forEach((el) => {
    if (!el) return;
    el.addEventListener("scroll", () => sleepTimerSyncWheelHighlight(el), { passive: true });
    sleepTimerSyncWheelHighlight(el);
  });
}

function sleepTimerFormatClock(msRemaining) {
  const totalSec = Math.max(0, Math.round(msRemaining / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

/** Aggiorna sia il pannello (se aperto) sia il sottotitolo della riga in
 * home impostazioni (visibile anche col pannello chiuso — l'utente deve
 * vedere a colpo d'occhio se un timer è già attivo senza doverci entrare). */
function syncSleepTimerPanel() {
  const picker = document.getElementById("sleepTimerPicker");
  const active = document.getElementById("sleepTimerActive");
  const remainingEl = document.getElementById("sleepTimerRemaining");
  const rowSub = document.getElementById("sleepTimerRowSub");
  const isActive = !!sleepTimerEndAt;
  if (picker) picker.classList.toggle("hidden", isActive);
  if (active) active.classList.toggle("hidden", !isActive);
  if (isActive) {
    const remaining = sleepTimerEndAt - Date.now();
    if (remainingEl) remainingEl.textContent = sleepTimerFormatClock(remaining);
    if (rowSub) rowSub.textContent = `Tra ${sleepTimerFormatClock(remaining)}`;
  } else {
    if (rowSub) rowSub.textContent = "Off";
  }
}

function startSleepTimer(totalMinutes) {
  if (totalMinutes <= 0) {
    toast("Scegli un tempo maggiore di zero");
    return;
  }
  clearTimeout(sleepTimerTimeoutId);
  sleepTimerEndAt = Date.now() + totalMinutes * 60000;
  localStorage.setItem(SLEEP_TIMER_STORAGE_KEY, String(sleepTimerEndAt));
  sleepTimerArmTimeout();
  syncSleepTimerPanel();
  toast(`Musica in pausa tra ${totalMinutes} min`);
}

/** setTimeout PIÙ un controllo su Date.now() a ogni risveglio della pagina
 * (vedi visibilitychange sotto) — su iOS/WKWebView i timer JS non sono
 * garantiti mentre l'app è in background (schermo bloccato, esattamente lo
 * scenario "vado a dormire" per cui esiste questa funzione): un setTimeout
 * da solo potrebbe non scattare mai finché l'utente non riapre l'app. Il
 * controllo su Date.now() recupera il caso, il setTimeout resta comunque
 * il modo più pronto quando l'app è attiva davvero. */
function sleepTimerArmTimeout() {
  clearTimeout(sleepTimerTimeoutId);
  if (!sleepTimerEndAt) return;
  const ms = sleepTimerEndAt - Date.now();
  if (ms <= 0) {
    fireSleepTimer();
    return;
  }
  sleepTimerTimeoutId = setTimeout(fireSleepTimer, ms);
}

function fireSleepTimer() {
  clearTimeout(sleepTimerTimeoutId);
  sleepTimerTimeoutId = null;
  sleepTimerEndAt = null;
  localStorage.removeItem(SLEEP_TIMER_STORAGE_KEY);
  if (audio && !audio.paused) audio.pause();
  // ferma anche una battuta di JARVIS in corso, altrimenti resta a parlare
  // nel silenzio dopo che la musica vera si è già fermata
  if (jarvisSpeechAudio && !jarvisSpeechAudio.paused) jarvisSpeechAudio.pause();
  setPlayingUi(false);
  toast("Musica in pausa — buonanotte");
  syncSleepTimerPanel();
}

function cancelSleepTimer() {
  clearTimeout(sleepTimerTimeoutId);
  sleepTimerTimeoutId = null;
  sleepTimerEndAt = null;
  localStorage.removeItem(SLEEP_TIMER_STORAGE_KEY);
  syncSleepTimerPanel();
  toast("Timer annullato");
}

/** All'avvio dell'app: un timer impostato in una sessione precedente (o
 * appena prima che l'app venisse chiusa/il telefono si spegnesse) va
 * ripreso da localStorage — altrimenti "spegni tra 30 min" e chiudere
 * l'app subito dopo lo cancellerebbe silenziosamente, l'opposto di quello
 * che l'utente si aspetta da un timer "vado a dormire". */
function sleepTimerRestoreFromStorage() {
  const raw = localStorage.getItem(SLEEP_TIMER_STORAGE_KEY);
  if (!raw) return;
  const endAt = Number(raw);
  if (!endAt || Number.isNaN(endAt)) {
    localStorage.removeItem(SLEEP_TIMER_STORAGE_KEY);
    return;
  }
  sleepTimerEndAt = endAt;
  sleepTimerArmTimeout(); // se già scaduto, ferma subito (vedi dentro)
}
sleepTimerRestoreFromStorage();
syncSleepTimerPanel(); // sottotitolo riga "Spegni musica tra" corretto già al primo render

// aggiorna il conto alla rovescia visibile una volta al secondo SOLO
// mentre il pannello è aperto (niente interval permanente per un numero
// che nessuno sta guardando) — vedi showSettingsPanel/wireSleepTimerUI
setInterval(() => {
  const panel = document.getElementById("settingsSleepTimer");
  if (panel && !panel.classList.contains("hidden")) syncSleepTimerPanel();
}, 1000);

// stesso motivo del setTimeout in sleepTimerArmTimeout: se il timer doveva
// scattare MENTRE l'app era in background e il setTimeout non è partito,
// il ritorno in foreground è il primo momento sicuro per accorgersene.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && sleepTimerEndAt) sleepTimerArmTimeout();
});

function wireSleepTimerUI() {
  sleepTimerInitWheels();
  const startBtn = document.getElementById("sleepTimerStart");
  const cancelBtn = document.getElementById("sleepTimerCancel");
  if (startBtn) {
    startBtn.addEventListener("click", () => {
      const h = sleepTimerWheelValue(document.getElementById("sleepTimerHoursWheel"));
      const m = sleepTimerWheelValue(document.getElementById("sleepTimerMinutesWheel"));
      startSleepTimer(h * 60 + m);
    });
  }
  if (cancelBtn) cancelBtn.addEventListener("click", () => cancelSleepTimer());
}

function syncThemePicker() {
  const cur = getUiTheme();
  document.querySelectorAll(".theme-option").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.theme === cur);
  });
}

function fillSettingsUser() {
  const u = authState.user || {};
  const name = u.display_name || u.username || "Account";
  const userEl = document.getElementById("settingsUserName");
  const detail = document.getElementById("accountDetail");
  const infoUser = document.getElementById("settingsInfoUser");
  const infoRole = document.getElementById("settingsInfoRole");
  const nickInput = document.getElementById("profileNicknameInput");
  const avatarRemoveBtn = document.getElementById("profileAvatarRemove");
  if (userEl) userEl.textContent = name;
  if (detail) {
    detail.textContent =
      "@" +
      (u.username || "—") +
      (u.role === "admin" ? " · admin" : " · user");
  }
  if (infoUser) infoUser.textContent = u.username ? "@" + u.username : "—";
  if (infoRole) infoRole.textContent = u.role === "admin" ? "Admin" : "User";
  if (nickInput) nickInput.value = name;
  applyAvatarToEl(document.getElementById("settingsAvatar"), u.avatar_url, "");
  applyAvatarToEl(document.getElementById("profileAvatarPreview"), u.avatar_url, "");
  if (avatarRemoveBtn) avatarRemoveBtn.classList.toggle("hidden", !u.avatar_url);
}

async function saveProfileNickname() {
  const input = document.getElementById("profileNicknameInput");
  const hint = document.getElementById("profileSaveHint");
  if (!input) return;
  const name = input.value.trim();
  if (!name) {
    if (hint) {
      hint.textContent = "Il nickname non può essere vuoto";
      hint.classList.remove("hidden", "ok");
      hint.classList.add("err");
    }
    return;
  }
  try {
    const r = await apiJson("/api/me/profile", { display_name: name }, "PATCH");
    if (r && r.user) authState.user = r.user;
    updateAccountUI();
    fillSettingsUser();
    if (hint) {
      hint.textContent = "Nickname salvato";
      hint.classList.remove("hidden", "err");
      hint.classList.add("ok");
    }
    toast("Nickname aggiornato");
  } catch (e) {
    if (hint) {
      hint.textContent = e.message || "Errore salvataggio";
      hint.classList.remove("hidden", "ok");
      hint.classList.add("err");
    }
  }
}

async function uploadProfileAvatar(file, filename) {
  const hint = document.getElementById("profileSaveHint");
  if (!file) return;
  const fd = new FormData();
  fd.append("file", file, filename || "avatar.jpg");
  try {
    const res = await fetch(apiUrl("/api/me/avatar"), {
      method: "POST",
      headers: authHeaders(),
      credentials: "same-origin",
      body: fd,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || "Upload fallito");
    if (data.user) authState.user = data.user;
    updateAccountUI();
    fillSettingsUser();
    toast("Foto profilo aggiornata");
  } catch (e) {
    if (hint) {
      hint.textContent = e.message || "Errore upload";
      hint.classList.remove("hidden", "ok");
      hint.classList.add("err");
    }
  }
}

async function removeProfileAvatar() {
  try {
    const r = await apiJson("/api/me/avatar", null, "DELETE");
    if (r && r.user) authState.user = r.user;
    updateAccountUI();
    fillSettingsUser();
    toast("Foto profilo rimossa");
  } catch (e) {
    toast(e.message || "Errore rimozione foto");
  }
}

// ── Ritaglio foto profilo (pan + zoom su viewport circolare) ──
const _cropState = {
  objectUrl: null,
  naturalW: 0,
  naturalH: 0,
  baseScale: 1,
  zoom: 1,
  offsetX: 0,
  offsetY: 0,
  viewportSize: 260,
  dragging: false,
  startX: 0,
  startY: 0,
  startOffX: 0,
  startOffY: 0,
  onConfirm: null,
};

function _cropClamp() {
  const s = _cropState.baseScale * _cropState.zoom;
  const dw = _cropState.naturalW * s;
  const dh = _cropState.naturalH * s;
  const vp = _cropState.viewportSize;
  const minX = Math.min(0, vp - dw);
  const minY = Math.min(0, vp - dh);
  _cropState.offsetX = Math.min(0, Math.max(minX, _cropState.offsetX));
  _cropState.offsetY = Math.min(0, Math.max(minY, _cropState.offsetY));
}

function _cropApplyTransform() {
  const img = document.getElementById("avatarCropImg");
  if (!img) return;
  const s = _cropState.baseScale * _cropState.zoom;
  img.style.transform = `translate(${_cropState.offsetX}px, ${_cropState.offsetY}px) scale(${s})`;
}

function openAvatarCropModal(file, onConfirm) {
  const modal = document.getElementById("avatarCropModal");
  const img = document.getElementById("avatarCropImg");
  const zoomInput = document.getElementById("avatarCropZoom");
  if (!modal || !img) return;
  _cropState.onConfirm =
    onConfirm || ((blob) => uploadProfileAvatar(blob, "avatar.jpg"));
  if (_cropState.objectUrl) URL.revokeObjectURL(_cropState.objectUrl);
  const url = URL.createObjectURL(file);
  _cropState.objectUrl = url;
  img.onload = () => {
    const vp = _cropState.viewportSize;
    _cropState.naturalW = img.naturalWidth;
    _cropState.naturalH = img.naturalHeight;
    _cropState.baseScale = vp / Math.min(img.naturalWidth, img.naturalHeight);
    _cropState.zoom = 1;
    if (zoomInput) zoomInput.value = 100;
    // centra l'immagine nel viewport
    const dw = _cropState.naturalW * _cropState.baseScale;
    const dh = _cropState.naturalH * _cropState.baseScale;
    _cropState.offsetX = (vp - dw) / 2;
    _cropState.offsetY = (vp - dh) / 2;
    _cropClamp();
    _cropApplyTransform();
  };
  img.src = url;
  modal.classList.remove("hidden");
}

function closeAvatarCropModal() {
  const modal = document.getElementById("avatarCropModal");
  if (modal) modal.classList.add("hidden");
  if (_cropState.objectUrl) {
    URL.revokeObjectURL(_cropState.objectUrl);
    _cropState.objectUrl = null;
  }
}

function confirmAvatarCrop() {
  const img = document.getElementById("avatarCropImg");
  if (!img || !_cropState.naturalW) return;
  const s = _cropState.baseScale * _cropState.zoom;
  const vp = _cropState.viewportSize;
  const srcX = -_cropState.offsetX / s;
  const srcY = -_cropState.offsetY / s;
  const srcSize = vp / s;
  const OUT = 480;
  const canvas = document.createElement("canvas");
  canvas.width = OUT;
  canvas.height = OUT;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, srcX, srcY, srcSize, srcSize, 0, 0, OUT, OUT);
  canvas.toBlob(
    (blob) => {
      if (blob && _cropState.onConfirm) _cropState.onConfirm(blob);
      closeAvatarCropModal();
    },
    "image/jpeg",
    0.92
  );
}

function wireAvatarCropUI() {
  const viewport = document.getElementById("avatarCropViewport");
  const zoomInput = document.getElementById("avatarCropZoom");
  const cancelBtn = document.getElementById("avatarCropCancel");
  const closeBtn = document.getElementById("avatarCropClose");
  const confirmBtn = document.getElementById("avatarCropConfirm");
  const modal = document.getElementById("avatarCropModal");

  if (zoomInput) {
    zoomInput.addEventListener("input", () => {
      _cropState.zoom = Number(zoomInput.value) / 100;
      _cropClamp();
      _cropApplyTransform();
    });
  }
  if (viewport) {
    const onDown = (e) => {
      _cropState.dragging = true;
      viewport.classList.add("dragging");
      _cropState.startX = e.clientX;
      _cropState.startY = e.clientY;
      _cropState.startOffX = _cropState.offsetX;
      _cropState.startOffY = _cropState.offsetY;
      viewport.setPointerCapture && viewport.setPointerCapture(e.pointerId);
    };
    const onMove = (e) => {
      if (!_cropState.dragging) return;
      _cropState.offsetX = _cropState.startOffX + (e.clientX - _cropState.startX);
      _cropState.offsetY = _cropState.startOffY + (e.clientY - _cropState.startY);
      _cropClamp();
      _cropApplyTransform();
    };
    const onUp = () => {
      _cropState.dragging = false;
      viewport.classList.remove("dragging");
    };
    viewport.addEventListener("pointerdown", onDown);
    viewport.addEventListener("pointermove", onMove);
    viewport.addEventListener("pointerup", onUp);
    viewport.addEventListener("pointercancel", onUp);
  }
  if (cancelBtn) cancelBtn.addEventListener("click", closeAvatarCropModal);
  if (closeBtn) closeBtn.addEventListener("click", closeAvatarCropModal);
  if (confirmBtn) confirmBtn.addEventListener("click", confirmAvatarCrop);
  if (modal) {
    modal.addEventListener("click", (e) => {
      if (e.target === modal) closeAvatarCropModal();
    });
  }
}

function openAccountModal() {
  const modal = document.getElementById("accountModal");
  if (!modal) return;
  // in modalità offline non c'è /api/me: le impostazioni si aprono lo stesso
  // (servono per spegnere "Resta offline"), le voci che vogliono il Mac
  // le nasconde il CSS
  if (!authState.authenticated && !appOfflineMode) {
    openLoginModal();
    return;
  }
  fillSettingsUser();
  showSettingsPanel("settingsHome");
  modal.classList.remove("hidden");
}

function closeAccountModal() {
  const modal = document.getElementById("accountModal");
  dismissKeyboard();
  if (modal) modal.classList.add("hidden");
  showSettingsPanel("settingsHome");
}

async function refreshMe() {
  // se non c’è token: mostra login subito (non aspettare rete)
  if (!getSessionToken()) {
    authState.authenticated = false;
    authState.user = null;
  }
  try {
    const me = await apiJson("/api/me");
    authState.authRequired = me.auth_required !== false; // default true
    authState.authenticated = !!me.authenticated;
    authState.user = me.user || null;
    authState.currentDeviceId = me.device_id || null;
    if (!me.authenticated) {
      if (getSessionToken()) setSessionToken(null);
    } else if (!authState.token) {
      authState.token = getSessionToken();
    }
  } catch (_) {
    // se /api/me fallisce e non c’è token → richiedi login
    authState.authenticated = false;
    authState.user = null;
    if (authState.authRequired === false) {
      /* guest ok */
    } else {
      authState.authRequired = true;
    }
  }
  updateAccountUI();
  // sidebar riempita appena sappiamo chi sei: questo e' il percorso
  // di avvio con sessione gia' valida (app Mac / ricarica), diverso
  // dal login col form piu' sotto
  renderSidebarLibrary();
  if (!authState.authenticated && authState.authRequired !== false) {
    openLoginModal();
  } else if (authState.authenticated) {
    // già loggato: niente gate
    document.documentElement.classList.remove("need-login");
    setAuthGate(false);
    const modal = document.getElementById("loginModal");
    if (modal) modal.classList.add("hidden");
    startSync();
    loadRecentServer();
    loadHomeCharts();
    loadHomeDailyMixes();
    loadHomeRadioStations();
    loadHomeRecommendedPlaylists();
    loadHomeQuickGrid();
    loadOnlineUsers();
  } else {
    setAuthGate(false);
    closeLoginModal();
  }
  return authState;
}

async function doLogin() {
  const userEl = document.getElementById("loginUser");
  const passEl = document.getElementById("loginPass");
  const err = document.getElementById("loginErr");
  const btn = document.getElementById("loginSubmit");
  const username = (userEl && userEl.value || "").trim();
  const password = (passEl && passEl.value) || "";
  if (!username || !password) {
    if (err) {
      err.textContent = "Inserisci username e password";
      err.hidden = false;
    }
    return;
  }
  if (btn) btn.disabled = true;
  try {
    const data = await apiJson("/api/auth/login", {
      username,
      password,
      device_name: guessDeviceName(),
      device_id: getOrCreateDeviceId(),
    });
    setSessionToken(data.token);
    authState.authenticated = true;
    authState.user = data.user;
    authState.currentDeviceId = data.device && data.device.id;
    try {
      if (data.device && data.device.id) {
        localStorage.setItem(DEVICE_KEY, data.device.id);
      }
    } catch (_) {}
    setAuthGate(false);
    document.documentElement.classList.remove("need-login");
    const modal = document.getElementById("loginModal");
    if (modal) modal.classList.add("hidden");
    updateAccountUI();
    renderSidebarLibrary();
    startSync();
    toast("Ciao " + (data.user.display_name || data.user.username));
    // ricarica libreria/playlist dell'utente
    if (typeof loadLibrary === "function") {
      try {
        await loadLibrary();
      } catch (_) {}
    }
    if (typeof loadPlaylists === "function") {
      try {
        await loadPlaylists();
      } catch (_) {}
    }
  } catch (e) {
    if (err) {
      err.textContent = "TOSSICO SEI STRAFATTO???";
      err.hidden = false;
    }
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function doLogout() {
  // il token che tiene aperto il canale sta per morire: chiudiamo noi,
  // senza lasciare il socket a rimbalzare sul backoff
  if (typeof stopSync === "function") stopSync();
  stopRemoteCommandPoll();
  try {
    await apiJson("/api/auth/logout", {}, "POST");
  } catch (_) {}
  setSessionToken(null);
  authState.authenticated = false;
  authState.user = null;
  authState.currentDeviceId = null;
  updateAccountUI();
  closeAccountModal();
  toast("Disconnesso");
  if (authState.authRequired) {
    openLoginModal();
  } else {
    // torna a legacy library
    if (typeof loadLibrary === "function") {
      try {
        await loadLibrary();
      } catch (_) {}
    }
    if (typeof loadPlaylists === "function") {
      try {
        await loadPlaylists();
      } catch (_) {}
    }
  }
}

function formatRelativeTime(secAgo) {
  if (secAgo == null || !Number.isFinite(secAgo)) return "sconosciuto";
  const s = Math.max(0, Math.floor(secAgo));
  if (s < 45) return "adesso";
  if (s < 3600) return Math.floor(s / 60) + " min fa";
  if (s < 86400) {
    const h = Math.floor(s / 3600);
    return h + (h === 1 ? " ora fa" : " ore fa");
  }
  if (s < 86400 * 7) {
    const d = Math.floor(s / 86400);
    return d + (d === 1 ? " giorno fa" : " giorni fa");
  }
  const w = Math.floor(s / (86400 * 7));
  return w + (w === 1 ? " settimana fa" : " settimane fa");
}

function devicePlatformIcon(platform) {
  const p = (platform || "").toLowerCase();
  if (p.includes("iphone") || p.includes("ipad") || p === "ios") return "📱";
  if (p.includes("android")) return "🤖";
  if (p.includes("mac")) return "💻";
  if (p.includes("windows")) return "🖥️";
  if (p.includes("linux")) return "🐧";
  return "🌐";
}

function getCurrentPlaybackPosition() {
  const t = Number(audio && audio.currentTime);
  if (!Number.isFinite(t) || t < 0) return 0;
  // un filo di margine per latenza handoff
  return Math.max(0, t);
}

function getRemotePlayPayload() {
  // brano da mandare a un altro device (con posizione per non ripartire da 0)
  const pos = getCurrentPlaybackPosition();
  const snap = playerSnapshot();
  const durLabel =
    (Number.isFinite(audio.duration) && audio.duration > 0
      ? fmtTime(audio.duration)
      : timeDur?.textContent) || "";
  if (nowPlaying.libraryId) {
    return {
      action: "play",
      library_id: nowPlaying.libraryId,
      title: nowPlaying.title || nowTitle?.textContent || "",
      artist: nowPlaying.artist || nowArtist?.textContent || "",
      duration: durLabel,
      duration_sec: snap.duration_sec || 0,
      cover_url: _lastCoverThumb || "",
      position_sec: pos,
    };
  }
  if (nowPlaying.token) {
    return {
      action: "play",
      stream_token: nowPlaying.token,
      title: nowPlaying.title || nowTitle?.textContent || "",
      artist: nowPlaying.artist || nowArtist?.textContent || "",
      duration: durLabel,
      duration_sec: snap.duration_sec || 0,
      cover_url: _lastCoverThumb || "",
      position_sec: pos,
    };
  }
  // né in libreria né dietro un media token (JARVIS, daily mix): l'unica
  // identità del brano è l'URL da cui sta suonando. Senza questo ramo
  // "Riproduci qui" si prendeva un 400 dal server e il brano non si poteva
  // passare a un altro device (Vitto, 2026-08-12).
  const streamPath = currentStreamPath();
  if (streamPath) {
    return {
      action: "play",
      stream_url: streamPath,
      title: nowPlaying.title || nowTitle?.textContent || "",
      artist: nowPlaying.artist || nowArtist?.textContent || "",
      duration: durLabel,
      duration_sec: snap.duration_sec || 0,
      cover_url: _lastCoverThumb || "",
      position_sec: pos,
    };
  }
  // coda corrente
  const q = queue.items[queue.index];
  if (q && q.source === "library" && q.id) {
    return {
      action: "play",
      library_id: q.id,
      title: q.title || "",
      artist: q.artist || "",
      duration: q.duration || durLabel,
      duration_sec: snap.duration_sec || parseDurationToSec(q.duration),
      cover_url: q.cover_url || "",
      position_sec: pos,
    };
  }
  return null;
}

/** Seek quando l'audio è pronto (handoff remote) */
function seekWhenReady(sec) {
  const target = Number(sec);
  if (!Number.isFinite(target) || target <= 0.25) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    let timer = null;
    const finish = () => {
      if (done) return;
      done = true;
      audio.removeEventListener("loadedmetadata", onReady);
      audio.removeEventListener("canplay", onReady);
      if (timer) clearTimeout(timer);
      resolve();
    };
    const onReady = () => {
      // Il guard va PRIMA di toccare currentTime, e il timer di fallback va
      // spento: senza queste due righe il seek veniva riapplicato quando
      // scattava il setTimeout qui sotto, cioè ~2,5s dopo che l'audio era
      // già partito → salto indietro al punto di partenza e quel pezzo si
      // risentiva. È il "mini loop" allo switch di device segnalato da Vitto
      // il 2026-08-12 (finish() rimuoveva i listener ma non il timeout, e
      // onReady scriveva currentTime prima di controllare `done`).
      if (done) return;
      try {
        const dur = Number(audio.duration);
        let t = target;
        if (Number.isFinite(dur) && dur > 0) {
          t = Math.min(t, Math.max(0, dur - 0.35));
        }
        audio.currentTime = t;
      } catch (_) {}
      finish();
    };
    if (audio.readyState >= 1) {
      onReady();
      return;
    }
    audio.addEventListener("loadedmetadata", onReady);
    audio.addEventListener("canplay", onReady);
    // fallback se eventi non arrivano
    timer = setTimeout(onReady, 2500);
  });
}

/** true se questo device è l'active player (o nessuno ha claim) */
let connectThisIsActive = true;

function setConnectIconState(isThisDevicePlaying) {
  connectThisIsActive = !!isThisDevicePlaying;
  document.querySelectorAll(".connect-btn, #npConnect").forEach((btn) => {
    if (!btn) return;
    btn.classList.toggle("active", connectThisIsActive && !audio.paused && !!audio.src);
    btn.classList.toggle("remote-active", !connectThisIsActive);
  });
}

async function refreshConnectPlayerState() {
  if (!authState.authenticated) {
    setConnectIconState(true);
    return;
  }
  try {
    const st = await apiJson("/api/me/player");
    setConnectIconState(st.is_this_device !== false || !st.active);
  } catch (_) {
    setConnectIconState(true);
  }
}

async function sendPlayToDevice(deviceId, deviceName) {
  const payload = getRemotePlayPayload();
  if (!payload) {
    toast("Avvia prima un brano qui, poi invialo all’altro device");
    return;
  }
  try {
    const res = await apiJson(`/api/me/devices/${deviceId}/command`, payload, "POST");
    // Se il device non era raggiungibile (su iOS: app sospesa in background,
    // il caso più comune proprio per il device a cui stai mandando la
    // musica) il comando è in attesa e partirà quando l'app si riapre. NON
    // fermiamo l'audio qui: prima ci si zittiva restando in mirror di un
    // device che non stava suonando niente — silenzio totale con scritto
    // "in riproduzione su…" (Vitto, 2026-08-11: "ho aspettato 40 sec e non
    // è successo nulla").
    if (res && res.delivered === false) {
      toast(
        "“" + (deviceName || "device") + "” non è raggiungibile ora — riparte appena riapri l’app lì",
        { duration: 4000 }
      );
      closeConnectSheet();
      return;
    }
    // hand-off: ferma qui e resta in mirror (mini bar sincronizzata)
    audio.pause();
    setConnectIconState(false);
    const snap = playerSnapshot();
    applyRemoteMirror({
      device_id: deviceId,
      title: snap.title || payload.title,
      artist: snap.artist || payload.artist,
      library_id: payload.library_id || snap.library_id,
      stream_token: payload.stream_token || snap.stream_token,
      cover_url: payload.cover_url || snap.cover_url,
      position_sec: payload.position_sec != null ? payload.position_sec : snap.position_sec,
      duration_sec: snap.duration_sec || parseDurationToSec(payload.duration),
      is_playing: true,
    });
    toast("In riproduzione su “" + (deviceName || "device") + "”");
    closeConnectSheet();
  } catch (e) {
    toast(e.message || "Invio fallito");
  }
}

function openConnectSheet() {
  if (!authState.authenticated) {
    openLoginModal();
    return;
  }
  const sheet = document.getElementById("connectSheet");
  if (!sheet) return;
  sheet.classList.add("open");
  sheet.setAttribute("aria-hidden", "false");
  renderConnectSheet();
}

function closeConnectSheet() {
  const sheet = document.getElementById("connectSheet");
  if (!sheet) return;
  sheet.classList.remove("open");
  sheet.setAttribute("aria-hidden", "true");
}

function buildConnectItem(d, { cur, activeId, canSend, trackLabel, artistLabel, playerSt }) {
  const isCur = !!(d.is_current || d.id === cur);
  const isActivePlayer = activeId ? d.id === activeId : isCur;
  const online = !!d.is_online || isCur;
  const platform = d.platform || "Device";
  const name = d.name || platform || "Device";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "connect-item" + (isActivePlayer ? " active" : "");
  if (!isCur && !online) btn.disabled = true;
  if (!isCur && online && !canSend) btn.disabled = true;

  const trackLine = isActivePlayer
    ? playerSt.active && (playerSt.active.title || playerSt.active.artist)
      ? [playerSt.active.title, playerSt.active.artist].filter(Boolean).join(" — ")
      : trackLabel + (artistLabel ? " — " + artistLabel : "")
    : online
      ? "Online"
      : "Offline";

  btn.innerHTML = `
    <div class="connect-item-ico" aria-hidden="true"></div>
    <div class="connect-item-body">
      <div class="connect-item-name"></div>
      <div class="connect-item-track"></div>
    </div>
    <div class="connect-item-check" aria-hidden="true">✓</div>
  `;
  btn.querySelector(".connect-item-ico").textContent = devicePlatformIcon(platform);
  const nameEl = btn.querySelector(".connect-item-name");
  nameEl.textContent = isCur ? "Questo dispositivo" : name;
  if (isCur) {
    const pill = document.createElement("span");
    pill.className = "pill";
    pill.textContent = platform;
    nameEl.appendChild(document.createTextNode(" "));
    nameEl.appendChild(pill);
  }
  btn.querySelector(".connect-item-track").textContent = trackLine;

  btn.addEventListener("click", async () => {
    if (isCur) {
      if (audio.src && !audio.paused) {
        await claimThisPlayer();
        setConnectIconState(true);
        toast("In ascolto su questo device");
        closeConnectSheet();
      } else if (canSend) {
        await claimThisPlayer();
        setConnectIconState(true);
        toast("Questo device è pronto");
        closeConnectSheet();
      } else {
        toast("Avvia un brano su questo device");
      }
      return;
    }
    if (!online) {
      toast("Dispositivo offline");
      return;
    }
    await sendPlayToDevice(d.id, name);
    renderConnectSheet();
  });
  return btn;
}

async function renderConnectSheet() {
  const list = document.getElementById("connectList");
  const sub = document.getElementById("connectSub");
  const hint = document.getElementById("connectHint");
  if (!list) return;
  list.innerHTML = '<div class="connect-loading">Carico dispositivi…</div>';
  const canSend = !!getRemotePlayPayload();
  const trackLabel =
    (nowPlaying.title || nowTitle?.textContent || "").trim() || "Nessun brano";
  const artistLabel =
    (nowPlaying.artist || nowArtist?.textContent || "").trim() || "";

  try {
    const [devData, playerSt] = await Promise.all([
      apiJson("/api/me/devices"),
      apiJson("/api/me/player").catch(() => ({})),
    ]);
    const devices = devData.devices || [];
    const cur = devData.current_device_id || authState.currentDeviceId;
    const activeId = playerSt.active && playerSt.active.device_id;
    const thisActive =
      !activeId || activeId === cur || playerSt.is_this_device === true;
    setConnectIconState(thisActive);

    if (sub) {
      sub.textContent = thisActive
        ? "In ascolto su questo dispositivo"
        : "In ascolto su un altro dispositivo";
    }
    if (hint) {
      hint.hidden = true; // UI più pulita; i device offline non si mostrano affatto
    }

    if (!devices.length) {
      list.innerHTML =
        '<div class="connect-empty">Nessun dispositivo. Accedi da un altro device con lo stesso account.</div>';
      return;
    }

    // solo device online (o quello corrente) — gli offline non si mostrano proprio
    const online = devices.filter(
      (d) => !!(d.is_current || d.id === cur) || d.is_online
    );
    online.sort((a, b) => {
      const ac = a.is_current || a.id === cur ? 0 : 1;
      const bc = b.is_current || b.id === cur ? 0 : 1;
      return ac - bc;
    });

    list.innerHTML = "";
    const ctx = {
      cur,
      activeId,
      canSend,
      trackLabel,
      artistLabel,
      playerSt,
    };

    if (!online.length) {
      list.innerHTML =
        '<div class="connect-empty">Nessun device online</div>';
    } else {
      online.forEach((d) => list.appendChild(buildConnectItem(d, ctx)));
    }
  } catch (e) {
    list.innerHTML =
      '<div class="connect-empty">' +
      (e.message || "Errore caricamento") +
      "</div>";
  }
}

async function handleRemoteCommands(commands) {
  if (!commands || !commands.length) return;
  for (const cmd of commands) {
    const action = cmd.action || "play";
    const p = cmd.payload || {};
    try {
      if (action === "play") {
        const pos = Number(p.position_sec) || 0;
        // Prima la coda che ci ha passato il device che stava suonando: i
        // rami qui sotto costruiscono una coda di UN SOLO brano, e a fine
        // canzone non c'era un successivo da suonare — la riproduzione si
        // fermava lì (Vitto, 2026-08-12: "non prosegue con quella dopo").
        // Se la coda condivisa contiene questo brano riprendiamo da lì, con
        // tutta la fila dietro, come fa già il take-over.
        const adopted = adoptSharedQueue({
          libraryId: p.library_id || "",
          token: p.stream_token || "",
          title: p.title || "",
        });
        if (adopted) {
          adopted.resumeAt = pos;
          remoteMirror = false;
          _lastMirrorPos = -1;
          _mirrorMetaKey = "";
          toast("▶ Remote: " + (adopted.title || "brano"));
          await playQueueItem(adopted);
          if (audio.paused && audio.src) {
            try {
              await audio.play();
            } catch (_) {
              toast("Tocca ▶ per continuare da dove eri");
            }
          }
          setConnectIconState(true);
          continue;
        }
        if (p.library_id) {
          const item = {
            source: "library",
            id: p.library_id,
            title: p.title || "track",
            artist: p.artist || "",
            duration: p.duration || "",
            cover_url: p.cover_url
              ? mediaAuthUrl(p.cover_url, { bust: false })
              : null,
            cover_hd_url: p.cover_hd_url
              ? mediaAuthUrl(p.cover_hd_url, { bust: false })
              : null,
            stream_url: mediaAuthUrl(
              p.stream_url || `/api/library/${p.library_id}/audio`,
              { bust: false }
            ),
            // handoff: riprendi da qui, non da 0
            resumeAt: pos,
          };
          queue.items = [item];
          queue.index = 0;
          shuffleOrder = [];
          updateQueueUi();
          remoteMirror = false;
          _lastMirrorPos = -1;
          _mirrorMetaKey = "";
          toast("▶ Remote: " + (item.title || "brano"));
          await playQueueItem(item); // resumeAt + autoplay
          // se iOS ha bloccato autoplay, riprova dopo seek
          if (audio.paused && audio.src) {
            try {
              await audio.play();
            } catch (_) {
              toast("Tocca ▶ per continuare da dove eri");
            }
          }
        } else if (p.stream_token || p.stream_url) {
          // l'URL arriva dal device che stava suonando, quindi col SUO token:
          // retokenUrl lo rifirma col nostro (per /api/library/... il token è
          // obbligatorio, altrimenti sarebbe un 401 e nessun audio)
          const streamUrl = p.stream_url
            ? retokenUrl(p.stream_url)
            : apiUrl(`/api/media/${p.stream_token}`);
          remoteMirror = false;
          _lastMirrorPos = -1;
          _mirrorMetaKey = "";
          nowPlaying = {
            token: p.stream_token || null,
            libraryId: null,
            title: p.title || "track",
            artist: p.artist || "",
            saved: false,
          };
          nowTitle.textContent = nowPlaying.title;
          nowArtist.textContent = nowPlaying.artist || "—";
          setCover(p.cover_url || null, p.cover_url || null);
          setLikeUi(false);
          syncNowPlayingSheetMeta();
          audio.src =
            streamUrl + (streamUrl.includes("?") ? "&" : "?") + "_=" + Date.now();
          setPlayerEnabled(true);
          resetTimeline(p.duration || "");
          // autoplay: play prima se possibile, poi seek (iOS-friendly)
          try {
            await audio.play();
          } catch (_) {}
          if (pos > 0.25) {
            await seekWhenReady(pos);
            try {
              await audio.play();
            } catch (_) {}
          }
          if (audio.paused) {
            toast("Tocca ▶ per continuare da dove eri");
          } else {
            toast("▶ Remote: " + nowPlaying.title);
          }
          setStatus("In riproduzione · remote");
          claimThisPlayer();
          setConnectIconState(true);
        }
      } else if (action === "pause") {
        audio.pause();
      } else if (action === "stop") {
        const wasPlaying = !audio.paused && !!audio.src;
        const alreadyMirror = remoteMirror;
        audio.pause();
        // non azzerare: restiamo in mirror sulla posizione del device attivo
        setConnectIconState(false);
        remoteMirror = true;
        // toast solo al passaggio locale→mirror (mai a ogni poll/stop ripetuto)
        if (!alreadyMirror && (wasPlaying || p.reason === "single_player")) {
          toastRemotePlayingOnce(p.title || "", p.artist || "");
          setStatus("Sync · altro dispositivo");
        }
        // rinfresca subito lo stato per la barra — col canale aperto arriva
        // da sé col broadcast, non serve andarlo a chiedere
        if (!syncIsOpen()) {
          try {
            const st = await apiJson("/api/me/player");
            if (st.active && !st.is_this_device) applyRemoteMirror(st.active);
          } catch (_) {}
        }
      } else if (action === "next") {
        playNext();
      } else if (action === "prev") {
        playPrev();
      }
    } catch (e) {
      console.warn("remote command failed", cmd, e);
      toast("Remote play fallito");
    }
  }
}

let _remotePollTimer = null;
let _remotePollTick = null;

function startRemoteCommandPoll() {
  const tick = async () => {
    if (!authState.authenticated || !getSessionToken()) return;
    try {
      const data = await apiJson("/api/me/commands");
      await handleRemoteCommands(data.commands || []);
    } catch (_) {
      /* silenzioso se offline */
    }
    // sync barra se un altro device sta playando
    try {
      const st = await apiJson("/api/me/player");
      if (st.active && st.is_this_device === false) {
        applyRemoteMirror(st.active);
      } else if (st.is_this_device) {
        if (remoteMirror) {
          // siamo di nuovo noi (claim da altrove rientrato) — esci mirror
          remoteMirror = false;
          _lastMirrorPos = -1;
          _mirrorMetaKey = "";
          stopMirrorTicker();
        }
        setConnectIconState(true);
        // heartbeat periodico già aggiorna lo stato — niente push extra qui
      } else if (!st.active && remoteMirror) {
        // nessuno in play: ferma ticker ma tieni ultima meta
        _mirrorPlaying = false;
        stopMirrorTicker();
        setPlayingUi(false);
      }
    } catch (_) {}
  };
  _remotePollTick = tick;
  if (_remotePollTimer) return;
  setTimeout(tick, 600);
  _remotePollTimer = setInterval(tick, 1000);
  startPlayerHeartbeat();
}

function stopRemoteCommandPoll() {
  if (_remotePollTimer) {
    clearInterval(_remotePollTimer);
    _remotePollTimer = null;
  }
}

/**
 * PWA su iOS: quando l'app va in background il timer di poll può restare
 * sospeso a lungo (anche minuti) anche a schermo tornato attivo — è la causa
 * più comune di "sync che non va tra due PWA". Al ritorno in foreground
 * forziamo subito un tick invece di aspettare che il setInterval si risvegli.
 */
function resumeRemotePollNow() {
  if (document.visibilityState && document.visibilityState !== "visible") return;
  if (!authState.authenticated) return;
  if (_remotePollTick) _remotePollTick();
  else startRemoteCommandPoll();
  if (_playerHbTick) _playerHbTick();
}

// ——————————————————————————————————————————————————————————————————————
// Canale di sync (WebSocket)
//
// Sostituisce il giro a poll qui sopra: lo stato di riproduzione arriva
// quando cambia invece di essere richiesto ogni secondo, e i comandi tra
// device vanno diretti al destinatario. Il poll resta come rete di
// sicurezza: se il socket non si apre (proxy strano, WebSocket assente)
// riparte da solo e l'app funziona come prima.
//
// Protocollo lato server: app/sync.py.
// (SYNC_HB_MS e lo stato _sync sono dichiarati vicino a `audio`, in cima al
// file — vedi il commento lì per il perché.)
// ——————————————————————————————————————————————————————————————————————

function syncSocketUrl() {
  const tok = authState.token || getSessionToken();
  if (!tok) return null;
  let base;
  try {
    base = new URL(API_BASE || location.origin, location.origin);
  } catch (_) {
    return null;
  }
  const proto = base.protocol === "https:" ? "wss:" : "ws:";
  // il token va in query: i gusci nativi girano cross-origin e il cookie
  // di sessione non parte (stesso motivo di mediaAuthUrl)
  return `${proto}//${base.host}/ws/sync?t=${encodeURIComponent(tok)}`;
}

function syncIsOpen() {
  return !!(_sync.ws && _sync.ws.readyState === 1);
}

function syncSend(msg) {
  if (!syncIsOpen()) return false;
  try {
    _sync.ws.send(JSON.stringify(msg));
    _sync.lastSentAt = Date.now();
    return true;
  } catch (_) {
    return false;
  }
}

/** Stato di riproduzione locale nel formato del canale. */
function syncPatch() {
  const s = playerSnapshot();
  return {
    track: {
      title: s.title,
      artist: s.artist,
      library_id: s.library_id,
      stream_token: s.stream_token,
      stream_url: s.stream_url,
      cover_url: s.cover_url,
      duration_sec: s.duration_sec,
    },
    position_sec: s.position_sec,
    is_playing: s.is_playing,
    is_jarvis: s.is_jarvis,
  };
}

/** Stato del canale → record che applyRemoteMirror già sa leggere. */
function syncStateToActive(state) {
  const tr = (state && state.track) || {};
  return {
    device_id: state.owner_device || "",
    title: tr.title || "",
    artist: tr.artist || "",
    library_id: tr.library_id || "",
    stream_token: tr.stream_token || "",
    stream_url: tr.stream_url || "",
    cover_url: tr.cover_url || "",
    position_sec: state.position_sec || 0,
    duration_sec: tr.duration_sec || 0,
    is_playing: !!state.is_playing,
    is_jarvis: !!state.is_jarvis,
  };
}

function syncMyDeviceId() {
  return _sync.deviceId || authState.currentDeviceId || getOrCreateDeviceId();
}

function applySyncState(state) {
  if (!state) return;
  _sync.seq = state.seq || 0;
  _sync.state = state; // ultimo stato noto: lo legge anche loadDevices
  rememberSharedQueue(state.queue);
  const owner = state.owner_device || "";
  const mine = syncMyDeviceId();

  if (!owner) {
    // nessuno sta suonando: esci dal mirror ma tieni l'ultima meta a video
    if (remoteMirror) {
      remoteMirror = false;
      _mirrorMetaKey = "";
      _mirrorPlaying = false;
      stopMirrorTicker();
      setPlayingUi(false);
    }
    _sync.wasMirror = false;
    return;
  }

  if (owner === mine) {
    if (remoteMirror) {
      remoteMirror = false;
      _lastMirrorPos = -1;
      _mirrorMetaKey = "";
      stopMirrorTicker();
    }
    _sync.wasMirror = false;
    setConnectIconState(true);
    return;
  }

  // sta suonando un altro device
  const entering = !_sync.wasMirror;
  _sync.wasMirror = true;
  applyRemoteMirror(syncStateToActive(state));
  if (entering) {
    // stesso avviso del vecchio comando "stop", ma senza doverlo accodare
    toastRemotePlayingOnce(
      (state.track && state.track.title) || "",
      (state.track && state.track.artist) || ""
    );
    setStatus("Sync · altro dispositivo");
  }
}

function handleSyncMessage(msg) {
  if (!msg || typeof msg !== "object") return;
  switch (msg.t) {
    case "snapshot":
      if (msg.device_id) _sync.deviceId = msg.device_id;
      _sync.sawSnapshotSince = true; // prova di vita per il watchdog di resumeSyncNow
      applySyncState(msg.state);
      // (ri)collegati: avvio, ritorno in primo piano, rete tornata — i pin
      // cambiati altrove nel frattempo si recuperano qui
      sincronizzaPin();
      break;
    case "pin":
      // pin cambiati da un altro device dell'account (vedi app/pins.py)
      applicaPinDalServer(msg.items);
      break;
    case "copertina":
      // copertina scelta col selettore su un altro device dell'account
      applyNewTrackCover(msg.id, msg.cover_url, msg.cover_hd_url);
      break;
    case "state":
      applySyncState(msg.state);
      break;
    case "cmd":
      handleRemoteCommands([
        {
          action: msg.action,
          payload: msg.payload || {},
          from_device_id: msg.from_device_id || "",
        },
      ]);
      break;
    case "avviso":
      // il server avvisa SOLO questo device mentre aspetta una sua richiesta,
      // es. «Il primo bot non l'ha trovato · cerco col secondo…» (Vitto 03/10,
      // vedi bridge.avvisa_utente)
      // 4s e non 1,8 di default: deve restare a schermo mentre il bot dopo
      // cerca (2-3s), non sparire prima che succeda qualcosa
      if (msg.testo) toast(String(msg.testo), { duration: 4000 });
      break;
    default:
      break;
  }
}

function startSyncHeartbeat() {
  if (_sync.hbTimer) return;
  _sync.hbTimer = setInterval(() => {
    if (!syncIsOpen()) return;
    // Keepalive. Il battito qui sotto parte solo se stiamo suonando noi: un
    // device aperto e fermo non mandava NIENTE sul socket, e uvicorn chiude
    // la connessione quando il suo ping resta senza risposta (la pagina in
    // background non risponde). Nei log del Mac mini si vedeva proprio
    // questo: connect/disconnect ogni 6-18 minuti sullo stesso device, e nel
    // frattempo i comandi "riproduci qui" finivano in coda invece di partire.
    if (Date.now() - (_sync.lastSentAt || 0) > 25000) syncSend({ t: "ping" });
    if (remoteMirror) return;
    if (!connectThisIsActive) return;
    if (!audio.src && !nowPlaying.libraryId && !nowPlaying.token) return;
    // in pausa il battito serve solo se è cambiato qualcosa: la posizione
    // non si muove, il server ha già lo stato giusto e gli altri device
    // non hanno niente da ricalcolare
    if (audio.paused) {
      const sig = `${nowPlaying.title}|${nowPlaying.artist}|paused`;
      if (sig === _sync.lastIdleSig) return;
      _sync.lastIdleSig = sig;
    } else {
      _sync.lastIdleSig = "";
    }
    syncSend({ t: "state", state: syncPatch() });
  }, SYNC_HB_MS);
}

function stopSyncHeartbeat() {
  if (_sync.hbTimer) {
    clearInterval(_sync.hbTimer);
    _sync.hbTimer = null;
  }
}

/** Push immediato (cambio brano, play/pause, seek): non aspettare il battito. */
function syncPushNow() {
  if (remoteMirror || !connectThisIsActive) return false;
  if (!audio.src && !nowPlaying.libraryId && !nowPlaying.token) return false;
  return syncSend({ t: "state", state: syncPatch() });
}

function scheduleSyncReconnect() {
  if (_sync.retryTimer) return;
  if (!authState.authenticated || !getSessionToken()) return;
  // backoff 1s → 15s; dal terzo tentativo a vuoto rientra il poll, così
  // l'app resta sincronizzata anche dove il WebSocket non passa
  const wait = Math.min(15000, 1000 * Math.pow(2, Math.max(0, _sync.tries - 1)));
  if (_sync.tries >= 3) startRemoteCommandPoll();
  _sync.retryTimer = setTimeout(() => {
    _sync.retryTimer = null;
    connectSync();
  }, wait);
}

function connectSync() {
  if (!authState.authenticated || !getSessionToken()) return;
  if (_sync.ws && (_sync.ws.readyState === 0 || _sync.ws.readyState === 1)) return;
  if (typeof WebSocket === "undefined") {
    startRemoteCommandPoll();
    return;
  }
  const url = syncSocketUrl();
  if (!url) {
    startRemoteCommandPoll();
    return;
  }
  let ws;
  try {
    ws = new WebSocket(url);
  } catch (_) {
    _sync.tries++;
    scheduleSyncReconnect();
    return;
  }
  _sync.ws = ws;
  _sync.tries++;
  ws.onopen = () => {
    _sync.tries = 0;
    stopRemoteCommandPoll(); // il socket basta: niente doppio canale
    startSyncHeartbeat();
    // se stiamo suonando noi, riprendiamoci il posto subito (es. rientro
    // da background con l'audio mai fermato)
    if (!remoteMirror && audio.src && !audio.paused) {
      syncSend({ t: "claim", state: syncPatch() });
    }
    publishSharedQueue(true);
  };
  ws.onmessage = (ev) => {
    let msg = null;
    try {
      msg = JSON.parse(ev.data);
    } catch (_) {
      return;
    }
    handleSyncMessage(msg);
  };
  ws.onclose = (ev) => {
    if (_sync.ws === ws) _sync.ws = null;
    stopSyncHeartbeat();
    // 4401 = sessione non valida, 4400 = sessione senza device, 4403 = device
    // non più in lista (revocato). Riprovare è inutile — il server risponderà
    // sempre lo stesso: passiamo al poll, che almeno riceve il 401 e fa
    // scattare il riaggancio del login. (Il socket verrà ritentato al prossimo
    // ritorno in foreground, via resumeSyncNow.)
    const code = (ev && ev.code) || 0;
    if (code === 4401 || code === 4400 || code === 4403) {
      startRemoteCommandPoll();
      return;
    }
    scheduleSyncReconnect();
  };
  ws.onerror = () => {
    try {
      ws.close();
    } catch (_) {}
  };
}

function stopSync() {
  stopSyncHeartbeat();
  if (_sync.retryTimer) {
    clearTimeout(_sync.retryTimer);
    _sync.retryTimer = null;
  }
  if (_sync.ws) {
    try {
      _sync.ws.close();
    } catch (_) {}
    _sync.ws = null;
  }
}

/** Entry point unico: socket se possibile, poll come riserva. */
function startSync() {
  connectSync();
}

// ————————————————————————— coda condivisa —————————————————————————
// Il device che suona pubblica la sua coda; gli altri la tengono da parte e
// la adottano quando prendono il controllo. Prima il take-over ripartiva con
// una coda di UN brano (quello corrente) e tutto il resto spariva: passando
// dal Mac all'iPhone perdevi la fila.
// (_sharedQueue/_sharedQueueSig/_publishQueueTimer dichiarate vicino a
// `audio`, in cima al file: updateQueueUi() e takeOverFromMirror() — molto
// più in alto — le leggono via publishSharedQueue()/adoptSharedQueue(), che
// come funzioni sono già "hoisted" e chiamabili da lì. Se le loro variabili
// restassero quaggiù, la stessa temporal-dead-zone del bug di _sync le
// avrebbe colpite appena una di quelle due funzioni fosse scattata prima
// che lo script arrivasse a questa riga.)

function _hashStr(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return String(h);
}

function _queueSig(items, index) {
  return _hashStr(
    items.length +
      "|" +
      index +
      "|" +
      items.map((i) => (i && (i.qid || i.id || i.title)) || "").join("")
  );
}

function rememberSharedQueue(q) {
  if (!q || !Array.isArray(q.items)) return;
  _sharedQueue = {
    items: q.items,
    index: typeof q.index === "number" ? q.index : -1,
    shuffle: !!q.shuffle,
  };
}

function publishSharedQueue(immediate = false) {
  if (!syncIsOpen() || remoteMirror || !connectThisIsActive) return;
  const send = () => {
    _publishQueueTimer = null;
    if (!syncIsOpen() || remoteMirror || !connectThisIsActive) return;
    const items = queue.items || [];
    const sig = _queueSig(items, queue.index);
    if (sig === _sharedQueueSig) return; // nulla di nuovo da dire
    _sharedQueueSig = sig;
    syncSend({
      t: "queue",
      queue: { items, index: queue.index, shuffle: shuffleOrder.length > 0 },
    });
  };
  if (immediate) {
    send();
    return;
  }
  // la coda cambia a raffica (append, riordino, skip): un colpo solo dopo
  clearTimeout(_publishQueueTimer);
  _publishQueueTimer = setTimeout(send, 1200);
}

/** Gli URL protetti arrivano col token dell'ALTRO device: rigeneriamoli con
 * il nostro, altrimenti smettono di funzionare appena quella sessione cade. */
function retokenUrl(u) {
  if (!u || typeof u !== "string" || u.startsWith("data:")) return u;
  try {
    const url = new URL(u, location.origin);
    let apiOrigin = null;
    if (API_BASE) {
      try {
        apiOrigin = new URL(API_BASE, location.origin).origin;
      } catch (_) {}
    }
    if (url.origin !== location.origin && url.origin !== apiOrigin) return u;
    url.searchParams.delete("t");
    url.searchParams.delete("_");
    return mediaAuthUrl(url.pathname + (url.search || ""), { bust: false });
  } catch (_) {
    return u;
  }
}

function _adoptedItem(it) {
  const out = { ...it };
  for (const k of ["stream_url", "cover_url", "cover_hd_url", "previewUrl"]) {
    if (out[k]) out[k] = retokenUrl(out[k]);
  }
  return out;
}

/**
 * Ricostruisce la coda del device che stava suonando, se quella che ci ha
 * mandato è ancora quella giusta (il brano corrente deve combaciare con
 * quello che stiamo specchiando). Ritorna l'item corrente, o null.
 */
function adoptSharedQueue({ libraryId, token, title }) {
  const sq = _sharedQueue;
  if (!sq || !Array.isArray(sq.items) || !sq.items.length) return null;
  const matches = (it) =>
    !!it &&
    ((libraryId && String(it.id || "") === String(libraryId)) ||
      (token && String(it.stream_token || "") === String(token)) ||
      (!!title && (it.title || "") === title));
  // L'indice della coda condivisa non è affidabile: nello stato salvato dal
  // server si è visto index=1 ("Scotty Doesn't Know") mentre suonava
  // items[0]. Cerchiamo quindi il brano nella coda; l'indice è solo il primo
  // posto dove guardare, non la verità (Vitto, 2026-08-12).
  let idx = sq.index;
  if (!(idx >= 0 && idx < sq.items.length && matches(sq.items[idx]))) {
    idx = sq.items.findIndex(matches);
  }
  if (idx < 0) return null; // coda di un altro brano: meglio il singolo
  queue.items = sq.items.map(_adoptedItem);
  queue.index = idx;
  shuffleOrder = [];
  updateQueueUi();
  return queue.items[idx];
}

/**
 * Rientro in foreground. Su iOS il socket viene chiuso quando l'app viene
 * sospesa e il close event può arrivare in ritardo: riconnettiamo subito
 * invece di aspettare il backoff, e chiediamo uno snapshot se era rimasto
 * aperto (potremmo aver perso dei broadcast mentre eravamo fermi).
 */
function resumeSyncNow() {
  if (document.visibilityState && document.visibilityState !== "visible") return;
  if (!authState.authenticated) return;
  if (syncIsOpen()) {
    // readyState dice "aperto" anche quando il socket è morto mentre l'app
    // era sospesa: iOS congela la WebView, il server non riceve più risposta
    // ai suoi ping e chiude, ma qui il close event può non essere ancora
    // arrivato. Quindi non ci fidiamo: mandiamo hello e pretendiamo lo
    // snapshot di risposta entro il timeout, altrimenti buttiamo giù noi la
    // connessione e ne apriamo una nuova. Senza questo si restava agganciati
    // a un socket fantasma, senza ricevere più né stato né comandi.
    syncSend({ t: "hello" });
    syncPushNow();
    clearTimeout(_sync.helloWatchdog);
    _sync.helloWatchdog = setTimeout(() => {
      _sync.helloWatchdog = null;
      if (!_sync.sawSnapshotSince) {
        try {
          if (_sync.ws) _sync.ws.close();
        } catch (_) {}
        _sync.ws = null;
        _sync.tries = 0;
        connectSync();
      }
    }, 3000);
    _sync.sawSnapshotSince = false;
  } else {
    _sync.tries = 0;
    connectSync();
  }
  if (_remotePollTimer) resumeRemotePollNow();
}
document.addEventListener("visibilitychange", resumeSyncNow);
window.addEventListener("pageshow", resumeSyncNow);
window.addEventListener("focus", resumeSyncNow);

async function loadDevices() {
  const list = document.getElementById("devicesList");
  const summary = document.getElementById("devicesSummary");
  const btnOthers = document.getElementById("btnRevokeOthers");
  if (!list) return;
  list.innerHTML = '<li class="dev-loading">Carico dispositivi…</li>';
  if (btnOthers) btnOthers.classList.add("hidden");
  try {
    const data = await apiJson("/api/me/devices");
    const devices = data.devices || [];
    const cur = data.current_device_id || authState.currentDeviceId;
    if (summary) {
      const n = devices.length;
      const onlineN = devices.filter((d) => d.is_online).length;
      summary.textContent =
        n === 0
          ? "Nessun dispositivo collegato"
          : n +
            (n === 1 ? " dispositivo" : " dispositivi") +
            (onlineN ? " · " + onlineN + " online" : "") +
            " · invia un brano con “Riproduci qui”";
    }
    if (!devices.length) {
      list.innerHTML =
        '<li class="dev-empty">Nessun dispositivo — accedi da un altro device per vederlo qui</li>';
      return;
    }
    list.innerHTML = "";
    let others = 0;
    const canRemote = !!getRemotePlayPayload();
    // chi sta suonando adesso: dal canale se è aperto, altrimenti chiediamolo
    let activeDeviceId = (_sync.state && _sync.state.owner_device) || "";
    if (!activeDeviceId) {
      try {
        const st = await apiJson("/api/me/player");
        activeDeviceId = (st.active && st.active.device_id) || "";
      } catch (_) {}
    }
    devices.forEach((d) => {
      const isCur = !!(d.is_current || d.id === cur);
      if (!isCur) others++;
      const li = document.createElement("li");
      li.className = "device-item" + (isCur ? " current" : "");
      const online = !!d.is_online;
      const ago =
        d.last_seen_ago_sec != null
          ? formatRelativeTime(d.last_seen_ago_sec)
          : d.last_seen
            ? formatRelativeTime(Date.now() / 1000 - d.last_seen)
            : "—";
      const platform = d.platform || "Device";
      const sessions = d.session_count || 0;
      li.innerHTML = `
        <div class="device-ico" aria-hidden="true"></div>
        <div class="device-body">
          <div class="device-title-row">
            <strong></strong>
            <span class="device-badge this" hidden>Questo</span>
            <span class="device-badge online" hidden>Online</span>
            <span class="device-badge offline" hidden>Offline</span>
          </div>
          <div class="device-meta"></div>
          <div class="device-actions"></div>
        </div>
      `;
      li.querySelector(".device-ico").textContent = devicePlatformIcon(platform);
      li.querySelector("strong").textContent = d.name || platform || "Device";
      const badgeThis = li.querySelector(".device-badge.this");
      const badgeOn = li.querySelector(".device-badge.online");
      const badgeOff = li.querySelector(".device-badge.offline");
      if (isCur) badgeThis.hidden = false;
      else if (online) badgeOn.hidden = false;
      else badgeOff.hidden = false;
      li.querySelector(".device-meta").textContent =
        platform +
        // "visto" = ultima richiesta HTTP: per un device appeso al canale può
        // essere di ore fa pur essendo collegato in questo momento
        (d.is_connected ? " · collegato adesso" : " · visto " + ago) +
        (sessions
          ? " · " + sessions + (sessions === 1 ? " sessione" : " sessioni")
          : d.is_expired
            ? " · accesso scaduto"
            : "");
      const actions = li.querySelector(".device-actions");
      if (!isCur) {
        // Se è LUI a suonare, la cosa che serve è il contrario di "manda":
        // prenditi tu la riproduzione. Prima da un device fermo si vedeva
        // solo un "▶ Riproduci qui" grigio, col motivo scritto in un title
        // che su touch non si legge — segnalato da Vitto (2026-08-11:
        // "da iOS dava macbook online ma non potevo cliccarlo").
        if (d.id === activeDeviceId) {
          const btnTake = document.createElement("button");
          btnTake.type = "button";
          btnTake.textContent = "⤓ Ascolta qui";
          btnTake.title = "Sposta su questo device quello che sta suonando";
          btnTake.addEventListener("click", async () => {
            btnTake.disabled = true;
            const moved = await takeOverFromMirror();
            if (!moved) toast("Non riesco a spostare la riproduzione");
            else toast("Riproduzione spostata qui");
            await loadDevices();
          });
          actions.appendChild(btnTake);
        }
        const btnPlay = document.createElement("button");
        btnPlay.type = "button";
        btnPlay.textContent = "▶ Riproduci qui";
        btnPlay.title = canRemote
          ? "Avvia su questo dispositivo il brano in riproduzione"
          : "Prima avvia un brano su questo device, poi invialo";
        btnPlay.disabled = !canRemote;
        btnPlay.addEventListener("click", () =>
          sendPlayToDevice(d.id, d.name || platform)
        );
        actions.appendChild(btnPlay);
        if (!canRemote) {
          const why = document.createElement("small");
          why.className = "device-hint";
          why.textContent = "Avvia un brano qui per poterlo mandare";
          actions.appendChild(why);
        }
      }
      const btnRename = document.createElement("button");
      btnRename.type = "button";
      btnRename.textContent = "Rinomina";
      btnRename.addEventListener("click", async () => {
        const next = prompt("Nome dispositivo", d.name || platform || "Device");
        if (next == null) return;
        const name = next.trim();
        if (!name) return;
        try {
          await apiJson(`/api/me/devices/${d.id}`, { name }, "PATCH");
          toast("Dispositivo rinominato");
          await loadDevices();
        } catch (e) {
          toast(e.message || "Errore");
        }
      });
      actions.appendChild(btnRename);
      if (!isCur) {
        const btnRev = document.createElement("button");
        btnRev.type = "button";
        btnRev.className = "danger";
        btnRev.textContent = "Revoca";
        btnRev.addEventListener("click", async () => {
          if (
            !confirm(
              "Revocare “" +
                (d.name || platform) +
                "”? Dovrà rifare il login."
            )
          )
            return;
          try {
            await apiJson(`/api/me/devices/${d.id}`, null, "DELETE");
            toast("Dispositivo revocato");
            await loadDevices();
          } catch (e) {
            toast(e.message || "Errore");
          }
        });
        actions.appendChild(btnRev);
      }
      list.appendChild(li);
    });
    if (btnOthers) {
      btnOthers.classList.toggle("hidden", others < 1);
      const sub = btnOthers.querySelector(".settings-row-text span");
      if (sub) {
        sub.textContent =
          others === 1
            ? "Revoca 1 altro dispositivo"
            : "Revoca " + others + " altri dispositivi";
      }
    }
  } catch (e) {
    list.innerHTML = `<li class="dev-empty">${e.message || "Errore"}</li>`;
  }
}

(function wireAuthUI() {
  const loginSubmit = document.getElementById("loginSubmit");
  const loginClose = document.getElementById("loginClose");
  const loginPass = document.getElementById("loginPass");
  const accountChip = document.getElementById("accountChip");
  const accountClose = document.getElementById("accountClose");
  const btnLogout = document.getElementById("btnLogout");
  const btnDevices = document.getElementById("btnDevices");
  const accountModal = document.getElementById("accountModal");

  if (loginSubmit) loginSubmit.addEventListener("click", () => doLogin());
  if (loginClose) {
    loginClose.addEventListener("click", () => {
      if (authState.authRequired && !authState.authenticated) return;
      closeLoginModal();
    });
  }
  if (loginPass) {
    loginPass.addEventListener("keydown", (e) => {
      if (e.key === "Enter") doLogin();
    });
  }

  // "Cambia indirizzo server" — solo dentro l'app nativa (Capacitor)
  const loginChangeServer = document.getElementById("loginChangeServer");
  if (loginChangeServer) {
    loginChangeServer.classList.toggle("hidden", !isNativeShell());
    loginChangeServer.addEventListener("click", () => openServerBindModal({ cancelable: true }));
  }
  const serverBindSave = document.getElementById("serverBindSave");
  const serverBindCancel = document.getElementById("serverBindCancel");
  const serverBindInput = document.getElementById("serverBindInput");
  if (serverBindSave) serverBindSave.addEventListener("click", () => confirmServerBind());
  if (serverBindCancel) serverBindCancel.addEventListener("click", () => closeServerBindModal());
  if (serverBindInput) {
    serverBindInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") confirmServerBind();
    });
  }
  const openSettingsOrLogin = () => {
    if (authState.authenticated || appOfflineMode) openAccountModal();
    else openLoginModal();
  };
  const btnAccountMobile = document.getElementById("btnAccountMobile");
  if (btnAccountMobile) {
    btnAccountMobile.addEventListener("click", openSettingsOrLogin);
  }
  initOnlineUsersWidget();
  if (accountChip) {
    accountChip.title = "Impostazioni e account";
    accountChip.addEventListener("click", openSettingsOrLogin);
  }
  if (accountClose) accountClose.addEventListener("click", closeAccountModal);
  if (accountModal) {
    accountModal.addEventListener("click", (e) => {
      if (e.target === accountModal) closeAccountModal();
    });
  }
  if (btnLogout) btnLogout.addEventListener("click", () => doLogout());
  const btnForceUpdate = document.getElementById("btnForceUpdate");
  if (btnForceUpdate) {
    btnForceUpdate.addEventListener("click", () => forceAppUpdate());
  }
  if (btnDevices) {
    btnDevices.addEventListener("click", () => loadDevices());
  }
  const profileNicknameSave = document.getElementById("profileNicknameSave");
  if (profileNicknameSave) {
    profileNicknameSave.addEventListener("click", () => saveProfileNickname());
  }
  const profileAvatarInput = document.getElementById("profileAvatarInput");
  const profileAvatarBtn = document.getElementById("profileAvatarBtn");
  if (profileAvatarBtn && profileAvatarInput) {
    profileAvatarBtn.addEventListener("click", () => profileAvatarInput.click());
  }
  if (profileAvatarInput) {
    profileAvatarInput.addEventListener("change", () => {
      const file = profileAvatarInput.files && profileAvatarInput.files[0];
      if (file) openAvatarCropModal(file);
      profileAvatarInput.value = "";
    });
  }
  const profileAvatarRemove = document.getElementById("profileAvatarRemove");
  if (profileAvatarRemove) {
    profileAvatarRemove.addEventListener("click", () => removeProfileAvatar());
  }
  wireAvatarCropUI();
  const btnRevokeOthers = document.getElementById("btnRevokeOthers");
  if (btnRevokeOthers) {
    btnRevokeOthers.addEventListener("click", async () => {
      if (
        !confirm(
          "Uscire da tutti gli altri dispositivi? Dovranno rifare il login."
        )
      )
        return;
      try {
        const r = await apiJson(
          "/api/me/devices/revoke-others",
          {},
          "POST"
        );
        toast(
          r.revoked
            ? "Revocati " + r.revoked + " dispositivi"
            : "Nessun altro dispositivo"
        );
        await loadDevices();
      } catch (e) {
        toast(e.message || "Errore");
      }
    });
  }

  // navigazione pannelli impostazioni
  document.querySelectorAll("[data-settings-go]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const go = btn.getAttribute("data-settings-go");
      if (go === "account") showSettingsPanel("settingsAccount");
      else if (go === "devices") showSettingsPanel("settingsDevices");
      else if (go === "appearance") showSettingsPanel("settingsAppearance");
      else if (go === "sleeptimer") showSettingsPanel("settingsSleepTimer");
      else if (go === "offline") showSettingsPanel("settingsOffline");
      else if (go === "travel") showSettingsPanel("settingsTravel");
    });
  });
  document.getElementById("offlineResta")?.addEventListener("change", (e) => {
    cambiaRestaOffline(e.target.checked);
  });
  if (offlineFs()) {
    caricaCodaDownload();
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        if (_lavoroInCorso) _lavoroInCorso.vistoNascosto = true;
        return;
      }
      downloadLavori.forEach((l) => {
        if (l.stato === "errore" && l.riprovaAlRitorno) {
          l.riprovaAlRitorno = false;
          l.vistoNascosto = false;
          l.autoRiprese = (l.autoRiprese || 0) + 1;
          riprendiLavoro(l.pid);
        }
      });
    });
  }
  document.getElementById("viaggioEsci")?.addEventListener("click", () =>
    showSettingsPanel("settingsOffline")
  );
  document.getElementById("viaggioAvanti")?.addEventListener("click", () => {
    if (viaggio.minuti > 0) showSettingsPanel("settingsTravelPick");
  });
  document.getElementById("viaggioLista")?.addEventListener("click", (e) => {
    const riga = e.target.closest(".viaggio-riga");
    if (riga && riga.classList.contains("viaggio-cerca")) {
      // tutta la riga finta apre la ricerca, non solo il campo
      if (!e.target.closest("button")) document.getElementById("viaggioCerca")?.focus();
      return;
    }
    if (!riga || viaggioLavoro()) return;
    const id = riga.dataset.id;
    if (viaggio.scelti.has(id)) viaggio.scelti.delete(id);
    else viaggio.scelti.add(id);
    const scelto = viaggio.scelti.has(id);
    riga.classList.toggle("scelto", scelto);
    riga.setAttribute("aria-checked", String(scelto));
    haptic(8);
    viaggioAggiornaIndicatore();
  });
  document.getElementById("viaggioScarica")?.addEventListener("click", () => viaggioScarica());
  document.getElementById("offlineVeloce")?.addEventListener("change", (e) => {
    try {
      if (e.target.checked) localStorage.setItem(OFFLINE_VELOCE_KEY, "1");
      else localStorage.removeItem(OFFLINE_VELOCE_KEY);
    } catch (_) {}
    toast(
      e.target.checked
        ? "Fast download attivo: i prossimi brani arrivano a 160 kbps"
        : "Fast download spento: qualità piena"
    );
  });
  document.getElementById("offlineEliminaTutto")?.addEventListener("click", async () => {
    const btn = document.getElementById("offlineEliminaTutto");
    if (!btn.classList.contains("conferma")) {
      btn.classList.add("conferma");
      document.getElementById("offlineEliminaTitolo").textContent = "Tocca di nuovo per eliminare";
      document.getElementById("offlineEliminaSub").textContent = "Tutti i brani scaricati spariscono dal telefono";
      _offlineEliminaTimer = setTimeout(azzeraConfermaEliminaTutto, 4000);
      return;
    }
    azzeraConfermaEliminaTutto();
    btn.disabled = true;
    try {
      await eliminaTuttiOffline();
    } finally {
      btn.disabled = false;
    }
    aggiornaPannelloOffline();
  });
  wireSleepTimerUI();
  document.querySelectorAll("[data-settings-back]").forEach((btn) => {
    btn.addEventListener("click", () => showSettingsPanel("settingsHome"));
  });

  // theme picker
  document.querySelectorAll(".theme-option").forEach((btn) => {
    btn.addEventListener("click", () => {
      const t = btn.dataset.theme;
      if (!t) return;
      setUiTheme(t);
      syncThemePicker();
      toast(t === "classic" ? "Tema Classic" : "Tema Liquid Glass");
    });
  });

  // Connect sheet (stile Spotify)
  const openConnect = () => openConnectSheet();
  document.getElementById("btnConnect")?.addEventListener("click", (e) => {
    e.stopPropagation();
    openConnect();
  });
  document.getElementById("btnConnectMobile")?.addEventListener("click", (e) => {
    e.stopPropagation();
    openConnect();
  });
  document.getElementById("npConnect")?.addEventListener("click", (e) => {
    e.stopPropagation();
    openConnect();
  });
  document.getElementById("connectClose")?.addEventListener("click", closeConnectSheet);
  document.getElementById("connectBackdrop")?.addEventListener("click", closeConnectSheet);

  setupEdgeSwipeBack();

  // App nativa (Capacitor): al primo avvio chiedi l'indirizzo del Mac,
  // altrimenti le fetch relative punterebbero al WebView stesso invece
  // che al server — non c'è modo di indovinarlo (dipende dalla rete/
  // Tailscale dell'utente). Finché non è impostato, NON aprire anche il
  // login sopra (altrimenti si sovrappongono ed è invisibile quello giusto).
  const needsServerBind = isNativeShell() && !API_BASE;
  ensureApiBaseConfigured();

  async function bootOnline() {
    // già configurato (non primo avvio) + almeno una playlist scaricata:
    // controlla che il Mac risponda PRIMA di lanciarsi nel flusso online,
    // altrimenti login/refreshMe restano appesi ad aspettare una rete che
    // non c'è invece di offrire subito le playlist offline disponibili
    if (
      isNativeShell() &&
      API_BASE &&
      Object.keys(getOfflinePlaylists()).length
    ) {
      if (offlineForzato()) {
        enterOfflineMode("scelta");
        return;
      }
      // un solo tentativo era troppo fragile: al cold boot dell'app, la
      // extension di rete di Tailscale può metterci un paio di secondi a
      // "risvegliarsi" (iOS la sospende in background) — un primo fallimento
      // qui non è ancora "offline", riprova una volta prima di arrendersi
      // (Vitto: entrava in modalità offline al boot pur avendo la rete a posto,
      // confermato che da Safari/manualmente il server rispondeva sempre)
      let reachable = await checkServerReachable(3500);
      if (!reachable) {
        await new Promise((r) => setTimeout(r, 1800));
        reachable = await checkServerReachable(4500);
      }
      if (!reachable) {
        enterOfflineMode();
        return;
      }
      // server raggiungibile: ripara in background le copertine mancanti di
      // TUTTE le playlist scaricate, non solo quella eventualmente aperta —
      // altrimenti chi resta sempre offline (rete del server irraggiungibile
      // da fuori casa) non ha mai occasione di farle recuperare.
      // Piccolo delay (non blocca il resto del boot, vedi niente await qui):
      // appena riconnesso Tailscale/WiFi può essere ancora instabile per un
      // istante, meglio non sparare subito una raffica di fetch.
      setTimeout(() => {
        const offlinePls = getOfflinePlaylists();
        for (const [pid, entry] of Object.entries(offlinePls)) {
          backfillOfflineCovers(pid, (entry.pl && entry.pl.tracks) || []);
        }
      }, 1500);
    }
    // da qui in poi siamo online: sorveglia la connessione e passa da solo
    // in modalità offline se il Mac sparisce (vedi startOnlineDropWatch)
    startOnlineDropWatch();
    // Gate immediato: senza token → login prima di tutto (anche prima di /api/me)
    if (!getSessionToken()) {
      authState.authRequired = true;
      openLoginModal();
    }
    refreshMe()
      .then(() => {
        if (authState.authenticated) refreshConnectPlayerState();
      })
      .catch(() => {
        if (!authState.authenticated) openLoginModal();
      });
  }

  restoreLastTrackDisplay();
  if (!needsServerBind) bootOnline();
})();
