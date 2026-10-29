/** State-changing operations. Every function validates, mutates the in-memory state synchronously and keeps related records consistent. */
import {
  OPEN_JOB_STATUSES, LABOR_RATE, ValidationError, availableQty, checkParts, cleanEmail, cleanInt, cleanNum, cleanPhone, cleanStr,
  estimateJob, findSlots, freeMechanics, isActive, jobOf, localDate, mechanicById, pickMechanic, repairType, reservedQty, slotProblem, toMin,
} from "./rules.js";
import { OPEN_REQUEST, addMovement, buildRequest, etaOf, nextId, requestTotal } from "./sourcing.js";
import { consumeJobParts, jobPartChecks, releaseJobParts, reserveJobParts } from "./sourcing.js";
import { assessment } from "./texts.js";
import type {
  Booking, BookingStatus, Customer, DemoState, Job, JobStatus, Part, PartsRequest, RequestStatus, Task, Vehicle,
} from "./types.js";

type Rec = Record<string, unknown>;
export const rec = (v: unknown): Rec => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new ValidationError("Request body must be a JSON object.");
  return v as Rec;
};

// ------------------------------------------------------------------ lookups

export function customerOf(state: DemoState, id: unknown): Customer {
  const c = state.customers.find((x) => x.id === id);
  if (!c) throw new ValidationError("Customer not found.", 404);
  return c;
}
export function vehicleOf(state: DemoState, id: unknown): Vehicle {
  const v = state.vehicles.find((x) => x.id === id);
  if (!v) throw new ValidationError("Vehicle not found.", 404);
  return v;
}
export function bookingOf(state: DemoState, id: string): Booking {
  const b = state.bookings.find((x) => x.id === id);
  if (!b) throw new ValidationError("Booking not found.", 404);
  return b;
}
export function partOf(state: DemoState, id: string): Part {
  const p = state.parts.find((x) => x.id === id);
  if (!p) throw new ValidationError("Part not found.", 404);
  return p;
}
export function requestOf(state: DemoState, id: string): PartsRequest {
  const r = state.requests.find((x) => x.id === id);
  if (!r) throw new ValidationError("Parts request not found.", 404);
  return r;
}
export const normPhone = (p: string): string => p.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
export const findCustomerByPhone = (state: DemoState, phone: string): Customer | undefined =>
  state.customers.find((c) => normPhone(c.phone) === normPhone(phone));

// ---------------------------------------------------------------- customers

export function createCustomer(state: DemoState, body: unknown, now: Date): Customer {
  const b = rec(body);
  const phone = cleanPhone(b.phone);
  if (findCustomerByPhone(state, phone)) throw new ValidationError("A customer with this phone number already exists.", 409);
  const c: Customer = {
    id: nextId(state, "customer"), name: cleanStr(b.name, "Name", 2, 80), phone, email: cleanEmail(b.email),
    notes: cleanStr(b.notes, "Notes", 0, 500, false), createdAt: now.toISOString(), demo: true,
  };
  state.customers.push(c);
  return c;
}
export function updateCustomer(state: DemoState, id: string, body: unknown): Customer {
  const b = rec(body);
  const c = customerOf(state, id);
  if (b.name !== undefined) c.name = cleanStr(b.name, "Name", 2, 80);
  if (b.phone !== undefined) {
    const phone = cleanPhone(b.phone);
    const other = findCustomerByPhone(state, phone);
    if (other && other.id !== c.id) throw new ValidationError("Another customer already uses this phone number.", 409);
    c.phone = phone;
  }
  if (b.email !== undefined) c.email = cleanEmail(b.email);
  if (b.notes !== undefined) c.notes = cleanStr(b.notes, "Notes", 0, 500, false);
  return c;
}

// ----------------------------------------------------------------- vehicles

