import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CallAgent } from "../src/agent/callAgent.js";
import type { CustomerRequest } from "../src/domain/types.js";
import { createHarness } from "./helpers.js";

let harness: Awaited<ReturnType<typeof createHarness>>;
let agent: CallAgent;

beforeEach(async () => {
  harness = await createHarness();
  agent = harness.agent;
});

afterEach(async () => {
  await harness.cleanup();
});

describe("CallAgent — FAQ", () => {
  it("answers business questions from the tenant knowledge base", async () => {
    const start = await agent.startCall({ tenantId: "demo-tire" });

    const hours = await agent.handleMessage(start.callId, "Iki kada dirbate?");
    expect(hours.reply).toContain("18:00");
    expect(hours.reply).toContain("Ar dar kuo galiu padėti?");

    const address = await agent.handleMessage(start.callId, "Kur esate?");
    expect(address.reply).toContain("Vilniaus g.");
    expect(address.state.intent).toBe("faq");

    const ended = await agent.endCall(start.callId);
    expect(ended.summary.outcome).toBe("Pokalbis baigtas be poreikio.");
    expect(ended.summary.nextAction).toBe("Nereikia.");
  });
});

describe("CallAgent — service booking", () => {
  it("quotes a service, collects contact details and saves a booking", async () => {
    const start = await agent.startCall({ tenantId: "demo-tire" });

    const service = await agent.handleMessage(start.callId, "Noriu ratų suvedimo");
    expect(service.reply).toContain("Ratų suvedimas");
    expect(service.reply).toContain("45");
    expect(service.state.phase).toBe("service_time");

    const time = await agent.handleMessage(start.callId, "rytoj 9 val.");
    expect(time.reply.toLowerCase()).toContain("kaip jus vadinti");

    await agent.handleMessage(start.callId, "Asta");
    const done = await agent.handleMessage(start.callId, "860054321");
    expect(done.reply).toContain("Užregistravau rezervaciją");

    const saved = await harness.requests.list("demo-tire");
    expect(saved).toHaveLength(1);
    const request = saved[0] as CustomerRequest;
    expect(request.type).toBe("service_booking");
    expect(request.service).toBe("Ratų suvedimas");
    expect(request.status).toBe("pending_confirmation");
    expect(request.preferredTime).toBe("rytoj 9 val.");
    expect(request.items).toHaveLength(0);
  });
});

describe("CallAgent — invalid phone fallback", () => {
  it("continues without a phone after two invalid entries instead of looping", async () => {
    const start = await agent.startCall({ tenantId: "demo-tire" });

    await agent.handleMessage(start.callId, "Noriu ratų suvedimo");
    await agent.handleMessage(start.callId, "rytoj 9 val.");
    await agent.handleMessage(start.callId, "Asta");

    const first = await agent.handleMessage(start.callId, "abc");
    expect(first.reply.toLowerCase()).toContain("telefono numer");

    const done = await agent.handleMessage(start.callId, "xyz");
    expect(done.reply).toContain("Užregistravau rezervaciją");
    expect(done.requestId).toMatch(/^REQ-/);

    const saved = await harness.requests.list("demo-tire");
    const request = saved[0] as CustomerRequest;
    expect(request.customer).toEqual({ name: "Asta", phone: undefined });
    expect(request.notes).toContain("Telefono numerio nenurodė");
  });
});

describe("CallAgent — human transfer", () => {
  it("transfers the caller and saves a transcript", async () => {
    const start = await agent.startCall({ tenantId: "demo-tire" });

    const transfer = await agent.handleMessage(start.callId, "Sujunkite su žmogumi");
    expect(transfer.transferred).toBe(true);
    expect(transfer.ended).toBe(true);
    expect(transfer.reply).toContain("operatoriui");

    const session = agent.getSession(start.callId);
    expect(session?.status).toBe("transferred");
    expect(session?.toolEvents.some((event) => event.tool === "transfer_to_human")).toBe(true);

    const ended = await agent.endCall(start.callId);
    expect(ended.summary.outcome).toBe("Perduota žmogui.");
    expect(ended.transferred).toBe(true);
  });
});

describe("CallAgent — fallback", () => {
  it("offers a human after two unclear messages", async () => {
    const start = await agent.startCall({ tenantId: "demo-tire" });

    const first = await agent.handleMessage(start.callId, "Labas");
    expect(first.reply).toContain("Ar ieškote padangų");
    expect(first.state.unknownTurns).toBe(1);

    const second = await agent.handleMessage(start.callId, "Na, tokia situacija");
    expect(second.reply).toContain("operatoriui");
    expect(second.state.awaitingHumanConfirmation).toBe(true);

    const confirmed = await agent.handleMessage(start.callId, "Taip");
    expect(confirmed.transferred).toBe(true);
    expect(confirmed.ended).toBe(true);
  });
});
