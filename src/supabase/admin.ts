export type PlanCode = "pending" | "receptionist" | "warehouse";

export const PLAN_CODES: readonly PlanCode[] = ["pending", "receptionist", "warehouse"];

export function isPlanCode(value: unknown): value is PlanCode {
  return typeof value === "string" && (PLAN_CODES as readonly string[]).includes(value);
}

export interface AdminStats {
  companies: number;
  users: number;
  appointments: number;
  calls: number;
  services: number;
  specialists: number;
  paidCompanies: number;
  suspendedCompanies: number;
}

export interface AdminCompany {
  id: string;
  name: string;
  ownerId: string;
  ownerEmail: string | null;
  address: string;
  phone: string;
  planCode: PlanCode;
  paidAt: string | null;
  suspendedAt: string | null;
  suspendedReason: string;
  createdAt: string;
  appointments: number;
  calls: number;
  services: number;
  specialists: number;
}

export interface AdminAppointment {
  id: string;
  companyId: string;
  companyName: string;
  customerName: string;
  customerPhone: string;
  serviceName: string;
  specialistId: string | null;
  startsAt: string;
  endsAt: string;
  status: string;
  createdAt: string;
}

export interface AdminCall {
  id: string;
  companyId: string;
  companyName: string;
  customerName: string;
  customerPhone: string;
  summary: string;
  status: string;
  createdAt: string;
}

export interface AdminDataSource {
  overview(): Promise<{ stats: AdminStats; companies: AdminCompany[] }>;
  listCompanies(): Promise<AdminCompany[]>;
  updateCompanyPlan(id: string, planCode: PlanCode): Promise<AdminCompany | undefined>;
  suspendCompany(id: string, reason: string): Promise<AdminCompany | undefined>;
  restoreCompany(id: string): Promise<AdminCompany | undefined>;
  deleteCompany(id: string): Promise<boolean>;
  listAppointments(limit?: number): Promise<AdminAppointment[]>;
  listCalls(limit?: number): Promise<AdminCall[]>;
}

/**
 * Raised when Supabase rejects the suspension columns, which means the
 * 20261028190000_admin_company_controls migration has not been applied yet.
 */
export class AdminSchemaOutdatedError extends Error {
  constructor() {
    super(
      "Blokavimo funkcijai reikia pritaikyti migraciją " +
        "supabase/migrations/20261028190000_admin_company_controls.sql.",
    );
    this.name = "AdminSchemaOutdatedError";
  }
}

interface SupabaseAdminConfig {
  url: string;
  key: string;
}

interface CompanyRow {
  id: string;
  name: string;
  owner_id: string;
  address?: string | null;
  phone?: string | null;
  plan_code?: string | null;
  paid_at?: string | null;
  suspended_at?: string | null;
  suspended_reason?: string | null;
  created_at: string;
  appointments?: Array<{ count?: number }>;
  business_calls?: Array<{ count?: number }>;
  business_services?: Array<{ count?: number }>;
  specialists?: Array<{ count?: number }>;
}

interface AuthUserRow {
  id: string;
  email?: string | null;
}

interface AppointmentRow {
  id: string;
  company_id: string;
  customer_name: string;
  customer_phone: string;
  service_name: string;
  specialist_id?: string | null;
  starts_at: string;
  ends_at: string;
  status: string;
  created_at: string;
  companies?: { name?: string | null } | null;
}

interface CallRow {
  id: string;
  company_id: string;
  customer_name: string;
  customer_phone: string;
  summary: string;
  status: string;
  created_at: string;
  companies?: { name?: string | null } | null;
}

const COMPANY_COLUMNS = "id,name,owner_id,address,phone,plan_code,paid_at,suspended_at,suspended_reason,created_at,appointments(count),business_calls(count),business_services(count),specialists(count)";
const LEGACY_COMPANY_COLUMNS = "id,name,owner_id,address,phone,plan_code,paid_at,created_at,appointments(count),business_calls(count),business_services(count),specialists(count)";

