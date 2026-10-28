import { existsSync } from "node:fs";

if (existsSync(".env")) {
  if (typeof process.loadEnvFile !== "function") {
    throw new Error(".env įkėlimui reikia Node.js 20.12 arba naujesnio.");
  }
  process.loadEnvFile();
}

const API_BASE = (process.env.ELEVENLABS_API_URL?.trim() || "https://api.elevenlabs.io").replace(/\/+$/, "");
const API_KEY = process.env.ELEVENLABS_API_KEY?.trim();

interface Subscription {
  tier?: string;
  status?: string;
  character_count?: number;
  character_limit?: number;
  next_character_count_reset_unix?: number;
}

interface AgentSummary {
  agent_id: string;
  name: string;
  tags?: string[];
  archived?: boolean;
  last_call_time_unix_secs?: number | null;
}

interface AgentDetail {
  agent_id?: string;
  name?: string;
  conversation_config?: {
    agent?: {
      first_message?: string;
      language?: string;
      prompt?: {
        prompt?: string;
        tool_ids?: string[];
      };
    };
  };
}

interface PhoneNumber {
  provider: "twilio" | "sip_trunk" | "exotel" | string;
  phone_number: string;
  phone_number_id: string;
  label?: string;
  assigned_agent?: {
    agent_id: string;
    agent_name: string;
  } | null;
}

interface Webhook {
  name: string;
  webhook_id: string;
  webhook_url: string;
  is_disabled: boolean;
  is_auto_disabled: boolean;
  auth_type: string;
  usage?: Array<{ usage_type: string }> | null;
}

interface Tool {
  id: string;
  name?: string;
  type?: string;
  tool_config?: {
    type?: string;
    name?: string;
    description?: string;
  };
}

interface AgentList {
  agents: AgentSummary[];
  has_more?: boolean;
}

interface ToolList {
  tools: Tool[];
}

interface WebhookList {
  webhooks: Webhook[];
}

