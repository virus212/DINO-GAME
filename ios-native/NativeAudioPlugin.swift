import Foundation
import AVFoundation
import MediaPlayer
import Capacitor

// Player musicale nativo (AVPlayer) al posto dell'<audio> di WKWebView.
//
// Perché: iOS assegna il controller musicale (lock screen, Centro di
// Controllo) all'app che produce DAVVERO l'audio. Con l'<audio> lo produce
// il processo GPU di WebKit, che ritira il Now Playing alla prima
// interruzione (Instagram, vocali…): iOS ripiegava sull'ultima app candidata
// (SoundCloud) e Crackify spariva. Pubblicare il Now Playing dall'app non
// bastava, perché l'app non suonava niente in prima persona. Con AVPlayer qui
// dentro l'app si comporta come Spotify.
//
// Lato JS c'è uno shim (NativeAudioElement in app.js) che imita
// l'HTMLAudioElement — src, play(), pause(), currentTime, eventi — così il
// resto di app.js non sa di parlare con un player nativo.
@objc(NativeAudioPlugin)
public class NativeAudioPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NativeAudioPlugin"
    public let jsName = "NativeAudio"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "load", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "play", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pause", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "seek", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setVolume", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setNowPlaying", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "suonoGioco", returnType: CAPPluginReturnPromise),
    ]

    private let player = AVPlayer()
    private var timeObserver: Any?
    private var itemObservers: [NSKeyValueObservation] = []
    private var rateObserver: NSKeyValueObservation?
    // stato reale del suono: con automaticallyWaitsToMinimizeStalling il
    // rate va a 1 subito, ma in streaming AVPlayer resta "in attesa" finché
    // non ha abbastanza buffer — solo .playing vuol dire che si sente
    private var controlObserver: NSKeyValueObservation?
    private var endObserver: NSObjectProtocol?
    private var pendingSeek: Double?
    // generazione del brano (la decide JS a ogni cambio di src): gli eventi
    // del brano precedente ancora in viaggio vengono scartati lato JS
    private var gen = 0
    private var volume: Float = 1
    private var muted = false

    // interruzioni
    private var lastPlayingAt = Date.distantPast
    private var userPausedAt = Date.distantPast
    private var resumeAfterInterruption = false

    // suoni del minigioco offline: vedi suonoGioco
    private var motoreGioco: AVAudioEngine?
    private var nodiGioco: [AVAudioPlayerNode] = []
    private var prossimoNodo = 0
    private var suoniGioco: [String: AVAudioPCMBuffer] = [:]
    private var spegniGioco: DispatchWorkItem?

    // Now Playing
    private var npTitle = "CRACKIFY"
    private var npArtist = ""
    private var artworkUrl: String?
    private var artwork: MPMediaItemArtwork?

    override public func load() {
        player.automaticallyWaitsToMinimizeStalling = true
        rateObserver = player.observe(\.rate, options: [.new]) { [weak self] p, _ in
            guard let self = self else { return }
            if p.rate != 0 { self.lastPlayingAt = Date() }
            self.emit("state")
            self.updateNowPlaying()
        }
        // come "playing"/"waiting" dell'<audio>: lo shim JS risolve play()
        // solo al primo "playing", altrimenti il riempimento della riga
        // finiva prima che il brano partisse (anteprime Deezer, 03/10)
        controlObserver = player.observe(\.timeControlStatus, options: [.new]) { [weak self] p, _ in
            DispatchQueue.main.async {
                guard let self = self else { return }
                switch p.timeControlStatus {
                case .playing: self.emit("playing")
                case .waitingToPlayAtSpecifiedRate: self.emit("waiting")
                default: break
                }
            }
        }
        timeObserver = player.addPeriodicTimeObserver(
            forInterval: CMTime(seconds: 0.25, preferredTimescale: 600), queue: .main
        ) { [weak self] _ in
            self?.emit("timeupdate")
        }
        NotificationCenter.default.addObserver(
            self, selector: #selector(handleInterruption(_:)),
            name: AVAudioSession.interruptionNotification,
            object: AVAudioSession.sharedInstance())
        setupRemoteCommands()
    }

    // MARK: stato verso JS

    private var currentTime: Double {
        let t = player.currentTime().seconds
        return t.isFinite ? t : 0
    }

    private var duration: Double {
        guard let d = player.currentItem?.duration.seconds, d.isFinite, d > 0 else { return -1 }
        return d
    }

    private var bufferedEnd: Double {
        guard let r = player.currentItem?.loadedTimeRanges.last?.timeRangeValue else { return 0 }
        let e = (r.start + r.duration).seconds
        return e.isFinite ? e : 0
    }

    private func emit(_ type: String, extra: [String: Any] = [:]) {
        var data: [String: Any] = [
            "type": type,
            "t": currentTime,
            "d": duration,
            "paused": player.rate == 0,
            "sounding": player.timeControlStatus == .playing,
            "buf": bufferedEnd,
            "gen": gen,
        ]
        for (k, v) in extra { data[k] = v }
        notifyListeners("audio", data: data)
    }

    // MARK: metodi JS

    @objc func load(_ call: CAPPluginCall) {
        let raw = call.getString("url") ?? ""
        let g = call.getInt("gen") ?? 0
        DispatchQueue.main.async {
            self.replaceItem(raw, gen: g)
            call.resolve()
        }
    }

    private func replaceItem(_ raw: String, gen g: Int) {
        itemObservers.forEach { $0.invalidate() }
        itemObservers = []
        if let o = endObserver { NotificationCenter.default.removeObserver(o) }
        endObserver = nil
        pendingSeek = nil
        player.pause()  // emette ancora con la generazione vecchia: JS la ignora
        gen = g
        guard !raw.isEmpty, let url = Self.playableUrl(raw) else {
            player.replaceCurrentItem(with: nil)
            updateNowPlaying()
            return
        }
        let item = AVPlayerItem(url: url)
        var announced = false
        itemObservers.append(item.observe(\.status, options: [.new]) { [weak self] it, _ in
            DispatchQueue.main.async {
                guard let self = self, self.player.currentItem === it else { return }
                if it.status == .readyToPlay, !announced {
                    announced = true
                    if let s = self.pendingSeek {
                        self.pendingSeek = nil
                        self.doSeek(s)
                    }
                    self.emit("loadedmetadata")
                    self.emit("durationchange")
                    self.emit("canplay")
                    self.updateNowPlaying()
                } else if it.status == .failed {
                    self.emit("error", extra: ["code": 4,
                        "msg": it.error?.localizedDescription ?? ""])
                }
            }
        })
        itemObservers.append(item.observe(\.loadedTimeRanges, options: [.new]) { [weak self] it, _ in
            DispatchQueue.main.async {
                guard let self = self, self.player.currentItem === it else { return }
                self.emit("progress")
            }
        })
        endObserver = NotificationCenter.default.addObserver(
            forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main
        ) { [weak self] _ in
            self?.emit("ended")
        }
        player.replaceCurrentItem(with: item)
        player.volume = muted ? 0 : volume
    }

    /// Le copie offline arrivano come URL capacitor://…/_capacitor_file_/…
    /// (servite dal WebView): AVPlayer vuole il file:// vero.
    static func playableUrl(_ raw: String) -> URL? {
        let marker = "/_capacitor_file_"
        if raw.hasPrefix("capacitor://"), let r = raw.range(of: marker) {
            let path = String(raw[r.upperBound...]).removingPercentEncoding ?? String(raw[r.upperBound...])
            return URL(fileURLWithPath: path)
        }
        return URL(string: raw)
    }

    @objc func play(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.startPlayback()
            call.resolve()
        }
    }

    private func startPlayback() {
        guard player.currentItem != nil else { return }
        let s = AVAudioSession.sharedInstance()
        try? s.setCategory(.playback, mode: .default, options: [])
        try? s.setActive(true)
        if player.currentItem?.status == .readyToPlay,
           duration > 0, currentTime >= duration - 0.05 {
            player.seek(to: .zero)
        }
        player.play()
    }

    @objc func pause(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.userPausedAt = Date()
            self.player.pause()
            call.resolve()
        }
    }

    @objc func seek(_ call: CAPPluginCall) {
        let t = call.getDouble("time") ?? 0
        DispatchQueue.main.async {
            if self.player.currentItem?.status == .readyToPlay {
                self.doSeek(t)
            } else {
                self.pendingSeek = t
            }
            call.resolve()
        }
    }

    private func doSeek(_ t: Double) {
        player.seek(to: CMTime(seconds: max(0, t), preferredTimescale: 600),
                    toleranceBefore: .zero, toleranceAfter: .zero) { [weak self] _ in
            DispatchQueue.main.async {
                self?.emit("seeked")
                self?.updateNowPlaying()
            }
        }
    }

    /// Suoni del minigioco offline (07/10). Prima erano Web Audio dentro la
    /// WebView e su iPhone arrivavano a sprazzi («un paio di bip ogni tanto,
    /// non come pianificato»); Vitto: «l'audio dovrebbe essere nativo iOS, non
    /// WebKit». Ora qui: bip a 8 bit sintetizzati una volta (SuoniGioco) e
    /// suonati da un AVAudioEngine sulla stessa sessione della musica.
    /// La regola di Vitto si controlla qui, nel momento del bip: se la musica
    /// di Crackify suona o sta partendo (rate != 0) il gioco tace, e tace
    /// anche se suona un'altra app (secondaryAudioShouldBeSilencedHint, il
    /// segnale che iOS dà apposta ai giochi).
    @objc func suonoGioco(_ call: CAPPluginCall) {
        let nome = call.getString("nome") ?? ""
        DispatchQueue.main.async {
            if self.player.rate != 0 {
                call.resolve(["suonato": false, "motivo": "musica"])
                return
            }
            if AVAudioSession.sharedInstance().secondaryAudioShouldBeSilencedHint {
                call.resolve(["suonato": false, "motivo": "altra-app"])
                return
            }
            guard self.preparaMotoreGioco(), let buffer = self.suoniGioco[nome] else {
                call.resolve(["suonato": false, "motivo": "motore"])
                return
            }
            // tre voci a giro: un salto non taglia il doppio bip dei 100
            // punti, la fanfara del record parte sopra lo schianto
            let nodo = self.nodiGioco[self.prossimoNodo % self.nodiGioco.count]
            self.prossimoNodo += 1
            nodo.scheduleBuffer(buffer, at: nil, options: .interrupts, completionHandler: nil)
            if !nodo.isPlaying { nodo.play() }
            // dopo 4 s di silenzio il motore si spegne: niente uscita audio
            // tenuta occupata (e batteria) a gioco fermo
            self.spegniGioco?.cancel()
            let spegni = DispatchWorkItem { [weak self] in
                self?.nodiGioco.forEach { $0.stop() }
                self?.motoreGioco?.stop()
            }
            self.spegniGioco = spegni
            DispatchQueue.main.asyncAfter(deadline: .now() + 4, execute: spegni)
            call.resolve(["suonato": true])
        }
    }

    /// Motore e suoni pronti al primo bip; il motore riparte se iOS l'ha
    /// fermato (cuffie staccate, interruzione) o se l'abbiamo spento noi.
    private func preparaMotoreGioco() -> Bool {
        if motoreGioco == nil {
            let motore = AVAudioEngine()
            guard let formato = AVAudioFormat(standardFormatWithSampleRate: SuoniGioco.frequenza, channels: 1) else {
                return false
            }
            for _ in 0..<3 {
                let nodo = AVAudioPlayerNode()
                motore.attach(nodo)
                motore.connect(nodo, to: motore.mainMixerNode, format: formato)
                nodiGioco.append(nodo)
            }
            suoniGioco = SuoniGioco.crea(formato: formato)
            motoreGioco = motore
        }
        guard let motore = motoreGioco else { return false }
        if !motore.isRunning {
            do {
                try motore.start()
            } catch {
                return false
            }
        }
        return true
    }

    @objc func setVolume(_ call: CAPPluginCall) {
        let v = Float(call.getDouble("volume") ?? 1)
        let m = call.getBool("muted") ?? false
        DispatchQueue.main.async {
            self.volume = max(0, min(1, v))
            self.muted = m
            self.player.volume = m ? 0 : self.volume
            call.resolve()
        }
    }

    @objc func setNowPlaying(_ call: CAPPluginCall) {
        let title = call.getString("title") ?? "CRACKIFY"
        let artist = call.getString("artist") ?? ""
        let art = call.getString("artwork") ?? ""
        DispatchQueue.main.async {
            self.npTitle = title
            self.npArtist = artist
            if art != self.artworkUrl {
                self.artworkUrl = art
                self.artwork = nil
                self.loadArtwork(art)
            }
            self.updateNowPlaying()
            call.resolve()
        }
    }

    // MARK: Now Playing

    private func updateNowPlaying() {
        let center = MPNowPlayingInfoCenter.default()
        guard player.currentItem != nil else {
            center.nowPlayingInfo = nil
            return
        }
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: npTitle,
            MPMediaItemPropertyArtist: npArtist,
            MPMediaItemPropertyAlbumTitle: "CRACKIFY",
            MPNowPlayingInfoPropertyElapsedPlaybackTime: currentTime,
            MPNowPlayingInfoPropertyPlaybackRate: Double(player.rate),
        ]
        if duration > 0 { info[MPMediaItemPropertyPlaybackDuration] = duration }
        if let a = artwork { info[MPMediaItemPropertyArtwork] = a }
        center.nowPlayingInfo = info
        center.playbackState = player.rate != 0 ? .playing : .paused
    }

    private func loadArtwork(_ s: String) {
        guard let url = URL(string: s), url.scheme?.hasPrefix("http") == true
                || url.isFileURL || s.hasPrefix("capacitor://") else { return }
        let target = Self.playableUrl(s) ?? url
        URLSession.shared.dataTask(with: target) { [weak self] data, _, _ in
            guard let self = self, let data = data, let img = UIImage(data: data) else { return }
            DispatchQueue.main.async {
                guard self.artworkUrl == s else { return }
                self.artwork = MPMediaItemArtwork(boundsSize: img.size) { _ in img }
                self.updateNowPlaying()
            }
        }.resume()
    }

    // MARK: comandi dal controller

    private func setupRemoteCommands() {
        let c = MPRemoteCommandCenter.shared()
        // play/pausa li gestiamo QUI, subito: dopo una lunga pausa in
        // background il WebView può essere ancora sospeso quando arriva il
        // comando. JS viene solo avvisato per allineare sync/UI.
        c.playCommand.addTarget { [weak self] _ in
            guard let self = self, self.player.currentItem != nil else {
                self?.notifyListeners("remote", data: ["cmd": "play"])
                return .success
            }
            self.startPlayback()
            self.notifyListeners("remote", data: ["cmd": "play", "handled": true])
            return .success
        }
        c.pauseCommand.addTarget { [weak self] _ in
            self?.userPausedAt = Date()
            self?.player.pause()
            self?.notifyListeners("remote", data: ["cmd": "pause", "handled": true])
            return .success
        }
        c.togglePlayPauseCommand.addTarget { [weak self] _ in
            guard let self = self else { return .commandFailed }
            if self.player.rate != 0 {
                self.userPausedAt = Date()
                self.player.pause()
                self.notifyListeners("remote", data: ["cmd": "pause", "handled": true])
            } else if self.player.currentItem != nil {
                self.startPlayback()
                self.notifyListeners("remote", data: ["cmd": "play", "handled": true])
            } else {
                self.notifyListeners("remote", data: ["cmd": "play"])
            }
            return .success
        }
        c.nextTrackCommand.addTarget { [weak self] _ in
            self?.notifyListeners("remote", data: ["cmd": "next"])
            return .success
        }
        c.previousTrackCommand.addTarget { [weak self] _ in
            self?.notifyListeners("remote", data: ["cmd": "prev"])
            return .success
        }
        c.changePlaybackPositionCommand.addTarget { [weak self] ev in
            guard let self = self, let e = ev as? MPChangePlaybackPositionCommandEvent else {
                return .commandFailed
            }
            self.doSeek(e.positionTime)
            return .success
        }
        c.skipForwardCommand.isEnabled = false
        c.skipBackwardCommand.isEnabled = false
    }

    // MARK: interruzioni (chiamata, vocale, video di un'altra app)

    @objc private func handleInterruption(_ note: Notification) {
        guard let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
        DispatchQueue.main.async {
            if type == .began {
                // iOS ferma AVPlayer da sé, a volte prima che arrivi "began":
                // conta anche una pausa di un attimo fa non chiesta da noi
                let now = Date()
                self.resumeAfterInterruption = self.player.rate != 0
                    || (now.timeIntervalSince(self.lastPlayingAt) < 2
                        && now.timeIntervalSince(self.userPausedAt) > 2)
                return
            }
            let optRaw = note.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0
            let shouldResume = AVAudioSession.InterruptionOptions(rawValue: optRaw).contains(.shouldResume)
            let resume = shouldResume && self.resumeAfterInterruption
            self.resumeAfterInterruption = false
            if resume { self.startPlayback() }
        }
    }
}

