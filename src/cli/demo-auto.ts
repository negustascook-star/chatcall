import path from "node:path";
import { CallAgent } from "../agent/callAgent.js";

const dataDir = path.resolve(process.env.DATA_DIR ?? path.join(process.cwd(), "data"));
const agent = new CallAgent({ dataDir });

const scenarios = [
  {
    title: "Scenarijus 1: padangos yra sandėlyje",
    lines: [
      "Sveiki, ieškau 205/55 R16 žieminių padangų, Michelin",
      "Taip, noriu rezervuoti",
      "Tomas",
      "+370 600 12345",
      "rytoj 10 val.",
      "ne, ačiū",
    ],
  },
  {
    title: "Scenarijus 2: padangų sandėlyje nėra",
    lines: [
      "Sveiki, reikia 225/40 R18 žieminių padangų",
      "Michelin, biudžetas iki 150 eurų",
      "Asta",
      "8 600 54321",
      "viso gero",
    ],
  },
];

for (const scenario of scenarios) {
  console.log("");
  console.log("=".repeat(70));
  console.log(scenario.title);
  console.log("=".repeat(70));

  const call = await agent.startCall({
    tenantId: "demo-tire",
    from: "+370 600 99999",
    channel: "text",
  });
  console.log(`Botas: ${call.reply}`);

  for (const line of scenario.lines) {
    console.log(`Jūs: ${line}`);
    const result = await agent.handleMessage(call.callId, line);
    console.log(`Botas: ${result.reply}`);
    if (result.ended) {
      const end = await agent.endCall(call.callId);
      console.log("");
      console.log(`[Santrauka] ${end.summary.text}`);
      console.log(`[Failai] ${end.mdPath}`);
      break;
    }
  }
}
