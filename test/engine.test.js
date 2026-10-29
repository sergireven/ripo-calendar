const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../src/engine');

// Coordenades de prova: casa a Ripollet, Manlleu ~56 km, Vilafranca ~42 km, Mollet ~6 km, Sant Cugat ~8 km.
const venues = {
  'CH RIPOLLET A': { lat: 41.5015, lng: 2.1569 },
  'MARTINELIA MANLLEU B': { lat: 42.0, lng: 2.28 },
  'CP VILAFRANCA AKO A': { lat: 41.35, lng: 1.70 },
  'MOLLET HC A': { lat: 41.54, lng: 2.21 },
  'VICIO PHC SANT CUGAT': { lat: 41.47, lng: 2.08 },
};

const teams = [
  { id: 1, name: 'CH RIPOLLET A', own: 1, competition_name: 'BCN PREBENJAMI OR 3' },
  { id: 2, name: 'CH RIPOLLET C', own: 1, competition_name: 'BCN BENJAMÍ PLATA 4' },
  { id: 3, name: 'CH RIPOLLET B', own: 1, competition_name: 'ALEVÍ PLATA 3' },
  { id: 4, name: 'CH RIPOLLET', own: 1, competition_name: 'TERCERA CATALANA' },
  { id: 9, name: 'VICIO PHC SANT CUGAT', own: 0, competition_name: 'FEM 19' },
  { id: 20, name: 'CP VILAFRANCA AKO A', own: 0 },
  { id: 21, name: 'MARTINELIA MANLLEU B', own: 0 },
  { id: 22, name: 'MOLLET HC A', own: 0 },
];
const T = Object.fromEntries(teams.map((t) => [t.id, t]));

let nextId = 100;
function match(compName, home, away, date, time) {
  return { id: nextId++, competition_id: 1, competition_name: compName, jornada: 1, home_team_id: home, away_team_id: away,
    home_name: T[home].name, away_name: T[away].name, date, time, played: 0, status: 'actiu', origin: 'font' };
}

const M = {
  prebeFora: match('BCN PREBENJAMI OR 3', 20, 1, '2026-11-01', '10:00'),
  benjFora: match('BCN BENJAMÍ PLATA 4', 21, 2, '2026-11-01', '10:00'),
  prebeCasa: match('BCN PREBENJAMI OR 3', 1, 22, '2026-11-08', '10:00'),
  benjCasa: match('BCN BENJAMÍ PLATA 4', 2, 22, '2026-11-08', '11:15'),
  aleviCasa: match('ALEVÍ PLATA 3', 3, 22, '2026-11-08', '11:45'),
  terceraFora: match('TERCERA CATALANA', 22, 4, '2026-11-08', '12:00'),
  prebeCasa2: match('BCN PREBENJAMI OR 3', 1, 22, '2026-11-15', '10:00'),
  benjCasa2: match('BCN BENJAMÍ PLATA 4', 2, 22, '2026-11-15', '11:15'),
  santCugat: match('FEM 19', 9, 22, '2026-11-15', '10:30'),
};
const matches = Object.values(M);

const P = (id, name, links, extra = {}) => ({ id, name, active: 1, teams: links.map(([teamId, role]) => ({ teamId, role })), ...extra });

function model({ people = [], assignments = [], blocks = [], config } = {}) {
  return E.buildModel({ matches, teams, people, assignments, blocks, venues, config });
}

const bernat = P(1, 'BERNAT REVENTOS PLAZA', [[1, 'juga'], [2, 'juga']]);
const genis = P(2, 'GENIS REVENTOS PLAZA', [[3, 'juga']]);

test('dates i noms', () => {
  assert.equal(E.dayKeyOf('01-11-2026'), '2026-11-01');
  assert.equal(E.weekdayOf('2026-11-01'), 'dg');
  assert.deepEqual(E.weekendDays('2026-11-04'), ['2026-11-07', '2026-11-08']);
  assert.ok(E.nameMatches('Hugo Lachica', 'HUGO LACHICA BOSCH'));
  assert.ok(!E.nameMatches('Hugo', 'HUGO LACHICA BOSCH'));
  assert.equal(E.familyKey('Genís Reventós Plaza'), 'reventos plaza');
  assert.equal(E.teamLabel(T[1], 'BCN PREBENJAMI OR 3'), 'Prebenjamí A');
  assert.equal(E.teamLabel({ name: 'CH RIPOLLET', own: 1 }, 'BCN PB-INICIACIÓ 3'), 'Prebenjamí Iniciació');
  assert.equal(E.teamLabel({ name: 'CH RIPOLLET', own: 1 }, '3ª CATALANA GRUP A'), '3a Catalana');
  assert.equal(E.teamLabel({ name: 'CH RIPOLLET', own: 1 }, '1ª CATALANA GRUP A'), '1a Catalana');
  assert.equal(E.categoryOf('3ª Catalana'), '3a Catalana');
});

test('jugador que dobla: dos partits fora a la mateixa hora és bloqueig', () => {
  const m = model({ people: [bernat] });
  const c = E.detectConflicts(m.events, m).find((x) => x.type === 'persona');
  assert.equal(c.severity, 'block');
  assert.equal(c.a.dayKey, '2026-11-01');
  assert.deepEqual(c.people.map((p) => p.name), ['BERNAT REVENTOS PLAZA']);
});