/// View controller del bridge: registra i plugin locali (non sono pacchetti
/// npm, vivono nel target App).
class CrackifyBridgeViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(NativeAudioPlugin())
        bridge?.registerPluginInstance(OrientamentoPlugin())
    }

    // Il bridge di suo legge gli orientamenti dall'Info.plist (solo
    // verticale): qui decide OrientamentoPlugin, che apre l'orizzontale
    // solo per il minigioco offline.
    override open var supportedInterfaceOrientations: UIInterfaceOrientationMask {
        return OrientamentoPlugin.maschera
    }
}

/// I bip a 8 bit del minigioco, sintetizzati una volta in memoria: onda
/// quadra con frequenza che scorre da f1 a f2 e inviluppo esponenziale
/// (attacco di 6 ms, poi coda fino al silenzio), più un colpo di rumore
/// filtrato per lo schianto. Stessa ricetta della prima versione in Web
/// Audio, così suonano uguali.
enum SuoniGioco {
    static let frequenza: Double = 44100
    /// volume generale: bip, non concerto
    static let volume: Float = 0.14

    static func crea(formato: AVAudioFormat) -> [String: AVAudioPCMBuffer] {
        var suoni: [String: AVAudioPCMBuffer] = [:]
        suoni["salto"] = buffer(0.11, formato) { s in
            tono(&s, 620, 980, 0, 0.09, 0.8)
        }
        suoni["cento"] = buffer(0.22, formato) { s in
            tono(&s, 1046, 1046, 0, 0.07, 0.7)
            tono(&s, 1046, 1046, 0.1, 0.1, 0.7)
        }
        suoni["schianto"] = buffer(0.3, formato) { s in
            tono(&s, 260, 70, 0, 0.28, 1)
            rumore(&s, 0, 0.14, 0.7, 900)
        }
        // do-mi-sol-do, dopo lo schianto (parte insieme, con 0,34 s di attesa)
        suoni["record"] = buffer(0.74, formato) { s in
            for (i, f) in [523.0, 659.0, 784.0, 1046.0].enumerated() {
                tono(&s, f, f, 0.34 + Double(i) * 0.09, 0.1, 0.75)
            }
        }
        // oggetti e poteri (08/10), stesse ricette del Web Audio in app.js:
        // oggetto preso, arpeggio che sale (sol-do-mi-sol)
        suoni["oggetto"] = buffer(0.34, formato) { s in
            for (i, f) in [784.0, 1046.0, 1318.0, 1568.0].enumerated() {
                tono(&s, f, f, Double(i) * 0.06, i == 3 ? 0.14 : 0.06, 0.6)
            }
        }
        // il soffio atomico di Godzilla (08/10, carica e spara): una tacca
        // della carica per ognuna delle 6, bip che sale, l'ultima doppia
        for n in 1...6 {
            let f = 330 * pow(1.19, Double(n))
            suoni["carica\(n)"] = buffer(n == 6 ? 0.17 : 0.08, formato) { s in
                tono(&s, f, f * 1.06, 0, 0.06, 0.5)
                if n == 6 { tono(&s, f * 1.5, f * 1.5, 0.07, 0.08, 0.5) }
            }
        }
        // il soffio: botto grave, ruggito di rumore e fischio che scende
        suoni["soffio"] = buffer(0.72, formato) { s in
            tono(&s, 90, 40, 0, 0.6, 1)
            tono(&s, 1400, 500, 0, 0.5, 0.3)
            rumore(&s, 0, 0.7, 0.7, 1800)
        }
        // lasciato troppo presto: uno sbuffo
        suoni["sfiata"] = buffer(0.16, formato) { s in
            tono(&s, 300, 150, 0, 0.12, 0.35)
            rumore(&s, 0, 0.15, 0.7, 1200)
        }
        // diventa Godzilla: sale, poi il ruggito (rumore grave)
        suoni["trasforma"] = buffer(0.52, formato) { s in
            tono(&s, 110, 440, 0, 0.42, 0.9)
            tono(&s, 220, 880, 0.05, 0.38, 0.45)
            rumore(&s, 0, 0.5, 0.7, 500)
        }
        // torna dinosauro: scende, con lo sbuffo
        suoni["torna"] = buffer(0.36, formato) { s in
            tono(&s, 660, 165, 0, 0.34, 0.6)
            rumore(&s, 0, 0.2, 0.7, 2200)
        }
        // ostacolo spaccato: botto basso col rumore
        suoni["scoppio"] = buffer(0.24, formato) { s in
            tono(&s, 180, 50, 0, 0.2, 0.9)
            rumore(&s, 0, 0.2, 0.7, 1400)
        }
        // lo scudo para il colpo e si spegne: due note di vetro che scendono
        suoni["scudo"] = buffer(0.2, formato) { s in
            tono(&s, 2093, 1046, 0, 0.16, 0.6)
            tono(&s, 1568, 784, 0.02, 0.14, 0.4)
        }
        // drop del basso: un colpo che sprofonda nel grave, col rumore sotto
        // (08/10, la boombox: prima il rullante che accelera e sale, poi la
        // botta alla stessa ora del disegno, 0,35 s, e altri due colpi a tempo)
        suoni["drop"] = buffer(1.15, formato) { s in
            for (i, q) in [0, 0.09, 0.17, 0.23, 0.28, 0.32].enumerated() {
                rumore(&s, q, 0.04, 0.25 + Double(i) * 0.08, 3500)
                tono(&s, 300 * pow(1.3, Double(i)), 330 * pow(1.3, Double(i)), q, 0.04, 0.2 + Double(i) * 0.05)
            }
            tono(&s, 110, 32, 0.35, 0.6, 1)
            rumore(&s, 0.35, 0.35, 0.7, 260)
            tono(&s, 100, 35, 0.6, 0.25, 0.6)
            tono(&s, 100, 35, 0.85, 0.25, 0.4)
        }
        // pozione: scivolata in giù, ci si rimpicciolisce
        suoni["pozione"] = buffer(0.32, formato) { s in
            tono(&s, 1568, 392, 0, 0.3, 0.6)
            tono(&s, 1175, 294, 0.05, 0.25, 0.4)
        }
        // l'errore di Windows XP (Vitto: «col suo indimenticabile suono»):
        // ricostruito a orecchio, non il file di Microsoft. Due rintocchi di
        // campana che scendono, il secondo con l'ottava sotto, e un'eco corta
        suoni["errore"] = buffer(1.0, formato) { s in
            campana(&s, 659, 0, 0.6, 0.9)
            campana(&s, 494, 0.12, 0.85, 0.9)
            campana(&s, 247, 0.12, 0.85, 0.35)
            campana(&s, 659, 0.07, 0.5, 0.22)
            campana(&s, 494, 0.19, 0.7, 0.22)
        }
        return suoni
    }

