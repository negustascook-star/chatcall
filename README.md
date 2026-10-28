# ChatCall

Inbound AI skambučių centro **verslo logika** (multi-tenant). Tai ne svetainė ir ne UI — tai backend’as, kurį telefonijos adapteris kvies kiekvienam kliento skambučiui.

## Ką daro botas

1. Atsiliepia ir pasisveikina.
2. Išsiaiškina, ko klientui reikia: padangų, paslaugos ar atsakymo į klausimą.
3. Patikrina konkretaus tenant’o sandėlį.
4. Jei prekė yra — pasiūlo variantą, kainą ir rezervuoja laiką.
5. Jei nėra — surenka poreikį (dydis, sezonas, gamintojas, biudžetas), kontaktus ir išsaugo `requests/` kataloge.
6. Atsako į DUK: darbo laikas, adresas, garantija, atsiskaitymas ir t. t.
7. Neaiškaus pokalbio atveju pasiūlo perduoti žmogui.
8. Po pokalbio išsaugo transkriptą ir santrauką `calls/` kataloge.

> **Dabar veikia mock režimu.** Kol nėra Twilio / OpenAI raktų, pokalbis vyksta tekstu per CLI arba HTTP API, o „protas“ yra deterministinis `RuleBasedBrain`. Tai leidžia pilnai testuoti verslo logiką be išorinių paslaugų. Tikras balsas ir telefonija jungiami per atskirus adapterius, neperrašant šios logikos.

## Greitas startas

Reikia Node.js 20.12 ar naujesnio.

### Supabase katalogas

Pridėtas ryšys su Supabase projektu `lzongluhbmyasadscuri`: HTTP API gali skaityti
paslaugas ir padangų likučius iš mūsų sukurtų `services` bei `inventory` lentelių.
Įjungimas, serverio rakto nustatymas ir patikra: **[docs/SUPABASE.md](docs/SUPABASE.md)**.
SQL schema ir demonstraciniai duomenys yra `supabase/` kataloge.

Pagal numatymą lieka `CATALOG_SOURCE=json`. Supabase įjungiamas serverio `.env`
faile nustatant `CATALOG_SOURCE=supabase` ir serverio raktą. `.env` automatinis
įkėlimas palaikomas nuo Node.js 20.12. Rezervacijų kalendoriaus ir išsaugojimo
į `bookings` prijungimas yra kitas etapas.

### Diegimas Render

API paruoštas Render hostingui: `render.yaml` blueprint ir
[docs/RENDER.md](docs/RENDER.md). Serverio `SUPABASE_SECRET_KEY` įvedamas Render
**Environment** skiltyje, o ne į Git ar `.env.example`. Render taip pat gali
talpinti statinę `index.html` svetainę atskirai.

```bash
npm install

# Automatinis demo: 2 scenarijai (yra sandėlyje / nėra sandėlyje)
npm run demo:auto

# Interaktyvus pokalbis terminale
npm run demo

# HTTP API
npm run api

# Testai
npm test

# Tipų patikra
npm run typecheck
```

Interaktyviame demo:

- `/end` — baigti skambutį ir išsaugoti transkriptą
- `/state` — parodyti pokalbio būseną
- `/quit` — baigti ir išeiti

Demo duomenys numatytai rašomi į `data/`, bet galima nurodyti kitą katalogą:

```bash
DATA_DIR=./tmp-data npm run demo
```

PowerShell:

```powershell
$env:DATA_DIR = "$env:TEMP\chatcall-demo"
npm run demo
```

## Pavyzdinis pokalbis

```text
Botas: Sveiki, čia Padangų centras. Kuo galiu padėti?
Jūs: Sveiki, ieškau 205/55 R16 žieminių padangų, Michelin
Botas: Turime jums tinkamų padangų:
• Michelin Alpin 7 205/55 R16 – 129 €/vnt. (8 vnt. sandėlyje; 4 vnt. – 516 €)

Ar norite rezervuoti su montavimu?
Jūs: Taip, noriu rezervuoti
Botas: Puiku. Kaip jus vadinti?
Jūs: Tomas
Botas: Ačiū, Tomas. Kokiu telefono numeriu su jumis susisiekti?
Jūs: +370 600 12345
Botas: Kada jums patogiausia atvykti? Pvz., rytoj 10 val.
Jūs: rytoj 10 val.
Botas: Užregistravau rezervaciją REQ-20261028-A2D1F5. Susisieksime patvirtinti laiko. Ar dar kuo galiu padėti?
```

