import type {
  CallState,
  RequestItem,
  TenantContext,
  ToolEvent,
} from "../domain/types.js";
import {
  serviceDurationLabel,
  servicePriceLabel,
} from "../knowledge/knowledgeService.js";
import {
  extractBudget,
  extractName,
  extractPhone,
  extractPreferredTime,
  extractQuantity,
  extractSeason,
  extractTireSize,
  extractVehicle,
  findBrand,
  formatMoney,
  includesAny,
  isAffirmative,
  isGoodbye,
  isHumanRequest,
  isLikelyName,
  isNegative,
  isUnknownPreference,
  normalizeText,
  seasonGenitive,
  toNameCase,
} from "../lib/text.js";
import type { BrainDeps, BrainResponse, ConversationBrain } from "./brain.js";

const TIRE_WORDS = ["padang", "ziemin", "vasarin", "visasezon", "ratlank"];
const BUY_WORDS = [
  "pirkt",
  "nauj",
  "ieskau",
  "reiskia padang",
  "reikia padang",
  "parduodat",
  "turit padang",
  "kainuoja padang",
];
const QUESTION_START = /^(kiek|kada|kur|ar|kaip|koks|kokia|kodel|kodel|gal|kokios|kokiu)\b/;

export class RuleBasedBrain implements ConversationBrain {
  private readonly knownBrands: string[];

  constructor(
    private readonly ctx: TenantContext,
    private readonly deps: BrainDeps,
  ) {
    this.knownBrands = [...new Set(ctx.inventory.map((item) => item.brand))];
  }

  greeting(): string {
    const greeting = this.ctx.tenant.greeting.trim();
    return greeting.endsWith("?") ? greeting : `${greeting} Kuo galiu padėti?`;
  }

  async respond(userText: string, previousState: CallState): Promise<BrainResponse> {
    const state = cloneState(previousState);
    const events: ToolEvent[] = [];
    const text = userText.trim();

    if (!text) {
      return this.reply("Atsiprašau, nepagirdau. Pakartokite, prašau.", state, events);
    }

    if (isGoodbye(text)) {
      return this.close(state, events, "Klientas atsisveikino");
    }

    if (isHumanRequest(text)) {
      return this.transfer(state, text, events);
    }

    if (
      isNegative(text) &&
      (state.phase === "discover" || state.phase === "closing") &&
      !state.offer
    ) {
      return this.close(state, events, "Klientas atsisakė pagalbos");
    }

    this.applyEntities(state, text);

    if (state.awaitingHumanConfirmation) {
      if (isAffirmative(text)) {
        return this.transfer(state, "Klientas patvirtino operatoriaus perdavimą", events);
      }
      if (isNegative(text)) {
        state.awaitingHumanConfirmation = false;
        return this.reply("Gerai. Ar dar kuo galiu padėti?", state, events);
      }
      state.awaitingHumanConfirmation = false;
    }

    switch (state.phase) {
      case "tire_size":
        return this.handleTireSize(state, text, events);
      case "tire_season":
        return this.handleTireSeason(state, text, events);
      case "tire_preferences":
        return this.handleTirePreferences(state, text, events);
      case "tire_offer":
        return this.handleTireOffer(state, text, events);
      case "service_time":
        return this.handleServiceTime(state, text, events);
      case "contact_name":
        return this.handleContactName(state, text, events);
      case "contact_phone":
        return this.handleContactPhone(state, text, events);
      case "booking_time":
        return this.handleBookingTime(state, text, events);
      case "closing":
        return this.handleClosing(state, text, events);
      case "transferred":
        return this.reply("Pokalbis perduotas operatoriui. Palaukite, prašau.", state, events);
      case "discover":
        return this.handleDiscover(state, text, events);
    }
  }