    private static func buffer(_ durata: Double, _ formato: AVAudioFormat, _ disegna: (inout [Float]) -> Void) -> AVAudioPCMBuffer? {
        let n = Int(durata * frequenza)
        var campioni = [Float](repeating: 0, count: n)
        disegna(&campioni)
        guard let buf = AVAudioPCMBuffer(pcmFormat: formato, frameCapacity: AVAudioFrameCount(n)),
              let canale = buf.floatChannelData?[0] else { return nil }
        buf.frameLength = AVAudioFrameCount(n)
        for i in 0..<n {
            canale[i] = max(-1, min(1, campioni[i] * volume))
        }
        return buf
    }

    /// Onda quadra da f1 a f2 (rampa esponenziale) che parte a `inizio`.
    private static func tono(_ s: inout [Float], _ f1: Double, _ f2: Double, _ inizio: Double, _ durata: Double, _ vol: Double) {
        let i0 = Int(inizio * frequenza)
        let n = Int(durata * frequenza)
        let attacco = 0.006
        var fase = 0.0
        for k in 0..<n {
            let t = Double(k) / frequenza
            let f = f1 * pow(f2 / f1, t / durata)
            fase += f / frequenza
            if fase >= 1 { fase -= 1 }
            let quadra: Double = fase < 0.5 ? 1 : -1
            let g = t < attacco
                ? 0.0001 * pow(vol / 0.0001, t / attacco)
                : vol * pow(0.0001 / vol, (t - attacco) / (durata - attacco))
            let i = i0 + k
            if i < s.count { s[i] += Float(quadra * g) }
        }
    }

