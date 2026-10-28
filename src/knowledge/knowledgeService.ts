import type { FaqEntry, Service } from "../domain/types.js";
import { formatMoney, normalizeText } from "../lib/text.js";

export class KnowledgeService {
  findFaq(entries: FaqEntry[], text: string): FaqEntry | undefined {
    const normalized = normalizeText(text);
    let best: { entry: FaqEntry; score: number } | undefined;

    for (const entry of entries) {
      let score = 0;
      for (const keyword of entry.keywords) {
        const normalizedKeyword = normalizeText(keyword);
        if (normalizedKeyword && normalized.includes(normalizedKeyword)) {
          score += 2 + normalizedKeyword.split(" ").length;
        }
      }

      const questionWords = normalizeText(entry.question)
        .split(" ")
        .filter((word) => word.length > 3);
      score += questionWords.filter((word) => normalized.includes(word)).length;

      if (score > 0 && (!best || score > best.score)) {
        best = { entry, score };
      }
    }

    return best?.entry;
  }

  findService(services: Service[], text: string): Service | undefined {
    const normalized = normalizeText(text);
    let best: { service: Service; score: number } | undefined;

    for (const service of services) {
      let score = 0;
      for (const keyword of [service.name, ...service.keywords]) {
        const normalizedKeyword = normalizeText(keyword);
        if (normalizedKeyword && normalized.includes(normalizedKeyword)) {
          score += 2 + normalizedKeyword.split(" ").length;
        }
      }

      if (score > 0 && (!best || score > best.score)) {
        best = { service, score };
      }
    }

    return best?.service;
  }
}

export function servicePriceLabel(service: Service): string {
  const unit = service.priceUnit ? ` ${service.priceUnit}` : "";
  if (service.priceFrom !== undefined && service.priceTo !== undefined) {
    if (service.priceFrom === service.priceTo) {
      return `${formatMoney(service.priceFrom)}${unit}`;
    }
    return `${formatMoney(service.priceFrom)}–${formatMoney(service.priceTo)}${unit}`;
  }
  if (service.priceFrom !== undefined) {
    return `nuo ${formatMoney(service.priceFrom)}${unit}`;
  }
  return "kainą patikslinsime";
}

export function serviceDurationLabel(service: Service): string {
  if (!service.durationMinutes) return "";
  if (service.durationMinutes >= 60) {
    const hours = Math.round((service.durationMinutes / 60) * 10) / 10;
    return `apie ${hours} val.`;
  }
  return `apie ${service.durationMinutes} min.`;
}