function cleanVehicleFields(b: Rec, current?: Vehicle) {
  const year = b.year !== undefined || !current ? cleanInt(b.year, "Year", 1980, 2027) : current.year;
  return {
    make: b.make !== undefined || !current ? cleanStr(b.make, "Make", 2, 30) : current!.make,
    model: b.model !== undefined || !current ? cleanStr(b.model, "Model", 1, 40) : current!.model,
    year,
    reg: (b.reg !== undefined || !current ? cleanStr(b.reg, "Registration", 3, 12) : current!.reg).toUpperCase(),
    engine: b.engine !== undefined ? cleanStr(b.engine, "Engine", 0, 40, false) : current?.engine ?? "",
    fuel: b.fuel !== undefined ? cleanStr(b.fuel, "Fuel", 0, 20, false) : current?.fuel ?? "",
    mileage: b.mileage !== undefined && b.mileage !== "" ? cleanInt(b.mileage, "Mileage", 0, 1_000_000) : current?.mileage ?? 0,
  };
}
export function createVehicle(state: DemoState, body: unknown): Vehicle {
  const b = rec(body);
  customerOf(state, b.customerId);
  const f = cleanVehicleFields(b);
  if (state.vehicles.some((v) => v.reg === f.reg)) throw new ValidationError("A vehicle with this registration already exists.", 409);
  const v: Vehicle = { id: nextId(state, "vehicle"), customerId: String(b.customerId), ...f };
  state.vehicles.push(v);
  return v;
}
export function updateVehicle(state: DemoState, id: string, body: unknown): Vehicle {
  const b = rec(body);
  const v = vehicleOf(state, id);
  const f = cleanVehicleFields(b, v);
  if (state.vehicles.some((x) => x.id !== v.id && x.reg === f.reg)) throw new ValidationError("A vehicle with this registration already exists.", 409);
  Object.assign(v, f);
  return v;
}

// --------------------------------------------------------------------- jobs

export function activeBookingsOf(state: DemoState, jobId: string): Booking[] {
  return state.bookings.filter((b) => b.jobId === jobId && (b.status === "confirmed" || b.status === "pending"));
}
export function openRequestOf(state: DemoState, jobId: string): PartsRequest | undefined {
  return state.requests.find((r) => r.jobId === jobId && OPEN_REQUEST.includes(r.status));
}

/** Creates the job record for a service request and reserves available stock. */
export function createJob(
  state: DemoState, o: { customerId: string; vehicleId: string; repairType: string; notes?: string; callId?: string; title?: string }, now: Date,
): Job {
  const vehicle = vehicleOf(state, o.vehicleId);
  if (vehicle.customerId !== o.customerId) throw new ValidationError("That vehicle does not belong to this customer.");
  const rt = repairType(o.repairType);
  const checks = checkParts(state, vehicle, rt.parts);
  const job: Job = {
    id: nextId(state, "job"), customerId: o.customerId, vehicleId: o.vehicleId, repairType: rt.id, title: o.title ?? rt.name,
    status: rt.kind === "inspection" ? "pending_inspection" : "requested", parts: rt.parts.map((p) => ({ ...p })),
    laborHours: rt.hours, laborRate: LABOR_RATE, estimate: estimateJob(state, vehicle, rt.hours, checks),
    notes: o.notes ?? "", callId: o.callId, createdAt: now.toISOString(),
  };
  state.jobs.push(job);
  reserveJobParts(state, job, vehicle);
  return job;
}

/** Re-derives a job's workflow status from its bookings, stock reservations and parts request. */
export function syncJob(state: DemoState, job: Job, now: Date): void {
  if (job.status === "completed" || job.status === "cancelled") return;
  const vehicle = vehicleOf(state, job.vehicleId);
  reserveJobParts(state, job, vehicle);
  const rt = repairType(job.repairType);
  const short = job.parts.some((p) => p.qty > (p.reservedQty ?? 0));
  const request = openRequestOf(state, job.id);
  const bookings = activeBookingsOf(state, job.id);
  if (job.status === "in_progress") return;
  if (rt.kind === "inspection") {
    job.status = bookings.length ? "pending_inspection" : "pending_inspection";
  } else if (short) {
    job.status = "awaiting_parts";
  } else if (request && request.status === "ready_for_repair") {
    job.status = bookings.length ? "scheduled" : "ready";
  } else {
    job.status = bookings.length ? "scheduled" : "requested";
  }
  void now;
}

