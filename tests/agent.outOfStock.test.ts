import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CallAgent } from "../src/agent/callAgent.js";
import type { CustomerRequest } from "../src/domain/types.js";
import type { RequestService } from "../src/requests/requestService.js";
import { createHarness } from "./helpers.js";

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

describe("CallAgent — out-of-stock flow", () => {
  it("collects the need, saves a parts order and flags that it is not in stock", async () => {
    const start = await agent.startCall({ tenantId: "demo-tire" });

    const noStock = await agent.handleMessage(
      start.callId,
      "Sveiki, reikia 225/40 R18 žieminių padangų",
    );
    expect(noStock.reply).toContain("neturime");
    expect(noStock.reply).toContain("225/40 R18");
    expect(noStock.state.phase).toBe("tire_preferences");
    expect(noStock.toolEvents.some((event) => event.tool === "check_stock")).toBe(true);

    const preferences = await agent.handleMessage(
      start.callId,
      "Michelin, biudžetas iki 150 eurų",
    );
    expect(preferences.reply.toLowerCase()).toContain("kaip jus vadinti");
    expect(preferences.reply).not.toContain("..");

    await agent.handleMessage(start.callId, "Asta");
    const done = await agent.handleMessage(start.callId, "8 600 54321");
    expect(done.reply).toContain("Užregistravau poreikį");
    expect(done.requestId).toMatch(/^REQ-/);

    const saved = await requests.list("demo-tire");
    expect(saved).toHaveLength(1);
    const request = saved[0] as CustomerRequest;
    expect(request.type).toBe("parts_order");
    expect(request.status).toBe("new");
    expect(request.customer).toEqual({ name: "Asta", phone: "+37060054321" });
    expect(request.items[0]).toMatchObject({
      size: "225/40 R18",
      season: "winter",
      brandPreference: "Michelin",
      quantity: 4,
      inStock: false,
    });
    expect(request.items[0]?.unitPrice).toBeUndefined();
    expect(request.notes).toContain("Tikslaus varianto sandėlyje nebuvo");
    expect(request.notes).toContain("Biudžetas");
    expect(request.notes).not.toContain("..");

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
    expect(markdown).toContain("225/40 R18");
    expect(markdown).toContain("Sandėlyje: ne");

    const csv = await readFile(
      path.join(
        harness.dataDir,
        "tenants",
        "demo-tire",
        "requests",
        "2026-10-28",
        "poreikiai.csv",
      ),
      "utf8",
    );
    expect(csv).toContain(request.id);
    expect(csv).toContain("Asta");
  });
});
