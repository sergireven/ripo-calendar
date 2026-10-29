// Sonda temporal: com llegir calendaris de la FECAPA i la RFEP (sidgad) sense navegador.
import fs from "node:fs";
const OUT = "probe-out";
fs.mkdirSync(OUT, { recursive: true });
const log = (...a) => { const s = a.join(" "); console.log(s); fs.appendFileSync(`${OUT}/log.txt`, s + "\n"); };
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127 Safari/537.36";

async function get(name, url, opts = {}) {
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA, ...(opts.headers || {}) }, method: opts.method || "GET", body: opts.body });
    const t = await r.text();
    fs.writeFileSync(`${OUT}/${name}`, t);
    log(`${name}: HTTP ${r.status} ${t.length}B  idc_master=${(t.match(/idc_master/g) || []).length} team_class=${(t.match(/team_class/g) || []).length} game_report=${(t.match(/game_report/g) || []).length}`);
    return t;
  } catch (e) { log(`${name}: ERROR ${e.message}`); return ""; }
}
const form = o => ({ method: "POST", body: new URLSearchParams(o), headers: { "Content-Type": "application/x-www-form-urlencoded" } });
const withRef = (o, ref) => ({ ...o, headers: { ...o.headers, Referer: ref, Origin: new URL(ref).origin } });

const FEC = "https://www.hoqueipatins.fecapa.cat/";
const home = await get("fecapa-home.html", FEC);
log("temp_activa:", (home.match(/id="temp_activa"[^>]*value="(\d+)"/) || home.match(/temp_activa[^>]*value="?(\d+)/) || [])[1] || "-");
for (const id of ["4948", "4999", "4866"]) {
  await get(`fecapa-cal-${id}.html`, `https://www.server2.sidgad.es/fecapa/fecapa_cal_idc_${id}_1.php`, form({ idc: id, site_lang: "ca" }));
  await get(`fecapa-cal-${id}-ref.html`, `https://www.server2.sidgad.es/fecapa/fecapa_cal_idc_${id}_1.php`, withRef(form({ idc: id, site_lang: "ca" }), FEC));
}
await get("fecapa-ls.html", "https://www.server2.sidgad.es/fecapa/fecapa_ls_1.php");
await get("fecapa-mc.html", "https://www.server2.sidgad.es/fecapa/fecapa_mc_1.php", withRef(form({ idm: "1" }), FEC));
await get("rfep-cal-3575.html", "https://www.server2.sidgad.es/rfep/rfep_cal_idc_3575_1.php", form({ idc: "3575", site_lang: "es" }));
await get("rfep-home.html", "https://www.hockeypatines.fep.es/");

// Amb navegador: quines peticions fa el portal i quina llista de competicions hi ha.
try {
  const puppeteer = (await import("puppeteer")).default;
  const b = await puppeteer.launch({ args: ["--no-sandbox"] });
  const p = await b.newPage();
  const reqs = [];
  p.on("request", r => { if (/sidgad|fecapa/.test(r.url()) && !/\.(png|jpe?g|gif|svg|css|woff2?|js)(\?|$)/i.test(r.url())) reqs.push(`${r.method()} ${r.url()} ${r.postData() || ""}`); });
  await p.goto(FEC, { waitUntil: "networkidle2", timeout: 90000 });
  await new Promise(r => setTimeout(r, 4000));
  const info = await p.evaluate(() => {
    const temp = document.getElementById("temp_activa")?.value || "";
    return {
      temp,
      temps: [...document.querySelectorAll(".select_temporada")].slice(0, 3).map(e => [e.getAttribute("id_temp"), e.getAttribute("temp_name")]),
      comps: [...document.querySelectorAll(`a.idc_master.temp_${temp}`)].map(a => [a.id, a.getAttribute("name")]),
      allIdc: document.querySelectorAll("a.idc_master").length,
    };
  });
  fs.writeFileSync(`${OUT}/browser-comps.json`, JSON.stringify(info, null, 1));
  log(`browser: temp=${info.temp} comps(temp)=${info.comps.length} total=${info.allIdc}`);
  log("REQUESTS:\n" + reqs.join("\n"));
  // Clic a una competició per veure la petició del calendari i la fitxa d'un partit.
  const rip = info.comps.find(c => /BENJAM/i.test(c[1])) || info.comps[0];
  reqs.length = 0;
  if (rip) {
    await p.evaluate(id => document.getElementById(id)?.click(), rip[0]);
    await new Promise(r => setTimeout(r, 6000));
    log(`CLICK ${rip.join(" ")} REQUESTS:\n` + reqs.join("\n"));
  }
  fs.writeFileSync(`${OUT}/fecapa-home-rendered.html`, await p.content());
  await b.close();
} catch (e) { log("browser ERROR " + e.message); }
