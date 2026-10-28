import type { TireSeason } from "../domain/types.js";

export const SEASON_LABELS: Record<TireSeason, string> = {
  winter: "žieminės",
  summer: "vasarinės",
  all_season: "visasezoninės",
};

const SEASON_GENITIVE: Record<TireSeason, string> = {
  winter: "žieminių",
  summer: "vasarinių",
  all_season: "visasezoninių",
};

export function seasonGenitive(season: TireSeason | undefined): string {
  return season ? SEASON_GENITIVE[season] : "";
}

export interface ParsedTireSize {
  width: number;
  profile: number;
  diameter: number;
}

/** Lowercase, strip Lithuanian diacritics and punctuation for keyword matching. */
export function normalizeText(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9/+:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function includesAny(text: string, terms: string[]): boolean {
  const normalized = normalizeText(text);
  return terms.some((term) => normalized.includes(normalizeText(term)));
}

/** Normalizes Lithuanian phone numbers to +3706XXXXXXX. */
export function normalizePhone(input: string): string | undefined {
  const digits = input.replace(/\D/g, "");
  if (digits.length === 14 && digits.startsWith("00370")) {
    return `+${digits.slice(2)}`;
  }
  if (digits.length === 11 && digits.startsWith("370")) {
    return `+${digits}`;
  }
  if (digits.length === 9 && digits.startsWith("8")) {
    return `+370${digits.slice(1)}`;
  }
  if (digits.length === 8) {
    return `+370${digits}`;
  }
  return undefined;
}

export function extractPhone(text: string, allowBare = false): string | undefined {
  const prefixed = /(?:\+?370|00370|8)[\s\-()]*\d(?:[\s\-()]*\d){7,9}/g;
  for (const match of text.matchAll(prefixed)) {
    const phone = normalizePhone(match[0]);
    if (phone) return phone;
  }

  if (allowBare) {
    const bare = /\d(?:[\s\-()]*\d){7,9}/g;
    for (const match of text.matchAll(bare)) {
      const phone = normalizePhone(match[0]);
      if (phone) return phone;
    }
  }

  return undefined;
}

export function parseTireSize(input: string): ParsedTireSize | undefined {
  const match = input.match(/(\d{3})\s*[/\- ]\s*(\d{2})\s*(?:r\s*)?(\d{2})/i);
  if (!match) return undefined;

  const width = Number(match[1]);
  const profile = Number(match[2]);
  const diameter = Number(match[3]);

  if (width < 125 || width > 355) return undefined;
  if (profile < 25 || profile > 85) return undefined;
  if (diameter < 13 || diameter > 24) return undefined;

  return { width, profile, diameter };
}

export function normalizeTireSize(input: string): string | undefined {
  const parsed = parseTireSize(input);
  if (!parsed) return undefined;
  return `${parsed.width}/${parsed.profile} R${parsed.diameter}`;
}

export function extractTireSize(text: string): string | undefined {
  return normalizeTireSize(text);
}

export function extractSeason(text: string): TireSeason | undefined {
  const normalized = normalizeText(text);
  if (/\b(ziem|winter|snow)/.test(normalized)) return "winter";
  if (/\b(vasar|summer)/.test(normalized)) return "summer";
  if (/(visasezon|all.?season|universal)/.test(normalized)) return "all_season";
  return undefined;
}

const QUANTITY_WORDS: Record<string, number> = {
  vienas: 1,
  viena: 1,
  du: 2,
  dvi: 2,
  tris: 3,
  trys: 3,
  keturias: 4,
  keturios: 4,
  keturi: 4,
  penkias: 5,
  penkios: 5,
  penki: 5,
};

export function extractQuantity(text: string): number | undefined {
  const normalized = normalizeText(text);
  const numeric = normalized.match(/(\d{1,2})\s*(?:vnt|padang|rat|kompl)/);
  if (numeric) {
    const value = Number(numeric[1]);
    if (value > 0 && value <= 12) return value;
  }

  for (const [word, value] of Object.entries(QUANTITY_WORDS)) {
    if (new RegExp(`\\b${word}\\b`).test(normalized)) return value;
  }

  return undefined;
}

export function toNameCase(input: string): string {
  return input
    .trim()
    .replace(/[^\p{L}\s-]/gu, "")
    .replace(/\s+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((part) =>
      part
        .split("-")
        .map((piece) => piece.charAt(0).toUpperCase() + piece.slice(1).toLowerCase())
        .join("-"),
    )
    .join(" ");
}

export function extractName(text: string): string | undefined {
  const patterns = [
    /\b(?:mano vardas|vardas)\s*[:\-]?\s*([\p{L}][\p{L}-]{1,30})/iu,
    /\b(?:aš esu|as esu|esu)\s+([\p{L}][\p{L}-]{1,30})/iu,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return toNameCase(match[1]);
  }

  return undefined;
}

export function isLikelyName(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 40) return false;
  if (/[?]/.test(trimmed)) return false;
  const words = trimmed.split(/\s+/);
  if (words.length > 3) return false;
  if (!/^[\p{L}\s-]+$/u.test(trimmed)) return false;
  return !/^(taip|ne|noriu|nereikia|nesvarbu|nezinau|kur|kada|kiek|kaip|ar)\b/i.test(
    normalizeText(trimmed),
  );
}

const CAR_MAKES = [
  "Audi",
  "BMW",
  "Volkswagen",
  "VW",
  "Toyota",
  "Volvo",
  "Mercedes",
  "Mercedes-Benz",
  "Opel",
  "Ford",
  "Škoda",
  "Skoda",
  "Peugeot",
  "Renault",
  "Nissan",
  "Honda",
  "Kia",
  "Hyundai",
  "Seat",
  "Fiat",
  "Mazda",
  "Subaru",
  "Lexus",
  "Tesla",
  "Dacia",
  "Citroen",
  "Citroën",
  "Mini",
  "Jeep",
  "Land Rover",
  "Porsche",
  "Alfa Romeo",
  "Mitsubishi",
  "Suzuki",
  "Chevrolet",
  "Smart",
  "Iveco",
  "MAN",
];

export function extractVehicle(text: string): string | undefined {
  for (const make of CAR_MAKES) {
    const pattern = new RegExp(`\\b${escapeRegExp(make)}\\b(?:\\s+([\\p{L}0-9-]{1,20}))?`, "iu");
    const match = text.match(pattern);
    if (match) {
      const makeLabel = make === "VW" ? "Volkswagen" : make;
      return [makeLabel, match[1]].filter(Boolean).join(" ").slice(0, 60);
    }
  }
  return undefined;
}

export function extractBudget(text: string): number | undefined {
  const normalized = normalizeText(text);
  const patterns = [
    /(?:iki|max|ne daugiau(?: kaip)?)\s*(\d{2,4})/,
    /(\d{2,4})\s*(?:eur|euru|€)/,
    /(?:biudzetas|budzetas)\s*(\d{2,4})/,
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match?.[1]) {
      const value = Number(match[1]);
      if (value >= 10 && value <= 10000) return value;
    }
  }

  return undefined;
}

