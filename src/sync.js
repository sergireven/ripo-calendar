/**
 * Sincronització diària: competicions (FECAPA + OK Liga de la RFEP) → partits, canvis,
 * actes dels equips del club, conflictes nous i un sol correu d'avís.
 */
'use strict';

const E = require('./engine');
const { getSetting, setSetting } = require('./db');
const { CLUB_RE, analyze, findPersonByName, todayKey } = require('./data');
const { activeSeason } = require('./sidgad');

const RFEP_FILTER = new RegExp(process.env.RFEP_FILTER || 'OK LIGA', 'i');
const ACTA_LIMIT = Number(process.env.ACTA_LIMIT || 60);
let running = null;

function seasonLabel(now = new Date()) {
  const y = now.getFullYear();
  const start = now.getMonth() >= 7 ? y : y - 1;
  return `${start}-${String(start + 1).slice(2)}`;
}

const slot = (m) => (m ? `${m.date || '?'} ${m.time || ''}`.trim() : null);

function createSync(db, { client, mailer, appUrl = process.env.APP_URL || '' } = {}) {
  const q = {
    competition: db.prepare('SELECT * FROM competitions WHERE source = ? AND source_id = ?'),
    insertCompetition: db.prepare('INSERT INTO competitions (source, source_id, master_id, name, season) VALUES (?, ?, ?, ?, ?)'),
    updateCompetition: db.prepare('UPDATE competitions SET master_id = ?, name = ?, season = ? WHERE id = ?'),
    team: db.prepare('SELECT * FROM teams WHERE competition_id = ? AND source_id = ?'),
    insertTeam: db.prepare('INSERT INTO teams (competition_id, source_id, name, own) VALUES (?, ?, ?, ?)'),
    updateTeamName: db.prepare('UPDATE teams SET name = ? WHERE id = ?'),
    match: db.prepare('SELECT * FROM matches WHERE source_key = ?'),
    insertMatch: db.prepare(`INSERT INTO matches (competition_id, source_key, idp, jornada, home_team_id, away_team_id, home_name, away_name, date, time, played, score)
      VALUES (@competition_id, @source_key, @idp, @jornada, @home_team_id, @away_team_id, @home_name, @away_name, @date, @time, @played, @score)`),
    updateMatch: db.prepare(`UPDATE matches SET idp = COALESCE(@idp, idp), jornada = @jornada, home_team_id = @home_team_id, away_team_id = @away_team_id, home_name = @home_name,
      away_name = @away_name, date = @date, time = @time, played = @played, score = @score, status = 'actiu', updated_at = datetime('now') WHERE id = @id`),
    activeOfCompetition: db.prepare("SELECT * FROM matches WHERE competition_id = ? AND origin = 'font' AND status = 'actiu'"),
    removeMatch: db.prepare("UPDATE matches SET status = 'eliminat', updated_at = datetime('now') WHERE id = ?"),
    isOwnTeam: db.prepare('SELECT own FROM teams WHERE id = ?'),
    change: db.prepare('INSERT INTO match_changes (match_id, type, before, after) VALUES (?, ?, ?, ?)'),
    followed: db.prepare('SELECT master_id, MAX(follow) AS follow FROM competitions WHERE source = ? GROUP BY master_id'),
  };
  const isOwn = (teamId) => Boolean(teamId && q.isOwnTeam.get(teamId)?.own);

  function upsertTeam(competitionId, sourceId, name) {
    if (!name) return null;
    const key = sourceId || `nom:${E.norm(name)}`;
    const row = q.team.get(competitionId, key);
    if (row) {
      if (row.name !== name) q.updateTeamName.run(name, row.id);
      return row.id;
    }
    return q.insertTeam.run(competitionId, key, name, CLUB_RE.test(name) ? 1 : 0).lastInsertRowid;
  }

  /** Desa el calendari d'una competició mestra. Retorna { matches, changes: [ids de match_changes] }. */
  const saveCalendar = db.transaction((source, masterId, rows, season) => {
    const changes = [];
    let count = 0;
    const groups = new Map();
    for (const r of rows) {
      if (!groups.has(r.groupId)) groups.set(r.groupId, []);
      groups.get(r.groupId).push(r);
    }
    for (const [groupId, list] of groups) {
      let comp = q.competition.get(source, groupId);
      const isNewCompetition = !comp;
      const name = list.find((r) => r.groupName)?.groupName || `Grup ${groupId}`;
      if (comp) q.updateCompetition.run(masterId, name, season, comp.id);
      else comp = { id: q.insertCompetition.run(source, groupId, masterId, name, season).lastInsertRowid };
      const seen = new Set();
      for (const r of list) {
        // Clau estable: l'idp només apareix quan el partit té acta.
        const key = `${source}:${groupId}:${r.jornada}:${r.homeId || E.norm(r.home)}:${r.awayId || E.norm(r.away)}`;
        seen.add(key);
        const data = {
          competition_id: comp.id, source_key: key, idp: r.idp || null, jornada: r.jornada,
          home_team_id: upsertTeam(comp.id, r.homeId, r.home), away_team_id: upsertTeam(comp.id, r.awayId, r.away),
          home_name: r.home, away_name: r.away, date: r.date || null, time: r.time || null, played: r.played ? 1 : 0, score: r.score,
        };
        const old = q.match.get(key);
        const own = isOwn(data.home_team_id) || isOwn(data.away_team_id);
        if (!old) {
          const id = q.insertMatch.run(data).lastInsertRowid;
          if (own && !isNewCompetition && !data.played) changes.push(q.change.run(id, 'nou', null, slot(data)).lastInsertRowid);
        } else {
          q.updateMatch.run({ ...data, id: old.id });
          const moved = old.status === 'actiu' && (old.date !== data.date || old.time !== data.time);
          if (own && moved && !data.played) changes.push(q.change.run(old.id, 'canvi', slot(old), slot(data)).lastInsertRowid);
        }
        count++;
      }
      // Partits que ja no surten (només si el grup ha arribat sencer, que ve amb files).
      for (const m of q.activeOfCompetition.all(comp.id)) {
        if (seen.has(m.source_key) || m.played) continue;
        q.removeMatch.run(m.id);
        if (isOwn(m.home_team_id) || isOwn(m.away_team_id)) changes.push(q.change.run(m.id, 'eliminat', slot(m), null).lastInsertRowid);
      }
    }
    return { matches: count, changes };
  });

  /** Propostes que la federació ja ha oficialitzat. */
  function markOfficialProposals() {
    return db.prepare(`UPDATE proposals SET status = 'oficial', decided_at = datetime('now')
      WHERE status IN ('pendent', 'acceptada') AND EXISTS (SELECT 1 FROM matches m WHERE m.id = proposals.match_id AND m.date = proposals.new_date AND m.time = proposals.new_time)`).run().changes;
  }

  /** Actes dels partits jugats dels equips del club: qui juga, qui entrena i qui és delegat. */
  async function loadActas(errors) {
    const pending = db.prepare(`SELECT m.*, c.source, c.source_id AS group_id FROM matches m JOIN competitions c ON c.id = m.competition_id
      WHERE m.played = 1 AND m.acta_loaded = 0 AND m.status = 'actiu' AND m.idp IS NOT NULL
        AND (m.home_team_id IN (SELECT id FROM teams WHERE own = 1) OR m.away_team_id IN (SELECT id FROM teams WHERE own = 1))
      ORDER BY m.date DESC LIMIT ?`).all(ACTA_LIMIT);
    const byPlayer = db.prepare('SELECT * FROM people WHERE player_id = ?');
    const createPerson = db.prepare('INSERT INTO people (name, player_id, auto) VALUES (?, ?, 1)');
    const setPlayerId = db.prepare('UPDATE people SET player_id = ? WHERE id = ?');
    const appear = db.prepare('INSERT OR IGNORE INTO appearances (match_id, person_id, team_id, role) VALUES (?, ?, ?, ?)');
    const done = db.prepare('UPDATE matches SET acta_loaded = ? WHERE id = ?');
    let loaded = 0;
    for (const m of pending) {
      const idp = m.idp;
      let acta;
      try { acta = await client.acta(m.source, idp, m.group_id); } catch (err) { errors.push(`Acta ${idp}: ${err.message}`); continue; }
      const empty = !acta.home.players.length && !acta.away.players.length;
      const old = (Date.now() - Date.parse(m.date)) > 14 * 86400000;
      db.transaction(() => {
        for (const [side, teamId] of [['home', m.home_team_id], ['away', m.away_team_id]]) {
          if (!isOwn(teamId)) continue;
          for (const p of acta[side].players) {
            let person = byPlayer.get(p.id);
            if (!person) {
              const byName = findPersonByName(db, p.name, { onlyWithoutPlayerId: true });
              if (byName) { setPlayerId.run(p.id, byName.id); person = byName; } else person = { id: createPerson.run(E.titleCase(p.name), p.id).lastInsertRowid };
            }
            appear.run(m.id, person.id, teamId, 'juga');
          }
          for (const s of acta[side].staff) {
            const person = findPersonByName(db, s.name) || { id: createPerson.run(E.titleCase(s.name), null).lastInsertRowid };
            appear.run(m.id, person.id, teamId, s.role);
          }
        }
        if (!empty || old) done.run(empty ? 2 : 1, m.id);
      })();
      if (!empty) loaded++;
    }
    return loaded;
  }

  function newBlockConflicts() {
    const { conflicts } = analyze(db);
    const blocks = conflicts.filter((c) => c.severity === 'block');
    const prev = getSetting(db, 'last_block_ids', null);
    setSetting(db, 'last_block_ids', blocks.map((c) => c.id));
    if (!prev) return [];
    const before = new Set(prev);
    return blocks.filter((c) => !before.has(c.id));
  }

  function describeChange(id) {
    const ch = db.prepare(`SELECT mc.*, m.home_name, m.away_name, m.home_team_id, m.away_team_id, c.name AS competition_name
      FROM match_changes mc JOIN matches m ON m.id = mc.match_id LEFT JOIN competitions c ON c.id = m.competition_id WHERE mc.id = ?`).get(id);
    const own = db.prepare('SELECT * FROM teams WHERE id IN (?, ?) AND own = 1').get(ch.home_team_id, ch.away_team_id);
    const label = own ? E.teamLabel(own, ch.competition_name) : ch.competition_name;
    const what = ch.type === 'canvi' ? `${ch.before} → ${ch.after}` : ch.type === 'nou' ? `nou: ${ch.after}` : `ja no surt (era ${ch.before})`;
    return `• ${label} · ${E.titleCase(ch.home_name)} – ${E.titleCase(ch.away_name)}: ${what}\n  ${appUrl}/partits/${ch.match_id}`;
  }

  function describeConflict(c) {
    const who = c.people.length ? ` (${c.people.map((p) => E.titleCase(p.name)).join(', ')})` : '';
    const pair = c.a.matchId === c.b.matchId ? `${c.a.time} ${c.a.label}` : `${c.a.time} ${c.a.label} ↔ ${c.b.time} ${c.b.label}`;
    return `• ${c.a.dayKey} · ${pair}: ${c.message}${who}\n  ${appUrl}/partits/${c.a.matchId}`;
  }

  async function notify({ changes, blocks, errors }) {
    if (!changes.length && !blocks.length && !errors.length) return null;
    const to = [
      ...db.prepare("SELECT email FROM users WHERE role = 'coordinador'").all().map((u) => u.email),
      ...String(getSetting(db, 'alert_emails', '') || '').split(/[,;\s]+/),
    ].filter(Boolean);
    const parts = [];
    if (changes.length) parts.push(`CANVIS A LA FEDERACIÓ (${changes.length})\n${changes.map(describeChange).join('\n')}`);
    if (blocks.length) parts.push(`BLOQUEJOS NOUS (${blocks.length})\n${blocks.map(describeConflict).join('\n')}`);
    if (errors.length) parts.push(`ERRORS DE LECTURA (${errors.length}) — no s'ha esborrat res\n${errors.slice(0, 10).map((e) => `• ${e}`).join('\n')}`);
    const subject = [
      changes.length && `${changes.length} canvi${changes.length > 1 ? 's' : ''}`,
      blocks.length && `${blocks.length} bloqueig${blocks.length > 1 ? 's' : ''} nou${blocks.length > 1 ? 's' : ''}`,
      errors.length && 'errors de lectura',
    ].filter(Boolean).join(' i ');
    return mailer.send(to, `[Calendari CH Ripollet] ${subject}`, `${parts.join('\n\n')}\n\nCalendari: ${appUrl}/`);
  }

  async function run({ only } = {}) {
    if (running) return running;
    running = (async () => {
      const runId = db.prepare('INSERT INTO sync_runs DEFAULT VALUES').run().lastInsertRowid;
      const errors = [];
      let matches = 0;
      const changeIds = [];
      try {
        const season = seasonLabel();
        for (const source of ['fecapa', 'rfep']) {
          let list;
          try { list = await client.competitions(source); } catch (err) { errors.push(`Llista ${source}: ${err.message}`); continue; }
          const temp = activeSeason(list);
          const skip = new Set(q.followed.all(source).filter((r) => !r.follow).map((r) => r.master_id));
          const masters = list.filter((c) => c.temp === temp && !skip.has(c.id) && (source === 'fecapa' || RFEP_FILTER.test(c.name)) && (!only || only.includes(c.id)));
          for (const master of masters) {
            try {
              const rows = await client.calendar(source, master.id);
              if (!rows.length) continue;
              const res = saveCalendar(source, master.id, rows, season);
              matches += res.matches;
              changeIds.push(...res.changes);
            } catch (err) { errors.push(`${master.name}: ${err.message}`); }
          }
        }
        markOfficialProposals();
        await loadActas(errors);
        const blocks = newBlockConflicts();
        await notify({ changes: changeIds, blocks, errors });
        db.prepare("UPDATE sync_runs SET finished_at = datetime('now'), ok = ?, matches = ?, changes = ?, new_blocks = ?, errors = ? WHERE id = ?")
          .run(errors.length ? 0 : 1, matches, changeIds.length, blocks.length, errors.join('\n') || null, runId);
        return { ok: !errors.length, matches, changes: changeIds.length, newBlocks: blocks.length, errors };
      } catch (err) {
        errors.push(err.message);
        db.prepare("UPDATE sync_runs SET finished_at = datetime('now'), ok = 0, errors = ? WHERE id = ?").run(errors.join('\n'), runId);
        await notify({ changes: [], blocks: [], errors }).catch(() => {});
        return { ok: false, matches, changes: changeIds.length, newBlocks: 0, errors };
      }
    })();
    try { return await running; } finally { running = null; }
  }

  return { run, isRunning: () => Boolean(running) };
}

/** Propera execució diària a les HH:00 de Madrid (sense dependències). */
function msUntilNext(hour, now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Madrid', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(now).filter((p) => p.type !== 'literal').map((p) => [p.type, Number(p.value)]));
  const madridNowAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour % 24, parts.minute, parts.second);
  let target = Date.UTC(parts.year, parts.month - 1, parts.day, hour, 0, 0);
  if (target <= madridNowAsUtc) target += 86400000;
  return target - madridNowAsUtc;
}

function scheduleDaily(fn, hour = Number(process.env.SYNC_HOUR || 7)) {
  let timer;
  const plan = () => {
    timer = setTimeout(async () => {
      try { await fn(); } catch (err) { console.error('[sync]', err); }
      plan();
    }, msUntilNext(hour));
    timer.unref?.();
  };
  plan();
  return () => clearTimeout(timer);
}

module.exports = { createSync, scheduleDaily, msUntilNext, seasonLabel, todayKey };