/**
 * Server-only Supabase client for the administrator dashboard. It deliberately
 * uses the secret key, so it must never be imported into browser code.
 */
export class SupabaseAdmin implements AdminDataSource {
  constructor(
    private readonly config: SupabaseAdminConfig,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async overview(): Promise<{ stats: AdminStats; companies: AdminCompany[] }> {
    const [companies, users, appointments, calls, services, specialists] = await Promise.all([
      this.listCompanies(),
      this.users().catch(() => [] as AuthUserRow[]),
      this.count("appointments"),
      this.count("business_calls"),
      this.count("business_services"),
      this.count("specialists"),
    ]);

    return {
      stats: {
        companies: companies.length,
        users: users.length,
        appointments,
        calls,
        services,
        specialists,
        paidCompanies: companies.filter((company) => company.planCode !== "pending").length,
        suspendedCompanies: companies.filter((company) => company.suspendedAt !== null).length,
      },
      companies,
    };
  }

  async listCompanies(): Promise<AdminCompany[]> {
    const [rows, users] = await Promise.all([
      this.companyRows("&order=created_at.desc&limit=500"),
      this.users().catch(() => [] as AuthUserRow[]),
    ]);
    const emails = new Map(users.map((user) => [user.id, user.email ?? null]));
    return rows.map((row) => this.toCompany(row, emails.get(row.owner_id) ?? null));
  }

  async updateCompanyPlan(id: string, planCode: PlanCode): Promise<AdminCompany | undefined> {
    const changed = await this.json<Array<{ id: string }>>(
      `/rest/v1/companies?id=eq.${encodeURIComponent(id)}&select=id`,
      {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({
          plan_code: planCode,
          paid_at: planCode === "pending" ? null : new Date().toISOString(),
        }),
      },
    );
    if (!changed[0]) return undefined;

    return this.company(id);
  }

  async suspendCompany(id: string, reason: string): Promise<AdminCompany | undefined> {
    const changed = await this.patchCompany(id, {
      suspended_at: new Date().toISOString(),
      suspended_reason: reason.trim().slice(0, 500),
    });
    if (!changed[0]) return undefined;

    return this.company(id);
  }

  async restoreCompany(id: string): Promise<AdminCompany | undefined> {
    const changed = await this.patchCompany(id, { suspended_at: null, suspended_reason: "" });
    if (!changed[0]) return undefined;

    return this.company(id);
  }

  async deleteCompany(id: string): Promise<boolean> {
    const deleted = await this.json<Array<{ id: string }>>(
      `/rest/v1/companies?id=eq.${encodeURIComponent(id)}&select=id`,
      { method: "DELETE", headers: { Prefer: "return=representation" } },
    );
    return Array.isArray(deleted) && deleted.length > 0;
  }

  private async patchCompany(
    id: string,
    fields: Record<string, unknown>,
  ): Promise<Array<{ id: string }>> {
    try {
      return await this.json<Array<{ id: string }>>(
        `/rest/v1/companies?id=eq.${encodeURIComponent(id)}&select=id`,
        {
          method: "PATCH",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify(fields),
        },
      );
    } catch (error) {
      if (error instanceof Error && error.message.includes("HTTP 400")) {
        throw new AdminSchemaOutdatedError();
      }
      throw error;
    }
  }

  private async company(id: string): Promise<AdminCompany | undefined> {
    const [rows, users] = await Promise.all([
      this.companyRows(`&id=eq.${encodeURIComponent(id)}&limit=1`),
      this.users().catch(() => [] as AuthUserRow[]),
    ]);
    const row = rows[0];
    if (!row) return undefined;
    return this.toCompany(row, users.find((user) => user.id === row.owner_id)?.email ?? null);
  }

  /**
   * Reads companies with the suspension columns. Before the
   * 20261028190000_admin_company_controls migration is applied, Supabase
   * rejects those columns, so fall back to the original set and treat every
   * business as active instead of failing the whole dashboard.
   */
  private async companyRows(suffix: string): Promise<CompanyRow[]> {
    try {
      return await this.json<CompanyRow[]>(`/rest/v1/companies?select=${COMPANY_COLUMNS}${suffix}`);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("HTTP 400")) throw error;
      return this.json<CompanyRow[]>(`/rest/v1/companies?select=${LEGACY_COMPANY_COLUMNS}${suffix}`);
    }
  }

