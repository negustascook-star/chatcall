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

Reikia Node.js 20 ar naujesnio.

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
- HTTP API ir 15 testų.

## Ko dar nėra

- Tikro balso (STT/TTS), telefonijos Media Streams ir barge-in.
- OpenAI / kito LLM adaptoriaus (dabar `RuleBasedBrain`).
- Realaus kalendoriaus, CRM, sandėlio sistemos sinchronizacijos.
- Admin UI, autentifikacijos, mokėjimų, SMS.
- Produkcinės DB / eilių / retry logikos.

Svetainė ir frontendas — ne šio repo scope. Šis repo atsako už logiką ir duomenis, kuriuos frontendas/telefonija gali kviesti per API.

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
├── lib/                   # tekstas, data, failų saugykla
├── api/                   # HTTP API
└── cli/                   # demo
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
- HTTP API pilnas skambutis ir klaidos.

## Toliau

Architektūra, būsenų mašina ir Twilio/OpenAI prijungimo planas: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
