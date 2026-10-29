import { routeReception, type ReceptionConfig } from "./reception.js";
import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { CallAgent, CallEndedError, CallNotFoundError } from "../agent/callAgent.js";
import { RequestService } from "../requests/requestService.js";
import {
  AdminSchemaOutdatedError,
  isPlanCode,
  type AdminCompany,
  type AdminDataSource,
} from "../supabase/admin.js";
import { TenantRepository } from "../tenants/tenantRepository.js";

export interface ApiDependencies {
  dataDir: string;
  agent: CallAgent;
  tenants?: TenantRepository;
  catalogSource?: "json" | "supabase";
  websiteFile?: string;
  authFile?: string;
  appFile?: string;
  adminFile?: string;
  supabaseUrl?: string;
  supabasePublicKey?: string;
  warehousePlanPriceEur?: number;
  adminKey?: string;
  admin?: AdminDataSource;
  reception?: ReceptionConfig;
}

interface ServerContext {
  agent: CallAgent;
  tenants: TenantRepository;
  requests: RequestService;
  catalogSource: "json" | "supabase";
  websiteFile: string;
  authFile: string;
  appFile: string;
  adminFile: string;
  supabaseUrl?: string;
  supabasePublicKey?: string;
  warehousePlanPriceEur?: number;
  adminKey?: string;
  admin?: AdminDataSource;
  reception?: ReceptionConfig;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

const ADMIN_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const ADMIN_MAX_ATTEMPTS = 10;
const adminAttempts = new Map<string, { count: number; resetAt: number }>();
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Static brand assets served next to the HTML pages. */
const STATIC_ASSETS: Record<string, string> = {
  "/logo.svg": "image/svg+xml",
  "/logo-mark.svg": "image/svg+xml",
};

export function createApiServer(deps: ApiDependencies): Server {
  const tenants = deps.tenants ?? new TenantRepository(deps.dataDir);
  const requests = new RequestService(deps.dataDir);
  const websiteFile = deps.websiteFile ?? path.resolve(process.cwd(), "index.html");
  const authFile = deps.authFile ?? path.join(path.dirname(websiteFile), "auth.html");
  const appFile = deps.appFile ?? path.join(path.dirname(websiteFile), "app.html");
  const adminFile = deps.adminFile ?? path.join(path.dirname(websiteFile), "admin.html");
  const context: ServerContext = {
    agent: deps.agent,
    tenants,
    requests,
    catalogSource: deps.catalogSource ?? "json",
    websiteFile,
    authFile,
    appFile,
    adminFile,
    supabaseUrl: deps.supabaseUrl,
    supabasePublicKey: deps.supabasePublicKey,
    warehousePlanPriceEur: deps.warehousePlanPriceEur,
    adminKey: deps.adminKey,
    admin: deps.admin,
    reception: deps.reception,
  };

  return createServer(async (req, res) => {
    const adminApi = (req.url ?? "").startsWith("/api/admin/");
    try {
      await route(req, res, context);
    } catch (error) {
      if (res.headersSent) {
        res.end();
        return;
      }

      if (error instanceof HttpError) {
        sendJson(res, error.status, { error: error.message }, !adminApi);
        return;
      }
      if (error instanceof CallNotFoundError) {
        sendJson(res, 404, { error: "Skambutis nerastas." });
        return;
      }
      if (error instanceof CallEndedError) {
        sendJson(res, 409, { error: "Skambutis jau baigtas." });
        return;
      }

      console.error(error);
      sendJson(res, 500, { error: "Vidinė serverio klaida." }, !adminApi);
    }
  });
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ServerContext,
): Promise<void> {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", "http://localhost");

  if (url.pathname === "/api/reception/check-availability") {
    await routeReception(req, res, ctx.reception);
    return;
  }

  if (method === "OPTIONS") {
    sendNoContent(res);
    return;
  }

  if (method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    await sendWebsite(res, ctx.websiteFile);
    return;
  }

  if (method === "GET" && url.pathname === "/auth.html") {
    await sendWebsite(res, ctx.authFile);
    return;
  }

  if (method === "GET" && url.pathname === "/app.html") {
    await sendWebsite(res, ctx.appFile);
    return;
  }

  if (method === "GET" && (url.pathname === "/admin" || url.pathname === "/admin/" || url.pathname === "/admin.html")) {
    await sendWebsite(res, ctx.adminFile);
    return;
  }

  if (method === "GET" && url.pathname === "/api/public-config") {
    sendJson(res, 200, {
      supabaseUrl: ctx.supabaseUrl ?? null,
      supabasePublicKey: ctx.supabasePublicKey ?? null,
      warehousePlanPriceEur: ctx.warehousePlanPriceEur ?? null,
    });
    return;
  }

  if (method === "GET" && url.pathname === "/i18n.js") {
    await sendJavaScript(res, path.join(path.dirname(ctx.websiteFile), "i18n.js"));
    return;
  }

  const assetType = STATIC_ASSETS[url.pathname];
  if (method === "GET" && assetType) {
    await sendAsset(res, path.join(path.dirname(ctx.websiteFile), url.pathname.slice(1)), assetType);
    return;
  }

  if (method === "GET" && url.pathname === "/health") {
    sendJson(res, 200, {
      ok: true,
      service: "chatcall",
      catalogSource: ctx.catalogSource,
      time: new Date().toISOString(),
    });
    return;
  }

  if (url.pathname.startsWith("/api/admin/")) {
    requireAdmin(req, ctx.adminKey);
    if (!ctx.admin) {
      throw new HttpError(503, "Administratoriaus duomenų šaltinis nesukonfigūruotas. Nustatykite SUPABASE_SECRET_KEY.");
    }
    await routeAdmin(req, res, url, ctx.admin);
    return;
  }

  if (method === "GET" && url.pathname === "/api/tenants") {
    const list = await ctx.tenants.list();
    sendJson(res, 200, {
      tenants: list.map(({ tenant, services, inventory, faq }) => ({
        id: tenant.id,
        name: tenant.name,
        phone: tenant.phone,
        services: services.length,
        inventoryItems: inventory.length,
        faqEntries: faq.length,
      })),
    });
    return;
  }

  if (method === "POST" && url.pathname === "/api/calls") {
    const body = await readJsonBody(req);
    const record = requireRecord(body);
    const tenantId = optionalString(record, "tenantId");
    const to = optionalString(record, "to");
    const from = optionalString(record, "from");

    if (!tenantId && !to) {
      throw new HttpError(400, "Nurodykite tenantId arba to (skambinamą numerį).");
    }

    const channel = record.channel;
    if (channel !== undefined && channel !== "text" && channel !== "phone") {
      throw new HttpError(400, "channel turi būti 'text' arba 'phone'.");
    }

    const result = await ctx.agent.startCall({
      tenantId,
      to,
      from,
      channel: channel === "phone" ? "phone" : "text",
    });
    sendJson(res, 201, result);
    return;
  }

  const callMatch = url.pathname.match(/^\/api\/calls\/([^/]+)$/);
  if (method === "GET" && callMatch?.[1]) {
    const session = ctx.agent.getSession(decodeURIComponent(callMatch[1]));
    if (!session) throw new CallNotFoundError(callMatch[1]);
    sendJson(res, 200, session);
    return;
  }

  const messageMatch = url.pathname.match(/^\/api\/calls\/([^/]+)\/messages$/);
  if (method === "POST" && messageMatch?.[1]) {
    const body = await readJsonBody(req);
    const record = requireRecord(body);
    const text = optionalString(record, "text");
    if (!text) throw new HttpError(400, "Laukas 'text' yra privalomas.");

    const result = await ctx.agent.handleMessage(decodeURIComponent(messageMatch[1]), text);
    sendJson(res, 200, result);
    return;
  }

  const endMatch = url.pathname.match(/^\/api\/calls\/([^/]+)\/end$/);
  if (method === "POST" && endMatch?.[1]) {
    const result = await ctx.agent.endCall(decodeURIComponent(endMatch[1]));
    sendJson(res, 200, result);
    return;
  }

  const requestsMatch = url.pathname.match(/^\/api\/tenants\/([^/]+)\/requests$/);
  if (method === "GET" && requestsMatch?.[1]) {
    const tenantId = decodeURIComponent(requestsMatch[1]);
    const tenant = await ctx.tenants.get(tenantId);
    if (!tenant) throw new HttpError(404, "Tenant nerastas.");

    const date = url.searchParams.get("date") ?? undefined;
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new HttpError(400, "date turi būti YYYY-MM-DD formatu.");
    }

    const saved = await ctx.requests.list(tenantId, date);
    sendJson(res, 200, { requests: saved });
    return;
  }