  private handleDiscover(
    state: CallState,
    text: string,
    events: ToolEvent[],
  ): BrainResponse | Promise<BrainResponse> {
    const service = this.deps.knowledge.findService(this.ctx.services, text);
    const tireInterest =
      includesAny(text, TIRE_WORDS) ||
      state.tireSize !== undefined ||
      state.season !== undefined;
    const wantsToBuy = includesAny(text, BUY_WORDS);

    if (includesAny(text, ["pirkti", "pirkt", "naujas padangas", "nauju padangu"])) {
      return this.startTires(state, events);
    }

    if (service && tireInterest && !wantsToBuy && !state.tireSize && !state.season) {
      state.notes.push(`Neaiškus prašymas: ${text}`);
      return this.reply(
        `Norite įsigyti padangas ar užsiregistruoti paslaugai „${service.name}“?`,
        state,
        events,
      );
    }

    if (tireInterest) {
      return this.startTires(state, events);
    }

    if (service) {
      return this.startService(state, service, events);
    }

    const faq = this.deps.knowledge.findFaq(this.ctx.faq, text);
    if (faq) {
      state.intent = "faq";
      return this.answerFaq(faq, state, events);
    }

    state.unknownTurns++;
    if (state.unknownTurns >= 2) {
      return this.offerHuman(state, events);
    }

    return this.reply(
      "Atsiprašau, noriu tiksliai suprasti. Ar ieškote padangų, ar norite užsiregistruoti paslaugai (montavimas, balansavimas, suvedimas)?",
      state,
      events,
    );
  }

  private startTires(state: CallState, events: ToolEvent[]): BrainResponse | Promise<BrainResponse> {
    state.intent = "tires";
    state.pendingRequestType = "parts_order";
    state.quantity ??= 4;

    if (!state.tireSize) {
      state.phase = "tire_size";
      return this.reply(
        "Kokio dydžio padangos jums reikia? Dydį rasite ant padangos šono, pvz., 205/55 R16.",
        state,
        events,
      );
    }

    if (!state.season) {
      state.phase = "tire_season";
      return this.reply(
        "Ar ieškote žieminių, vasarinių ar visasezoninių padangų?",
        state,
        events,
      );
    }

    return this.searchTires(state, events);
  }

  private startService(
    state: CallState,
    service: TenantContext["services"][number],
    events: ToolEvent[],
  ): BrainResponse | Promise<BrainResponse> {
    state.intent = "service";
    state.pendingRequestType = "service_booking";
    state.service = service.name;

    const detail = [servicePriceLabel(service), serviceDurationLabel(service)]
      .filter(Boolean)
      .join(", ");
    const description = service.description ? ` ${service.description}` : "";
    const base = `Paslauga „${service.name}“ – ${detail}.${description}`;

    if (state.preferredTime) {
      state.phase = "contact_name";
      return this.reply(
        `${base} Užrašiau pageidaujamą laiką: ${state.preferredTime}. Kaip jus vadinti?`,
        state,
        events,
      );
    }

    state.phase = "service_time";
    return this.reply(
      `${base} Kokiam automobiliui ir kada patogiausia atvykti?`,
      state,
      events,
    );
  }

  private handleTireSize(
    state: CallState,
    text: string,
    events: ToolEvent[],
  ): BrainResponse | Promise<BrainResponse> {
    const question = this.tryAnswerQuestion(state, text, events);
    if (question) return question;

    if (state.tireSize) {
      if (!state.season) {
        state.phase = "tire_season";
        return this.reply("Ar ieškote žieminių, vasarinių ar visasezoninių padangų?", state, events);
      }
      return this.searchTires(state, events);
    }

    if (isUnknownPreference(text)) {
      return this.reply(
        "Dydį rasite ant padangos šono, pvz., 205/55 R16. Jei norite, pasakykite automobilio markę, modelį ir metus — padėsiu patikslinti.",
        state,
        events,
      );
    }

    state.unknownTurns++;
    if (state.unknownTurns >= 2) {
      return this.offerHuman(state, events);
    }

    return this.reply("Kokio dydžio padangos jums reikia? Pvz., 205/55 R16.", state, events);
  }

  private handleTireSeason(
    state: CallState,
    text: string,
    events: ToolEvent[],
  ): BrainResponse | Promise<BrainResponse> {
    const question = this.tryAnswerQuestion(state, text, events);
    if (question) return question;

    if (state.season) {
      return this.searchTires(state, events);
    }

    if (isUnknownPreference(text) || state.unknownTurns >= 1) {
      state.notes.push("Sezonas nepatikslintas.");
      return this.searchTires(state, events);
    }

    state.unknownTurns++;
    return this.reply("Žieminės, vasarinės ar visasezoninės?", state, events);
  }

