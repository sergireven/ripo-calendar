'use strict';

const multer = require('multer');
const E = require('../engine');
const { analyze, clubTeams, peopleWithTeams, getConfig } = require('../data');
const { requireCoordinator } = require('../auth');
const { previewImport, applyImport, exportWorkbook } = require('../people-io');
const { personEvents, severityMap } = require('./calendar');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

function teamsById(db) {
  return new Map(db.prepare('SELECT t.*, c.name AS competition_name FROM teams t LEFT JOIN competitions c ON c.id = t.competition_id').all()
    .map((t) => [t.id, { ...t, label: E.teamLabel(t, t.competition_name) }]));
}

module.exports = (app, { db }) => {
  app.get('/persones', (req, res) => {
    const { conflicts } = analyze(db);
    const blocks = new Map();
    for (const c of conflicts) for (const p of c.people) if (c.severity === 'block') blocks.set(p.id, (blocks.get(p.id) || 0) + 1);
    const teams = teamsById(db);
    const q = E.norm(req.query.q || '');
    const filter = req.query.filtre || 'tots';
    const filters = {
      tots: () => true,
      entrenadors: (p) => p.teams.some((t) => t.role !== 'juga'),
      doblen: (p) => p.teams.filter((t) => t.role === 'juga' && teams.get(t.teamId)?.own).length > 1,
      altres: (p) => p.teams.some((t) => !teams.get(t.teamId)?.own),
      bloquejos: (p) => blocks.has(p.id),
      'sense-equip': (p) => !p.teams.length,
    };
    const list = peopleWithTeams(db, getConfig(db).minAppearances)
      .filter((p) => p.active || filter === 'tots')
      .filter(filters[filter] || filters.tots)
      .filter((p) => !q || E.norm(p.name).includes(q) || p.teams.some((t) => E.norm(teams.get(t.teamId)?.label).includes(q)));
    res.render('people', { title: 'Persones', list, teams, blocks, q: req.query.q || '', filter, total: db.prepare('SELECT COUNT(*) n FROM people').get().n });
  });

  app.post('/persones', requireCoordinator, (req, res) => {
    const name = String(req.body.name || '').trim();
    if (!name) { req.flash('error', 'Cal posar un nom.'); return res.redirect('/persones'); }
    const id = db.prepare('INSERT INTO people (name) VALUES (?)').run(name).lastInsertRowid;
    res.redirect(`/persones/${id}`);
  });

  app.get('/persones/exportar.xlsx', requireCoordinator, (req, res) => {
    res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.set('Content-Disposition', 'attachment; filename="persones.xlsx"');
    res.send(exportWorkbook(db));
  });

  app.get('/persones/importar', requireCoordinator, (req, res) => {
    res.render('import', { title: 'Importar persones', items: req.session.importPreview || null });
  });

  app.post('/persones/importar', requireCoordinator, upload.single('file'), (req, res) => {
    try {
      if (!req.file) throw new Error('Tria un fitxer Excel.');
      const items = previewImport(db, req.file.buffer);
      if (!items.length) throw new Error('No hi ha cap fila amb la columna "Nom".');
      req.session.importPreview = items;
      res.redirect('/persones/importar');
    } catch (err) {
      req.flash('error', `No s'ha pogut llegir: ${err.message}`);
      res.redirect('/persones/importar');
    }
  });

  app.post('/persones/importar/aplicar', requireCoordinator, (req, res) => {
    const items = req.session.importPreview;
    delete req.session.importPreview;
    if (req.body.cancel || !items) return res.redirect('/persones');
    const r = applyImport(db, items);
    req.flash('ok', `Importació feta: ${r.created} noves, ${r.updated} actualitzades.`);
    res.redirect('/persones?filtre=entrenadors');
  });

  app.get('/persones/:id', (req, res, next) => {
    const id = Number(req.params.id);
    const person = peopleWithTeams(db, getConfig(db).minAppearances).find((p) => p.id === id);
    if (!person) return next();
    const teams = teamsById(db);
    const { model, upcoming, conflicts } = analyze(db, { withProposals: true });
    const mine = conflicts.filter((c) => c.people.some((p) => p.id === id));
    const sev = severityMap(mine);
    const agenda = personEvents(model, upcoming, id).slice(0, 40).map((ev) => ({
      ev, severity: sev.get(ev.key),
      role: model.commitments.get(id)?.teams.get(ev.teamId) || 'juga',
      conflicts: mine.filter((c) => c.a.key === ev.key || c.b.key === ev.key),
    }));
    const q = E.norm(req.query.cerca || '');
    const search = q.length >= 3 ? [...teams.values()].filter((t) => !person.teams.some((x) => x.teamId === t.id)
      && E.norm(`${t.name} ${t.competition_name}`).includes(q)).slice(0, 12) : [];
    const appearances = db.prepare(`SELECT team_id, role, COUNT(*) n FROM appearances WHERE person_id = ? GROUP BY team_id, role`).all(id);
    // Per fusionar: primer les fitxes que comparteixen nom o cognom.
    const words = new Set(E.nameTokens(person.name));
    const others = db.prepare('SELECT id, name FROM people WHERE id != ? ORDER BY name').all(id)
      .map((p) => ({ ...p, score: E.nameTokens(p.name).filter((w) => words.has(w) || [...words].some((x) => x.length > 2 && (w.startsWith(x) || x.startsWith(w)))).length }))
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    res.render('person', {
      title: E.titleCase(person.name), person, others, teams, clubTeams: clubTeams(db), agenda, conflicts: mine, search, cerca: req.query.cerca || '', appearances,
      excluded: db.prepare("SELECT team_id FROM person_teams WHERE person_id = ? AND role = 'cap'").all(id).map((r) => teams.get(r.team_id)).filter(Boolean),
      comments: db.prepare(`SELECT c.*, u.name AS author FROM comments c LEFT JOIN users u ON u.id = c.user_id WHERE entity_type = 'person' AND entity_id = ? ORDER BY c.id`).all(id),
    });
  });

  app.post('/persones/:id', requireCoordinator, (req, res) => {
    const id = Number(req.params.id);
    const name = String(req.body.name || '').trim();
    if (name) {
      db.prepare('UPDATE people SET name = ?, family = ?, porter = ?, notes = ?, active = ?, auto = 0 WHERE id = ?')
        .run(name, String(req.body.family || '').trim() || null, req.body.porter ? 1 : 0, String(req.body.notes || '').trim() || null, req.body.inactive ? 0 : 1, id);
    }
    // Rols dels equips: "treure" un equip que surt a les actes el deixa exclòs (rol 'cap').
    const teamIds = [].concat(req.body.team_id || []);
    const roles = [].concat(req.body.role || []);
    const auto = new Set(db.prepare('SELECT DISTINCT team_id FROM appearances WHERE person_id = ?').all(id).map((r) => r.team_id));
    teamIds.forEach((t, i) => {
      const teamId = Number(t);
      const role = roles[i];
      if (role === 'treure') {
        if (auto.has(teamId)) db.prepare("INSERT INTO person_teams (person_id, team_id, role) VALUES (?, ?, 'cap') ON CONFLICT(person_id, team_id) DO UPDATE SET role = 'cap'").run(id, teamId);
        else db.prepare('DELETE FROM person_teams WHERE person_id = ? AND team_id = ?').run(id, teamId);
      } else if (['juga', 'entrena', 'ajuda'].includes(role)) {
        db.prepare('INSERT INTO person_teams (person_id, team_id, role) VALUES (?, ?, ?) ON CONFLICT(person_id, team_id) DO UPDATE SET role = excluded.role').run(id, teamId, role);
      }
    });
    req.flash('ok', 'Fitxa desada.');
    res.redirect(`/persones/${id}`);
  });

  app.post('/persones/:id/equips', requireCoordinator, (req, res) => {
    const role = ['juga', 'entrena', 'ajuda'].includes(req.body.role) ? req.body.role : 'juga';
    if (req.body.team_id) {
      db.prepare('INSERT INTO person_teams (person_id, team_id, role) VALUES (?, ?, ?) ON CONFLICT(person_id, team_id) DO UPDATE SET role = excluded.role')
        .run(req.params.id, req.body.team_id, role);
    }
    res.redirect(`/persones/${req.params.id}`);
  });

  app.post('/persones/:id/equips/:teamId/recuperar', requireCoordinator, (req, res) => {
    db.prepare("DELETE FROM person_teams WHERE person_id = ? AND team_id = ? AND role = 'cap'").run(req.params.id, req.params.teamId);
    res.redirect(`/persones/${req.params.id}`);
  });

  /** Fusiona una altra fitxa dins d'aquesta (p. ex. «Cesc» de l'Excel amb «Francesc Navarra Garcia» de les actes). */
  app.post('/persones/:id/fusionar', requireCoordinator, (req, res) => {
    const keep = db.prepare('SELECT * FROM people WHERE id = ?').get(req.params.id);
    const drop = db.prepare('SELECT * FROM people WHERE id = ?').get(req.body.other_id);
    if (!keep || !drop || keep.id === drop.id) { req.flash('error', 'Tria una altra persona.'); return res.redirect(`/persones/${req.params.id}`); }
    db.transaction(() => {
      for (const t of db.prepare('SELECT * FROM person_teams WHERE person_id = ?').all(drop.id)) {
        db.prepare('INSERT OR IGNORE INTO person_teams (person_id, team_id, role) VALUES (?, ?, ?)').run(keep.id, t.team_id, t.role);
      }
      db.prepare('UPDATE OR IGNORE appearances SET person_id = ? WHERE person_id = ?').run(keep.id, drop.id);
      db.prepare('UPDATE OR IGNORE assignments SET person_id = ? WHERE person_id = ?').run(keep.id, drop.id);
      db.prepare("UPDATE comments SET entity_id = ? WHERE entity_type = 'person' AND entity_id = ?").run(keep.id, drop.id);
      db.prepare('UPDATE users SET person_id = ? WHERE person_id = ?').run(keep.id, drop.id);
      db.prepare('DELETE FROM people WHERE id = ?').run(drop.id);
      const notes = [keep.notes, drop.notes].filter(Boolean).join('\n') || null;
      db.prepare('UPDATE people SET player_id = COALESCE(player_id, ?), family = COALESCE(family, ?), porter = MAX(porter, ?), notes = ?, auto = 0 WHERE id = ?')
        .run(drop.player_id, drop.family, drop.porter, notes, keep.id);
    })();
    req.flash('ok', `${E.titleCase(drop.name)} fusionat amb aquesta fitxa. Revisa els equips.`);
    res.redirect(`/persones/${keep.id}`);
  });

  app.post('/persones/:id/esborrar', requireCoordinator, (req, res) => {
    const p = db.prepare('SELECT * FROM people WHERE id = ?').get(req.params.id);
    if (p?.player_id || db.prepare('SELECT 1 FROM appearances WHERE person_id = ?').get(req.params.id)) {
      db.prepare('UPDATE people SET active = 0 WHERE id = ?').run(req.params.id);
      req.flash('ok', 'Surt a les actes: queda desactivada (no compta per als conflictes).');
    } else {
      db.prepare('DELETE FROM people WHERE id = ?').run(req.params.id);
      req.flash('ok', 'Persona esborrada.');
    }
    res.redirect('/persones');
  });

  app.get('/equips/:id', (req, res, next) => {
    const teams = teamsById(db);
    const team = teams.get(Number(req.params.id));
    if (!team) return next();
    const people = peopleWithTeams(db, getConfig(db).minAppearances).filter((p) => p.active && p.teams.some((t) => t.teamId === team.id))
      .map((p) => ({ ...p, link: p.teams.find((t) => t.teamId === team.id) }));
    const { upcoming, conflicts } = analyze(db, { withProposals: true });
    const events = upcoming.filter((e) => e.teamId === team.id).slice(0, 20);
    const sev = severityMap(conflicts);
    res.render('team', {
      title: team.label, team, people, events, sev,
      comments: db.prepare(`SELECT c.*, u.name AS author FROM comments c LEFT JOIN users u ON u.id = c.user_id WHERE entity_type = 'team' AND entity_id = ? ORDER BY c.id`).all(team.id),
    });
  });
};
