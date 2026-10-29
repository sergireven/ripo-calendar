const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const XLSX = require('xlsx');
const { openDb } = require('../src/db');
const { createApp } = require('../src/app');
const { createSync } = require('../src/sync');
const { upsertUser } = require('../src/auth');
const S = require('../src/sidgad');

process.env.TODAY = '2026-10-01'; // el fixture és d'octubre de 2026

const fixture = (f) => fs.readFileSync(path.join(__dirname, 'fixtures', f), 'utf8');
const client = {
  async competitions(source) { return source === 'fecapa' ? [{ id: '4948', name: 'BENJAMÍ OR', temp: 41 }] : []; },
  async calendar() { return S.parseCalendar(fixture('fecapa-cal-4948.html')); },
  async acta(source, idp) { return idp === '154502' ? S.parseActa(fixture('fecapa-acta-154502.html')) : { home: { players: [], staff: [] }, away: { players: [], staff: [] } }; },
};
const mailer = { send: async () => ({ sent: true }), configured: false };

async function setup() {
  const db = openDb(':memory:');
  const sync = createSync(db, { client, mailer });
  await sync.run();
  upsertUser(db, { email: 'coord@club.cat', name: 'Coord', role: 'coordinador', password: 'secret123' });
  upsertUser(db, { email: 'entrenador@club.cat', name: 'Entrenador', role: 'entrenador', password: 'secret123' });
  const app = createApp(db, { mailer, sync });
  return { db, app };
}

async function login(app, email) {
  const agent = request.agent(app);
  const page = await agent.get('/entrar');
  const csrf = page.text.match(/name="_csrf" value="([^"]+)"/)[1];
  const res = await agent.post('/entrar').type('form').send({ _csrf: csrf, email, password: 'secret123' });
  assert.equal(res.status, 302);
  // La sessió es regenera en entrar: el token nou surt a qualsevol pàgina.
  agent.csrf = (await agent.get('/persones')).text.match(/name="_csrf" value="([^"]+)"/)[1];
  return agent;
}

test('sense sessió: healthcheck obert i la resta redirigeix a entrar', async () => {
  const { app } = await setup();
  assert.equal((await request(app).get('/healthz')).status, 200);
  const res = await request(app).get('/');
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/entrar');
  assert.equal((await request(app).get('/api/events')).status, 401);
});

test('després d\'entrar no redirigeix fora del lloc', async () => {
  const { app } = await setup();
  const agent = request.agent(app);
  await agent.get('//exemple.com/x');
  const csrf = (await agent.get('/entrar')).text.match(/name="_csrf" value="([^"]+)"/)[1];
  const res = await agent.post('/entrar').type('form').send({ _csrf: csrf, email: 'coord@club.cat', password: 'secret123' });
  assert.ok(!String(res.headers.location).startsWith('//'));
});

test('el favicon no es converteix en la pàgina de després d\'entrar', async () => {
  const { app } = await setup();
  const agent = request.agent(app);
  assert.equal((await agent.get('/favicon.ico')).status, 200);
  await agent.get('/no-existeix.png');
  const csrf = (await agent.get('/entrar')).text.match(/name="_csrf" value="([^"]+)"/)[1];
  const res = await agent.post('/entrar').type('form').send({ _csrf: csrf, email: 'coord@club.cat', password: 'secret123' });
  assert.equal(res.headers.location, '/');
});

test('contrasenya incorrecta no entra', async () => {
  const { app } = await setup();
  const agent = request.agent(app);
  const csrf = (await agent.get('/entrar')).text.match(/name="_csrf" value="([^"]+)"/)[1];
  const res = await agent.post('/entrar').type('form').send({ _csrf: csrf, email: 'coord@club.cat', password: 'malament' });
  assert.equal(res.status, 401);
});

test('totes les pantalles responen 200 per al coordinador', async () => {
  const { app, db } = await setup();
  const agent = await login(app, 'coord@club.cat');
  const matchId = db.prepare("SELECT id FROM matches WHERE home_name = 'CH RIPOLLET B' AND played = 0 ORDER BY date LIMIT 1").get().id;
  const personId = db.prepare('SELECT id FROM people LIMIT 1').get().id;
  const teamId = db.prepare('SELECT id FROM teams WHERE own = 1').get().id;
  for (const url of ['/', '/conflictes', '/pista', '/pista?dia=2026-11-01', '/persones', '/persones?filtre=entrenadors', `/persones/${personId}`,
    `/equips/${teamId}`, `/partits/${matchId}`, '/simulador', `/simulador?partit=${matchId}`, `/simulador?partit=${matchId}&data=2026-11-01&hora=18:00`,
    `/simulador?partit=${matchId}&alternatives=1`, '/canvis', '/config', '/persones/importar']) {
    const res = await agent.get(url);
    assert.equal(res.status, 200, url);
  }
  const ev = await agent.get('/api/events?start=2026-09-01&end=2027-07-01');
  assert.equal(ev.status, 200);
  assert.ok(ev.body.length >= 14, 'els 14 partits del Ripollet B');
  assert.ok(ev.body.every((e) => e.url.startsWith('/partits/')));
});

