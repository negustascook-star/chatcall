import { randomBytes } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";
import type {
  CustomerRequest,
  RequestItem,
  RequestStatus,
  RequestType,
  Tenant,
} from "../domain/types.js";
import {
  appendText,
  fileExists,
  listDirectories,
  readJson,
  writeJsonAtomic,
  writeTextAtomic,
} from "../lib/jsonStore.js";
import {
  csvEscape,
  dateFolder,
  formatMoney,
  SEASON_LABELS,
  timeLabel,
} from "../lib/text.js";

export interface CreateRequestInput {
  type: RequestType;
  status?: RequestStatus;
  customer: {
    name?: string;
    phone?: string;
  };
  vehicle?: string;
  items: RequestItem[];
  service?: string;
  preferredTime?: string;
  notes?: string;
  summary: string;
}

export interface CreatedRequest {
  request: CustomerRequest;
  jsonPath: string;
  mdPath: string;
}

export class RequestService {
  private readonly dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = path.resolve(dataDir);
  }

  async create(
    tenant: Tenant,
    callId: string,
    input: CreateRequestInput,
    now = new Date(),
  ): Promise<CreatedRequest> {
    const date = dateFolder(tenant.timezone, now);
    const folder = path.join(this.dataDir, "tenants", tenant.id, "requests", date);
    const id = createRequestId(date);
    const request: CustomerRequest = {
      id,
      tenantId: tenant.id,
      callId,
      type: input.type,
      status: input.status ?? "new",
      customer: input.customer,
      vehicle: input.vehicle,
      items: input.items,
      service: input.service,
      preferredTime: input.preferredTime,
      notes: input.notes,
      summary: input.summary,
      source: "ai_call",
      createdAt: now.toISOString(),
    };

    const jsonPath = path.join(folder, `${id}.json`);
    const mdPath = path.join(folder, `${id}.md`);

    await Promise.all([
      writeJsonAtomic(jsonPath, request),
      writeTextAtomic(mdPath, renderRequestMarkdown(request, tenant, now)),
    ]);

    await this.appendDailyDigest(request, tenant, folder, date, now);

    return { request, jsonPath, mdPath };
  }

  async list(tenantId: string, date?: string): Promise<CustomerRequest[]> {
    const requestsDir = path.join(this.dataDir, "tenants", tenantId, "requests");
    const dates = date ? [date] : (await listDirectories(requestsDir)).sort().reverse();
    const requests: CustomerRequest[] = [];

    for (const day of dates) {
      let files: string[];
      try {
        files = await readdir(path.join(requestsDir, day));
      } catch (error) {
        if (isNotFound(error)) continue;
        throw error;
      }

      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        requests.push(await readJson<CustomerRequest>(path.join(requestsDir, day, file)));
      }
    }

    return requests
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 200);
  }

  private async appendDailyDigest(
    request: CustomerRequest,
    tenant: Tenant,
    folder: string,
    date: string,
    now: Date,
  ): Promise<void> {
    const mdPath = path.join(folder, "poreikiai.md");
    const csvPath = path.join(folder, "poreikiai.csv");
    const time = timeLabel(tenant.timezone, now);
    const needs = describeNeeds(request);
    const type = requestTypeLabel(request.type);
    const status = requestStatusLabel(request.status);

    if (!(await fileExists(mdPath))) {
      await appendText(mdPath, `# Poreikiai ${date}\n\n`);
    }
    await appendText(
      mdPath,
      `## ${time} · ${request.id} · ${type}\n\n` +
        `- **Klientas:** ${oneLine(request.customer.name ?? "Neįvardytas")} · ${oneLine(request.customer.phone ?? "telefonas nenurodytas")}\n` +
        `- **Ko reikia:** ${oneLine(needs)}\n` +
        `- **Terminas:** ${oneLine(request.preferredTime ?? "nesutarta")}\n` +
        `- **Statusas:** ${status}\n\n`,
    );

    if (!(await fileExists(csvPath))) {
      await appendText(
        csvPath,
        "Laikas,ID,Tipas,Klientas,Telefonas,Automobilis,Ko reikia,Terminas,Statusas\n",
      );
    }
    await appendText(
      csvPath,
      [
        time,
        request.id,
        type,
        request.customer.name ?? "",
        request.customer.phone ?? "",
        request.vehicle ?? "",
        needs,
        request.preferredTime ?? "",
        status,
      ]
        .map(csvEscape)
        .join(",") + "\n",
    );
  }
}

