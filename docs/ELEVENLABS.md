# ElevenLabs prijungimas

Šis dokumentas aprašo, ko reikia, kad AIcall platforma priimtų realius telefono skambučius per ElevenLabs.

## 1. Ką turime dabar

- Veikianti svetainė, registracija, owner darbo vieta ir kalendorius.
- Supabase daugiabučių (multi-tenant) duomenų bazė: `companies`, `business_services`,
  `specialists`, `business_calls`, `appointments`.
- Administratoriaus panelė (`/admin`).
- Serverio API (`/api/...`), bet jame dar nėra ElevenLabs maršrutų.

Telefonijos integracijos kode dar nėra: nei agento, nei webhook'ų, nei skambučių įrašymo.

## 2. Ko trūksta

### 2.1. ElevenLabs prieigos

Reikia vieno iš dviejų:

1. **ElevenLabs API rakto** – Profile → API Keys → Create Key. Raktą įrašykite į
   `chatcall/.env` kaip `ELEVENLABS_API_KEY=...` (niekada necommitinkite).
2. **ElevenLabs CLI prisijungimo** – `npx -y @elevenlabs/cli@latest onboard init`.
   Ši komanda atidaro naršyklę, sukuria raktą ir gali sukurti agentą.

Be rakto negalime nei pamatyti, ką nusipirkote, nei priskirti numerio, nei sukurti webhook'o.

### 2.2. Pasirinkto ElevenLabs produkto

ElevenLabs turi du skirtingus dalykus, kurie abu vadinami „telefonu“:

- **Reception.ai** – gatavas AI administratorius su savo kalendoriumi, numeriu ir
  valdymo skydeliu. Tinka, jei norite naudoti ElevenLabs produktą tiesiogiai.
- **ElevenAgents / Conversational AI API** – agentas, kurį programuojame mes ir
  jungiame prie savo Supabase kalendoriaus. Tinka, jei AIcall turi likti pagrindinė
  platforma.

Nuo šio pasirinkimo priklauso visa integracija, todėl jo negalima spėti.

### 2.3. Telefono numerio

- ElevenLabs **Reception.ai** iš karto duoda numerius tik JAV ir Kanadai.
- Apie 50 šalių (Lenkija, Latvija, Estija, Vokietija ir kt.) numerį galima gauti
  pateikus reguliacinę paraišką. **Lietuvos (+370) sąraše nėra.**
- Lietuvai reikia **savo Twilio numerio arba SIP trunk'o** (pvz. Telnyx, Plivo,
  vietinis SIP tiekėjas) ir jį prijungti prie ElevenLabs.
- Jei numerį jau nusipirkote per ElevenLabs, jo sąraše jis bus matomas. Jei numeris
  yra JAV/Kanados, jis veiks, bet skambinantys iš Lietuvos mokės tarptautinio
  skambučio tarifą.

### 2.4. Verslo duomenų

Agentas negali rezervuoti laiko, jei neturi ką pasiūlyti. Šiuo metu produkcinėje
duomenų bazėje:

- `business_services` – 0 įrašų,
- `specialists` – 0 įrašų,
- `appointments` – 0 įrašų.

Pirmiausia reikia užpildyti bent paslaugas, trukmes, kainas ir specialistus
(arba aiškiai pasirinkti, kad agentas tik užrašo kliento kontaktą ir perskambins).

### 2.5. Serverio konfigūracijos

Kai bus aiškus produktas, reikės šių Render aplinkos kintamųjų:

- `ELEVENLABS_API_KEY`
- `ELEVENLABS_WEBHOOK_SECRET`
- `ELEVENLABS_TOOL_SECRET`
- `PUBLIC_BASE_URL=https://chatcall-api.onrender.com`

Ir Supabase migracijos, kuri saugos agento ↔ įmonės ↔ numerio ryšį bei skambučių
transkriptus.

## 3. Kaip sužinoti, ką turite