/** Creates or refreshes the single open parts request for a job's shortfall (no duplicates). */
export function ensureRequestForJob(state: DemoState, job: Job, now: Date): PartsRequest | undefined {
  if (job.status === "completed" || job.status === "cancelled") return undefined;
  const vehicle = vehicleOf(state, job.vehicleId);
  const checks = jobPartChecks(state, job);
  const missing = checks.filter((c) => c.shortfall > 0);
  const existing = openRequestOf(state, job.id);
  if (!missing.length) return existing;
  if (existing) {
    if (existing.status === "ordered" || existing.status === "received" || existing.status === "ready_for_repair" || existing.status === "approved") return existing;
    const fresh = buildRequest(state, job, vehicle, missing, now);
    state.requests.splice(state.requests.indexOf(fresh), 1);
    existing.lines = fresh.lines.map((l) => {
      const old = existing.lines.find((o) => o.kind === l.kind);
      return old && old.shortfall === l.shortfall ? old : l;
    });
    existing.total = requestTotal(existing.lines);
    return existing;
  }
  return buildRequest(state, job, vehicle, missing, now);
}

export function createServiceRequest(state: DemoState, body: unknown, now: Date): Job {
  const b = rec(body);
  const customer = customerOf(state, b.customerId);
  const vehicle = vehicleOf(state, b.vehicleId);
  if (vehicle.customerId !== customer.id) throw new ValidationError("That vehicle does not belong to this customer.");
  const type = cleanStr(b.repairType, "Repair type", 2, 40);
  repairType(type);
  const job = createJob(state, { customerId: customer.id, vehicleId: vehicle.id, repairType: type, notes: cleanStr(b.notes, "Notes", 0, 500, false) }, now);
  syncJob(state, job, now);
  ensureRequestForJob(state, job, now);
  return job;
}

export function updateJob(state: DemoState, id: string, body: unknown, now: Date): Job {
  const b = rec(body);
  const job = jobOf(state, id);
  if (job.status === "completed" || job.status === "cancelled") throw new ValidationError(`This job is ${job.status} and can no longer be changed.`, 409);
  if (b.notes !== undefined) job.notes = cleanStr(b.notes, "Notes", 0, 500, false);
  if (b.laborHours !== undefined) {
    job.laborHours = cleanNum(b.laborHours, "Labour hours", 0.25, 40);
    const checks = jobPartChecks(state, job);
    job.estimate = estimateJob(state, vehicleOf(state, job.vehicleId), job.laborHours, checks);
  }
  if (b.status !== undefined) {
    const status = String(b.status) as JobStatus;
    const allowed: JobStatus[] = ["in_progress", "ready", "completed", "cancelled"];
    if (!allowed.includes(status)) throw new ValidationError(`Status must be one of: ${allowed.join(", ")}.`);
    if (status === "completed") completeJob(state, job, now);
    else if (status === "cancelled") cancelJob(state, job, now, "Cancelled by staff");
    else if (status === "ready" && job.parts.some((p) => p.qty > (p.reservedQty ?? 0))) {
      throw new ValidationError("Cannot mark ready: required parts are not available yet.", 409);
    } else job.status = status;
  } else syncJob(state, job, now);
  return job;
}

