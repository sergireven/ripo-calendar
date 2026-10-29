// Sincronitza ara (fora del servidor): node scripts/sync-now.js
require('dotenv').config({ quiet: true });
const { openDb } = require('../src/db');
const { createClient } = require('../src/sidgad');
const { createMailer } = require('../src/mailer');
const { createSync } = require('../src/sync');

(async () => {
  const db = openDb();
  const t0 = Date.now();
  const res = await createSync(db, { client: createClient(), mailer: createMailer(db) }).run();
  console.log(JSON.stringify({ ...res, seconds: Math.round((Date.now() - t0) / 1000) }, null, 1));
  db.close();
  process.exit(res.ok ? 0 : 1);
})();
