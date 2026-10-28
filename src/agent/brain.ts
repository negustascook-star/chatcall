import type {
  CallState,
  TenantContext,
  ToolEvent,
} from "../domain/types.js";
import type { InventoryService } from "../inventory/inventoryService.js";
import type { KnowledgeService } from "../knowledge/knowledgeService.js";
import type { RequestService } from "../requests/requestService.js";

export interface BrainResponse {
  reply: string;
  state: CallState;
  events: ToolEvent[];
  end?: boolean;
  transferred?: boolean;
}

export interface ConversationBrain {
  greeting(): string;
  respond(text: string, state: CallState): Promise<BrainResponse>;
}

export interface BrainDeps {
  inventory: InventoryService;
  knowledge: KnowledgeService;
  requests: RequestService;
  callId: string;
  now: () => Date;
}

export type BrainFactory = (ctx: TenantContext, deps: BrainDeps) => ConversationBrain;
