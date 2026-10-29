/** In-memory store + HTTP routes for the demo portal. Isolated from Supabase and from every real tenant. */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { chooseOption, endSession, handleMessage, scenarioList, startSession } from "./agent.js";
import {
  adjustStock, bookingFromForm, bookingOf, cancelBooking, completeBooking, createPart, createServiceRequest, createCustomer, createVehicle,
  customerOf, jobRequestSummary, openRequestOf, partOf, requestAction, updateBooking, updateCustomer, updateJob, updatePart, updateTask, updateVehicle, vehicleOf,
} from "./ops.js";
import { buildSeed, MECHANICS } from "./seed.js";
import {
  HOURS_TEXT, LABOR_RATE, OPEN_JOB_STATUSES, REPAIR_TYPES, SHOP_NAME, ValidationError, addDays, availableQty, dayHours, findSlots, fromMin, jobOf,
  localDate, nowMinutes, parseDate, repairType, reservedQty, stockStatus, toMin, weekStart,
} from "./rules.js";
import { OPEN_REQUEST, jobPartChecks } from "./sourcing.js";
import type { DemoState, Job, Part } from "./types.js";

export const DEMO_EMAIL = "demo@aicall.example";
export const DEMO_PASSWORD_DEFAULT = "DemoGarage2026!";
const TOKEN_TTL_MS = 8 * 3_600_000;

/** In-memory demo data, generated from the seed at server start. No files, no database. */
export class DemoStore {
  state: DemoState;
  constructor(state: DemoState, readonly now: () => Date = () => new Date()) {
    this.state = state;
  }
  static open(now: () => Date = () => new Date()): DemoStore {
    return new DemoStore(buildSeed(now()), now);
  }
  /**
   * Runs a mutation synchronously, so concurrent requests can never interleave. If it throws, the state is
   * restored to what it was before, so a half-applied change is never visible.
   */
  async mutate<T>(fn: (state: DemoState, now: Date) => T): Promise<T> {
    const snapshot = JSON.stringify(this.state);
    try {
      return fn(this.state, this.now());
    } catch (error) {
      // Restore in place so every holder of `store.state` keeps pointing at the live object.
      const restored = JSON.parse(snapshot) as DemoState;
      for (const key of Object.keys(this.state) as (keyof DemoState)[]) delete this.state[key];
      Object.assign(this.state, restored);
      throw error;
    }
  }
  async reset(): Promise<void> {
    const fresh = buildSeed(this.now());
    for (const key of Object.keys(this.state) as (keyof DemoState)[]) delete this.state[key];
    Object.assign(this.state, fresh);
  }
}

// -------------------------------------------------------------------------- auth

export class DemoAuth {
  private readonly key = randomBytes(32);
  private readonly attempts = new Map<string, { n: number; reset: number }>();
  constructor(private readonly email = DEMO_EMAIL, private readonly password = DEMO_PASSWORD_DEFAULT) {}
  private static eq(a: string, b: string): boolean {
    const x = createHmac("sha256", "cmp").update(a).digest();
    const y = createHmac("sha256", "cmp").update(b).digest();
    return timingSafeEqual(x, y);
  }
  login(email: unknown, password: unknown, ip: string, nowMs: number): string {
    const a = this.attempts.get(ip);
    if (a && a.reset > nowMs && a.n >= 8) throw new ValidationError("Too many sign-in attempts. Please wait a few minutes.", 429);
    const ok = typeof email === "string" && typeof password === "string"
      && DemoAuth.eq(email.trim().toLowerCase(), this.email.toLowerCase()) && DemoAuth.eq(password, this.password);
    if (!ok) {
      const cur = a && a.reset > nowMs ? a : { n: 0, reset: nowMs + 10 * 60_000 };
      cur.n++;
      this.attempts.set(ip, cur);
      throw new ValidationError("Incorrect email or password.", 401);
    }
    this.attempts.delete(ip);
    const payload = Buffer.from(JSON.stringify({ sub: "demo", exp: nowMs + TOKEN_TTL_MS })).toString("base64url");
    return `${payload}.${createHmac("sha256", this.key).update(payload).digest("base64url")}`;
  }
  verify(token: string, nowMs: number): boolean {
    const [payload, sig] = token.split(".");
    if (!payload || !sig) return false;
    const expect = createHmac("sha256", this.key).update(payload).digest("base64url");
    if (!DemoAuth.eq(sig, expect)) return false;
    try { return (JSON.parse(Buffer.from(payload, "base64url").toString()) as { exp: number }).exp > nowMs; } catch { return false; }
  }
}