export function completeJob(state: DemoState, job: Job, now: Date): void {
  if (job.status === "completed") return;
  if (job.parts.some((p) => p.qty > (p.reservedQty ?? 0))) {
    throw new ValidationError("Cannot complete: required parts are not in stock yet. Receive the parts first.", 409);
  }
  consumeJobParts(state, job, now);
  job.status = "completed";
  job.completedAt = now.toISOString();
  job.finalCost = job.estimate;
  for (const b of state.bookings) if (b.jobId === job.id && (b.status === "confirmed" || b.status === "pending")) b.status = "completed";
  for (const r of state.requests) {
    if (r.jobId === job.id && (r.status === "ready_for_repair" || r.status === "received")) {
      r.status = "completed";
      r.history.push({ at: now.toISOString(), text: "Repair completed." });
    }
  }
}

export function cancelJob(state: DemoState, job: Job, now: Date, reason: string): void {
  job.status = "cancelled";
  releaseJobParts(job);
  for (const b of state.bookings) if (b.jobId === job.id && (b.status === "confirmed" || b.status === "pending")) b.status = "cancelled";
  for (const r of state.requests.filter((x) => x.jobId === job.id)) {
    if (["awaiting_verification", "parts_required", "awaiting_price_confirmation", "awaiting_approval", "approved"].includes(r.status)) {
      r.status = "cancelled";
      r.approval = r.approval === "approved" ? "approved" : "rejected";
      r.history.push({ at: now.toISOString(), text: `${reason}. Request cancelled; nothing had been ordered.` });
    } else if (r.status === "ordered") {
      r.notes = `${r.notes} Job cancelled after the parts were ordered — decide how to handle the order manually.`.trim();
      r.history.push({ at: now.toISOString(), text: `${reason}. Parts were already ordered: review manually.` });
    }
  }
}

// ----------------------------------------------------------------- bookings

export interface BookingInput {
  customerId: string; vehicleId: string; repairType: string; date: string; start: string;
  mechanicId?: string; durationMin?: number; jobId?: string; reportedIssue?: string; notes?: string;
  status?: BookingStatus; source?: Booking["source"]; callId?: string; aiAssessment?: string; allowPast?: boolean;
}

export function createBooking(state: DemoState, input: BookingInput, now: Date): Booking {
  customerOf(state, input.customerId);
  const vehicle = vehicleOf(state, input.vehicleId);
  if (vehicle.customerId !== input.customerId) throw new ValidationError("That vehicle does not belong to this customer.");
  const rt = repairType(input.repairType);
  const durationMin = input.durationMin ?? rt.durationMin;
  const job = input.jobId ? jobOf(state, input.jobId) : undefined;
  if (job && (job.status === "completed" || job.status === "cancelled")) throw new ValidationError("That job is closed.", 409);
  if (job && job.vehicleId !== vehicle.id) throw new ValidationError("Job and vehicle do not match.");
  toMin(input.start);
  let mechanicId = input.mechanicId;
  if (!mechanicId && !input.allowPast) {
    // Give a precise reason (closed, outside hours, past, break) instead of a vague "nobody free".
    const reasons = state.mechanics.map((m) => slotProblem(state, { mechanicId: m.id, date: input.date, start: input.start, durationMin }, now));
    const general = reasons.find((r) => r && !/already booked|does not work/.test(r));
    if (general && reasons.every((r) => r)) throw new ValidationError(general, 409);
  }
  if (!mechanicId) {
    const free = freeMechanics(state, input.date, input.start, durationMin, now).filter(() => true);
    if (input.allowPast) {
      const all = state.mechanics.filter((m) => !slotProblem(state, { mechanicId: m.id, date: input.date, start: input.start, durationMin }, now, { allowPast: true }));
      if (!all.length) throw new ValidationError("No mechanic is free at that time.", 409);
      mechanicId = pickMechanic(state, all, input.date, rt.skill).id;
    } else {
      if (!free.length) throw new ValidationError("No mechanic is free at that time.", 409);
      mechanicId = pickMechanic(state, free, input.date, rt.skill).id;
    }
  }
  mechanicById(state, mechanicId);
  const problem = slotProblem(state, { mechanicId, date: input.date, start: input.start, durationMin }, now, { allowPast: input.allowPast });
  if (problem) throw new ValidationError(problem, 409);

  const owner = job ?? createJob(state, {
    customerId: input.customerId, vehicleId: input.vehicleId, repairType: rt.id, notes: input.notes, callId: input.callId,
  }, now);
  const issue = cleanStr(input.reportedIssue, "Reported issue", 0, 500, false);
  const booking: Booking = {
    id: nextId(state, "booking"), customerId: input.customerId, vehicleId: input.vehicleId, jobId: owner.id, mechanicId,
    date: input.date, start: input.start, durationMin, kind: rt.kind, repairType: rt.name, status: input.status ?? "confirmed",
    reportedIssue: issue, aiAssessment: input.aiAssessment ?? assessment(rt.id, issue),
    notes: cleanStr(input.notes, "Notes", 0, 500, false), source: input.source ?? "manual", callId: input.callId, createdAt: now.toISOString(),
  };
  state.bookings.push(booking);
  syncJob(state, owner, now);
  if (booking.status !== "completed") ensureRequestForJob(state, owner, now);
  return booking;
}

