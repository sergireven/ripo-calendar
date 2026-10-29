const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { openDb } = require('../src/db');
const S = require('../src/sidgad');
const { createSync, msUntilNext } = require('../src/sync');
const { createMailer } = require('../src/mailer');

const fixture = (f) => fs.readFileSync(path.join(__dirname, 'fixtures', f), 'utf8');

/** Canvia l'hora d'un partit (fila amb aquests dos equips) al fixture del calendari. */
function moveInHtml(html, db, match, newTime) {
  const t = (id) => db.prepare('SELECT source_id FROM teams WHERE id = ?').get(id).source_id;
  const cls = `team_${t(match.home_team_id)} team_${t(match.away_team_id)} team_class`;
  return html.split('<tr').map((row) => (row.includes(cls) ? row.replace(`>${match.time}<`, `>${newTime}<`) : row)).join('<tr');
}

function setup() {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO users (email, name, role, password_hash) VALUES ('coord@club.cat', 'Coord', 'coordinador', 'x')").run();
  let calendarHtml = fixture('fecapa-cal-4948.html');
  const client = {
    calls: 0,
    async competitions(source) { return source === 'fecapa' ? [{ id: '4948', name: 'BENJAMÍ OR', temp: 41 }, { id: '1', name: 'VELLA', temp: 39 }] : []; },
    async calendar() { this.calls++; return S.parseCalendar(calendarHtml); },
    async acta(source, idp) { return idp === '154502' ? S.parseActa(fixture('fecapa-acta-154502.html')) : { home: { players: [], staff: [] }, away: { players: [], staff: [] } }; },
  };
  const sent = [];
  const mailer = { send: async (to, subject, body) => { sent.push({ to, subject, body }); return { sent: true }; } };
  const sync = createSync(db, { client, mailer, appUrl: 'https://cal.test' });
  return { db, sync, client, sent, setHtml: (h) => { calendarHtml = h; } };
}

test('primera sincronització: desa partits i equips sense avisar de res', async () => {
  const { db, sync, sent } = setup();
  const r = await sync.run();
  assert.equal(r.ok, true);
  assert.equal(r.matches, 56);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM matches').get().n, 56);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM teams WHERE own = 1").get().n, 1);
  assert.equal(db.prepare("SELECT name FROM competitions").get().name, 'BCN BENJAMÍ OR 4');
  assert.equal(r.changes, 0);
  assert.equal(sent.length, 0);
});

test('acta: crea jugadors, entrenador i delegat de l\'equip del club', async () => {
  const { db, sync } = setup();
  await sync.run();
  const roles = db.prepare('SELECT p.name, a.role FROM appearances a JOIN people p ON p.id = a.person_id ORDER BY a.role, p.name').all();
  assert.equal(roles.filter((r) => r.role === 'juga').length, 7, 'només els 7 jugadors del Ripollet');
  assert.deepEqual(roles.filter((r) => r.role !== 'juga').map((r) => [r.role, r.name]), [['ajuda', 'Eloi Rebollo Vergara'], ['entrena', 'Sergio Miras Valero']]);
  assert.equal(db.prepare("SELECT player_id FROM people WHERE name = 'Roc Fernández Moral'").get().player_id, '78704');
});

test('acta: vincula amb una persona creada a mà pel nom', async () => {
  const { db, sync } = setup();
  db.prepare("INSERT INTO people (name) VALUES ('Sergio Miras')").run();
  await sync.run();
  assert.equal(db.prepare("SELECT COUNT(*) n FROM people WHERE name LIKE 'Sergio Miras%'").get().n, 1);
});

test('dues sincronitzacions amb una hora canviada → 1 canvi, 1 correu, cap duplicat', async () => {
  const { db, sync, sent, setHtml } = setup();
  await sync.run();
  const m = db.prepare("SELECT * FROM matches WHERE played = 0 AND (home_name LIKE '%RIPOLLET%' OR away_name LIKE '%RIPOLLET%') ORDER BY date LIMIT 1").get();
  // A la federació, aquest partit passa de la seva hora a les 19:45.
  const html = moveInHtml(fixture('fecapa-cal-4948.html'), db, m, '19:45');
  assert.notEqual(html, fixture('fecapa-cal-4948.html'), 'el fixture s\'ha modificat');
  setHtml(html);
  const r = await sync.run();
  assert.equal(r.changes, 1);
  assert.equal(sent.length, 1);
  assert.match(sent[0].subject, /1 canvi/);
  assert.match(sent[0].body, new RegExp(`${m.time} → .*19:45`));
  assert.match(sent[0].body, new RegExp(`https://cal.test/partits/${m.id}`));
  assert.deepEqual(sent[0].to, ['coord@club.cat']);
  const again = await sync.run();
  assert.equal(again.changes, 0);
  assert.equal(sent.length, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM matches').get().n, 56);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM match_changes').get().n, 1);
});

