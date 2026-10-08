// Fase 2 del boss: foto di arrivo e incontro (banner e schermo intero) e i
// suoni di fase nell'ordine giusto. Uso: node boss-incontro.mjs <cartella-foto>
import { apri, foto } from "./banco.mjs";
const OUT = process.argv[2];
for (const [nome, opz] of [["v", {}], ["o", { largo: 852, alto: 393, schermo: true }]]) {
  const { browser, page, errori } = await apri(opz);
  await page.locator("#dinoCampo").tap();
  await page.evaluate(() => {
    window.__suoni = [];
    const o = window.dinoSuono;
    window.dinoSuono = (n) => (window.__suoni.push(n), o(n));
    window.__p = setInterval(() => (__dino.ostacoli = __dino.ostacoli.filter((o) => o.x > 90 || o.x + o.w < 0)), 20);
    window.__dinoBoss("scimmione");
  });
  const scatta = async (fase, t, file) => {
    await page.waitForFunction(([f, t]) => __dino.boss && __dino.boss.fase === f && __dino.boss.t >= t, [fase, t], { timeout: 20000 });
    await foto(page, `${OUT}/${nome}-${file}.png`, !!opz.schermo);
  };
  await scatta("arrivo", 700, "1-arrivo");
  await scatta("incontro", 250, "2-incontro");
  await scatta("incontro", 900, "3-incontro");
  await page.waitForFunction(() => __dino.boss && __dino.boss.fase === "gioco", null, { timeout: 8000 });
  const suoni = await page.evaluate(() => window.__suoni.join(","));
  console.log(nome, suoni, "errori:", errori.length ? errori : "nessuno");
  if (suoni !== "boss_arriva,boss_titolo,tendina" || errori.length) process.exitCode = 1;
  await browser.close();
}