  private searchTires(state: CallState, events: ToolEvent[]): BrainResponse {
    const quantity = state.quantity ?? 4;
    const result = this.deps.inventory.checkStock(this.ctx.inventory, {
      size: state.tireSize,
      season: state.season,
      brand: state.brandPreference,
      quantity,
    });

    const available = result.matches.filter((match) => match.available);
    const unavailable = result.matches.filter((match) => !match.available);

    events.push({
      tool: "check_stock",
      ok: true,
      at: this.nowIso(),
      data: {
        size: state.tireSize,
        season: state.season,
        quantity,
        brand: state.brandPreference,
        available: available.map((match) => ({
          sku: match.item.sku,
          brand: match.item.brand,
          model: match.item.model,
          quantity: match.item.quantity,
          price: match.item.price,
        })),
        alternatives: result.alternatives.map((match) => ({
          sku: match.item.sku,
          brand: match.item.brand,
          model: match.item.model,
          size: match.item.size,
          season: match.item.season,
          price: match.item.price,
        })),
      },
    });

    if (available.length > 0) {
      state.inStock = true;
      state.offer = available.slice(0, 3).map((match) => ({
        sku: match.item.sku,
        label: `${match.item.brand} ${match.item.model} ${match.item.size ?? ""}`.trim(),
        quantity: match.item.quantity,
        unitPrice: match.item.price,
        currency: match.item.currency,
      }));
      state.phase = "tire_offer";
      return this.reply(this.offerMessage(state), state, events);
    }

    state.inStock = false;
    state.offer = undefined;
    state.phase = "tire_preferences";

    const label = [state.tireSize, seasonGenitive(state.season)].filter(Boolean).join(" ");
    let message = `Deja, ${label || "tokio dydžio"} padangų šiuo metu sandėlyje neturime.`;
    if (unavailable.length > 0) {
      message += " Šiuo metu likutis nepakankamas Jūsų kiekiui.";
    }
    if (result.alternatives.length > 0) {
      const alternatives = result.alternatives
        .slice(0, 2)
        .map(
          (match) =>
            `${match.item.brand} ${match.item.model} ${match.item.size ?? ""}`.trim() +
            ` – ${formatMoney(match.item.price, match.item.currency)}/vnt`,
        )
        .join("; ");
      message += ` Turime artimų variantų: ${alternatives}.`;
    }
    message +=
      " Kad galėtume užsakyti, pasakykite pageidaujamą gamintoją ir biudžetą (arba „nesvarbu“).";

    return this.reply(message, state, events);
  }

  private handleTirePreferences(
    state: CallState,
    text: string,
    events: ToolEvent[],
  ): BrainResponse | Promise<BrainResponse> {
    const question = this.tryAnswerQuestion(state, text, events);
    if (question) return question;

    if (extractSeason(text) || extractTireSize(text)) {
      return this.searchTires(state, events);
    }

    if (isUnknownPreference(text) || state.brandPreference || state.budget) {
      const preferences = [
        state.brandPreference ? `gamintojas ${state.brandPreference}` : undefined,
        state.budget ? `biudžetas iki ${formatMoney(state.budget)}/vnt.` : undefined,
      ]
        .filter(Boolean)
        .join(", ");
      return this.advanceContact(
        state,
        events,
        preferences ? `Supratau: ${preferences}` : undefined,
      );
    }

    if (isNegative(text)) {
      state.notes.push("Konkrečių pageidavimų neturi.");
      return this.advanceContact(state, events);
    }

    state.notes.push(`Pageidavimas: ${text}`);
    return this.advanceContact(state, events);
  }

