# Diegimas Render

Šis dokumentas skirtas ChatCall API paleisti Render hostinge. Svetainė
(`index.html`) yra statinė ir gali būti talpinama atskirai.

## 1. Supabase SQL

Jei projekte `lzongluhbmyasadscuri` dar nebuvo paleista schema, Supabase
**SQL Editor** įvykdykite iš eilės:

1. `supabase/migrations/20261028140000_initial_autoservice.sql`
2. `supabase/seed.sql`

Be šių lentelių API negalės nuskaityti `services` ir `inventory`.

## 2. Render Web Service

### Variantas A: Blueprint

1. Render Dashboard → **New → Blueprint**.
2. Prijunkite GitHub repo `negustascook-star/chatcall`.
3. Render perskaitys `render.yaml` ir paprašys įvesti `SUPABASE_SECRET_KEY`.
4. Įklijuokite **Secret key** reikšmę iš Supabase
   (**Project Settings → API Keys → Secret keys**). Ji prasideda `sb_secret_`.
   Galima naudoti ir seną `service_role` JWT raktą, prasidedantį `eyJ`.
5. Paleiskite deploy.

### Variantas B: Rankinis Web Service

- **Runtime:** Node
- **Build command:** `npm ci --include=dev && npm run typecheck`
- **Start command:** `npm run api`
- **Health check path:** `/health`

Aplinkos kintamieji:

| Kintamasis | Reikšmė |
| --- | --- |
| `CATALOG_SOURCE` | `supabase` |
| `SUPABASE_URL` | `https://lzongluhbmyasadscuri.supabase.co` |
| `SUPABASE_TENANT_ID` | `demo-tire` |
| `SUPABASE_SECRET_KEY` | Jūsų serverio Secret key (tik Render aplinkoje) |
| `DATA_DIR` | `./data` |
| `NODE_VERSION` | `22.20.0` |

`PORT` nustatyti nereikia – Render jį suteikia automatiškai.

`SUPABASE_SECRET_KEY` niekada neįrašykite į GitHub, `render.yaml` ar `.env.example`.
Jį įveskite tik Render **Environment** skiltyje. Jei raktas buvo paviešintas,
sukurkite naują Secret key ir ištrinkite seną.

## 3. Patikra

Po deploy atidarykite:

```text
https://JUSU-SERVISAS.onrender.com/health
https://JUSU-SERVISAS.onrender.com/api/tenants
```

Tikėtina:

- `/health` → `"catalogSource": "supabase"`
- `/api/tenants` → `demo-tire` su 1 paslauga ir 2 sandėlio prekėmis

Tada galima paleisti pokalbį:

```text
Ieškau 4 žieminių padangų 205/55 R16
```

Demonstracinė R16 padanga turi kainuoti 65 EUR už vienetą.

## 4. Svetainė

`index.html` yra statinė svetainė. **Rekomenduojamas variantas:** talpinti ją
tame pačiame Render Web Service kaip ir API. `npm run api` pagrindiniame
maršrute `/` atiduoda `index.html`, o svetainė automatiškai naudoja tą patį
domeną kaip API:

```text
https://JUSU-SERVISAS.onrender.com/        → svetainė
https://JUSU-SERVISAS.onrender.com/api/... → API
```

Jei svetainę talpini atskirai (Render Static Site, GitHub Pages ar kitur),
svetainės lauke **API prisijungimas** įrašyk Render API adresą. API leidžia
CORS užklausas iš kitų domenų. Šiuo metu API neturi autentifikacijos, todėl
viešai atidaryta ji tinka tik demonstracijai.

## 5. Failų saugykla

Nemokamas Render planas turi laikiną diską. Supabase saugomos tik `services` ir
`inventory` lentelės, o klientų poreikiai, transkriptai ir `calls/` failai rašomi
į `DATA_DIR`. Po redeploy ar restart jie gali išnykti.

Jei reikia išsaugoti šiuos failus:

- prijunkite mokamą Render diską ir nustatykite `mountPath`, pvz.
  `/opt/render/project/src/data` (pavyzdys yra `render.yaml` komentaruose);
- arba ateityje perkelkite poreikius ir transkriptus į DB / object storage.

## 6. Lokalus `.env`

Lokaliai galima naudoti `.env` failą (jis ignoruojamas Git):

```dotenv
CATALOG_SOURCE=supabase
SUPABASE_URL=https://lzongluhbmyasadscuri.supabase.co
SUPABASE_TENANT_ID=demo-tire
SUPABASE_SECRET_KEY=JUSU_SECRET_KEY
```

Render atveju `.env` nereikia – naudojami Render aplinkos kintamieji.