test('l\'entrenador veu però no pot canviar res', async () => {
  const { app, db } = await setup();
  const agent = await login(app, 'entrenador@club.cat');
  assert.equal((await agent.get('/')).status, 200);
  assert.equal((await agent.get('/config')).status, 403);
  assert.equal((await agent.get('/persones/exportar.xlsx')).status, 403, 'l\'Excel té dades de menors: només coordinadors');
  const res = await agent.post('/pista/bloqueig').type('form').send({ _csrf: agent.csrf, date: '2026-11-01', from: '10:00', to: '11:00' });
  assert.equal(res.status, 403);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM pista_blocks').get().n, 0);
  // però sí que pot comentar
  const m = db.prepare('SELECT id FROM matches LIMIT 1').get().id;
  await agent.post('/comentaris').type('form').send({ _csrf: agent.csrf, entity_type: 'match', entity_id: m, body: 'Hola', back: `/partits/${m}` });
  assert.equal(db.prepare('SELECT body FROM comments').get().body, 'Hola');
});

test('sense CSRF el formulari es rebutja', async () => {
  const { app } = await setup();
  const agent = await login(app, 'coord@club.cat');
  assert.equal((await agent.post('/pista/bloqueig').type('form').send({ date: '2026-11-01' })).status, 403);
});

test('simular i desar una proposta, acceptar-la', async () => {
  const { app, db } = await setup();
  const agent = await login(app, 'coord@club.cat');
  const m = db.prepare("SELECT * FROM matches WHERE home_name = 'CH RIPOLLET B' AND played = 0 ORDER BY date LIMIT 1").get();
  const res = await agent.post('/propostes').type('form').send({ _csrf: agent.csrf, match_id: m.id, date: m.date, time: '19:00', origin: 'telefon', contact: 'Club X', comment: 'Ho demanen per un torneig' });
  assert.equal(res.status, 302);
  const p = db.prepare('SELECT * FROM proposals').get();
  assert.equal(p.status, 'pendent');
  assert.equal(JSON.parse(p.impact).blocks, 0);
  assert.equal(db.prepare("SELECT body FROM comments WHERE entity_type = 'proposal'").get().body, 'Ho demanen per un torneig');
  await agent.post(`/propostes/${p.id}/estat`).type('form').send({ _csrf: agent.csrf, action: 'acceptar' });
  assert.equal(db.prepare('SELECT status FROM proposals').get().status, 'acceptada');
  const page = await agent.get(`/propostes/${p.id}`);
  assert.match(page.text, /pendent que la federació la publiqui/);
});

test('bloquejar una franja de la pista crea un bloqueig de pista', async () => {
  const { app, db } = await setup();
  const agent = await login(app, 'coord@club.cat');
  const m = db.prepare("SELECT * FROM matches WHERE home_name = 'CH RIPOLLET B' AND played = 0 ORDER BY date LIMIT 1").get();
  await agent.post('/pista/bloqueig').type('form').send({ _csrf: agent.csrf, date: m.date, from: m.time, to: '23:00', reason: 'Escola' });
  const page = await agent.get('/conflictes');
  assert.match(page.text, /Pista bloquejada/);
  assert.match(page.text, /Escola/);
});