  private handleTireOffer(
    state: CallState,
    text: string,
    events: ToolEvent[],
  ): BrainResponse | Promise<BrainResponse> {
    const question = this.tryAnswerQuestion(state, text, events);
    if (question) return question;

    if (extractTireSize(text) || extractSeason(text)) {
      return this.searchTires(state, events);
    }

    const offered = state.offer ?? [];
    if (offered.length === 0) {
      state.phase = "tire_preferences";
      return this.reply(
        "Kokio gamintojo pageidaujate ir koks biudžetas? Jei nesvarbu — pasakykite „nesvarbu“.",
        state,
        events,
      );
    }

    if (isNegative(text)) {
      return this.close(state, events, "Klientas atsisakė siūlomo varianto");
    }

    const offeredBrands = offered.map((item) => item.label.split(" ")[0] ?? "");
    const selectedBrand = findBrand(text, offeredBrands);

    if (isAffirmative(text) || selectedBrand) {
      const selected =
        (selectedBrand
          ? offered.find((item) => normalizeText(item.label).startsWith(normalizeText(selectedBrand)))
          : undefined) ?? offered[0];
      state.offer = [selected, ...offered.filter((item) => item.sku !== selected.sku)];
      state.inStock = true;
      state.pendingRequestType = "parts_order";
      return this.advanceContact(state, events);
    }

    if (text.includes("?") || includesAny(text, ["kiek", "kaina", "montavim"])) {
      const mounting = this.deps.knowledge.findService(this.ctx.services, "montavimas");
      const mountingText = mounting ? ` Montavimas – ${servicePriceLabel(mounting)}.` : "";
      return this.reply(
        `${this.offerMessage(state, "")}${mountingText} Ar norite rezervuoti su montavimu?`,
        state,
        events,
      );
    }

    return this.reply(this.offerMessage(state), state, events);
  }

  private handleServiceTime(
    state: CallState,
    text: string,
    events: ToolEvent[],
  ): BrainResponse | Promise<BrainResponse> {
    const question = this.tryAnswerQuestion(state, text, events);
    if (question) return question;

    if (state.preferredTime) {
      return this.advanceContact(state, events);
    }

    if (isUnknownPreference(text)) {
      state.notes.push("Laikas nesutartas.");
      return this.advanceContact(state, events);
    }

    state.unknownTurns++;
    if (state.unknownTurns >= 2) {
      state.preferredTime = text.slice(0, 80);
      return this.advanceContact(state, events);
    }

    return this.reply(
      "Kada jums patogiausia atvykti? Pvz., rytoj 10 val.",
      state,
      events,
    );
  }

  private async advanceContact(
    state: CallState,
    events: ToolEvent[],
    leadIn?: string,
  ): Promise<BrainResponse> {
    if (!state.customerName) {
      state.phase = "contact_name";
      const prefix = leadIn ? `${leadIn.replace(/[.\s]+$/, "")}. ` : "Puiku. ";
      return this.reply(`${prefix}Kaip jus vadinti?`, state, events);
    }

    if (!state.phone) {
      state.phase = "contact_phone";
      return this.reply(
        `Ačiū, ${state.customerName}. Kokiu telefono numeriu su jumis susisiekti?`,
        state,
        events,
      );
    }

    if (this.needsTime(state) && !state.preferredTime) {
      state.phase = "booking_time";
      return this.reply("Kada jums patogiausia atvykti? Pvz., rytoj 10 val.", state, events);
    }

    return this.finalize(state, events);
  }

  private handleContactName(
    state: CallState,
    text: string,
    events: ToolEvent[],
  ): BrainResponse | Promise<BrainResponse> {
    if (state.customerName) {
      return this.advanceContact(state, events);
    }

    if (isLikelyName(text)) {
      state.customerName = toNameCase(text);
      state.unknownTurns = 0;
      return this.advanceContact(state, events);
    }

    if (isNegative(text) || isUnknownPreference(text)) {
      state.notes.push("Vardo nenurodė.");
      return this.advanceContact(state, events);
    }

    state.unknownTurns++;
    if (state.unknownTurns >= 2) {
      state.notes.push("Vardo nenurodė.");
      return this.advanceContact(state, events);
    }

    return this.reply("Kaip jus vadinti?", state, events);
  }

  private handleContactPhone(
    state: CallState,
    text: string,
    events: ToolEvent[],
  ): BrainResponse | Promise<BrainResponse> {
    if (state.phone) {
      return this.afterPhone(state, events);
    }

    if (isNegative(text) || isUnknownPreference(text)) {
      state.notes.push("Telefono numerio nenurodė.");
      return this.afterPhone(state, events);
    }

    state.unknownTurns++;
    if (state.unknownTurns >= 2) {
      state.notes.push("Telefono numerio nenurodė.");
      return this.afterPhone(state, events);
    }

    return this.reply(
      "Telefono numerį įrašykite taip: +370 600 12345.",
      state,
      events,
    );
  }

