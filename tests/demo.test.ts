import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApiServer } from "../src/api/server.js";
import { DEMO_EMAIL, DEMO_PASSWORD_DEFAULT, DemoAuth, DemoStore, createDemoApi } from "../src/demo/api.js";
import { buildSeed } from "../src/demo/seed.js";
import { createHarness } from "./helpers.js";

// A Wednesday in the middle of a working week; 09:00 local so same-day slots exist.
const NOW = new Date(2026, 9, 28, 9, 0, 0);

let harness: Awaited<ReturnType<typeof createHarness>>;
let server: Server;
let base: string;
let store: DemoStore;
let token = "";

async function call(method: string, path: string, body?: unknown, auth = true): Promise<{ status: number; data: any }> {
  const res = await fetch(`${base}/api/demo${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(auth && token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
}
const get = (p: string) => call("GET", p);
const post = (p: string, b: unknown = {}) => call("POST", p, b);

beforeEach(async () => {
  harness = await createHarness();
  store = new DemoStore(buildSeed(NOW), () => NOW);
  server = createApiServer({ dataDir: harness.dataDir, agent: harness.agent, demo: createDemoApi(store, new DemoAuth()) });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  token = (await call("POST", "/login", { email: DEMO_EMAIL, password: DEMO_PASSWORD_DEFAULT }, false)).data.token;
});
afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await harness.cleanup();
});

describe("demo access control", () => {
  it("rejects missing, wrong and forged credentials", async () => {
    expect((await call("GET", "/dashboard", undefined, false)).status).toBe(401);
    expect((await call("POST", "/login", { email: DEMO_EMAIL, password: "nope" }, false)).status).toBe(401);
    const forged = await fetch(`${base}/api/demo/dashboard`, { headers: { Authorization: "Bearer abc.def" } });
    expect(forged.status).toBe(401);
    expect(token).toBeTruthy();
  });
  it("serves the demo page and keeps the legacy API working", async () => {
    expect((await fetch(`${base}/demo`)).status).toBe(200);
    expect((await fetch(`${base}/health`)).status).toBe(200);
    expect((await fetch(`${base}/api/tenants`)).status).toBe(200);
  });
  it("throttles repeated bad logins", async () => {
    let last = 0;
    for (let i = 0; i < 10; i++) last = (await call("POST", "/login", { email: "x@y.z", password: "bad" }, false)).status;
    expect(last).toBe(429);
  });
});

describe("seed realism", () => {
  it("meets the requested volumes with no double-booking or over-reservation", async () => {
    const s = store.state;
    expect(s.customers.length).toBeGreaterThanOrEqual(40);
    expect(s.bookings.length).toBeGreaterThanOrEqual(60);
    expect(s.calls.length).toBeGreaterThanOrEqual(100);
    expect(s.parts.length).toBeGreaterThanOrEqual(30);
    const inv = (await get("/inventory")).data;
    expect(inv.summary.out_of_stock).toBeGreaterThan(0);
    expect(inv.summary.low_stock).toBeGreaterThan(0);
    expect(inv.items.every((p: any) => p.reserved <= p.quantity)).toBe(true);
    const live = s.bookings.filter((b) => b.status === "confirmed" || b.status === "pending");
    for (const a of live) for (const b of live) {
      if (a.id < b.id && a.mechanicId === b.mechanicId && a.date === b.date) {
        const a0 = Number(a.start.slice(0, 2)) * 60 + Number(a.start.slice(3));
        const b0 = Number(b.start.slice(0, 2)) * 60 + Number(b.start.slice(3));
        expect(a0 < b0 + b.durationMin && b0 < a0 + a.durationMin).toBe(false);
      }
    }
    expect(["completed", "missed", "new_inquiry", "follow_up"].every((st) => s.calls.some((c) => c.status === st))).toBe(true);
  });
  it("produces dashboard figures", async () => {
    const d = (await get("/dashboard")).data;
    expect(d.cards.callsToday).toBeGreaterThan(0);
    expect(d.cards.upcomingAppointments).toBeGreaterThan(0);
    expect(d.cards.repairsAwaitingParts).toBeGreaterThan(0);
    expect(d.cards.pendingJobValue).toBeGreaterThan(0);
  });
});

describe("customers and vehicles", () => {
  it("validates input, persists edits and rejects duplicates", async () => {
    expect((await post("/customers", { name: "A", phone: "123" })).status).toBe(400);
    expect((await post("/customers", { name: "Jane Test", phone: "abc" })).status).toBe(400);
    const ok = await post("/customers", { name: "Jane Test", phone: "+1 555-0188", email: "jane@example.test" });
    expect(ok.status).toBe(201);
    expect((await post("/customers", { name: "Jane Two", phone: "+1 555 0188" })).status).toBe(409);
    const v = await post("/vehicles", { customerId: ok.data.id, make: "Ford", model: "Focus", year: 2017, reg: "demo-zz999" });
    expect(v.status).toBe(201);
    expect(v.data.reg).toBe("DEMO-ZZ999");
    expect((await post("/vehicles", { customerId: ok.data.id, make: "Ford", model: "Focus", year: 1850, reg: "DEMO-ZZ998" })).status).toBe(400);
    expect((await post("/vehicles", { customerId: ok.data.id, make: "Ford", model: "Focus", year: 2017, reg: "DEMO-ZZ999" })).status).toBe(409);
    const patched = await call("PATCH", `/customers/${ok.data.id}`, { name: "Jane Renamed" });
    expect(patched.data.name).toBe("Jane Renamed");
    const detail = (await get(`/customers/${ok.data.id}`)).data;
    expect(detail.customer.name).toBe("Jane Renamed");
    expect(detail.vehicles).toHaveLength(1);
    expect((await get("/customers?q=DEMO-ZZ999")).data.total).toBe(1);
  });
});

describe("calendar rules", () => {
  async function pick(repairType = "oil_service") {
    const customer = store.state.customers[10]!;
    const vehicle = store.state.vehicles.find((x) => x.customerId === customer.id)!;
    return { customerId: customer.id, vehicleId: vehicle.id, repairType };
  }
  it("creates, reschedules and cancels while preventing conflicts", async () => {
    const base0 = await pick();
    const date = "2026-11-17"; // a Tuesday with no seeded bookings
    const first = await post("/bookings", { ...base0, date, start: "09:00", mechanicId: "M-1" });
    expect(first.status).toBe(201);
    const clash = await post("/bookings", { ...base0, date, start: "09:30", mechanicId: "M-1" });
    expect(clash.status).toBe(409);
    expect(clash.data.error).toMatch(/already booked/);
    // other mechanic is fine at the same time
    const other = await post("/bookings", { ...base0, date, start: "09:30", mechanicId: "M-2" });
    expect(other.status).toBe(201);
    // outside hours, break, Sunday, past, bad duration
    expect((await post("/bookings", { ...base0, date, start: "07:00", mechanicId: "M-3" })).status).toBe(409);
    expect((await post("/bookings", { ...base0, date, start: "11:30", mechanicId: "M-3" })).data.error).toMatch(/break/);
    expect((await post("/bookings", { ...base0, date: "2026-11-15", start: "10:00" })).data.error).toMatch(/closed/);
    expect((await post("/bookings", { ...base0, date: "2026-10-20", start: "10:00" })).data.error).toMatch(/past/);
    expect((await post("/bookings", { ...base0, date, start: "10:00", durationMin: 37 })).status).toBe(400);
    // reschedule onto a busy slot fails, onto a free slot works and frees the old one
    expect((await call("PATCH", `/bookings/${other.data.id}`, { mechanicId: "M-1", start: "09:00" })).status).toBe(409);
    const moved = await call("PATCH", `/bookings/${first.data.id}`, { start: "14:00" });
    expect(moved.status).toBe(200);
    expect((await post("/bookings", { ...base0, date, start: "09:00", mechanicId: "M-1" })).status).toBe(201);
    // cancel releases the slot
    const cancel = await post(`/bookings/${moved.data.id}/cancel`);
    expect(cancel.data.status).toBe("cancelled");
    expect((await post("/bookings", { ...base0, date, start: "14:00", mechanicId: "M-1" })).status).toBe(201);
    expect((await post(`/bookings/${moved.data.id}/cancel`)).status).toBe(409);
  });
  it("cannot double-book under concurrent requests", async () => {
    const base0 = await pick();
    const date = "2026-11-18";
    const results = await Promise.all(Array.from({ length: 8 }, () => post("/bookings", { ...base0, date, start: "10:00", mechanicId: "M-2" })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(7);
  });
  it("shows the same appointment in calendar views and details", async () => {
    const b = store.state.bookings.find((x) => x.status === "confirmed")!;
    const cal = (await get(`/calendar?from=${b.date}&to=${b.date}`)).data;
    expect(cal.items.some((x: any) => x.id === b.id)).toBe(true);
    const detail = (await get(`/bookings/${b.id}`)).data;
    expect(detail.customerName).toBeTruthy();
    expect(detail.parts).toBeDefined();
    expect((await get("/calendar?from=2026-01-01&to=2026-12-31")).status).toBe(400);
  });
});

describe("inventory, reservations and parts requests", () => {
  it("does not count reserved stock twice and flags the shortfall", async () => {
    const s = store.state;
    const golf = s.vehicles.find((v) => v.model === "Golf")!;
    const pads = s.parts.find((p) => p.sku === "BPF-GLF-1201")!;
    const discs = s.parts.find((p) => p.sku === "BDF-GLF-1202")!;
    expect(discs.quantity).toBe(0);
    expect(pads.quantity).toBeGreaterThan(0);
    const created = await post("/service-requests", { customerId: golf.customerId, vehicleId: golf.id, repairType: "brake_service_front" });
    expect(created.status).toBe(201);
    const checks = created.data.partChecks;
    expect(checks.find((c: any) => c.kind === "brake_pads_front").shortfall).toBe(0);
    expect(checks.find((c: any) => c.kind === "brake_discs_front").shortfall).toBe(1);
    const reqs = (await get("/requests")).data.items.filter((r: any) => r.jobId === created.data.id);
    expect(reqs).toHaveLength(1);
    expect(reqs[0].lines).toHaveLength(1);
    expect(reqs[0].lines[0].priceSource).toMatch(/Simulated/);
    expect(reqs[0].status).toBe("awaiting_approval");
  });
  it("blocks stock adjustments that would break reservations and updates later checks", async () => {
    const s = store.state;
    const reservedPart = s.parts.find((p) => p.sku === "OFI-FRD-3315")!;
    const inv = (await get("/inventory?q=OFI-FRD-3315")).data.items[0];
    expect(inv.reserved).toBeGreaterThan(0);
    const bad = await post(`/inventory/${reservedPart.id}/adjust`, { delta: -(inv.quantity - inv.reserved + 1), reason: "test removal" });
    expect(bad.status).toBe(409);
    expect((await post(`/inventory/${reservedPart.id}/adjust`, { delta: 0, reason: "nothing" })).status).toBe(400);
    expect((await post(`/inventory/${reservedPart.id}/adjust`, { delta: 3, reason: "" })).status).toBe(400);
    const up = await post(`/inventory/${reservedPart.id}/adjust`, { delta: 3, reason: "Supplier delivery (test)" });
    expect(up.data.part.quantity).toBe(inv.quantity + 3);
    const moves = (await get(`/inventory/${reservedPart.id}/movements`)).data;
    expect(moves.movements[0].delta).toBe(3);
  });
  it("requires human approval, an explicit order and receipt before the job moves on — and never double-creates", async () => {
    const s = store.state;
    const req = s.requests.find((r) => r.status === "awaiting_approval")!;
    const jobId = req.jobId;
    expect((await post(`/requests/${req.id}/action`, { action: "ordered" })).status).toBe(409);
    expect((await post(`/requests/${req.id}/action`, { action: "receive" })).status).toBe(409);
    const approved = await post(`/requests/${req.id}/action`, { action: "approve", confirmFitment: true });
    expect(approved.data.status).toBe("approved");
    expect(approved.data.approval).toBe("approved");
    expect((await post(`/requests/${req.id}/action`, { action: "receive" })).status).toBe(409);
    expect((await post(`/requests/${req.id}/action`, { action: "ordered" })).data.status).toBe("ordered");
    const part = s.parts.find((p) => p.id === req.lines[0]!.partId)!;
    const before = part.quantity;
    const received = await post(`/requests/${req.id}/action`, { action: "receive" });
    expect(received.data.status).toBe("ready_for_repair");
    expect(part.quantity).toBe(before + req.lines[0]!.shortfall);
    const job = (await get("/jobs?status=")).data.items.find((j: any) => j.id === jobId);
    expect(["scheduled", "ready"]).toContain(job.status);
    // completing the job consumes the reserved stock
    const done = await call("PATCH", `/jobs/${jobId}`, { status: "completed" });
    expect(done.data.status).toBe("completed");
    expect(part.quantity).toBe(before + req.lines[0]!.shortfall - 1);
  });
  it("refuses to complete a job whose parts are missing and blocks approval of unverified fitment", async () => {
    const s = store.state;
    const waiting = s.jobs.find((j) => j.status === "awaiting_parts")!;
    expect((await call("PATCH", `/jobs/${waiting.id}`, { status: "completed" })).status).toBe(409);
    const unsure = s.requests.find((r) => r.lines.some((l) => l.compat === "uncertain" && l.shortfall > 0 && ["awaiting_approval", "parts_required"].includes(r.status)));
    if (unsure) expect((await post(`/requests/${unsure.id}/action`, { action: "approve" })).status).toBe(409);
  });
});

describe("simulated AI receptionist", () => {
  async function run(scenario: string, extra: string[] = []) {
    const list = (await get("/scenarios")).data.items;
    const sc = list.find((x: any) => x.id === scenario);
    let sess = (await post("/agent/sessions", { scenario, callerId: sc.callerId })).data;
    for (const line of [...sc.script, ...extra]) {
      if (sess.stage === "confirmed" || sess.stage === "ended") break;
      const r = await post(`/agent/sessions/${sess.id}/messages`, { text: line });
      expect(r.status).toBe(200);
      sess = r.data;
    }
    return sess;
  }
  const lastAi = (s: any) => [...s.transcript].reverse().find((t: any) => t.role === "ai").text as string;

  it("A: books an in-stock service and links every record", async () => {
    const before = store.state.calls.length;
    const s = await run("A");
    expect(s.stage).toBe("confirmed");
    expect(s.result.requestId).toBeUndefined();
    expect(s.plan.missing).toHaveLength(0);
    const call = (await get(`/calls/${s.result.callId}`)).data;
    expect(call.call.simulated).toBe(true);
    expect(call.booking.customerName).toBeTruthy();
    expect(call.job.id).toBe(s.result.jobId);
    expect(store.state.calls.length).toBe(before + 1);
    const cal = (await get(`/calendar?from=${call.booking.date}&to=${call.booking.date}`)).data;
    expect(cal.items.some((x: any) => x.id === s.result.bookingIds[0])).toBe(true);
  });
  it("B: inspects instead of diagnosing, sources the missing disc, orders nothing", async () => {
    const s = await run("B");
    expect(s.stage).toBe("confirmed");
    expect(s.result.bookingIds).toHaveLength(2);
    const bookings = s.result.bookingIds.map((id: string) => store.state.bookings.find((b) => b.id === id)!);
    expect(bookings[0]!.kind).toBe("inspection");
    expect(bookings[1]!.status).toBe("pending");
    expect(bookings[0]!.aiAssessment).toMatch(/not confirmed|must inspect|before any repair/i);
    expect(bookings[1]!.aiAssessment).toMatch(/NOT a diagnosis/);
    const req = store.state.requests.find((r) => r.id === s.result.requestId)!;
    expect(req.lines.map((l) => l.kind)).toEqual(["brake_discs_front"]);
    expect(["ordered", "approved"]).not.toContain(req.status);
    expect(req.approval).toBe("pending");
    expect(req.history.some((h) => /ordered/i.test(h.text) && !/Nothing/i.test(h.text))).toBe(false);
    expect(bookings[1]!.date > req.lines[0]!.etaDate).toBe(true);
    expect(s.steps.find((x: any) => x.id === "sourcing").detail).toMatch(/Nothing is ordered/);
  });
  it("C: detects the conflict, offers alternatives and books only after a choice", async () => {
    const list = (await get("/scenarios")).data.items.find((x: any) => x.id === "C");
    let sess = (await post("/agent/sessions", { scenario: "C", callerId: list.callerId })).data;
    sess = (await post(`/agent/sessions/${sess.id}/messages`, { text: list.script[0] })).data;
    expect(sess.stage).toBe("offering");
    expect(lastAi(sess)).toMatch(/isn't available/);
    expect(sess.options.length).toBeGreaterThanOrEqual(2);
    const bookingsBefore = store.state.bookings.length;
    const unclear = await post(`/agent/sessions/${sess.id}/messages`, { text: "hmm what do you think" });
    expect(unclear.data.stage).toBe("offering");
    expect(store.state.bookings.length).toBe(bookingsBefore);
    sess = (await post(`/agent/sessions/${sess.id}/choose`, { optionId: sess.options[1].id })).data;
    expect(sess.stage).toBe("confirmed");
    expect(store.state.bookings.length).toBe(bookingsBefore + 1);
    expect((await post(`/agent/sessions/${sess.id}/messages`, { text: "hello again" })).status).toBe(409);
  });
  it("D: checks each part individually and builds one consolidated request with a total", async () => {
    const s = await run("D");
    expect(s.stage).toBe("confirmed");
    const req = store.state.requests.find((r) => r.id === s.result.requestId)!;
    expect(req.lines.map((l) => l.kind).sort()).toEqual(["timing_belt_kit", "water_pump"]);
    expect(req.total).toBeGreaterThan(0);
    expect(req.status).toBe("awaiting_approval");
    const open = store.state.requests.filter((r) => r.jobId === req.jobId);
    expect(open).toHaveLength(1);
  });
  it("E: reports the recorded job status and books a follow-up without a duplicate request", async () => {
    const reqCount = store.state.requests.length;
    const s = await run("E");
    expect(s.stage).toBe("confirmed");
    expect(s.transcript.some((t: any) => t.role === "ai" && /Job J-\d+/.test(t.text))).toBe(true);
    expect(store.state.requests.length).toBe(reqCount);
    const b = store.state.bookings.find((x) => x.id === s.result.bookingIds[0])!;
    expect(b.repairType).toBe("Follow-up check");
    expect(b.jobId).toBe(s.result.jobId);
  });
  it("collects name, phone and vehicle for a brand-new caller and creates records", async () => {
    let sess = (await post("/agent/sessions", {})).data;
    const say = async (t: string) => { const r = await post(`/agent/sessions/${sess.id}/messages`, { text: t }); expect(r.status).toBe(200); sess = r.data; };
    await say("I'd like an oil change please");
    expect(sess.awaiting).toBe("name");
    await say("My name is Priya Shah");
    expect(sess.awaiting).toBe("phone");
    await say("+1 555-0177");
    expect(sess.awaiting).toBe("vehicle");
    await say("2016 Toyota Corolla");
    expect(sess.stage).toBe("offering");
    await say("option 1");
    expect(sess.stage).toBe("confirmed");
    const c = store.state.customers.find((x) => x.name === "Priya Shah")!;
    expect(c).toBeTruthy();
    expect(store.state.vehicles.some((v) => v.customerId === c.id && v.model === "Corolla")).toBe(true);
    const customer = (await get(`/customers/${c.id}`)).data;
    expect(customer.calls).toHaveLength(1);
    expect(customer.bookings).toHaveLength(1);
  });
  it("books an inspection when the customer is unsure, and validates input", async () => {
    let sess = (await post("/agent/sessions", { callerId: "+1 555-0101" })).data;
    const r = await post(`/agent/sessions/${sess.id}/messages`, { text: "I'm not sure what's wrong but I think the clutch is slipping, can you replace it?" });
    sess = r.data;
    expect(sess.plan.intent).toBe("inspection");
    expect(sess.plan.likelyRepairType).toBe("clutch");
    expect((await post(`/agent/sessions/${sess.id}/messages`, { text: "   " })).status).toBe(400);
    expect((await post("/agent/sessions", { callerId: "not a number" })).status).toBe(400);
    expect((await post("/agent/sessions/S-9999/messages", { text: "hi" })).status).toBe(404);
  });
});

describe("in-memory demo state", () => {
  it("keeps changes across requests within a running server and restores them on reset", async () => {
    const c = await post("/customers", { name: "Memory Check", phone: "+1 555-0166" });
    expect(c.status).toBe(201);
    expect((await get("/customers?q=Memory")).data.total).toBe(1);
    expect((await post("/reset")).status).toBe(200);
    expect((await get("/customers?q=Memory")).data.total).toBe(0);
  });
  it("rolls back a failed mutation", async () => {
    const before = store.state.customers.length;
    await expect(store.mutate((st) => { st.customers.pop(); throw new Error("boom"); })).rejects.toThrow("boom");
    expect(store.state.customers.length).toBe(before);
  });
  it("does not write any demo file to disk", async () => {
    const { existsSync } = await import("node:fs");
    const path = await import("node:path");
    await post("/customers", { name: "No File", phone: "+1 555-0167" });
    expect(existsSync(path.join(harness.dataDir, "demo"))).toBe(false);
  });
});
