import { genera, regoleV402 } from './mondo.mjs';
import { analizza, riassumi } from './analisi.mjs';
const quale = process.argv[2] || 'v402';
const mod = await import('./regole.mjs').catch(() => ({}));
const regole = quale === 'v402' ? regoleV402 : mod[quale];
// «boss»: un boss ogni 20 s, ritorno con la strada libera di BOSS_RIPRESA e
// il primo spawn dopo ogni ritorno forzato a oggetto (il caso peggiore)
const boss = process.argv.includes('boss') ? { ogni: 20000, ripresa: 1500, forza: true } : null;
let righe = [];
for (let seed = 1; seed <= 40; seed++) righe = righe.concat(analizza(genera({ seed, regole, ogni: 5000, boss })));
riassumi(righe, boss ? `${quale} + boss` : quale);
if (process.argv[3] === 'dettagli') {
  const brutti = righe.filter((x) => x.comodaMs === 0);
  const per = {}; brutti.forEach((x) => (per[x.davanti] = (per[x.davanti] || 0) + 1));
  const tutti = {}; righe.forEach((x) => (tutti[x.davanti] = (tutti[x.davanti] || 0) + 1));
  console.log('scomodi per ostacolo davanti:', Object.entries(per).map(([k, n]) => `${k} ${n}/${tutti[k]}`).join(', '));
  console.log('per oggetto:', ['scaglia','stella','cuffie','basso','pozione'].map(t=>{const r=righe.filter(x=>x.tipo===t);return t+' '+r.filter(x=>x.comodaMs===0).length+'/'+r.length}).join(', '));
}
