import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CallAgent } from "../src/agent/callAgent.js";
import { RequestService } from "../src/requests/requestService.js";

export const FIXED_NOW = new Date("2026-10-28T12:00:00.000Z");

export async function createHarness(tenantIds: string[] = ["demo-tire"]) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "chatcall-test-"));
  const source = path.resolve(process.cwd(), "data", "tenants");

  for (const id of tenantIds) {
    const target = path.join(dataDir, "tenants", id);
    await cp(path.join(source, id), target, {
      recursive: true,
    });
    await rm(path.join(target, "requests"), { recursive: true, force: true });
    await rm(path.join(target, "calls"), { recursive: true, force: true });
  }

  const agent = new CallAgent({
    dataDir,
    now: () => new Date(FIXED_NOW),
  });
  const requests = new RequestService(dataDir);

  return {
    dataDir,
    agent,
    requests,
    cleanup: async () => {
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

export async function addSecondTenant(
  dataDir: string,
  id = "demo-second",
  phone = "+370 700 00000",
): Promise<string> {
  const source = path.join(dataDir, "tenants", "demo-tire");
  const target = path.join(dataDir, "tenants", id);
  await cp(source, target, { recursive: true });

  const tenantPath = path.join(target, "tenant.json");
  const tenant = JSON.parse(await readFile(tenantPath, "utf8")) as {
    id: string;
    name: string;
    phone: string;
    greeting: string;
  };
  tenant.id = id;
  tenant.name = "Kauno servisas";
  tenant.phone = phone;
  tenant.greeting = "Sveiki, čia Kauno servisas. Kuo galiu padėti?";
  await writeFile(tenantPath, `${JSON.stringify(tenant, null, 2)}\n`, "utf8");

  return target;
}

export async function readJsonFile<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, "utf8")) as T;
}
