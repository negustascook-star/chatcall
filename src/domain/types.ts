export type TireSeason = "winter" | "summer" | "all_season";

export interface Tenant {
  id: string;
  name: string;
  legalName?: string;
  phone: string;
  greeting: string;
  language: string;
  timezone: string;
  address: string;
  hours: string;
  transferPhone?: string;
  email?: string;
}

export interface Service {
  id: string;
  name: string;
  description?: string;
  priceFrom?: number;
  priceTo?: number;
  priceUnit?: string;
  durationMinutes?: number;
  keywords: string[];
}

export interface InventoryItem {
  sku: string;
  category: "tire" | "part" | "accessory";
  brand: string;
  model: string;
  size?: string;
  season?: TireSeason;
  quantity: number;
  price: number;
  currency: string;
  location?: string;
  keywords?: string[];
}

export interface FaqEntry {
  id: string;
  question: string;
  answer: string;
  keywords: string[];
}

export interface TenantContext {
  tenant: Tenant;
  services: Service[];
  inventory: InventoryItem[];
  faq: FaqEntry[];
}

export type ChatRole = "assistant" | "user" | "system";

export interface ChatMessage {
  role: ChatRole;
  text: string;
  at: string;
}

export type CallIntent = "tires" | "service" | "faq" | "human" | "other";

export type CallPhase =
  | "discover"
  | "tire_size"
  | "tire_season"
  | "tire_preferences"
  | "tire_offer"
  | "service_time"
  | "contact_name"
  | "contact_phone"
  | "booking_time"
  | "closing"
  | "transferred";

export interface OfferedItem {
  sku: string;
  label: string;
  quantity: number;
  unitPrice: number;
  currency: string;
}

export interface CallState {
  phase: CallPhase;
  intent?: CallIntent;
  customerName?: string;
  phone?: string;
  vehicle?: string;
  tireSize?: string;
  season?: TireSeason;
  brandPreference?: string;
  budget?: number;
  quantity?: number;
  service?: string;
  preferredTime?: string;
  notes: string[];
  offer?: OfferedItem[];
  inStock?: boolean;
  pendingRequestType?: RequestType;
  requestId?: string;
  transferReason?: string;
  awaitingHumanConfirmation?: boolean;
  unknownTurns: number;
}

export interface StockQuery {
  size?: string;
  season?: TireSeason;
  brand?: string;
  quantity?: number;
  text?: string;
}

export interface StockMatch {
  item: InventoryItem;
  /** True when the requested quantity is available right now. */
  available: boolean;
}

export interface StockResult {
  query: StockQuery;
  matches: StockMatch[];
  /** Same size but a different season, or a different profile of the same diameter. */
  alternatives: StockMatch[];
}

export type RequestType = "parts_order" | "service_booking" | "callback";
export type RequestStatus = "new" | "pending_confirmation" | "transferred";

export interface RequestItem {
  sku?: string;
  description: string;
  size?: string;
  season?: TireSeason;
  brandPreference?: string;
  quantity: number;
  unitPrice?: number;
  currency?: string;
  inStock: boolean;
}

export interface CustomerRequest {
  id: string;
  tenantId: string;
  callId: string;
  type: RequestType;
  status: RequestStatus;
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
  source: "ai_call";
  createdAt: string;
}

export type ToolName =
  | "check_stock"
  | "list_services"
  | "get_business_info"
  | "create_request"
  | "transfer_to_human"
  | "end_call";

export interface ToolEvent {
  tool: ToolName;
  ok: boolean;
  at: string;
  data?: unknown;
  error?: string;
}

export interface CallSummary {
  text: string;
  outcome: string;
  nextAction: string;
}

export type CallStatus = "active" | "ended" | "transferred";

export interface CallSession {
  id: string;
  tenantId: string;
  channel: "text" | "phone";
  from?: string;
  to?: string;
  status: CallStatus;
  startedAt: string;
  endedAt?: string;
  messages: ChatMessage[];
  state: CallState;
  toolEvents: ToolEvent[];
  requestIds: string[];
  summary?: CallSummary;
}

export interface CallResult {
  callId: string;
  reply: string;
  state: CallState;
  ended: boolean;
  transferred: boolean;
  requestId?: string;
  toolEvents: ToolEvent[];
  transcriptPath?: string;
}
