import path from "node:path";
import type { FaqEntry, InventoryItem, Service, Tenant, TenantContext } from "../domain/types.js";
import { listDirectories, readJsonIfExists } from "../lib/jsonStore.js";
import { normalizePhone } from "../lib/text.js";
import type { TenantCatalogSource } from "../supabase/catalog.js";

export interface TenantRepositoryOptions {
  catalog?: TenantCatalogSource;
  catalogTenantId?: string;
}

export class TenantRepository {
  private readonly tenantsDir: string;

  constructor(dataDir: string, private readonly options: TenantRepositoryOptions = {}) {
    this.tenantsDir = path.join(path.resolve(dataDir), "tenants");
    if (options.catalog && !options.catalogTenantId) {
      throw new Error("Supabase katalogui nurodykite catalogTenantId.");
    }
  }

  async list(): Promise<TenantContext[]> {
    const ids = await listDirectories(this.tenantsDir);
    const tenants = await Promise.all(ids.map((id) => this.get(id)));
    return tenants.filter((tenant): tenant is TenantContext => tenant !== undefined);
  }

  async get(id: string): Promise<TenantContext | undefined> {
    const directory = path.join(this.tenantsDir, id);
    const tenant = await readJsonIfExists<Tenant>(path.join(directory, "tenant.json"));
    if (!tenant) return undefined;

    validateTenant(tenant, directory);
    if (tenant.id !== id) {
      throw new Error(`Tenant "${id}" has mismatched id "${tenant.id}" in tenant.json`);
    }

    const [catalog, faq] = await Promise.all([
      this.options.catalog && id === this.options.catalogTenantId
        ? this.options.catalog.load()
        : this.readFileCatalog(directory),
      readJsonIfExists<FaqEntry[]>(path.join(directory, "faq.json")),
    ]);

    return {
      tenant,
      services: catalog.services,
      inventory: catalog.inventory,
      faq: faq ?? [],
    };
  }

  private async readFileCatalog(directory: string): Promise<Pick<TenantContext, "services" | "inventory">> {
    const [services, inventory] = await Promise.all([
      readJsonIfExists<Service[]>(path.join(directory, "services.json")),
      readJsonIfExists<InventoryItem[]>(path.join(directory, "inventory.json")),
    ]);
    return { services: services ?? [], inventory: inventory ?? [] };
  }

  async getOrThrow(id: string): Promise<TenantContext> {
    const tenant = await this.get(id);
    if (!tenant) {
      throw new Error(`Unknown tenant "${id}". Check data/tenants/${id}/tenant.json`);
    }
    return tenant;
  }

  async findByPhone(phone: string): Promise<TenantContext | undefined> {
    const requested = normalizePhone(phone);
    if (!requested) return undefined;

    const tenants = await this.list();
    return tenants.find(({ tenant }) => normalizePhone(tenant.phone) === requested);
  }
}

function validateTenant(tenant: Tenant, directory: string): void {
  const required: Array<keyof Tenant> = [
    "id",
    "name",
    "phone",
    "greeting",
    "language",
    "timezone",
    "address",
    "hours",
  ];

  for (const field of required) {
    if (!tenant[field] || typeof tenant[field] !== "string") {
      throw new Error(`Tenant config ${path.join(directory, "tenant.json")} is missing "${field}"`);
    }
  }
}
