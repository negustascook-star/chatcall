/** Deterministic generator of the fictional "Summit Auto Care" demo workshop. All people, plates and numbers are invented. */
import { VEHICLES, startingParts } from "./catalog.js";
import {
  createBooking, createCustomer, createJob, createServiceRequest, createTask, ensureRequestForJob, requestAction, syncJob,
} from "./ops.js";
import {
  LABOR_RATE, REPAIR_TYPES, SHOP_NAME, addDays, checkParts, dayHours, diffDays, fromMin, localDate, nowMinutes, pad, partsForKind,
  repairType, slotProblem, toMin, weekday,
} from "./rules.js";
import { addMovement, nextId, releaseJobParts } from "./sourcing.js";
import { ISSUES, assessment, money, partNeedsText, seedTranscript } from "./texts.js";
import type { Booking, Call, CallStatus, Customer, DemoState, Job, Mechanic, Vehicle } from "./types.js";
import { randomBytes } from "node:crypto";

export const SEED_VERSION = 4;

function rng(seed: number) {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: <T>(arr: readonly T[]): T => arr[Math.floor(next() * arr.length)]!,
    chance: (p: number) => next() < p,
  };
}

const FIRST = ["Olivia", "Liam", "Emma", "Noah", "Ava", "Ethan", "Sophia", "Mason", "Isabella", "Lucas", "Mia", "Henry", "Amelia", "Jack", "Harper", "Daniel", "Evelyn", "Samuel", "Grace", "Owen", "Chloe", "Wyatt", "Zoe", "Caleb", "Nora", "Isaac", "Hannah", "Julian", "Priya", "Ravi", "Mei", "Kenji", "Fatima", "Omar", "Elena", "Mateo", "Sofia", "Andre", "Tessa", "Nolan", "Ruth", "Victor", "Alma", "Felix", "Greta", "Hugo", "Iris", "Marcus", "Nina", "Paul"];
const LAST = ["Carter", "Meyer", "Brooks", "Foster", "Grant", "Nair", "Ortiz", "Webb", "Hayes", "Bennett", "Collins", "Dixon", "Ellis", "Fisher", "Gibson", "Harper", "Ibrahim", "Jensen", "Kowalski", "Lambert", "Morales", "Nguyen", "Owens", "Patel", "Quinn", "Reyes", "Sato", "Turner", "Underwood", "Vance", "Walsh", "Yamada", "Zimmer", "Alvarez", "Bauer", "Castillo", "Duarte", "Eriksen", "Fontaine", "Gallagher", "Holloway", "Ivanov", "Jacobs", "Keller", "Lindgren", "Monroe", "Novak", "Okafor", "Petrov", "Rossi"];
const PLATE_L = "ABCDEFGHJKLMNPRSTUVWXYZ";

export const MECHANICS: Mechanic[] = [
  { id: "M-1", name: "Marcus Reed", role: "Senior mechanic — brakes & suspension", skills: ["brakes", "suspension", "service"], workDays: [1, 2, 3, 4, 5] },
  { id: "M-2", name: "Elena Novak", role: "Diagnostics & electrical", skills: ["electrical", "service"], workDays: [1, 2, 3, 4, 5] },
  { id: "M-3", name: "Tom Becker", role: "Engine & drivetrain", skills: ["engine", "service", "brakes"], workDays: [1, 2, 3, 4, 5, 6] },
  { id: "M-4", name: "Sara Lindqvist", role: "Service technician", skills: ["service", "suspension", "electrical"], workDays: [2, 3, 4, 5, 6] },
];

const SHOP_PHONE = "+1 555-0100";
export const DEMO_PHONES = { shop: SHOP_PHONE };

export function emptyState(now: Date): DemoState {
  return {
    version: SEED_VERSION, seededAt: localDate(now), generatedThrough: localDate(now), secret: randomBytes(32).toString("hex"),
    counters: {}, scenarioRefs: {}, mechanics: MECHANICS.map((m) => ({ ...m })), customers: [], vehicles: [], parts: [], jobs: [],
    bookings: [], calls: [], requests: [], movements: [], tasks: [], sessions: [],
  };
}

