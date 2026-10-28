import type {
  InventoryItem,
  StockMatch,
  StockQuery,
  StockResult,
} from "../domain/types.js";
import {
  normalizeText,
  normalizeTireSize,
  parseTireSize,
  SEASON_LABELS,
} from "../lib/text.js";

export class InventoryService {
  checkStock(items: InventoryItem[], query: StockQuery): StockResult {
    const requestedQuantity = query.quantity ?? 1;
    const normalizedSize = query.size ? normalizeTireSize(query.size) : undefined;
    const brand = query.brand ? normalizeText(query.brand) : undefined;
    const textTokens = query.text
      ? normalizeText(query.text)
          .split(" ")
          .filter((token) => token.length > 2)
      : [];

    const filter = (skipBrand: boolean): StockMatch[] =>
      items
        .filter((item) => {
          if (normalizedSize) {
            const itemSize = item.size ? normalizeTireSize(item.size) : undefined;
            if (itemSize !== normalizedSize) return false;
          }

          if (query.season && item.season !== query.season) return false;

          if (!skipBrand && brand) {
            const brandText = normalizeText(`${item.brand} ${item.model}`);
            if (!brandText.includes(brand)) return false;
          }

          if (textTokens.length > 0) {
            const haystack = normalizeText(
              [
                item.brand,
                item.model,
                item.size ?? "",
                item.season ? SEASON_LABELS[item.season] : "",
                item.category,
                ...(item.keywords ?? []),
              ].join(" "),
            );
            if (!textTokens.every((token) => haystack.includes(token))) return false;
          }

          return true;
        })
        .map((item) => ({ item, available: item.quantity >= requestedQuantity }))
        .sort(compareMatches);

    const matches = filter(false);
    const alternatives: StockMatch[] = [];

    const hasAvailable = matches.some((match) => match.available);
    if (!hasAvailable && brand) {
      for (const match of filter(true)) {
        if (match.available && !matches.some((existing) => existing.item.sku === match.item.sku)) {
          alternatives.push(match);
        }
      }
    }

    if (!hasAvailable && normalizedSize) {
      const requested = parseTireSize(normalizedSize);
      if (requested) {
        const knownSkus = new Set([
          ...matches.map((match) => match.item.sku),
          ...alternatives.map((match) => match.item.sku),
        ]);

        const similar = items
          .filter((item) => {
            if (knownSkus.has(item.sku) || item.quantity < requestedQuantity || !item.size) {
              return false;
            }
            const size = parseTireSize(item.size);
            if (!size) return false;
            if (size.width !== requested.width || size.diameter !== requested.diameter) {
              return false;
            }
            return true;
          })
          .map((item) => ({ item, available: true }))
          .sort((a, b) => {
            const aSize = parseTireSize(a.item.size ?? "");
            const bSize = parseTireSize(b.item.size ?? "");
            const aDistance = aSize ? Math.abs(aSize.profile - requested.profile) : 99;
            const bDistance = bSize ? Math.abs(bSize.profile - requested.profile) : 99;
            return aDistance - bDistance || a.item.price - b.item.price;
          });

        for (const match of similar) {
          if (alternatives.length >= 3) break;
          alternatives.push(match);
        }
      }
    }

    return {
      query: { ...query, size: normalizedSize ?? query.size },
      matches: matches.slice(0, 5),
      alternatives: alternatives.slice(0, 3),
    };
  }
}

function compareMatches(a: StockMatch, b: StockMatch): number {
  return Number(b.available) - Number(a.available) || a.item.price - b.item.price;
}
