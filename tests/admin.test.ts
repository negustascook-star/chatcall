import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApiServer } from "../src/api/server.js";
import type {
  AdminAppointment,
  AdminCall,
  AdminCompany,
  AdminDataSource,
  AdminStats,
  PlanCode,
} from "../src/supabase/admin.js";
import { createHarness } from "./helpers.js";

const COMPANY_ID = "ac871830-632c-4595-a48c-16d3e6dee817";

class FakeAdmin implements AdminDataSource {
  updated: { id: string; planCode: PlanCode } | undefined;
  lastAppointmentsLimit: number | undefined;
  lastCallsLimit: number | undefined;

  constructor(
    private readonly companies: AdminCompany[] = [{
      id: COMPANY_ID,
      name: "APEX",
      ownerId: "c6e96d4b-a4db-4a5e-b930-2d666bb59dcb",
      ownerEmail: "owner@example.com",
      address: "Vilnius",
      phone: "+370 600 00000",
      planCode: "pending",
      paidAt: null,
      createdAt: "2026-10-28T16:00:00.000Z",
      appointments: 2,
      calls: 1,
      services: 3,
      specialists: 1,
    }],
    private readonly appointments: AdminAppointment[] = [{
      id: "11111111-1111-1111-1111-111111111111",
      companyId: COMPANY_ID,
      companyName: "APEX",
      customerName: "Jonas",
      customerPhone: "+370 600 11111",
      serviceName: "Tyre change",
      specialistId: null,
      startsAt: "2026-10-29T09:00:00.000Z",
      endsAt: "2026-10-29T09:30:00.000Z",
      status: "confirmed",
      createdAt: "2026-10-28T16:00:00.000Z",
    }],
    private readonly calls: AdminCall[] = [{
      id: "22222222-2222-2222-2222-222222222222",
      companyId: COMPANY_ID,
      companyName: "APEX",
      customerName: "Petras",
      customerPhone: "+370 600 22222",
      summary: "Asked about winter tyres.",
      status: "completed",
      createdAt: "2026-10-28T16:00:00.000Z",
    }],
  ) {}

  async overview(): Promise<{ stats: AdminStats; companies: AdminCompany[] }> {
    return {
      stats: {
        companies: this.companies.length,
        users: 1,
        appointments: this.appointments.length,
        calls: this.calls.length,
        services: 3,
        specialists: 1,
        paidCompanies: this.companies.filter((company) => company.planCode !== "pending").length,
      },
      companies: this.companies,
    };
  }

  async listCompanies(): Promise<AdminCompany[]> {
    return this.companies;
  }

  async updateCompanyPlan(id: string, planCode: PlanCode): Promise<AdminCompany | undefined> {
    this.updated = { id, planCode };
    const company = this.companies.find((entry) => entry.id === id);
    if (!company) return undefined;
    company.planCode = planCode;
    company.paidAt = planCode === "pending" ? null : "2026-10-28T17:00:00.000Z";
    return company;
  }

  async listAppointments(limit = 100): Promise<AdminAppointment[]> {
    this.lastAppointmentsLimit = limit;
    return this.appointments.slice(0, limit);
  }

  async listCalls(limit = 100): Promise<AdminCall[]> {
    this.lastCallsLimit = limit;
    return this.calls.slice(0, limit);
  }
}

let harness: Awaited<ReturnType<typeof createHarness>>;
let server: Server;
let baseUrl: string;
let admin: FakeAdmin;

