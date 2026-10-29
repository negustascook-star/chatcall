# Reception.ai availability tool

This adds a read-only tool; existing pages, API routes and data remain intact.
It does not book appointments, transfer calls or import call transcripts.

## Server configuration

Set these environment variables on the server actually serving aicall.lt:

- `SUPABASE_URL` and server-only `SUPABASE_SECRET_KEY` (or service role key).
- `RECEPTION_COMPANY_ID`: the UUID of your existing `companies` row.
- `RECEPTION_TOOL_SECRET`: a new random secret, for example generated with
  `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.

Never use a Supabase service key as the tool secret. Restart/redeploy after setting
the variables. Existing Supabase migrations, including suspended_at, are required.

## Calendar configuration (required)

The current owner UI stores schedules as free text. Availability requires explicit
structured hours so the agent never guesses. Merge `timezone` and `weekly` into
the existing `companies.opening_hours` JSON, preserving `display`:

```json
{"display":"Mon–Fri 09:00–17:00","timezone":"Europe/Vilnius","weekly":{"mon":[{"start":"09:00","end":"17:00"}],"tue":[{"start":"09:00","end":"17:00"}],"wed":[{"start":"09:00","end":"17:00"}],"thu":[{"start":"09:00","end":"17:00"}],"fri":[{"start":"09:00","end":"17:00"}],"sat":[],"sun":[]}}
```

Each active specialist's `working_schedule` needs the same `weekly` shape using
their real shifts. `unavailable_periods` must be `[]` or an array of
`{"starts_at":"2026-11-02T07:00:00Z","ends_at":"2026-11-02T10:00:00Z"}`.
Do not replace real absence information with an empty array. The current specialist
editor replaces these fields with free text when saving; restore structured data
after such edits until a structured schedule editor is implemented.
Unknown/malformed schedules return 503, never fabricated availability.

## Reception.ai → Integrations → Webhook Tool

- Name: `check_availability`
- Method: `POST`
- URL: `https://aicall.lt/api/reception/check-availability`
- Assign to: **Receptionist**
- Request headers: `x-reception-key` = your `RECEPTION_TOOL_SECRET`;
  `Content-Type` = `application/json`
- Body parameters: `service_id` (string, required; exact active business_services
  UUID), `date` (string, required; YYYY-MM-DD in business timezone),
  `specialist_id` (string, optional; exact specialist UUID).
- Description: Check real availability before offering times. Use only configured
  service/specialist IDs. On error offer a callback. This tool NEVER confirms a booking.

Put the actual service IDs/names in the receptionist's knowledge/instructions.
The company is bound by server configuration, not caller-supplied parameters.
Results contain up to 50 available slots, UTC timestamps and the business timezone;
no customer names, phone numbers or existing appointment details are returned.
Slots use a 15-minute start interval and the configured service duration. Cancelled
appointments do not block slots. Appointments with no specialist block all staff.

## Verification

Opening the URL in a browser should give **405 Use POST**, not 404. POST without
a valid key gives 401; missing server configuration gives 503. Use the Reception
tool test with a real service UUID and date. Confirm an existing appointment and
an absence are excluded. A 200 response only reports availability at that moment;
booking still needs a separate transactional endpoint with a conflict check.
