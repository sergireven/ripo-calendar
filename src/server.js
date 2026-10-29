require('dotenv').config({ quiet: true });

const { openDb, getSetting } = require('./db');
const { createApp } = require('./app');
const { bootstrapAdmin } = require('./auth');
const { createSync, scheduleDaily } = require('./sync');
const { createClient } = require('./sidgad');
const { createMailer } = require('./mailer');

if (!process.env.SESSION_SECRET && process.env.NODE_ENV === 'production') {
  console.error('Falta SESSION_SECRET a l\'entorn.');
  process.exit(1);
}

const db = openDb();
bootstrapAdmin(db);
const mailer = createMailer(db);
const sync = createSync(db, { client: createClient(), mailer });
const app = createApp(db, { mailer, sync });

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`Calendari escoltant a http://localhost:${port}`);
  if (!mailer.configured) console.log('Avís: correu no configurat (BREVO_API_KEY); els correus només queden al registre.');
});

// Cada dia a les 07:00 de Madrid. Si encara no s'ha sincronitzat mai, al cap d'uns segons d'arrencar.
scheduleDaily(() => sync.run());
const neverSynced = !db.prepare('SELECT 1 FROM sync_runs WHERE ok = 1 LIMIT 1').get();
if (neverSynced && process.env.NODE_ENV !== 'test' && getSetting(db, 'auto_first_sync', true)) {
  setTimeout(() => sync.run().then((r) => console.log('[sync] primera sincronització', r)), 10000).unref();
}
