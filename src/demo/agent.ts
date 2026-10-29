/** Deterministic, clearly-simulated AI receptionist. It collects details, checks real demo stock and schedules, then books. It never orders parts. */
import { MAKE_ALIASES, VEHICLES } from "./catalog.js";
import {
  ValidationError, REPAIR_TYPES, WEEKDAY_NAMES, addBusinessDays, addDays, checkParts, estimateJob, findSlots, fromMin, localDate, mechanicById,
  parseDate, prettyDate, repairType, slotProblem, sourcingOptions, toMin, weekday, type FoundSlot, type RepairType, PART_KINDS, LABOR_RATE, SHOP_NAME, HOURS_TEXT,
} from "./rules.js";
import { OPEN_JOB_STATUSES } from "./rules.js";
import {
  cancelBooking, createBooking, createCustomer, createTask, createVehicle, customerOf, findCustomerByPhone, normPhone, openRequestOf, vehicleOf,
} from "./ops.js";
import { jobPartChecks, nextId } from "./sourcing.js";
import { SYMPTOM_PATTERNS, assessment, money } from "./texts.js";
import type {
  AgentPlan, AgentSession, AgentStep, Call, DemoState, Job, PartCheck, SlotOption, TranscriptLine, Vehicle,
} from "./types.js";

export const SIM_NOTICE = "Simulated demo call — no real phone call took place and no real message was sent.";

const STEP_DEFS: [string, string][] = [
  ["receive", "Receive call"], ["customer", "Identify customer"], ["vehicle", "Collect vehicle details"], ["issue", "Understand the problem"],
  ["history", "Check customer history"], ["inspection", "Inspection or repair?"], ["inventory", "Check inventory (incl. reserved stock)"],
  ["sourcing", "Prepare sourcing request"], ["schedule", "Check mechanic schedules"], ["offer", "Offer appointment options"],
  ["confirm", "Customer picks a time"], ["save", "Save booking & link records"], ["tasks", "Create follow-up tasks"], ["summary", "Summary in dashboard & call history"],
];

export interface ScenarioDef { id: string; title: string; description: string; callerId: string; script: string[] }

export function scenarioList(state: DemoState, now: Date): ScenarioDef[] {
  const ref = state.scenarioRefs;
  const phoneOf = (id?: string): string => state.customers.find((c) => c.id === id)?.phone ?? "+1 555-0199";
  const conflict = ref.conflictDate ? WEEKDAY_NAMES[weekday(ref.conflictDate)] : "Friday";
  void now;
  return [
    { id: "A", title: "A · Parts in stock", description: "Existing customer books an oil & filter change. All supplies are in stock, so the AI books the first free slot.",
      callerId: phoneOf(ref.A), script: ["Hi, I'd like to book an oil and filter change.", "Option 1 please."] },
    { id: "B", title: "B · Brake noise, part missing", description: "Reported grinding noise: the AI books an inspection (not a diagnosis), finds the front discs out of stock, drafts a sourcing request and proposes a repair slot after delivery.",
      callerId: phoneOf(ref.B), script: ["Hi, my 2018 BMW 320d makes a grinding noise when I brake.", "It started about a week ago, mostly at low speed.", "Option 1 please."] },
    { id: "C", title: "C · Schedule conflict", description: `Customer asks for ${conflict} at 10:00, when every mechanic is busy. The AI offers alternatives and books only after a choice.`,
      callerId: phoneOf(ref.C), script: [`I need an oil and filter change for my Golf on ${conflict} at 10:00.`, "The second one works for me."] },
    { id: "D", title: "D · Several parts missing", description: "Timing belt job: each part is checked separately against stock minus reservations; the AI builds one consolidated list with a total and flags uncertainty.",
      callerId: phoneOf(ref.D), script: ["Hi, I need the timing belt and water pump replaced on my Ford Focus.", "Option 1 is fine."] },
    { id: "E", title: "E · Returning customer follow-up", description: "Existing customer asks about an open brake job. The AI reports the recorded status and books a follow-up check.",
      callerId: phoneOf(ref.E), script: ["Hi, I'm calling about my brakes. Is the car ready yet?", "Yes please, a quick follow-up check would be great.", "Option 1 works."] },
  ];
}

// ----------------------------------------------------------------------------- text parsing

const MONTH_DAY = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\b/i;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

export function parseDateText(text: string, now: Date): string | undefined {
  const t = text.toLowerCase();
  const today = localDate(now);
  const iso = /\b(\d{4}-\d{2}-\d{2})\b/.exec(t);
  if (iso) { try { parseDate(iso[1]!); return iso[1]; } catch { return undefined; } }
  const md = MONTH_DAY.exec(text);
  if (md) {
    const month = MONTHS.indexOf(md[1]!.toLowerCase());
    let year = now.getFullYear();
    let d = `${year}-${String(month + 1).padStart(2, "0")}-${md[2]!.padStart(2, "0")}`;
    try { parseDate(d); } catch { return undefined; }
    if (d < today) { year++; d = `${year}-${String(month + 1).padStart(2, "0")}-${md[2]!.padStart(2, "0")}`; }
    return d;
  }
  if (/\bday after tomorrow\b/.test(t)) return addDays(today, 2);
  if (/\btomorrow\b/.test(t)) return addDays(today, 1);
  if (/\b(today|this morning|this afternoon)\b/.test(t)) return today;
  if (/\bnext week\b/.test(t)) return addDays(today, 7);
  for (let i = 0; i < 7; i++) {
    if (new RegExp(`\\b${WEEKDAY_NAMES[i]!.toLowerCase()}\\b`).test(t)) {
      for (let n = 1; n <= 7; n++) if (weekday(addDays(today, n)) === i) return addDays(today, n);
    }
  }
  return undefined;
}

export function parseTimeText(text: string): { minutes?: number; part?: "morning" | "afternoon" } {
  const t = text.toLowerCase();
  let m = /\b(\d{1,2}):(\d{2})\s*(am|pm)?\b/.exec(t);
  if (m) {
    let h = Number(m[1]);
    if (m[3] === "pm" && h < 12) h += 12;
    if (m[3] === "am" && h === 12) h = 0;
    if (h < 24 && Number(m[2]) < 60) return { minutes: h * 60 + Number(m[2]) };
  }
  m = /\b(\d{1,2})\s*(am|pm)\b/.exec(t);
  if (m) { let h = Number(m[1]); if (m[2] === "pm" && h < 12) h += 12; if (m[2] === "am" && h === 12) h = 0; if (h < 24) return { minutes: h * 60 }; }
  m = /\bat (\d{1,2})\b(?!\s*(?:km|miles|k\b))/.exec(t);
  if (m) { let h = Number(m[1]); if (h >= 1 && h <= 7) h += 12; if (h >= 8 && h <= 17) return { minutes: h * 60 }; }
  if (/\bmorning\b/.test(t)) return { part: "morning" };
  if (/\bafternoon\b/.test(t)) return { part: "afternoon" };
  return {};
}