async function api<T>(path: string): Promise<T> {
  if (!API_KEY) {
    throw new Error(
      "ELEVENLABS_API_KEY nenustatytas. Įrašykite jį į chatcall/.env ir paleiskite iš naujo.",
    );
  }

  const response = await fetch(`${API_BASE}${path}`, {
    headers: {
      "xi-api-key": API_KEY,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(20_000),
  });

  if (!response.ok) {
    const body = (await response.text()).slice(0, 300);
    throw new Error(`ElevenLabs API ${path} → HTTP ${response.status}: ${body || "be atsakymo"}`);
  }

  return (await response.json()) as T;
}

function formatDate(unixSeconds?: number | null): string {
  if (!unixSeconds) return "—";
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

async function main(): Promise<void> {
  if (!API_KEY) {
    console.error("Trūksta ELEVENLABS_API_KEY.");
    console.error("");
    console.error("1. Atidarykite https://elevenlabs.io/app/settings/api-keys");
    console.error("2. Sukurkite raktą (arba naudokite esamą).");
    console.error("3. Įrašykite į chatcall/.env: ELEVENLABS_API_KEY=...");
    console.error("4. Paleiskite: npm run elevenlabs:audit");
    process.exitCode = 1;
    return;
  }

  const [subscription, agentList, phoneNumbers, webhookList, toolList] = await Promise.all([
    api<Subscription>("/v1/user/subscription"),
    api<AgentList>("/v1/convai/agents?page_size=100"),
    api<PhoneNumber[]>("/v1/convai/phone-numbers"),
    api<WebhookList>("/v1/workspace/webhooks?include_usages=true"),
    api<ToolList>("/v1/convai/tools"),
  ]);

  const agents = agentList.agents.filter((agent) => !agent.archived);
  const details = await Promise.allSettled(
    agents.slice(0, 20).map((agent) => api<AgentDetail>(`/v1/convai/agents/${encodeURIComponent(agent.agent_id)}`)),
  );
  const detailById = new Map<string, AgentDetail>();
  details.forEach((result, index) => {
    if (result.status === "fulfilled") {
      const agent = agents[index];
      if (agent) detailById.set(agent.agent_id, result.value);
    }
  });

  console.log("ElevenLabs auditas");
  console.log("==================");
  console.log(`Planas: ${subscription.tier ?? "nežinomas"} (${subscription.status ?? "būsena nežinoma"})`);
  if (typeof subscription.character_count === "number" && typeof subscription.character_limit === "number") {
    console.log(`Kreditai: ${subscription.character_count}/${subscription.character_limit}`);
  }
  console.log(`Agentai: ${agents.length}`);
  console.log(`Telefono numeriai: ${phoneNumbers.length}`);
  console.log(`Webhook'ai: ${webhookList.webhooks.length}`);
  console.log(`Įrankiai: ${toolList.tools.length}`);
  console.log("");

  console.log("Agentai");
  console.log("-------");
  if (!agents.length) {
    console.log("Nėra sukonfigūruotų agentų.");
  }
  for (const agent of agents) {
    const detail = detailById.get(agent.agent_id);
    const config = detail?.conversation_config?.agent;
    const tools = config?.prompt?.tool_ids?.length ?? 0;
    console.log(`- ${agent.name} (${agent.agent_id})`);
    console.log(`  kalba: ${config?.language ?? "—"} | įrankiai: ${tools} | paskutinis skambutis: ${formatDate(agent.last_call_time_unix_secs)}`);
    if (config?.first_message) {
      console.log(`  pirmas sakinys: ${JSON.stringify(config.first_message.slice(0, 120))}`);
    }
  }
  console.log("");

  console.log("Telefono numeriai");
  console.log("-----------------");
  if (!phoneNumbers.length) {
    console.log("Nėra prijungtų telefono numerių.");
  }
  for (const number of phoneNumbers) {
    const assigned = number.assigned_agent
      ? `${number.assigned_agent.agent_name} (${number.assigned_agent.agent_id})`
      : "nepriskirtas agentui";
    console.log(`- ${number.phone_number} | ${number.provider} | ${assigned}`);
    console.log(`  numerio ID: ${number.phone_number_id}${number.label ? ` | pavadinimas: ${number.label}` : ""}`);
  }
  console.log("");

  console.log("Webhook'ai");
  console.log("-----------");
  if (!webhookList.webhooks.length) {
    console.log("Nėra webhook'ų.");
  }
  for (const webhook of webhookList.webhooks) {
    const usages = webhook.usage?.map((usage) => usage.usage_type).join(", ") || "—";
    const state = webhook.is_disabled || webhook.is_auto_disabled ? "IŠJUNGTAS" : "aktyvus";
    console.log(`- ${webhook.name} | ${state} | ${webhook.auth_type}`);
    console.log(`  ${webhook.webhook_url}`);
    console.log(`  naudoja: ${usages}`);
  }
  console.log("");

  console.log("Kitos pastabos");
  console.log("--------------");
  const expectedWebhook = "https://chatcall-api.onrender.com/api/elevenlabs/webhook";
  const hasExpectedWebhook = webhookList.webhooks.some((webhook) => webhook.webhook_url === expectedWebhook);
  if (!hasExpectedWebhook) {
    console.log(`- Nėra post-call webhook'o į ${expectedWebhook}`);
  }
  if (!phoneNumbers.length) {
    console.log("- Nėra numerio, kuris priimtų skambučius.");
  }
  if (agents.length && !phoneNumbers.some((number) => number.assigned_agent)) {
    console.log("- Numeris nepriskirtas nė vienam agentui.");
  }
  if (!agents.length) {
    console.log("- Nėra agento, kuris atsakytų į skambučius.");
  }
  const ltNumber = phoneNumbers.find((number) => number.phone_number.startsWith("+370"));
  if (!ltNumber) {
    console.log("- Nėra +370 (Lietuvos) numerio. ElevenLabs tiesiogiai LT numerių nesiūlo – reikia Twilio/SIP numerio.");
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
