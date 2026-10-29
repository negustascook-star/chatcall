/** Wording used by the seed data and the simulated receptionist. Customer-reported symptoms are never stated as diagnoses. */
import { PART_KINDS, repairType } from "./rules.js";
import type { PartCheck, TranscriptLine } from "./types.js";

export const ISSUES: Record<string, string[]> = {
  oil_service: ["It's due for its annual service and oil change.", "The service reminder came on, so I'd like an oil and filter change.", "Time for an oil change, it's been about 10,000 km."],
  filters: ["It smells musty when the fan is on.", "I'd like the air and cabin filters replaced."],
  brake_inspection: ["There's a grinding noise when I brake.", "The brake pedal feels soft.", "I hear squealing when I brake at low speed."],
  brake_pads_front: ["The brake warning light is on, I'd like front pads fitted.", "I'd like new front brake pads."],
  brake_service_front: ["Squealing brakes and a vibration in the steering wheel when braking.", "I'd like the front pads and discs replaced."],
  brake_service_rear: ["The rear brakes squeak and the handbrake feels weak."],
  battery: ["The car struggles to start in the morning.", "The battery went flat twice this week."],
  diagnostic: ["The check engine light came on.", "Engine warning light and it feels sluggish."],
  ac_service: ["The air conditioning blows warm air."],
  spark_plugs: ["The engine idles roughly and sometimes misfires."],
  timing_belt: ["It's at the mileage when the manual says the timing belt is due."],
  suspension_inspection: ["There's a clunk from the front over bumps."],
  front_shocks: ["The front end feels bouncy, I think the shocks are tired."],
  wheel_bearing: ["There's a humming noise that gets louder with speed."],
  clutch: ["The clutch seems to slip when I accelerate hard."],
  wipers: ["The wipers are streaking."],
  tire_rotation: ["I feel a vibration at highway speed."],
  general_inspection: ["I'm buying a used car and want a general check."],
};

/** Free-text → symptom tags (customer reported; never confirmed). */
export const SYMPTOM_PATTERNS: [RegExp, string][] = [
  [/grind(ing)?/i, "grinding noise"], [/squeal|squeak/i, "squealing/squeaking"], [/vibrat|shak/i, "vibration"],
  [/soft (brake )?pedal|pedal.*(soft|spongy|sink)/i, "soft brake pedal"], [/clunk|knock/i, "clunking over bumps"],
  [/hum(ming)?/i, "humming noise"], [/warning light|check engine|engine light|dashboard light/i, "warning light on"],
  [/won'?t start|struggl\w* to start|hard to start/i, "hard starting"], [/leak/i, "fluid leak"], [/smoke|smell|burning/i, "smell/smoke"],
  [/misfir|rough idle|stall/i, "rough running"], [/overheat/i, "overheating"],
];

export function assessment(repairId: string, issue: string): string {
  const rt = repairType(repairId);
  const symptoms = SYMPTOM_PATTERNS.filter(([re]) => re.test(issue)).map(([, s]) => s);
  const said = symptoms.length ? `Customer reports: ${symptoms.join(", ")}.` : issue ? `Customer reports: "${issue}"` : "No fault reported.";
  if (rt.kind === "inspection") {
    return `${said} Cause not confirmed — a mechanic must inspect the vehicle before any repair is recommended. Booked as an inspection, not a repair.`;
  }
  if (rt.kind === "repair") {
    return `${said} Customer requested "${rt.name}". Scope and parts are provisional until the mechanic has inspected the vehicle.`;
  }
  return `${said} Routine maintenance; parts and time are standard estimates.`;
}

export const money = (n: number): string => `€${n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

export function partNeedsText(checks: PartCheck[]): string {
  if (!checks.length) return "No parts required for this visit.";
  return checks.map((c) => `${c.qty}× ${PART_KINDS[c.kind]?.label ?? c.description}: ${c.shortfall ? `${c.shortfall} short` : "available"}`).join("; ");
}

export function seedTranscript(o: {
  shop: string; name: string; vehicle: string; issue: string; repairId: string; when: string; mechanic: string;
  estimate: number; missing: string; kind: string;
}): TranscriptLine[] {
  const rt = repairType(o.repairId);
  const first = o.name.split(" ")[0]!;
  const t: TranscriptLine[] = [
    { role: "ai", text: `Thank you for calling ${o.shop}, this is the virtual receptionist. How can I help?` },
    { role: "customer", text: o.issue },
    { role: "ai", text: `Happy to help, ${first}. Which vehicle is it, and could I have the registration?` },
    { role: "customer", text: `It's the ${o.vehicle}.` },
  ];
  if (rt.kind === "inspection") {
    t.push(
      { role: "ai", text: "When did you first notice it, and does it happen every time or only sometimes?" },
      { role: "customer", text: "Over the last week or so, mostly at low speed." },
      { role: "ai", text: "Thanks. I can't tell you what is causing it from a phone call — a mechanic needs to look at the car. I'd book an inspection and they will explain what, if anything, needs repairing." },
    );
  } else {
    t.push({ role: "ai", text: `Understood. That's a "${rt.name}" — roughly ${rt.hours} hour(s) of labour. The estimate is about ${money(o.estimate)}; the mechanic will confirm the final price.` });
  }
  if (o.missing) t.push({ role: "ai", text: `One note: ${o.missing} isn't in stock right now, so I've raised a parts request for the workshop to review. Nothing has been ordered.` });
  t.push(
    { role: "ai", text: `I can offer ${o.when} with ${o.mechanic}. Would that suit you?` },
    { role: "customer", text: "Yes, that works." },
    { role: "ai", text: "Booked. You'll see it in the calendar and the workshop has your details. Anything else?" },
    { role: "customer", text: "No, thanks." },
    { role: "ai", text: "Thanks for calling. Goodbye!" },
  );
  return t;
}
