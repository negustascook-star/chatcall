/** Pure business rules of the demo workshop: hours, booking conflicts, stock and sourcing. */
import type {
  Booking, DemoState, Job, Mechanic, Part, PartCheck, RepairKind, SupplierOption, Vehicle,
} from "./types.js";

export class ValidationError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "ValidationError";
  }
}

export const SLOT_STEP = 15;
export const LABOR_RATE = 85;
export const PARTS_MARKUP = 1.35;
export const SHOP_NAME = "Summit Auto Care";
export const OPEN_JOB_STATUSES = ["requested", "pending_inspection", "awaiting_parts", "scheduled", "in_progress", "ready"] as const;

// ---------------------------------------------------------------- time helpers

export const pad = (n: number): string => String(n).padStart(2, "0");
export function toMin(hhmm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) throw new ValidationError(`Invalid time '${hhmm}'. Use HH:MM.`);
  return Number(m[1]) * 60 + Number(m[2]);
}
export const fromMin = (n: number): string => `${pad(Math.floor(n / 60))}:${pad(n % 60)}`;
export function localDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
export function parseDate(date: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new ValidationError(`Invalid date '${date}'. Use YYYY-MM-DD.`);
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0);
  if (localDate(d) !== date) throw new ValidationError(`Invalid date '${date}'.`);
  return d;
}
export function addDays(date: string, n: number): string {
  const d = parseDate(date);
  d.setDate(d.getDate() + n);
  return localDate(d);
}
export const weekday = (date: string): number => parseDate(date).getDay();
export const nowMinutes = (now: Date): number => now.getHours() * 60 + now.getMinutes();
export function diffDays(a: string, b: string): number {
  return Math.round((parseDate(a).getTime() - parseDate(b).getTime()) / 86_400_000);
}
export function weekStart(date: string): string {
  const wd = weekday(date);
  return addDays(date, wd === 0 ? -6 : 1 - wd);
}
export const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export function prettyDate(date: string): string {
  const d = parseDate(date);
  return `${WEEKDAY_NAMES[d.getDay()]}, ${d.toLocaleString("en-US", { month: "short" })} ${d.getDate()}`;
}

export interface DayHours { open: number; close: number; breaks: [number, number][] }
/** Opening hours: Mon–Fri 08:00–17:00 with a 12:00–13:00 break, Sat 09:00–13:00, Sunday closed. */
export function dayHours(date: string): DayHours | null {
  const wd = weekday(date);
  if (wd === 0) return null;
  if (wd === 6) return { open: 9 * 60, close: 13 * 60, breaks: [] };
  return { open: 8 * 60, close: 17 * 60, breaks: [[12 * 60, 13 * 60]] };
}
export const HOURS_TEXT = "Mon–Fri 08:00–17:00 (break 12:00–13:00), Sat 09:00–13:00, Sun closed";

export function addBusinessDays(date: string, n: number): string {
  let d = date;
  let left = n;
  while (left > 0) {
    d = addDays(d, 1);
    if (weekday(d) !== 0) left--;
  }
  while (weekday(d) === 0) d = addDays(d, 1);
  return d;
}

export const overlaps = (a0: number, a1: number, b0: number, b1: number): boolean => a0 < b1 && b0 < a1;
export const isActive = (b: Booking): boolean => b.status === "confirmed" || b.status === "pending" || b.status === "completed";
const blocksTime = (b: Booking): boolean => b.status === "confirmed" || b.status === "pending" || b.status === "completed";

// ------------------------------------------------------------ booking checks

export function mechanicById(state: DemoState, id: string): Mechanic {
  const m = state.mechanics.find((x) => x.id === id);
  if (!m) throw new ValidationError("Unknown mechanic.", 404);
  return m;
}

