/**
 * Motor de conflictes de calendari (codi pur, sense base de dades ni HTTP).
 *
 * Esdeveniment = un partit vist des d'un equip que ens importa (equip del club o equip
 * on hi ha alguna persona del club). Un derbi intern genera dos esdeveniments amb el
 * mateix `matchId`, però compta com un sol partit a la pista.
 *
 * Regles:
 *  - Pista (bloqueig): dos partits a casa amb menys de `slotMinutes` entre inicis,
 *    o un partit a casa dins d'una franja bloquejada.
 *  - Persona (bloqueig si juga/entrena, avís si és ajudant): no pot arribar a dos partits.
 *    Casa→casa: només cal que no es solapin. Si algun és fora: partit + trajecte + arribada.
 *  - Germans (avís): germans que juguen en partits incompatibles (no compta qui entrena).
 *  - Marge molt just (avís): hi ha desplaçament i sobren menys de `tightMarginMinutes`.
 */
'use strict';

const DEFAULT_CONFIG = Object.freeze({
  slotMinutes: 75,
  busyMinutes: 75,
  preMatchMinutes: 30,
  defaultTravelMinutes: 45,
  travelSpeedKmh: 50,
  roadFactor: 1.3,
  parkingMinutes: 10,
  tightMarginMinutes: 15,
  minAppearances: 2,        // actes perquè algú compti com a membre d'un equip (1 = també qui hi ha anat un sol dia)
  gridMinCount: 2,
});

const ROLES = Object.freeze({
  juga: { label: 'Juga', severity: 'block' },
  entrena: { label: 'Entrena', severity: 'block' },
  ajuda: { label: 'Ajudant/delegat', severity: 'warn' },
});

const WEEKDAYS = ['dg', 'dl', 'dt', 'dc', 'dj', 'dv', 'ds'];

// ── Dates (hora de paret, sense zona: només per comparar) ─────────────
const pad = (n) => String(n).padStart(2, '0');

function parseDate(date) {
  const s = String(date || '').trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return { y: +m[1], mo: +m[2], d: +m[3] };
  m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (m) return { y: +m[3], mo: +m[2], d: +m[1] };
  return null;
}

function parseTime(time) {
  const m = String(time || '').trim().match(/^(\d{1,2})[:.h,](\d{2})/);
  if (!m || +m[1] > 23 || +m[2] > 59) return null;
  return { h: +m[1], mi: +m[2] };
}

function dayKeyOf(date) {
  const p = parseDate(date);
  return p ? `${p.y}-${pad(p.mo)}-${pad(p.d)}` : '';
}

function normTime(time) {
  const t = parseTime(time);
  return t ? `${pad(t.h)}:${pad(t.mi)}` : '';
}

function toMinutes(date, time) {
  const p = parseDate(date);
  const t = parseTime(time);
  if (!p || !t) return null;
  return Math.round(Date.UTC(p.y, p.mo - 1, p.d, t.h, t.mi) / 60000);
}

function clockToMinutes(time) {
  const t = parseTime(time);
  return t ? t.h * 60 + t.mi : null;
}

function minutesToClock(mins) {
  const m = ((mins % 1440) + 1440) % 1440;
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}

function weekdayOf(dayKey) {
  const p = parseDate(dayKey);
  return p ? WEEKDAYS[new Date(Date.UTC(p.y, p.mo - 1, p.d)).getUTCDay()] : '';
}

