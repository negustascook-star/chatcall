/** Domain model of the AIcall demo workshop. Everything here is fictional demo data. */

export type RepairKind = "service" | "inspection" | "repair";

export interface Mechanic {
  id: string;
  name: string;
  role: string;
  skills: string[];
  /** 0 = Sunday … 6 = Saturday */
  workDays: number[];
}

export interface Customer {
  id: string;
  name: string;
  phone: string;
  email: string;
  notes: string;
  createdAt: string;
  demo: true;
}

export interface Vehicle {
  id: string;
  customerId: string;
  make: string;
  model: string;
  year: number;
  reg: string;
  engine: string;
  fuel: string;
  mileage: number;
}

export interface CompatEntry {
  make: string;
  /** "*" matches every model of the make. */
  model: string;
  yearFrom: number;
  yearTo: number;
}

export interface SupplierOption {
  supplier: string;
  partNumber: string;
  unitPrice: number;
  leadDays: number;
}

export interface Part {
  id: string;
  sku: string;
  kind: string;
  name: string;
  compat: CompatEntry[];
  /** True when the compatibility list was verified by a human. */
  compatVerified: boolean;
  quantity: number;
  minStock: number;
  unitCost: number;
  supplier: string;
  leadDays: number;
}

export type JobStatus =
  | "requested"
  | "pending_inspection"
  | "awaiting_parts"
  | "scheduled"
  | "in_progress"
  | "ready"
  | "completed"
  | "cancelled";

export interface JobPart {
  kind: string;
  qty: number;
  /** Stock item this job draws from, once matched against inventory. */
  partId?: string;
  /** Units of that item currently held back for this job. */
  reservedQty?: number;
}

export interface Job {
  id: string;
  customerId: string;
  vehicleId: string;
  repairType: string;
  title: string;
  status: JobStatus;
  parts: JobPart[];
  laborHours: number;
  laborRate: number;
  estimate: number;
  finalCost?: number;
  notes: string;
  callId?: string;
  createdAt: string;
  completedAt?: string;
}

export type BookingStatus = "confirmed" | "pending" | "completed" | "cancelled" | "no_show";

export interface Booking {
  id: string;
  customerId: string;
  vehicleId: string;
  jobId: string;
  mechanicId: string;
  date: string;
  start: string;
  durationMin: number;
  kind: RepairKind;
  repairType: string;
  status: BookingStatus;
  reportedIssue: string;
  aiAssessment: string;
  notes: string;
  source: "ai_call" | "manual" | "seed";
  callId?: string;
  createdAt: string;
}

export type CallStatus = "completed" | "missed" | "new_inquiry" | "follow_up";

export interface TranscriptLine {
  role: "customer" | "ai" | "system";
  text: string;
}

export interface Call {
  id: string;
  customerId?: string;
  name: string;
  phone: string;
  date: string;
  time: string;
  durationSec: number;
  status: CallStatus;
  vehicle: string;
  reason: string;
  summary: string;
  requested: string;
  estimate?: number;
  appointmentStatus: string;
  followUp: string;
  missingParts: string;
  transcript: TranscriptLine[];
  bookingId?: string;
  jobId?: string;
  /** False while the call still needs staff attention (e.g. a missed call with an open callback task). */
  resolved: boolean;
  simulated: boolean;
}

export type RequestStatus =
  | "awaiting_verification"
  | "parts_required"
  | "awaiting_price_confirmation"
  | "awaiting_approval"
  | "approved"
  | "ordered"
  | "received"
  | "ready_for_repair"
  | "completed"
  | "cancelled";

export interface RequestLine {
  kind: string;
  description: string;
  partNumber: string;
  partId?: string;
  qty: number;
  inStock: number;
  shortfall: number;
  compat: "confirmed" | "uncertain";
  options: SupplierOption[];
  chosen: number;
  unitPrice: number;
  leadDays: number;
  etaDate: string;
  priceSource: string;
  priceAt: string;
  received: boolean;
}

export interface PartsRequest {
  id: string;
  jobId: string;
  customerId: string;
  vehicleId: string;
  status: RequestStatus;
  approval: "pending" | "approved" | "rejected";
  lines: RequestLine[];
  total: number;
  notes: string;
  createdAt: string;
  history: { at: string; text: string }[];
}

export interface Movement {
  id: string;
  partId: string;
  at: string;
  delta: number;
  reason: string;
  ref?: string;
}

export interface Task {
  id: string;
  text: string;
  due: string;
  done: boolean;
  callId?: string;
  jobId?: string;
  createdAt: string;
}

export interface AgentStep {
  id: string;
  label: string;
  status: "done" | "warn" | "info" | "pending";
  detail: string;
}

export interface SlotOption {
  id: string;
  label: string;
  note?: string;
  bookings: {
    kind: RepairKind;
    repairType: string;
    date: string;
    start: string;
    durationMin: number;
    mechanicId: string;
    status: BookingStatus;
  }[];
}

export interface AgentSession {
  id: string;
  createdAt: string;
  scenario?: string;
  stage: "collecting" | "offering" | "confirmed" | "ended";
  asked?: string[];
  awaiting?: "issue" | "symptoms" | "name" | "phone" | "vehicle" | "followup_offer" | "pick";
  intent?: "new" | "follow_up";
  input: {
    name?: string;
    phone?: string;
    make?: string;
    model?: string;
    year?: number;
    reg?: string;
    issue?: string;
    preferredDate?: string;
    preferredTime?: string;
    preferredMechanicId?: string;
  };
  customerId?: string;
  vehicleId?: string;
  steps: AgentStep[];
  transcript: TranscriptLine[];
  options: SlotOption[];
  plan?: AgentPlan;
  result?: AgentResult;
  followUpJobId?: string;
  simulatedNotice: string;
}

export interface AgentPlan {
  intent: "service" | "inspection" | "repair" | "follow_up";
  repairType: string;
  likelyRepairType?: string;
  symptoms: string[];
  issueText: string;
  parts: PartCheck[];
  missing: PartCheck[];
  etaDate?: string;
  estimate: number;
  inspectionFee?: number;
  laborHours: number;
  assessment: string;
  conflictNote?: string;
}

export interface PartCheck {
  kind: string;
  description: string;
  qty: number;
  partId?: string;
  partName?: string;
  stock: number;
  reserved: number;
  available: number;
  shortfall: number;
  compat: "confirmed" | "uncertain";
  note: string;
}

export interface AgentResult {
  callId: string;
  customerId: string;
  vehicleId: string;
  jobId: string;
  bookingIds: string[];
  requestId?: string;
  taskIds: string[];
  actions: string[];
}

export interface DemoState {
  version: number;
  seededAt: string;
  generatedThrough: string;
  secret: string;
  counters: Record<string, number>;
  scenarioRefs: Record<string, string>;
  mechanics: Mechanic[];
  customers: Customer[];
  vehicles: Vehicle[];
  parts: Part[];
  jobs: Job[];
  bookings: Booking[];
  calls: Call[];
  requests: PartsRequest[];
  movements: Movement[];
  tasks: Task[];
  sessions: AgentSession[];
}