export function mechanicConflict(
  state: DemoState, mechanicId: string, date: string, start: number, dur: number, ignoreId?: string,
): Booking | undefined {
  return state.bookings.find((b) =>
    b.id !== ignoreId && b.mechanicId === mechanicId && b.date === date && blocksTime(b)
    && overlaps(start, start + dur, toMin(b.start), toMin(b.start) + b.durationMin));
}

/** Returns a human readable reason when the slot cannot be booked, otherwise null. */
export function slotProblem(
  state: DemoState,
  slot: { mechanicId: string; date: string; start: string; durationMin: number; ignoreId?: string },
  now: Date,
  opts: { allowPast?: boolean } = {},
): string | null {
  const mech = mechanicById(state, slot.mechanicId);
  const start = toMin(slot.start);
  const dur = slot.durationMin;
  if (!Number.isInteger(dur) || dur < SLOT_STEP || dur > 480 || dur % SLOT_STEP !== 0) {
    throw new ValidationError(`Duration must be a multiple of ${SLOT_STEP} minutes between ${SLOT_STEP} and 480.`);
  }
  if (start % SLOT_STEP !== 0) throw new ValidationError(`Start time must be on a ${SLOT_STEP}-minute step.`);
  const hours = dayHours(slot.date);
  if (!hours) return `The workshop is closed on ${WEEKDAY_NAMES[weekday(slot.date)]}s.`;
  if (!mech.workDays.includes(weekday(slot.date))) return `${mech.name} does not work on ${WEEKDAY_NAMES[weekday(slot.date)]}s.`;
  if (start < hours.open || start + dur > hours.close) {
    return `Outside opening hours (${fromMin(hours.open)}–${fromMin(hours.close)}).`;
  }
  for (const [b0, b1] of hours.breaks) {
    if (overlaps(start, start + dur, b0, b1)) return `Overlaps the break (${fromMin(b0)}–${fromMin(b1)}).`;
  }
  if (!opts.allowPast) {
    const today = localDate(now);
    if (slot.date < today || (slot.date === today && start < nowMinutes(now))) return "That time is in the past.";
  }
  const clash = mechanicConflict(state, slot.mechanicId, slot.date, start, dur, slot.ignoreId);
  if (clash) {
    return `${mech.name} is already booked ${clash.start}–${fromMin(toMin(clash.start) + clash.durationMin)} (${clash.repairType}).`;
  }
  return null;
}

export function freeMechanics(
  state: DemoState, date: string, start: string, dur: number, now: Date, ignoreId?: string,
): Mechanic[] {
  return state.mechanics.filter((m) => !slotProblem(state, { mechanicId: m.id, date, start, durationMin: dur, ignoreId }, now));
}

export interface FoundSlot { date: string; start: string; mechanicId: string }

/** Earliest free (date, start, mechanic) triples starting at `from`. */
export function findSlots(
  state: DemoState,
  o: { from: string; days: number; durationMin: number; now: Date; skill?: string; startAfter?: number; limit?: number; avoid?: FoundSlot[] },
): FoundSlot[] {
  const out: FoundSlot[] = [];
  for (let i = 0; i < o.days; i++) {
    const date = addDays(o.from, i);
    const hours = dayHours(date);
    if (!hours) continue;
    for (let t = hours.open; t + o.durationMin <= hours.close; t += 30) {
      if (i === 0 && o.startAfter !== undefined && t < o.startAfter) continue;
      const free = freeMechanics(state, date, fromMin(t), o.durationMin, o.now)
        .filter((m) => !o.avoid?.some((a) => a.date === date && a.mechanicId === m.id && toMin(a.start) < t + o.durationMin));
      if (!free.length) continue;
      const pick = pickMechanic(state, free, date, o.skill);
      out.push({ date, start: fromMin(t), mechanicId: pick.id });
      if (o.limit && out.length >= o.limit) return out;
    }
  }
  return out;
}

