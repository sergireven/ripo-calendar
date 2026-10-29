'use strict';

const E = require('../engine');
const { analyze, clubTeams, loadModel, peopleWithTeams, getConfig, todayKey } = require('../data');
const { requireCoordinator } = require('../auth');

/** Severitat més greu per esdeveniment (bloqueig > avís). */
function severityMap(conflicts) {
  const sev = new Map();
  for (const c of conflicts) for (const k of [c.a.key, c.b.key]) if (c.severity === 'block' || !sev.has(k)) sev.set(k, c.severity);
  return sev;
}

/** Esdeveniments d'una persona (equips + assignacions). */
function personEvents(model, events, personId) {
  const c = model.commitments.get(personId);
  if (!c) return [];
  const out = events.filter((e) => c.teams.has(e.teamId));
  for (const matchId of c.matches.keys()) {
    if (out.some((e) => e.matchId === matchId)) continue;
    const ev = events.find((e) => e.matchId === matchId && e.own) || events.find((e) => e.matchId === matchId);
    if (ev) out.push(ev);
  }
  return out.sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
}

function backTo(req, fallback) {
  const b = String(req.body?.back || '');
  return b.startsWith('/') && !b.startsWith('//') ? b : fallback;
}

module.exports = (app, { db }) => {
  app.get('/', (req, res) => {
    const people = db.prepare('SELECT id, name FROM people WHERE active = 1 ORDER BY name').all();
    res.render('calendar', {
      title: 'Calendari', teams: clubTeams(db), people,
      team: req.query.equip || '', person: req.query.persona || (req.query.meva && req.user.person_id) || '',
    });
  });

  app.get('/api/events', (req, res) => {
    const start = E.dayKeyOf(String(req.query.start || '').slice(0, 10)) || todayKey();
    const end = E.dayKeyOf(String(req.query.end || '').slice(0, 10)) || E.addDays(start, 42);
    const model = loadModel(db);
    let events = model.events.filter((e) => e.dayKey >= start && e.dayKey < end);
    if (req.query.propostes !== '0') {
      const proposals = db.prepare("SELECT * FROM proposals WHERE status IN ('pendent', 'acceptada')").all();
      events = E.applyProposals(events, proposals);
    }
    const sev = severityMap(E.detectConflicts(events, model));
    let shown;
    if (req.query.persona) shown = personEvents(model, events, Number(req.query.persona));
    else if (req.query.equip) shown = events.filter((e) => e.teamId === Number(req.query.equip));
    else shown = events.filter((e) => e.own);
    const seen = new Set();
    const out = [];
    for (const ev of shown) {
      if (seen.has(ev.matchId)) continue;
      seen.add(ev.matchId);
      const s = sev.get(ev.key) || events.filter((x) => x.matchId === ev.matchId).map((x) => sev.get(x.key)).find(Boolean);
      const where = ev.isHome ? 'vs' : '@';
      const cls = [ev.isHome ? 'ev-casa' : 'ev-fora', s ? `ev-${s}` : '', ev.proposalId ? 'ev-proposta' : '', ev.own ? '' : 'ev-extern'].filter(Boolean);
      out.push({
        id: String(ev.matchId),
        title: `${ev.derby ? 'Derbi ' : ''}${ev.label} ${where} ${E.titleCase(ev.opponent)}${ev.proposalId ? ' (proposta)' : ''}`,
        start: ev.time ? `${ev.dayKey}T${ev.time}` : ev.dayKey,
        end: ev.time ? `${ev.dayKey}T${E.minutesToClock(E.clockToMinutes(ev.time) + model.cfg.busyMinutes)}` : undefined,
        allDay: !ev.time,
        url: `/partits/${ev.matchId}`,
        classNames: cls,
      });
    }
    res.json(out);
  });

  app.get('/partits/:id', (req, res, next) => {
    const id = Number(req.params.id);
    const match = db.prepare(`SELECT m.*, c.name AS competition_name, c.source FROM matches m LEFT JOIN competitions c ON c.id = m.competition_id WHERE m.id = ?`).get(id);
    if (!match) return next();
    const model = loadModel(db);
    const events = model.events.filter((e) => e.dayKey === E.dayKeyOf(match.date));
    const conflicts = E.conflictsOfMatch(E.detectConflicts(events, model), id);
    const mine = model.events.filter((e) => e.matchId === id);
    const ownTeamIds = mine.filter((e) => e.own).map((e) => e.teamId);
    const people = peopleWithTeams(db, getConfig(db).minAppearances).filter((p) => p.active);
    const staff = people.filter((p) => p.teams.some((t) => ownTeamIds.includes(t.teamId) && t.role !== 'juga'));
    const players = people.filter((p) => p.teams.some((t) => ownTeamIds.includes(t.teamId) && t.role === 'juga'));
    const teams = db.prepare('SELECT * FROM teams WHERE id IN (?, ?)').all(match.home_team_id, match.away_team_id);
    res.render('match', {
      title: mine[0]?.label || 'Partit', match, mine, conflicts, staff, players,
      rotation: teams.some((t) => t.own && t.rotation),
      porterPool: (players.filter((p) => p.porter).length ? players.filter((p) => p.porter) : players),
      assignments: db.prepare('SELECT a.*, p.name FROM assignments a JOIN people p ON p.id = a.person_id WHERE a.match_id = ? ORDER BY a.type, p.name').all(id),
      allPeople: people,
      changes: db.prepare('SELECT * FROM match_changes WHERE match_id = ? ORDER BY id DESC').all(id),
      proposals: db.prepare('SELECT * FROM proposals WHERE match_id = ? ORDER BY id DESC').all(id),
      comments: db.prepare(`SELECT c.*, u.name AS author FROM comments c LEFT JOIN users u ON u.id = c.user_id WHERE entity_type = 'match' AND entity_id = ? ORDER BY c.id`).all(id),
      rotationCount: (personId) => db.prepare(`SELECT COUNT(*) n FROM assignments a JOIN matches m ON m.id = a.match_id
        WHERE a.person_id = ? AND a.type = 'porter' AND (m.home_team_id IN (SELECT value FROM json_each(?)) OR m.away_team_id IN (SELECT value FROM json_each(?)))`)
        .get(personId, JSON.stringify(ownTeamIds), JSON.stringify(ownTeamIds)).n,
    });
  });

  app.post('/partits/:id/assignacio', requireCoordinator, (req, res) => {
    const type = req.body.type === 'porter' ? 'porter' : 'reforç';
    const personId = Number(req.body.person_id);
    if (type === 'porter') db.prepare("DELETE FROM assignments WHERE match_id = ? AND type = 'porter'").run(req.params.id);
    if (personId) db.prepare('INSERT OR IGNORE INTO assignments (match_id, person_id, type) VALUES (?, ?, ?)').run(req.params.id, personId, type);
    res.redirect(`/partits/${req.params.id}`);
  });

  app.post('/partits/:id/assignacio/:aid/treure', requireCoordinator, (req, res) => {
    db.prepare('DELETE FROM assignments WHERE id = ? AND match_id = ?').run(req.params.aid, req.params.id);
    res.redirect(`/partits/${req.params.id}`);
  });

  /** Partit manual: amistós, torneig o competició que no surt a cap federació. */
  app.post('/partits/nou', requireCoordinator, (req, res) => {
    const date = E.dayKeyOf(req.body.date);
    const time = E.normTime(req.body.time);
    const titleText = String(req.body.title || '').trim();
    if (!date || !time || !titleText) {
      req.flash('error', 'Cal posar títol, data i hora.');
      return res.redirect(backTo(req, '/'));
    }
    const team = req.body.team_id ? db.prepare('SELECT * FROM teams WHERE id = ? AND own = 1').get(req.body.team_id) : null;
    const atHome = req.body.home === '1';
    const place = String(req.body.place || '').trim() || (atHome ? (team?.name || 'CH RIPOLLET') : titleText);
    const r = db.prepare(`INSERT INTO matches (origin, jornada, home_team_id, away_team_id, home_name, away_name, date, time)
      VALUES ('manual', NULL, ?, ?, ?, ?, ?, ?)`).run(
      team && atHome ? team.id : null, team && !atHome ? team.id : null,
      atHome ? (team?.name || 'CH RIPOLLET') : place, atHome ? titleText : (team?.name || titleText), date, time,
    );
    if (req.body.person_id) db.prepare("INSERT INTO assignments (match_id, person_id, type) VALUES (?, ?, 'reforç')").run(r.lastInsertRowid, req.body.person_id);
    req.flash('ok', 'Partit afegit.');
    res.redirect(`/partits/${r.lastInsertRowid}`);
  });

  app.post('/partits/:id/esborrar', requireCoordinator, (req, res) => {
    db.prepare("DELETE FROM matches WHERE id = ? AND origin = 'manual'").run(req.params.id);
    req.flash('ok', 'Partit esborrat.');
    res.redirect('/');
  });

  app.post('/comentaris', (req, res) => {
    const type = ['match', 'person', 'team', 'proposal'].includes(req.body.entity_type) ? req.body.entity_type : null;
    const body = String(req.body.body || '').trim().slice(0, 2000);
    if (type && body) db.prepare('INSERT INTO comments (entity_type, entity_id, user_id, body) VALUES (?, ?, ?, ?)').run(type, Number(req.body.entity_id), req.user.id, body);
    res.redirect(backTo(req, '/'));
  });

  app.post('/comentaris/:id/esborrar', (req, res) => {
    const c = db.prepare('SELECT * FROM comments WHERE id = ?').get(req.params.id);
    if (c && (c.user_id === req.user.id || req.user.role === 'coordinador')) db.prepare('DELETE FROM comments WHERE id = ?').run(c.id);
    res.redirect(backTo(req, '/'));
  });

  app.get('/conflictes', (req, res) => {
    const { conflicts } = analyze(db, { withProposals: req.query.propostes === '1' });
    const filter = req.query.tipus || 'tots';
    const weeks = [2, 4, 8, 52].includes(Number(req.query.setmanes)) ? Number(req.query.setmanes) : 4;
    const until = E.addDays(todayKey(), weeks * 7);
    const inRange = conflicts.filter((c) => c.a.dayKey < until);
    const list = inRange.filter((c) => filter === 'tots' || c.severity === filter || (filter === 'entrenadors' && c.people.some((p) => p.roles.includes('entrena'))));
    res.render('conflicts', { title: 'Conflictes', list, filter, weeks, total: inRange.length, blocks: inRange.filter((c) => c.severity === 'block').length, season: conflicts.length });
  });
};

module.exports.personEvents = personEvents;
module.exports.severityMap = severityMap;