    /// Rintocco di campana: sinusoidi sulla fondamentale e su due armonici
    /// (×2 al 30%, ×3,01 al 12%), attacco di 8 ms e coda che si smorza. Non
    /// è un 8 bit: serve al suono dell'errore di Windows.
    private static func campana(_ s: inout [Float], _ f: Double, _ inizio: Double, _ durata: Double, _ vol: Double) {
        let i0 = Int(inizio * frequenza)
        let n = Int(durata * frequenza)
        let attacco = 0.008
        for k in 0..<n {
            let t = Double(k) / frequenza
            let g = t < attacco
                ? 0.0001 * pow(vol / 0.0001, t / attacco)
                : vol * pow(0.0001 / vol, (t - attacco) / (durata - attacco))
            let onda = sin(2 * Double.pi * f * t)
                + 0.3 * sin(2 * Double.pi * 2 * f * t)
                + 0.12 * sin(2 * Double.pi * 3.01 * f * t)
            let i = i0 + k
            if i < s.count { s[i] += Float(onda * g) }
        }
    }

    /// Colpo di rumore passato da un filtro passa-basso, che si smorza.
    private static func rumore(_ s: inout [Float], _ inizio: Double, _ durata: Double, _ vol: Double, _ taglio: Double) {
        let i0 = Int(inizio * frequenza)
        let n = Int(durata * frequenza)
        let a = 1 - exp(-2 * Double.pi * taglio / frequenza)
        var y = 0.0
        for k in 0..<n {
            let t = Double(k) / frequenza
            y += a * (Double.random(in: -1...1) - y)
            let g = vol * pow(0.0001 / vol, t / durata)
            let i = i0 + k
            if i < s.count { s[i] += Float(y * g) }
        }
    }
}