test('importar Excel de persones: previsualitza, aplica i vincula amb les actes', async () => {
  const { app, db } = await setup();
  const agent = await login(app, 'coord@club.cat');
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['Nom', 'Juga a', 'Entrena', 'Ajudant/delegat a', 'Altres equips (Equip | Competició)', 'Família', 'Porter', 'Notes', 'ID jok'],
    ['Sergio Miras', '', 'Benjamí B', '', '', '', '', 'Coordinador de base', ''],
    ['Roc Fernández Moral', '', '', '', '', '', 'Sí', '', '78704'],
    ['Persona Nova', 'Prebe Z', '', '', 'Equip Inventat | Lliga', '', '', '', ''],
  ]), 'Persones');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const up = await agent.post(`/persones/importar?_csrf=${agent.csrf}`).attach('file', buf, 'persones.xlsx');
  assert.equal(up.status, 302);
  const preview = await agent.get('/persones/importar');
  assert.match(preview.text, /No reconegut: Prebe Z, Equip Inventat \| Lliga/);
  await agent.post('/persones/importar/aplicar').type('form').send({ _csrf: agent.csrf });
  const miras = db.prepare("SELECT * FROM people WHERE name LIKE 'Sergio Miras%'").all();
  assert.equal(miras.length, 1, 'no es duplica: es vincula amb l\'entrenador de les actes');
  assert.equal(miras[0].notes, 'Coordinador de base');
  assert.equal(db.prepare("SELECT porter FROM people WHERE player_id = '78704'").get().porter, 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM people WHERE name = 'Persona Nova'").get().n, 1);
  const exp = await agent.get('/persones/exportar.xlsx').buffer(true).parse((res, cb) => { const d = []; res.on('data', (c) => d.push(c)); res.on('end', () => cb(null, Buffer.concat(d))); });
  const rows = XLSX.utils.sheet_to_json(XLSX.read(exp.body).Sheets.Persones);
  assert.ok(rows.some((r) => r.Nom === 'Sergio Miras Valero' && /Benjamí B/.test(r.Entrena)));
});

test('partit manual amb una persona convocada', async () => {
  const { app, db } = await setup();
  const agent = await login(app, 'coord@club.cat');
  const person = db.prepare('SELECT id FROM people LIMIT 1').get().id;
  const res = await agent.post('/partits/nou').type('form').send({ _csrf: agent.csrf, title: 'Torneig de Nadal', date: '2026-12-20', time: '10:00', place: 'Pavelló de Mollet', person_id: person });
  assert.equal(res.status, 302);
  const m = db.prepare("SELECT * FROM matches WHERE origin = 'manual'").get();
  assert.equal(m.home_name, 'Pavelló de Mollet');
  assert.equal(db.prepare('SELECT person_id FROM assignments WHERE match_id = ?').get(m.id).person_id, person);
  assert.equal((await agent.get(`/partits/${m.id}`)).status, 200);
});

test('fusionar dues fitxes de la mateixa persona', async () => {
  const { app, db } = await setup();
  const agent = await login(app, 'coord@club.cat');
  const keep = db.prepare("SELECT id FROM people WHERE name = 'Sergio Miras Valero'").get().id;
  const team = db.prepare('SELECT id FROM teams WHERE own = 1').get().id;
  const drop = db.prepare("INSERT INTO people (name, notes) VALUES ('Miras', 'de l''Excel')").run().lastInsertRowid;
  db.prepare("INSERT INTO person_teams (person_id, team_id, role) VALUES (?, ?, 'entrena')").run(drop, team);
  db.prepare("INSERT INTO comments (entity_type, entity_id, body) VALUES ('person', ?, 'nota')").run(drop);
  const res = await agent.post(`/persones/${keep}/fusionar`).type('form').send({ _csrf: agent.csrf, other_id: drop });
  assert.equal(res.status, 302);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM people WHERE id = ?').get(drop).n, 0);
  assert.equal(db.prepare('SELECT notes FROM people WHERE id = ?').get(keep).notes, "de l'Excel");
  assert.equal(db.prepare("SELECT entity_id FROM comments WHERE body = 'nota'").get().entity_id, keep);
  assert.ok(db.prepare('SELECT 1 FROM appearances WHERE person_id = ?').get(keep));
});

test('importar: àlies de nom de pila es vinculen si comparteixen equip', async () => {
  const { app, db } = await setup();
  const agent = await login(app, 'coord@club.cat');
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['Nom', 'Juga a', 'Entrena'],
    ['Sergio', '', 'Benjamí B'],   // Sergio Miras Valero entrena el Benjamí B a les actes
    ['Sergio Garcia', '', 'Benjamí B'], // un altre cognom: persona nova
  ]), 'Persones');
  await agent.post(`/persones/importar?_csrf=${agent.csrf}`).attach('file', XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), 'p.xlsx');
  await agent.post('/persones/importar/aplicar').type('form').send({ _csrf: agent.csrf });
  assert.equal(db.prepare("SELECT COUNT(*) n FROM people WHERE name LIKE 'Sergio%'").get().n, 2);
  assert.ok(db.prepare("SELECT 1 FROM people WHERE name = 'Sergio Miras Valero'").get(), 'es queda el nom complet de les actes');
  assert.ok(db.prepare("SELECT 1 FROM people WHERE name = 'Sergio Garcia'").get());
});
