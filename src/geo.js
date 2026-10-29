/** Coordenades a partir del que enganxa el coordinador: un enllaç de Google Maps o «41.53, 2.19». */
'use strict';

const valid = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);

function parseLocation(input) {
  let s = String(input || '').trim();
  try { s = decodeURIComponent(s); } catch { /* es queda com està */ }
  const num = '(-?\\d{1,3}(?:\\.\\d+)?)';
  const patterns = [
    new RegExp(`!3d${num}!4d${num}`),                 // marcador d'un lloc (el més exacte)
    new RegExp(`[?&](?:q|query|ll|destination|center)=${num},\\s*${num}`),
    new RegExp(`@${num},${num}`),                     // centre del mapa
    new RegExp(`^${num}\\s*[,;\\s]\\s*${num}$`),      // «41.53, 2.19»
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (m && valid(Number(m[1]), Number(m[2]))) return { lat: Number(m[1]), lng: Number(m[2]) };
  }
  return null;
}

/** Els enllaços curts (maps.app.goo.gl, goo.gl/maps) redirigeixen a l'enllaç llarg, que sí porta coordenades. */
async function locationFrom(input, fetchImpl = globalThis.fetch) {
  const direct = parseLocation(input);
  if (direct) return direct;
  let url = String(input || '').trim();
  if (!/^https:\/\/(maps\.app\.goo\.gl|goo\.gl\/maps|(www\.)?google\.[a-z.]+\/maps)/i.test(url)) return null;
  for (let i = 0; i < 4; i++) {
    let res;
    try { res = await fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(8000) }); } catch { return null; }
    const next = res.headers.get('location');
    if (!next) {
      const body = await res.text().catch(() => '');
      const m = body.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/) || body.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
      return m ? parseLocation(`${m[1]},${m[2]}`) : null;
    }
    const found = parseLocation(next);
    if (found) return found;
    url = new URL(next, url).toString();
  }
  return null;
}

module.exports = { parseLocation, locationFrom };
