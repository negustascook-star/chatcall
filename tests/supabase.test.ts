import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { CallAgent } from "../src/agent/callAgent.js";
import { createApiServer } from "../src/api/server.js";
import { SupabaseCatalog, readSupabaseConfig, type SupabaseCatalogConfig } from "../src/supabase/catalog.js";
import { TenantRepository } from "../src/tenants/tenantRepository.js";
import { addSecondTenant, createHarness } from "./helpers.js";

const config: SupabaseCatalogConfig = {
  url: "https://test-project.supabase.co", key: "sb_secret_test_only", tenantId: "demo-tire",
};
const services = [{ id: "tyre_change", name: "4 padangų keitimas", duration_minutes: 60, price_eur: "40.00" }];
const inventory = [{
  id: "demo_r16_winter", name: "DEMO žieminė R16", tyre_size: "205/55 R16",
  season: "winter", stock_quantity: 8, stock_price_eur: "65.00",
}];

function fixtureFetch(calls: URL[] = []): typeof fetch {
  return async (input, init) => {
    const url = new URL(String(input));
    calls.push(url);
    const headers = new Headers(init?.headers);
    expect(headers.get("apikey")).toBe(config.key);
    expect(headers.has("Authorization")).toBe(false);
    const rows = url.pathname.endsWith("/services") ? services : inventory;
    const offset = Number(url.searchParams.get("offset"));
    return Response.json(rows.slice(offset), { headers: { "Content-Range": `0-${rows.length - 1}/${rows.length}` } });
  };
}

describe("Supabase configuration", () => {
  it("keeps JSON as the default and requires private credentials for Supabase", () => {
    expect(readSupabaseConfig({})).toBeUndefined();
    expect(() => readSupabaseConfig({ CATALOG_SOURCE: "supabase" })).toThrow("SUPABASE_URL");
    expect(() => readSupabaseConfig({
      CATALOG_SOURCE: "supabase", SUPABASE_URL: "not a url", SUPABASE_SECRET_KEY: config.key,
    })).toThrow("SUPABASE_URL");
    expect(() => readSupabaseConfig({
      CATALOG_SOURCE: "supabase", SUPABASE_URL: config.url, SUPABASE_SECRET_KEY: "sb_publishable_wrong",
    })).toThrow("serverio");
    expect(readSupabaseConfig({
      CATALOG_SOURCE: "supabase", SUPABASE_URL: `${config.url}/`, SUPABASE_SECRET_KEY: config.key,
    })).toEqual(config);
  });

  it("accepts a legacy service_role key but rejects an anon key", () => {
    const key = (role: string) => `header.${Buffer.from(JSON.stringify({ role })).toString("base64url")}.signature`;
    const env = { CATALOG_SOURCE: "supabase", SUPABASE_URL: config.url };
    expect(readSupabaseConfig({ ...env, SUPABASE_SERVICE_ROLE_KEY: key("service_role") })?.key).toBe(key("service_role"));
    expect(() => readSupabaseConfig({ ...env, SUPABASE_SERVICE_ROLE_KEY: key("anon") })).toThrow("serverio");
  });
});

describe("Supabase catalog", () => {
  it("maps the existing SQL columns and keeps money and stock accurate", async () => {
    const calls: URL[] = [];
    const catalog = await new SupabaseCatalog(config, fixtureFetch(calls)).load();
    expect(catalog.services[0]).toMatchObject({ id: "tyre_change", priceFrom: 40, durationMinutes: 60 });
    expect(catalog.inventory[0]).toMatchObject({ sku: "demo_r16_winter", quantity: 8, price: 65, currency: "EUR" });
    expect(calls).toHaveLength(2);
    expect(calls.some((url) => url.pathname.endsWith("/bookings"))).toBe(false);
  });

  it("reads the next page when the project has a smaller API row limit", async () => {
    const seen: string[] = [];
    const fetcher: typeof fetch = async (input) => {
      const url = new URL(String(input));
      const offset = Number(url.searchParams.get("offset"));
      seen.push(`${url.pathname}:${offset}`);
      const rows = url.pathname.endsWith("/services") ? services : inventory;
      // No count header: emulate a server that returns one row per page.
      return Response.json(offset < 2 ? rows : []);
    };
    const catalog = await new SupabaseCatalog(config, fetcher).load();
    expect(catalog.inventory).toHaveLength(2);
    expect(seen).toContain("/rest/v1/inventory:2");
  });

  it("surfaces database failures without leaking credentials or returning JSON fixtures", async () => {
    const fetcher: typeof fetch = async () => new Response(`private: ${config.key}`, { status: 403 });
    await expect(new SupabaseCatalog(config, fetcher).load()).rejects.toThrow("HTTP 403");
    try { await new SupabaseCatalog(config, fetcher).load(); } catch (error) {
      expect(String(error)).not.toContain(config.key);
    }
    const malformed: typeof fetch = async (input) => Response.json(
      String(input).includes("/services") ? [{ ...services[0], price_eur: null }] : [],
      { headers: { "Content-Range": "0-0/1" } },
    );
    await expect(new SupabaseCatalog(config, malformed).load()).rejects.toThrow("services.price_eur");
  });

  it("uses the cloud catalog only for the mapped tenant", async () => {
    const harness = await createHarness();
    try {
      await addSecondTenant(harness.dataDir);
      const calls: URL[] = [];
      const tenants = new TenantRepository(harness.dataDir, {
        catalog: new SupabaseCatalog(config, fixtureFetch(calls)), catalogTenantId: config.tenantId,
      });
      expect((await tenants.getOrThrow("demo-tire")).inventory[0]?.price).toBe(65);
      expect((await tenants.getOrThrow("demo-second")).inventory[0]?.price).toBe(129);
      expect(calls).toHaveLength(2);
    } finally { await harness.cleanup(); }
  });

  it("serves a call through the existing API using the Supabase price", async () => {
    const harness = await createHarness();
    let server: Server | undefined;
    try {
      const tenants = new TenantRepository(harness.dataDir, {
        catalog: new SupabaseCatalog(config, fixtureFetch()), catalogTenantId: config.tenantId,
      });
      const agent = new CallAgent({ dataDir: harness.dataDir, tenants });
      server = createApiServer({ dataDir: harness.dataDir, agent, tenants, catalogSource: "supabase" });
      await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
      const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      expect(await (await fetch(`${baseUrl}/health`)).json()).toMatchObject({ catalogSource: "supabase" });
      const start = await (await fetch(`${baseUrl}/api/calls`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tenantId: "demo-tire" }),
      })).json() as { callId: string };
      const message = await (await fetch(`${baseUrl}/api/calls/${start.callId}/messages`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "Ieškau 4 žieminių padangų 205/55 R16" }),
      })).json() as { state: { phase: string; offer: Array<{ unitPrice: number }> } };
      expect(message.state.phase).toBe("tire_offer");
      expect(message.state.offer[0]?.unitPrice).toBe(65);
    } finally {
      if (server) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
      await harness.cleanup();
    }
  });
});
