import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CallAgent } from "../src/agent/callAgent.js";
import { addSecondTenant, createHarness } from "./helpers.js";

let harness: Awaited<ReturnType<typeof createHarness>>;
let agent: CallAgent;

beforeEach(async () => {
  harness = await createHarness();
  agent = harness.agent;
});

afterEach(async () => {
  await harness.cleanup();
});

describe("multi-tenant routing", () => {
  it("routes an inbound call by the called phone number", async () => {
    await addSecondTenant(harness.dataDir, "demo-second", "+370 700 00000");

    const start = await agent.startCall({ to: "+370 700 00000" });
    expect(agent.getSession(start.callId)?.tenantId).toBe("demo-second");
    expect(start.reply).toContain("Kauno servisas");

    await agent.handleMessage(start.callId, "Noriu ratų suvedimo");
    await agent.handleMessage(start.callId, "rytoj 9 val.");
    await agent.handleMessage(start.callId, "Asta");
    const done = await agent.handleMessage(start.callId, "860054321");
    expect(done.reply).toContain("Užregistravau");

    const secondRequests = await harness.requests.list("demo-second");
    const firstRequests = await harness.requests.list("demo-tire");
    expect(secondRequests).toHaveLength(1);
    expect(firstRequests).toHaveLength(0);
    expect(secondRequests[0]?.tenantId).toBe("demo-second");
  });

  it("normalizes a locally formatted number when routing", async () => {
    await addSecondTenant(harness.dataDir, "demo-second", "+370 700 00000");

    const start = await agent.startCall({ to: "8 700 00000" });
    expect(agent.getSession(start.callId)?.tenantId).toBe("demo-second");
  });
});
