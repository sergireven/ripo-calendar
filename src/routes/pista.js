'use strict';

const E = require('../engine');
const { analyze, loadModel, todayKey } = require('../data');
const { requireCoordinator } = require('../auth');

const ORIGINS = { telefon: 'Telèfon', correu: 'Correu', rival: 'Club rival', federacio: 'Federació', intern: 'Intern' };

/** Calendari de propers partits (amb les altres propostes superposades) per simular un canvi. */
function simulationBase(db, matchId) {
  const { model, upcoming } = analyze(db);
  const others = db.prepare("SELECT * FROM proposals WHERE status IN ('pendent', 'acceptada') AND match_id != ?").all(matchId || 0);
  return { model, events: E.applyProposals(upcoming, others) };
}

function summarize(sim) {
  const pick = (c) => ({ id: c.id, severity: c.severity, type: c.type, message: c.message, a: `${c.a.dayKey} ${c.a.time} ${c.a.label}`,
    b: c.a.matchId === c.b.matchId ? '' : `${c.b.time} ${c.b.label}`, people: c.people.map((p) => p.name) });
  return { blocks: sim.blocks, warns: sim.warns, inGrid: sim.inGrid, conflicts: sim.after.map(pick), resolved: sim.resolved.length, affected: sim.affected };
}