function createRequestId(date: string): string {
  const suffix = randomBytes(3).toString("hex").toUpperCase();
  return `REQ-${date.replaceAll("-", "")}-${suffix}`;
}

function renderRequestMarkdown(
  request: CustomerRequest,
  tenant: Tenant,
  now: Date,
): string {
  const lines: string[] = [];
  const date = dateFolder(tenant.timezone, now);
  const time = timeLabel(tenant.timezone, now);

  lines.push(`# Poreikis ${request.id}`, "");
  lines.push(`- **Data:** ${date} ${time}`);
  lines.push(`- **Įmonė:** ${tenant.name}`);
  lines.push(`- **Tipas:** ${requestTypeLabel(request.type)}`);
  lines.push(`- **Statusas:** ${requestStatusLabel(request.status)}`);
  lines.push(`- **Klientas:** ${oneLine(request.customer.name ?? "Neįvardytas")}`);
  lines.push(`- **Telefonas:** ${oneLine(request.customer.phone ?? "Nenurodytas")}`);
  if (request.vehicle) lines.push(`- **Automobilis:** ${oneLine(request.vehicle)}`);
  if (request.preferredTime) {
    lines.push(`- **Pageidaujamas laikas:** ${oneLine(request.preferredTime)}`);
  }
  lines.push(`- **Skambučio ID:** ${request.callId}`);
  lines.push("");

  lines.push("## Ko reikia", "");
  if (request.items.length > 0) {
    for (const item of request.items) {
      lines.push(`- **${item.quantity} vnt.** ${oneLine(item.description)}`);
      if (item.size) lines.push(`  - Dydis: ${item.size}`);
      if (item.season) lines.push(`  - Sezonas: ${SEASON_LABELS[item.season]}`);
      if (item.brandPreference) lines.push(`  - Gamintojas / pageidavimas: ${item.brandPreference}`);
      if (item.unitPrice !== undefined) {
        lines.push(`  - Kaina: ${formatMoney(item.unitPrice, item.currency ?? "EUR")}/vnt.`);
      }
      lines.push(`  - Sandėlyje: ${item.inStock ? "taip" : "ne"}`);
    }
  } else if (request.service) {
    lines.push(`- Paslauga: **${oneLine(request.service)}**`);
  } else {
    lines.push("- Bendra konsultacija / perskambinimas");
  }
  lines.push("");

  if (request.notes) {
    lines.push("## Pastabos", "", oneLine(request.notes), "");
  }

  lines.push("## Pokalbio santrauka", "", oneLine(request.summary), "");
  return `${lines.join("\n")}\n`;
}

function describeNeeds(request: CustomerRequest): string {
  if (request.items.length > 0) {
    return request.items
      .map((item) => {
        const details: string[] = [];
        if (item.size && !item.description.includes(item.size)) details.push(item.size);
        if (item.season) details.push(SEASON_LABELS[item.season]);
        if (
          item.brandPreference &&
          !item.description.toLowerCase().includes(item.brandPreference.toLowerCase())
        ) {
          details.push(item.brandPreference);
        }
        if (!item.inStock) details.push("sandėlyje nėra");
        return `${item.quantity} vnt. ${item.description}${details.length > 0 ? ` (${details.join(", ")})` : ""}`;
      })
      .join("; ");
  }

  if (request.service) return request.service;
  return "Konsultacija / perskambinimas";
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function requestTypeLabel(type: RequestType): string {
  switch (type) {
    case "parts_order":
      return "Padangų / dalių užsakymas";
    case "service_booking":
      return "Paslaugos rezervacija";
    case "callback":
      return "Perskambinimas";
  }
}

export function requestStatusLabel(status: RequestStatus): string {
  switch (status) {
    case "new":
      return "Naujas";
    case "pending_confirmation":
      return "Laukia patvirtinimo";
    case "transferred":
      return "Perduota žmogui";
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