export function pickMechanic(state: DemoState, free: Mechanic[], date: string, skill?: string): Mechanic {
  const load = (m: Mechanic) => state.bookings.filter((b) => b.mechanicId === m.id && b.date === date && blocksTime(b)).length;
  const sorted = [...free].sort((a, b) => {
    const sa = skill && a.skills.includes(skill) ? 0 : 1;
    const sb = skill && b.skills.includes(skill) ? 0 : 1;
    return sa - sb || load(a) - load(b) || a.id.localeCompare(b.id);
  });
  return sorted[0]!;
}

// ------------------------------------------------------------------ catalogs

export interface RepairType {
  id: string; name: string; kind: RepairKind; hours: number; durationMin: number;
  parts: { kind: string; qty: number }[]; skill: string; keywords: string[]; weight: number;
}

export const REPAIR_TYPES: RepairType[] = [
  { id: "oil_service", name: "Oil & filter change", kind: "service", hours: 1, durationMin: 60, skill: "service", weight: 18,
    parts: [{ kind: "engine_oil", qty: 1 }, { kind: "oil_filter", qty: 1 }], keywords: ["oil change", "oil and filter", "oil service", "oil & filter", "engine oil", "annual service", "full service", "routine service", "maintenance", "oil"] },
  { id: "filters", name: "Air & cabin filter replacement", kind: "service", hours: 0.5, durationMin: 30, skill: "service", weight: 6,
    parts: [{ kind: "air_filter", qty: 1 }, { kind: "cabin_filter", qty: 1 }], keywords: ["air filter", "cabin filter", "pollen filter", "dusty smell"] },
  { id: "brake_inspection", name: "Brake inspection", kind: "inspection", hours: 0.75, durationMin: 45, skill: "brakes", weight: 8,
    parts: [], keywords: ["brake inspection", "check the brakes", "brakes checked"] },
  { id: "brake_pads_front", name: "Front brake pads", kind: "repair", hours: 1.5, durationMin: 90, skill: "brakes", weight: 6,
    parts: [{ kind: "brake_pads_front", qty: 1 }], keywords: ["front brake pads", "brake pads", "new pads"] },
  { id: "brake_service_front", name: "Front brake pads & discs", kind: "repair", hours: 2.5, durationMin: 150, skill: "brakes", weight: 8,
    parts: [{ kind: "brake_pads_front", qty: 1 }, { kind: "brake_discs_front", qty: 1 }], keywords: ["pads and discs", "pads & discs", "brake discs", "brake rotors", "discs"] },
  { id: "brake_service_rear", name: "Rear brake pads & discs", kind: "repair", hours: 2, durationMin: 120, skill: "brakes", weight: 3,
    parts: [{ kind: "brake_pads_rear", qty: 1 }, { kind: "brake_discs_rear", qty: 1 }], keywords: ["rear brakes", "rear brake pads", "rear discs"] },
  { id: "battery", name: "Battery replacement", kind: "repair", hours: 0.5, durationMin: 30, skill: "electrical", weight: 6,
    parts: [{ kind: "battery", qty: 1 }], keywords: ["battery", "flat battery", "dead battery"] },
  { id: "diagnostic", name: "Diagnostic scan", kind: "inspection", hours: 1, durationMin: 60, skill: "electrical", weight: 8,
    parts: [], keywords: ["check engine", "warning light", "engine light", "diagnostic", "fault code", "dashboard light", "limp mode"] },
  { id: "ac_service", name: "A/C service & regas", kind: "service", hours: 1, durationMin: 60, skill: "electrical", weight: 4,
    parts: [{ kind: "ac_refrigerant", qty: 1 }], keywords: ["air conditioning", "a/c", "aircon", "ac service", "ac not cold", "regas"] },
  { id: "spark_plugs", name: "Spark plug replacement", kind: "service", hours: 1, durationMin: 60, skill: "engine", weight: 3,
    parts: [{ kind: "spark_plugs_set", qty: 1 }], keywords: ["spark plug"] },
  { id: "timing_belt", name: "Timing belt & water pump service", kind: "repair", hours: 4, durationMin: 240, skill: "engine", weight: 2,
    parts: [{ kind: "timing_belt_kit", qty: 1 }, { kind: "water_pump", qty: 1 }, { kind: "serpentine_belt", qty: 1 }, { kind: "coolant", qty: 1 }],
    keywords: ["timing belt", "cambelt", "water pump", "belt replacement"] },
  { id: "suspension_inspection", name: "Suspension inspection", kind: "inspection", hours: 1, durationMin: 60, skill: "suspension", weight: 4,
    parts: [], keywords: ["clunk", "knocking over bumps", "suspension", "bouncy", "rattle over bumps"] },
  { id: "front_shocks", name: "Front shock absorbers (pair)", kind: "repair", hours: 3, durationMin: 180, skill: "suspension", weight: 2,
    parts: [{ kind: "shock_absorber_front", qty: 2 }], keywords: ["shock absorber", "shocks", "struts"] },
  { id: "wheel_bearing", name: "Front wheel bearing", kind: "repair", hours: 2, durationMin: 120, skill: "suspension", weight: 2,
    parts: [{ kind: "wheel_bearing_front", qty: 1 }], keywords: ["wheel bearing"] },
  { id: "clutch", name: "Clutch replacement", kind: "repair", hours: 4, durationMin: 240, skill: "engine", weight: 1,
    parts: [{ kind: "clutch_kit", qty: 1 }], keywords: ["clutch", "slipping clutch"] },
  { id: "wipers", name: "Wiper blades", kind: "service", hours: 0.25, durationMin: 30, skill: "service", weight: 3,
    parts: [{ kind: "wiper_blades", qty: 1 }], keywords: ["wiper"] },
  { id: "tire_rotation", name: "Tire rotation & balance", kind: "service", hours: 1, durationMin: 60, skill: "service", weight: 4,
    parts: [], keywords: ["tire rotation", "tyre rotation", "wheel balance", "balancing"] },
  { id: "follow_up_check", name: "Follow-up check", kind: "inspection", hours: 0.5, durationMin: 30, skill: "service", weight: 0,
    parts: [], keywords: ["follow-up check"] },
  { id: "general_inspection", name: "General vehicle inspection", kind: "inspection", hours: 1, durationMin: 60, skill: "service", weight: 4,
    parts: [], keywords: ["general inspection", "health check", "pre-purchase", "look it over", "check it over"] },
];
export const repairType = (id: string): RepairType => {
  const r = REPAIR_TYPES.find((x) => x.id === id);
  if (!r) throw new ValidationError(`Unknown repair type '${id}'.`);
  return r;
};

