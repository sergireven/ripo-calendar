const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const S = require('../src/sidgad');

const fixture = (f) => fs.readFileSync(path.join(__dirname, 'fixtures', f), 'utf8');

test('llista de competicions i temporada activa', () => {
  const list = S.parseCompetitionList(fixture('fecapa-ls.html'));
  assert.equal(list[0].id, '4774');
  assert.equal(list[0].name, 'NACIONAL CATALANA MASCULINA');
  assert.equal(S.activeSeason(list), 41);
});

test('calendari d\'un grup FECAPA: ids d\'equip, data ISO, resultat i idp', () => {
  const rows = S.parseCalendar(fixture('fecapa-cal-4948.html'));
  assert.equal(rows.length, 56);
  const rip = rows.find((r) => r.home === 'CH RIPOLLET B' && r.jornada === 1);
  assert.deepEqual(
    { groupId: rip.groupId, groupName: rip.groupName, homeId: rip.homeId, away: rip.away, date: rip.date, time: rip.time, played: rip.played, score: rip.score, idp: rip.idp },
    { groupId: '4948', groupName: 'BCN BENJAMÍ OR 4', homeId: '12442', away: 'CP RIUDEBITLLES B', date: '2026-09-26', time: '15:00', played: true, score: '6-4', idp: '154502' },
  );
});

test('calendari mestre: un bloc per grup', () => {
  const rows = S.parseCalendar(fixture('fecapa-cal-master-4810.html'));
  assert.deepEqual([...new Set(rows.map((r) => r.groupId))], ['4946', '4947']);
  assert.equal(rows.find((r) => r.groupId === '4946').groupName, 'BCN BENJAMÍ OR 2');
});

test('calendari RFEP amb el mateix parser', () => {
  const rows = S.parseCalendar(fixture('rfep-cal.html'));
  assert.equal(rows.length, 12);
  assert.equal(rows[0].home, 'CHP SANT FELIU');
  assert.equal(rows[0].date, '2024-10-19');
});

test('acta: jugadors amb id i cos tècnic de cada equip', () => {
  const a = S.parseActa(fixture('fecapa-acta-154502.html'));
  assert.equal(a.home.players.length, 7);
  assert.deepEqual(a.home.players[1], { id: '78704', name: 'ROC FERNÁNDEZ MORAL' });
  assert.deepEqual(a.home.staff.map((s) => [s.role, s.name]), [['entrena', 'SERGIO MIRAS VALERO'], ['ajuda', 'ELOI REBOLLO VERGARA']]);
  assert.equal(a.away.players.length, 8);
});

test('client: envia Referer i reintenta un cop', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    if (calls.length === 1) throw new Error('reset');
    return { ok: true, text: async () => fixture('fecapa-cal-4948.html') };
  };
  const rows = await S.createClient({ fetchImpl }).calendar('fecapa', '4948');
  assert.equal(rows.length, 56);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, 'https://www.server2.sidgad.es/fecapa/fecapa_cal_idc_4948_1.php');
  assert.equal(calls[1].opts.headers.Referer, 'https://www.hoqueipatins.fecapa.cat/');
  assert.match(calls[1].opts.body, /idc=4948/);
});

test('acta: pavelló de la capçalera', () => {
  assert.equal(S.parseActa(fixture('fecapa-acta-154502.html')).venue, 'PAVELLÓ RIPOLLET');
});

test('ubicació enganxada: coordenades, enllaços de Google Maps i text que no ho és', () => {
  const { parseLocation } = require('../src/geo');
  assert.deepEqual(parseLocation('41.5312, 2.1925'), { lat: 41.5312, lng: 2.1925 });
  assert.deepEqual(parseLocation('41.5312 2.1925'), { lat: 41.5312, lng: 2.1925 });
  assert.deepEqual(parseLocation('https://www.google.com/maps/place/Pavell%C3%B3/@41.53,2.19,17z/data=!3d41.5312!4d2.1925'), { lat: 41.5312, lng: 2.1925 });
  assert.deepEqual(parseLocation('https://maps.google.com/?q=41.40,2.13'), { lat: 41.4, lng: 2.13 });
  assert.deepEqual(parseLocation('https://www.google.com/maps/@41.40,2.13,15z'), { lat: 41.4, lng: 2.13 });
  assert.equal(parseLocation('carrer major 3'), null);
  assert.equal(parseLocation('0,0'), null);
});