export function bookingFromForm(state: DemoState, body: unknown, now: Date): Booking {
  const b = rec(body);
  const rtId = cleanStr(b.repairType, "Repair type", 2, 40);
  const rt = repairType(rtId);
  const date = cleanStr(b.date, "Date", 10, 10);
  const status = b.status === "pending" ? "pending" : "confirmed";
  return createBooking(state, {
    customerId: String(b.customerId ?? ""), vehicleId: String(b.vehicleId ?? ""), repairType: rt.id, date,
    start: cleanStr(b.start, "Start time", 4, 5), mechanicId: b.mechanicId ? String(b.mechanicId) : undefined,
    durationMin: b.durationMin !== undefined && b.durationMin !== "" ? cleanInt(b.durationMin, "Duration", 15, 480) : undefined,
    reportedIssue: typeof b.reportedIssue === "string" ? b.reportedIssue : "", notes: typeof b.notes === "string" ? b.notes : "",
    status, source: "manual",
  }, now);
}

export function updateBooking(state: DemoState, id: string, body: unknown, now: Date): Booking {
  const b = rec(body);
  const booking = bookingOf(state, id);
  if (booking.status === "cancelled" || booking.status === "completed" || booking.status === "no_show") {
    throw new ValidationError(`This booking is ${booking.status.replace("_", " ")} and cannot be edited.`, 409);
  }
  const next = {
    mechanicId: b.mechanicId !== undefined ? String(b.mechanicId) : booking.mechanicId,
    date: b.date !== undefined ? cleanStr(b.date, "Date", 10, 10) : booking.date,
    start: b.start !== undefined ? cleanStr(b.start, "Start time", 4, 5) : booking.start,
    durationMin: b.durationMin !== undefined ? cleanInt(b.durationMin, "Duration", 15, 480) : booking.durationMin,
  };
  const moved = next.mechanicId !== booking.mechanicId || next.date !== booking.date || next.start !== booking.start || next.durationMin !== booking.durationMin;
  if (moved) {
    const problem = slotProblem(state, { ...next, ignoreId: booking.id }, now);
    if (problem) throw new ValidationError(problem, 409);
  }
  const notes = b.notes !== undefined ? cleanStr(b.notes, "Notes", 0, 500, false) : booking.notes;
  const issue = b.reportedIssue !== undefined ? cleanStr(b.reportedIssue, "Reported issue", 0, 500, false) : booking.reportedIssue;
  let status = booking.status;
  if (b.status !== undefined) {
    if (b.status !== "confirmed" && b.status !== "pending") throw new ValidationError("Use the cancel / complete actions for other statuses.");
    status = b.status;
  }
  Object.assign(booking, next, { notes, reportedIssue: issue, status });
  const job = jobOf(state, booking.jobId);
  syncJob(state, job, now);
  return booking;
}

