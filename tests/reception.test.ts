import { describe, it, expect } from "vitest";
import { calculateSlots, routeReception } from "../src/api/reception.js";
import { createServer } from "node:http";

const hours = { weekly: { fri: [{ start: "09:00", end: "10:00" }] } };
const specialist = { id: "one", name: "Jonas", working_schedule: hours, unavailable_periods: [] };
describe("Reception availability", () => {
  it("converts Vilnius time and excludes overlapping bookings", () => {
    const slots = calculateSlots("2026-10-30", "Europe/Vilnius", 30, hours, [specialist], [{ specialist_id: "one", starts_at: "2026-10-30T07:00:00Z", ends_at: "2026-10-30T07:30:00Z", status: "confirmed" }], 0);
    expect(slots.map(s => s.starts_at)).toEqual(["2026-10-30T07:30:00.000Z"]);
  });
  it("does not block other specialists or cancelled bookings", () => {
    expect(calculateSlots("2026-10-30", "Europe/Vilnius", 30, hours, [specialist], [{ specialist_id: "two", starts_at: "2026-10-30T07:00:00Z", ends_at: "2026-10-30T08:00:00Z", status: "confirmed" }], 0)).toHaveLength(3);
  });
  it("fails closed for free text schedules and absences", () => {
    expect(() => calculateSlots("2026-10-30", "Europe/Vilnius", 30, { display: "9-17" }, [specialist], [], 0)).toThrow();
    expect(() => calculateSlots("2026-10-30", "Europe/Vilnius", 30, hours, [{ ...specialist, unavailable_periods: { display: "holiday" } }], [], 0)).toThrow();
  });
  it("excludes absences and past slots", () => {
    expect(calculateSlots("2026-10-30", "Europe/Vilnius", 30, hours, [{ ...specialist, unavailable_periods: [{ starts_at: "2026-10-30T07:00:00Z", ends_at: "2026-10-30T08:00:00Z" }] }], [], 0)).toHaveLength(0);
    expect(calculateSlots("2026-10-30", "Europe/Vilnius", 30, hours, [specialist], [], Date.parse("2026-10-31"))).toHaveLength(0);
  });
  it("rejects unauthenticated requests and explains browser GET", async () => {
    const server = createServer((req,res) => { void routeReception(req,res,{ url:"https://example.invalid",key:"private",toolSecret:"test",companyId:"00000000-0000-0000-0000-000000000001" }); });
    await new Promise<void>(resolve => server.listen(0,"127.0.0.1",resolve));
    try {
      const address = server.address() as { port: number };
      const url = `http://127.0.0.1:${address.port}`;
      expect((await fetch(url)).status).toBe(405);
      expect((await fetch(url,{method:"POST",body:"{}"})).status).toBe(401);
      expect((await fetch(url,{method:"POST",headers:{"x-reception-key":"test"},body:"{}"})).status).toBe(400);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