  throw new HttpError(404, "Maršrutas nerastas.");
}

async function routeAdmin(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  admin: AdminDataSource,
): Promise<void> {
  const method = req.method ?? "GET";

  if (method === "GET" && url.pathname === "/api/admin/overview") {
    const overview = await admin.overview();
    sendJson(res, 200, overview, false);
    return;
  }

  if (method === "GET" && url.pathname === "/api/admin/companies") {
    const companies = await admin.listCompanies();
    sendJson(res, 200, { companies }, false);
    return;
  }

  const planMatch = url.pathname.match(/^\/api\/admin\/companies\/([^/]+)\/plan$/);
  if (method === "POST" && planMatch?.[1]) {
    const id = decodeURIComponent(planMatch[1]);
    if (!UUID_PATTERN.test(id)) {
      throw new HttpError(400, "Neteisingas įmonės ID.");
    }
    const body = await readJsonBody(req);
    const record = requireRecord(body);
    if (!isPlanCode(record.planCode)) {
      throw new HttpError(400, "planCode turi būti pending, receptionist arba warehouse.");
    }
    const company = await admin.updateCompanyPlan(id, record.planCode);
    if (!company) throw new HttpError(404, "Įmonė nerasta.");
    sendJson(res, 200, { company }, false);
    return;
  }

  const suspensionMatch = url.pathname.match(/^\/api\/admin\/companies\/([^/]+)\/(suspend|restore)$/);
  if (method === "POST" && suspensionMatch?.[1] && suspensionMatch[2]) {
    const id = decodeURIComponent(suspensionMatch[1]);
    if (!UUID_PATTERN.test(id)) {
      throw new HttpError(400, "Neteisingas įmonės ID.");
    }
    let company: AdminCompany | undefined;
    try {
      if (suspensionMatch[2] === "suspend") {
        const body = await readJsonBody(req);
        const reason = optionalString(requireRecord(body), "reason") ?? "";
        if (reason.length > 500) {
          throw new HttpError(400, "Priežastis per ilga (iki 500 simbolių).");
        }
        company = await admin.suspendCompany(id, reason);
      } else {
        company = await admin.restoreCompany(id);
      }
    } catch (error) {
      if (error instanceof AdminSchemaOutdatedError) {
        throw new HttpError(503, error.message);
      }
      throw error;
    }
    if (!company) throw new HttpError(404, "Įmonė nerasta.");
    sendJson(res, 200, { company }, false);
    return;
  }

  const companyMatch = url.pathname.match(/^\/api\/admin\/companies\/([^/]+)$/);
  if (method === "DELETE" && companyMatch?.[1]) {
    const id = decodeURIComponent(companyMatch[1]);
    if (!UUID_PATTERN.test(id)) {
      throw new HttpError(400, "Neteisingas įmonės ID.");
    }
    const deleted = await admin.deleteCompany(id);
    if (!deleted) throw new HttpError(404, "Įmonė nerasta.");
    sendJson(res, 200, { deleted: true, id }, false);
    return;
  }

  if (method === "GET" && url.pathname === "/api/admin/appointments") {
    const appointments = await admin.listAppointments(readLimit(url));
    sendJson(res, 200, { appointments }, false);
    return;
  }

  if (method === "GET" && url.pathname === "/api/admin/calls") {
    const calls = await admin.listCalls(readLimit(url));
    sendJson(res, 200, { calls }, false);
    return;
  }

  throw new HttpError(404, "Administratoriaus maršrutas nerastas.");
}

