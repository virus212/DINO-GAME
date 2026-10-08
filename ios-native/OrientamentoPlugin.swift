import UIKit
import Capacitor

// Eccezione all'orientamento per il minigioco offline (07/10, Vitto: «l'ho
// bloccata [in verticale], ma si può fare un'eccezione per il minigame»).
//
// L'app resta solo verticale come dice l'Info.plist. Il gioco del dinosauro
// (DINO in app.js) chiama orizzontale() quando si apre a schermo intero e
// verticale() quando si chiude; app.js chiama verticale() anche a ogni avvio,
// così un ricaricamento a gioco aperto (es. torna la rete) non lascia l'app
// girata.
//
// Perché iOS ruoti devono essere d'accordo in due: l'AppDelegate
// (application(_:supportedInterfaceOrientationsFor:)) e il view controller
// del bridge (CrackifyBridgeViewController), che di suo leggerebbe il solo
// verticale dall'Info.plist. Tutti e due guardano `maschera`.
@objc(OrientamentoPlugin)
public class OrientamentoPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "OrientamentoPlugin"
    public let jsName = "Orientamento"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "orizzontale", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "verticale", returnType: CAPPluginReturnPromise),
    ]

    /// Orientamenti permessi adesso: solo verticale, tranne dentro il gioco.
    static var maschera: UIInterfaceOrientationMask = .portrait

    /// Tutti e due i versi dell'orizzontale: iOS sceglie quello in cui tieni
    /// il telefono, niente giroscopio da interrogare.
    @objc func orizzontale(_ call: CAPPluginCall) {
        imposta(.landscape, verso: .landscapeRight, call)
    }

    @objc func verticale(_ call: CAPPluginCall) {
        imposta(.portrait, verso: .portrait, call)
    }

    private func imposta(_ nuova: UIInterfaceOrientationMask, verso: UIInterfaceOrientation, _ call: CAPPluginCall) {
        DispatchQueue.main.async {
            OrientamentoPlugin.maschera = nuova
            guard let vc = self.bridge?.viewController else {
                call.resolve()
                return
            }
            if #available(iOS 16.0, *) {
                vc.setNeedsUpdateOfSupportedInterfaceOrientations()
                vc.view.window?.windowScene?.requestGeometryUpdate(.iOS(interfaceOrientations: nuova)) { _ in }
            } else {
                UIDevice.current.setValue(verso.rawValue, forKey: "orientation")
                UIViewController.attemptRotationToDeviceOrientation()
            }
            call.resolve()
        }
    }
}