Jei prekės nėra, botas surenka poreikį ir į `requests/` įrašo, ko klientui reikia, bei kontaktus. Tai tas pats „sąrašas į folderį“, kurį galima atidaryti Excel’yje arba Markdown’e.

## HTTP API

Paleidus `npm run api`, serveris klauso `http://localhost:3000` (galima keisti `PORT`).

| Metodas | Maršrutas | Paskirtis |
| --- | --- | --- |
| `GET` | `/health` | Sveikatos patikra |
| `GET` | `/api/tenants` | Tenant’ų sąrašas |
| `POST` | `/api/calls` | Pradėti skambutį |
| `POST` | `/api/calls/:id/messages` | Nusiųsti kliento repliką |
| `GET` | `/api/calls/:id` | Aktyvaus skambučio būsena |
| `POST` | `/api/calls/:id/end` | Baigti skambutį ir išsaugoti |
| `GET` | `/api/tenants/:id/requests?date=YYYY-MM-DD` | Tenant’o poreikiai |

### Pavyzdys

```bash
curl.exe -X POST http://localhost:3000/api/calls \
  -H "Content-Type: application/json" \
  -d "{\"tenantId\":\"demo-tire\",\"from\":\"+37060011111\"}"

curl.exe -X POST http://localhost:3000/api/calls/CALL_ID/messages \
  -H "Content-Type: application/json" \
  -d "{\"text\":\"Ieškau 205/55 R16 žieminių padangų\"}"

curl.exe -X POST http://localhost:3000/api/calls/CALL_ID/end
```

Skambutį galima pradėti ir pagal skambinamą numerį (tada tenant’as surandamas pagal `tenant.json` telefoną):

```json
{ "to": "+370 600 00000", "from": "+370 600 11111" }
```

## Duomenų struktūra

```text
data/tenants/<tenant-id>/
├── tenant.json          # įmonės pavadinimas, telefonas, pasisveikinimas, adresas, laikas
├── services.json        # paslaugos, kainos, trukmės, raktiniai žodžiai
├── inventory.json       # padangų / dalių likučiai
├── faq.json             # DUK
├── requests/<data>/     # KLIENTŲ POREIKIAI (generuojama)
│   ├── REQ-....json
│   ├── REQ-....md
│   ├── poreikiai.md     # dienos suvestinė žmogui
│   └── poreikiai.csv    # dienos suvestinė Excel’iui
└── calls/<data>/        # TRANSKRIPTAI IR SANTRAUKOS (generuojama)
    ├── call_....json
    └── call_....md
```

`requests/` ir `calls/` yra ignoruojami git’e — realūs klientų duomenys į repo nepatenka.

### Kaip pridėti naują tenant’ą

1. Nukopijuok `data/tenants/demo-tire` į `data/tenants/<naujas-id>`.
2. `tenant.json` pakeisk `id` į naują katalogo pavadinimą, taip pat `name`, `phone`, `greeting`, `address`, `hours`.
3. Pakoreguok `services.json`, `inventory.json`, `faq.json`.
4. Skambučiai į `phone` numerį bus rutinami automatiškai; per API galima nurodyti `tenantId`.

## Kas jau veikia

- Multi-tenant duomenų izoliacija pagal `tenantId`.
- Skambučio rutinimas pagal skambinamą numerį.
- Sandėlio paieška pagal dydį, sezoną, gamintoją ir kiekį.
- Alternatyvūs variantai, kai tikslaus modelio nėra.
- Rezervacija, kai prekė yra.
- Poreikio užsakymas ir kontaktų surinkimas, kai prekės nėra.
- Paslaugų kainos ir rezervacijos.
- DUK atsakymai iš tenant’o žinių bazės.
- Perdavimas žmogui.
- Fallback po dviejų nesuprastų replikų.
- JSON + Markdown + CSV išsaugojimas.
- Transkriptai ir pokalbio santraukos.
- Paslaugų ir sandėlio katalogas iš Supabase (`services`, `inventory`) arba JSON.
- HTTP API ir 24 testai.

## Ko dar nėra

- Tikro balso (STT/TTS), telefonijos Media Streams ir barge-in.
- OpenAI / kito LLM adaptoriaus (dabar `RuleBasedBrain`).
- Realaus kalendoriaus ir dvipusės sandėlio sistemos sinchronizacijos.
- `time_slots` / `bookings` lentelių panaudojimo pokalbio rezervacijai.
- Poreikių ir transkriptų saugojimo DB.
- Admin UI, autentifikacijos, mokėjimų, SMS.
- Eilių / retry logikos.