function requireAdmin(req: IncomingMessage, adminKey?: string): void {
  if (!adminKey) {
    throw new HttpError(503, "Administratoriaus panelė nesukonfigūruota. Nustatykite ADMIN_KEY.");
  }

  const address = req.socket.remoteAddress ?? "unknown";
  const now = Date.now();
  const previous = adminAttempts.get(address);
  if (previous && previous.resetAt <= now) {
    adminAttempts.delete(address);
  } else if (previous && previous.count >= ADMIN_MAX_ATTEMPTS) {
    throw new HttpError(429, "Per daug neteisingų bandymų. Bandykite vėliau.");
  }

  const provided = readAdminKey(req);
  if (!secureEqual(provided, adminKey)) {
    const current = adminAttempts.get(address);
    adminAttempts.set(address, {
      count: (current?.count ?? 0) + 1,
      resetAt: current?.resetAt ?? now + ADMIN_ATTEMPT_WINDOW_MS,
    });
    throw new HttpError(401, "Neteisingas administratoriaus raktas.");
  }

  adminAttempts.delete(address);
}

function readAdminKey(req: IncomingMessage): string {
  const direct = req.headers["x-admin-key"];
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const authorization = req.headers.authorization;
  if (authorization?.startsWith("Bearer ")) return authorization.slice(7).trim();
  return "";
}