function plate(r: ReturnType<typeof rng>, used: Set<string>): string {
  for (;;) {
    const p = `DEMO-${r.pick([...PLATE_L])}${r.pick([...PLATE_L])}${r.int(100, 999)}`;
    if (!used.has(p)) { used.add(p); return p; }
  }
}

export function buildSeed(now: Date = new Date(), secret?: string): DemoState {
  const r = rng(20261029);
  const state = emptyState(now);
  if (secret) state.secret = secret;
  const today = localDate(now);
  const nowMin = nowMinutes(now);
  state.parts = startingParts();
  state.counters.part = state.parts.length;

  // ---- customers & vehicles ------------------------------------------------------------
  const usedNames = new Set<string>();
  const usedPlates = new Set<string>();
  const story = [
    { key: "A", name: "Emily Carter", make: "Ford", model: "Focus", year: 2017 },
    { key: "B", name: "Lucas Meyer", make: "BMW", model: "320d", year: 2018 },
    { key: "C", name: "Hannah Brooks", make: "Volkswagen", model: "Golf", year: 2019 },
    { key: "D", name: "Ben Ortiz", make: "Ford", model: "Focus", year: 2015 },
    { key: "E", name: "Olivia Grant", make: "Volkswagen", model: "Golf", year: 2016 },
    { key: "F", name: "Marco Silva", make: "Ford", model: "Fiesta", year: 2016 },
  ];
  const make = (name: string, vehicleSpec?: { make: string; model: string; year: number }): { c: Customer; v: Vehicle } => {
    usedNames.add(name);
    const idx = state.customers.length;
    const phone = `+1 555-01${pad(idx + 1)}`;
    const first = name.split(" ")[0]!.toLowerCase();
    const last = name.split(" ")[1]!.toLowerCase();
    const c = createCustomer(state, { name, phone, email: `${first}.${last}@example.test`, notes: "" }, new Date(now.getTime() - r.int(30, 400) * 86_400_000));
    const cat = vehicleSpec ? VEHICLES.find((x) => x.make === vehicleSpec.make && x.model === vehicleSpec.model)! : r.pick(VEHICLES);
    const [engine, fuel] = r.pick(cat.engines);
    const year = vehicleSpec?.year ?? r.int(cat.from, cat.to);
    const v: Vehicle = {
      id: nextId(state, "vehicle"), customerId: c.id, make: cat.make, model: cat.model, year, reg: plate(r, usedPlates), engine, fuel,
      mileage: r.int(18, 190) * 1000,
    };
    state.vehicles.push(v);
    return { c, v };
  };
  const storyRefs: Record<string, { c: Customer; v: Vehicle }> = {};
  for (const s of story) storyRefs[s.key] = make(s.name, s);
  while (state.customers.length < 46) {
    const name = `${r.pick(FIRST)} ${r.pick(LAST)}`;
    if (usedNames.has(name)) continue;
    make(name);
  }
  // some customers own a second vehicle
  for (const c of state.customers.slice(5).filter(() => r.chance(0.17))) {
    const cat = r.pick(VEHICLES);
    const [engine, fuel] = r.pick(cat.engines);
    state.vehicles.push({
      id: nextId(state, "vehicle"), customerId: c.id, make: cat.make, model: cat.model, year: r.int(cat.from, cat.to), reg: plate(r, usedPlates),
      engine, fuel, mileage: r.int(30, 220) * 1000,
    });
  }
  const regular = state.customers.slice(5);

  // ---- which repair types fit which vehicle ---------------------------------------------
  const fitsCatalogue = (v: Vehicle, rtId: string): boolean =>
    repairType(rtId).parts.every((p) => partsForKind(state, p.kind, v).length > 0);
  const eligible = (v: Vehicle, strict: boolean): string[] =>
    REPAIR_TYPES.filter((t) => t.weight > 0 && fitsCatalogue(v, t.id)
      && (!strict || checkParts(state, v, t.parts).every((c) => c.shortfall === 0 && c.compat === "confirmed"))).map((t) => t.id);
  const weighted = (ids: string[]): string => {
    const total = ids.reduce((s, id) => s + repairType(id).weight, 0);
    let x = r.next() * total;
    for (const id of ids) { x -= repairType(id).weight; if (x <= 0) return id; }
    return ids[0]!;
  };

  const placeBooking = (
    date: string, customer: Customer, vehicle: Vehicle, rtId: string, opts: { strict: boolean; status?: Booking["status"]; start?: string; mechanicId?: string },
  ): Booking | undefined => {
    const hours = dayHours(date);
    if (!hours) return undefined;
    const rt = repairType(rtId);
    for (let attempt = 0; attempt < 40; attempt++) {
      const steps = Math.floor((hours.close - hours.open - rt.durationMin) / 30);
      const start = opts.start ?? fromMin(hours.open + r.int(0, Math.max(0, steps)) * 30);
      const mech = opts.mechanicId ?? r.pick(state.mechanics.filter((m) => m.skills.includes(rt.skill) || r.chance(0.2)) .map((m) => m.id));
      const mid = mech ?? state.mechanics[0]!.id;
      const past = date < today || (date === today && toMin(start) + rt.durationMin <= nowMin);
      if (slotProblem(state, { mechanicId: mid, date, start, durationMin: rt.durationMin }, now, { allowPast: true })) { if (opts.start && opts.mechanicId) return undefined; continue; }
      if (!past && !opts.strict) { /* allowed to create shortages */ }
      try {
        const issue = r.pick(ISSUES[rtId] ?? ["Routine visit."]);
        const b = createBooking(state, {
          customerId: customer.id, vehicleId: vehicle.id, repairType: rtId, date, start, mechanicId: mid, reportedIssue: issue,
          source: "ai_call", status: opts.status ?? "confirmed", allowPast: true,
        }, new Date(now.getTime() - r.int(1, 9) * 86_400_000));
        return b;
      } catch { continue; }
    }
    return undefined;
  };

  const finishAsHistory = (b: Booking): void => {
    const job = state.jobs.find((j) => j.id === b.jobId)!;
    releaseJobParts(job);
    job.status = "completed";
    job.completedAt = `${b.date}T${b.start}:00.000Z`;
    job.finalCost = job.estimate;
    for (const jp of job.parts) {
      const best = partsForKind(state, jp.kind, state.vehicles.find((v) => v.id === job.vehicleId)!)[0];
      if (best) addMovement(state, { partId: best.part.id, at: `${b.date}T${b.start}:00.000Z`, delta: -jp.qty, reason: "Used on completed job", ref: job.id });
    }
    state.requests = state.requests.filter((q) => q.jobId !== job.id);
  };

  // ---- history: six weeks ---------------------------------------------------------------
  const histStart = addDays(today, -42);
  for (let d = histStart; d < today; d = addDays(d, 1)) {
    if (!dayHours(d)) continue;
    const n = weekday(d) === 6 ? r.int(2, 3) : r.int(3, 4);
    for (let i = 0; i < n; i++) {
      const customer = r.pick(regular);
      const vehicles = state.vehicles.filter((v) => v.customerId === customer.id);
      const vehicle = r.pick(vehicles);
      const ids = eligible(vehicle, false);
      if (!ids.length) continue;
      const b = placeBooking(d, customer, vehicle, weighted(ids), { strict: false });
      if (!b) continue;
      const roll = r.next();
      if (roll < 0.07) {
        b.status = "cancelled";
        const job = state.jobs.find((j) => j.id === b.jobId)!;
        job.status = "cancelled"; releaseJobParts(job);
        state.requests = state.requests.filter((q) => q.jobId !== job.id);
      } else if (roll < 0.1) {
        b.status = "no_show";
        const job = state.jobs.find((j) => j.id === b.jobId)!;
        job.status = "cancelled"; releaseJobParts(job);
        state.requests = state.requests.filter((q) => q.jobId !== job.id);
      } else {
        b.status = "completed";
        finishAsHistory(b);
      }
    }
  }

  // ---- today (some already done) and the next two weeks ------------------------------------
  const futureDays: string[] = [];
  for (let i = 0; i < 14; i++) futureDays.push(addDays(today, i));
  for (const d of futureDays) {
    if (!dayHours(d)) continue;
    const n = d === today ? 7 : weekday(d) === 6 ? 3 : r.int(5, 7);
    for (let i = 0; i < n; i++) {
      const customer = r.pick(regular);
      const vehicle = r.pick(state.vehicles.filter((v) => v.customerId === customer.id));
      const ids = eligible(vehicle, true);
      if (!ids.length) continue;
      const pending = d !== today && r.chance(0.14);
      const b = placeBooking(d, customer, vehicle, weighted(ids), { strict: true, status: pending ? "pending" : "confirmed" });
      if (!b) continue;
      if (d === today && toMin(b.start) + b.durationMin <= nowMin) {
        b.status = "completed";
        finishAsHistory(b);
      } else if (d === today && toMin(b.start) <= nowMin) {
        state.jobs.find((j) => j.id === b.jobId)!.status = "in_progress";
      }
    }
  }

  // ---- all mechanics busy at one slot: the schedule-conflict demonstration -------------------
  let conflictDate = addDays(today, 1);
  while (!dayHours(conflictDate) || weekday(conflictDate) === 6) conflictDate = addDays(conflictDate, 1);
  const conflictStart = "10:00";
  for (const m of state.mechanics.filter((x) => x.workDays.includes(weekday(conflictDate)))) {
    if (!slotProblem(state, { mechanicId: m.id, date: conflictDate, start: conflictStart, durationMin: 60 }, now)) {
      const customer = r.pick(regular);
      const vehicle = r.pick(state.vehicles.filter((v) => v.customerId === customer.id));
      const ids = eligible(vehicle, true).filter((id) => repairType(id).durationMin <= 60);
      if (ids.length) placeBooking(conflictDate, customer, vehicle, ids[0]!, { strict: true, start: conflictStart, mechanicId: m.id });
    }
    // anything else overlapping 10:00 already blocks the mechanic
  }

  // ---- story jobs awaiting parts (all created by the normal rules; nothing auto-ordered) -------
  const upcoming = (offset: number): string => {
    let d = addDays(today, offset);
    while (!dayHours(d)) d = addDays(d, 1);
    return d;
  };
  const later = (from: string, startHour: string, rtId: string): { date: string; start: string; mechanicId: string } | undefined => {
    const rt = repairType(rtId);
    for (let i = 0; i < 20; i++) {
      const date = addDays(from, i);
      if (!dayHours(date)) continue;
      for (const m of state.mechanics) {
        for (const start of [startHour, "13:00", "14:00", "09:00", "08:00", "10:00", "15:00"]) {
          if (!slotProblem(state, { mechanicId: m.id, date, start, durationMin: rt.durationMin }, now)) return { date, start, mechanicId: m.id };
        }
      }
    }
    return undefined;
  };
  const makeStory = (
    customer: Customer, vehicle: Vehicle, rtId: string, daysAhead: number, advance: (string)[] = [], note = "",
  ): { job: Job; booking?: Booking } => {
    const slot = later(upcoming(daysAhead), "11:00", rtId);
    if (!slot) throw new Error("seed: no slot for story job");
    const issue = r.pick(ISSUES[rtId] ?? ["Customer request."]);
    const b = createBooking(state, {
      customerId: customer.id, vehicleId: vehicle.id, repairType: rtId, reportedIssue: issue, notes: note, source: "ai_call",
      date: slot.date, start: slot.start, mechanicId: slot.mechanicId,
    }, new Date(now.getTime() - 86_400_000 * 2));
    const job = state.jobs.find((j) => j.id === b.jobId)!;
    const req = state.requests.find((q) => q.jobId === job.id);
    if (req) for (const action of advance) requestAction(state, req.id, action === "approve" ? { action, confirmFitment: true } : { action }, new Date(now.getTime() - 3_600_000));
    return { job, booking: b };
  };
  // Golf (Olivia Grant, scenario E): pads in stock, discs out of stock -> request awaiting approval
  makeStory(storyRefs.E!.c, storyRefs.E!.v, "brake_service_front", 6, [], "Customer waiting for parts update.");
  // Fiesta timing belt: takes the single kit and pump in stock
  const fiesta = storyRefs.F!.v;
  makeStory(state.customers.find((c) => c.id === fiesta.customerId)!, fiesta, "timing_belt", 4);
  // Corolla pads (0 in stock) -> approved/ordered by the owner
  const corolla = state.vehicles.find((v) => v.model === "Corolla")!;
  makeStory(state.customers.find((c) => c.id === corolla.customerId)!, corolla, "brake_service_front", 8, ["approve", "ordered"]);
  // Clio battery -> ordered and already received => ready for repair; Qashqai then short by one
  const clio = state.vehicles.find((v) => v.model === "Clio")!;
  makeStory(state.customers.find((c) => c.id === clio.customerId)!, clio, "battery", 3, ["approve", "ordered", "receive"]);
  const qashqai = state.vehicles.find((v) => v.model === "Qashqai")!;
  makeStory(state.customers.find((c) => c.id === qashqai.customerId)!, qashqai, "battery", 7, ["approve"]);
  // Mercedes oil service: filter out of stock -> awaiting price confirmation style request
  const merc = state.vehicles.find((v) => v.make === "Mercedes-Benz") ?? state.vehicles.find((v) => v.make === "Volvo")!;
  const mercStory = makeStory(state.customers.find((c) => c.id === merc.customerId)!, merc, "oil_service", 5);
  const mercReq = state.requests.find((q) => q.jobId === mercStory.job.id);
  if (mercReq) { mercReq.status = "awaiting_price_confirmation"; mercReq.history.push({ at: now.toISOString(), text: "Waiting for the supplier to confirm the price." }); }
  // Focus clutch: out of stock
  const focusV = state.vehicles.find((v) => v.model === "Focus" && v.id !== storyRefs.A!.v.id && v.id !== storyRefs.D!.v.id);
  if (focusV) {
    const st = makeStory(state.customers.find((c) => c.id === focusV.customerId)!, focusV, "clutch", 9);
    const rq = state.requests.find((q) => q.jobId === st.job.id);
    if (rq) { rq.status = "parts_required"; rq.history.push({ at: now.toISOString(), text: "Flagged for inventory verification by staff." }); }
  }
  // A couple of fresh, unscheduled service requests
  for (const [customer, vehicle, rt] of [
    [regular[3]!, state.vehicles.find((v) => v.customerId === regular[3]!.id)!, "brake_inspection"],
    [regular[9]!, state.vehicles.find((v) => v.customerId === regular[9]!.id)!, "diagnostic"],
    [regular[14]!, state.vehicles.find((v) => v.customerId === regular[14]!.id)!, "oil_service"],
  ] as const) {
    const job = createJob(state, { customerId: customer.id, vehicleId: vehicle.id, repairType: rt, notes: "Customer asked for a call back with available times." }, new Date(now.getTime() - 3_600_000 * r.int(2, 30)));
    syncJob(state, job, now);
    ensureRequestForJob(state, job, now);
  }
  void createServiceRequest;

  // ---- calls ---------------------------------------------------------------------------------
  const reasons: Record<string, string[]> = {
    info: ["Asked about prices for a full service.", "Asked about opening hours on Saturday.", "Asked whether we service hybrids.", "Asked how long a brake job takes.", "Asked if a courtesy car is available.", "Asked for a rough price for a clutch replacement."],
  };
  const callTime = (date: string, hour?: number): string => {
    if (date === today) {
      const latest = Math.max(30, nowMin - 3);
      return fromMin(r.int(0, Math.floor(latest / 5)) * 5);
    }
    const h = hour ?? (r.chance(0.12) ? r.int(0, 6) : r.chance(0.08) ? r.int(19, 23) : r.int(8, 17));
    return `${pad(h)}:${pad(r.int(0, 59))}`;
  };
  const mechOf = (id: string): string => state.mechanics.find((m) => m.id === id)?.name ?? "a mechanic";
  const vehLabel = (v: Vehicle): string => `${v.year} ${v.make} ${v.model}`;
  const push = (c: Omit<Call, "id" | "simulated">): Call => {
    const call: Call = { ...c, id: nextId(state, "call"), simulated: false };
    state.calls.push(call);
    return call;
  };

  for (const b of [...state.bookings].sort((a, b2) => (a.date + a.start).localeCompare(b2.date + b2.start))) {
    const job = state.jobs.find((j) => j.id === b.jobId)!;
    const customer = state.customers.find((c) => c.id === b.customerId)!;
    const vehicle = state.vehicles.find((v) => v.id === b.vehicleId)!;
    const rt = REPAIR_TYPES.find((t) => t.name === b.repairType)!;
    const lead = Math.min(r.int(0, 5), Math.max(0, diffDays(b.date, addDays(today, -12))));
    let date = addDays(b.date, -lead);
    if (date > today) date = today;
    const time = callTime(date);
    const checks = job.status === "cancelled" || job.status === "completed" ? [] : checkParts(state, vehicle, rt.parts);
    const missingTxt = checks.filter((c) => c.shortfall > 0).map((c) => c.description).join(", ");
    const when = `${b.date} at ${b.start}`;
    const status: CallStatus = "completed";
    const dur = r.int(95, 360);
    const apptStatus = b.status === "cancelled" ? "Cancelled by customer" : b.status === "no_show" ? "No-show" : b.status === "completed" ? "Completed" : b.status === "pending" ? "Awaiting confirmation" : "Confirmed";
    const symptomsSaid = b.kind === "inspection";
    push({
      customerId: customer.id, name: customer.name, phone: customer.phone, date, time, durationSec: dur, status, vehicle: vehLabel(vehicle),
      reason: b.reportedIssue,
      summary: symptomsSaid
        ? `${customer.name.split(" ")[0]} reported: "${b.reportedIssue}" The cause is not confirmed; the AI booked an inspection with ${mechOf(b.mechanicId)} (${when}) rather than suggesting a repair.`
        : `${customer.name.split(" ")[0]} requested ${rt.name.toLowerCase()} for the ${vehLabel(vehicle)}. The AI checked stock${missingTxt ? ` (missing: ${missingTxt})` : " (all parts available)"} and booked ${when} with ${mechOf(b.mechanicId)}.`,
      requested: rt.name, estimate: job.estimate, appointmentStatus: apptStatus,
      followUp: b.status === "pending" ? "Confirm the booking with the customer." : missingTxt ? "Parts request awaiting owner approval." : "None",
      missingParts: missingTxt || "None",
      transcript: seedTranscript({ shop: SHOP_NAME, name: customer.name, vehicle: vehLabel(vehicle), issue: b.reportedIssue, repairId: rt.id, when: `${when}`, mechanic: mechOf(b.mechanicId), estimate: job.estimate, missing: missingTxt, kind: b.kind }),
      bookingId: b.id, jobId: job.id, resolved: true,
    });
    b.callId = state.calls[state.calls.length - 1]!.id;
    if (!job.callId) job.callId = b.callId;
  }

  // calls tied to the story jobs without bookings
  for (const job of state.jobs.filter((j) => !j.callId && j.status !== "completed" && j.status !== "cancelled")) {
    const customer = state.customers.find((c) => c.id === job.customerId)!;
    const vehicle = state.vehicles.find((v) => v.id === job.vehicleId)!;
    const rt = repairType(job.repairType);
    const date = addDays(today, -r.int(0, 2));
    const call = push({
      customerId: customer.id, name: customer.name, phone: customer.phone, date, time: callTime(date), durationSec: r.int(120, 300), status: "new_inquiry",
      vehicle: vehLabel(vehicle), reason: r.pick(ISSUES[job.repairType] ?? ["Service request."]),
      summary: `${customer.name} asked for ${rt.name.toLowerCase()}. No appointment was agreed yet — the customer will choose a time after a call back.`,
      requested: rt.name, estimate: job.estimate, appointmentStatus: "Not scheduled", followUp: "Call the customer with available times.",
      missingParts: partNeedsText(checkParts(state, vehicle, rt.parts).filter((c) => c.shortfall > 0)).replace("No parts required for this visit.", "None"),
      transcript: [], jobId: job.id, resolved: false,
    });
    call.transcript = seedTranscript({ shop: SHOP_NAME, name: customer.name, vehicle: vehLabel(vehicle), issue: call.reason, repairId: rt.id, when: "a time to be agreed", mechanic: "our team", estimate: job.estimate, missing: "", kind: rt.kind }).slice(0, 5);
    job.callId = call.id;
  }

  // missed calls, general inquiries and follow-ups over the last 6 weeks
  for (let i = 0; i < 22; i++) {
    const date = addDays(today, -r.int(i < 4 ? 0 : 1, 40));
    const known = r.chance(0.55);
    const c = known ? r.pick(regular) : undefined;
    const recent = diffDays(today, date) <= 3;
    const call = push({
      customerId: c?.id, name: c?.name ?? "Unknown caller", phone: c?.phone ?? `+1 555-01${r.int(50, 99)}`, date,
      time: callTime(date, r.chance(0.5) ? r.int(17, 22) : undefined), durationSec: 0, status: "missed", vehicle: c ? vehLabel(state.vehicles.find((v) => v.customerId === c.id)!) : "Unknown",
      reason: "Call not connected (line dropped before the AI could greet).", summary: "No conversation took place.", requested: "—", appointmentStatus: "None",
      followUp: recent ? "Call back the customer." : "Called back.", missingParts: "None", transcript: [{ role: "system", text: "Missed call — no audio recorded." }], resolved: !recent,
    });
    if (recent) createTask(state, { text: `Call back ${call.name} (${call.phone}) — missed call`, due: today, callId: call.id }, now);
  }
  for (let i = 0; i < 20; i++) {
    const date = addDays(today, -r.int(i < 3 ? 0 : 1, 40));
    const known = r.chance(0.35);
    const c = known ? r.pick(regular) : undefined;
    const reason = r.pick(reasons.info!);
    const open = diffDays(today, date) <= 2 && r.chance(0.5);
    const call = push({
      customerId: c?.id, name: c?.name ?? "New caller", phone: c?.phone ?? `+1 555-01${r.int(50, 99)}`, date, time: callTime(date), durationSec: r.int(45, 190),
      status: "new_inquiry", vehicle: c ? vehLabel(state.vehicles.find((v) => v.customerId === c.id)!) : "Not given", reason,
      summary: `${reason} The AI answered from the shop's published information (${HOURS_SHORT}) and offered to book a visit; the caller wanted to think about it.`,
      requested: "Information only", appointmentStatus: "Not scheduled", followUp: open ? "Follow up with a quote by email." : "None", missingParts: "None",
      transcript: [
        { role: "ai", text: `Thank you for calling ${SHOP_NAME}. How can I help?` }, { role: "customer", text: reason.replace("Asked", "I'd like to ask").replace(/\.$/, "?") },
        { role: "ai", text: "I can help with that. Our hours are Mon–Fri 08:00–17:00 and Sat 09:00–13:00. Final prices depend on the vehicle, so I can book an inspection or have the team send a quote." },
        { role: "customer", text: "I'll think about it, thanks." }, { role: "ai", text: "No problem. Thanks for calling!" },
      ],
      resolved: !open,
    });
    if (open) createTask(state, { text: `Send quote to ${call.name}: ${reason}`, due: addDays(today, 1), callId: call.id }, now);
  }
  const withHistory = state.jobs.filter((j) => j.status === "completed");
  for (let i = 0; i < 18; i++) {
    const job = withHistory[r.int(0, withHistory.length - 1)]!;
    const c = state.customers.find((x) => x.id === job.customerId)!;
    const date = addDays(today, -r.int(i < 3 ? 0 : 1, 30));
    push({
      customerId: c.id, name: c.name, phone: c.phone, date, time: callTime(date), durationSec: r.int(60, 210), status: "follow_up",
      vehicle: vehLabel(state.vehicles.find((v) => v.id === job.vehicleId)!), reason: `Asking about the earlier ${job.title.toLowerCase()} (job ${job.id}).`,
      summary: `Returning customer. The AI found job ${job.id} (${job.title}, completed) and confirmed the recorded status. ${r.chance(0.5) ? "The customer was happy; no action needed." : "Customer reported the issue is not fully resolved — a follow-up check was suggested."}`,
      requested: "Status / follow-up", appointmentStatus: "Completed job", followUp: "None", missingParts: "None", jobId: job.id,
      transcript: [
        { role: "ai", text: `Thank you for calling ${SHOP_NAME}. How can I help?` }, { role: "customer", text: `I'm calling about the ${job.title.toLowerCase()} you did.` },
        { role: "ai", text: `Welcome back, ${c.name.split(" ")[0]}. I can see job ${job.id}, ${job.title}, marked completed. Is something wrong?` },
        { role: "customer", text: "No, I just wanted to confirm everything was finished." }, { role: "ai", text: "Everything is recorded as completed. Anything else I can help with?" },
        { role: "customer", text: "That's all, thanks." },
      ],
      resolved: true,
    });
  }
  // today's story calls for the open parts requests keep the dashboard lively
  state.calls.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  state.calls.forEach((c) => { c.id = c.id; });

  // ---- tasks tied to open work ---------------------------------------------------------------
  for (const req of state.requests.filter((q) => q.status === "awaiting_approval" || q.status === "parts_required")) {
    createTask(state, { text: `Review parts request ${req.id} and decide whether to order`, due: today, jobId: req.jobId }, now);
  }
  for (const b of state.bookings.filter((x) => x.status === "pending")) {
    createTask(state, { text: `Confirm pending booking ${b.id} with the customer`, due: b.date, jobId: b.jobId }, now);
  }
  for (const t of state.tasks.slice(0, 3)) t.done = true;

  // ---- stock history: opening stock + deliveries reconcile with today's quantities -------------
  const consumed = new Map<string, number>();
  for (const m of state.movements) consumed.set(m.partId, (consumed.get(m.partId) ?? 0) + m.delta);
  const received = new Set(state.movements.filter((m) => m.reason.startsWith("Received")).map((m) => m.partId));
  const histMoves = [...state.movements];
  state.movements = [];
  for (const part of state.parts) {
    const used = -(consumed.get(part.id) ?? 0);
    const delivery = received.has(part.id) ? 0 : used > 0 ? Math.max(1, Math.ceil(used * 0.6)) : 0;
    const liveMoves = histMoves.filter((m) => m.partId === part.id);
    const sum = liveMoves.reduce((s, m) => s + m.delta, 0) + delivery;
    const opening = part.quantity - sum;
    const first = addDays(today, -45);
    if (opening !== 0) addMovement(state, { partId: part.id, at: `${first}T08:00:00.000Z`, delta: opening, reason: "Opening stock count" });
    if (delivery) addMovement(state, { partId: part.id, at: `${addDays(today, -r.int(10, 25))}T10:00:00.000Z`, delta: delivery, reason: "Supplier delivery (demo)" });
    for (const m of liveMoves) addMovement(state, { partId: m.partId, at: m.at, delta: m.delta, reason: m.reason, ref: m.ref });
  }
  state.movements.sort((a, b) => a.at.localeCompare(b.at));

  // ---- scenario references --------------------------------------------------------------------
  state.scenarioRefs = {
    A: storyRefs.A!.c.id, B: storyRefs.B!.c.id, C: storyRefs.C!.c.id, D: storyRefs.D!.c.id, E: storyRefs.E!.c.id,
    conflictDate, conflictStart,
  };
  void LABOR_RATE; void money;
  return state;
}

const HOURS_SHORT = "Mon–Fri 08:00–17:00, Sat 09:00–13:00";
export { assessment };