// --------------------------------------------------------------------- read models

const money = (n: number): number => Math.round(n * 100) / 100;
export const vehicleName = (v: { year: number; make: string; model: string }): string => `${v.year} ${v.make} ${v.model}`;

export function partView(state: DemoState, p: Part) {
  const reserved = reservedQty(state, p.id);
  return { ...p, reserved, available: availableQty(state, p), status: stockStatus(state, p), value: money(p.quantity * p.unitCost) };
}

export function jobView(state: DemoState, job: Job) {
  const v = state.vehicles.find((x) => x.id === job.vehicleId);
  const c = state.customers.find((x) => x.id === job.customerId);
  const checks = jobPartChecks(state, job);
  const req = openRequestOf(state, job.id);
  return {
    ...job, customerName: c?.name ?? "", vehicle: v ? vehicleName(v) : "", reg: v?.reg ?? "", partChecks: checks, requestId: req?.id,
    bookings: state.bookings.filter((b) => b.jobId === job.id).map((b) => b.id),
  };
}

export function bookingView(state: DemoState, id: string) {
  const b = bookingOf(state, id);
  const c = state.customers.find((x) => x.id === b.customerId)!;
  const v = state.vehicles.find((x) => x.id === b.vehicleId)!;
  const job = state.jobs.find((j) => j.id === b.jobId)!;
  const checks = job.status === "completed" || job.status === "cancelled" ? [] : jobPartChecks(state, job);
  const missing = checks.filter((x) => x.shortfall > 0);
  const mech = state.mechanics.find((m) => m.id === b.mechanicId)!;
  const req = state.requests.find((r) => r.jobId === job.id && OPEN_REQUEST.includes(r.status));
  return {
    ...b, endTime: fromMin(toMin(b.start) + b.durationMin), customerName: c.name, customerPhone: c.phone, vehicle: vehicleName(v), reg: v.reg, mechanicName: mech.name,
    jobStatus: job.status, estimate: job.estimate, laborHours: job.laborHours, laborRate: job.laborRate, jobTitle: job.title, parts: checks,
    partsState: !checks.length ? "none" : missing.length ? "missing" : "available", requestId: req?.id, requestStatus: req?.status, callId: b.callId ?? job.callId,
  };
}

export function requestView(state: DemoState, id: string) {
  const r = state.requests.find((x) => x.id === id)!;
  const c = state.customers.find((x) => x.id === r.customerId);
  const v = state.vehicles.find((x) => x.id === r.vehicleId);
  const job = state.jobs.find((j) => j.id === r.jobId);
  return { ...r, customerName: c?.name ?? "", vehicle: v ? vehicleName(v) : "", reg: v?.reg ?? "", jobTitle: job?.title ?? "", jobStatus: job?.status ?? "" };
}

export function customerDetail(state: DemoState, id: string) {
  const c = customerOf(state, id);
  const vehicles = state.vehicles.filter((v) => v.customerId === id);
  const bookings = state.bookings.filter((b) => b.customerId === id).sort((a, b) => (b.date + b.start).localeCompare(a.date + a.start)).map((b) => bookingView(state, b.id));
  const jobs = state.jobs.filter((j) => j.customerId === id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((j) => jobView(state, j));
  const calls = state.calls.filter((x) => x.customerId === id).sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time)).map(({ transcript, ...rest }) => { void transcript; return rest; });
  const requests = state.requests.filter((r) => r.customerId === id).map((r) => requestView(state, r.id));
  return { customer: c, vehicles, bookings, jobs, calls, requests };
}

