import { describe, expect, it } from "vitest";
import { InventoryService } from "../src/inventory/inventoryService.js";
import type { InventoryItem } from "../src/domain/types.js";

const items: InventoryItem[] = [
  {
    sku: "A",
    category: "tire",
    brand: "Michelin",
    model: "Alpin 7",
    size: "205/55 R16",
    season: "winter",
    quantity: 8,
    price: 129,
    currency: "EUR",
  },
  {
    sku: "B",
    category: "tire",
    brand: "Nokian",
    model: "Snowproof 2",
    size: "205/55 R16",
    season: "winter",
    quantity: 4,
    price: 109,
    currency: "EUR",
  },
  {
    sku: "C",
    category: "tire",
    brand: "Tigar",
    model: "Winter 1",
    size: "205/55 R16",
    season: "winter",
    quantity: 0,
    price: 72,
    currency: "EUR",
  },
  {
    sku: "D",
    category: "tire",
    brand: "Continental",
    model: "PremiumContact 6",
    size: "205/55 R16",
    season: "summer",
    quantity: 6,
    price: 98,
    currency: "EUR",
  },
  {
    sku: "E",
    category: "tire",
    brand: "Michelin",
    model: "Pilot Sport 5",
    size: "225/40 R18",
    season: "summer",
    quantity: 4,
    price: 165,
    currency: "EUR",
  },
];

describe("InventoryService", () => {
  const inventory = new InventoryService();

  it("finds available tires by exact size and season", () => {
    const result = inventory.checkStock(items, {
      size: "205/55R16",
      season: "winter",
      quantity: 4,
    });

    expect(result.matches.map((match) => match.item.sku)).toEqual(["B", "A", "C"]);
    expect(result.matches.filter((match) => match.available).map((match) => match.item.sku)).toEqual([
      "B",
      "A",
    ]);
  });

  it("respects quantity and brand filters", () => {
    const result = inventory.checkStock(items, {
      size: "205/55 R16",
      season: "winter",
      brand: "Nokian",
      quantity: 5,
    });

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.item.sku).toBe("B");
    expect(result.matches[0]?.available).toBe(false);
  });

  it("suggests alternatives of the same width and diameter", () => {
    const result = inventory.checkStock(items, {
      size: "225/40 R18",
      season: "winter",
      quantity: 4,
    });

    expect(result.matches).toHaveLength(0);
    expect(result.alternatives.map((match) => match.item.sku)).toContain("E");
  });

  it("does not suggest another size with a different diameter", () => {
    const result = inventory.checkStock(items, {
      size: "225/45 R17",
      season: "winter",
      quantity: 4,
    });

    expect(result.matches).toHaveLength(0);
    expect(result.alternatives).toHaveLength(0);
  });
});
