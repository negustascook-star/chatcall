import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApiServer } from "../src/api/server.js";
import { createHarness } from "./helpers.js";

let harness: Awaited<ReturnType<typeof createHarness>>;
let server: Server;
let baseUrl: string;

beforeEach(async () => {
  harness = await createHarness();
  server = createApiServer({ dataDir: harness.dataDir, agent: harness.agent });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await harness.cleanup();
});

describe("HTTP API", () => {
  it("runs a complete call through the API", async () => {
    const health = await fetch(`${baseUrl}/health`);
    expect(health.status).toBe(200);

    const startResponse = await fetch(`${baseUrl}/api/calls`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tenantId: "demo-tire", from: "+370 600 11111" }),
    });
    expect(startResponse.status).toBe(201);
    const start = (await startResponse.json()) as {
      callId: string;
      reply: string;
    };
    expect(start.callId).toMatch(/^call_/);
    expect(start.reply).toContain("Padangų centras");

    const messageResponse = await fetch(`${baseUrl}/api/calls/${start.callId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Ieškau 205/55 R16 žieminių, Michelin" }),
    });
    expect(messageResponse.status).toBe(200);
    const message = (await messageResponse.json()) as {
      reply: string;
      state: { phase: string };
    };
    expect(message.state.phase).toBe("tire_offer");
    expect(message.reply).toContain("Michelin");

    const tenantsResponse = await fetch(`${baseUrl}/api/tenants`);
    expect(tenantsResponse.status).toBe(200);
    const tenants = (await tenantsResponse.json()) as {
      tenants: Array<{ id: string }>;
    };
    expect(tenants.tenants.some((tenant) => tenant.id === "demo-tire")).toBe(true);

    const endResponse = await fetch(`${baseUrl}/api/calls/${start.callId}/end`, {
      method: "POST",
    });
    expect(endResponse.status).toBe(200);
    const end = (await endResponse.json()) as {
      summary: { outcome: string };
      mdPath: string;
    };
    expect(end.summary.outcome).toBe("Pokalbis baigtas be poreikio.");
    expect(end.mdPath).toContain(start.callId);

    const requestsResponse = await fetch(
      `${baseUrl}/api/tenants/demo-tire/requests?date=2026-10-28`,
    );
    expect(requestsResponse.status).toBe(200);
    const requests = (await requestsResponse.json()) as { requests: unknown[] };
    expect(requests.requests).toHaveLength(0);
  });

  it("serves the demo website at the root", async () => {
    const response = await fetch(`${baseUrl}/`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toContain("AIcall");
  });

  it("serves the owner workspace with the business calendar", async () => {
    const response = await fetch(`${baseUrl}/app.html`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("renderCalendar");
    expect(html).toContain("New appointment");
    expect(html).toContain("appointments");
    expect(html).toContain('id="suspended"');
    expect(html).toContain("suspended_at");
  });

  it("serves the brand logo assets", async () => {
    const response = await fetch(`${baseUrl}/logo-mark.svg`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("image/svg+xml");
    expect(await response.text()).toContain("<svg");
  });

  it("returns useful errors", async () => {
    const missingTenant = await fetch(`${baseUrl}/api/calls`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(missingTenant.status).toBe(400);

    const unknownCall = await fetch(`${baseUrl}/api/calls/does-not-exist/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Labas" }),
    });
    expect(unknownCall.status).toBe(404);
  });
});
