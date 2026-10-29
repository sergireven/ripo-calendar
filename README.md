# Calendari CH Ripollet

Web per al coordinador esportiu del Club Hoquei Ripollet: tots els partits del club en un calendari, bloquejos detectats sols, avisos quan la federació mou un partit i un simulador per decidir si s'accepta un canvi.

## Què fa

- **Calendari** (setmana, mes o llista) de tots els equips, amb colors: casa/fora, bloqueig, avís i propostes pendents. Filtre per equip o per persona («agenda»).
- **Bloquejos**: pista ocupada (una sola pista), persones que juguen o entrenen en dos partits que no encaixen (amb el temps de trajecte), franges bloquejades. **Avisos**: ajudants/delegats, germans, marges molt justos.
- **Persones**: jugadors, entrenadors i delegats surten sols de les actes de la FECAPA. S'hi afegeixen equips d'altres clubs, família, porter, notes i comentaris. Importació i exportació en Excel.
- **Pista**: parrilla del pavelló per cap de setmana (lliure, ocupada, solapament, bloquejada), deduïda dels partits programats.
- **Simulador**: «si moc aquest partit a aquesta hora, què passa?», alternatives sense bloquejos i propostes pendents que passen soles a oficials quan la federació les publica.
- **Lectura diària** (07:00) de la FECAPA i l'OK Liga (RFEP) i **un correu** amb els canvis dels partits del club i els bloquejos nous.

Detalls tècnics i per què de cada decisió: [DECISIONS.md](DECISIONS.md). Manual d'una pàgina: [docs/MANUAL.md](docs/MANUAL.md).

## Desplegar a Railway

1. **Nou projecte** → *Deploy from GitHub repo* → `sergireven/ripo-calendar` (branca `main`).
2. **Volum**: al servei, *Settings → Volumes → Add volume*, muntat a `/data`.
3. **Variables** (*Variables*):
   | Variable | Valor |
   |---|---|
   | `DB_PATH` | `/data/calendar.db` |
   | `SESSION_SECRET` | una cadena llarga i aleatòria |
   | `APP_URL` | l'adreça pública (p. ex. `https://ripo-calendar.up.railway.app`) |
   | `COOKIE_SECURE` | `true` |
   | `TRUST_PROXY` | `1` |
   | `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_NAME` | el primer coordinador |
   | `BREVO_API_KEY`, `MAIL_FROM` | correu (opcional, veure a sota) |
4. **Domini**: *Settings → Networking → Generate domain*. Posa'l a `APP_URL`.
5. En arrencar per primer cop es crea el coordinador i, al cap de 10 segons, es fa la primera lectura de la federació (menys d'un minut). Després, cada dia a les 07:00.

**Correu (Brevo).** Railway bloqueja l'SMTP. Crea un compte gratuït a Brevo (300 correus/dia), verifica el remitent a *Senders* i crea una clau a *SMTP & API → API keys*. Sense clau, l'app funciona igual i els correus queden a *Configuració → Usuaris → Darrers correus*.

**Usuaris.** El coordinador en crea més a *Configuració → Usuaris*: coordinadors (ho poden fer tot) o entrenadors (veuen i comenten). Es pot lligar cada usuari a la seva fitxa per tenir «La meva agenda».

## En local

```bash
npm install
cp .env.example .env   # omple ADMIN_EMAIL i ADMIN_PASSWORD
npm run dev            # http://localhost:3000
npm run sync           # llegeix la federació ara
npm test
```

Necessita Node 22. Si l'ordinador no té sortida a `server2.sidgad.es`, la lectura falla però la resta funciona.
