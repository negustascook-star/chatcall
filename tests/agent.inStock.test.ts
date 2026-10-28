import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CallAgent } from "../src/agent/callAgent.js";
import type { CustomerRequest } from "../src/domain/types.js";
import type { RequestService } from "../src/requests/requestService.js";
import { createHarness, readJsonFile } from "./helpers.js";

let harness: Awaited<ReturnType<typeof createHarness>>;
let agent: CallAgent;
let requests: RequestService;

beforeEach(async () => {
  harness = await createHarness();
  agent = harness.agent;
  requests = harness.requests;
});

afterEach(async () => {
  await harness.cleanup();
});

describe("CallAgent — in-stock tire flow", () => {
  it("greets, checks stock, reserves tires and saves the request to disk", async () => {
    const start = await agent.startCall({
      tenantId: "demo-tire",
      from: "+370 600 11111",
    });
    expect(start.reply).toContain("Padangų centras");

    const offer = await agent.handleMessage(
      start.callId,
      "Sveiki, ieškau 205/55 R16 žieminių padangų, Michelin",
    );
    expect(offer.reply).toContain("205/55 R16");
    expect(offer.reply).toContain("Michelin");
    expect(offer.reply).toContain("129");
    expect(offer.state.phase).toBe("tire_offer");
    expect(offer.toolEvents.some((event) => event.tool === "check_stock")).toBe(true);

    const wants = await agent.handleMessage(start.callId, "Taip, noriu rezervuoti");
    expect(wants.reply.toLowerCase()).toContain("kaip jus vadinti");

    const name = await agent.handleMessage(start.callId, "Tomas");
    expect(name.reply.toLowerCase()).toContain("telefono");

    const phone = await agent.handleMessage(start.callId, "+370 600 12345");
    expect(phone.reply.toLowerCase()).toContain("kada");

    const done = await agent.handleMessage(start.callId, "rytoj 10 val.");
    expect(done.reply).toContain("Užregistravau");
    expect(done.requestId).toMatch(/^REQ-/);
    expect(done.state.phase).toBe("closing");

    const saved = await requests.list("demo-tire");
    expect(saved).toHaveLength(1);

    const request = saved[0] as CustomerRequest;
    expect(request.id).toBe(done.requestId);
    expect(request.type).toBe("parts_order");
    expect(request.status).toBe("pending_confirmation");
    expect(request.customer).toEqual({ name: "Tomas", phone: "+37060012345" });
    expect(request.items[0]).toMatchObject({
      size: "205/55 R16",
      season: "winter",
      quantity: 4,
      unitPrice: 129,
      inStock: true,
    });
    expect(request.preferredTime).toContain("rytoj");

    const requestJson = await readJsonFile<CustomerRequest>(
      path.join(
        harness.dataDir,
        "tenants",
        "demo-tire",
        "requests",
        "2026-10-28",
        `${request.id}.json`,
      ),
    );
    expect(requestJson.id).toBe(request.id);

    const markdown = await readFile(
      path.join(
        harness.dataDir,
        "tenants",
        "demo-tire",
        "requests",
        "2026-10-28",
        `${request.id}.md`,
      ),
      "utf8",
    );
    expect(markdown).toContain("Ko reikia");
    expect(markdown).toContain("205/55 R16");
    expect(markdown).toContain("Tomas");

    const digest = await readFile(
      path.join(
        harness.dataDir,
        "tenants",
        "demo-tire",
        "requests",
        "2026-10-28",
        "poreikiai.md",
      ),
      "utf8",
    );
    expect(digest).toContain(request.id);
    expect(digest).toContain("205/55 R16");

    const ended = await agent.endCall(start.callId);
    expect(ended.summary.outcome).toBe("Užregistruotas poreikis.");
    expect(ended.jsonPath).toContain(start.callId);
    expect(ended.mdPath).toContain(start.callId);
  });
});
