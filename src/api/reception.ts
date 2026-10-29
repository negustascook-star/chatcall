import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export interface ReceptionConfig {
  url: string;
  key: string;
  toolSecret: string;
  companyId: string;
}
type Row = Record<string, any>;
class ReceptionError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

export function receptionConfigFromEnv(): ReceptionConfig | undefined {
  const url = process.env.SUPABASE_URL?.trim();
  const key = (process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY)?.trim();
  const toolSecret = process.env.RECEPTION_TOOL_SECRET?.trim();
  const companyId = process.env.RECEPTION_COMPANY_ID?.trim();
  if (!url || !key || !toolSecret || !companyId || !UUID.test(companyId)) return undefined;
  return { url, key, toolSecret, companyId };
}

export async function routeReception(req: IncomingMessage, res: ServerResponse, config?: ReceptionConfig): Promise<void> {
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify(body));
  };
  // A browser visit is a GET; explain the contract without exposing company data.
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    send(405, { error: "Use POST with x-reception-key and JSON {service_id, date, specialist_id?}. This tool checks availability; it does not book." });
    return;
  }
  try {
    if (!config) throw new ReceptionError(503, "Reception integration is not configured on the server.");
    const supplied = req.headers["x-reception-key"];
    if (typeof supplied !== "string" || !timingSafeEqual(createHash("sha256").update(supplied).digest(), createHash("sha256").update(config.toolSecret).digest())) {
      throw new ReceptionError(401, "Invalid tool key.");
    }
    let raw = "";
    for await (const chunk of req) {
      raw += chunk.toString();
      if (Buffer.byteLength(raw) > 16384) throw new ReceptionError(413, "Request too large.");
    }
    let input: Row;
    try { input = JSON.parse(raw); } catch { throw new ReceptionError(400, "Invalid JSON."); }
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new ReceptionError(400, "JSON object required.");
    if (typeof input.service_id !== "string" || !UUID.test(input.service_id)) throw new ReceptionError(400, "Valid service_id required.");
    if (input.specialist_id !== undefined && (typeof input.specialist_id !== "string" || !UUID.test(input.specialist_id))) throw new ReceptionError(400, "Invalid specialist_id.");
    if (typeof input.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(input.date) || !Number.isFinite(Date.parse(input.date)) || new Date(input.date).toISOString().slice(0, 10) !== input.date) throw new ReceptionError(400, "Valid date YYYY-MM-DD required.");
    const read = async (table: string, params: Record<string, string>): Promise<Row[]> => {
      const url = new URL(`${config.url.replace(/\/$/, "")}/rest/v1/${table}`);
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
      const response = await fetch(url, { headers: { apikey: config.key, Authorization: `Bearer ${config.key}` }, signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new ReceptionError(502, "Calendar data source unavailable.");
      const rows = await response.json();
      if (!Array.isArray(rows)) throw new ReceptionError(502, "Invalid calendar response.");
      return rows;
    };
    const companies = await read("companies", { select: "id,opening_hours,suspended_at", id: `eq.${config.companyId}` });
    const company = companies[0];
    if (!company || company.suspended_at) throw new ReceptionError(403, "Company unavailable.");
    const services = await read("business_services", { select: "id,name,duration_minutes", company_id: `eq.${config.companyId}`, id: `eq.${input.service_id}`, active: "eq.true" });
    const service = services[0];
    if (!service) throw new ReceptionError(404, "Active service not found for this company.");
    const duration = Number(service.duration_minutes);
    if (!Number.isInteger(duration) || duration < 1 || duration > 1440) throw new ReceptionError(503, "Service duration is not configured.");
    const timezone = company.opening_hours?.timezone || "Europe/Vilnius";
    const nowDate = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    if (input.date < nowDate || new Date(input.date).getTime() > Date.now() + 180 * 86400000) throw new ReceptionError(400, "Date must be within the next 180 days.");
    const specialistParams: Record<string, string> = { select: "id,name,working_schedule,unavailable_periods", company_id: `eq.${config.companyId}`, active: "eq.true", limit: "101" };
    if (input.specialist_id) specialistParams.id = `eq.${input.specialist_id}`;
    const specialists = await read("specialists", specialistParams);
    if (!specialists.length) throw new ReceptionError(503, "No active specialists configured.");
    if (specialists.length > 100) throw new ReceptionError(503, "Specify specialist_id.");
    // Fetch appointments crossing the local day too; never expose customer details.
    const start = new Date(`${input.date}T00:00:00Z`).getTime() - 86400000;
    const end = start + 3 * 86400000;
    const appointments = await read("appointments", { select: "specialist_id,starts_at,ends_at,status", company_id: `eq.${config.companyId}`, starts_at: `lt.${new Date(end).toISOString()}`, ends_at: `gt.${new Date(start).toISOString()}`, limit: "1001" });
    if (appointments.length > 1000) throw new ReceptionError(503, "Calendar too large to check safely.");
    const result = calculateSlots(input.date, timezone, duration, company.opening_hours, specialists, appointments);
    send(200, { date: input.date, timezone, service: { id: service.id, name: service.name, duration_minutes: duration }, available: result.length > 0, slots: result.slice(0, 50), booking_confirmed: false });
  } catch (error) {
    if (error instanceof ReceptionError) send(error.status, { error: error.message, booking_confirmed: false });
    else { console.error("Reception availability failed", error instanceof Error ? error.name : "UnknownError"); send(502, { error: "Availability could not be verified. Offer a callback; do not confirm a booking.", booking_confirmed: false }); }
  }
}

function windows(schedule: Row, day: string): Array<{ start: string; end: string }> {
  if (!schedule || !schedule.weekly || !Object.prototype.hasOwnProperty.call(schedule.weekly, day)) throw new ReceptionError(503, "Structured weekly opening hours and specialist schedules required.");
  const rows = schedule.weekly[day];
  if (!Array.isArray(rows) || rows.some((r: Row) => !r || !/^([01]\d|2[0-3]):[0-5]\d$/.test(r.start) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(r.end) || r.start >= r.end)) throw new ReceptionError(503, "Invalid working hours.");
  return rows;
}
function minutes(time: string): number { const [h, m] = time.split(":").map(Number); return h! * 60 + m!; }
function localInstant(date: string, minute: number, timezone: string): number {
  const target = new Date(`${date}T00:00:00Z`).getTime() + minute * 60000;
  let candidate = target;
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  for (let i = 0; i < 3; i++) {
    const p = Object.fromEntries(formatter.formatToParts(candidate).map(p => [p.type, p.value]));
    const observed = Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:00Z`);
    if (observed === target) return candidate;
    candidate += target - observed;
  }
  throw new ReceptionError(503, "Cannot resolve working time across daylight saving change.");
}
export function calculateSlots(date: string, timezone: string, duration: number, hours: Row, specialists: Row[], appointments: Row[], now = Date.now()): Row[] {
  const day = DAY_KEYS[new Date(`${date}T12:00:00Z`).getUTCDay()]!;
  const business = windows(hours, day);
  const slots: Row[] = [];
  if (!business.length) return slots;
  for (const specialist of specialists) {
    const shifts = windows(specialist.working_schedule, day);
    const periods = specialist.unavailable_periods;
    if (!Array.isArray(periods) || periods.some(p => !p || !Number.isFinite(Date.parse(p.starts_at)) || !Number.isFinite(Date.parse(p.ends_at)) || Date.parse(p.ends_at) <= Date.parse(p.starts_at))) throw new ReceptionError(503, "Structured specialist unavailable periods required.");
    for (let minute = 0; minute + duration < 1440; minute += 15) {
      if (!business.some(w => minute >= minutes(w.start) && minute + duration <= minutes(w.end)) || !shifts.some(w => minute >= minutes(w.start) && minute + duration <= minutes(w.end))) continue;
      const start = localInstant(date, minute, timezone);
      const end = start + duration * 60000;
      if (start <= now) continue;
      const conflicts = [...periods, ...appointments.filter(a => a.status !== "cancelled" && a.status !== "canceled" && (!a.specialist_id || a.specialist_id === specialist.id))];
      if (conflicts.some(a => Date.parse(a.starts_at) < end && Date.parse(a.ends_at) > start)) continue;
      slots.push({ specialist_id: specialist.id, specialist_name: specialist.name, starts_at: new Date(start).toISOString(), ends_at: new Date(end).toISOString() });
    }
  }
  return slots.sort((a, b) => a.starts_at.localeCompare(b.starts_at));
}