export function cancelBooking(state: DemoState, id: string, now: Date): Booking {
  const booking = bookingOf(state, id);
  if (booking.status === "cancelled") throw new ValidationError("This booking is already cancelled.", 409);
  if (booking.status === "completed" || booking.status === "no_show") throw new ValidationError("A finished booking cannot be cancelled.", 409);
  booking.status = "cancelled";
  const job = jobOf(state, booking.jobId);
  if (job.status !== "completed" && job.status !== "cancelled" && activeBookingsOf(state, job.id).length === 0) {
    cancelJob(state, job, now, `Booking ${booking.id} cancelled`);
  } else syncJob(state, job, now);
  return booking;
}

export function completeBooking(state: DemoState, id: string, now: Date): Booking {
  const booking = bookingOf(state, id);
  if (booking.status !== "confirmed" && booking.status !== "pending") throw new ValidationError(`A ${booking.status.replace("_", " ")} booking cannot be completed.`, 409);
  const job = jobOf(state, booking.jobId);
  if (booking.kind === "inspection") {
    booking.status = "completed";
    job.notes = `${job.notes} Inspection done on ${booking.date}; awaiting mechanic's findings.`.trim();
    syncJob(state, job, now);
  } else {
    completeJob(state, job, now);
    booking.status = "completed";
  }
  return booking;
}

// ------------------------------------------------------------ parts requests

const APPROVABLE: RequestStatus[] = ["awaiting_verification", "parts_required", "awaiting_price_confirmation", "awaiting_approval"];

function log(r: PartsRequest, now: Date, text: string): void {
  r.history.push({ at: now.toISOString(), text });
}