Šiame repo yra ir statinė Aical demonstracinė svetainė (`index.html`). Jos „Live API demo“ jungiasi prie žemiau aprašytos ChatCall API ir leidžia išbandyti realų `CallAgent` / `RuleBasedBrain` pokalbį. Likę svetainės blokai yra produkto dizaino peržiūra; administravimo, autentifikacijos ir mokėjimų funkcijų jie neteikia.

## Struktūra

```text
src/
├── agent/
│   ├── callAgent.ts       # skambučio orkestratorius, sesijos, išsaugojimas
│   ├── brain.ts           # ConversationBrain sąsaja (mock → LLM)
│   ├── ruleBrain.ts       # deterministinis mock protas
│   └── summary.ts         # pokalbio santrauka
├── inventory/             # sandėlio paieška
├── knowledge/             # DUK ir paslaugų paieška
├── requests/              # poreikių išsaugojimas (JSON/MD/CSV)
├── calls/                 # transkriptų išsaugojimas
├── tenants/               # tenant’ų įkėlimas ir rutinimas
├── supabase/              # Supabase katalogo adapteris
├── lib/                   # tekstas, data, failų saugykla
├── api/                   # HTTP API
└── cli/                   # demo

supabase/
├── config.toml            # vietinio Supabase projekto konfigūracija
├── migrations/            # SQL schema
└── seed.sql               # demonstraciniai duomenys
```

## Testai

```bash
npm test
```

Dengiama:

- sandėlio filtravimas ir alternatyvos;
- sėkmingas rezervavimas, kai prekė yra;
- poreikio išsaugojimas, kai prekės nėra;
- DUK atsakymai;
- paslaugos rezervacija;
- perdavimas žmogui;
- fallback į žmogų ir neteisingo telefono numerio apdorojimas;
- multi-tenant rutinimas pagal telefoną;
- Supabase konfigūracija, katalogo mapinimas, puslapiavimas, klaidos ir tenant’ų izoliacija;
- HTTP API pilnas skambutis ir klaidos.

## Toliau

- Supabase paleidimas ir serverio rakto nustatymas: [docs/SUPABASE.md](docs/SUPABASE.md).
- Diegimas Render: [docs/RENDER.md](docs/RENDER.md).
- Architektūra, būsenų mašina ir Twilio/OpenAI prijungimo planas: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).


## Svetainė ir gyvas API demo

Repo šaknyje esantis `index.html` pateikia AIcall rinkodaros puslapį ir viešą, pavyzdiniais duomenimis pažymėtą `#live-demo`. Demonstracija naudoja viešus demo maršrutus `GET /api/tenants`, `POST /api/calls`, `POST /api/calls/:id/messages` ir `POST /api/calls/:id/end`; jos duomenys nėra savininko darbo aplinkos įrašai.

`auth.html` naudoja Supabase Auth registracijai bei prisijungimui. Sėkmingai prisijungus atidaromas `app.html` – savininko aplinka, kuri skaito / rašo įmonei priklausančius įrašus per RLS apsaugotas Supabase lenteles. Verslo lentelių migracija ir naršyklės publishable key turi būti įdiegti prieš registracijos įjungimą.

Paleisk API (`npm ci`, tada `npm run api`) ir atidaryk `http://localhost:3000/`. Supabase konfigūracija: `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`; katalogo demonstracijai serveriui taip pat reikalingas `SUPABASE_SECRET_KEY`. Niekada neatskleisk serverio rakto naršyklei. Demonstraciniai skambučių API maršrutai nėra autentifikuoti ir turi būti naudojami tik su viešais demonstraciniais tenant duomenimis.

## AIcall verslo aplinka

Savininkų prisijungimas ir verslo duomenys naudoja Supabase Auth bei RLS. Prieš diegiant reikia pritaikyti migraciją `supabase/migrations/20261028170000_business_owner_app.sql` ir nustatyti `SUPABASE_URL` bei `SUPABASE_PUBLISHABLE_KEY` (naršyklei skirtas raktas; `SUPABASE_SECRET_KEY` lieka tik serveryje). `WAREHOUSE_PLAN_PRICE_EUR` yra pasirenkama platformos administratoriaus konfigūracija; jos nenustačius svetainė rodo „Susisiekite dėl kainos“.

Mokėjimų tiekėjas, telefonija ir tiekėjų katalogai šiame diegime dar neprijungti. Todėl pasirinktas planas paskyroje lieka neaktyvus, skambučių / rezervacijų skiltyse rodomos tik realios DB eilutės, o tiekėjo informacija nepateikiama kaip gyva.
