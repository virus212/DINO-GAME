// DEBUG boss: da togliere col pannello. Il pannello «Debug» del menu del dino
// (banco offline, telefono): tocca ogni bottone dei trucchi e dei cattivi e ne
// guarda l'effetto su window.__dino.
// Uso: PW_DIR=~/crackify-redesign/node_modules BROWSER=webkit STATIC=$PWD/static node boss-debug.mjs foto
import { apri } from "./banco.mjs";
const OUT = process.argv[2] || ".";
const { browser, page, errori } = await apri();
const falliti = [];
const verifica = (nome, ok, info = "") => {
  console.log(`${ok ? "ok" : "NO"}  ${nome}${info ? "  | " + info : ""}`);
  if (!ok) falliti.push(nome);
};
/** Apre il menu e tocca il bottone del pannello; aspetta il suo effetto. */
async function tocca(cosa) {
  await page.evaluate(() => apriMenuDino());
  await page.waitForTimeout(350);
  await page.locator(`#dinoMenu [data-debug="${cosa}"]`).tap();
  await page.waitForTimeout(cosa === "trucco:immortale" ? 150 : 450);
}
const stato = () => page.evaluate(() => ({ stato: __dino.stato, v: __dino.velocita, boss: __dino.boss && { fase: __dino.boss.fase, esito: __dino.boss.esito }, causa: __dino.causa }));

// il pannello: 3 colonne, ogni gruppo col suo titolino
await page.evaluate(() => apriMenuDino());
await page.waitForTimeout(400);
const pannello = await page.evaluate(() => {
  const g = document.querySelector("#dinoDebug .dino-debug-griglia");
  return { colonne: getComputedStyle(g).gridTemplateColumns.split(" ").length, bottoni: [...g.querySelectorAll("[data-debug]")].map((b) => b.dataset.debug) };
});
verifica("pannello a 3 colonne", pannello.colonne === 3, `${pannello.bottoni.length} bottoni`);
await page.locator("#dinoDebug").scrollIntoViewIfNeeded();
await page.locator("#dinoDebug").screenshot({ path: `${OUT}/debug-pannello.png` });
await page.evaluate(() => chiudiMenuDino());
await page.waitForTimeout(300);

// Immortale: resta nel menu e cambia etichetta
await tocca("trucco:immortale");
const imm = await page.evaluate(() => ({ testo: document.querySelector('[data-debug="trucco:immortale"]').textContent, on: _dinoDebugImmortale, aperto: !document.getElementById("dinoMenu").classList.contains("hidden") }));
verifica("Immortale: sì", imm.on && imm.testo === "Immortale: sì" && imm.aperto, imm.testo);

// Vinci boss senza un boss: niente
await tocca("trucco:vinci");
const nulla = await stato();
verifica("Vinci boss senza boss non fa niente", !nulla.boss && nulla.stato !== "corsa", nulla.stato);

// i cattivi: ognuno compare a destra, fuori dal dino, e arriva in 1-2 s;
// immortale: il dino ci passa attraverso e corre ancora
const CATTIVI = {
  "cattivo:piccolo": (o) => o.tipo === "mixer" && !o.cristallo,
  "cattivo:grande": (o) => o.tipo === "mixer" && o.cristallo,
  "cattivo:fantasma:basso": (o) => o.tipo === "fantasma" && o.sopra < DINO_H,
  "cattivo:fantasma:alto": (o) => o.tipo === "fantasma" && o.sopra >= DINO_H + 14,
  "cattivo:mina": (o) => o.tipo === "mina",
  "cattivo:paracadute": (o) => o.tipo === "paracadute" && o.sopra > 0,
  "cattivo:virus": (o) => o.tipo === "virus",
};
for (const [cosa, prova] of Object.entries(CATTIVI)) {
  await page.evaluate(() => (window.__prima = new Set(__dino.ostacoli)));
  await tocca(cosa);
  const nuovo = await page.evaluate((src) => {
    const prova = eval(src);
    const o = __dino.ostacoli.find((v) => !__prima.has(v) && prova(v));
    window.__nuovo = o;
    window.__t0 = performance.now();
    return o ? { x: Math.round(o.x), w: __dino.w, davanti: o.x > dinoX() + DINO_W + 40 } : null;
  }, prova.toString());
  if (!nuovo) {
    verifica(cosa, false, "non comparso");
    continue;
  }
  let arrivo = -1;
  try {
    await page.waitForFunction(() => __nuovo.x < dinoX() + DINO_W, null, { timeout: 4000 });
    arrivo = await page.evaluate(() => Math.round(performance.now() - __t0));
  } catch (_) {}
  if (cosa === "cattivo:fantasma:alto") await page.locator("#offlineCabinato").screenshot({ path: `${OUT}/debug-fantasma-alto.png` });
  await page.waitForTimeout(500);
  const s = await stato();
  const extra = cosa === "cattivo:virus" ? await page.evaluate(() => !!__dino.virus) : true;
  verifica(cosa, nuovo.davanti && arrivo > 0 && arrivo < 3000 && s.stato === "corsa" && extra, `x ${nuovo.x}/${Math.round(nuovo.w)}, arriva in ${arrivo} ms, ${s.stato}${cosa === "cattivo:virus" ? ", finestre " + extra : ""}`);
}

