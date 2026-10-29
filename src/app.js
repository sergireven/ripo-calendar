'use strict';

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const { SqliteStore, requireLogin } = require('./auth');
const { createMailer } = require('./mailer');
const { createSync } = require('./sync');
const { createClient } = require('./sidgad');
const helpers = require('./helpers');

const ASSET_VERSION = Date.now().toString(36);

function createApp(db, options = {}) {
  const app = express();
  const mailer = options.mailer || createMailer(db);
  const sync = options.sync || createSync(db, { client: options.client || createClient(), mailer });
  const ctx = { db, mailer, sync };

  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  if (process.env.TRUST_PROXY) app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('X-Frame-Options', 'DENY');
    res.set('Referrer-Policy', 'same-origin');
    Object.assign(res.locals, helpers, { user: null, csrf: '', path: req.path, flash: null, assetVersion: ASSET_VERSION, unseen: 0 });
    next();
  });
  app.get('/healthz', (req, res) => res.json({ ok: true }));
  app.get('/favicon.ico', (req, res) => res.type('image/svg+xml').send('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">🏒</text></svg>'));
  app.use('/static', express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h' }));
  app.use(express.urlencoded({ extended: false, limit: '200kb' }));

  app.use(session({
    store: new SqliteStore(db),
    name: 'ripo.cal',
    secret: process.env.SESSION_SECRET || 'canvia-aquest-secret',
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.COOKIE_SECURE === 'true', maxAge: 1000 * 60 * 60 * 24 * 30 },
  }));

  const getUser = db.prepare('SELECT * FROM users WHERE id = ?');
  const unseen = db.prepare(`SELECT COUNT(*) AS n FROM match_changes WHERE seen = 0`);
  app.use((req, res, next) => {
    if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
    req.user = req.session.userId ? getUser.get(req.session.userId) : null;
    Object.assign(res.locals, {
      user: req.user, csrf: req.session.csrf, flash: req.session.flash || null,
      unseen: req.user ? unseen.get().n : 0, isCoord: req.user?.role === 'coordinador',
    });
    delete req.session.flash;
    req.flash = (type, text) => { req.session.flash = { type, text }; };
    next();
  });

  // CSRF per a tots els formularis (els multipart porten el token a la URL).
  app.use((req, res, next) => {
    if (req.method !== 'POST') return next();
    const token = String(req.body?._csrf || req.query._csrf || '');
    const expected = req.session.csrf || '';
    if (token.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected))) {
      return res.status(403).render('error', { title: 'Formulari caducat', message: 'Torna enrere, recarrega la pàgina i torna-ho a provar.' });
    }
    next();
  });

  require('./routes/auth')(app, ctx);
  app.use(requireLogin);
  require('./routes/calendar')(app, ctx);
  require('./routes/people')(app, ctx);
  require('./routes/pista')(app, ctx);
  require('./routes/admin')(app, ctx);

  app.use((req, res) => res.status(404).render('error', { title: 'No trobat', message: 'Aquesta pàgina no existeix.' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).render('error', { title: 'Error', message: 'Alguna cosa ha fallat. Torna-ho a provar.' });
  });
  return app;
}

module.exports = { createApp };
