// Sonda 2: llista de competicions, calendari mestre, RFEP i acta, sense navegador.
import fs from "node:fs";
const OUT = "probe-out2";
fs.mkdirSync(OUT, { recursive: true });
const log = (...a) => { const s = a.join(" "); console.log(s); fs.appendFileSync(`${OUT}/log.txt`, s + "\n"); };
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127 Safari/537.36";
const FEC = "https://www.hoqueipatins.fecapa.cat/";
const FEP = "https://www.hockeypatines.fep.es/";
async function req(name, url, { body, ref } = {}) {
  const headers = { "User-Agent": UA, "X-Requested-With": "XMLHttpRequest" };
  if (ref) { headers.Referer = ref; headers.Origin = new URL(ref).origin; }
  if (body) headers["Content-Type"] = "application/x-www-form-urlencoded; charset=UTF-8";
  try {
    const r = await fetch(url, { method: body ? "POST" : "GET", headers, body: body ? new URLSearchParams(body) : undefined });
    const t = await r.text();
    fs.writeFileSync(`${OUT}/${name}`, t);
    const fases = [...new Set([...t.matchAll(/content_fase_(\d+)/g)].map(m => m[1]))];
    log(`${name}: HTTP ${r.status} ${t.length}B idc_master=${(t.match(/idc_master/g) || []).length} temp_41=${(t.match(/temp_41/g) || []).length} rows=${(t.match(/team_class/g) || []).length} fases=${fases.join(",")} players=${(t.match(/player_season_stats/g) || []).length} ripollet=${(t.match(/RIPOLLET/gi) || []).length}`);
    return t;
  } catch (e) { log(`${name}: ERROR ${e.message}`); return ""; }
}
await req("ls-get.html", "https://www.server2.sidgad.es/fecapa/fecapa_ls_1.php", { ref: FEC });
await req("ls-post.html", "https://www.server2.sidgad.es/fecapa/fecapa_ls_1.php", { ref: FEC, body: { idm: "1" } });
await req("cal-4810.html", "https://www.server2.sidgad.es/fecapa/fecapa_cal_idc_4810_1.php", { ref: FEC, body: { idc: "4810", site_lang: "ca" } });
await req("cal-4776.html", "https://www.server2.sidgad.es/fecapa/fecapa_cal_idc_4776_1.php", { ref: FEC, body: { idc: "4776", site_lang: "ca" } });
await req("rfep-cal-3575.html", "https://www.server2.sidgad.es/rfep/rfep_cal_idc_3575_1.php", { ref: FEP, body: { idc: "3575", site_lang: "es" } });
await req("rfep-ls.html", "https://www.server2.sidgad.es/rfep/rfep_ls_1.php", { ref: FEP });
await req("gr-154502.html", "https://www.server2.sidgad.es/fecapa/fecapa_gr_154502_1.php", { ref: FEC, body: { idm: "1", idc: "4948", idp: "154502", tab: "tab_ficha_resumen" } });
