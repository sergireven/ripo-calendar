/** Funcions petites per a les vistes (EJS). */
'use strict';

const E = require('./engine');

const DOW = { dl: 'dilluns', dt: 'dimarts', dc: 'dimecres', dj: 'dijous', dv: 'divendres', ds: 'dissabte', dg: 'diumenge' };
const ROLE_LABEL = { juga: 'juga', entrena: 'entrena', ajuda: 'ajudant/delegat', cap: 'no hi és' };
const KIND = { pista: 'Pista', 'pista-bloquejada': 'Pista bloquejada', persona: 'Persones', germans: 'Germans' };

function dayLabel(dayKey, short = false) {
  const p = E.parseDate(dayKey);
  if (!p) return dayKey || 'Sense data';
  const wd = E.weekdayOf(dayKey);
  return short ? `${wd} ${p.d}/${p.mo}` : `${DOW[wd]} ${p.d}/${p.mo}`;
}

const tc = (s) => E.titleCase(s);
const shortName = (s) => tc(String(s || '').split(' ').slice(0, 2).join(' '));

/** "2026-10-29 17:05:00" (UTC de SQLite) → "29/10 18:05" a Madrid. */
function when(sqlDate) {
  if (!sqlDate) return '';
  const d = new Date(`${String(sqlDate).replace(' ', 'T')}Z`);
  return new Intl.DateTimeFormat('ca-ES', { timeZone: 'Europe/Madrid', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' }).format(d);
}

function kindOf(c) {
  if (c.type === 'persona' && c.people.some((p) => p.roles.includes('entrena'))) return 'Entrenador';
  return KIND[c.type] || c.type;
}

const sevIcon = (s) => (s === 'block' ? '⛔' : '⚠️');
const roleText = (roles) => (roles?.length === 2 ? `${ROLE_LABEL[roles[0]]} ↔ ${ROLE_LABEL[roles[1]]}` : '');
const weekendOf = (dayKey) => E.weekendDays(dayKey)[0] || '';
const evText = (ev) => `${ev.time || '--:--'} ${ev.label} ${ev.isHome ? 'vs' : 'a'} ${tc(ev.opponent || '')} (${ev.isHome ? 'casa' : 'fora'})`;

module.exports = {
  DOW, ROLE_LABEL, dayLabel, tc, shortName, when, kindOf, sevIcon, roleText, evText, weekendOf,
  addDays: E.addDays, minutesToClock: E.minutesToClock, clockToMinutes: E.clockToMinutes,
};
