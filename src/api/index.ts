import path from "node:path";
import { existsSync } from "node:fs";
import { CallAgent } from "../agent/callAgent.js";
import { SupabaseAdmin } from "../supabase/admin.js";
import { SupabaseCatalog, readSupabaseConfig } from "../supabase/catalog.js";
import { TenantRepository } from "../tenants/tenantRepository.js";
import { DEMO_EMAIL, DEMO_PASSWORD_DEFAULT, DemoAuth, DemoStore, createDemoApi } from "../demo/api.js";
import { createApiServer } from "./server.js";

if (existsSync(".env")) {
  if (typeof process.loadEnvFile !== "function") {
    throw new Error(".env įkėlimui reikia Node.js 20.12 arba naujesnio.");
  }
  process.loadEnvFile();
}

const dataDir = path.resolve(process.env.DATA_DIR ?? path.join(process.cwd(), "data"));
const port = Number(process.env.PORT ?? 3000);

if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  console.error(`Neteisingas PORT: ${process.env.PORT}`);
  process.exit(1);
}

const supabase = readSupabaseConfig();
const catalogSource = supabase ? "supabase" : "json";
const tenants = new TenantRepository(dataDir, supabase ? {
  catalog: new SupabaseCatalog(supabase),
  catalogTenantId: supabase.tenantId,
} : {});
const agent = new CallAgent({ dataDir, tenants });
const websiteFile = path.resolve(process.cwd(), "index.html");
const publicKey = process.env.SUPABASE_PUBLISHABLE_KEY?.trim() || process.env.SUPABASE_ANON_KEY?.trim();
const supabaseUrl = process.env.SUPABASE_URL?.trim();
const configuredAdminKey = process.env.ADMIN_KEY?.trim();
// Keep the requested demo key working on a fresh deployment. Production should
// always override this with a long random ADMIN_KEY in Render.
const adminKey = configuredAdminKey || "ADMIN123";
const secretKey = process.env.SUPABASE_SECRET_KEY?.trim() || process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
// The admin dashboard is optional. Its Supabase client stays on the server and
// is only created when both the URL and the secret key are configured.
const admin = supabaseUrl && secretKey
  ? new SupabaseAdmin({ url: supabaseUrl, key: secretKey })
  : undefined;
const configuredWarehousePrice = process.env.WAREHOUSE_PLAN_PRICE_EUR?.trim();
const warehousePlanPriceEur = configuredWarehousePrice && /^\d+(\.\d{1,2})?$/.test(configuredWarehousePrice)
  ? Number(configuredWarehousePrice)
  : undefined;
const validWarehousePrice = warehousePlanPriceEur && warehousePlanPriceEur > 200 ? warehousePlanPriceEur : undefined;
// Demo client portal: in-memory sample data (re-seeded at every start). It never touches
// Supabase or real tenants. DEMO_PASSWORD may override the published demo password.
const demoStore = DemoStore.open();
const demoAuth = new DemoAuth(DEMO_EMAIL, process.env.DEMO_PASSWORD?.trim() || DEMO_PASSWORD_DEFAULT);
const server = createApiServer({
  demo: createDemoApi(demoStore, demoAuth),
  dataDir, agent, tenants, catalogSource, websiteFile, supabaseUrl,
  // This must be a browser-safe publishable/anon key. Never expose the secret key.
  supabasePublicKey: publicKey,
  warehousePlanPriceEur: validWarehousePrice,
  adminKey,
  admin,
});

server.listen(port, () => {
  console.log(`Chatcall API veikia: http://localhost:${port}`);
  console.log(`Duomenų katalogas: ${dataDir}`);
  console.log(`Paslaugų ir sandėlio šaltinis: ${catalogSource}`);
  console.log(`Administratoriaus panelė: ${adminKey && admin ? "įjungta (/admin)" : "neįjungta"}`);
  if (!configuredAdminKey) {
    console.warn("ADMIN_KEY nenustatytas – naudojamas numatytasis demonstracinis raktas. Produkcijoje nustatykite savo ADMIN_KEY.");
  }
  console.log("Demo portalas: /demo");
  console.log("Sveikatos patikra: GET /health");
});

function shutdown(): void {
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
