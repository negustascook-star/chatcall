import type { CallSession, CallSummary, Tenant } from "../domain/types.js";
import { seasonGenitive } from "../lib/text.js";

export function buildCallSummary(session: CallSession, _tenant: Tenant): CallSummary {
  const state = session.state;
  const contact = state.customerName
    ? `Klientas ${state.customerName}${state.phone ? ` (${state.phone})` : ""}`
    : "Klientas";

  const parts: string[] = [];

  if (session.status === "transferred") {
    parts.push(`${contact} prašė sujungti su operatoriumi.`);
  } else if (state.intent === "tires") {
    const label = [state.tireSize, seasonGenitive(state.season)].filter(Boolean).join(" ");
    parts.push(
      `${contact} ieškojo ${label ? `${label} padangų` : "padangų"} (${state.quantity ?? 4} vnt.).`,
    );
    parts.push(
      state.inStock
        ? "Sandėlyje rastas tinkamas variantas."
        : "Tikslaus varianto sandėlyje nebuvo – reikia užsakyti.",
    );
  } else if (state.intent === "service") {
    parts.push(`${contact} pageidavo paslaugos „${state.service ?? "paslauga"}“.`);
  } else if (state.intent === "faq") {
    parts.push(`${contact} uždavė klausimą ir gavo informaciją.`);
  } else {
    parts.push(`${contact} bendravo dėl paslaugų.`);
  }

  if (state.vehicle) parts.push(`Automobilis: ${state.vehicle}.`);
  if (state.preferredTime) {
    parts.push(
      `Pageidaujamas laikas: ${state.preferredTime.replace(/[.\s]+$/, "")}.`,
    );
  }
  if (state.budget) parts.push(`Biudžetas: iki ${state.budget} €/vnt.`);

  if (session.requestIds.length > 0) {
    parts.push(`Užregistruoti poreikiai: ${session.requestIds.join(", ")}.`);
  } else {
    parts.push("Poreikis neužregistruotas.");
  }

  const outcome =
    session.status === "transferred"
      ? "Perduota žmogui."
      : session.requestIds.length > 0
        ? "Užregistruotas poreikis."
        : "Pokalbis baigtas be poreikio.";

  let nextAction = "Nereikia.";
  if (session.status === "transferred") {
    nextAction = "Operatorius tęsia pokalbį.";
  } else if (session.requestIds.length > 0) {
    if (state.pendingRequestType === "parts_order" && state.inStock) {
      nextAction = "Patvirtinti padangų rezervaciją ir laiką.";
    } else if (state.pendingRequestType === "parts_order") {
      nextAction = "Užsakyti reikalingas padangas ir susisiekti su klientu.";
    } else if (state.pendingRequestType === "service_booking") {
      nextAction = "Patvirtinti paslaugos rezervacijos laiką.";
    } else {
      nextAction = "Perskambinti klientui.";
    }
  }

  return {
    text: parts.join(" "),
    outcome,
    nextAction,
  };
}
