/**
 * Lectura de la base de dades cap al model del motor, i petites utilitats compartides.
 */
'use strict';

const path = require('path');
const E = require('./engine');
const { getSetting } = require('./db');

const CLUB_RE = new RegExp(process.env.CLUB_PATTERN || 'ripollet', 'i');
const VENUES = require(path.join(__dirname, '..', 'seed', 'venues.json')).venues || {};
const CAT_ORDER = ['Prebenjamí', 'Benjamí', 'Aleví', 'Infantil', 'Juvenil', 'Júnior', 'Femení', '3a Catalana', '2a Catalana', '1a Catalana', 'Nacional Catalana', 'Veterans', 'OK Liga', 'Altres'];

/** Data d'avui a Madrid (YYYY-MM-DD). */
function todayKey(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

function getConfig(db) {
  return {
    ...E.DEFAULT_CONFIG,
    ...getSetting(db, 'rules', {}),
    travelOverrides: getSetting(db, 'travel', {}),
    disabledFamilies: getSetting(db, 'disabled_families', []),
  };
}

function allTeams(db) {
  return db.prepare(`SELECT t.*, c.name AS competition_name, c.source FROM teams t LEFT JOIN competitions c ON c.id = t.competition_id`).all();
}

/** Equips del club, ordenats per categoria, amb etiqueta. */
function clubTeams(db) {
  return db.prepare(`SELECT t.*, c.name AS competition_name FROM teams t JOIN competitions c ON c.id = t.competition_id WHERE t.own = 1`).all()
    .map((t) => ({ ...t, label: E.teamLabel(t, t.competition_name), category: E.categoryOf(t.competition_name) }))
    .sort((a, b) => (CAT_ORDER.indexOf(a.category) - CAT_ORDER.indexOf(b.category)) || a.label.localeCompare(b.label));
}

/**
 * Persones amb els seus equips efectius: el que diu la fitxa (person_teams) i el que surt a les actes
 * (appearances, mínim `minApps`). El rol 'cap' de la fitxa treu un equip de les actes.
 */
function peopleWithTeams(db, minApps = 1) {
  const people = db.prepare('SELECT * FROM people ORDER BY name').all();
  const manual = db.prepare('SELECT person_id, team_id, role FROM person_teams').all();
  const auto = db.prepare('SELECT person_id, team_id, role, COUNT(*) AS n FROM appearances GROUP BY person_id, team_id, role').all();
  const byPerson = new Map(people.map((p) => [p.id, new Map()]));
  for (const a of auto) {
    if (a.n < minApps || !byPerson.has(a.person_id)) continue;
    const m = byPerson.get(a.person_id);
    const prev = m.get(a.team_id);
    // Si surt com a entrenador i com a jugador del mateix equip, mana entrenar.
    if (!prev || (a.role === 'entrena' && prev.role !== 'entrena')) m.set(a.team_id, { teamId: a.team_id, role: a.role, auto: true, apps: a.n });
  }
  for (const r of manual) {
    const m = byPerson.get(r.person_id);
    if (!m) continue;
    if (r.role === 'cap') m.delete(r.team_id);
    else m.set(r.team_id, { teamId: r.team_id, role: r.role, auto: false, apps: m.get(r.team_id)?.apps || 0 });
  }
  return people.map((p) => ({ ...p, teams: [...byPerson.get(p.id).values()] }));
}

/** Model complet per al motor. Només es carreguen els partits d'equips que ens importen. */
function loadModel(db) {
  const config = getConfig(db);
  const teams = allTeams(db);
  const people = peopleWithTeams(db, config.minAppearances);
  const relevant = new Set(teams.filter((t) => t.own).map((t) => t.id));
  for (const p of people) if (p.active) for (const t of p.teams) relevant.add(t.teamId);
  const assignments = db.prepare('SELECT match_id, person_id, type FROM assignments').all();
  const assigned = new Set(assignments.map((a) => a.match_id));
  const ids = [...relevant];
  const matches = db.prepare(`SELECT m.*, c.name AS competition_name FROM matches m LEFT JOIN competitions c ON c.id = m.competition_id
    WHERE m.status = 'actiu' AND (m.home_team_id IN (SELECT value FROM json_each(?)) OR m.away_team_id IN (SELECT value FROM json_each(?)) OR m.origin = 'manual')`)
    .all(JSON.stringify(ids), JSON.stringify(ids))
    .filter((m) => m.origin !== 'manual' || relevant.has(m.home_team_id) || relevant.has(m.away_team_id) || assigned.has(m.id));
  const blocks = db.prepare('SELECT * FROM pista_blocks').all();
  const grid = getSetting(db, 'grid', null);
  return E.buildModel({ matches, teams, people, assignments, blocks, config, venues: VENUES, grid });
}

/** Model + conflictes dels propers partits (amb propostes superposades si es demana). */
function analyze(db, { withProposals = false } = {}) {
  const model = loadModel(db);
  const today = todayKey();
  let upcoming = model.events.filter((e) => e.dayKey >= today);
  const proposals = db.prepare("SELECT * FROM proposals WHERE status IN ('pendent', 'acceptada')").all();
  if (withProposals) upcoming = E.applyProposals(upcoming, proposals);
  const conflicts = E.detectConflicts(upcoming, model);
  return { model, upcoming, conflicts, proposals, today };
}

/** Persona per nom: igual (normalitzat) o, si n'hi ha només una, la que conté tots els mots. */
function findPersonByName(db, name, { onlyWithoutPlayerId = false } = {}) {
  const n = E.norm(name);
  const people = db.prepare('SELECT * FROM people').all().filter((p) => !onlyWithoutPlayerId || !p.player_id);
  const exact = people.find((p) => E.norm(p.name) === n);
  if (exact) return exact;
  const cands = people.filter((p) => E.nameMatches(p.name, name) || E.nameMatches(name, p.name));
  return cands.length === 1 ? cands[0] : null;
}

module.exports = { CLUB_RE, VENUES, CAT_ORDER, todayKey, getConfig, allTeams, clubTeams, peopleWithTeams, loadModel, analyze, findPersonByName };