export function hasTimeExpression(text: string): boolean {
  const normalized = normalizeText(text);
  return (
    /\b(šiandien|siandien|rytoj|poryt|pirmadien|antradien|trečiadien|treciadien|ketvirtadien|penktadien|šeštadien|sestadien|sekmadien)\b/.test(
      normalized,
    ) ||
    /\b\d{1,2}:\d{2}\b/.test(normalized) ||
    /\b\d{1,2}\s*(?:val|h)\b/.test(normalized) ||
    /\b(ryte|ryta|vakare|po pietu|pries pietus|pietu)\b/.test(normalized)
  );
}

export function extractPreferredTime(text: string): string | undefined {
  if (!hasTimeExpression(text)) return undefined;
  return text.trim().replace(/\s+/g, " ").slice(0, 80);
}

export function isGoodbye(text: string): boolean {
  const normalized = normalizeText(text);
  return (
    /\b(viso gero|iki pasimatymo|atsisveikin|viskas|daugiau nieko|nieko daugiau|ne aciu|aciu viskas|viso)\b/.test(
      normalized,
    ) || /^(aciu|dekui)[.!]?$/.test(normalized)
  );
}

export function isAffirmative(text: string): boolean {
  const normalized = normalizeText(text);
  return (
    /^(taip|jo|ok|gerai|tinka|tikrai)\b/.test(normalized) ||
    /\b(noriu|norim|norėtumėm|noretumem|rezervuok|uzsakyk|imsiu|paimsiu|prasau|prašau)\b/.test(
      normalized,
    )
  );
}

export function isNegative(text: string): boolean {
  const normalized = normalizeText(text);
  return (
    /^(ne|ne,|nereikia|atsisakau)\b/.test(normalized) ||
    /\b(nereikia|atsisakau|nenoriu)\b/.test(normalized)
  );
}

export function isUnknownPreference(text: string): boolean {
  return includesAny(text, [
    "nesvarbu",
    "nežinau",
    "nezinau",
    "bet kokia",
    "bet koks",
    "nera skirtumo",
    "nerūpi",
    "nerupi",
    "kaip patariate",
    "jūsų nuožiūra",
    "jusu nuoziura",
  ]);
}

export function isHumanRequest(text: string): boolean {
  return includesAny(text, [
    "žmogus",
    "zmogus",
    "operatorius",
    "konsultantas",
    "gyvas",
    "specialistas",
    "sujunk",
    "perduok",
    "perjungti",
  ]);
}

export function findBrand(text: string, knownBrands: string[]): string | undefined {
  const normalized = normalizeText(text);
  return knownBrands.find((brand) => normalized.includes(normalizeText(brand)));
}

export function formatMoney(amount: number, currency = "EUR"): string {
  return new Intl.NumberFormat("lt-LT", {
    style: "currency",
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(amount);
}

export function dateFolder(timezone: string, date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "00";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

export function timeLabel(timezone: string, date: Date): string {
  return new Intl.DateTimeFormat("lt-LT", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function csvEscape(value: string | number | undefined): string {
  const text = value === undefined ? "" : String(value);
  if (/[",\n\r;]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