  private async afterPhone(
    state: CallState,
    events: ToolEvent[],
  ): Promise<BrainResponse> {
    if (this.needsTime(state) && !state.preferredTime) {
      state.phase = "booking_time";
      return this.reply("Kada jums patogiausia atvykti? Pvz., rytoj 10 val.", state, events);
    }

    return this.finalize(state, events);
  }

  private handleBookingTime(
    state: CallState,
    text: string,
    events: ToolEvent[],
  ): BrainResponse | Promise<BrainResponse> {
    const question = this.tryAnswerQuestion(state, text, events);
    if (question) return question;

    if (state.preferredTime) {
      return this.finalize(state, events);
    }

    if (isUnknownPreference(text) || isNegative(text)) {
      state.notes.push("Laikas nesutartas.");
      return this.finalize(state, events);
    }

    state.preferredTime = text.slice(0, 80);
    return this.finalize(state, events);
  }

  private handleClosing(
    state: CallState,
    text: string,
    events: ToolEvent[],
  ): BrainResponse | Promise<BrainResponse> {
    if (isNegative(text)) {
      return this.close(state, events, "Klientas daugiau nieko nenorėjo");
    }

    const faq = this.deps.knowledge.findFaq(this.ctx.faq, text);
    if (faq) {
      return this.answerFaq(faq, state, events);
    }

    state.phase = "discover";
    state.intent = undefined;
    state.offer = undefined;
    return this.handleDiscover(state, text, events);
  }

  private needsTime(state: CallState): boolean {
    return (
      state.pendingRequestType === "service_booking" ||
      (state.pendingRequestType === "parts_order" && state.inStock === true)
    );
  }

  private offerHuman(state: CallState, events: ToolEvent[]): BrainResponse {
    state.awaitingHumanConfirmation = true;
    return this.reply(
      "Kad padėčiau tiksliau, galiu perduoti jus operatoriui. Ar norite, kad sujungčiau?",
      state,
      events,
    );
  }

  private transfer(
    state: CallState,
    reason: string,
    events: ToolEvent[],
  ): BrainResponse {
    state.phase = "transferred";
    state.transferReason = reason.slice(0, 200);
    state.awaitingHumanConfirmation = false;
    events.push({
      tool: "transfer_to_human",
      ok: true,
      at: this.nowIso(),
      data: { phone: this.ctx.tenant.transferPhone ?? null },
    });

    const suffix = this.ctx.tenant.transferPhone
      ? ` Perjungiu į ${this.ctx.tenant.transferPhone}.`
      : "";
    return {
      reply: `Perduodu jus operatoriui.${suffix} Palaukite, prašau.`,
      state,
      events,
      end: true,
      transferred: true,
    };
  }

  private close(
    state: CallState,
    events: ToolEvent[],
    reason: string,
  ): BrainResponse {
    state.phase = "closing";
    events.push({
      tool: "end_call",
      ok: true,
      at: this.nowIso(),
      data: { reason },
    });
    const requestSuffix = state.requestId
      ? ` Jūsų poreikis ${state.requestId} užregistruotas.`
      : "";
    return {
      reply: `Ačiū, gražios dienos!${requestSuffix} Jei prireiks pagalbos — paskambinkite.`,
      state,
      events,
      end: true,
    };
  }

  private async finalize(state: CallState, events: ToolEvent[]): Promise<BrainResponse> {
    const type = state.pendingRequestType ?? "callback";
    const items = this.buildRequestItems(state);
    const notes = this.buildNotes(state, type);
    const summary = this.buildRequestSummary(state);

    try {
      const created = await this.deps.requests.create(
        this.ctx.tenant,
        this.deps.callId,
        {
          type,
          status:
            type === "service_booking" || (type === "parts_order" && state.inStock)
              ? "pending_confirmation"
              : "new",
          customer: {
            name: state.customerName,
            phone: state.phone,
          },
          vehicle: state.vehicle,
          items,
          service: state.service,
          preferredTime: state.preferredTime,
          notes,
          summary,
        },
        this.deps.now(),
      );

      state.requestId = created.request.id;
      state.phase = "closing";
      state.awaitingHumanConfirmation = false;
      events.push({
        tool: "create_request",
        ok: true,
        at: this.nowIso(),
        data: {
          requestId: created.request.id,
          type,
          jsonPath: created.jsonPath,
          mdPath: created.mdPath,
        },
      });

      return this.reply(this.requestCreatedMessage(state), state, events);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      events.push({
        tool: "create_request",
        ok: false,
        at: this.nowIso(),
        error: message,
      });
      return this.reply(
        "Atsiprašau, įvyko techninė klaida saugant poreikį. Informaciją perduosiu komandai.",
        state,
        events,
      );
    }
  }