export function requestAction(state: DemoState, id: string, body: unknown, now: Date): PartsRequest {
  const b = rec(body);
  const r = requestOf(state, id);
  const action = String(b.action ?? "");
  const job = jobOf(state, r.jobId);
  const fail = (m: string) => { throw new ValidationError(m, 409); };
  switch (action) {
    case "verify":
      if (r.status !== "awaiting_verification" && r.status !== "parts_required") fail("Only requests awaiting verification can be verified.");
      r.status = "awaiting_approval"; log(r, now, "Inventory and fitment verified by staff."); break;
    case "choose": {
      if (!APPROVABLE.includes(r.status)) fail("Supplier options can only be changed before approval.");
      const line = r.lines[cleanInt(b.line, "Line", 0, 50)];
      if (!line) throw new ValidationError("Line not found.", 404);
      const idx = cleanInt(b.option, "Option", 0, line.options.length - 1);
      const opt = line.options[idx]!;
      line.chosen = idx; line.unitPrice = opt.unitPrice; line.leadDays = opt.leadDays; line.partNumber = opt.partNumber;
      line.etaDate = addBusiness(localDate(now), opt.leadDays);
      r.total = requestTotal(r.lines); log(r, now, `Supplier option changed to ${opt.supplier} (simulated quote).`); break;
    }
    case "approve":
      if (!APPROVABLE.includes(r.status)) fail("This request cannot be approved in its current state.");
      if (r.lines.some((l) => l.compat === "uncertain") && b.confirmFitment !== true) {
        throw new ValidationError("Fitment is unverified for at least one line. Tick 'I verified fitment' to approve.", 409);
      }
      r.status = "approved"; r.approval = "approved"; log(r, now, "Approved by a human for manual ordering. No order has been placed."); break;
    case "reject":
      if (!APPROVABLE.includes(r.status) && r.status !== "approved") fail("This request can no longer be rejected.");
      r.status = "cancelled"; r.approval = "rejected"; log(r, now, "Rejected by a human. Nothing was ordered."); break;
    case "ordered":
      if (r.status !== "approved") fail("Approve the request before recording an order.");
      r.status = "ordered"; log(r, now, "Order recorded by an authorised human (demo: simulated, no real purchase was made)."); break;
    case "receive": {
      if (r.status !== "ordered") fail("Only ordered requests can be marked received.");
      const vehicle = vehicleOf(state, r.vehicleId);
      for (const l of r.lines) {
        if (l.received) continue;
        let part = l.partId ? state.parts.find((p) => p.id === l.partId) : undefined;
        if (!part) {
          part = {
            id: nextId(state, "part"), sku: l.partNumber, kind: l.kind, name: l.description,
            compat: [{ make: vehicle.make, model: vehicle.model, yearFrom: vehicle.year - 2, yearTo: vehicle.year + 2 }], compatVerified: true,
            quantity: 0, minStock: 1, unitCost: l.unitPrice, supplier: l.options[l.chosen]?.supplier ?? "Unknown", leadDays: l.leadDays,
          };
          state.parts.push(part);
          addMovement(state, { partId: part.id, at: now.toISOString(), delta: 0, reason: "Part added to catalogue on receipt", ref: r.id });
          l.partId = part.id;
        }
        part.quantity += l.shortfall;
        part.unitCost = l.unitPrice;
        addMovement(state, { partId: part.id, at: now.toISOString(), delta: l.shortfall, reason: "Received against parts request", ref: r.id });
        l.received = true;
      }
      r.status = "received"; log(r, now, "Parts received and added to inventory.");
      for (const jp of job.parts) jp.partId = undefined;
      syncJob(state, job, now);
      if (!job.parts.some((p) => p.qty > (p.reservedQty ?? 0))) { r.status = "ready_for_repair"; log(r, now, "All parts reserved — job is ready for repair."); }
      syncJob(state, job, now);
      break;
    }
    default: throw new ValidationError("Unknown action.");
  }
  if (r.status === "cancelled") syncJob(state, job, now);
  return r;
}
const addBusiness = (d: string, n: number): string => {
  let date = d; let left = n;
  const next = (s: string): string => { const x = new Date(`${s}T12:00:00`); x.setDate(x.getDate() + 1); return localDate(x); };
  while (left > 0) { date = next(date); if (new Date(`${date}T12:00:00`).getDay() !== 0) left--; }
  return date;
};
export { addBusiness };

// ----------------------------------------------------------------- inventory

function cleanCompat(v: unknown): Part["compat"] {
  if (v === undefined || v === "") return [];
  if (!Array.isArray(v)) throw new ValidationError("Compatibility must be a list.");
  return v.map((c) => {
    const r = rec(c);
    return {
      make: cleanStr(r.make, "Compat make", 1, 30), model: cleanStr(r.model ?? "*", "Compat model", 1, 40),
      yearFrom: cleanInt(r.yearFrom ?? 1990, "Compat year from", 1980, 2030), yearTo: cleanInt(r.yearTo ?? 2030, "Compat year to", 1980, 2030),
    };
  });
}

export function createPart(state: DemoState, body: unknown, now: Date): Part {
  const b = rec(body);
  const sku = cleanStr(b.sku, "SKU", 3, 30).toUpperCase();
  if (state.parts.some((p) => p.sku === sku)) throw new ValidationError("A part with this SKU already exists.", 409);
  const kind = cleanStr(b.kind, "Part category", 2, 40);
  const part: Part = {
    id: nextId(state, "part"), sku, kind, name: cleanStr(b.name, "Part name", 2, 80), compat: cleanCompat(b.compat),
    compatVerified: b.compatVerified === true, quantity: cleanInt(b.quantity ?? 0, "Quantity", 0, 10_000),
    minStock: cleanInt(b.minStock ?? 1, "Minimum stock", 0, 10_000), unitCost: cleanNum(b.unitCost, "Unit cost", 0, 100_000),
    supplier: cleanStr(b.supplier, "Supplier", 2, 60), leadDays: cleanInt(b.leadDays ?? 3, "Lead time", 0, 90),
  };
  state.parts.push(part);
  if (part.quantity > 0) addMovement(state, { partId: part.id, at: now.toISOString(), delta: part.quantity, reason: "Opening stock (new part)" });
  refreshOpenJobs(state, now);
  return part;
}