function parsePick(text: string, count: number): number | undefined {
  const t = text.toLowerCase().trim();
  let m = /\boption\s*#?\s*(\d)\b/.exec(t) ?? /^\s*#?(\d)\s*[.)!]?\s*$/.exec(t);
  if (m) { const n = Number(m[1]); return n >= 1 && n <= count ? n - 1 : undefined; }
  if (/\b(first|1st|the one)\b/.test(t)) return 0;
  if (/\b(second|2nd)\b/.test(t)) return count >= 2 ? 1 : undefined;
  if (/\b(third|3rd)\b/.test(t)) return count >= 3 ? 2 : undefined;
  if (count === 1 && isYes(t)) return 0;
  if (isYes(t) && !/\b(no|not)\b/.test(t)) return 0;
  return undefined;
}
const isYes = (t: string): boolean => /\b(yes|yeah|yep|sure|ok|okay|fine|works|perfect|great|please do|book it|go ahead|sounds good|that works)\b/i.test(t);
const isNo = (t: string): boolean => /\b(no|nope|not now|no thanks|don'?t|skip|cancel|never mind)\b/i.test(t);

export function matchVehicleText(text: string): { make?: string; model?: string; year?: number; reg?: string } {
  const lower = ` ${text.toLowerCase().replace(/[.,!?]/g, " ")} `;
  const out: { make?: string; model?: string; year?: number; reg?: string } = {};
  const y = /\b(19[89]\d|20[0-2]\d)\b/.exec(text);
  if (y) out.year = Number(y[1]);
  const reg = /\b(DEMO-[A-Z]{2}\d{3})\b/i.exec(text);
  if (reg) out.reg = reg[1]!.toUpperCase();
  let best = 0;
  for (const v of VEHICLES) {
    for (const alias of [v.model.toLowerCase(), ...v.aliases]) {
      if (lower.includes(` ${alias} `) && alias.length > best) { best = alias.length; out.make = v.make; out.model = v.model; }
    }
  }
  if (!out.make) {
    for (const [alias, make] of Object.entries(MAKE_ALIASES)) if (lower.includes(` ${alias} `)) { out.make = make; break; }
  }
  return out;
}

const NAME_WORDS = /^(?:my name is|this is|it'?s|i am|i'm|name'?s|call me)\s+/i;
function parseName(text: string): string | undefined {
  const m = /(?:my name is|this is|i am|i'm|it'?s|name'?s|call me)\s+([A-Za-z][A-Za-z'’-]+(?:\s+[A-Za-z][A-Za-z'’-]+){0,2})/i.exec(text);
  const cand = (m ? m[1]! : text.replace(NAME_WORDS, "")).trim().replace(/[.!,]+$/, "");
  const words = cand.split(/\s+/);
  const stop = new Set(["calling", "looking", "need", "want", "would", "have", "got", "just", "here", "with", "about", "the", "a", "an", "and", "my", "its", "in", "on", "at"]);
  if (words.length < 1 || words.length > 3 || words.some((w) => stop.has(w.toLowerCase()) || !/^[A-Za-z][A-Za-z'’-]*$/.test(w))) return undefined;
  return words.map((w) => w[0]!.toUpperCase() + w.slice(1)).join(" ");
}
function parsePhone(text: string): string | undefined {
  const m = /(\+?\d[\d\s().-]{6,}\d)/.exec(text);
  return m ? m[1]!.trim() : undefined;
}

const FOLLOW_UP = /\b(is (it|the car|my car) ready|status|update on|any news|progress|how is (it|my)|calling about my|checking on|when will (it|my)|follow(?:ing)? up|already (booked|dropped)|still waiting|waiting for (the )?parts?)\b/i;
const UNSURE = /\b(not sure|unsure|don'?t know|do not know|maybe|i think|i guess|might (be)?|could be|no idea|something wrong|something'?s wrong|probably)\b/i;

// --------------------------------------------------------------------------- classification

interface Classified { first: RepairType; likely?: RepairType; symptoms: string[]; inspectionReason?: string }

const SKILL_INSPECTION: Record<string, string> = { brakes: "brake_inspection", suspension: "suspension_inspection", electrical: "diagnostic", engine: "diagnostic", service: "general_inspection" };

export function classify(issue: string): Classified | undefined {
  const lower = issue.toLowerCase();
  const symptoms = SYMPTOM_PATTERNS.filter(([re]) => re.test(issue)).map(([, s]) => s);
  const unsure = UNSURE.test(issue);
  let best: RepairType | undefined;
  let bestLen = 0;
  for (const rt of REPAIR_TYPES) {
    for (const k of rt.keywords) {
      if (lower.includes(k) && k.length > bestLen) { best = rt; bestLen = k.length; }
    }
  }
  if (best && best.id === "general_inspection" && /brake/.test(lower)) best = undefined;
  if (best) {
    if (best.kind === "repair" && unsure) {
      const first = repairType(SKILL_INSPECTION[best.skill] ?? "general_inspection");
      return { first, likely: best, symptoms, inspectionReason: "You weren't certain what the fault is, so the right first step is an inspection." };
    }
    return { first: best, symptoms };
  }
  const brake = /\b(brake|braking|brakes|pedal)\b/.test(lower);
  if (brake) {
    const likely = /grind|squeal|squeak|vibrat|scrap/.test(lower) ? repairType("brake_service_front") : undefined;
    return { first: repairType("brake_inspection"), likely, symptoms, inspectionReason: "Brake symptoms must be inspected by a mechanic before any repair is recommended." };
  }
  if (/clunk|knock|bumps|bounc|rattle|hum(ming)?/.test(lower)) return { first: repairType("suspension_inspection"), symptoms, inspectionReason: "A noise like that can have several causes; a mechanic needs to look at the car." };
  if (/warning light|check engine|engine light|dashboard|limp/.test(lower)) return { first: repairType("diagnostic"), symptoms, inspectionReason: "A warning light needs a diagnostic scan before anything can be said about the cause." };
  if (/won'?t start|struggl\w* to start|hard to start|starts? slowly|flat battery/.test(lower)) return { first: repairType("diagnostic"), likely: repairType("battery"), symptoms, inspectionReason: "Starting problems have several possible causes; the scan and a battery test come first." };
  if (/misfir|rough idle|stall|overheat|leak|smoke|smell|vibrat|shak|noise|noisy|sound/.test(lower)) return { first: repairType("general_inspection"), symptoms, inspectionReason: "I can't tell the cause from a call, so a mechanic should inspect it." };
  return undefined;
}

// ------------------------------------------------------------------------------- session ops

function step(s: AgentSession, id: string, status: AgentStep["status"], detail: string): void {
  const st = s.steps.find((x) => x.id === id);
  if (st) { st.status = status; st.detail = detail; }
}
function say(s: AgentSession, text: string): void { s.transcript.push({ role: "ai", text }); }
const hhmm = (d: Date): string => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

export function startSession(state: DemoState, body: { scenario?: string; callerId?: string }, now: Date): AgentSession {
  const callerId = typeof body.callerId === "string" ? body.callerId.trim().slice(0, 24) : "";
  const session: AgentSession = {
    id: nextId(state, "session"), createdAt: now.toISOString(), scenario: body.scenario, stage: "collecting", input: {}, steps: STEP_DEFS.map(([id, label]) => ({ id, label, status: "pending", detail: "" })),
    transcript: [], options: [], simulatedNotice: SIM_NOTICE,
  };
  if (callerId) {
    if (!/^[+\d][\d\s().-]{5,}$/.test(callerId)) throw new ValidationError("Caller number looks invalid.");
    session.input.phone = callerId;
  }
  const known = session.input.phone ? findCustomerByPhone(state, session.input.phone) : undefined;
  step(session, "receive", "done", `Simulated incoming call${session.input.phone ? ` from ${session.input.phone}` : " (caller ID withheld)"} at ${hhmm(now)}.`);
  session.transcript.push({ role: "system", text: SIM_NOTICE });
  if (known) {
    session.customerId = known.id;
    session.input.name = known.name;
    step(session, "customer", "done", `Recognised returning customer ${known.name} (${known.id}) from the caller number.`);
    say(session, `Thank you for calling ${SHOP_NAME}, this is the virtual receptionist. Welcome back, ${known.name.split(" ")[0]}! How can I help?`);
  } else {
    step(session, "customer", "info", session.input.phone ? "New caller — number not on file." : "Caller ID not available.");
    say(session, `Thank you for calling ${SHOP_NAME}, this is the virtual receptionist. How can I help?`);
  }
  session.awaiting = "issue";
  state.sessions.push(session);
  if (state.sessions.length > 40) state.sessions.splice(0, state.sessions.length - 40);
  return session;
}

function vehiclesOf(state: DemoState, customerId?: string): Vehicle[] {
  return customerId ? state.vehicles.filter((v) => v.customerId === customerId) : [];
}
const vlabel = (v: { year?: number; make?: string; model?: string }): string => [v.year, v.make, v.model].filter(Boolean).join(" ");
const first = (n?: string): string => (n ?? "").split(" ")[0] ?? "";

function openJobsOf(state: DemoState, customerId: string): Job[] {
  return state.jobs.filter((j) => j.customerId === customerId && (OPEN_JOB_STATUSES as readonly string[]).includes(j.status));
}

export const JOB_STATUS_TEXT: Record<string, string> = {
  requested: "requested", pending_inspection: "waiting for inspection", awaiting_parts: "waiting for parts", scheduled: "scheduled",
  in_progress: "in progress", ready: "ready for repair", completed: "completed", cancelled: "cancelled",
};
export const REQUEST_STATUS_TEXT: Record<string, string> = {
  awaiting_verification: "awaiting inventory verification", parts_required: "parts required", awaiting_price_confirmation: "awaiting price confirmation",
  awaiting_approval: "awaiting the owner's approval", approved: "approved for manual ordering (not ordered yet)", ordered: "ordered by the workshop",
  received: "received", ready_for_repair: "all parts received", completed: "completed", cancelled: "cancelled",
};

export function handleMessage(state: DemoState, id: string, textRaw: unknown, now: Date): AgentSession {
  const s = state.sessions.find((x) => x.id === id);
  if (!s) throw new ValidationError("Session not found.", 404);
  if (s.stage === "confirmed" || s.stage === "ended") throw new ValidationError("This call has ended. Start a new simulated call.", 409);
  const text = typeof textRaw === "string" ? textRaw.trim() : "";
  if (!text) throw new ValidationError("Please type what the customer says.");
  if (text.length > 600) throw new ValidationError("Message is too long (max 600 characters).");
  s.transcript.push({ role: "customer", text });
  const lower = text.toLowerCase();

  // ---- picking an offered option
  if (s.stage === "offering" && s.options.length) {
    const wantsNewTime = parseDateText(text, now) || parseTimeText(text).minutes !== undefined;
    const pick = parsePick(text, s.options.length);
    if (pick !== undefined && !(wantsNewTime && pick === undefined)) return confirm(state, s, pick, now);
    if (isNo(lower) && !wantsNewTime) {
      s.stage = "ended"; step(s, "confirm", "warn", "Customer declined all offered times — nothing booked.");
      say(s, "No problem. I haven't booked anything. Feel free to call back whenever suits you. Goodbye!");
      finishDeclined(state, s, now);
      return s;
    }
    if (wantsNewTime) {
      absorb(state, s, text, now, true);
      return plan(state, s, now);
    }
    say(s, `Sorry, I didn't catch which option you'd like. Please say "option 1", "option 2"${s.options.length > 2 ? ' or "option 3"' : ""}, or give me another day or time.`);
    return s;
  }

  absorb(state, s, text, now, false);
  if (s.awaiting === "followup_offer") return followUpOffer(state, s, text, now);
  return advance(state, s, now);
}

/** Pulls whatever the customer said into the structured input. */
function absorb(state: DemoState, s: AgentSession, text: string, now: Date, timeOnly: boolean): void {
  const d = parseDateText(text, now);
  const t = parseTimeText(text);
  if (d) s.input.preferredDate = d;
  if (t.minutes !== undefined) s.input.preferredTime = fromMin(t.minutes);
  else if (t.part) s.input.preferredTime = t.part === "morning" ? "09:00" : "14:00";
  if (timeOnly) return;
  const phone = parsePhone(text);
  if (phone && s.awaiting === "phone") s.input.phone = phone;
  else if (phone && !s.input.phone && /\b(\+?\d[\d\s().-]{8,})\b/.test(text) && !/\b\d{4}-\d{2}-\d{2}\b/.test(text)) s.input.phone = phone;
  const veh = matchVehicleText(text);
  if (veh.make && !s.vehicleId) { s.input.make = veh.make; if (veh.model) s.input.model = veh.model; }
  if (veh.year && !s.vehicleId) s.input.year = veh.year;
  if (veh.reg) s.input.reg = veh.reg;

  switch (s.awaiting) {
    case "issue": {
      s.input.issue = s.input.issue ? `${s.input.issue} ${text}` : text;
      if (!s.intent) s.intent = FOLLOW_UP.test(text) ? "follow_up" : "new";
      break;
    }
    case "symptoms": s.input.issue = `${s.input.issue ?? ""} ${text}`.trim(); break;
    case "name": {
      const name = parseName(text);
      if (name) s.input.name = name;
      break;
    }
    case "vehicle": {
      const cust = vehiclesOf(state, s.customerId);
      const pickIdx = /\b([1-9])\b/.exec(text);
      if (cust.length > 1) {
        const byText = cust.find((v) => text.toLowerCase().includes(v.model.toLowerCase()) || text.toLowerCase().includes(v.make.toLowerCase()) || text.toUpperCase().includes(v.reg));
        const chosen = byText ?? (pickIdx ? cust[Number(pickIdx[1]) - 1] : undefined);
        if (chosen) { s.vehicleId = chosen.id; break; }
      }
      if (!s.input.make) {
        const words = text.replace(/[.,!?]/g, " ").split(/\s+/).filter((w) => w && !/^\d{4}$/.test(w) && !/^(it'?s|its|a|an|the|my|is|i|have|drive)$/i.test(w));
        if (words.length >= 2) { s.input.make = words[0]![0]!.toUpperCase() + words[0]!.slice(1); s.input.model = words.slice(1).join(" "); }
      }
      break;
    }
    default: break;
  }
  if (!s.intent && s.input.issue) s.intent = FOLLOW_UP.test(s.input.issue) ? "follow_up" : "new";
  if (s.input.issue && FOLLOW_UP.test(text) && s.customerId && openJobsOf(state, s.customerId).length) s.intent = "follow_up";
}

function advance(state: DemoState, s: AgentSession, now: Date): AgentSession {
  const input = s.input;
  // ---------------------------------------------------------------- returning customer asking about a job
  if (s.intent === "follow_up" && s.customerId) return followUpStatus(state, s, now);

  if (!input.issue) { s.awaiting = "issue"; say(s, "Could you tell me what the car needs, or what's happening with it?"); return s; }
  step(s, "issue", "done", `Customer says: "${input.issue.slice(0, 120)}"`);

  // ---------------------------------------------------------------- ask about unknown classification once
  const cls = classify(input.issue);
  const symptomaticNoDetail = cls && cls.first.kind === "inspection" && s.awaiting === "issue" && !s.asked?.includes("symptoms")
    && input.issue.split(/\s+/).length < 22 && !/\b(week|day|month|always|sometimes|every time|only when|low speed|high speed|cold start|at speed|motorway|highway)\b/i.test(input.issue);
  if (!cls) {
    if (!s.asked?.includes("issue")) {
      (s.asked ??= []).push("issue");
      s.awaiting = "issue";
      say(s, "I want to get this right — could you describe the problem or the service you'd like (for example an oil change, a noise when braking, or a warning light)?");
      return s;
    }
  }
  if (cls && symptomaticNoDetail && cls.symptoms.length) {
    (s.asked ??= []).push("symptoms");
    s.awaiting = "symptoms";
    say(s, `Thanks. To help the mechanic, when did you first notice it, and does it happen every time or only in certain conditions (e.g. low speed, cold start)?`);
    step(s, "issue", "info", `Symptoms recorded: ${cls.symptoms.join(", ")}. Asked a follow-up question.`);
    return s;
  }

  // ---------------------------------------------------------------- name
  if (!input.name) {
    s.awaiting = "name";
    if (s.asked?.includes("name") && !parseName(s.transcript[s.transcript.length - 1]?.text ?? "")) say(s, "Sorry, I didn't catch that. Could I have your first and last name?");
    else say(s, "Could I take your name, please?");
    (s.asked ??= []).push("name");
    return s;
  }
  // ---------------------------------------------------------------- phone
  if (!input.phone) {
    s.awaiting = "phone";
    if (s.asked?.includes("phone")) say(s, "That number doesn't look right. Please give me a phone number with at least 7 digits.");
    else say(s, `Thanks, ${first(input.name)}. What's the best phone number to reach you on?`);
    (s.asked ??= []).push("phone");
    return s;
  }
  const digits = normPhone(input.phone);
  if (digits.length < 7 || digits.length > 15) { delete input.phone; return advance(state, s, now); }

  if (!s.customerId) {
    const known = findCustomerByPhone(state, input.phone);
    if (known) { s.customerId = known.id; step(s, "customer", "done", `Matched existing customer ${known.name} (${known.id}) by phone number.`); }
    else step(s, "customer", "info", `New customer ${input.name} — a record will be created when the booking is confirmed.`);
  }
  // ---------------------------------------------------------------- vehicle
  const own = vehiclesOf(state, s.customerId);
  if (!s.vehicleId && own.length) {
    const mention = input.make ? own.find((v) => v.make === input.make && (!input.model || v.model === input.model) && (!input.year || v.year === input.year)) : undefined;
    if (mention) s.vehicleId = mention.id;
    else if (own.length === 1 && !input.make) s.vehicleId = own[0]!.id;
    else if (!input.make) {
      s.awaiting = "vehicle";
      say(s, `Which vehicle is it? I have on file: ${own.map((v, i) => `${i + 1}) ${vlabel(v)} (${v.reg})`).join("; ")}.`);
      return s;
    }
  }
  if (!s.vehicleId && !(input.make && input.model && input.year)) {
    s.awaiting = "vehicle";
    const missing = [!input.make || !input.model ? "make and model" : "", !input.year ? "year" : ""].filter(Boolean).join(" and ");
    say(s, s.asked?.includes("vehicle") ? `I still need the vehicle's ${missing}. For example "2017 Ford Focus".` : `Which vehicle is it? Please tell me the ${missing}.`);
    (s.asked ??= []).push("vehicle");
    return s;
  }
  const vehicle: Pick<Vehicle, "make" | "model" | "year"> & { fuel?: string } = s.vehicleId ? vehicleOf(state, s.vehicleId) : { make: input.make!, model: input.model!, year: input.year! };
  step(s, "vehicle", "done", `${vlabel(vehicle)}${s.vehicleId ? ` (${vehicleOf(state, s.vehicleId).reg}, on file)` : " — new vehicle to be added"}.`);
  return plan(state, s, now);
}

// --------------------------------------------------------------------------------- planning

function vehicleForPlan(state: DemoState, s: AgentSession): Vehicle {
  if (s.vehicleId) return vehicleOf(state, s.vehicleId);
  return { id: "NEW", customerId: s.customerId ?? "NEW", make: s.input.make!, model: s.input.model!, year: s.input.year!, reg: s.input.reg ?? "TBC", engine: "", fuel: "", mileage: 0 };
}

function plan(state: DemoState, s: AgentSession, now: Date): AgentSession {
  const input = s.input;
  const vehicle = vehicleForPlan(state, s);
  const cls = classify(input.issue ?? "") ?? { first: repairType("general_inspection"), symptoms: [], inspectionReason: "I couldn't match that to a specific service, so a general inspection is the safest first step." };
  const today = localDate(now);

  // history
  let historyNote = "New customer — no history.";
  if (s.customerId) {
    const jobs = state.jobs.filter((j) => j.customerId === s.customerId);
    const done = jobs.filter((j) => j.status === "completed").length;
    const open = openJobsOf(state, s.customerId);
    historyNote = `${jobs.length} job(s) on record: ${done} completed, ${open.length} open${open.length ? ` (${open.map((j) => `${j.id} ${j.title}`).join(", ")})` : ""}.`;
    const same = open.find((j) => j.vehicleId === s.vehicleId && j.repairType === cls.first.id);
    if (same) {
      step(s, "history", "warn", historyNote);
      step(s, "inspection", "warn", "Duplicate avoided.");
      s.awaiting = "followup_offer";
      s.intent = "follow_up";
      say(s, `I can see you already have job ${same.id} (${same.title}) open for this vehicle, so I won't create a duplicate. ${jobStatusSentence(state, same)} Would you like me to book a quick follow-up check instead?`);
      return s;
    }
  }
  step(s, "history", s.customerId ? "done" : "info", historyNote);

  // inspection vs repair
  const bookKind = cls.first.kind;
  const inspectionFirst = bookKind === "inspection";
  step(s, "inspection", inspectionFirst ? "warn" : "done",
    inspectionFirst ? `Inspection needed first — ${cls.inspectionReason ?? "cause not confirmed"}` : `Straightforward ${bookKind}: "${cls.first.name}". Provisional scope; the mechanic confirms on arrival.`);

  // inventory
  const mainChecks = checkParts(state, vehicle, cls.first.parts);
  const likelyChecks = cls.likely ? checkParts(state, vehicle, cls.likely.parts) : [];
  const relevant = cls.likely ? likelyChecks : mainChecks;
  const missing = relevant.filter((c) => c.shortfall > 0);
  const unsure = relevant.filter((c) => c.compat === "uncertain" && c.shortfall === 0);
  step(s, "inventory", relevant.length ? (missing.length || unsure.length ? "warn" : "done") : "info",
    relevant.length
      ? relevant.map((c) => `${c.qty}× ${c.description}: ${c.available} available${c.reserved ? ` (${c.stock} on hand, ${c.reserved} reserved)` : ""}${c.shortfall ? ` → ${c.shortfall} short` : " ✓"}${c.compat === "uncertain" && c.partId ? " — fitment unverified" : ""}`).join(" | ")
      : "No parts needed for this visit.");

  // sourcing
  let eta: string | undefined;
  let sourcingCost = 0;
  if (missing.length) {
    const lead = Math.max(...missing.map((m) => sourcingOptions(m.kind, vehicle)[0]!.leadDays));
    eta = addBusinessDays(today, lead);
    sourcingCost = missing.reduce((t, m) => t + sourcingOptions(m.kind, vehicle)[0]!.unitPrice * m.shortfall, 0);
    step(s, "sourcing", "warn", `${missing.map((m) => `${m.shortfall}× ${m.description}`).join(", ")}. Simulated demo quote ≈ ${money(Math.round(sourcingCost * 100) / 100)}, earliest simulated delivery ${prettyDate(eta)}. Nothing is ordered.`);
  } else step(s, "sourcing", "info", "Nothing to source.");

  const rtFinal = cls.likely ?? cls.first;
  const estimate = estimateJob(state, vehicle, cls.first.hours, mainChecks);
  const likelyEstimate = cls.likely ? estimateJob(state, vehicle, cls.likely.hours, likelyChecks) : undefined;
  const p: AgentPlan = {
    intent: inspectionFirst ? "inspection" : bookKind === "repair" ? "repair" : "service", repairType: cls.first.id, likelyRepairType: cls.likely?.id,
    symptoms: cls.symptoms, issueText: input.issue ?? "", parts: relevant, missing, etaDate: eta, estimate: likelyEstimate && inspectionFirst ? estimate : estimate,
    inspectionFee: inspectionFirst ? estimate : undefined, laborHours: cls.first.hours, assessment: assessment(cls.first.id, input.issue ?? ""),
  };
  if (cls.likely) p.assessment += ` A possible repair (${cls.likely.name}, est. ${money(likelyEstimate ?? 0)}) has been pre-checked against stock, but it is NOT a diagnosis and only proceeds if the inspection supports it.`;
  s.plan = p;

  // scheduling
  const options = buildOptions(state, s, cls, eta, now);
  s.options = options;
  step(s, "schedule", options.length ? "done" : "warn", options.length ? `${options.length} free slot option(s) found around the mechanics' existing bookings.` : "No free slots found in the next 30 days.");
  if (!options.length) {
    say(s, "I'm sorry — I couldn't find a free appointment in the next month. I'll flag this for the workshop to call you back.");
    s.stage = "ended";
    finishDeclined(state, s, now, "No availability found");
    return s;
  }

  const lines: string[] = [];
  lines.push(`Thanks, ${first(input.name)}. Here's what I've noted for the ${vlabel(vehicle)}:`);
  if (cls.symptoms.length) lines.push(`• You reported: ${cls.symptoms.join(", ")}.`);
  if (inspectionFirst) lines.push(`• I can't confirm what's causing it from a call — ${cls.inspectionReason ?? "a mechanic needs to inspect it"} I'll book an inspection (${cls.first.durationMin} min, about ${money(estimate)}).`);
  else lines.push(`• Service: ${cls.first.name}, about ${cls.first.hours} h labour. Estimate ${money(estimate)} (final price confirmed by the mechanic).`);
  if (relevant.length) {
    const label = cls.likely ? `If the inspection leads to "${cls.likely.name}", the stock position today is` : "Stock check";
    lines.push(`• ${label}: ${relevant.map((c) => `${c.description} — ${c.shortfall ? `${c.available} available, ${c.shortfall} missing` : "available"}`).join("; ")}.`);
    if (missing.length) lines.push(`• Missing parts: I'll add ${missing.map((m) => m.description).join(", ")} to a parts request for the owner to review (simulated demo quote ≈ ${money(Math.round(sourcingCost * 100) / 100)}, earliest simulated delivery ${prettyDate(eta!)}). I can't order anything myself.`);
    else lines.push("• The workshop can proceed without buying anything extra.");
    if (unsure.length) lines.push(`• Fitment for ${unsure.map((u) => u.description).join(", ")} isn't verified in our records, so a mechanic will double-check it.`);
  }
  if (rtFinal !== cls.first && missing.length && eta) lines.push(`• I've proposed the repair slot after the expected delivery (${prettyDate(eta)}), pending the inspection result.`);
  if (p.conflictNote) lines.push(`• ${p.conflictNote}`);
  lines.push(`Here are your options:\n${options.map((o, i) => `  ${i + 1}) ${o.label}${o.note ? ` — ${o.note}` : ""}`).join("\n")}\nWhich would you like?`);
  step(s, "offer", "done", options.map((o) => o.label).join(" | "));
  say(s, lines.join("\n"));
  s.stage = "offering";
  s.awaiting = "pick";
  return s;
}

function jobStatusSentence(state: DemoState, job: Job): string {
  const bookings = state.bookings.filter((b) => b.jobId === job.id && (b.status === "confirmed" || b.status === "pending"));
  const bk = bookings[0];
  const req = openRequestOf(state, job.id);
  const parts: string[] = [`Job ${job.id} (${job.title}) is ${JOB_STATUS_TEXT[job.status] ?? job.status}.`];
  if (bk) parts.push(`It's booked for ${prettyDate(bk.date)} at ${bk.start} with ${mechanicById(state, bk.mechanicId).name} (${bk.status === "pending" ? "awaiting confirmation" : "confirmed"}).`);
  if (req) {
    const missing = req.lines.filter((l) => l.shortfall > 0 && !l.received);
    parts.push(`Parts request ${req.id} is ${REQUEST_STATUS_TEXT[req.status] ?? req.status}${missing.length ? ` (${missing.map((l) => `${l.shortfall}× ${l.description}`).join(", ")})` : ""}.`);
    if (req.status === "ordered") parts.push("The workshop has recorded an order; the delivery date is an estimate until the supplier confirms it.");
    else if (req.status !== "received" && req.status !== "ready_for_repair") parts.push("Nothing has been ordered yet.");
  }
  return parts.join(" ");
}

function followUpStatus(state: DemoState, s: AgentSession, now: Date): AgentSession {
  step(s, "issue", "done", `Returning customer asks for a status update: "${(s.input.issue ?? "").slice(0, 100)}"`);
  const open = openJobsOf(state, s.customerId!);
  const customer = customerOf(state, s.customerId);
  const lower = (s.input.issue ?? "").toLowerCase();
  const pickJob = open.find((j) => lower.includes(j.title.toLowerCase().split(" ")[1] ?? "§") || (/brake/.test(lower) && /brake/i.test(j.title))
    || (/(oil|service)/.test(lower) && /oil/i.test(j.title)) || (/battery/.test(lower) && /battery/i.test(j.title))) ?? open.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (!pickJob) {
    step(s, "history", "warn", "No open job found for this customer.");
    say(s, `I can't see any open job for you, ${first(customer.name)}. Would you like to book a service or inspection?`);
    s.intent = "new"; s.awaiting = "issue"; s.input.issue = undefined;
    return s;
  }
  s.followUpJobId = pickJob.id;
  s.vehicleId = pickJob.vehicleId;
  const veh = vehicleOf(state, pickJob.vehicleId);
  step(s, "vehicle", "done", `${vlabel(veh)} (${veh.reg}).`);
  step(s, "history", "done", `Found open job ${pickJob.id} — ${pickJob.title} (${JOB_STATUS_TEXT[pickJob.status]}).`);
  const checks = jobPartChecks(state, pickJob);
  const short = checks.filter((c) => c.shortfall > 0);
  step(s, "inventory", short.length ? "warn" : "done", checks.length ? checks.map((c) => `${c.qty}× ${c.description}: ${c.shortfall ? `${c.shortfall} short` : "reserved ✓"}`).join(" | ") : "No parts needed.");
  step(s, "inspection", "info", "Status enquiry — recorded information only; no new diagnosis made.");
  say(s, `Welcome back, ${first(customer.name)}. I've found the ${vlabel(veh)}. ${jobStatusSentence(state, pickJob)}${short.length ? "" : " All parts for this job are reserved in stock."} That's the information on record — I can't promise anything beyond it. Would you like me to book a quick follow-up check so a mechanic can update you in person?`);
  s.awaiting = "followup_offer";
  void now;
  return s;
}

function followUpOffer(state: DemoState, s: AgentSession, text: string, now: Date): AgentSession {
  const lower = text.toLowerCase();
  if (isNo(lower) && !isYes(lower)) {
    s.stage = "ended"; say(s, "No problem. The recorded status is as I described. Thanks for calling, goodbye!");
    step(s, "confirm", "info", "Customer did not need a follow-up check.");
    finishInfoCall(state, s, now);
    return s;
  }
  if (!isYes(lower) && !/\b(book|schedule|follow|check|please|time)\b/.test(lower)) {
    say(s, "Would you like me to book a quick follow-up check? Please say yes or no.");
    return s;
  }
  const rt = repairType("follow_up_check");
  const vehicle = vehicleOf(state, s.vehicleId);
  const pref = prefs(s);
  const slots = chooseSlots(state, { rt, now, from: pref.date ?? localDate(now), prefMin: pref.min, strict: !!pref.date && !!pref.min });
  s.plan = {
    intent: "follow_up", repairType: rt.id, symptoms: [], issueText: s.input.issue ?? "", parts: [], missing: [], estimate: Math.round(rt.hours * LABOR_RATE * 0) , laborHours: rt.hours,
    assessment: "Follow-up on an existing job. No new fault reported; the mechanic will update the customer on the recorded status.",
  };
  s.options = slots.options;
  step(s, "schedule", slots.options.length ? "done" : "warn", `${slots.options.length} follow-up slot(s) found.`);
  if (!slots.options.length) { say(s, "I couldn't find a free slot — I'll ask the workshop to call you."); s.stage = "ended"; finishDeclined(state, s, now, "No availability found"); return s; }
  step(s, "offer", "done", slots.options.map((o) => o.label).join(" | "));
  say(s, `The follow-up check is free of charge and takes about ${rt.durationMin} minutes. Here are the options:\n${slots.options.map((o, i) => `  ${i + 1}) ${o.label}${o.note ? ` — ${o.note}` : ""}`).join("\n")}\nWhich would you like?`);
  s.stage = "offering"; s.awaiting = "pick";
  void vehicle;
  return s;
}

// ---------------------------------------------------------------------------------- slots

function prefs(s: AgentSession): { date?: string; min?: number } {
  return { date: s.input.preferredDate, min: s.input.preferredTime ? toMin(s.input.preferredTime) : undefined };
}

interface SlotArgs { rt: RepairType; now: Date; from: string; prefMin?: number; strict?: boolean; minDate?: string; avoid?: FoundSlot[] }

function chooseSlots(state: DemoState, a: SlotArgs): { options: SlotOption[]; conflict?: string } {
  const today = localDate(a.now);
  let from = a.from < today ? today : a.from;
  if (a.minDate && from < a.minDate) from = a.minDate;
  const startAfter = from === today ? Math.ceil((a.now.getHours() * 60 + a.now.getMinutes() + 60) / 30) * 30 : undefined;
  const all = findSlots(state, { from, days: 30, durationMin: a.rt.durationMin, now: a.now, skill: a.rt.skill, startAfter, avoid: a.avoid });
  let conflict: string | undefined;
  let ordered = all;
  if (a.prefMin !== undefined) {
    const exact = all.find((x) => x.date === from && toMin(x.start) === a.prefMin);
    if (!exact && !a.minDate) {
      const busy = state.mechanics.filter((m) => m.workDays.includes(weekday(from))).map((m) => ({ m, p: slotProblem(state, { mechanicId: m.id, date: from, start: fromMin(a.prefMin!), durationMin: a.rt.durationMin }, a.now) }));
      const closed = !state.mechanics.some((m) => m.workDays.includes(weekday(from))) || !all.length;
      conflict = closed ? undefined : `${prettyDate(from)} at ${fromMin(a.prefMin)} isn't available: ${busy.every((b) => b.p) ? "every mechanic is already booked or on break at that time" : "that time doesn't fit the schedule"}. These are the nearest alternatives.`;
    }
    ordered = [...all].sort((x, y) => {
      const dx = Math.abs(toMin(x.start) - a.prefMin!) + (x.date === from ? 0 : 1000 * Math.abs(daysBetween(from, x.date)));
      const dy = Math.abs(toMin(y.start) - a.prefMin!) + (y.date === from ? 0 : 1000 * Math.abs(daysBetween(from, y.date)));
      return dx - dy || (x.date + x.start).localeCompare(y.date + y.start);
    });
  }
  const picked: FoundSlot[] = [];
  const dateSeen = new Set<string>();
  for (const sl of ordered) {
    if (picked.length >= 3) break;
    if (a.prefMin === undefined) {
      if (picked.length === 0) { picked.push(sl); dateSeen.add(sl.date); continue; }
      if (!dateSeen.has(sl.date)) { picked.push(sl); dateSeen.add(sl.date); continue; }
    } else {
      const close = picked.some((p) => p.date === sl.date && Math.abs(toMin(p.start) - toMin(sl.start)) < 90);
      if (!close) picked.push(sl);
    }
  }
  if (picked.length < 3 && a.prefMin === undefined) {
    for (const sl of all) {
      if (picked.length >= 3) break;
      if (!picked.includes(sl) && picked.every((p) => p.date !== sl.date || Math.abs(toMin(p.start) - toMin(sl.start)) >= 120)) picked.push(sl);
    }
  }
  picked.sort((x, y) => (x.date + x.start).localeCompare(y.date + y.start));
  const options: SlotOption[] = picked.map((sl, i) => ({
    id: `o${i + 1}`, label: `${prettyDate(sl.date)} at ${sl.start} with ${mechanicById(state, sl.mechanicId).name}`,
    bookings: [{ kind: a.rt.kind, repairType: a.rt.id, date: sl.date, start: sl.start, durationMin: a.rt.durationMin, mechanicId: sl.mechanicId, status: "confirmed" }],
  }));
  return { options, conflict };
}
const daysBetween = (a: string, b: string): number => Math.round((parseDate(b).getTime() - parseDate(a).getTime()) / 86_400_000);

function buildOptions(state: DemoState, s: AgentSession, cls: Classified, eta: string | undefined, now: Date): SlotOption[] {
  const pref = prefs(s);
  const today = localDate(now);
  const needsParts = !!eta;
  if (cls.likely) {
    // inspection first, then provisional repair after the parts are expected
    const insp = chooseSlots(state, { rt: cls.first, now, from: pref.date ?? today, prefMin: pref.min });
    if (insp.conflict && s.plan) s.plan.conflictNote = insp.conflict;
    const options: SlotOption[] = [];
    for (const o of insp.options) {
      const b0 = o.bookings[0]!;
      const repairFrom = addDays(needsParts && eta! > b0.date ? addBusinessDays(eta!, 1) : addDays(b0.date, 1), 0);
      const rep = findSlots(state, { from: repairFrom, days: 30, durationMin: cls.likely.durationMin, now, skill: cls.likely.skill, limit: 1 })[0];
      if (!rep) { options.push(o); continue; }
      options.push({
        id: o.id,
        label: `Inspection ${prettyDate(b0.date)} at ${b0.start} (${mechanicById(state, b0.mechanicId).name}) → provisional repair ${prettyDate(rep.date)} at ${rep.start} (${mechanicById(state, rep.mechanicId).name})`,
        note: needsParts ? "repair slot follows the expected part delivery; confirmed only after the inspection" : "repair slot is provisional until the inspection result",
        bookings: [...o.bookings, { kind: cls.likely.kind, repairType: cls.likely.id, date: rep.date, start: rep.start, durationMin: cls.likely.durationMin, mechanicId: rep.mechanicId, status: "pending" }],
      });
    }
    return options;
  }
  const minDate = needsParts && cls.first.kind !== "inspection" ? addBusinessDays(eta!, 1) : undefined;
  const r = chooseSlots(state, { rt: cls.first, now, from: pref.date ?? today, prefMin: pref.min, minDate });
  if (r.conflict && s.plan) s.plan.conflictNote = r.conflict;
  if (minDate && s.plan) s.plan.conflictNote = `Because parts are missing, the earliest repair date is after the expected delivery (${prettyDate(eta!)}).`;
  return r.options.map((o) => ({ ...o, note: minDate ? "after expected part delivery" : o.note }));
}

// ------------------------------------------------------------------------------- confirmation

function confirm(state: DemoState, s: AgentSession, idx: number, now: Date): AgentSession {
  const option = s.options[idx];
  const p = s.plan;
  if (!option || !p) throw new ValidationError("That option is no longer available.", 409);
  step(s, "confirm", "done", `Customer chose: ${option.label}`);
  // ---- re-validate every slot right before writing (no await between check and write => no race)
  for (const b of option.bookings) {
    const problem = slotProblem(state, { mechanicId: b.mechanicId, date: b.date, start: b.start, durationMin: b.durationMin }, now);
    if (problem) {
      say(s, `I'm sorry, that time was just taken (${problem}) Let me find updated options.`);
      s.stage = "collecting";
      s.input.preferredDate = undefined; s.input.preferredTime = undefined;
      return s.intent === "follow_up" ? followUpOffer(state, s, "yes", now) : plan(state, s, now);
    }
  }
  const actions: string[] = [];
  // ---- customer & vehicle
  let customerId = s.customerId;
  let createdCustomer = false;
  if (!customerId) {
    const c = createCustomer(state, { name: s.input.name, phone: s.input.phone, email: "", notes: "Created by the simulated AI receptionist (demo)." }, now);
    customerId = c.id; s.customerId = c.id; createdCustomer = true;
    actions.push(`Created customer ${c.name} (${c.id})`);
  }
  let vehicleId = s.vehicleId;
  if (!vehicleId) {
    const reg = `TBC-${String(state.vehicles.length + 1).padStart(3, "0")}`;
    const v = createVehicle(state, { customerId, make: s.input.make, model: s.input.model, year: s.input.year, reg: s.input.reg ?? reg });
    vehicleId = v.id; s.vehicleId = v.id;
    actions.push(`Added vehicle ${vlabel(v)} (${v.id}) to ${customerId}`);
  }
  const customer = customerOf(state, customerId);
  const vehicle = vehicleOf(state, vehicleId);
  step(s, "customer", "done", `${createdCustomer ? "Created" : "Matched"} customer ${customer.name} (${customer.id}); vehicle ${vlabel(vehicle)} (${vehicle.id}).`);

  // ---- bookings (+ jobs, reservations, parts request)
  const callId = nextId(state, "call");
  const bookingIds: string[] = [];
  let primaryJob: string | undefined;
  let requestId: string | undefined;
  const issue = (s.input.issue ?? "").slice(0, 480);
  const knownRequests = new Set(state.requests.map((q) => q.id));
  let newRequest = false;
  for (const b of option.bookings) {
    const isLikely = b.repairType === p.likelyRepairType;
    const existingJobId = s.followUpJobId && s.intent === "follow_up" ? s.followUpJobId : undefined;
    const booking = createBooking(state, {
      customerId, vehicleId, repairType: b.repairType, date: b.date, start: b.start, durationMin: b.durationMin, mechanicId: b.mechanicId, jobId: existingJobId,
      reportedIssue: issue, status: b.status, source: "ai_call", callId,
      notes: isLikely ? "Provisional repair — proceed only if the inspection supports it." : b.repairType === "follow_up_check" ? "Follow-up check requested by the customer." : "",
      aiAssessment: isLikely ? `Possible repair, NOT a diagnosis. Customer-reported symptoms: ${p.symptoms.join(", ") || issue}. Confirm with the inspection before ordering or repairing.` : p.assessment,
    }, now);
    bookingIds.push(booking.id);
    primaryJob ??= booking.jobId;
    const job = state.jobs.find((j) => j.id === booking.jobId)!;
    if (!job.callId) job.callId = callId;
    const req = openRequestOf(state, job.id);
    if (req && !requestId) {
      requestId = req.id;
      newRequest = !knownRequests.has(req.id);
      if (isLikely && req.status === "awaiting_approval") {
        req.status = "awaiting_verification"; req.approval = "pending";
        req.history.push({ at: now.toISOString(), text: "Pre-checked for a possible repair; needs verification after the inspection findings. Nothing has been ordered." });
        req.notes = `${req.notes} Possible repair only — not a confirmed diagnosis.`.trim();
      }
      actions.push(`${newRequest ? "Created" : "Linked existing"} parts request ${req.id} for ${req.lines.filter((l) => l.shortfall > 0).map((l) => l.description).join(", ")} (est. ${money(req.total)}, simulated prices, awaiting human review — nothing ordered)`);
    }
    actions.push(`${booking.status === "pending" ? "Provisional booking" : "Booking"} ${booking.id}: ${booking.repairType}, ${prettyDate(booking.date)} ${booking.start} with ${mechanicById(state, booking.mechanicId).name}`);
  }
  step(s, "save", "done", actions.join(" · "));
  // ---- tasks
  const taskIds: string[] = [];
  const primary = state.bookings.find((b) => b.id === bookingIds[0])!;
  const addTask = (text: string, due: string): void => { taskIds.push(createTask(state, { text, due, callId, jobId: primaryJob }, now).id); };
  if (requestId && newRequest) addTask(`Review parts request ${requestId} (${customer.name}, ${vlabel(vehicle)}) and decide whether to order`, localDate(now));
  if (p.intent === "inspection") addTask(`Record inspection findings for ${customer.name} (${vlabel(vehicle)}) before quoting any repair`, primary.date);
  if (p.parts.some((c) => c.compat === "uncertain")) addTask(`Verify part fitment for ${vlabel(vehicle)} (${customer.name})`, primary.date);
  if (vehicle.reg.startsWith("TBC")) addTask(`Collect registration for ${customer.name}'s ${vlabel(vehicle)} at arrival`, primary.date);
  if (p.intent === "follow_up") addTask(`Update ${customer.name} on job ${s.followUpJobId} at the follow-up check`, primary.date);
  if (!taskIds.length) addTask(`Prepare for ${primary.repairType} — ${customer.name}, ${vlabel(vehicle)}`, primary.date);
  step(s, "tasks", "done", `${taskIds.length} task(s) created.`);

  // ---- call record
  const missingTxt = p.missing.map((m) => `${m.shortfall}× ${m.description}`).join(", ") || "None";
  const call: Call = {
    id: callId, customerId, name: customer.name, phone: customer.phone, date: localDate(now), time: hhmm(now),
    durationSec: 70 + s.transcript.length * 22, status: p.intent === "follow_up" ? "follow_up" : "completed", vehicle: vlabel(vehicle), reason: issue,
    summary: summarise(state, s, option, p, missingTxt, createdCustomer), requested: [...new Set(option.bookings.map((b) => repairType(b.repairType).name))].join(" → "),
    estimate: p.intent === "inspection" ? (p.inspectionFee ?? p.estimate) : p.estimate,
    appointmentStatus: option.bookings.some((b) => b.status === "pending") ? "Inspection confirmed; repair provisional" : "Confirmed",
    followUp: taskIds.length ? "See workshop tasks" : "None", missingParts: missingTxt, transcript: s.transcript.map((t) => ({ ...t })),
    bookingId: bookingIds[0], jobId: primaryJob, resolved: true, simulated: true,
  };
  state.calls.push(call);
  s.stage = "confirmed"; s.awaiting = undefined;
  s.result = { callId, customerId, vehicleId, jobId: primaryJob!, bookingIds, requestId, taskIds, actions };
  const reply = `Booked! ${option.bookings.length > 1 ? "Your inspection is confirmed and the repair slot is provisional until the mechanic has inspected the car." : `You're confirmed for ${prettyDate(primary.date)} at ${primary.start} with ${mechanicById(state, primary.mechanicId).name}.`}${requestId && newRequest ? " I've asked the owner to review the parts needed — nothing has been ordered." : ""} Thanks for calling ${SHOP_NAME}. Goodbye!`;
  say(s, reply);
  call.transcript = s.transcript.map((t) => ({ ...t }));
  step(s, "summary", "done", `Call ${callId} added to call history; calendar, customer record, job${requestId ? " and parts request" : ""} updated.`);
  return s;
}

function summarise(state: DemoState, s: AgentSession, o: SlotOption, p: AgentPlan, missing: string, created: boolean): string {
  const c = customerOf(state, s.customerId);
  const v = vehicleOf(state, s.vehicleId);
  const bk = o.bookings[0]!;
  const parts: string[] = [`[Simulated demo call] ${created ? "New customer" : "Returning customer"} ${c.name} called about their ${vlabel(v)}.`];
  if (p.intent === "inspection") parts.push(`Customer-reported: ${p.symptoms.join(", ") || p.issueText}. No diagnosis was made — the AI booked an inspection on ${bk.date} at ${bk.start}.`);
  else if (p.intent === "follow_up") parts.push(`The AI reported the recorded status of job ${s.followUpJobId} and booked a follow-up check on ${bk.date} at ${bk.start}.`);
  else parts.push(`Requested ${repairType(bk.repairType).name.toLowerCase()}; booked ${bk.date} at ${bk.start}.`);
  if (p.likelyRepairType) parts.push(`A possible repair (${repairType(p.likelyRepairType).name}) was pre-checked and provisionally scheduled.`);
  parts.push(p.parts.length ? (p.missing.length ? `Missing: ${missing}; a parts request awaits human approval (nothing ordered).` : "All required parts are in stock.") : "No parts required.");
  return parts.join(" ");
}

function finishInfoCall(state: DemoState, s: AgentSession, now: Date): void {
  const c = customerOf(state, s.customerId);
  const v = s.vehicleId ? vehicleOf(state, s.vehicleId) : undefined;
  const call: Call = {
    id: nextId(state, "call"), customerId: c.id, name: c.name, phone: c.phone, date: localDate(now), time: hhmm(now), durationSec: 60 + s.transcript.length * 20, status: "follow_up",
    vehicle: v ? vlabel(v) : "—", reason: s.input.issue ?? "Status enquiry", summary: `[Simulated demo call] ${c.name} asked about job ${s.followUpJobId ?? ""}. The AI reported the recorded status; no further action requested.`,
    requested: "Status enquiry", appointmentStatus: "No change", followUp: "None", missingParts: "None", transcript: s.transcript.map((t) => ({ ...t })), jobId: s.followUpJobId, resolved: true, simulated: true,
  };
  state.calls.push(call);
  s.result = { callId: call.id, customerId: c.id, vehicleId: s.vehicleId ?? "", jobId: s.followUpJobId ?? "", bookingIds: [], taskIds: [], actions: ["Logged the status enquiry in call history"] };
  step(s, "summary", "done", `Call ${call.id} logged.`);
}

function finishDeclined(state: DemoState, s: AgentSession, now: Date, why = "Customer declined the offered times"): void {
  const known = s.customerId ? customerOf(state, s.customerId) : undefined;
  const call: Call = {
    id: nextId(state, "call"), customerId: known?.id, name: known?.name ?? s.input.name ?? "Unknown caller", phone: known?.phone ?? s.input.phone ?? "—", date: localDate(now), time: hhmm(now),
    durationSec: 60 + s.transcript.length * 20, status: "new_inquiry", vehicle: s.vehicleId ? vlabel(vehicleOf(state, s.vehicleId)) : vlabel(s.input), reason: s.input.issue ?? "—",
    summary: `[Simulated demo call] ${why}. No booking, job or parts request was created.`, requested: "—", appointmentStatus: "Not scheduled", followUp: "Call back the customer.",
    missingParts: s.plan?.missing.map((m) => m.description).join(", ") || "None", transcript: s.transcript.map((t) => ({ ...t })), resolved: false, simulated: true,
  };
  state.calls.push(call);
  createTask(state, { text: `Call back ${call.name} (${call.phone}) — ${why.toLowerCase()}`, due: localDate(now), callId: call.id }, now);
  s.result = { callId: call.id, customerId: known?.id ?? "", vehicleId: s.vehicleId ?? "", jobId: "", bookingIds: [], taskIds: [], actions: ["Call logged; callback task created; nothing booked"] };
  step(s, "summary", "done", `Call ${call.id} logged without a booking.`);
}

export function chooseOption(state: DemoState, id: string, body: unknown, now: Date): AgentSession {
  const s = state.sessions.find((x) => x.id === id);
  if (!s) throw new ValidationError("Session not found.", 404);
  if (s.stage !== "offering") throw new ValidationError("There are no options to choose from right now.", 409);
  const b = typeof body === "object" && body ? (body as Record<string, unknown>) : {};
  const idx = s.options.findIndex((o) => o.id === b.optionId);
  if (idx < 0) throw new ValidationError("Unknown option.");
  s.transcript.push({ role: "customer", text: `Option ${idx + 1}, please.` });
  return confirm(state, s, idx, now);
}

export function endSession(state: DemoState, id: string, now: Date): AgentSession {
  const s = state.sessions.find((x) => x.id === id);
  if (!s) throw new ValidationError("Session not found.", 404);
  if (s.stage === "confirmed" || s.stage === "ended") return s;
  s.stage = "ended";
  s.transcript.push({ role: "system", text: "Caller hung up." });
  if (s.customerId || s.input.issue) finishDeclined(state, s, now, "Caller hung up before booking");
  return s;
}

export { cancelBooking, PART_KINDS, HOURS_TEXT, TranscriptLine };
