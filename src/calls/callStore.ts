import path from "node:path";
import type { CallSession, Tenant } from "../domain/types.js";
import { dateFolder, timeLabel } from "../lib/text.js";
import { writeJsonAtomic, writeTextAtomic } from "../lib/jsonStore.js";

export interface SavedCall {
  jsonPath: string;
  mdPath: string;
}

export class CallStore {
  private readonly dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = path.resolve(dataDir);
  }

  async save(session: CallSession, tenant: Tenant): Promise<SavedCall> {
    const date = dateFolder(tenant.timezone, new Date(session.startedAt));
    const folder = path.join(this.dataDir, "tenants", tenant.id, "calls", date);
    const jsonPath = path.join(folder, `${session.id}.json`);
    const mdPath = path.join(folder, `${session.id}.md`);

    await Promise.all([
      writeJsonAtomic(jsonPath, session),
      writeTextAtomic(mdPath, renderTranscript(session, tenant)),
    ]);

    return { jsonPath, mdPath };
  }
}

function renderTranscript(session: CallSession, tenant: Tenant): string {
  const start = new Date(session.startedAt);
  const end = session.endedAt ? new Date(session.endedAt) : undefined;
  const duration = end ? Math.max(0, Math.round((end.getTime() - start.getTime()) / 1000)) : 0;
  const lines: string[] = [];

  lines.push(`# Skambutis ${session.id}`, "");
  lines.push(`- **Įmonė:** ${tenant.name}`);
  lines.push(`- **Data:** ${dateFolder(tenant.timezone, start)} ${timeLabel(tenant.timezone, start)}`);
  lines.push(`- **Kanalas:** ${session.channel === "phone" ? "telefonas" : "tekstas"}`);
  if (session.from) lines.push(`- **Skambinantis:** ${session.from}`);
  lines.push(`- **Būsena:** ${session.status}`);
  lines.push(`- **Trukmė:** ${formatDuration(duration)}`);
  if (session.requestIds.length > 0) {
    lines.push(`- **Poreikiai:** ${session.requestIds.join(", ")}`);
  }
  lines.push("");

  if (session.summary) {
    lines.push("## Santrauka", "", session.summary.text, "");
    lines.push(`**Rezultatas:** ${session.summary.outcome}`, "");
    lines.push(`**Kitas veiksmas:** ${session.summary.nextAction}`, "");
  }

  lines.push("## Pokalbis", "");
  for (const message of session.messages) {
    const speaker =
      message.role === "assistant" ? "Botas" : message.role === "user" ? "Klientas" : "Sistema";
    lines.push(`**${speaker}:** ${message.text.replace(/\s+/g, " ").trim()}`, "");
  }

  return `${lines.join("\n")}\n`;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds} sek.`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest > 0 ? `${minutes} min. ${rest} sek.` : `${minutes} min.`;
}
