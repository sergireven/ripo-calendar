/**
 * Lectura dels portals sidgad de la FECAPA i la RFEP (veure DECISIONS.md §1).
 * Només HTTP: cal la capçalera Referer del portal, sinó el servidor respon buit.
 */
'use strict';

const SOURCES = {
  fecapa: { base: 'https://www.server2.sidgad.es/fecapa', prefix: 'fecapa', portal: 'https://www.hoqueipatins.fecapa.cat/', lang: 'ca' },
  rfep: { base: 'https://www.server2.sidgad.es/rfep', prefix: 'rfep', portal: 'https://www.hockeypatines.fep.es/', lang: 'es' },
};
const UA = 'Mozilla/5.0 (compatible; ripo-calendar/1.0; +https://github.com/sergireven/ripo-calendar)';

function decode(s) {
  return String(s || '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#0?39;|&apos;/g, "'")
    .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}
const text = (html) => decode(String(html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const attr = (tag, name) => decode((tag.match(new RegExp(`\\b${name}="([^"]*)"`)) || [])[1] || '');

/** Llista de competicions: [{ id, name, temp }]. */
function parseCompetitionList(html) {
  const out = [];
  for (const m of String(html).matchAll(/<a\b[^>]*class="[^"]*idc_master[^"]*"[^>]*>/g)) {
    const tag = m[0];
    const temp = (attr(tag, 'class').match(/\btemp_(\d+)/) || [])[1];
    const id = attr(tag, 'id');
    if (id && temp) out.push({ id, name: attr(tag, 'name').trim(), temp: Number(temp) });
  }
  return out;
}

/** Temporada activa = la temp_ més alta de la llista. */
function activeSeason(list) {
  return list.reduce((max, c) => Math.max(max, c.temp), 0);
}

/**
 * Calendari d'una competició mestra o d'un grup. Una taula `content_fase_{grup}` per grup.
 * @returns {Array<{groupId, groupName, idp, jornada, homeId, home, awayId, away, date, time, played, score}>}
 */
function parseCalendar(html) {
  const out = [];
  const tables = String(html).split(/(?=<table[^>]*content_fase_\d+)/);
  for (const chunk of tables) {
    const groupId = (chunk.match(/^<table[^>]*content_fase_(\d+)/) || [])[1];
    if (!groupId) continue;
    let jornada = null;
    let groupName = '';
    const re = /<thead[^>]*head_jornada[^>]*>([\s\S]*?)<\/thead>|<tr([^>]*team_class[^>]*)>([\s\S]*?)<\/tr>/gi;
    let m;
    while ((m = re.exec(chunk))) {
      if (m[1] != null) {
        const j = text(m[1]).match(/(\d+)/);
        if (j) jornada = Number(j[1]);
        continue;
      }
      const ids = [...m[2].matchAll(/\bteam_(\d+)\b/g)].map((x) => x[1]);
      const row = m[3];
      const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((x) => text(x[1]));
      const names = [...row.matchAll(/nombre_junto_logo[^>]*>([\s\S]*?)<\/div>/gi)].map((x) => text(x[1]));
      if (names.length < 2) continue;
      const d = cells.find((c) => /^\d{2}\/\d{2}\/\d{4}$/.test(c));
      const time = cells.find((c) => /^\d{1,2}:\d{2}$/.test(c)) || '';
      const score = cells.find((c) => /^\d+\s*-\s*\d+$/.test(c));
      const jorCell = cells.find((c) => /^JORNADA\s+\d+/i.test(c));
      const report = row.match(/<[^>]*\bgame_report\b[^>]*>/);
      if (!groupName && report) groupName = attr(report[0], 'topbar_title').replace(/\s+\d{4}\/\d{4}.*$/, '').trim();
      out.push({
        groupId,
        groupName,
        idp: report ? attr(report[0], 'idp') : '',
        jornada: jorCell ? Number(jorCell.match(/\d+/)[0]) : jornada,
        homeId: ids[0] || '',
        home: names[0],
        awayId: ids[1] || '',
        away: names[1],
        date: d ? `${d.slice(6)}-${d.slice(3, 5)}-${d.slice(0, 2)}` : '',
        time: time.padStart(5, '0'),
        played: Boolean(score),
        score: score ? score.replace(/\s+/g, '') : null,
      });
    }
    for (const r of out) if (r.groupId === groupId && !r.groupName) r.groupName = groupName;
  }
  return out;
}

/** "<spam>BENB </spam>APARICIO CASAS <span>MATEU</span>" → "MATEU APARICIO CASAS" */
function personName(html) {
  const clean = String(html).replace(/<spam[\s\S]*?<\/spam>/gi, '');
  const first = text((clean.match(/<span[^>]*>([\s\S]*?)<\/span>/) || [])[1] || '');
  const surnames = text(clean.replace(/<span[\s\S]*?<\/span>/gi, ''));
  return `${first} ${surnames}`.replace(/\s+/g, ' ').trim();
}

/**
 * Acta: jugadors (amb id) i cos tècnic (rol E1/E2/D…) de cada equip.
 * La primera taula de jugadors és del local i la segona del visitant.
 */
function parseActa(html) {
  const sides = [];
  for (const table of String(html).match(/<table[\s\S]*?<\/table>/gi) || []) {
    if (!/player_season_stats/.test(table)) continue;
    const players = [...table.matchAll(/<div[^>]*player_season_stats[^>]*id_player="(\d+)"[^>]*>([\s\S]*?)<\/div>/gi)]
      .map((m) => ({ id: m[1], name: personName(m[2]) }))
      .filter((p) => p.id !== '0' && p.name);
    const staff = [];
    const at = table.search(/CUERPO T.CNICO|COS T.CNIC|STAFF/i);
    const staffPart = at >= 0 ? table.slice(at) : '';
    for (const row of staffPart.match(/<tr[\s\S]*?<\/tr>/gi) || []) {
      const badge = text((row.match(/<div[^>]*border-radius[^>]*>([\s\S]*?)<\/div>/) || [])[1] || '');
      const nameCell = (row.match(/<td[^>]*colspan="7"[^>]*>([\s\S]*?)<\/td>/) || [])[1];
      if (badge && nameCell) staff.push({ code: badge, role: /^E/i.test(badge) ? 'entrena' : 'ajuda', name: personName(nameCell) });
    }
    sides.push({ players, staff });
  }
  return { home: sides[0] || { players: [], staff: [] }, away: sides[1] || { players: [], staff: [] } };
}

function createClient({ fetchImpl = globalThis.fetch, timeoutMs = 30000 } = {}) {
  async function request(source, path, body) {
    const s = SOURCES[source];
    const headers = { 'User-Agent': UA, Referer: s.portal, Origin: new URL(s.portal).origin, 'X-Requested-With': 'XMLHttpRequest' };
    if (body) headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
    let lastErr;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetchImpl(`${s.base}/${path}`, {
          method: body ? 'POST' : 'GET', headers, body: body ? new URLSearchParams(body).toString() : undefined,
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.text();
      } catch (err) { lastErr = err; }
    }
    throw new Error(`${source} ${path}: ${lastErr.message}`);
  }

  return {
    async competitions(source) {
      return parseCompetitionList(await request(source, `${SOURCES[source].prefix}_ls_1.php`));
    },
    async calendar(source, id) {
      return parseCalendar(await request(source, `${SOURCES[source].prefix}_cal_idc_${id}_1.php`, { idc: id, site_lang: SOURCES[source].lang }));
    },
    async acta(source, idp, idc) {
      return parseActa(await request(source, `${SOURCES[source].prefix}_gr_${idp}_1.php`, { idm: '1', idc, idp, tab: 'tab_ficha_resumen' }));
    },
  };
}

module.exports = { SOURCES, parseCompetitionList, activeSeason, parseCalendar, parseActa, personName, createClient };