  async listAppointments(limit = 100): Promise<AdminAppointment[]> {
    const rows = await this.json<AppointmentRow[]>(
      `/rest/v1/appointments?select=*,companies(name)&order=starts_at.desc&limit=${safeLimit(limit)}`,
    );
    return rows.map((row) => ({
      id: row.id,
      companyId: row.company_id,
      companyName: row.companies?.name?.trim() || "—",
      customerName: row.customer_name,
      customerPhone: row.customer_phone,
      serviceName: row.service_name,
      specialistId: row.specialist_id ?? null,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      status: row.status,
      createdAt: row.created_at,
    }));
  }

  async listCalls(limit = 100): Promise<AdminCall[]> {
    const rows = await this.json<CallRow[]>(
      `/rest/v1/business_calls?select=*,companies(name)&order=created_at.desc&limit=${safeLimit(limit)}`,
    );
    return rows.map((row) => ({
      id: row.id,
      companyId: row.company_id,
      companyName: row.companies?.name?.trim() || "—",
      customerName: row.customer_name,
      customerPhone: row.customer_phone,
      summary: row.summary,
      status: row.status,
      createdAt: row.created_at,
    }));
  }

  private toCompany(row: CompanyRow, ownerEmail: string | null): AdminCompany {
    return {
      id: row.id,
      name: row.name,
      ownerId: row.owner_id,
      ownerEmail,
      address: row.address ?? "",
      phone: row.phone ?? "",
      planCode: isPlanCode(row.plan_code) ? row.plan_code : "pending",
      paidAt: row.paid_at ?? null,
      suspendedAt: row.suspended_at ?? null,
      suspendedReason: row.suspended_reason ?? "",
      createdAt: row.created_at,
      appointments: embeddedCount(row.appointments),
      calls: embeddedCount(row.business_calls),
      services: embeddedCount(row.business_services),
      specialists: embeddedCount(row.specialists),
    };
  }

  private async users(): Promise<AuthUserRow[]> {
    const users: AuthUserRow[] = [];
    const perPage = 1000;
    for (let page = 1; page <= 20; page += 1) {
      const body = await this.json<{ users?: AuthUserRow[] }>(
        `/auth/v1/admin/users?page=${page}&per_page=${perPage}`,
      );
      const batch = Array.isArray(body.users) ? body.users : [];
      users.push(...batch);
      if (batch.length < perPage) break;
    }
    return users;
  }

  private async count(table: string): Promise<number> {
    const response = await this.request(`/rest/v1/${table}?select=id&limit=1`, {
      method: "HEAD",
      headers: { Prefer: "count=exact" },
    });
    const value = response.headers.get("content-range")?.split("/")[1];
    const count = value ? Number(value) : 0;
    return Number.isFinite(count) ? count : 0;
  }

  private async json<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.request(path, init);
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const response = await this.fetcher(`${this.config.url.replace(/\/+$/, "")}${path}`, {
      ...init,
      headers: {
        apikey: this.config.key,
        Authorization: `Bearer ${this.config.key}`,
        Accept: "application/json",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      // Never echo the remote body: it can contain customer data.
      throw new Error(`Supabase administratoriaus užklausa nepavyko (HTTP ${response.status}).`);
    }
    return response;
  }
}

function embeddedCount(value: Array<{ count?: number }> | undefined): number {
  const count = value?.[0]?.count;
  return typeof count === "number" && Number.isFinite(count) ? count : 0;
}

function safeLimit(limit: number): number {
  return Number.isInteger(limit) && limit >= 1 && limit <= 500 ? limit : 100;
}
