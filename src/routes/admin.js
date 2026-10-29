'use strict';

const E = require('../engine');
const { getSetting, setSetting } = require('../db');
const { loadModel, clubTeams, getConfig } = require('../data');
const { requireCoordinator, upsertUser } = require('../auth');

const RULES = [
  ['slotMinutes', 'Ocupació de pista per partit (min)', 'Entre inicis de dos partits a casa'],
  ['busyMinutes', 'Durada d\'un partit (min)', 'Escalfament + partit'],
  ['preMatchMinutes', 'Arribada abans del 2n partit (min)', 'Només quan hi ha desplaçament'],
  ['defaultTravelMinutes', 'Trajecte si no coneixem la pista (min)', ''],
  ['tightMarginMinutes', 'Avisar si el marge és menor de (min)', ''],
  ['minAppearances', 'Actes mínimes per comptar que algú és d\'un equip', 'Puja-ho si surten massa reforços puntuals'],
];

module.exports = (app, { db, sync }) => {
  app.get('/canvis', (req, res) => {
    const rows = db.prepare(`SELECT mc.*, m.home_name, m.away_name, m.date, m.time, m.home_team_id, m.away_team_id, c.name AS competition_name
      FROM match_changes mc JOIN matches m ON m.id = mc.match_id LEFT JOIN competitions c ON c.id = m.competition_id
      ORDER BY mc.id DESC LIMIT 200`).all();
    const own = new Map(db.prepare('SELECT * FROM teams WHERE own = 1').all().map((t) => [t.id, t]));
    const list = rows.map((r) => ({ ...r, label: E.teamLabel(own.get(r.home_team_id) || own.get(r.away_team_id), r.competition_name) }));
    const runs = db.prepare('SELECT * FROM sync_runs ORDER BY id DESC LIMIT 5').all();
    res.render('changes', { title: 'Canvis', list, runs, syncing: sync.isRunning() });
  });

  app.post('/canvis/vist', (req, res) => {
    db.prepare('UPDATE match_changes SET seen = 1 WHERE seen = 0').run();
    res.redirect('/canvis');
  });

  app.post('/sincronitzar', requireCoordinator, (req, res) => {
    if (!sync.isRunning()) sync.run().catch((err) => console.error('[sync]', err));
    req.flash('ok', 'Sincronització en marxa. Triga un minut: recarrega aquesta pàgina.');
    res.redirect('/canvis');
  });

  app.get('/config', requireCoordinator, (req, res) => {
    const cfg = getConfig(db);
    const model = loadModel(db);
    const derived = E.deriveGrid(model.events, cfg.gridMinCount, cfg.slotMinutes);
    const competitions = db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM teams t WHERE t.competition_id = c.id AND t.own = 1) AS own
      FROM competitions c ORDER BY own DESC, c.source, c.name`).all();
    const people = db.prepare('SELECT id, name FROM people WHERE active = 1 ORDER BY name').all();
    const allFamilies = E.buildModel({ people: model.people.map((p) => ({ ...p, teams: p.teams })), config: { ...cfg, disabledFamilies: [] } }).families;
    res.render('config', {
      title: 'Configuració', cfg, RULES, grid: getSetting(db, 'grid', null), derived, model,
      teams: clubTeams(db), competitions, alertEmails: getSetting(db, 'alert_emails', ''), people, families: allFamilies,
      users: db.prepare('SELECT u.*, p.name AS person_name FROM users u LEFT JOIN people p ON p.id = u.person_id ORDER BY u.role, u.name').all(),
      emails: db.prepare('SELECT * FROM email_log ORDER BY id DESC LIMIT 10').all(),
    });
  });

  app.post('/config/regles', requireCoordinator, (req, res) => {
    const rules = {};
    for (const [key] of RULES) {
      const n = Number(req.body[key]);
      if (Number.isFinite(n) && n >= 0) rules[key] = n;
    }
    setSetting(db, 'rules', rules);
    setSetting(db, 'alert_emails', String(req.body.alert_emails || '').trim());
    req.flash('ok', 'Regles desades.');
    res.redirect('/config#regles');
  });

  app.post('/config/parrilla', requireCoordinator, (req, res) => {
    if (req.body.reset) setSetting(db, 'grid', null);
    else {
      const grid = {};
      for (const wd of E.WEEKDAYS) {
        const times = String(req.body[wd] || '').split(/[,;\s]+/).map(E.normTime).filter(Boolean);
        if (times.length) grid[wd] = [...new Set(times)].sort();
      }
      setSetting(db, 'grid', grid);
    }
    req.flash('ok', 'Parrilla desada.');
    res.redirect('/config#parrilla');
  });

  app.post('/config/equips', requireCoordinator, (req, res) => {
    for (const t of clubTeams(db)) {
      db.prepare('UPDATE teams SET short_name = ?, rotation = ? WHERE id = ?')
        .run(String(req.body[`name_${t.id}`] || '').trim() || null, req.body[`rot_${t.id}`] ? 1 : 0, t.id);
    }
    req.flash('ok', 'Equips desats.');
    res.redirect('/config#equips');
  });

  app.post('/config/competicions', requireCoordinator, (req, res) => {
    const follow = new Set([].concat(req.body.follow || []).map(Number));
    for (const c of db.prepare('SELECT id FROM competitions').all()) db.prepare('UPDATE competitions SET follow = ? WHERE id = ?').run(follow.has(c.id) ? 1 : 0, c.id);
    req.flash('ok', 'Competicions desades. Les desmarcades no es llegiran a la propera sincronització.');
    res.redirect('/config#competicions');
  });

  app.post('/config/families', requireCoordinator, (req, res) => {
    const on = new Set([].concat(req.body.on || []));
    const all = [].concat(req.body.all || []);
    setSetting(db, 'disabled_families', all.filter((k) => !on.has(k)));
    req.flash('ok', 'Germans desats.');
    res.redirect('/config#germans');
  });

  app.post('/config/usuaris', requireCoordinator, (req, res) => {
    const { email, name, role, password } = req.body;
    if (!email || !name || String(password || '').length < 8) {
      req.flash('error', 'Cal correu, nom i una contrasenya d\'almenys 8 caràcters.');
    } else {
      upsertUser(db, { email, name, role: role === 'coordinador' ? 'coordinador' : 'entrenador', password, personId: Number(req.body.person_id) || null });
      req.flash('ok', `Usuari ${email} desat. Envia-li la contrasenya per un canal privat.`);
    }
    res.redirect('/config#usuaris');
  });

  app.post('/config/usuaris/:id/esborrar', requireCoordinator, (req, res) => {
    if (Number(req.params.id) === req.user.id) req.flash('error', 'No et pots esborrar a tu mateix.');
    else db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
    res.redirect('/config#usuaris');
  });
};