function addDays(dayKey, n) {
  const p = parseDate(dayKey);
  if (!p) return '';
  const d = new Date(Date.UTC(p.y, p.mo - 1, p.d) + n * 86400000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** Dissabte i diumenge del cap de setmana d'un dia. */
function weekendDays(dayKey) {
  const idx = WEEKDAYS.indexOf(weekdayOf(dayKey));
  if (idx < 0) return [];
  const sat = addDays(dayKey, idx === 0 ? -1 : 6 - idx);
  return [sat, addDays(sat, 1)];
}

// ── Noms ──────────────────────────────────────────────────────────────
function norm(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function stripTeamSuffix(s) {
  let out = norm(s);
  while (/ [a-h]$/.test(out)) out = out.slice(0, -2);
  return out;
}

const nameTokens = (name) => norm(name).split(' ').filter((t) => t.length > 1);

/** Dos cognoms finals → clau de família. */
function familyKey(name) {
  const t = nameTokens(name);
  return t.length >= 3 ? t.slice(-2).join(' ') : '';
}

/** "Hugo Lachica" encaixa amb "HUGO LACHICA BOSCH": tots els mots del curt dins del llarg. */
function nameMatches(shortName, longName) {
  const a = nameTokens(shortName);
  const b = new Set(nameTokens(longName));
  return a.length >= 2 && a.every((t) => b.has(t));
}

// ── Pistes i desplaçaments ────────────────────────────────────────────
function haversineKm(a, b) {
  const R = Math.PI / 180;
  const dLat = (b.lat - a.lat) * R;
  const dLng = (b.lng - a.lng) * R;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * R) * Math.cos(b.lat * R) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

const VENUE_STOPWORDS = new Set(['club', 'pati', 'hoquei', 'hockey', 'esports', 'esportiva', 'esportiu', 'futbol',
  'union', 'unio', 'sant', 'santa', 'cpi', 'chp', 'ceh', 'ueh', 'cch', 'the']);

/** Nom d'equip local → coordenades de la seva pista (venues.json: nom d'equip → {lat,lng}). */
function makeVenueResolver(venues) {
  const entries = Object.entries(venues || {}).map(([name, v]) => {
    const lat = Number(v?.lat ?? v?.coordinates?.lat);
    const lng = Number(v?.lng ?? v?.coordinates?.lng);
    return Number.isFinite(lat) && Number.isFinite(lng)
      ? { name, n: norm(name), base: stripTeamSuffix(name), lat, lng, exact: Boolean(v.exact), source: v.source || 'llista', checked: Boolean(v.checked) }
      : null;
  }).filter(Boolean);
  const byNorm = new Map();
  for (const e of entries) if (!byNorm.has(e.n) || e.source === 'manual') byNorm.set(e.n, e);
  const fuzzy = entries.filter((e) => !e.exact);           // els pavellons només per nom exacte
  const byBase = new Map();
  for (const e of fuzzy) if (!byBase.has(e.base)) byBase.set(e.base, e);
  const cache = new Map();
  const tokens = (s) => new Set(s.split(' ').filter((t) => t.length > 2 && !VENUE_STOPWORDS.has(t)));

  return function resolve(teamName) {
    const n = norm(teamName);
    if (!n) return null;
    if (cache.has(n)) return cache.get(n);
    const base = stripTeamSuffix(teamName);
    let hit = byNorm.get(n) || byBase.get(base) || null;
    if (!hit && base) hit = fuzzy.find((e) => e.base && (e.base.startsWith(`${base} `) || base.startsWith(`${e.base} `))) || null;
    if (!hit && base) {
      const tq = tokens(base);
      let best = null;
      let bestScore = 0;
      for (const e of fuzzy) {
        const te = tokens(e.base);
        if (!te.size || !tq.size) continue;
        let inter = 0;
        for (const t of tq) if (te.has(t)) inter++;
        const score = inter / Math.max(tq.size, te.size);
        if (score > bestScore) { bestScore = score; best = e; }
      }
      if (bestScore >= 0.6) hit = best;
    }
    const res = hit ? { lat: hit.lat, lng: hit.lng, name: hit.name, source: hit.source, checked: hit.checked, guessed: hit.n !== n } : null;
    cache.set(n, res);
    return res;
  };
}

function sameVenue(a, b, resolve) {
  if (a.isHome && b.isHome) return true;
  if (a.venue && norm(a.venue) === norm(b.venue)) return true;
  const ca = resolve(a.venue);
  const cb = resolve(b.venue);
  return Boolean(ca && cb && haversineKm(ca, cb) < 0.3);
}

/** Minuts de trajecte entre dues pistes. `cfg.travelOverrides` = minuts reals des de casa. */
function travelBetween(a, b, resolve, cfg) {
  const ov = cfg.travelOverrides || {};
  const oa = a.isHome ? 0 : ov[stripTeamSuffix(a.venue)];
  const ob = b.isHome ? 0 : ov[stripTeamSuffix(b.venue)];
  if ((a.isHome || b.isHome) && Number.isFinite(oa) && Number.isFinite(ob)) {
    return { minutes: Math.max(oa, ob), km: null, estimated: false, manual: true };
  }
  const ca = a.isHome && cfg.homeCoords ? cfg.homeCoords : resolve(a.venue);
  const cb = b.isHome && cfg.homeCoords ? cfg.homeCoords : resolve(b.venue);
  if (!ca || !cb) return { minutes: cfg.defaultTravelMinutes, km: null, estimated: true };
  const km = haversineKm(ca, cb) * cfg.roadFactor;
  return { minutes: Math.round((km / cfg.travelSpeedKmh) * 60 + cfg.parkingMinutes), km: Math.round(km), estimated: false };
}

function checkTiming(a, b, resolve, cfg) {
  const [first, second] = a.start <= b.start ? [a, b] : [b, a];
  const gap = second.start - first.start;
  const same = sameVenue(first, second, resolve);
  const travel = same ? { minutes: 0, km: 0, estimated: false } : travelBetween(first, second, resolve, cfg);
  const needed = same ? cfg.busyMinutes : cfg.busyMinutes + travel.minutes + cfg.preMatchMinutes;
  return { first, second, gap, needed, margin: gap - needed, same, travel, ok: gap >= needed };
}

function describeTiming(t, cfg) {
  if (t.same) {
    if (t.gap < cfg.busyMinutes) return t.gap === 0 ? 'Mateixa hora' : `Es solapen (${t.gap} min entre inicis, calen ${cfg.busyMinutes})`;
    return `Molt just: ${t.margin} min de marge a la mateixa pista`;
  }
  const tr = `${t.travel.minutes} min de trajecte${t.travel.estimated ? ' (estimat)' : t.travel.km != null ? ` (~${t.travel.km} km)` : ''}`;
  if (!t.ok) return `No dona temps: ${t.gap} min entre inicis, calen ${t.needed} (partit ${cfg.busyMinutes} + ${tr} + ${cfg.preMatchMinutes} d'arribada)`;
  return `Molt just: ${t.margin} min de marge amb ${tr}`;
}

// ── Etiquetes ─────────────────────────────────────────────────────────
const CATEGORIES = [
  [/prebenj|pb.?inici|prebe/, 'Prebenjamí'], [/benjam/, 'Benjamí'], [/alev/, 'Aleví'], [/infantil/, 'Infantil'],
  [/juvenil/, 'Juvenil'], [/junior/, 'Júnior'], [/nacional/, 'Nacional Catalana'], [/primera|\b1a? cat/, '1a Catalana'],
  [/segona|\b2a? cat/, '2a Catalana'], [/tercera|\b3a? cat/, '3a Catalana'], [/fem/, 'Femení'], [/veteran|\blcv\b/, 'Veterans'],
  [/ok liga/, 'OK Liga'],
];

function categoryOf(compName) {
  const n = norm(compName);
  for (const [re, label] of CATEGORIES) if (re.test(n)) return label;
  return 'Altres';
}

/** "Benjamí B", "Prebenjamí Iniciació"… o el nom curt que hagi posat el coordinador. */
function teamLabel(team, compName) {
  if (!team) return '';
  if (team.short_name) return team.short_name;
  if (!team.own) return `${titleCase(team.name)}${compName ? ` (${compName.replace(/\s*\(\d{4}-\d{2}\)\s*$/, '')})` : ''}`;
  const letter = (String(team.name).match(/\s([A-H])$/) || [])[1];
  const level = /inici/i.test(norm(compName)) ? ' Iniciació' : '';
  return `${categoryOf(compName)}${letter ? ` ${letter}` : ''}${level}`;
}

function titleCase(s) {
  return String(s || '').toLowerCase().replace(/(^|[\s'(-])\S/g, (c) => c.toUpperCase()).trim();
}

// ── Model ─────────────────────────────────────────────────────────────
/**
 * @param {object} o
 *  - matches: [{id, competition_id, competition_name, jornada, home_team_id, away_team_id, home_name, away_name, date, time, played, status, origin}]
 *  - teams: [{id, name, short_name, own, competition_name}]
 *  - people: [{id, name, family, porter, active, teams: [{teamId, role}]}]
 *  - assignments: [{match_id, person_id, type}]
 *  - blocks: [{id, date, time_from, time_to, reason}]
 *  - config, venues, grid (opcional, sinó es dedueix)
 */
function buildModel(o) {
  const cfg = { ...DEFAULT_CONFIG, ...(o.config || {}) };
  cfg.travelOverrides = { ...(o.config?.travelOverrides || {}) };
  const teamsById = new Map((o.teams || []).map((t) => [t.id, t]));
  const people = (o.people || []).filter((p) => p.active !== 0).map((p) => ({
    ...p,
    teams: (p.teams || []).filter((t) => ROLES[t.role]),
    familyKey: p.family ? `f:${norm(p.family)}` : familyKey(p.name) ? `s:${familyKey(p.name)}` : '',
  }));
  const peopleById = new Map(people.map((p) => [p.id, p]));
  const assignments = o.assignments || [];

  const relevant = new Set((o.teams || []).filter((t) => t.own).map((t) => t.id));
  for (const p of people) for (const t of p.teams) relevant.add(t.teamId);
  const assignedMatches = new Set(assignments.map((a) => a.match_id));

  const events = [];
  for (const m of o.matches || []) {
    if (m.status === 'eliminat') continue;
    const sides = [];
    for (const side of ['home', 'away']) {
      const teamId = m[`${side}_team_id`];
      if (teamId && relevant.has(teamId)) sides.push([side, teamId]);
    }
    if (!sides.length && assignedMatches.has(m.id)) sides.push(['home', null]);
    for (const [side, teamId] of sides) events.push(makeEvent(m, side, teamId, teamsById, sides.length > 1));
  }
  events.sort((a, b) => (a.start ?? Infinity) - (b.start ?? Infinity));

  const resolve = makeVenueResolver(o.venues || {});
  if (!cfg.homeCoords) {
    const home = events.find((e) => e.isHome);
    const c = home ? resolve(home.venue) : null;
    if (c) cfg.homeCoords = { lat: c.lat, lng: c.lng };
  }

  // Compromisos de cada persona: equips (amb rol) i partits concrets (assignacions).
  const commitments = new Map();
  for (const p of people) {
    commitments.set(p.id, {
      teams: new Map(p.teams.map((t) => [t.teamId, t.role])),
      matches: new Map(assignments.filter((a) => a.person_id === p.id).map((a) => [a.match_id, 'juga'])),
    });
  }

  const families = new Map();
  for (const p of people) {
    if (!p.familyKey || (cfg.disabledFamilies || []).includes(p.familyKey)) continue;
    if (!families.has(p.familyKey)) families.set(p.familyKey, []);
    families.get(p.familyKey).push(p);
  }

  const blocks = (o.blocks || []).map((b) => ({ ...b, dayKey: dayKeyOf(b.date) }));
  return {
    cfg, events, teamsById, people, peopleById, commitments, resolve, blocks,
    families: [...families.entries()].filter(([, m]) => m.length > 1).map(([key, members]) => ({ key, label: key.slice(2), manual: key.startsWith('f:'), members })),
    grid: o.grid || deriveGrid(events, cfg.gridMinCount, cfg.slotMinutes),
  };
}

function makeEvent(m, side, teamId, teamsById, derby) {
  const team = teamId ? teamsById.get(teamId) : null;
  const home = m.home_team_id ? teamsById.get(m.home_team_id) : null;
  const date = dayKeyOf(m.date);
  return {
    key: `${m.id}:${teamId || 0}`,
    matchId: m.id,
    competitionId: m.competition_id,
    compName: m.competition_name || '',
    jornada: m.jornada,
    teamId,
    team: team ? team.name : m.home_name,
    label: team ? teamLabel(team, m.competition_name) : titleCase(`${m.home_name}${m.away_name ? ` – ${m.away_name}` : ''}`),
    own: Boolean(team?.own),
    isHome: Boolean(home?.own),                 // es juga a la pista del club
    side,
    homeName: m.home_name,
    awayName: m.away_name,
    opponent: side === 'home' ? m.away_name : m.home_name,
    venue: m.venue || home?.venue || m.home_name,   // pavelló de l'acta, el que sol fer servir el local, o el seu nom
    date,
    time: normTime(m.time),
    dayKey: date,
    start: toMinutes(date, m.time),
    played: Boolean(m.played),
    manual: m.origin === 'manual',
    derby,
  };
}

// ── Detecció ──────────────────────────────────────────────────────────
const conflictId = (type, a, b) => `${type}|${[a.key, b.key].sort().join('||')}`;
const severityOf = (ra, rb) => (ROLES[ra]?.severity === 'block' && ROLES[rb]?.severity === 'block' ? 'block' : 'warn');

function blockFor(blocks, dayKey, startMin, slotMinutes) {
  if (startMin == null) return null;
  for (const b of blocks || []) {
    if (b.dayKey !== dayKey) continue;
    const from = clockToMinutes(b.time_from);
    const to = clockToMinutes(b.time_to);
    if (from != null && to != null && startMin < to && startMin + slotMinutes > from) return b;
  }
  return null;
}

/** Esdeveniments als quals està compromesa una persona (amb el rol). */
function eventsOfPerson(c, byTeam, byMatch) {
  const out = new Map();
  for (const [teamId, role] of c.teams) for (const ev of byTeam.get(teamId) || []) out.set(ev.key, { ev, role });
  for (const [matchId, role] of c.matches) {
    const evs = byMatch.get(matchId) || [];
    const ev = evs.find((e) => e.own) || evs[0];
    if (ev && ![...out.values()].some((x) => x.ev.matchId === matchId)) out.set(ev.key, { ev, role });
  }
  return [...out.values()];
}

function detectConflicts(events, model) {
  const { cfg, resolve } = model;
  const byDay = new Map();
  const byTeam = new Map();
  const byMatch = new Map();
  for (const ev of events) {
    if (ev.start == null) continue;
    if (!byDay.has(ev.dayKey)) byDay.set(ev.dayKey, []);
    byDay.get(ev.dayKey).push(ev);
    if (ev.teamId) {
      if (!byTeam.has(ev.teamId)) byTeam.set(ev.teamId, []);
      byTeam.get(ev.teamId).push(ev);
    }
    if (!byMatch.has(ev.matchId)) byMatch.set(ev.matchId, []);
    byMatch.get(ev.matchId).push(ev);
  }

  const found = new Map();
  const push = (c) => {
    const prev = found.get(c.id);
    if (!prev) { found.set(c.id, c); return; }
    if (c.severity === 'block') prev.severity = 'block';
    for (const p of c.people) if (!prev.people.some((x) => x.id === p.id)) prev.people.push(p);
  };

  // 1) Pista
  for (const list of byDay.values()) {
    const home = list.filter((e) => e.isHome).filter((e, i, arr) => arr.findIndex((x) => x.matchId === e.matchId) === i);
    for (let i = 0; i < home.length; i++) {
      for (let j = i + 1; j < home.length; j++) {
        const [f, s] = home[i].start <= home[j].start ? [home[i], home[j]] : [home[j], home[i]];
        const gap = s.start - f.start;
        if (gap >= cfg.slotMinutes) continue;
        push({ id: conflictId('pista', f, s), type: 'pista', severity: 'block', a: f, b: s, people: [],
          message: gap === 0 ? 'Dos partits a la pista a la mateixa hora' : `Pista ocupada: només ${gap} min entre inicis (calen ${cfg.slotMinutes})` });
      }
    }
    for (const ev of home) {
      const bl = blockFor(model.blocks, ev.dayKey, clockToMinutes(ev.time), cfg.slotMinutes);
      if (bl) push({ id: `bloqueig|${ev.key}|${bl.id}`, type: 'pista-bloquejada', severity: 'block', a: ev, b: ev, people: [],
        message: `Pista no disponible ${bl.time_from}–${bl.time_to}${bl.reason ? `: ${bl.reason}` : ''}` });
    }
  }

  // 2) Persones
  const mineById = new Map();
  for (const person of model.people) {
    const mine = eventsOfPerson(model.commitments.get(person.id), byTeam, byMatch);
    mineById.set(person.id, mine);
    const days = new Map();
    for (const x of mine) {
      if (!days.has(x.ev.dayKey)) days.set(x.ev.dayKey, []);
      days.get(x.ev.dayKey).push(x);
    }
    for (const list of days.values()) {
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const A = list[i];
          const B = list[j];
          if (A.ev.matchId === B.ev.matchId) continue;
          const t = checkTiming(A.ev, B.ev, resolve, cfg);
          if (t.ok && (t.same || t.margin >= cfg.tightMarginMinutes)) continue;
          const [rf, rs] = t.first === A.ev ? [A.role, B.role] : [B.role, A.role];
          const severity = t.ok ? 'warn' : severityOf(rf, rs);
          push({ id: conflictId('persona', t.first, t.second), type: 'persona', severity, a: t.first, b: t.second,
            travel: t.travel, gap: t.gap, needed: t.needed, people: [{ id: person.id, name: person.name, roles: [rf, rs], severity }],
            message: describeTiming(t, cfg) });
        }
      }
    }
  }

  // 3) Germans (avís), si no hi ha ja un conflicte de persona per al mateix parell
  for (const fam of model.families) {
    for (let i = 0; i < fam.members.length; i++) {
      for (let j = i + 1; j < fam.members.length; j++) {
        const p1 = fam.members[i];
        const p2 = fam.members[j];
        // Només com a jugadors: l'avís és per a les famílies que porten els nens a dos llocs.
        const playing = (id) => (mineById.get(id) || []).filter((x) => x.role === 'juga');
        for (const { ev: a } of playing(p1.id)) {
          for (const { ev: b } of playing(p2.id)) {
            if (a.dayKey !== b.dayKey || a.matchId === b.matchId) continue;
            if (found.has(conflictId('persona', a, b)) || found.has(conflictId('persona', b, a))) continue;
            const t = checkTiming(a, b, resolve, cfg);
            if (t.ok) continue;
            push({ id: conflictId('germans', t.first, t.second), type: 'germans', severity: 'warn', a: t.first, b: t.second,
              travel: t.travel, family: fam.label,
              people: [{ id: p1.id, name: p1.name, roles: [] }, { id: p2.id, name: p2.name, roles: [] }],
              message: describeTiming(t, cfg) });
          }
        }
      }
    }
  }

  const rank = { block: 0, warn: 1 };
  return [...found.values()].sort((x, y) => (x.a.start - y.a.start) || (rank[x.severity] - rank[y.severity]));
}

const conflictsOfMatch = (conflicts, matchId) => conflicts.filter((c) => c.a.matchId === matchId || c.b.matchId === matchId);

// ── Parrilla del pavelló ──────────────────────────────────────────────
/** Hores habituals per dia de la setmana: les més repetides, sense trepitjar-se. */
function deriveGrid(events, minCount = 2, slotMinutes = DEFAULT_CONFIG.slotMinutes) {
  const count = new Map();
  const seen = new Set();
  for (const ev of events) {
    if (!ev.isHome || !ev.time || seen.has(ev.matchId)) continue;
    seen.add(ev.matchId);
    const k = `${weekdayOf(ev.dayKey)}|${ev.time}`;
    count.set(k, (count.get(k) || 0) + 1);
  }
  const byDay = {};
  for (const [k, n] of count) {
    if (n < minCount) continue;
    const [wd, t] = k.split('|');
    (byDay[wd] = byDay[wd] || []).push({ t, n, m: clockToMinutes(t) });
  }
  const grid = {};
  for (const [wd, list] of Object.entries(byDay)) {
    list.sort((a, b) => (b.n - a.n) || (a.m - b.m));
    const chosen = [];
    for (const x of list) if (chosen.every((c) => Math.abs(c.m - x.m) >= slotMinutes)) chosen.push(x);
    grid[wd] = chosen.map((c) => c.t).sort();
  }
  return grid;
}

/** Un dia a la pista: franges (lliure, ocupada, solapament, trepitjada, bloquejada) i partits fora de franja. */
function pistaDay(events, model, dayKey) {
  const { cfg } = model;
  const home = events.filter((e) => e.isHome && e.dayKey === dayKey && e.start != null)
    .filter((e, i, arr) => arr.findIndex((x) => x.matchId === e.matchId) === i)
    .sort((a, b) => a.start - b.start);
  const times = model.grid?.[weekdayOf(dayKey)] || [];
  const slots = times.map((time) => {
    const s = clockToMinutes(time);
    const exact = home.filter((e) => clockToMinutes(e.time) === s);
    const overlapping = home.filter((e) => {
      const m = clockToMinutes(e.time);
      return m !== s && Math.abs(m - s) < cfg.slotMinutes && !times.includes(e.time);
    });
    const block = blockFor(model.blocks, dayKey, s, cfg.slotMinutes);
    const status = exact.length > 1 || (exact.length && overlapping.length) ? 'solapament'
      : exact.length ? 'ocupada' : overlapping.length ? 'trepitjada' : block ? 'bloquejada' : 'lliure';
    return { time, status, events: status === 'solapament' ? exact.concat(overlapping) : exact, overlapping, block };
  });
  return {
    dayKey, slots, homeCount: home.length,
    offGrid: home.filter((e) => !times.includes(e.time)),
    blocks: model.blocks.filter((b) => b.dayKey === dayKey),
    free: slots.filter((s) => s.status === 'lliure').length,
  };
}

// ── Propostes i simulació ─────────────────────────────────────────────
function moveEvent(ev, newDate, newTime) {
  const date = dayKeyOf(newDate);
  return { ...ev, date, dayKey: date, time: normTime(newTime), start: toMinutes(date, newTime), original: ev.original || { date: ev.date, time: ev.time } };
}

/** Superposa les propostes pendents o acceptades (encara no oficials) sobre el calendari. */
function applyProposals(events, proposals) {
  const map = new Map();
  for (const p of proposals || []) if (p.status === 'pendent' || p.status === 'acceptada') map.set(p.match_id, p);
  return events.map((ev) => {
    const p = map.get(ev.matchId);
    return p ? { ...moveEvent(ev, p.new_date, p.new_time), proposalId: p.id, proposalStatus: p.status } : ev;
  });
}

function simulateChange(events, model, matchId, newDate, newTime) {
  const target = events.find((e) => e.matchId === matchId);
  if (!target) return null;
  const moved = moveEvent(target, newDate, newTime);
  const next = events.map((e) => (e.matchId === matchId ? moveEvent(e, newDate, newTime) : e));
  const days = new Set([target.dayKey, moved.dayKey]);
  const before = conflictsOfMatch(detectConflicts(events.filter((e) => days.has(e.dayKey)), model), matchId);
  const after = conflictsOfMatch(detectConflicts(next.filter((e) => days.has(e.dayKey)), model), matchId);
  const beforeIds = new Set(before.map((c) => c.id));
  const afterIds = new Set(after.map((c) => c.id));
  const gridTimes = model.grid?.[weekdayOf(moved.dayKey)] || [];
  const affected = new Map();
  for (const c of after) for (const p of c.people) affected.set(p.id, p.name);
  return {
    event: target, moved, before, after,
    introduced: after.filter((c) => !beforeIds.has(c.id)),
    resolved: before.filter((c) => !afterIds.has(c.id)),
    blocks: after.filter((c) => c.severity === 'block').length,
    warns: after.filter((c) => c.severity === 'warn').length,
    inGrid: target.isHome ? gridTimes.includes(moved.time) : null,
    gridTimes,
    pista: target.isHome ? pistaDay(next, model, moved.dayKey) : null,
    affected: [...affected.values()],
  };
}

/** Hores alternatives sense bloquejos: primer la parrilla (si és a casa) i després les més properes. */
function suggestSlots(events, model, matchId, opts = {}) {
  const target = events.find((e) => e.matchId === matchId);
  if (!target) return { grid: [], other: [] };
  const days = opts.dayKeys?.length ? opts.dayKeys : weekendDays(target.dayKey);
  const from = clockToMinutes(opts.from || '09:00');
  const to = clockToMinutes(opts.to || '20:30');
  const step = opts.stepMinutes || 15;
  const grid = [];
  const other = [];
  for (const day of days) {
    const gridTimes = target.isHome ? (model.grid?.[weekdayOf(day)] || []) : [];
    const candidates = new Set(gridTimes);
    for (let m = from; m <= to; m += step) candidates.add(minutesToClock(m));
    for (const time of candidates) {
      if (day === target.dayKey && time === target.time) continue;
      const sim = simulateChange(events, model, matchId, day, time);
      if (!sim || sim.blocks > 0) continue;
      const slot = { dayKey: day, time, warns: sim.warns, distance: Math.abs(sim.moved.start - target.start) };
      (gridTimes.includes(time) ? grid : other).push(slot);
    }
  }
  const byDistance = (a, b) => (a.warns - b.warns) || (a.distance - b.distance);
  return { grid: grid.sort(byDistance), other: other.sort(byDistance).slice(0, opts.limit || 10) };
}

module.exports = {
  DEFAULT_CONFIG, ROLES, WEEKDAYS,
  parseDate, parseTime, dayKeyOf, normTime, toMinutes, clockToMinutes, minutesToClock, weekdayOf, addDays, weekendDays,
  norm, stripTeamSuffix, nameTokens, familyKey, nameMatches, titleCase, categoryOf, teamLabel,
  haversineKm, makeVenueResolver, travelBetween, checkTiming, describeTiming,
  buildModel, detectConflicts, conflictsOfMatch, deriveGrid, pistaDay,
  moveEvent, applyProposals, simulateChange, suggestSlots,
};
