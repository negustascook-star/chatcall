import { existsSync } from "node:fs";

if (existsSync(".env")) {
  if (typeof process.loadEnvFile !== "function") {
    throw new Error(".env įkėlimui reikia Node.js 20.12 arba naujesnio.");
  }
  process.loadEnvFile();
}

const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID?.trim();
const API_KEY = process.env.TWILIO_API_KEY?.trim();
const API_SECRET = process.env.TWILIO_API_SECRET?.trim();
const AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN?.trim();
const USERNAME = API_KEY || ACCOUNT_SID;
const PASSWORD = API_SECRET || AUTH_TOKEN;

interface TwilioAccount {
  friendly_name?: string;
  status?: string;
  type?: string;
  date_created?: string;
}

interface TwilioBalance {
  balance?: string;
  currency?: string;
}

interface TwilioNumber {
  phone_number: string;
  friendly_name?: string;
  capabilities?: {
    voice?: boolean;
    sms?: boolean;
    mms?: boolean;
    fax?: boolean;
  };
}

interface NumberList {
  incoming_phone_numbers?: TwilioNumber[];
}

interface AvailableNumber {
  phone_number: string;
  locality?: string;
  region?: string;
}

interface AvailableList {
  available_phone_numbers?: AvailableNumber[];
}

interface CallerId {
  phone_number: string;
  friendly_name?: string;
  status?: string;
}

interface CallerIdList {
  outgoing_caller_ids?: CallerId[];
}

interface Bundle {
  sid: string;
  friendly_name?: string;
  status?: string;
  regulation_sid?: string;
}

interface BundleList {
  results?: Bundle[];
}

const API = "https://api.twilio.com/2010-04-01";
const TRUSTHUB = "https://trusthub.twilio.com/v1";

function requireCredentials(): void {
  if (!ACCOUNT_SID || !USERNAME || !PASSWORD) {
    console.error("Trūksta Twilio prisijungimo duomenų.");
    console.error("");
    console.error("Įrašykite į chatcall/.env (rekomenduojama – API key):");
    console.error("TWILIO_ACCOUNT_SID=AC...");
    console.error("TWILIO_API_KEY=SK...");
    console.error("TWILIO_API_SECRET=...");
    console.error("");
    console.error("API key kuriamas: https://console.twilio.com/us1/account/keys-credentials/api-keys");
    console.error("Senesnis variantas: TWILIO_AUTH_TOKEN vietoje API key + secret.");
    process.exitCode = 1;
    return;
  }
}

