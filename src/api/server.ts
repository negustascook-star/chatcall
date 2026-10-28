import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { CallAgent, CallEndedError, CallNotFoundError } from "../agent/callAgent.js";
import { RequestService } from "../requests/requestService.js";
import { TenantRepository } from "../tenants/tenantRepository.js";

export interface ApiDependencies {
  dataDir: string;
  agent: CallAgent;
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

export function createApiServer(deps: ApiDependencies): Server {
  const tenants = new TenantRepository(deps.dataDir);
  const requests = new RequestService(deps.dataDir);

  return createServer(async (req, res) => {
    try {
      await route(req, res, deps.agent, tenants, requests);
    } catch (error) {
      if (res.headersSent) {
        res.end();
        return;
      }

      if (error instanceof HttpError) {
        sendJson(res, error.status, { error: error.message });
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
      sendJson(res, 500, { error: "Vidinė serverio klaida." });
    }
  });
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  agent: CallAgent,
  tenants: TenantRepository,
  requests: RequestService,
): Promise<void> {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", "http://localhost");

  if (method === "OPTIONS") {
    sendNoContent(res);
    return;
  }

  if (method === "GET" && url.pathname === "/health") {
    sendJson(res, 200, {
      ok: true,
      service: "chatcall",
      time: new Date().toISOString(),
    });
    return;
  }

  if (method === "GET" && url.pathname === "/api/tenants") {
    const list = await tenants.list();
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

    const result = await agent.startCall({
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
    const session = agent.getSession(decodeURIComponent(callMatch[1]));
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

    const result = await agent.handleMessage(decodeURIComponent(messageMatch[1]), text);
    sendJson(res, 200, result);
    return;
  }

  const endMatch = url.pathname.match(/^\/api\/calls\/([^/]+)\/end$/);
  if (method === "POST" && endMatch?.[1]) {
    const result = await agent.endCall(decodeURIComponent(endMatch[1]));
    sendJson(res, 200, result);
    return;
  }

  const requestsMatch = url.pathname.match(/^\/api\/tenants\/([^/]+)\/requests$/);
  if (method === "GET" && requestsMatch?.[1]) {
    const tenantId = decodeURIComponent(requestsMatch[1]);
    const tenant = await tenants.get(tenantId);
    if (!tenant) throw new HttpError(404, "Tenant nerastas.");

    const date = url.searchParams.get("date") ?? undefined;
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new HttpError(400, "date turi būti YYYY-MM-DD formatu.");
    }

    const saved = await requests.list(tenantId, date);
    sendJson(res, 200, { requests: saved });
    return;
  }

  throw new HttpError(404, "Maršrutas nerastas.");
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

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
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
