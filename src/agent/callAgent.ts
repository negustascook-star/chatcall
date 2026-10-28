import { randomUUID } from "node:crypto";
import path from "node:path";
import type {
  CallResult,
  CallSession,
  CallState,
  CallSummary,
  TenantContext,
} from "../domain/types.js";
import { CallStore, type SavedCall } from "../calls/callStore.js";
import { InventoryService } from "../inventory/inventoryService.js";
import { KnowledgeService } from "../knowledge/knowledgeService.js";
import { RequestService } from "../requests/requestService.js";
import { TenantRepository } from "../tenants/tenantRepository.js";
import type { BrainFactory, ConversationBrain } from "./brain.js";
import { RuleBasedBrain } from "./ruleBrain.js";
import { buildCallSummary } from "./summary.js";

export interface CallAgentDeps {
  dataDir: string;
  tenants?: TenantRepository;
  inventory?: InventoryService;
  knowledge?: KnowledgeService;
  requests?: RequestService;
  calls?: CallStore;
  brainFactory?: BrainFactory;
  now?: () => Date;
}

export interface StartCallInput {
  tenantId?: string;
  to?: string;
  from?: string;
  channel?: "text" | "phone";
}

export interface EndCallResult {
  callId: string;
  summary: CallSummary;
  jsonPath: string;
  mdPath: string;
  ended: true;
  transferred: boolean;
}

interface ActiveCall {
  session: CallSession;
  brain: ConversationBrain;
  tenant: TenantContext;
  saved?: SavedCall;
}

export class CallNotFoundError extends Error {
  constructor(callId: string) {
    super(`Call "${callId}" not found`);
    this.name = "CallNotFoundError";
  }
}

export class CallEndedError extends Error {
  constructor(callId: string) {
    super(`Call "${callId}" has already ended`);
    this.name = "CallEndedError";
  }
}

export class CallAgent {
  private readonly tenants: TenantRepository;
  private readonly inventory: InventoryService;
  private readonly knowledge: KnowledgeService;
  private readonly requests: RequestService;
  private readonly calls: CallStore;
  private readonly brainFactory: BrainFactory;
  private readonly now: () => Date;
  private readonly active = new Map<string, ActiveCall>();

  constructor(deps: CallAgentDeps) {
    const dataDir = path.resolve(deps.dataDir);
    this.tenants = deps.tenants ?? new TenantRepository(dataDir);
    this.inventory = deps.inventory ?? new InventoryService();
    this.knowledge = deps.knowledge ?? new KnowledgeService();
    this.requests = deps.requests ?? new RequestService(dataDir);
    this.calls = deps.calls ?? new CallStore(dataDir);
    this.brainFactory =
      deps.brainFactory ??
      ((ctx, brainDeps) => new RuleBasedBrain(ctx, brainDeps));
    this.now = deps.now ?? (() => new Date());
  }

  async startCall(input: StartCallInput): Promise<CallResult> {
    const tenant = await this.resolveTenant(input);
    const now = this.now();
    const callId = `call_${randomUUID()}`;
    const state: CallState = {
      phase: "discover",
      notes: [],
      unknownTurns: 0,
    };

    const session: CallSession = {
      id: callId,
      tenantId: tenant.tenant.id,
      channel: input.channel ?? "text",
      from: input.from,
      to: input.to ?? tenant.tenant.phone,
      status: "active",
      startedAt: now.toISOString(),
      messages: [],
      state,
      toolEvents: [],
      requestIds: [],
    };

    const brain = this.brainFactory(tenant, {
      inventory: this.inventory,
      knowledge: this.knowledge,
      requests: this.requests,
      callId,
      now: this.now,
    });

    const greeting = brain.greeting();
    session.messages.push({
      role: "assistant",
      text: greeting,
      at: now.toISOString(),
    });

    this.active.set(callId, { session, brain, tenant });

    return {
      callId,
      reply: greeting,
      state,
      ended: false,
      transferred: false,
      toolEvents: [],
    };
  }

  async handleMessage(callId: string, text: string): Promise<CallResult> {
    const active = this.active.get(callId);
    if (!active) throw new CallNotFoundError(callId);
    if (active.session.status !== "active") throw new CallEndedError(callId);

    const at = this.now().toISOString();
    active.session.messages.push({ role: "user", text, at });

    const result = await active.brain.respond(text, active.session.state);
    active.session.state = result.state;
    active.session.toolEvents.push(...result.events);
    active.session.messages.push({
      role: "assistant",
      text: result.reply,
      at: this.now().toISOString(),
    });

    if (
      result.state.requestId &&
      !active.session.requestIds.includes(result.state.requestId)
    ) {
      active.session.requestIds.push(result.state.requestId);
    }

    let saved: SavedCall | undefined;
    if (result.end) {
      saved = await this.finish(active, result.transferred ? "transferred" : "ended");
    }

    return {
      callId,
      reply: result.reply,
      state: result.state,
      ended: Boolean(result.end),
      transferred: Boolean(result.transferred),
      requestId: result.state.requestId,
      toolEvents: result.events,
      ...(saved ? { transcriptPath: saved.mdPath } : {}),
    };
  }

  async endCall(callId: string): Promise<EndCallResult> {
    const active = this.active.get(callId);
    if (!active) throw new CallNotFoundError(callId);

    if (!active.saved) {
      if (active.session.status === "active") {
        active.session.status = "ended";
      }
      active.session.endedAt ??= this.now().toISOString();
      active.session.summary ??= buildCallSummary(active.session, active.tenant.tenant);
      active.saved = await this.calls.save(active.session, active.tenant.tenant);
    }

    if (!active.session.summary) {
      active.session.summary = buildCallSummary(active.session, active.tenant.tenant);
    }

    return {
      callId,
      summary: active.session.summary,
      jsonPath: active.saved.jsonPath,
      mdPath: active.saved.mdPath,
      ended: true,
      transferred: active.session.status === "transferred",
    };
  }

  getSession(callId: string): CallSession | undefined {
    return this.active.get(callId)?.session;
  }

  private async resolveTenant(input: StartCallInput): Promise<TenantContext> {
    if (input.tenantId) {
      return this.tenants.getOrThrow(input.tenantId);
    }

    if (input.to) {
      const tenant = await this.tenants.findByPhone(input.to);
      if (!tenant) {
        throw new Error(`No tenant is configured for phone number "${input.to}"`);
      }
      return tenant;
    }

    const tenants = await this.tenants.list();
    if (tenants.length === 1) return tenants[0]!;
    throw new Error(
      "Cannot choose a tenant: pass tenantId or the called number (to).",
    );
  }

  private async finish(
    active: ActiveCall,
    status: "ended" | "transferred",
  ): Promise<SavedCall> {
    if (active.saved) return active.saved;

    active.session.status = status;
    active.session.endedAt ??= this.now().toISOString();
    active.session.summary = buildCallSummary(active.session, active.tenant.tenant);
    active.saved = await this.calls.save(active.session, active.tenant.tenant);
    return active.saved;
  }
}