async function api<T>(url: string): Promise<T | null> {
  const auth = Buffer.from(`${USERNAME}:${PASSWORD}`).toString("base64");
  const response = await fetch(url, {
    headers: {
      Authorization: `Basic ${auth}`,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(20_000),
  });

  if (response.status === 404) return null;
  if (!response.ok) {
    const body = (await response.text()).slice(0, 300);
    throw new Error(`${url} → HTTP ${response.status}: ${body || "be atsakymo"}`);
  }
  return (await response.json()) as T;
}

function count(numbers: AvailableList | null): number {
  return numbers?.available_phone_numbers?.length ?? 0;
}

async function main(): Promise<void> {
  requireCredentials();
  if (!ACCOUNT_SID || !USERNAME || !PASSWORD) return;

  const [account, balance, numbers, callerIds, bundles, us, ltLocal, ltMobile] =
    await Promise.all([
      api<TwilioAccount>(`${API}/Accounts/${ACCOUNT_SID}.json`),
      api<TwilioBalance>(`${API}/Accounts/${ACCOUNT_SID}/Balance.json`),
      api<NumberList>(`${API}/Accounts/${ACCOUNT_SID}/IncomingPhoneNumbers.json?PageSize=100`),
      api<CallerIdList>(`${API}/Accounts/${ACCOUNT_SID}/OutgoingCallerIds.json?PageSize=50`),
      api<BundleList>(`${TRUSTHUB}/RegulatoryCompliance/Bundles?PageSize=50`),
      api<AvailableList>(
        `${API}/Accounts/${ACCOUNT_SID}/AvailablePhoneNumbers/US/Local.json?VoiceEnabled=true&PageSize=5`,
      ),
      api<AvailableList>(
        `${API}/Accounts/${ACCOUNT_SID}/AvailablePhoneNumbers/LT/Local.json?VoiceEnabled=true&PageSize=5`,
      ),
      api<AvailableList>(
        `${API}/Accounts/${ACCOUNT_SID}/AvailablePhoneNumbers/LT/Mobile.json?VoiceEnabled=true&PageSize=5`,
      ),
    ]);

  console.log("Twilio auditas");
  console.log("=============");
  console.log(`Prisijungimas: ${API_KEY ? "API key" : "Account Auth Token"}`);
  console.log(`Paskyra: ${account?.friendly_name ?? "—"}`);
  console.log(`Būsena: ${account?.status ?? "—"} | tipas: ${account?.type ?? "—"}`);
  console.log(`Sukurta: ${account?.date_created ?? "—"}`);
  console.log(`Balansas: ${balance?.balance ?? "—"} ${balance?.currency ?? ""}`);
  console.log("");

  const owned = numbers?.incoming_phone_numbers ?? [];
  console.log(`Turimi numeriai (${owned.length})`);
  console.log("----------------------");
  if (!owned.length) {
    console.log("Nėra nupirktų Twilio numerių.");
  }
  for (const number of owned) {
    const caps = [
      number.capabilities?.voice ? "voice" : null,
      number.capabilities?.sms ? "sms" : null,
    ].filter(Boolean).join(", ");
    console.log(`- ${number.phone_number} | ${number.friendly_name ?? "—"} | ${caps || "—"}`);
  }
  console.log("");

  const callers = callerIds?.outgoing_caller_ids ?? [];
  console.log(`Patvirtinti caller ID (${callers.length})`);
  console.log("-------------------------------");
  if (!callers.length) {
    console.log("Nėra patvirtintų caller ID.");
  }
  for (const caller of callers) {
    console.log(`- ${caller.phone_number} | ${caller.status ?? "—"}`);
  }
  console.log("");

  console.log("Numerių paieška");
  console.log("---------------");
  console.log(`JAV local (voice): ${count(us)}`);
  console.log(`Lietuvos local (voice): ${ltLocal === null ? "nepalaikoma (404)" : count(ltLocal)}`);
  console.log(`Lietuvos mobile (voice): ${ltMobile === null ? "nepalaikoma (404)" : count(ltMobile)}`);
  console.log("");

  const bundleList = bundles?.results ?? [];
  console.log(`Reguliaciniai bundle'ai (${bundleList.length})`);
  console.log("------------------------------");
  if (!bundleList.length) {
    console.log("Nėra sukurtų reguliacinių bundle'ų.");
  }
  for (const bundle of bundleList) {
    console.log(`- ${bundle.friendly_name ?? bundle.sid} | ${bundle.status ?? "—"}`);
  }
  console.log("");

  console.log("Išvados");
  console.log("-------");
  if (account?.type === "Trial") {
    console.log("- Paskyra yra Trial. Numeriui pirkti ir skambučiams reikia upgrade / payment method.");
  }
  if (!balance?.balance || Number(balance.balance) <= 0) {
    console.log("- Balansas 0. Papildykite per Billing → Add funds.");
  }
  if (!owned.length) {
    console.log("- Nėra numerio, kurį būtų galima importuoti į ElevenLabs.");
  }
  if (count(ltLocal) === 0 && count(ltMobile) === 0) {
    console.log("- Twilio šiuo metu neturi +370 numerių. Lietuviams reikės SIP tiekėjo arba persiuntimo į JAV numerį.");
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