/** Reference cost per part kind (demo figures, EUR) used for stock valuation and fictional sourcing quotes. */
export const PART_KINDS: Record<string, { label: string; cost: number; code: string }> = {
  engine_oil: { label: "Engine oil 5 L", cost: 34, code: "OIL" },
  oil_filter: { label: "Oil filter", cost: 9, code: "OFI" },
  air_filter: { label: "Air filter", cost: 14, code: "AFI" },
  cabin_filter: { label: "Cabin filter", cost: 12, code: "CFI" },
  brake_pads_front: { label: "Front brake pad set", cost: 46, code: "BPF" },
  brake_pads_rear: { label: "Rear brake pad set", cost: 38, code: "BPR" },
  brake_discs_front: { label: "Front brake disc pair", cost: 96, code: "BDF" },
  brake_discs_rear: { label: "Rear brake disc pair", cost: 78, code: "BDR" },
  brake_fluid: { label: "Brake fluid 1 L", cost: 11, code: "BFL" },
  battery: { label: "Car battery", cost: 98, code: "BAT" },
  ac_refrigerant: { label: "A/C refrigerant", cost: 42, code: "ACR" },
  spark_plugs_set: { label: "Spark plug set", cost: 36, code: "SPK" },
  timing_belt_kit: { label: "Timing belt kit", cost: 148, code: "TBK" },
  water_pump: { label: "Water pump", cost: 72, code: "WPM" },
  serpentine_belt: { label: "Serpentine belt", cost: 31, code: "SRB" },
  coolant: { label: "Coolant 5 L", cost: 19, code: "CLT" },
  shock_absorber_front: { label: "Front shock absorber", cost: 84, code: "SHF" },
  wheel_bearing_front: { label: "Front wheel bearing", cost: 54, code: "WBF" },
  clutch_kit: { label: "Clutch kit", cost: 235, code: "CLK" },
  wiper_blades: { label: "Wiper blade set", cost: 21, code: "WIP" },
};
const PREMIUM = new Set(["BMW", "Audi", "Mercedes-Benz", "Volvo"]);
export const PRICE_SOURCE = "Simulated demo price — not a live market quote";

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** Fictional supplier offers. Never live data; deterministic per part kind and vehicle make. */
export function sourcingOptions(kind: string, vehicle: Pick<Vehicle, "make" | "model">): SupplierOption[] {
  const base = PART_KINDS[kind];
  if (!base) return [];
  const factor = PREMIUM.has(vehicle.make) ? 1.4 : 1;
  const code = `${base.code}-${(hash(`${kind}${vehicle.make}${vehicle.model}`) % 9000 + 1000)}`;
  const mk = (supplier: string, tag: string, mult: number, leadDays: number): SupplierOption => ({
    supplier, partNumber: `DEMO-${code}-${tag}`, unitPrice: Math.round(base.cost * factor * mult * 100) / 100, leadDays,
  });
  return [
    mk("AutoParts North (demo)", "N", 1, 3),
    mk("CityParts Express (demo)", "C", 1.14, 1),
    mk("EuroTrade Wholesale (demo)", "E", 0.91, 6),
  ];
}