test('casa→casa seguits no és conflicte de persona', () => {
  const m = model({ people: [P(3, 'X Y Z', [[1, 'juga'], [2, 'juga']])] });
  const cs = E.detectConflicts(m.events, m).filter((x) => x.type === 'persona' && x.a.dayKey === '2026-11-08');
  assert.equal(cs.length, 0);
});

test('entrenador que també juga: entrenar a casa i jugar fora és bloqueig', () => {
  const hugo = P(4, 'HUGO LACHICA BOSCH', [[2, 'entrena'], [4, 'juga']]);
  const m = model({ people: [hugo] });
  const c = E.detectConflicts(m.events, m).find((x) => x.type === 'persona');
  assert.ok(c, 'Benjamí C 11:15 a casa i 3a a Mollet a les 12:00');
  assert.equal(c.severity, 'block');
  assert.deepEqual(c.people[0].roles, ['entrena', 'juga']);
});

test('ajudant/delegat només avisa', () => {
  const m = model({ people: [P(5, 'DELEGAT X Y', [[1, 'ajuda'], [2, 'juga']])] });
  const c = E.detectConflicts(m.events, m).find((x) => x.type === 'persona');
  assert.equal(c.severity, 'warn');
});

test('equip d\'un altre club entra a l\'agenda de la persona', () => {
  const alba = P(6, 'ALBA X Y', [[2, 'entrena'], [9, 'juga']]);
  const m = model({ people: [alba] });
  const ext = m.events.find((e) => e.teamId === 9);
  assert.ok(ext && !ext.own && !ext.isHome);
  assert.ok(E.detectConflicts(m.events, m).some((c) => c.people.some((p) => p.id === 6)), 'Sant Cugat 10:30 + Ripollet 11:15');
});

test('porter assignat: el compromet a aquell partit', () => {
  const kael = P(7, 'KAEL CORDOBA FREGINALS', [[2, 'juga']]);
  const m = model({ people: [kael], assignments: [{ match_id: M.prebeFora.id, person_id: 7, type: 'porter' }] });
  const c = E.detectConflicts(m.events, m).find((x) => x.people.some((p) => p.id === 7));
  assert.ok(c);
  assert.equal(c.a.dayKey, '2026-11-01');
});

test('pista: dos partits a casa que es trepitgen', () => {
  const m = model();
  const pista = E.detectConflicts(m.events, m).filter((x) => x.type === 'pista');
  assert.equal(pista.length, 1);
  assert.equal(pista[0].a.time, '11:15');
  assert.equal(pista[0].b.time, '11:45');
});

test('franja bloquejada: partit a casa dins del bloqueig', () => {
  const m = model({ blocks: [{ id: 1, date: '2026-11-15', time_from: '09:00', time_to: '10:30', reason: 'Escola' }] });
  const c = E.detectConflicts(m.events, m).find((x) => x.type === 'pista-bloquejada');
  assert.ok(c);
  assert.match(c.message, /Escola/);
});

test('germans: només avís', () => {
  const m = model({ people: [bernat, genis] });
  assert.equal(m.families[0].label, 'reventos plaza');
  for (const c of E.detectConflicts(m.events, m).filter((x) => x.type === 'germans')) assert.equal(c.severity, 'warn');
});

test('parrilla deduïda i estat de les franges', () => {
  const m = model();
  assert.deepEqual(m.grid.dg, ['10:00', '11:15']);
  const day = E.pistaDay(m.events, m, '2026-11-08');
  assert.equal(day.slots[1].status, 'solapament'); // 11:15 + 11:45
  assert.equal(day.offGrid.length, 1);
});

test('simulador: moure el Benjamí C a la tarda resol el conflicte', () => {
  const m = model({ people: [bernat] });
  const sim = E.simulateChange(m.events, m, M.benjFora.id, '2026-11-01', '17:00');
  assert.equal(sim.blocks, 0);
  assert.ok(sim.resolved.some((c) => c.type === 'persona'));
});

test('alternatives: mai amb bloquejos, primer la parrilla', () => {
  const m = model({ people: [bernat, genis] });
  const s = E.suggestSlots(m.events, m, M.aleviCasa.id, { dayKeys: ['2026-11-01', '2026-11-08'] });
  assert.ok(s.grid.length > 0);
  assert.ok(!s.grid.some((x) => x.dayKey === '2026-11-08'), 'el 8/11 les franges ja estan ocupades');
  for (const x of [...s.grid, ...s.other]) assert.equal(E.simulateChange(m.events, m, M.aleviCasa.id, x.dayKey, x.time).blocks, 0);
});

test('propostes pendents se superposen al calendari', () => {
  const m = model();
  const moved = E.applyProposals(m.events, [{ id: 1, match_id: M.benjCasa.id, new_date: '2026-11-08', new_time: '13:00', status: 'pendent' }]);
  const ev = moved.find((e) => e.matchId === M.benjCasa.id);
  assert.equal(ev.time, '13:00');
  assert.equal(ev.proposalId, 1);
  assert.equal(E.applyProposals(m.events, [{ id: 2, match_id: M.benjCasa.id, new_date: '2026-11-08', new_time: '13:00', status: 'oficial' }])
    .find((e) => e.matchId === M.benjCasa.id).time, '11:15');
});

test('resolutor de pistes: no confon clubs per paraules genèriques', () => {
  const resolve = E.makeVenueResolver({ 'Club Pati Tordera': { lat: 41.7, lng: 2.7 } });
  assert.equal(resolve('Club Patí Roda A'), null);
  assert.ok(resolve('Club Pati Tordera A'));
});
