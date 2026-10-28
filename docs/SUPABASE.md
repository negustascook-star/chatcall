# Supabase prijungimas

Šio prototipo projektas: `lzongluhbmyasadscuri`.

API adresas: `https://lzongluhbmyasadscuri.supabase.co`.

## Paleidimas su turima duomenų baze

1. Nukopijuok `.env.example` į `.env` projekto šaknyje.
2. `.env` faile nustatyk:

   ```dotenv
   CATALOG_SOURCE=supabase
   SUPABASE_URL=https://lzongluhbmyasadscuri.supabase.co
   SUPABASE_TENANT_ID=demo-tire
   SUPABASE_SECRET_KEY=IRASYK_SAVO_SERVERIO_SECRET_KEY
   ```

   Serverio raktą rasi Supabase projekto **Settings → API Keys → Secret keys**.
   Galima naudoti ir senesnį `service_role` raktą: tuomet vietoj `SUPABASE_SECRET_KEY`
   nustatyk `SUPABASE_SERVICE_ROLE_KEY`. `publishable` / `anon` raktas šiam serverio
   adapteriui netinka, nes SQL lentelėse įjungta RLS ir tiesioginė kliento prieiga uždaryta.

   Tikros reikšmės laikomos vietiniame `.env` arba hostingo aplinkos kintamuosiuose.
   Į naršyklės HTML kodą dedami tik API užklausų adresai. `.env` ignoruojamas Git.

3. Paleisk:

   ```bash
   npm ci
   npm run api
   ```

   Automatiškai įkelti `.env` reikia Node.js **20.12 arba naujesnio**. Hostingo
   aplinkos kintamieji veikia ir be `.env` failo. Jau nustatyti aplinkos kintamieji turi pirmenybę.

4. Patikrink:

   ```bash
   curl http://localhost:3000/health
   curl http://localhost:3000/api/tenants
   ```

   `/health` rodo pasirinktą režimą (`catalogSource: "supabase"`); šis maršrutas pats
   duomenų bazės netikrina. `/api/tenants` jau skaito katalogą iš Supabase.
   Su mūsų SQL demonstraciniais duomenimis `demo-tire` turės vieną paslaugą ir dvi prekes.

5. Atidaryk `index.html` ir naudok esamą „Live API demo“. API prisijungimo lauke
   įrašyk savo paleisto ChatCall serverio adresą. Pradėk naują pokalbį ir parašyk:
   `Ieškau 4 žieminių padangų 205/55 R16`. Kataloge esanti kaina yra 65 EUR už vieną
   demonstracinę R16 padangą. Pakeitus kainą Supabase ir pradėjus naują pokalbį,
   API naudos naują reikšmę.

## Kas prijungta

`services` ir `inventory` lentelės yra paslaugų ir sandėlio duomenų šaltinis
esamam HTTP API ir jo pokalbio agentui. Katalogas įkeliamas naujo pokalbio pradžioje.
Įjungus Supabase režimą, ryšio ar duomenų klaida grąžinama kaip klaida; JSON kainomis ji nekeičiama.

Ši penkių lentelių SQL schema skirta **vienam autoservisui**. `SUPABASE_TENANT_ID`
priskiria ją konkrečiam tenant'ui; kiti tenant'ai ir toliau naudoja savo JSON failus.
Įmonės kontaktai, DUK, transkriptai ir klientų poreikiai lieka esamoje failų saugykloje.

`time_slots`, `mechanics` ir `bookings` lentelės išsaugotos SQL schemoje kitam
rezervavimo etapui. Esama pokalbio rezervavimo logika vis dar kuria
`pending_confirmation` poreikį failuose; ji šiuo pakeitimu netampa patvirtintu vizitu Supabase kalendoriuje.
Tiekėjo kainos ir pristatymo terminai `seed.sql` faile yra demonstraciniai.

Grįžti prie JSON katalogo galima nustatant `CATALOG_SOURCE=json` ir perkraunant API.

## SQL failai ir GitHub integracija

- `supabase/migrations/20261028140000_initial_autoservice.sql` – penkios lentelės,
  jų ryšiai, kainų ir kiekių apribojimai, RLS bei serverio prieigos teisės.
- `supabase/seed.sql` – atskiri demonstraciniai duomenys: du meistrai, viena paslauga,
  dvi prekės ir 40 laikų artimiausioms penkioms savaitės darbo dienoms.
- `supabase/config.toml` – vietinio Supabase projekto ir demonstracinių duomenų konfigūracija.

Jei mūsų pradinis SQL jau paleistas šiame Supabase projekte, API prijungimui
SQL pakartotinai vykdyti nereikia. Jau turimų duomenų šie failai neeksportuoja.

Norint prijungti repozitoriją per Supabase **Project Settings → Integrations → GitHub**,
darbinis katalogas yra `.` – jis turi repo šaknyje esantį `supabase/` katalogą.
GitHub diegimo nustatymai ir API serverio aplinkos kintamieji valdomi atskirai:
vien repo autorizacija nenustato `SUPABASE_SECRET_KEY` Node serveriui.

## Patikra

```bash
npm test
npm run typecheck
```

Supabase adapterio testai naudoja imituotą HTTP atsakymą. Jie tikrina stulpelių
atitikimą, kainų ir likučių nuskaitymą, puslapiavimą, tenant'ų izoliaciją, klaidas
ir visą HTTP pokalbio kelią. Gyvą ryšį patikrina `/api/tenants`, kai privačioje
serverio aplinkoje nustatytas tikras raktas.
