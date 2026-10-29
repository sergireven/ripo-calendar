// Crea o actualitza un usuari: node scripts/create-user.js correu@club.cat "Nom" coordinador|entrenador contrasenya
require('dotenv').config({ quiet: true });
const { openDb } = require('../src/db');
const { upsertUser } = require('../src/auth');

const [email, name, role = 'coordinador', password] = process.argv.slice(2);
if (!email || !name || !password) {
  console.error('Ús: node scripts/create-user.js correu "Nom" coordinador|entrenador contrasenya');
  process.exit(1);
}
upsertUser(openDb(), { email, name, role, password });
console.log(`Usuari ${email} (${role}) desat.`);
