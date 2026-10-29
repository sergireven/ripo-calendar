/**
 * Importació i exportació de persones en Excel.
 * Columnes: Nom | Juga a | Entrena | Ajudant/delegat a | Altres equips (Equip | Competició) | Família | Porter | Notes | ID jok
 */
'use strict';

const XLSX = require('xlsx');
const E = require('./engine');
const { clubTeams, peopleWithTeams, getConfig, findPersonByName } = require('./data');

const COLS = ['Nom', 'Juga a', 'Entrena', 'Ajudant/delegat a', 'Altres equips (Equip | Competició)', 'Família', 'Porter', 'Notes', 'ID jok'];
const ROLE_COLS = [['Juga a', 'juga'], ['Entrena', 'entrena'], ['Ajudant/delegat a', 'ajuda']];

/** Llegeix una cel·la tolerant amb majúscules, accents i el text entre parèntesis de la capçalera. */
function cell(row, col) {
  const want = E.norm(col.replace(/\(.*\)/, ''));
  for (const [k, v] of Object.entries(row)) if (E.norm(String(k).replace(/\(.*\)/, '')) === want) return String(v ?? '').trim();
  return '';
}

const splitList = (v, sep = /[,;\n]+/) => String(v || '').split(sep).map((s) => s.trim()).filter(Boolean);

/** Nom d'equip del club ("Prebe C", "Benjamí A", "BENJAMIN A ORO"…) → id. */
function makeClubResolver(teams) {
  const byName = new Map();
  for (const t of teams) for (const n of [t.label, t.short_name, E.teamLabel({ ...t, short_name: null }, t.competition_name)].filter(Boolean)) byName.set(E.norm(n), t.id);
  return (text) => {
    const n = E.norm(text);
    if (byName.has(n)) return byName.get(n);
    const cat = E.categoryOf(text.replace(/\bprebe\b/i, 'prebenjami'));
    if (cat === 'Altres') return null;
    const letter = (String(text).toUpperCase().match(/(?:^|\s)([A-D])(?:\s|$)/) || [])[1] || '';
    let cands = teams.filter((t) => t.category === cat);
    if (/inici/.test(n)) cands = cands.filter((t) => /inici/i.test(E.norm(t.competition_name)));
    else if (letter) {
      const byLetter = cands.filter((t) => (String(t.name).match(/\s([A-H])$/) || [])[1] === letter);
      if (byLetter.length) cands = byLetter;
    }
    if (cands.length > 1 && /plata|oro|\bor\b/.test(n)) {
      const lvl = /plata/.test(n) ? /plata/ : /\bor\b/;
      const f = cands.filter((t) => lvl.test(E.norm(t.competition_name)));
      if (f.length) cands = f;
    }
    return cands.length === 1 ? cands[0].id : null;
  };
}

/** "Vicio Phc Sant Cugat | FEM 19" → id d'equip de qualsevol competició. */
function resolveExternal(db, text) {
  const [teamPart, compPart = ''] = String(text).split('|').map((s) => s.trim());
  const rows = db.prepare('SELECT t.id, t.name, c.name AS comp FROM teams t JOIN competitions c ON c.id = t.competition_id').all();
  const tn = E.norm(teamPart);
  const cn = E.norm(compPart);
  let c = rows.filter((r) => E.norm(r.name) === tn && (!cn || E.norm(r.comp).startsWith(cn) || E.norm(r.comp).includes(cn)));
  if (c.length > 1 && cn) {
    const exact = c.filter((r) => E.norm(r.comp) === cn || E.norm(r.comp).startsWith(`${cn} `));
    if (exact.length) c = exact;
  }
  return c.length === 1 ? c[0].id : null;
}

/**
 * «Dani Miras» → «Daniel Miras Valero», «Cesc» → «Francesc Navarra Garcia»: el nom de pila encaixa (inici o final),
 * la resta de mots hi són i comparteixen algun equip. Només si hi ha un sol candidat.
 */
function sameNameAndTeam(people, name, teams) {
  const [first, ...rest] = E.nameTokens(name);
  if (!first || !teams.length) return null;
  const ids = new Set(teams.map((t) => t.teamId));
  const cands = people.filter((p) => {
    const [pf, ...pr] = E.nameTokens(p.name);
    if (!pf || !(pf.startsWith(first) || first.startsWith(pf) || (first.length >= 4 && pf.endsWith(first)))) return false;
    if (!rest.every((w) => pr.includes(w))) return false;
    return p.teams.some((t) => ids.has(t.teamId));
  });
  if (cands.length > 1) {
    // Desempat: mateix rol al mateix equip (l'entrenador «Pol» és el Pol que entrena, no un jugador).
    const sameRole = cands.filter((p) => p.teams.some((t) => teams.some((x) => x.teamId === t.teamId && x.role === t.role)));
    return sameRole.length === 1 ? sameRole[0] : null;
  }
  return cands.length === 1 ? cands[0] : null;
}