// Veloce e Lento: ±2, fino a DINO_VEL_MAX e giù fino al minimo
const v0 = (await stato()).v;
await tocca("trucco:veloce");
const v1 = (await stato()).v;
const max = await page.evaluate(() => DINO_VEL_MAX);
verifica("Veloce +2", Math.abs(v1 - Math.min(max, v0 + 2)) < 0.15, `${v0.toFixed(2)} → ${v1.toFixed(2)}`);
await tocca("trucco:lento");
const v2 = (await stato()).v;
verifica("Lento −2", Math.abs(v2 - Math.max(2, v1 - 2)) < 0.15, `${v1.toFixed(2)} → ${v2.toFixed(2)}`);
for (let i = 0; i < 4; i++) await tocca("trucco:lento");
const v3 = (await stato()).v;
verifica("Lento si ferma al minimo", v3 >= 2 && v3 < 2.15, v3.toFixed(2));
await tocca("trucco:veloce");
await tocca("trucco:veloce");

/** Un boss dal pannello fino al minigioco, poi «Vinci» o «Perdi» boss. */
async function boss(nome, trucco) {
  await tocca(`boss:${nome}`);
  await page.waitForFunction(() => __dino.boss && __dino.boss.fase === "gioco", null, { timeout: 30000 });
  await page.waitForTimeout(300);
  await tocca(trucco);
  return stato();
}
const vinto = await boss("invasori", "trucco:vinci");
verifica("Vinci boss", vinto.boss && vinto.boss.esito === "vinto" && vinto.stato === "corsa", JSON.stringify(vinto.boss));
await page.waitForFunction(() => !__dino.boss, null, { timeout: 10000 });
verifica("dopo la vittoria si corre", (await stato()).stato === "corsa");

// perso da immortale: niente game over, e il prossimo boss non torna subito
const perso = await boss("scimmione", "trucco:perdi");
verifica("Perdi boss", perso.boss && perso.boss.esito === "perso", JSON.stringify(perso.boss));
await page.waitForFunction(() => !__dino.boss, null, { timeout: 10000 });
await page.waitForTimeout(600);
const dopo = await page.evaluate(() => ({ stato: __dino.stato, boss: !!__dino.boss, soglia: __dino.prossimoBoss > __dino.punti }));
verifica("perso da immortale: si corre ancora", dopo.stato === "corsa" && !dopo.boss && dopo.soglia, JSON.stringify(dopo));

// Immortale spento (a minigioco già partito: sennò il primo ostacolo lo
// ammazza prima del boss): perdere il boss è di nuovo game over
await tocca("boss:labirinto");
await page.waitForFunction(() => __dino.boss && __dino.boss.fase === "gioco", null, { timeout: 30000 });
await page.waitForTimeout(300);
await tocca("trucco:immortale");
const off = await page.evaluate(() => ({ testo: document.querySelector('[data-debug="trucco:immortale"]').textContent, on: _dinoDebugImmortale }));
verifica("Immortale: no", !off.on && off.testo === "Immortale: no", off.testo);
await tocca("trucco:perdi");
await page.waitForFunction(() => __dino.stato === "fine", null, { timeout: 10000 }).catch(() => {});
const fine = await stato();
verifica("perso da mortale: game over", fine.stato === "fine" && fine.causa === "Battuto dal boss", `${fine.stato}, ${fine.causa}`);

console.log("falliti:", falliti.length ? falliti : "nessuno");
console.log("errori:", errori.length ? errori : "nessuno");
await browser.close();
process.exit(!falliti.length && !errori.length ? 0 : 1);