  private buildRequestItems(state: CallState): RequestItem[] {
    if (state.pendingRequestType !== "parts_order") return [];

    const quantity = state.quantity ?? 4;
    if (state.inStock && state.offer && state.offer.length > 0) {
      const selected = state.offer[0];
      return [
        {
          sku: selected.sku,
          description: `Padangos ${selected.label}`,
          size: state.tireSize,
          season: state.season,
          brandPreference: state.brandPreference,
          quantity,
          unitPrice: selected.unitPrice,
          currency: selected.currency,
          inStock: true,
        },
      ];
    }

    return [
      {
        description: "Padangos",
        size: state.tireSize,
        season: state.season,
        brandPreference: state.brandPreference,
        quantity,
        inStock: false,
      },
    ];
  }

  private buildNotes(state: CallState, type: string): string {
    const notes = [...state.notes];
    if (state.budget) notes.push(`Biudžetas: iki ${formatMoney(state.budget)}/vnt.`);
    if (state.intent === "tires" && !state.inStock) {
      notes.push("Tikslaus varianto sandėlyje nebuvo.");
    }
    if (state.intent === "tires" && state.inStock) {
      notes.push("Klientas pasirinko rezervaciją su montavimu.");
    }
    if (!state.phone) notes.push("Telefonas nenurodytas.");
    if (this.needsTime(state) && !state.preferredTime) notes.push("Laikas nesutartas.");
    if (type === "callback") notes.push("Klientas prašė perskambinimo.");
    return [...new Set(notes)].join(" ").replace(/\.(\s*\.)+/g, ".").trim();
  }

  private buildRequestSummary(state: CallState): string {
    const parts: string[] = [];
    if (state.customerName) {
      parts.push(
        `Klientas ${state.customerName}${state.phone ? ` (${state.phone})` : ""}.`,
      );
    } else {
      parts.push("Klientas (kontaktai nenurodyti).");
    }

    if (state.intent === "tires") {
      const label = [state.tireSize, seasonGenitive(state.season)].filter(Boolean).join(" ");
      parts.push(
        `Ieško ${label ? `${label} padangų` : "padangų"} (${state.quantity ?? 4} vnt.).`,
      );
      parts.push(
        state.inStock
          ? "Sandėlyje rastas tinkamas variantas."
          : "Tikslaus varianto sandėlyje nebuvo – reikia užsakyti.",
      );
    } else if (state.intent === "service") {
      parts.push(`Pageidauja paslaugos „${state.service}“.`);
    }

    if (state.vehicle) parts.push(`Automobilis: ${state.vehicle}.`);
    if (state.preferredTime) {
      parts.push(
        `Pageidaujamas laikas: ${state.preferredTime.replace(/[.\s]+$/, "")}.`,
      );
    }
    if (state.budget) parts.push(`Biudžetas: iki ${formatMoney(state.budget)}/vnt.`);
    return parts.join(" ");
  }

  private requestCreatedMessage(state: CallState): string {
    const id = state.requestId ?? "";
    if (state.intent === "tires") {
      if (state.inStock) {
        return `Užregistravau rezervaciją ${id}. Susisieksime patvirtinti laiko. Ar dar kuo galiu padėti?`;
      }
      return `Užregistravau poreikį ${id}. Surinkau, ko reikia — komanda susisieks dėl tinkamų padangų. Ar dar kuo galiu padėti?`;
    }
    if (state.intent === "service") {
      return `Užregistravau rezervaciją ${id}. Patvirtinsime laiką. Ar dar kuo galiu padėti?`;
    }
    return `Užregistravau poreikį ${id}. Susisieksime. Ar dar kuo galiu padėti?`;
  }

