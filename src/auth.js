'use strict';

const bcrypt = require('bcryptjs');
const session = require('express-session');

/** Sessions a la mateixa base de dades SQLite (sobreviuen als reinicis). */
class SqliteStore extends session.Store {
  constructor(db) {
    super();
    this.q = {
      get: db.prepare('SELECT data FROM sessions WHERE sid = ? AND expires > ?'),
      set: db.prepare('INSERT OR REPLACE INTO sessions (sid, data, expires) VALUES (?, ?, ?)'),
      del: db.prepare('DELETE FROM sessions WHERE sid = ?'),
      touch: db.prepare('UPDATE sessions SET expires = ? WHERE sid = ?'),
    };
    db.prepare('DELETE FROM sessions WHERE expires <= ?').run(Date.now());
  }

  expiry(sess) { return Date.now() + (sess?.cookie?.maxAge ?? 86400000); }
  get(sid, cb) { try { const r = this.q.get.get(sid, Date.now()); cb(null, r ? JSON.parse(r.data) : null); } catch (e) { cb(e); } }
  set(sid, sess, cb) { try { this.q.set.run(sid, JSON.stringify(sess), this.expiry(sess)); cb?.(null); } catch (e) { cb?.(e); } }
  destroy(sid, cb) { try { this.q.del.run(sid); cb?.(null); } catch (e) { cb?.(e); } }
  touch(sid, sess, cb) { try { this.q.touch.run(this.expiry(sess), sid); cb?.(null); } catch (e) { cb?.(e); } }
}

function upsertUser(db, { email, name, role = 'entrenador', password, personId = null }) {
  const hash = bcrypt.hashSync(String(password), 10);
  const mail = String(email).trim().toLowerCase();
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(mail);
  if (existing) {
    db.prepare('UPDATE users SET name = ?, role = ?, password_hash = ?, person_id = ? WHERE id = ?').run(name, role, hash, personId, existing.id);
    return existing.id;
  }
  return db.prepare('INSERT INTO users (email, name, role, password_hash, person_id) VALUES (?, ?, ?, ?, ?)').run(mail, name, role, hash, personId).lastInsertRowid;
}

/** Primer coordinador des de l'entorn (útil a Railway, sense consola). No en canvia la contrasenya si ja existeix. */
function bootstrapAdmin(db) {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) return;
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email.trim().toLowerCase())) return;
  upsertUser(db, { email, name: process.env.ADMIN_NAME || 'Coordinador', role: 'coordinador', password });
  console.log(`Coordinador inicial creat: ${email}`);
}

function checkPassword(db, email, password) {
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email || '').trim().toLowerCase());
  return user && bcrypt.compareSync(String(password || ''), user.password_hash) ? user : null;
}

function requireLogin(req, res, next) {
  if (req.user) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Cal entrar' });
  // Només pàgines: el navegador també demana /favicon.ico i similars, i no hi volem tornar després d'entrar.
  if (req.method === 'GET' && !/\.[a-z0-9]+$/i.test(req.path)) req.session.returnTo = req.originalUrl;
  return res.redirect('/entrar');
}

function requireCoordinator(req, res, next) {
  if (req.user?.role === 'coordinador') return next();
  return res.status(403).render('error', { title: 'Sense permís', message: 'Només els coordinadors poden fer aquesta acció.' });
}

/** Limitador senzill en memòria per a l'entrada (per IP). */
function rateLimit({ windowMs = 15 * 60 * 1000, max = 10 } = {}) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const e = hits.get(req.ip);
    if (!e || e.reset < now) hits.set(req.ip, { count: 1, reset: now + windowMs });
    else if (++e.count > max) return res.status(429).render('error', { title: 'Massa intents', message: 'Espera uns minuts i torna-ho a provar.' });
    next();
  };
}

module.exports = { SqliteStore, upsertUser, bootstrapAdmin, checkPassword, requireLogin, requireCoordinator, rateLimit };