Įrašius raktą į `.env`, paleiskite:

```bash
npm run elevenlabs:audit
```

Skriptas parodo:

- planą ir likusius kreditus,
- agentus ir jų kalbą, įrankius, pirmą sakinį,
- telefono numerius, tiekėją ir ar numeris priskirtas agentui,
- webhook'us ir jų būseną,
- ar yra +370 numeris,
- ko trūksta, kad skambučiai veiktų.

## 4. Integracijos planas (ElevenAgents kelias)

Jei pasirenkame ElevenAgents API:

1. **Supabase migracija**
   - `company_phone_numbers`: `company_id`, `provider`, `phone_number`,
     `elevenlabs_agent_id`, `elevenlabs_phone_number_id`, `status`.
   - `business_calls` papildymas: `provider`, `external_id`, `agent_id`,
     `duration_seconds`, `transcript`, `recording_url`, `started_at`.
   - Unikalus `(company_id, external_id)` idempotencijai.

2. **Serverio maršrutai**
   - `POST /api/elevenlabs/webhook` – `ElevenLabs-Signature` HMAC patikra,
     `post_call_transcription` įrašymas į `business_calls`.
   - `POST /api/elevenlabs/tools/:companyId/...` – agento įrankiai:
     `get_business_info`, `list_services`, `check_availability`,
     `book_appointment`, `take_message`.
   - Visi įrankiai apsaugoti `x-aicall-tool-key` antrašte.

3. **Agento sukūrimas**
   - Vienas agentas vienai įmonei.
   - Lietuviškas promptas, pirmas sakinys, darbo laikas, paslaugos, specialistai.
   - Webhook įrankiai nukreipti į mūsų API su įmonės ID.

4. **Numerio priskyrimas**
   - Twilio/SIP numeris importuojamas į ElevenLabs.
   - Numeris priskiriamas agentui.
   - Ryšys įrašomas į `company_phone_numbers`.

5. **Owner aplikacija**
   - „Phone setup“ puslapyje rodomas tikras numeris, agento būsena ir paskutiniai
     skambučiai vietoje „Not connected“.

6. **Testas**
   - Bandomasis skambutis į numerį.
   - Patikrinama, ar atsiranda `business_calls` įrašas.
   - Patikrinama, ar agentas randa paslaugą ir sukuria `appointments` įrašą.
   - Patikrinama, ar įrašas matomas owner kalendoriuje ir admin panelėje.

## 5. Integracijos planas (Reception.ai kelias)

Jei jau nusipirkote Reception.ai:

