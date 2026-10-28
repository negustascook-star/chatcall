import { describe, expect, it } from "vitest";
import type { Service } from "../src/domain/types.js";
import { servicePriceLabel } from "../src/knowledge/knowledgeService.js";

function service(overrides: Partial<Service> = {}): Service {
  return {
    id: "tyre-change",
    name: "4 padangų keitimas",
    keywords: [],
    ...overrides,
  };
}

describe("servicePriceLabel", () => {
  it("does not repeat a fixed price as a range", () => {
    const label = servicePriceLabel(
      service({ priceFrom: 40, priceTo: 40, priceUnit: "už paslaugą" }),
    );

    expect(label).toContain("40");
    expect(label).toContain("už paslaugą");
    expect(label).not.toContain("–");
  });

  it("keeps a real price range", () => {
    const label = servicePriceLabel(
      service({ priceFrom: 40, priceTo: 60, priceUnit: "už paslaugą" }),
    );

    expect(label).toContain("–");
  });
});