export function updatePart(state: DemoState, id: string, body: unknown, now: Date): Part {
  const b = rec(body);
  const part = partOf(state, id);
  if (b.name !== undefined) part.name = cleanStr(b.name, "Part name", 2, 80);
  if (b.minStock !== undefined) part.minStock = cleanInt(b.minStock, "Minimum stock", 0, 10_000);
  if (b.unitCost !== undefined) part.unitCost = cleanNum(b.unitCost, "Unit cost", 0, 100_000);
  if (b.supplier !== undefined) part.supplier = cleanStr(b.supplier, "Supplier", 2, 60);
  if (b.leadDays !== undefined) part.leadDays = cleanInt(b.leadDays, "Lead time", 0, 90);
  if (b.compat !== undefined) part.compat = cleanCompat(b.compat);
  if (b.compatVerified !== undefined) part.compatVerified = b.compatVerified === true;
  refreshOpenJobs(state, now);
  return part;
}

export function adjustStock(state: DemoState, id: string, body: unknown, now: Date) {
  const b = rec(body);
  const part = partOf(state, id);
  const delta = cleanInt(b.delta, "Change", -10_000, 10_000);
  if (delta === 0) throw new ValidationError("Change must not be zero.");
  const reason = cleanStr(b.reason, "Reason", 3, 120);
  const reserved = reservedQty(state, part.id);
  if (part.quantity + delta < 0) throw new ValidationError(`Only ${part.quantity} in stock; cannot remove ${-delta}.`, 409);
  if (part.quantity + delta < reserved) {
    throw new ValidationError(`${reserved} unit(s) are reserved for open jobs; stock cannot drop below that.`, 409);
  }
  part.quantity += delta;
  const m = addMovement(state, { partId: part.id, at: now.toISOString(), delta, reason });
  refreshOpenJobs(state, now);
  return { part, movement: m };
}

/** Stock changed: let open jobs claim newly available units and refresh their requests. */
export function refreshOpenJobs(state: DemoState, now: Date): void {
  for (const job of state.jobs) {
    if (!(OPEN_JOB_STATUSES as readonly string[]).includes(job.status)) continue;
    syncJob(state, job, now);
    const checks = jobPartChecks(state, job);
    const request = openRequestOf(state, job.id);
    if (request && ["parts_required", "awaiting_verification", "awaiting_approval", "awaiting_price_confirmation"].includes(request.status) && !checks.some((c) => c.shortfall > 0)) {
      request.status = "cancelled"; request.approval = "rejected";
      request.history.push({ at: now.toISOString(), text: "Parts are now in stock; request no longer needed." });
    }
  }
}

// --------------------------------------------------------------------- tasks

export function createTask(state: DemoState, o: { text: string; due: string; callId?: string; jobId?: string }, now: Date): Task {
  const t: Task = { id: nextId(state, "task"), text: o.text, due: o.due, done: false, callId: o.callId, jobId: o.jobId, createdAt: now.toISOString() };
  state.tasks.push(t);
  return t;
}
export function updateTask(state: DemoState, id: string, body: unknown): Task {
  const b = rec(body);
  const t = state.tasks.find((x) => x.id === id);
  if (!t) throw new ValidationError("Task not found.", 404);
  if (typeof b.done !== "boolean") throw new ValidationError("'done' must be true or false.");
  t.done = b.done;
  return t;
}

export function jobRequestSummary(state: DemoState, job: Job) {
  const checks = jobPartChecks(state, job);
  return { checks, missing: checks.filter((c) => c.shortfall > 0), request: openRequestOf(state, job.id) };
}

export { availableQty, etaOf, findSlots, isActive };
