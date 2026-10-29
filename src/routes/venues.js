'use strict';

const E = require('../engine');
const { loadModel, todayKey } = require('../data');
const { requireCoordinator } = require('../auth');
const { locationFrom } = require('../geo');

const FAR_KM = Number(process.env.FAR_KM || 100);
const anchorOf = (name) => `v-${E.norm(name).replace(/[^a-z0-9]+/g, '-')}`;

/** Pavellons on juguem (o rebem) en els propers partits, amb la ubicació que fa servir el motor. */
function venueList(db) {
  const model = loadModel(db);
  const today = todayKey();
  const saved = new Map(db.prepare('SELECT * FROM venues').all().map((v) => [E.norm(v.name), v]));
  const auto = (venue) => E.travelBetween({ isHome: true, venue: '' }, { isHome: false, venue }, model.resolve, { ...model.cfg, travelOverrides: {} });
  const byKey = new Map();
  for (const ev of model.events) {
    if (ev.dayKey < today || !ev.venue) continue;
    const key = ev.isHome ? 'casa' : E.norm(ev.venue);
    if (!byKey.has(key)) {
      const coords = model.resolve(ev.venue);
      byKey.set(key, {
        name: ev.venue, home: ev.isHome, coords, saved: saved.get(E.norm(ev.venue)) || null,
        pavilionKnown: E.norm(ev.venue) !== E.norm(ev.homeName),
        hosts: new Set(), teams: new Set(), next: ev.dayKey, count: 0,
        auto: ev.isHome ? null : auto(ev.venue),
      });
    }
    const v = byKey.get(key);
    v.hosts.add(E.titleCase(ev.homeName));
    if (ev.own) v.teams.add(ev.label);
    v.count++;
  }
  const list = [...byKey.values()].map((v) => {
    const minutes = v.saved?.minutes ?? v.auto?.minutes ?? 0;
    const flags = [];
    if (!v.coords) flags.push(['sense', 'Sense ubicació']);
    else if (v.coords.guessed && v.coords.source !== 'manual') flags.push(['aprox', 'Aproximada pel nom de l\'equip']);
    if (v.auto?.km != null && v.auto.km > FAR_KM) flags.push(['lluny', `A ${v.auto.km} km: revisa-la`]);
    if (!v.pavilionKnown && !v.home) flags.push(['nom', 'Encara no sabem el pavelló']);
    const checked = Boolean(v.saved?.checked);
    return { ...v, anchor: anchorOf(v.name), hosts: [...v.hosts], teams: [...v.teams], minutes, flags, checked, problem: !checked && flags.some(([k]) => k !== 'nom') };
  });
  list.sort((a, b) => Number(b.home) - Number(a.home) || Number(b.problem) - Number(a.problem) || Number(a.checked) - Number(b.checked) || b.minutes - a.minutes);
  return { list, homeCoords: model.cfg.homeCoords };
}

module.exports = (app, { db }) => {
  app.get('/ubicacions', (req, res) => {
    const { list, homeCoords } = venueList(db);
    res.render('venues', { title: 'Ubicacions', list, homeCoords, farKm: FAR_KM });
  });

  app.post('/ubicacions', requireCoordinator, async (req, res, next) => {
    try {
      const name = String(req.body.name || '').trim();
      if (!name) return res.redirect('/ubicacions');
      const anchor = `#${anchorOf(name)}`;
      if (req.body.reset) {
        db.prepare('DELETE FROM venues WHERE name = ?').run(name);
        req.flash('ok', `${E.titleCase(name)}: tornem a la ubicació automàtica.`);
        return res.redirect(`/ubicacions${anchor}`);
      }
      const prev = db.prepare('SELECT * FROM venues WHERE name = ?').get(name) || {};
      let { lat = null, lng = null } = prev;
      const where = String(req.body.location || '').trim();
      if (where) {
        const loc = await locationFrom(where);
        if (!loc) {
          req.flash('error', 'No he trobat coordenades en el que has enganxat. A Google Maps, fes clic dret sobre el pavelló i clica les coordenades (p. ex. 41.5312, 2.1925): es copien soles.');
          return res.redirect(`/ubicacions${anchor}`);
        }
        ({ lat, lng } = loc);
      }
      const minutesRaw = String(req.body.minutes ?? '').trim();
      const minutes = minutesRaw === '' ? null : Math.max(0, Math.round(Number(minutesRaw)));
      db.prepare(`INSERT INTO venues (name, lat, lng, minutes, checked, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(name) DO UPDATE SET lat = excluded.lat, lng = excluded.lng, minutes = excluded.minutes, checked = excluded.checked, updated_at = excluded.updated_at`)
        .run(name, lat, lng, Number.isFinite(minutes) ? minutes : null, req.body.checked ? 1 : 0);
      req.flash('ok', `${E.titleCase(name)}: desat.`);
      res.redirect(`/ubicacions${anchor}`);
    } catch (err) { next(err); }
  });
};

module.exports.venueList = venueList;