/** Previsualització: què es crearà o s'actualitzarà, i què no s'ha reconegut. */
function previewImport(db, buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const sheet = wb.SheetNames.find((n) => E.norm(n).startsWith('persones')) || wb.SheetNames[0];
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheet], { defval: '' });
  const club = clubTeams(db);
  const resolveClub = makeClubResolver(club);
  const labels = new Map(club.map((t) => [t.id, t.label]));
  const labelOf = (id) => labels.get(id) || (() => {
    const t = db.prepare('SELECT t.name, c.name AS comp FROM teams t JOIN competitions c ON c.id = t.competition_id WHERE t.id = ?').get(id);
    return t ? `${E.titleCase(t.name)} (${t.comp})` : String(id);
  })();
  const people = peopleWithTeams(db, 1);
  const items = [];
  for (const row of rows) {
    const name = cell(row, 'Nom');
    if (!name) continue;
    const teams = [];
    const unknown = [];
    for (const [col, role] of ROLE_COLS) {
      for (const t of splitList(cell(row, col))) {
        const id = resolveClub(t);
        if (id) teams.push({ teamId: id, role, label: labelOf(id) }); else unknown.push(t);
      }
    }
    for (const t of splitList(cell(row, 'Altres equips'), /[;\n]+/)) {
      const id = resolveExternal(db, t);
      if (id) teams.push({ teamId: id, role: 'juga', label: labelOf(id) }); else unknown.push(t);
    }
    const jok = cell(row, 'ID jok').replace(/\D/g, '');
    const existing = (jok && db.prepare('SELECT * FROM people WHERE player_id = ?').get(jok)) || findPersonByName(db, name)
      || sameNameAndTeam(people, name, teams);
    items.push({
      name, teams, unknown, playerId: jok || null,
      existing: existing ? { id: existing.id, name: existing.name } : null,
      family: cell(row, 'Família'), porter: /^(s|si|sí|x|1|yes|true)$/i.test(cell(row, 'Porter')), notes: cell(row, 'Notes'),
    });
  }
  return items;
}

const applyImport = (db, items) => db.transaction(() => {
  let created = 0;
  let updated = 0;
  for (const it of items) {
    let id = it.existing?.id;
    if (id) {
      // Es queda el nom més complet (el de les actes sol tenir els dos cognoms).
      const current = db.prepare('SELECT name FROM people WHERE id = ?').get(id).name;
      const name = E.nameTokens(current).length > E.nameTokens(it.name).length ? current : it.name;
      db.prepare(`UPDATE people SET name = ?, family = COALESCE(NULLIF(?, ''), family), porter = MAX(porter, ?), notes = COALESCE(NULLIF(?, ''), notes),
        player_id = COALESCE(player_id, ?), auto = 0 WHERE id = ?`).run(name, it.family, it.porter ? 1 : 0, it.notes, it.playerId, id);
      updated++;
    } else {
      const clash = it.playerId && db.prepare('SELECT 1 FROM people WHERE player_id = ?').get(it.playerId);
      id = db.prepare('INSERT INTO people (name, family, porter, notes, player_id) VALUES (?, ?, ?, ?, ?)')
        .run(it.name, it.family || null, it.porter ? 1 : 0, it.notes || null, clash ? null : it.playerId).lastInsertRowid;
      created++;
    }
    for (const t of it.teams) {
      db.prepare('INSERT INTO person_teams (person_id, team_id, role) VALUES (?, ?, ?) ON CONFLICT(person_id, team_id) DO UPDATE SET role = excluded.role').run(id, t.teamId, t.role);
    }
  }
  return { created, updated };
})();

function exportWorkbook(db) {
  const teams = new Map(db.prepare('SELECT t.*, c.name AS competition_name FROM teams t LEFT JOIN competitions c ON c.id = t.competition_id').all().map((t) => [t.id, t]));
  const label = (t) => E.teamLabel(t, t.competition_name);
  const rows = peopleWithTeams(db, getConfig(db).minAppearances).filter((p) => p.active).map((p) => {
    const own = (role) => p.teams.filter((x) => x.role === role && teams.get(x.teamId)?.own).map((x) => label(teams.get(x.teamId))).join(', ');
    const ext = p.teams.filter((x) => !teams.get(x.teamId)?.own).map((x) => {
      const t = teams.get(x.teamId);
      return t ? `${E.titleCase(t.name)} | ${t.competition_name}` : '';
    }).filter(Boolean).join('; ');
    return [E.titleCase(p.name), own('juga'), own('entrena'), own('ajuda'), ext, p.family || '', p.porter ? 'Sí' : '', p.notes || '', p.player_id || ''];
  });
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([COLS, ...rows]);
  ws['!cols'] = [28, 26, 26, 20, 44, 16, 7, 30, 10].map((wch) => ({ wch }));
  XLSX.utils.book_append_sheet(wb, ws, 'Persones');
  const help = XLSX.utils.aoa_to_sheet([
    ['Com omplir-ho'],
    ['Una fila per persona. Equips del club separats per comes, amb aquests noms (o el nom curt de Configuració):'],
    ...clubTeams(db).map((t) => [t.label]),
    [''],
    ['Altres equips: Equip | Competició, separats per punt i coma. Ex.: Vicio Phc Sant Cugat | FEM 19'],
    ['Porter: Sí. ID jok: vincula amb les actes (no cal per als entrenadors).'],
  ]);
  XLSX.utils.book_append_sheet(wb, help, 'Ajuda');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

module.exports = { COLS, previewImport, applyImport, exportWorkbook, makeClubResolver, resolveExternal };