module.exports = (app, { db }) => {
  app.get('/pista', (req, res) => {
    const base = E.dayKeyOf(req.query.dia) || todayKey();
    const [sat, sun] = E.weekendDays(base);
    const model = loadModel(db);
    const proposals = db.prepare("SELECT * FROM proposals WHERE status IN ('pendent', 'acceptada')").all();
    const events = req.query.propostes === '1' ? E.applyProposals(model.events, proposals) : model.events;
    const days = [sat, sun].map((d) => E.pistaDay(events, model, d));
    const today = todayKey();
    const weekends = [];
    for (let i = 0, d = E.weekendDays(today)[0]; i < 12; i++, d = E.addDays(d, 7)) {
      const pd = [E.pistaDay(model.events, model, d), E.pistaDay(model.events, model, E.addDays(d, 1))];
      weekends.push({ sat: d, home: pd[0].homeCount + pd[1].homeCount, free: pd[0].free + pd[1].free, slots: pd[0].slots.length + pd[1].slots.length });
    }
    res.render('pista', {
      title: 'Pista', days, sat, sun, weekends, grid: model.grid, prev: E.addDays(sat, -7), next: E.addDays(sat, 7),
      withProposals: req.query.propostes === '1', slotMinutes: model.cfg.slotMinutes,
    });
  });

  app.post('/pista/bloqueig', requireCoordinator, (req, res) => {
    const date = E.dayKeyOf(req.body.date);
    const from = E.normTime(req.body.from);
    const to = E.normTime(req.body.to);
    if (!date || !from || !to || E.clockToMinutes(to) <= E.clockToMinutes(from)) req.flash('error', 'Revisa la data i les hores.');
    else db.prepare('INSERT INTO pista_blocks (date, time_from, time_to, reason) VALUES (?, ?, ?, ?)').run(date, from, to, String(req.body.reason || '').trim() || null);
    res.redirect(`/pista?dia=${date || ''}`);
  });

  app.post('/pista/bloqueig/:id/treure', requireCoordinator, (req, res) => {
    const b = db.prepare('SELECT * FROM pista_blocks WHERE id = ?').get(req.params.id);
    db.prepare('DELETE FROM pista_blocks WHERE id = ?').run(req.params.id);
    res.redirect(`/pista?dia=${b?.date || ''}`);
  });

  app.get('/simulador', (req, res) => {
    const matchId = Number(req.query.partit) || null;
    const { model, events } = simulationBase(db, matchId);
    const own = events.filter((e) => e.own).filter((e, i, arr) => arr.findIndex((x) => x.matchId === e.matchId) === i);
    const target = matchId ? events.find((e) => e.matchId === matchId) : null;
    const date = E.dayKeyOf(req.query.data) || target?.dayKey || '';
    const time = E.normTime(req.query.hora) || target?.time || '';
    let sim = null;
    let slots = null;
    if (target && req.query.data && req.query.hora) sim = E.simulateChange(events, model, matchId, date, time);
    if (target && req.query.alternatives) {
      const days = E.weekendDays(date || target.dayKey);
      if (date && !days.includes(date)) days.unshift(date);
      slots = E.suggestSlots(events, model, matchId, { dayKeys: days });
    }
    const proposals = db.prepare(`SELECT p.*, u.name AS author FROM proposals p LEFT JOIN users u ON u.id = p.created_by
      WHERE p.status IN ('pendent', 'acceptada') OR p.created_at > datetime('now', '-30 days') ORDER BY p.id DESC`).all()
      .map((p) => ({ ...p, ev: model.events.find((e) => e.matchId === p.match_id && e.own) || model.events.find((e) => e.matchId === p.match_id) }));
    res.render('simulator', { title: 'Simulador', own, target, date, time, sim, slots, proposals, ORIGINS });
  });

  app.post('/propostes', requireCoordinator, (req, res) => {
    const matchId = Number(req.body.match_id);
    const date = E.dayKeyOf(req.body.date);
    const time = E.normTime(req.body.time);
    const { model, events } = simulationBase(db, matchId);
    const sim = date && time ? E.simulateChange(events, model, matchId, date, time) : null;
    if (!sim) { req.flash('error', 'No s\'ha pogut analitzar la proposta.'); return res.redirect('/simulador'); }
    db.prepare("UPDATE proposals SET status = 'rebutjada', decided_at = datetime('now') WHERE match_id = ? AND status = 'pendent'").run(matchId);
    const id = db.prepare('INSERT INTO proposals (match_id, new_date, new_time, origin, contact, impact, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(matchId, date, time, ORIGINS[req.body.origin] ? req.body.origin : 'telefon', String(req.body.contact || '').trim() || null, JSON.stringify(summarize(sim)), req.user.id).lastInsertRowid;
    const note = String(req.body.comment || '').trim();
    if (note) db.prepare("INSERT INTO comments (entity_type, entity_id, user_id, body) VALUES ('proposal', ?, ?, ?)").run(id, req.user.id, note);
    req.flash('ok', 'Proposta desada com a pendent.');
    res.redirect(`/propostes/${id}`);
  });

  app.get('/propostes/:id', (req, res, next) => {
    const p = db.prepare('SELECT p.*, u.name AS author FROM proposals p LEFT JOIN users u ON u.id = p.created_by WHERE p.id = ?').get(req.params.id);
    if (!p) return next();
    const { model, events } = simulationBase(db, p.match_id);
    const target = events.find((e) => e.matchId === p.match_id);
    const sim = target && p.status !== 'oficial' && p.status !== 'rebutjada' ? E.simulateChange(events, model, p.match_id, p.new_date, p.new_time) : null;
    res.render('proposal', {
      title: 'Proposta', p, target, sim, impact: JSON.parse(p.impact || '{}'), ORIGINS,
      comments: db.prepare(`SELECT c.*, u.name AS author FROM comments c LEFT JOIN users u ON u.id = c.user_id WHERE entity_type = 'proposal' AND entity_id = ? ORDER BY c.id`).all(p.id),
    });
  });

  app.post('/propostes/:id/estat', requireCoordinator, (req, res) => {
    const status = { acceptar: 'acceptada', rebutjar: 'rebutjada', reobrir: 'pendent' }[req.body.action];
    if (req.body.action === 'esborrar') {
      db.prepare('DELETE FROM proposals WHERE id = ?').run(req.params.id);
      req.flash('ok', 'Proposta esborrada.');
      return res.redirect('/simulador');
    }
    if (status) db.prepare("UPDATE proposals SET status = ?, decided_at = datetime('now') WHERE id = ?").run(status, req.params.id);
    req.flash('ok', status === 'acceptada' ? 'Acceptada: queda pendent que la federació la publiqui. Quan surti, passarà sola a oficial.' : 'Proposta actualitzada.');
    res.redirect(`/propostes/${req.params.id}`);
  });
};