function secureEqual(provided: string, expected: string): boolean {
  const actualHash = createHash("sha256").update(provided).digest();
  const expectedHash = createHash("sha256").update(expected).digest();
  return timingSafeEqual(actualHash, expectedHash);
}

function readLimit(url: URL): number {
  const raw = url.searchParams.get("limit");
  if (raw === null || raw === "") return 100;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 500) {
    throw new HttpError(400, "limit turi būti sveikas skaičius nuo 1 iki 500.");
  }
  return value;
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpError(400, "Netinkamas JSON kūnas.");
  }
  return value as Record<string, unknown>;
}

function optionalString(
  record: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = record[field];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") {
    throw new HttpError(400, `Laukas '${field}' turi būti tekstas.`);
  }
  return value.trim();
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1_000_000) {
        reject(new HttpError(413, "Užklausa per didelė."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new HttpError(400, "Neteisingas JSON."));
      }
    });

    req.on("error", reject);
  });
}

async function sendWebsite(res: ServerResponse, file: string): Promise<void> {
  let html: Buffer;
  try {
    html = await readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new HttpError(404, "Svetainė nerasta.");
    }
    throw error;
  }

  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": html.byteLength,
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(html);
}

async function sendJavaScript(res: ServerResponse, file: string): Promise<void> {
  let script: Buffer;
  try {
    script = await readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new HttpError(404, "Svetainės scenarijus nerastas.");
    }
    throw error;
  }
  res.writeHead(200, {
    "Content-Type": "text/javascript; charset=utf-8",
    "Content-Length": script.byteLength,
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(script);
}

async function sendAsset(res: ServerResponse, file: string, contentType: string): Promise<void> {
  let data: Buffer;
  try {
    data = await readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new HttpError(404, "Failas nerastas.");
    }
    throw error;
  }
  res.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": data.byteLength,
    "Cache-Control": "public, max-age=3600",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(data);
}

function sendJson(res: ServerResponse, status: number, payload: unknown, cors = true): void {
  const body = JSON.stringify(payload);
  const headers: Record<string, string | number> = {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  };
  if (cors) {
    headers["Access-Control-Allow-Origin"] = "*";
    headers["Access-Control-Allow-Methods"] = "GET,POST,OPTIONS";
    headers["Access-Control-Allow-Headers"] = "Content-Type";
  }
  res.writeHead(status, headers);
  res.end(body);
}

function sendNoContent(res: ServerResponse): void {
  res.writeHead(204, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end();
}