beforeEach(async () => {
  harness = await createHarness();
  admin = new FakeAdmin();
  server = createApiServer({
    dataDir: harness.dataDir,
    agent: harness.agent,
    adminKey: "ADMIN123",
    admin,
  });
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

describe("admin panel", () => {
  it("serves the dashboard and protects the API with ADMIN_KEY", async () => {
    const page = await fetch(`${baseUrl}/admin.html`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Administratoriaus panelė");

    const unauthorized = await fetch(`${baseUrl}/api/admin/overview`);
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("access-control-allow-origin")).toBeNull();

    const wrongKey = await fetch(`${baseUrl}/api/admin/overview`, {
      headers: { "x-admin-key": "wrong" },
    });
    expect(wrongKey.status).toBe(401);

    const authorized = await fetch(`${baseUrl}/api/admin/overview`, {
      headers: { "x-admin-key": "ADMIN123" },
    });
    expect(authorized.status).toBe(200);
    expect(authorized.headers.get("access-control-allow-origin")).toBeNull();
    const body = (await authorized.json()) as { stats: AdminStats; companies: AdminCompany[] };
    expect(body.stats.companies).toBe(1);
    expect(body.stats.appointments).toBe(1);
    expect(body.companies[0]?.name).toBe("APEX");
  });

  it("accepts the key as a bearer token and lists dashboard data", async () => {
    const headers = { Authorization: "Bearer ADMIN123" };
    const companies = await fetch(`${baseUrl}/api/admin/companies`, { headers });
    expect(companies.status).toBe(200);
    expect(((await companies.json()) as { companies: AdminCompany[] }).companies).toHaveLength(1);

    const appointments = await fetch(`${baseUrl}/api/admin/appointments?limit=5`, { headers });
    expect(appointments.status).toBe(200);
    expect(((await appointments.json()) as { appointments: AdminAppointment[] }).appointments).toHaveLength(1);
    expect(admin.lastAppointmentsLimit).toBe(5);

    const calls = await fetch(`${baseUrl}/api/admin/calls?limit=3`, { headers });
    expect(calls.status).toBe(200);
    expect(admin.lastCallsLimit).toBe(3);
  });

  it("updates a company plan and validates the request", async () => {
    const headers = { "x-admin-key": "ADMIN123", "Content-Type": "application/json" };
    const updated = await fetch(`${baseUrl}/api/admin/companies/${COMPANY_ID}/plan`, {
      method: "POST",
      headers,
      body: JSON.stringify({ planCode: "warehouse" }),
    });
    expect(updated.status).toBe(200);
    const body = (await updated.json()) as { company: AdminCompany };
    expect(body.company.planCode).toBe("warehouse");
    expect(admin.updated).toEqual({ id: COMPANY_ID, planCode: "warehouse" });

    const invalidPlan = await fetch(`${baseUrl}/api/admin/companies/${COMPANY_ID}/plan`, {
      method: "POST",
      headers,
      body: JSON.stringify({ planCode: "free" }),
    });
    expect(invalidPlan.status).toBe(400);

    const invalidId = await fetch(`${baseUrl}/api/admin/companies/not-a-uuid/plan`, {
      method: "POST",
      headers,
      body: JSON.stringify({ planCode: "warehouse" }),
    });
    expect(invalidId.status).toBe(400);

    const unknownCompany = await fetch(`${baseUrl}/api/admin/companies/33333333-3333-3333-3333-333333333333/plan`, {
      method: "POST",
      headers,
      body: JSON.stringify({ planCode: "warehouse" }),
    });
    expect(unknownCompany.status).toBe(404);

    const invalidLimit = await fetch(`${baseUrl}/api/admin/appointments?limit=501`, {
      headers: { "x-admin-key": "ADMIN123" },
    });
    expect(invalidLimit.status).toBe(400);
  });

  it("returns 503 when ADMIN_KEY is not configured", async () => {
    const secondServer = createApiServer({
      dataDir: harness.dataDir,
      agent: harness.agent,
      admin,
    });
    await new Promise<void>((resolve) => secondServer.listen(0, "127.0.0.1", resolve));
    const address = secondServer.address() as AddressInfo;
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/admin/overview`, {
        headers: { "x-admin-key": "ADMIN123" },
      });
      expect(response.status).toBe(503);
    } finally {
      await new Promise<void>((resolve, reject) => {
        secondServer.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
