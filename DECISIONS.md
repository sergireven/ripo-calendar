# Decisions

Registre curt de les decisions preses durant la construcció. La més nova, a baix.

## 1. Font de dades: portal oficial de la FECAPA (sidgad), sense navegador

Spike fet el 29/10/2026 amb un workflow temporal de GitHub Actions (el sandbox no té sortida a aquests dominis).

La FECAPA (`hoqueipatins.fecapa.cat`) i la RFEP (`hockeypatines.fep.es`) fan servir el mateix programari, **sidgad**. Tot es pot llegir amb `fetch` des de Node **només afegint la capçalera `Referer`** (i `Origin`) del portal. Sense `Referer` el servidor respon 200 amb el cos buit.

| Què | Petició | Resposta |
|---|---|---|
| Llista de competicions | `GET https://www.server2.sidgad.es/fecapa/fecapa_ls_1.php` | HTML amb `<a class="idc_master temp_{temporada}" id="{id}" name="{nom}">`. La temporada activa és la `temp_` més alta (2026-27 = 41). FECAPA: 58 competicions; RFEP (`rfep/rfep_ls_1.php`): 9. |
| Calendari | `POST https://www.server2.sidgad.es/fecapa/fecapa_cal_idc_{id}_1.php` amb `idc={id}&site_lang=ca` | Una taula `content_fase_{grup}` per grup. Demanant la competició mestra (p. ex. 4810 *Benjamí Or Barcelona*) arriben **tots els grups** (4945–4950). Cada fila: `team_{idLocal} team_{idVisitant}`, data, hora, jornada, noms, resultat i `idp` (id del partit). |
| Acta | `POST https://www.server2.sidgad.es/fecapa/fecapa_gr_{idp}_1.php` amb `idm=1&idc={grup}&idp={idp}&tab=tab_ficha_resumen` | Dues taules de jugadors (local i visitant) amb `id_player` i nom, i el **cos tècnic** de cada equip (E1 = entrenador, D = delegat…). |
| RFEP | El mateix amb `rfep/rfep_cal_idc_{id}_1.php` i `Referer: https://www.hockeypatines.fep.es/` | OK Liga 2026-27: 7 lligues, 182 partits cadascuna. |

**Decisió:** FECAPA i RFEP directes per HTTP, un sol parser per a les dues. Ni jok.cat ni Puppeteer. Els ids són els mateixos que fa servir jok.cat (`idp` = id d'acta; `id_player` = id de jugador), així que l'"ID jok" de l'Excel serveix tal qual.

**Volum:** la sincronització diària demana les ~58 competicions de la FECAPA i les 7 de l'OK Liga (uns 15 MB, menys d'un minut). Es desen tots els partits (uns 13.000 a SQLite, trivial) perquè així qualsevol equip d'un altre club on jugui algú del club ja hi és, sense haver de gestionar a mà quines competicions se segueixen. A Configuració es pot desmarcar una competició per no llegir-la.

**Actes:** només dels partits jugats d'equips del club, una sola vegada per partit, com a màxim 60 per execució. Omplen automàticament qui juga, qui entrena i qui és delegat de cada equip.

Fixtures a `test/fixtures/` (retallades de les respostes reals).

## 2. `xlsx` del registre npm (0.18.5)

La versió nova de SheetJS només es publica al seu CDN, que no és accessible des d'aquí. La 0.18.5 té avisos coneguts (prototype pollution i ReDoS en fitxers maliciosos). Risc acceptat: només els coordinadors, autenticats, poden pujar fitxers, i es limita la mida a 2 MB.

## 3. Rellotge de la tasca diària sense `node-cron`

Un `setTimeout` que calcula la propera 07:00 d'Europe/Madrid amb `Intl` i es reprograma. Una dependència menys.

## 4. Persones: manual + actes

- `person_teams` guarda només el que diu el coordinador (Excel o fitxa). Rol `cap` = "treu aquest equip encara que surti a les actes".
- `appearances` guarda qui ha sortit a cada acta. Els equips "automàtics" d'una persona són els que apareixen en almenys N actes (Configuració, per defecte 1).
- Una persona de l'Excel es vincula amb les actes per `ID jok` o pel nom (tots els mots del nom curt dins del nom complet, si només hi ha una coincidència).
- El cos tècnic de les actes no té id: s'enllaça pel nom amb el mateix criteri.
