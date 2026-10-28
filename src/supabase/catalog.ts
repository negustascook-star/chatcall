import type { InventoryItem, Service, TenantContext, TireSeason } from "../domain/types.js";

export interface TenantCatalogSource {
  load(): Promise<Pick<TenantContext, "inventory" | "services">>;
}

export interface SupabaseCatalogConfig {
  url: string;
  key: string;
  tenantId: string;
}

/** The existing SQL describes one garage. Map it to one explicit tenant only. */
export function readSupabaseConfig(
  env: Record<string, string | undefined> = process.env,
): SupabaseCatalogConfig | undefined {
  const source = env.CATALOG_SOURCE?.trim() || "json";
  if (source === "json") return undefined;
  if (source !== "supabase") {
    throw new Error("CATALOG_SOURCE turi būti json arba supabase.");
  }

  const url = env.SUPABASE_URL?.trim();
  const key = env.SUPABASE_SECRET_KEY?.trim() || env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  const tenantId = env.SUPABASE_TENANT_ID?.trim() || "demo-tire";
  if (!url || !key) {
    throw new Error("Supabase režimui reikia SUPABASE_URL ir serverio SUPABASE_SECRET_KEY (arba SUPABASE_SERVICE_ROLE_KEY).");
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Netinkamas SUPABASE_URL.");
  }
  if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error("Netinkamas SUPABASE_URL.");
  }

  // Reject browser keys: RLS intentionally blocks direct access to this catalog.
  let legacyServiceRole = false;
  try {
    const payload = key.split(".")[1];
    legacyServiceRole = Boolean(payload && JSON.parse(Buffer.from(payload, "base64url").toString()).role === "service_role");
  } catch { /* A current sb_secret_ key is not a JWT. */ }
  if (!key.startsWith("sb_secret_") && !legacyServiceRole) {
    throw new Error("Naudokite serverio Secret key arba service_role raktą, o ne publishable / anon raktą.");
  }
  return { url: url.replace(/\/+$/, ""), key, tenantId };
}

/** Native fetch keeps credentials on the Node server; no browser SDK is needed. */
export class SupabaseCatalog implements TenantCatalogSource {
  constructor(
    private readonly config: SupabaseCatalogConfig,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async load(): Promise<Pick<TenantContext, "inventory" | "services">> {
    const [serviceRows, inventoryRows] = await Promise.all([
      this.rows("services", "id,name,duration_minutes,price_eur"),
      this.rows("inventory", "id,name,tyre_size,season,stock_quantity,stock_price_eur"),
    ]);

    const services: Service[] = serviceRows.map((row) => {
      const id = text(row.id, "services.id");
      const name = text(row.name, "services.name");
      const price = amount(row.price_eur, "services.price_eur");
      const duration = amount(row.duration_minutes, "services.duration_minutes");
      if (!Number.isInteger(duration) || duration <= 0) throw new Error("Netinkama Supabase paslaugos trukmė.");
      return {
        id, name, priceFrom: price, priceTo: price, priceUnit: "už paslaugą",
        durationMinutes: duration,
        keywords: id === "tyre_change" ? [name, "padangų keitimas", "montavimas", "balansavimas"] : [name],
      };
    });

    const inventory: InventoryItem[] = inventoryRows.map((row) => {
      const quantity = amount(row.stock_quantity, "inventory.stock_quantity");
      if (!Number.isInteger(quantity)) throw new Error("Netinkamas Supabase sandėlio kiekis.");
      if (!["winter", "summer", "all_season"].includes(String(row.season))) {
        throw new Error("Netinkamas Supabase padangų sezonas.");
      }
      return {
        sku: text(row.id, "inventory.id"),
        category: "tire",
        // The initial SQL has a product name rather than separate brand/model fields.
        brand: text(row.name, "inventory.name"),
        model: "",
        size: text(row.tyre_size, "inventory.tyre_size"),
        season: row.season as TireSeason,
        quantity,
        price: amount(row.stock_price_eur, "inventory.stock_price_eur"),
        currency: "EUR",
      };
    });
    return { services, inventory };
  }

  private async rows(table: "services" | "inventory", columns: string): Promise<Record<string, unknown>[]> {
    const rows: Record<string, unknown>[] = [];
    const pageSize = 1000;
    let offset = 0;
    while (true) {
      const url = new URL(`${this.config.url}/rest/v1/${table}`);
      url.searchParams.set("select", columns);
      url.searchParams.set("order", "id.asc");
      url.searchParams.set("offset", String(offset));
      url.searchParams.set("limit", String(pageSize));
      const headers: Record<string, string> = {
        apikey: this.config.key, Accept: "application/json", Prefer: "count=exact",
      };
      if (!this.config.key.startsWith("sb_secret_")) headers.Authorization = `Bearer ${this.config.key}`;
      const response = await this.fetcher(url, { headers, signal: AbortSignal.timeout(8000) });
      if (!response.ok) {
        // Do not echo the remote body or credentials into API responses/logs.
        throw new Error(`Supabase ${table} užklausa nepavyko (HTTP ${response.status}). Patikrinkite serverio raktą ir SQL lenteles.`);
      }
      const page: unknown = await response.json();
      if (!Array.isArray(page) || page.some((row) => !row || typeof row !== "object" || Array.isArray(row))) {
        throw new Error(`Supabase ${table} grąžino netinkamą atsakymą.`);
      }
      rows.push(...page as Record<string, unknown>[]);
      const total = response.headers.get("content-range")?.split("/")[1];
      if (page.length === 0 || (total && total !== "*" && rows.length >= Number(total))) break;
      // Even a short page may be capped below pageSize by the project's API settings.
      offset += page.length;
    }
    return rows;
  }
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Netinkamas Supabase laukas ${field}.`);
  return value.trim();
}

function amount(value: unknown, field: string): number {
  if ((typeof value !== "number" && typeof value !== "string") || String(value).trim() === "") {
    throw new Error(`Netinkamas Supabase laukas ${field}.`);
  }
  const result = Number(value);
  if (!Number.isFinite(result) || result < 0) throw new Error(`Netinkamas Supabase laukas ${field}.`);
  return result;
}
