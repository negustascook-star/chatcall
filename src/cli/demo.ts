import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { CallAgent } from "../agent/callAgent.js";
import { TenantRepository } from "../tenants/tenantRepository.js";

const args = process.argv.slice(2);
const tenantId = readArg("--tenant") ?? "demo-tire";
const from = readArg("--from") ?? "+370 600 99999";
const dataDir = path.resolve(process.env.DATA_DIR ?? path.join(process.cwd(), "data"));

const tenants = new TenantRepository(dataDir);
const tenant = await tenants.get(tenantId);
if (!tenant) {
  console.error(`Nerastas tenant "${tenantId}". Patikrink data/tenants/${tenantId}/tenant.json`);
  process.exit(1);
}

const agent = new CallAgent({ dataDir });
const call = await agent.startCall({ tenantId, from, channel: "text" });

console.log("");
console.log(`=== ${tenant.tenant.name} · mock skambutis ${call.callId} ===`);
console.log("Komandos: /end — baigti, /state — būsena, /help — pagalba");
console.log("");
console.log(`Botas: ${call.reply}`);
console.log("");

const rl = createInterface({ input, output });
let ended = false;

try {
  while (!ended) {
    const line = (await rl.question("Jūs: ")).trim();
    if (!line) continue;

    if (line === "/help") {
      console.log("Įrašykite kliento repliką. /end baigia pokalbį, /state rodo būseną, /quit išeina.");
      continue;
    }

    if (line === "/state") {
      const session = agent.getSession(call.callId);
      console.log(JSON.stringify(session?.state, null, 2));
      continue;
    }

    if (line === "/quit") {
      await finishCall(call.callId);
      ended = true;
      break;
    }

    if (line === "/end") {
      const result = await agent.endCall(call.callId);
      printEnd(result);
      ended = true;
      break;
    }

    const result = await agent.handleMessage(call.callId, line);
    for (const event of result.toolEvents) {
      console.log(`\x1b[2m[tool] ${event.tool} ${event.ok ? "✓" : "✗"}\x1b[0m`);
    }
    console.log(`Botas: ${result.reply}`);
    console.log("");

    if (result.ended) {
      const end = await agent.endCall(call.callId);
      printEnd(end);
      ended = true;
    }
  }
} finally {
  rl.close();
}

async function finishCall(callId: string): Promise<void> {
  const result = await agent.endCall(callId);
  printEnd(result);
}

function printEnd(result: Awaited<ReturnType<CallAgent["endCall"]>>): void {
  console.log("");
  console.log("=== Skambučio santrauka ===");
  console.log(result.summary.text);
  console.log(`Rezultatas: ${result.summary.outcome}`);
  console.log(`Kitas veiksmas: ${result.summary.nextAction}`);
  console.log("");
  console.log(`Santrauka: ${result.mdPath}`);
  console.log(`JSON: ${result.jsonPath}`);
}

function readArg(name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}