test('proposta acceptada passa a oficial quan la federació mostra la nova hora', async () => {
  const { db, sync, setHtml } = setup();
  await sync.run();
  const m = db.prepare("SELECT * FROM matches WHERE played = 0 AND home_name = 'CH RIPOLLET B' ORDER BY date LIMIT 1").get();
  const p = db.prepare("INSERT INTO proposals (match_id, new_date, new_time, status) VALUES (?, ?, '19:45', 'acceptada')").run(m.id, m.date).lastInsertRowid;
  setHtml(moveInHtml(fixture('fecapa-cal-4948.html'), db, m, '19:45'));
  await sync.run();
  assert.equal(db.prepare('SELECT status FROM proposals WHERE id = ?').get(p).status, 'oficial');
});

test('si la font falla: no s\'esborra res, es registra i s\'avisa', async () => {
  const { db, sync, client, sent } = setup();
  await sync.run();
  client.calendar = async () => { throw new Error('HTTP 503'); };
  const r = await sync.run();
  assert.equal(r.ok, false);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM matches WHERE status = 'actiu'").get().n, 56);
  assert.match(db.prepare('SELECT errors FROM sync_runs ORDER BY id DESC').get().errors, /503/);
  assert.match(sent.at(-1).subject, /errors de lectura/);
});

test('correu sense BREVO_API_KEY: queda al registre', async () => {
  const db = openDb(':memory:');
  const mailer = createMailer(db, { apiKey: '' });
  const r = await mailer.send('a@b.c', 'Prova', 'Hola');
  assert.equal(r.sent, false);
  assert.equal(db.prepare('SELECT status FROM email_log').get().status, 'no enviat');
});

test('rellotge: propera 07:00 de Madrid', () => {
  const ms = msUntilNext(7, new Date('2026-11-02T05:30:00Z')); // 06:30 a Madrid (UTC+1)
  assert.equal(ms, 30 * 60000);
});

test('pavellons: es llegeixen de l\'acta i dels partits a casa dels rivals que ens rebran', async () => {
  const { db, sync, client } = setup();
  const asked = [];
  const original = client.acta;
  client.acta = async (source, idp, group) => {
    asked.push(idp);
    const a = await original.call(client, source, idp, group);
    return a.venue ? a : { ...a, venue: `PAVELLÓ ${idp}` };
  };
  await sync.run();
  assert.match(db.prepare("SELECT venue FROM teams WHERE name = 'CH RIPOLLET B'").get().venue, /^PAVELLÓ /, 'el de la darrera acta a casa');
  assert.equal(db.prepare("SELECT venue FROM matches WHERE idp = '154502'").get().venue, 'PAVELLÓ RIPOLLET');
  const hosts = db.prepare(`SELECT DISTINCT t.venue FROM matches m JOIN teams t ON t.id = m.home_team_id
    WHERE m.played = 0 AND t.own = 0 AND m.away_team_id IN (SELECT id FROM teams WHERE own = 1)`).all();
  assert.ok(hosts.length > 0);
  assert.ok(hosts.every((h) => h.venue === null || /^PAVELLÓ \d+$/.test(h.venue)), 'pavelló après o encara pendent si no ha jugat a casa');
  const n = asked.length;
  const retry = new Set(db.prepare("SELECT idp FROM matches WHERE played = 1 AND acta_loaded = 0 AND idp IS NOT NULL AND (home_team_id IN (SELECT id FROM teams WHERE own = 1) OR away_team_id IN (SELECT id FROM teams WHERE own = 1))").all().map((r) => r.idp));
  await sync.run();
  assert.ok(asked.slice(n).every((idp) => retry.has(idp)), 'només es tornen a demanar les actes buides, no les dels pavellons ja coneguts');
});