export function dashboard(state: DemoState, now: Date) {
  const today = localDate(now);
  const nowMin = nowMinutes(now);
  const callsToday = state.calls.filter((c) => c.date === today && c.time <= fromMin(nowMin));
  const active = (b: { status: string }) => b.status === "confirmed" || b.status === "pending";
  const todays = state.bookings.filter((b) => b.date === today && b.status !== "cancelled" && b.status !== "no_show");
  const upcoming = state.bookings.filter((b) => active(b) && (b.date > today || (b.date === today && toMin(b.start) >= nowMin)));
  const openJobs = state.jobs.filter((j) => (OPEN_JOB_STATUSES as readonly string[]).includes(j.status));
  const waiting = openJobs.filter((j) => j.status === "awaiting_parts");
  const openReq = state.requests.filter((r) => OPEN_REQUEST.includes(r.status) && r.lines.some((l) => !l.received && l.shortfall > 0));
  const partsToBuy = openReq.reduce((n, r) => n + r.lines.filter((l) => !l.received).reduce((m, l) => m + l.shortfall, 0), 0);
  const monthStart = `${today.slice(0, 7)}-01`;
  const done = state.jobs.filter((j) => j.status === "completed" && (j.completedAt ?? "").slice(0, 10) >= monthStart);
  const weekFrom = addDays(today, -7);
  const pendingValue = openJobs.reduce((s, j) => s + j.estimate, 0);
  const recent = [
    ...state.calls.map((c) => ({ at: `${c.date}T${c.time}`, type: "call", text: `${c.status === "missed" ? "Missed call from" : "Call from"} ${c.name}${c.requested && c.requested !== "—" ? ` — ${c.requested}` : ""}`, ref: c.id, simulated: c.simulated })),
    ...state.bookings.filter((b) => b.source === "ai_call" && b.createdAt >= addDays(today, -3)).map((b) => ({ at: b.createdAt.replace("Z", ""), type: "booking", text: `Booking ${b.id} created: ${b.repairType} (${b.date} ${b.start})`, ref: b.id, simulated: false })),
  ].filter((x) => x.at.slice(0, 10) <= today).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 10);
  const stockAlerts = state.parts.map((p) => ({ p, status: stockStatus(state, p) })).filter((x) => x.status !== "in_stock")
    .sort((a, b) => ["out_of_stock", "fully_reserved", "low_stock"].indexOf(a.status) - ["out_of_stock", "fully_reserved", "low_stock"].indexOf(b.status)).slice(0, 8)
    .map((x) => partView(state, x.p));
  const newRequests = state.jobs.filter((j) => j.status === "requested" || j.status === "pending_inspection").filter((j) => !state.bookings.some((b) => b.jobId === j.id && active(b)))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 6).map((j) => jobView(state, j));
  return {
    today, shop: SHOP_NAME, hours: HOURS_TEXT,
    cards: {
      callsToday: callsToday.length,
      answeredByAi: callsToday.filter((c) => c.status !== "missed").length,
      missedOrUnresolved: callsToday.filter((c) => c.status === "missed" || !c.resolved).length,
      missedOrUnresolvedTotal: state.calls.filter((c) => c.status === "missed" ? !c.resolved : !c.resolved).length,
      newServiceRequests: state.jobs.filter((j) => j.createdAt.slice(0, 10) >= weekFrom && (j.status === "requested" || j.status === "pending_inspection")).length,
      appointmentsToday: todays.length,
      appointmentsTodayLeft: todays.filter((b) => active(b)).length,
      upcomingAppointments: upcoming.length,
      repairsAwaitingParts: waiting.length,
      partsToPurchase: partsToBuy,
      partsRequestsOpen: openReq.length,
      revenueMonth: money(done.reduce((s, j) => s + (j.finalCost ?? j.estimate), 0)),
      revenueMonthJobs: done.length,
      pendingJobValue: money(pendingValue),
      pendingJobs: openJobs.length,
      lowOrOutParts: state.parts.filter((p) => stockStatus(state, p) !== "in_stock").length,
      openTasks: state.tasks.filter((t) => !t.done).length,
    },
    recent,
    upcoming: upcoming.sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start)).slice(0, 8).map((b) => bookingView(state, b.id)),
    stockAlerts, newRequests,
    tasks: state.tasks.filter((t) => !t.done).sort((a, b) => a.due.localeCompare(b.due)).slice(0, 8),
    requestsAwaiting: state.requests.filter((r) => r.status === "awaiting_approval").map((r) => requestView(state, r.id)).slice(0, 5),
  };
}