// ----------------------------------------------------------------- inventory

export function reservedQty(state: DemoState, partId: string, ignoreJobId?: string): number {
  let total = 0;
  for (const job of state.jobs) {
    if (job.id === ignoreJobId || !(OPEN_JOB_STATUSES as readonly string[]).includes(job.status)) continue;
    for (const p of job.parts) if (p.partId === partId) total += p.reservedQty ?? 0;
  }
  return total;
}
export const availableQty = (state: DemoState, part: Part, ignoreJobId?: string): number =>
  Math.max(0, part.quantity - reservedQty(state, part.id, ignoreJobId));

export type StockStatus = "in_stock" | "low_stock" | "out_of_stock" | "fully_reserved";
export function stockStatus(state: DemoState, part: Part): StockStatus {
  if (part.quantity <= 0) return "out_of_stock";
  const available = availableQty(state, part);
  if (available <= 0) return "fully_reserved";
  if (available <= part.minStock) return "low_stock";
  return "in_stock";
}

export function compatFor(part: Part, v: Pick<Vehicle, "make" | "model" | "year">): "confirmed" | "uncertain" | null {
  const hit = part.compat.some((c) =>
    c.make.toLowerCase() === v.make.toLowerCase()
    && (c.model === "*" || c.model.toLowerCase() === v.model.toLowerCase())
    && v.year >= c.yearFrom && v.year <= c.yearTo);
  if (!hit) return null;
  return part.compatVerified ? "confirmed" : "uncertain";
}
const universal = (part: Part): boolean => part.compat.some((c) => c.make === "*");

export function partsForKind(state: DemoState, kind: string, v: Pick<Vehicle, "make" | "model" | "year">, fuel?: string) {
  const out: { part: Part; compat: "confirmed" | "uncertain" }[] = [];
  for (const part of state.parts) {
    if (part.kind !== kind) continue;
    if (universal(part)) { out.push({ part, compat: "confirmed" }); continue; }
    const c = compatFor(part, v);
    if (c) out.push({ part, compat: c });
  }
  void fuel;
  return out.sort((a, b) => availableQty(state, b.part) - availableQty(state, a.part)
    || (a.compat === "confirmed" ? 0 : 1) - (b.compat === "confirmed" ? 0 : 1));
}

