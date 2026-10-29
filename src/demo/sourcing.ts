/** Helpers shared by the seed generator and the live service: ids, parts requests, movements. */
import {
  PRICE_SOURCE, addBusinessDays, localDate, sourcingOptions,
} from "./rules.js";
import type {
  DemoState, Job, Movement, PartCheck, PartsRequest, RequestLine, Vehicle,
} from "./types.js";

const PREFIX: Record<string, [string, number]> = {
  customer: ["C-", 1], vehicle: ["V-", 1], job: ["J-", 1000], booking: ["B-", 2000], call: ["CALL-", 3000],
  request: ["PR-", 4000], part: ["P-", 1], movement: ["M-", 1], task: ["T-", 1], session: ["S-", 1],
};

export function nextId(state: DemoState, kind: keyof typeof PREFIX): string {
  const [prefix, base] = PREFIX[kind]!;
  const n = (state.counters[kind] ?? base - 1) + 1;
  state.counters[kind] = n;
  return `${prefix}${kind === "customer" || kind === "vehicle" || kind === "part" ? String(n).padStart(3, "0") : n}`;
}

export function addMovement(state: DemoState, m: Omit<Movement, "id">): Movement {
  const movement: Movement = { id: nextId(state, "movement"), ...m };
  state.movements.push(movement);
  return movement;
}

export function requestTotal(lines: RequestLine[]): number {
  return Math.round(lines.reduce((sum, l) => sum + l.unitPrice * l.shortfall, 0) * 100) / 100;
}

export function etaOf(lines: RequestLine[]): string | undefined {
  const dates = lines.filter((l) => l.shortfall > 0).map((l) => l.etaDate).sort();
  return dates[dates.length - 1];
}

/** Builds a proposed parts request for the shortfall of a job. Nothing is ever ordered here. */
export function buildRequest(
  state: DemoState, job: Job, vehicle: Vehicle, missing: PartCheck[], now: Date, status: PartsRequest["status"] = "awaiting_approval",
): PartsRequest {
  const today = localDate(now);
  const lines: RequestLine[] = missing.filter((m) => m.shortfall > 0).map((m) => {
    const options = sourcingOptions(m.kind, vehicle);
    const chosen = 0;
    const opt = options[chosen]!;
    return {
      kind: m.kind, description: m.description, partNumber: opt.partNumber, partId: m.partId, qty: m.qty,
      inStock: m.available, shortfall: m.shortfall, compat: m.compat, options, chosen,
      unitPrice: opt.unitPrice, leadDays: opt.leadDays, etaDate: addBusinessDays(today, opt.leadDays),
      priceSource: PRICE_SOURCE, priceAt: now.toISOString(), received: false,
    };
  });
  const request: PartsRequest = {
    id: nextId(state, "request"), jobId: job.id, customerId: job.customerId, vehicleId: job.vehicleId, status,
    approval: status === "awaiting_approval" || status === "parts_required" || status === "awaiting_price_confirmation" ? "pending" : "approved",
    lines, total: requestTotal(lines),
    notes: lines.some((l) => l.compat === "uncertain") ? "Fitment not verified for at least one line — staff must confirm before ordering." : "",
    createdAt: now.toISOString(),
    history: [{ at: now.toISOString(), text: "Proposed by AI receptionist. Nothing has been ordered." }],
  };
  state.requests.push(request);
  return request;
}

export const OPEN_REQUEST: PartsRequest["status"][] = [
  "awaiting_verification", "parts_required", "awaiting_price_confirmation", "awaiting_approval", "approved", "ordered", "received", "ready_for_repair",
];

// ----------------------------------------------------------- stock reservation

import { PART_KINDS, availableQty, partsForKind, reservedQty } from "./rules.js";

/** Matches each job part to a stock item and holds back what is available. Never over-reserves. */
export function reserveJobParts(state: DemoState, job: Job, vehicle: Vehicle): void {
  for (const jp of job.parts) {
    const best = partsForKind(state, jp.kind, vehicle)[0];
    if (!best) { jp.partId = undefined; jp.reservedQty = 0; continue; }
    jp.partId = best.part.id;
    const free = availableQty(state, best.part, job.id);
    jp.reservedQty = Math.min(jp.qty, free);
  }
}

export function releaseJobParts(job: Job): void {
  for (const jp of job.parts) jp.reservedQty = 0;
}

/** Consumes reserved stock when a job completes and records the movement. */
export function consumeJobParts(state: DemoState, job: Job, now: Date): void {
  for (const jp of job.parts) {
    const part = jp.partId ? state.parts.find((p) => p.id === jp.partId) : undefined;
    const used = Math.min(jp.reservedQty ?? 0, part?.quantity ?? 0);
    if (part && used > 0) {
      part.quantity -= used;
      addMovement(state, { partId: part.id, at: now.toISOString(), delta: -used, reason: "Used on completed job", ref: job.id });
    }
    jp.reservedQty = 0;
  }
}

/** Part checks for a job derived from what is actually reserved for it right now. */
export function jobPartChecks(state: DemoState, job: Job): PartCheck[] {
  return job.parts.map((jp) => {
    const part = jp.partId ? state.parts.find((p) => p.id === jp.partId) : undefined;
    const label = PART_KINDS[jp.kind]?.label ?? jp.kind;
    if (!part) {
      return {
        kind: jp.kind, description: label, qty: jp.qty, stock: 0, reserved: 0, available: 0, shortfall: jp.qty,
        compat: "uncertain" as const, note: "No matching part in stock; fitment must be verified before ordering.",
      };
    }
    const others = reservedQty(state, part.id, job.id);
    const available = Math.max(0, part.quantity - others);
    const shortfall = Math.max(0, jp.qty - (jp.reservedQty ?? 0));
    return {
      kind: jp.kind, description: part.name, qty: jp.qty, partId: part.id, partName: part.name, stock: part.quantity,
      reserved: others, available, shortfall, compat: "confirmed" as const,
      note: shortfall ? `${shortfall} short` : "Reserved for this job",
    };
  });
}