// ------------------------------------------------------------------------- routes

class Http extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 200_000) throw new Http(413, "Request body too large.");
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw new Http(400, "Invalid JSON."); }
}

function send(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body), "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
  });
  res.end(body);
}

const q = (url: URL, key: string): string => (url.searchParams.get(key) ?? "").trim();

export interface DemoApi {
  handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean>;
}

export function createDemoApi(store: DemoStore, auth: DemoAuth): DemoApi {
  return {
    async handle(req, res, url) {
      if (!url.pathname.startsWith("/api/demo/")) return false;
      try {
        await dispatch(req, res, url);
      } catch (error) {
        if (res.headersSent) { res.end(); return true; }
        if (error instanceof Http) send(res, error.status, { error: error.message });
        else if (error instanceof ValidationError) send(res, error.status, { error: error.message });
        else { console.error(error); send(res, 500, { error: "Something went wrong on the server. Please try again." }); }
      }
      return true;
    },
  };

  async function dispatch(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const method = req.method ?? "GET";
    const p = url.pathname.slice("/api/demo".length);
    const nowMs = store.now().getTime();

    if (method === "POST" && p === "/login") {
      const b = (await readBody(req)) as Record<string, unknown>;
      const ip = req.socket.remoteAddress ?? "unknown";
      const token = auth.login(b.email, b.password, ip, nowMs);
      send(res, 200, { token, expiresInMinutes: TOKEN_TTL_MS / 60_000, user: { email: DEMO_EMAIL, name: "Demo owner", demo: true } });
      return;
    }
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!token || !auth.verify(token, nowMs)) throw new Http(401, "Please sign in to the demo.");

    const s = store.state;
    const now = store.now();
    const m = (re: RegExp): RegExpExecArray | null => re.exec(p);
    const body = async (): Promise<Record<string, unknown>> => {
      const b = await readBody(req);
      if (typeof b !== "object" || b === null || Array.isArray(b)) throw new ValidationError("Request body must be a JSON object.");
      return b as Record<string, unknown>;
    };
    const ok = (payload: unknown, status = 200): void => send(res, status, payload);

    if (method === "GET" && p === "/me") return ok({ email: DEMO_EMAIL, demo: true, shop: SHOP_NAME, today: localDate(now) });
    if (method === "POST" && p === "/reset") { await store.reset(); return ok({ ok: true }); }
    if (method === "GET" && p === "/meta") {
      return ok({
        shop: SHOP_NAME, hours: HOURS_TEXT, laborRate: LABOR_RATE, today: localDate(now), mechanics: s.mechanics,
        repairTypes: REPAIR_TYPES.filter((r) => r.weight > 0 || r.id === "follow_up_check").map((r) => ({ id: r.id, name: r.name, kind: r.kind, durationMin: r.durationMin, hours: r.hours })),
        partKinds: [...new Set(s.parts.map((x) => x.kind))].sort(),
      });
    }
    if (method === "GET" && p === "/dashboard") return ok(dashboard(s, now));

    // ---- calls
    if (method === "GET" && p === "/calls") {
      const status = q(url, "status"); const text = q(url, "q").toLowerCase(); const customer = q(url, "customer");
      const from = q(url, "from"); const to = q(url, "to"); const booking = q(url, "booking");
      const list = s.calls.filter((c) => {
        if (status && c.status !== status) return false;
        if (customer && c.customerId !== customer) return false;
        if (from && c.date < from) return false;
        if (to && c.date > to) return false;
        if (booking) {
          const bk = c.bookingId ? s.bookings.find((x) => x.id === c.bookingId) : undefined;
          if (booking === "none" ? !!bk : bk?.status !== booking) return false;
        }
        if (text && ![c.name, c.phone, c.vehicle, c.reason, c.summary, c.requested, c.id].some((f) => f.toLowerCase().includes(text))) return false;
        return true;
      }).sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time));
      const limit = Math.min(500, Math.max(1, Number(q(url, "limit")) || 100));
      const offset = Math.max(0, Number(q(url, "offset")) || 0);
      return ok({ total: list.length, items: list.slice(offset, offset + limit).map(({ transcript, ...rest }) => { void transcript; return { ...rest, bookingStatus: rest.bookingId ? s.bookings.find((x) => x.id === rest.bookingId)?.status ?? null : null }; }) });
    }
    let r = m(/^\/calls\/([\w-]+)$/);
    if (method === "GET" && r) {
      const call = s.calls.find((c) => c.id === r![1]);
      if (!call) throw new Http(404, "Call not found.");
      const booking = call.bookingId ? s.bookings.find((b) => b.id === call.bookingId) : undefined;
      const job = call.jobId ? s.jobs.find((j) => j.id === call.jobId) : undefined;
      const related = s.bookings.filter((b) => b.callId === call.id).map((b) => bookingView(s, b.id));
      return ok({
        call, booking: booking ? bookingView(s, booking.id) : null, bookings: related, job: job ? jobView(s, job) : null,
        request: job ? (() => { const rq = openRequestOf(s, job.id); return rq ? requestView(s, rq.id) : null; })() : null,
        tasks: s.tasks.filter((t) => t.callId === call.id),
        notice: call.simulated ? "Simulated demo call — no real phone call took place." : "Fictional demo call generated for the sample workshop.",
      });
    }

    // ---- customers & vehicles
    if (method === "GET" && p === "/customers") {
      const text = q(url, "q").toLowerCase();
      const items = s.customers.filter((c) => {
        if (!text) return true;
        const vs = s.vehicles.filter((v) => v.customerId === c.id);
        return [c.name, c.phone, c.email, ...vs.flatMap((v) => [v.reg, v.make, v.model])].some((f) => f.toLowerCase().includes(text));
      }).sort((a, b) => a.name.localeCompare(b.name)).map((c) => ({
        ...c, vehicles: s.vehicles.filter((v) => v.customerId === c.id).map((v) => ({ id: v.id, label: vehicleName(v), reg: v.reg })),
        openJobs: s.jobs.filter((j) => j.customerId === c.id && (OPEN_JOB_STATUSES as readonly string[]).includes(j.status)).length,
        nextAppointment: s.bookings.filter((b) => b.customerId === c.id && (b.status === "confirmed" || b.status === "pending") && b.date >= localDate(now)).sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start))[0]?.date ?? null,
      }));
      return ok({ total: items.length, items });
    }
    if (method === "POST" && p === "/customers") { const b = await body(); return ok(await store.mutate((st, n) => createCustomer(st, b, n)), 201); }
    r = m(/^\/customers\/([\w-]+)$/);
    if (r) {
      if (method === "GET") return ok(customerDetail(s, r[1]!));
      if (method === "PATCH") { const b = await body(); return ok(await store.mutate((st) => updateCustomer(st, r![1]!, b))); }
    }
    if (method === "POST" && p === "/vehicles") { const b = await body(); return ok(await store.mutate((st) => createVehicle(st, b)), 201); }
    r = m(/^\/vehicles\/([\w-]+)$/);
    if (r && method === "GET") {
      const v = vehicleOf(s, r[1]!);
      return ok({
        vehicle: v, customer: customerOf(s, v.customerId), bookings: s.bookings.filter((b) => b.vehicleId === v.id).sort((a, b) => (b.date + b.start).localeCompare(a.date + a.start)).map((b) => bookingView(s, b.id)),
        jobs: s.jobs.filter((j) => j.vehicleId === v.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((j) => jobView(s, j)),
        calls: s.calls.filter((c) => c.vehicle === vehicleName(v)).map(({ transcript, ...rest }) => { void transcript; return rest; }),
      });
    }
    if (r && method === "PATCH") { const b = await body(); return ok(await store.mutate((st) => updateVehicle(st, r![1]!, b))); }
    if (method === "POST" && p === "/service-requests") { const b = await body(); const job = await store.mutate((st, n) => createServiceRequest(st, b, n)); return ok(jobView(store.state, job), 201); }

    // ---- jobs
    if (method === "GET" && p === "/jobs") {
      const status = q(url, "status");
      const items = s.jobs.filter((j) => (status ? j.status === status : (OPEN_JOB_STATUSES as readonly string[]).includes(j.status))).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 200).map((j) => jobView(s, j));
      return ok({ total: items.length, items });
    }
    r = m(/^\/jobs\/([\w-]+)$/);
    if (r && method === "PATCH") { const b = await body(); const j = await store.mutate((st, n) => updateJob(st, r![1]!, b, n)); return ok(jobView(store.state, j)); }

    // ---- calendar & bookings
    if (method === "GET" && p === "/calendar") {
      const from = q(url, "from") || weekStart(localDate(now));
      const to = q(url, "to") || addDays(from, 6);
      parseDate(from); parseDate(to);
      if (to < from || (parseDate(to).getTime() - parseDate(from).getTime()) / 86_400_000 > 62) throw new ValidationError("Invalid date range (max 62 days).");
      const items = s.bookings.filter((b) => b.date >= from && b.date <= to).sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start)).map((b) => bookingView(s, b.id));
      return ok({ from, to, items });
    }
    if (method === "GET" && p === "/availability") {
      const date = q(url, "date") || localDate(now);
      parseDate(date);
      const rt = repairType(q(url, "repairType") || "oil_service");
      const dur = Number(q(url, "duration")) || rt.durationMin;
      const ignore = q(url, "ignore");
      const hours = dayHours(date);
      if (!hours) return ok({ date, open: false, slots: [] });
      const slots: { start: string; mechanicIds: string[] }[] = [];
      for (let t = hours.open; t + dur <= hours.close; t += 15) {
        const ids = s.mechanics.filter((mm) => !slotCheck(mm.id, date, fromMin(t), dur, ignore)).map((mm) => mm.id);
        if (ids.length) slots.push({ start: fromMin(t), mechanicIds: ids });
      }
      return ok({ date, open: true, hours: [fromMin(hours.open), fromMin(hours.close)], breaks: hours.breaks.map(([a, b2]) => [fromMin(a), fromMin(b2)]), slots });
    }
    if (method === "POST" && p === "/bookings") { const b = await body(); const bk = await store.mutate((st, n) => bookingFromForm(st, b, n)); return ok(bookingView(store.state, bk.id), 201); }
    r = m(/^\/bookings\/([\w-]+)$/);
    if (r) {
      if (method === "GET") return ok(bookingView(s, r[1]!));
      if (method === "PATCH") { const b = await body(); const bk = await store.mutate((st, n) => updateBooking(st, r![1]!, b, n)); return ok(bookingView(store.state, bk.id)); }
    }
    r = m(/^\/bookings\/([\w-]+)\/(cancel|complete)$/);
    if (r && method === "POST") {
      const bk = await store.mutate((st, n) => (r![2] === "cancel" ? cancelBooking(st, r![1]!, n) : completeBooking(st, r![1]!, n)));
      return ok(bookingView(store.state, bk.id));
    }

    // ---- inventory
    if (method === "GET" && p === "/inventory") {
      const text = q(url, "q").toLowerCase(); const status = q(url, "status"); const kind = q(url, "kind");
      let items = s.parts.map((x) => partView(s, x));
      if (text) items = items.filter((x) => [x.name, x.sku, x.supplier, x.kind, ...x.compat.map((c) => `${c.make} ${c.model}`)].some((f) => f.toLowerCase().includes(text)));
      if (status) items = items.filter((x) => x.status === status);
      if (kind) items = items.filter((x) => x.kind === kind);
      items.sort((a, b) => a.name.localeCompare(b.name));
      const all = s.parts.map((x) => stockStatus(s, x));
      return ok({
        total: items.length, items,
        summary: { in_stock: all.filter((x) => x === "in_stock").length, low_stock: all.filter((x) => x === "low_stock").length, out_of_stock: all.filter((x) => x === "out_of_stock").length, fully_reserved: all.filter((x) => x === "fully_reserved").length, value: money(s.parts.reduce((t, x) => t + x.quantity * x.unitCost, 0)) },
      });
    }
    if (method === "POST" && p === "/inventory") { const b = await body(); const part = await store.mutate((st, n) => createPart(st, b, n)); return ok(partView(store.state, part), 201); }
    r = m(/^\/inventory\/([\w-]+)$/);
    if (r && method === "PATCH") { const b = await body(); const part = await store.mutate((st, n) => updatePart(st, r![1]!, b, n)); return ok(partView(store.state, part)); }
    r = m(/^\/inventory\/([\w-]+)\/adjust$/);
    if (r && method === "POST") { const b = await body(); const out = await store.mutate((st, n) => adjustStock(st, r![1]!, b, n)); return ok({ part: partView(store.state, out.part), movement: out.movement }); }
    r = m(/^\/inventory\/([\w-]+)\/movements$/);
    if (r && method === "GET") {
      const part = partOf(s, r[1]!);
      const reservedBy = s.jobs.filter((j) => (OPEN_JOB_STATUSES as readonly string[]).includes(j.status)).flatMap((j) => j.parts.filter((x) => x.partId === part.id && (x.reservedQty ?? 0) > 0).map((x) => ({ jobId: j.id, title: j.title, qty: x.reservedQty ?? 0 })));
      return ok({ part: partView(s, part), movements: s.movements.filter((x) => x.partId === part.id).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 100), reservedBy });
    }

    // ---- parts requests & tasks
    if (method === "GET" && p === "/requests") {
      const status = q(url, "status");
      const items = s.requests.filter((x) => (status === "all" ? true : status ? x.status === status : OPEN_REQUEST.includes(x.status))).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((x) => requestView(s, x.id));
      return ok({ total: items.length, items });
    }
    r = m(/^\/requests\/([\w-]+)\/action$/);
    if (r && method === "POST") { const b = await body(); const rq = await store.mutate((st, n) => requestAction(st, r![1]!, b, n)); return ok(requestView(store.state, rq.id)); }
    r = m(/^\/requests\/([\w-]+)$/);
    if (r && method === "GET") { requestView(s, r[1]!); return ok(requestView(s, r[1]!)); }
    if (method === "GET" && p === "/tasks") return ok({ items: s.tasks.slice().sort((a, b) => Number(a.done) - Number(b.done) || a.due.localeCompare(b.due)).slice(0, 100) });
    r = m(/^\/tasks\/([\w-]+)$/);
    if (r && method === "PATCH") { const b = await body(); return ok(await store.mutate((st) => updateTask(st, r![1]!, b))); }

    // ---- simulated AI receptionist
    if (method === "GET" && p === "/scenarios") return ok({ items: scenarioList(s, now) });
    if (method === "POST" && p === "/agent/sessions") { const b = await body(); const sess = await store.mutate((st, n) => startSession(st, { scenario: typeof b.scenario === "string" ? b.scenario : undefined, callerId: typeof b.callerId === "string" ? b.callerId : undefined }, n)); return ok(sess, 201); }
    r = m(/^\/agent\/sessions\/([\w-]+)$/);
    if (r && method === "GET") { const sess = s.sessions.find((x) => x.id === r![1]); if (!sess) throw new Http(404, "Session not found."); return ok(sess); }
    r = m(/^\/agent\/sessions\/([\w-]+)\/(messages|choose|end)$/);
    if (r && method === "POST") {
      const b = await body();
      const sess = await store.mutate((st, n) => (r![2] === "messages" ? handleMessage(st, r![1]!, b.text, n) : r![2] === "choose" ? chooseOption(st, r![1]!, b, n) : endSession(st, r![1]!, n)));
      return ok(sess);
    }
    throw new Http(404, "Unknown demo endpoint.");
  }

  function slotCheck(mechanicId: string, date: string, start: string, dur: number, ignore: string): string | null {
    return slotProblemPublic(store.state, mechanicId, date, start, dur, ignore, store.now());
  }
}

import { slotProblem } from "./rules.js";
function slotProblemPublic(state: DemoState, mechanicId: string, date: string, start: string, dur: number, ignore: string, now: Date): string | null {
  return slotProblem(state, { mechanicId, date, start, durationMin: dur, ignoreId: ignore || undefined }, now);
}
void MECHANICS; void findSlots; void jobRequestSummary;