/** Checks each needed part kind against real demo stock, minus reservations of other jobs. */
export function checkParts(
  state: DemoState, vehicle: Pick<Vehicle, "make" | "model" | "year">, needs: { kind: string; qty: number }[], ignoreJobId?: string,
): PartCheck[] {
  return needs.map((need) => {
    const label = PART_KINDS[need.kind]?.label ?? need.kind;
    const cands = partsForKind(state, need.kind, vehicle);
    const best = cands[0];
    if (!best) {
      return {
        kind: need.kind, description: label, qty: need.qty, stock: 0, reserved: 0, available: 0, shortfall: need.qty,
        compat: "uncertain", note: "No stocked part is listed as compatible with this vehicle; fitment must be verified by staff before ordering.",
      };
    }
    const reserved = reservedQty(state, best.part.id, ignoreJobId);
    const available = Math.max(0, best.part.quantity - reserved);
    const shortfall = Math.max(0, need.qty - available);
    const note = shortfall === 0
      ? (best.compat === "uncertain" ? "In stock, but fitment is not verified — mechanic must confirm before use." : "In stock and compatible.")
      : `${available} available (${best.part.quantity} on hand, ${reserved} reserved for other jobs); ${shortfall} short.`;
    return {
      kind: need.kind, description: best.part.name, qty: need.qty, partId: best.part.id, partName: best.part.name,
      stock: best.part.quantity, reserved, available, shortfall, compat: best.compat, note,
    };
  });
}

export function estimateJob(
  state: DemoState, vehicle: Pick<Vehicle, "make" | "model" | "year">, hours: number, checks: PartCheck[],
): number {
  let parts = 0;
  for (const c of checks) {
    const part = c.partId ? state.parts.find((p) => p.id === c.partId) : undefined;
    const unit = part?.unitCost ?? sourcingOptions(c.kind, vehicle as Vehicle).map((o) => o.unitPrice).sort((a, b) => a - b)[0] ?? 0;
    parts += unit * PARTS_MARKUP * c.qty;
  }
  return Math.round(hours * LABOR_RATE + parts);
}

// ---------------------------------------------------------------- validation

export function cleanStr(v: unknown, field: string, min: number, max: number, required = true): string {
  if (v === undefined || v === null || v === "") {
    if (required) throw new ValidationError(`${field} is required.`);
    return "";
  }
  if (typeof v !== "string") throw new ValidationError(`${field} must be text.`);
  const s = v.trim().replace(/\s+/g, " ");
  if (s.length < min || s.length > max) throw new ValidationError(`${field} must be ${min}–${max} characters.`);
  return s;
}
export function cleanPhone(v: unknown): string {
  const s = cleanStr(v, "Phone", 7, 24);
  if (!/^[+\d][\d\s().-]{5,}$/.test(s) || s.replace(/\D/g, "").length < 7 || s.replace(/\D/g, "").length > 15) {
    throw new ValidationError("Phone number looks invalid.");
  }
  return s;
}
export function cleanEmail(v: unknown): string {
  const s = cleanStr(v, "Email", 3, 120, false);
  if (s && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw new ValidationError("Email looks invalid.");
  return s;
}
export function cleanInt(v: unknown, field: string, min: number, max: number): number {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isInteger(n) || n < min || n > max) {
    throw new ValidationError(`${field} must be a whole number between ${min} and ${max}.`);
  }
  return n;
}
export function cleanNum(v: unknown, field: string, min: number, max: number): number {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n) || n < min || n > max) {
    throw new ValidationError(`${field} must be a number between ${min} and ${max}.`);
  }
  return n;
}

export function jobOf(state: DemoState, id: string): Job {
  const j = state.jobs.find((x) => x.id === id);
  if (!j) throw new ValidationError("Job not found.", 404);
  return j;
}