  private offerMessage(state: CallState, suffix = "Ar norite rezervuoti su montavimu?"): string {
    const offered = state.offer ?? [];
    const quantity = state.quantity ?? 4;
    const lines = offered.map((item) => {
      const total = item.unitPrice * quantity;
      return `• ${item.label} – ${formatMoney(item.unitPrice, item.currency)}/vnt. (${item.quantity} vnt. sandėlyje; ${quantity} vnt. – ${formatMoney(total, item.currency)})`;
    });
    const tail = suffix ? `\n\n${suffix}` : "";
    return `Turime jums tinkamų padangų:\n${lines.join("\n")}${tail}`;
  }

  private tryAnswerQuestion(
    state: CallState,
    text: string,
    events: ToolEvent[],
  ): BrainResponse | undefined {
    const normalized = normalizeText(text);
    const looksLikeQuestion = text.includes("?") || QUESTION_START.test(normalized);
    if (!looksLikeQuestion) return undefined;

    const faq = this.deps.knowledge.findFaq(this.ctx.faq, text);
    if (!faq) return undefined;

    return this.answerFaq(faq, state, events, this.currentQuestion(state));
  }

  private currentQuestion(state: CallState): string {
    switch (state.phase) {
      case "tire_size":
        return "Kokio dydžio padangos jums reikia? Pvz., 205/55 R16.";
      case "tire_season":
        return "Žieminės, vasarinės ar visasezoninės?";
      case "tire_preferences":
        return "Kokio gamintojo pageidaujate ir koks biudžetas? Jei nesvarbu — pasakykite „nesvarbu“.";
      case "tire_offer":
        return "Ar norite rezervuoti su montavimu?";
      case "service_time":
        return "Kada jums patogiausia atvykti?";
      case "contact_name":
        return "Kaip jus vadinti?";
      case "contact_phone":
        return "Kokiu telefono numeriu susisiekti?";
      case "booking_time":
        return "Kada jums patogiausia atvykti?";
      default:
        return "Ar dar kuo galiu padėti?";
    }
  }

  private answerFaq(
    entry: TenantContext["faq"][number],
    state: CallState,
    events: ToolEvent[],
    suffix = "Ar dar kuo galiu padėti?",
  ): BrainResponse {
    events.push({
      tool: "get_business_info",
      ok: true,
      at: this.nowIso(),
      data: { faqId: entry.id },
    });
    return this.reply(`${entry.answer} ${suffix}`, state, events);
  }

  private applyEntities(state: CallState, text: string): void {
    let progressed = false;

    const size = extractTireSize(text);
    if (size) {
      state.tireSize = size;
      progressed = true;
    }

    const season = extractSeason(text);
    if (season) {
      state.season = season;
      progressed = true;
    }

    const quantity = extractQuantity(text);
    if (quantity) {
      state.quantity = quantity;
      progressed = true;
    }

    const budget = extractBudget(text);
    if (budget) {
      state.budget = budget;
      progressed = true;
    }

    const vehicle = extractVehicle(text);
    if (vehicle) {
      state.vehicle = vehicle;
      progressed = true;
    }

    const preferredTime = extractPreferredTime(text);
    if (preferredTime) {
      state.preferredTime = preferredTime;
      progressed = true;
    }

    const name = extractName(text);
    if (name) {
      state.customerName = name;
      progressed = true;
    }

    const phone = extractPhone(text, state.phase === "contact_phone");
    if (phone) {
      state.phone = phone;
      progressed = true;
    }

    if (
      state.intent === "tires" ||
      state.phase.startsWith("tire") ||
      includesAny(text, ["padang", "ratlank"])
    ) {
      const brand = findBrand(text, this.knownBrands);
      if (brand) {
        state.brandPreference = brand;
        progressed = true;
      }
    }

    if (progressed) state.unknownTurns = 0;
  }

  private reply(
    reply: string,
    state: CallState,
    events: ToolEvent[],
  ): BrainResponse {
    return { reply, state, events };
  }

  private nowIso(): string {
    return this.deps.now().toISOString();
  }
}

function cloneState(state: CallState): CallState {
  return {
    ...state,
    notes: [...state.notes],
    offer: state.offer ? state.offer.map((item) => ({ ...item })) : undefined,
  };
}