1. Prijunkite savo Twilio arba SIP numerį per Reception.ai → Integrations.
2. Įkelkite verslo informaciją, paslaugas, specialistus ir darbo laiką.
3. Nustatykite, ar kalendorius lieka Reception.ai, ar sinchronizuojamas su mūsų
   Supabase (per webhook'us / Google Calendar / MCP).
4. Owner aplikacijoje rodome nuorodą į Reception.ai valdymą ir skambučių suvestinę.
5. Nereikia kurti agento per ElevenAgents API.

Šis kelias greitesnis, bet AIcall kalendorius ir Reception.ai kalendorius gali likti
atskiri, kol nepadaryta sinchronizacija.

## 6. Saugumas

- `ELEVENLABS_API_KEY` ir `SUPABASE_SECRET_KEY` – tik serverio `.env` / Render
  aplinkoje, niekada naršyklėje ar Git'e.
- Webhook'as tikrinamas HMAC parašu pagal neapdorotą užklausos kūną.
- Įrankių endpoint'ams naudojama atskira `ELEVENLABS_TOOL_SECRET` antraštė.
- Admin API neleidžia CORS ir reikalauja `ADMIN_KEY`.

## 7. Trumpas checklist'as

- [ ] Įdėtas `ELEVENLABS_API_KEY` į `.env`.
- [ ] Paleistas `npm run elevenlabs:audit`.
- [ ] Nuspręsta: Reception.ai ar ElevenAgents API.
- [ ] Yra numeris (esamas ElevenLabs / Twilio / SIP).
- [ ] Užpildytos paslaugos ir specialistai.
- [ ] Nustatyti Render kintamieji.
- [ ] Atlikta Supabase migracija.
- [ ] Bandomasis skambutis praėjo.

## 8. Kur ką rasti (tikslios nuorodos)

### ElevenLabs

| Ką | Kur |
| --- | --- |
| Prisijungti | https://elevenlabs.io/app |
| API raktas | https://elevenlabs.io/app/settings/api-keys |
| Planas ir kreditai | https://elevenlabs.io/app/settings/subscription |
| Agentai | https://elevenlabs.io/app/agents |
| Agentų telefonai | https://elevenlabs.io/app/agents/phone-numbers |
| Skambučių istorija | https://elevenlabs.io/app/agents/history |
| Webhook'ai (post-call) | https://elevenlabs.io/app/agents/settings |
| Reception.ai | https://app.reception.ai |

API raktas kuriamas taip:

1. Atidarykite https://elevenlabs.io/app/settings/api-keys.
2. Spauskite **Create API key**.
3. Pavadinimas: `aicall`.
4. Palikite **Full access** (arba įjunkite Agents, Phone numbers, Webhooks,
   Tools read/write).
5. Spauskite **Create** ir **nusikopijuokite raktą iš karto** – jis rodomas tik
   vieną kartą.
6. Įrašykite į `chatcall/.env`:
   `ELEVENLABS_API_KEY=sk_...`

Jei `.env` įrašymas nepavyksta, paleiskite dukart spustelėdami
`chatcall\scripts\set-elevenlabs-key.cmd` – jis paprašys rakto ir įrašys jį
pats (raktas nebus rodomas ekrane).

### Twilio (jei reikia +370 numerio)

| Ką | Kur |
| --- | --- |
| Registracija | https://www.twilio.com/try-twilio |
| Valdymo konsolė | https://console.twilio.com |
| Pirkti numerį | Console → **Phone Numbers → Manage → Buy a number** → Country: Lithuania → Voice |
| Reguliaciniai dokumentai | Console → **Trust Hub → Regulatory Compliance → Bundles** |
| Account SID / Auth Token | Console → pagrindinis puslapis → **Account Info** |
| API raktai | https://console.twilio.com/us1/account/keys-credentials/api-keys |

Twilio numerį į ElevenLabs įkeliate: **Phone Numbers → Import from Twilio**,
įrašote numerį, Account SID ir Auth Token, tada priskiriate agentą.

### Mūsų platforma

| Ką | Kur |
| --- | --- |
| Owner darbo vieta | https://aicall.lt/app.html |
| Administratorius | https://aicall.lt/admin |
| Render kintamieji | https://dashboard.render.com → `chatcall-api` → **Environment** |
| Supabase SQL | https://supabase.com/dashboard/project/lzongluhbmyasadscuri/sql/new |

## 9. Numerio variantai pagal greitumą

1. **Jau turite ElevenLabs numerį** – nieko daryti nereikia, tik atsiųskite jo
   numerį ir numerio ID iš https://elevenlabs.io/app/agents/phone-numbers.
2. **Turite +370 verslo numerį** – greičiausias variantas: nukreipkite
   neatsakytus skambučius į ElevenLabs numerį savo operatoriaus nustatymuose
   (arba `**61*<numeris>#`). Skambinantys klientai skambina vietiniu tarifu.
3. **Norite savo +370 numerio ElevenLabs viduje** – pirkite Twilio numerį
   (reikės reguliacinio bundle su įmonės dokumentais) ir įkelkite į ElevenLabs.
4. **SIP trunk** – jei turite vietinį telekomunikacijų tiekėją ar PBX.

