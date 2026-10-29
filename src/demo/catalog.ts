/** Fictional vehicle catalogue and starting inventory for the demo workshop. */
import type { CompatEntry, Part } from "./types.js";

export interface CatalogVehicle {
  make: string; model: string; aliases: string[]; from: number; to: number; engines: [string, string][];
}

export const VEHICLES: CatalogVehicle[] = [
  { make: "Volkswagen", model: "Golf", aliases: ["vw golf", "golf"], from: 2012, to: 2021, engines: [["1.6 TDI", "Diesel"], ["1.4 TSI", "Petrol"], ["2.0 TDI", "Diesel"]] },
  { make: "BMW", model: "320d", aliases: ["320d", "bmw 3 series", "3 series"], from: 2014, to: 2020, engines: [["2.0 diesel (B47)", "Diesel"]] },
  { make: "Toyota", model: "Corolla", aliases: ["corolla"], from: 2014, to: 2022, engines: [["1.8 Hybrid", "Hybrid"], ["1.6 Valvematic", "Petrol"]] },
  { make: "Ford", model: "Focus", aliases: ["focus"], from: 2012, to: 2020, engines: [["1.0 EcoBoost", "Petrol"], ["1.5 TDCi", "Diesel"]] },
  { make: "Ford", model: "Fiesta", aliases: ["fiesta"], from: 2012, to: 2020, engines: [["1.0 EcoBoost", "Petrol"], ["1.25", "Petrol"]] },
  { make: "Audi", model: "A4", aliases: ["audi a4", "a4"], from: 2013, to: 2021, engines: [["2.0 TDI", "Diesel"], ["2.0 TFSI", "Petrol"]] },
  { make: "Honda", model: "Civic", aliases: ["civic"], from: 2013, to: 2021, engines: [["1.0 VTEC Turbo", "Petrol"], ["1.6 i-DTEC", "Diesel"]] },
  { make: "Skoda", model: "Octavia", aliases: ["octavia", "skoda octavia"], from: 2013, to: 2022, engines: [["2.0 TDI", "Diesel"], ["1.4 TSI", "Petrol"]] },
  { make: "Mercedes-Benz", model: "C220", aliases: ["c220", "c-class", "mercedes c class", "mercedes c220"], from: 2014, to: 2021, engines: [["2.1 diesel", "Diesel"]] },
  { make: "Volvo", model: "V60", aliases: ["v60", "volvo v60"], from: 2014, to: 2021, engines: [["D4 diesel", "Diesel"], ["T5 petrol", "Petrol"]] },
  { make: "Nissan", model: "Qashqai", aliases: ["qashqai"], from: 2014, to: 2022, engines: [["1.2 DIG-T", "Petrol"], ["1.5 dCi", "Diesel"]] },
  { make: "Mazda", model: "Mazda3", aliases: ["mazda 3", "mazda3"], from: 2014, to: 2022, engines: [["2.0 Skyactiv-G", "Petrol"]] },
  { make: "Hyundai", model: "i30", aliases: ["i30", "hyundai i30"], from: 2014, to: 2022, engines: [["1.4 T-GDi", "Petrol"], ["1.6 CRDi", "Diesel"]] },
  { make: "Kia", model: "Sportage", aliases: ["sportage"], from: 2014, to: 2022, engines: [["1.6 GDi", "Petrol"], ["1.7 CRDi", "Diesel"]] },
  { make: "Renault", model: "Clio", aliases: ["clio", "renault clio"], from: 2013, to: 2021, engines: [["0.9 TCe", "Petrol"], ["1.5 dCi", "Diesel"]] },
  { make: "Peugeot", model: "308", aliases: ["308", "peugeot 308"], from: 2014, to: 2021, engines: [["1.2 PureTech", "Petrol"], ["1.6 BlueHDi", "Diesel"]] },
];

export const MAKE_ALIASES: Record<string, string> = {
  vw: "Volkswagen", volkswagen: "Volkswagen", bmw: "BMW", toyota: "Toyota", ford: "Ford", audi: "Audi", honda: "Honda", skoda: "Skoda",
  mercedes: "Mercedes-Benz", "mercedes-benz": "Mercedes-Benz", volvo: "Volvo", nissan: "Nissan", mazda: "Mazda", hyundai: "Hyundai",
  kia: "Kia", renault: "Renault", peugeot: "Peugeot",
};

const VWG = ["Volkswagen", "Audi", "Skoda"];
type Group = { make: string; models: string[]; from: number; to: number }[];
function g(entries: [string, string[], number?, number?][]): Group {
  return entries.map(([make, models, from, to]) => ({ make, models, from: from ?? 2010, to: to ?? 2024 }));
}
function expand(grp: Group): CompatEntry[] {
  return grp.flatMap((e) => e.models.map((model) => ({ make: e.make, model, yearFrom: e.from, yearTo: e.to })));
}
const vw = expand(g([["Volkswagen", ["Golf"]], ["Skoda", ["Octavia"]], ["Audi", ["A4"]]]));
const golf = expand(g([["Volkswagen", ["Golf"], 2012, 2021]]));
const bmw = expand(g([["BMW", ["320d"], 2014, 2020]]));
const toyota = expand(g([["Toyota", ["Corolla"]], ["Honda", ["Civic"]], ["Mazda", ["Mazda3"]]]));
const corolla = expand(g([["Toyota", ["Corolla"], 2014, 2022]]));
const ford = expand(g([["Ford", ["Focus", "Fiesta"]]]));
const focus = expand(g([["Ford", ["Focus"], 2012, 2020]]));
const merc = expand(g([["Mercedes-Benz", ["C220"]], ["Volvo", ["V60"]]]));
const asia = expand(g([["Nissan", ["Qashqai"]], ["Renault", ["Clio"]], ["Peugeot", ["308"]], ["Hyundai", ["i30"]], ["Kia", ["Sportage"]]]));
const civic = expand(g([["Honda", ["Civic"], 2013, 2021]]));
const any: CompatEntry[] = [{ make: "*", model: "*", yearFrom: 1980, yearTo: 2035 }];

type P = [string, string, string, CompatEntry[], boolean, number, number, number, string, number];
const T: P[] = [
  // sku, kind, name, compat, verified, qty, min, unit cost, supplier, lead days
  ["OIL-5W30-5L", "engine_oil", "Engine oil 5W-30 5 L", any, true, 22, 4, 34, "AutoParts North (demo)", 2],
  ["OIL-0W20-5L", "engine_oil", "Engine oil 0W-20 5 L (hybrid)", any, true, 3, 3, 41, "AutoParts North (demo)", 2],
  ["OFI-VAG-2201", "oil_filter", "Oil filter — VW Group 1.4–2.0", vw, true, 9, 3, 9, "EuroTrade Wholesale (demo)", 4],
  ["OFI-BMW-1140", "oil_filter", "Oil filter — BMW B47 diesel", bmw, true, 5, 2, 13, "EuroTrade Wholesale (demo)", 4],
  ["OFI-TYT-0907", "oil_filter", "Oil filter — Toyota/Honda/Mazda", toyota, true, 7, 3, 8, "AutoParts North (demo)", 2],
  ["OFI-FRD-3315", "oil_filter", "Oil filter — Ford Focus/Fiesta", ford, true, 10, 3, 8, "AutoParts North (demo)", 2],
  ["OFI-MBV-4410", "oil_filter", "Oil filter — Mercedes C / Volvo V60", merc, true, 0, 2, 15, "EuroTrade Wholesale (demo)", 5],
  ["OFI-ASN-5502", "oil_filter", "Oil filter — Nissan/Renault/Peugeot/Hyundai/Kia", asia, true, 8, 3, 8, "CityParts Express (demo)", 1],
  ["AFI-VAG-1180", "air_filter", "Air filter — VW Group", vw, true, 5, 2, 14, "EuroTrade Wholesale (demo)", 4],
  ["AFI-FRD-2290", "air_filter", "Air filter — Ford Focus/Fiesta", ford, true, 3, 2, 12, "AutoParts North (demo)", 2],
  ["AFI-TYT-3301", "air_filter", "Air filter — Toyota/Honda/Mazda", toyota, true, 4, 2, 13, "AutoParts North (demo)", 2],
  ["AFI-BMW-4402", "air_filter", "Air filter — BMW 320d", bmw, true, 1, 2, 19, "EuroTrade Wholesale (demo)", 4],
  ["CFI-VAG-1190", "cabin_filter", "Cabin filter — VW Group", vw, true, 6, 2, 11, "EuroTrade Wholesale (demo)", 4],
  ["CFI-FRD-2291", "cabin_filter", "Cabin filter — Ford Focus/Fiesta", ford, true, 4, 2, 10, "AutoParts North (demo)", 2],
  ["CFI-BMW-4403", "cabin_filter", "Cabin filter — BMW 320d", bmw, true, 3, 2, 16, "EuroTrade Wholesale (demo)", 4],
  ["CFI-TYT-3302", "cabin_filter", "Cabin filter — Toyota/Honda/Mazda", toyota, true, 2, 3, 10, "AutoParts North (demo)", 2],
  ["BPF-GLF-1201", "brake_pads_front", "Front brake pads — VW Golf 2012–2021", golf, true, 6, 2, 46, "AutoParts North (demo)", 3],
  ["BPF-BMW-3201", "brake_pads_front", "Front brake pads — BMW 320d 2014–2020", bmw, true, 3, 1, 62, "EuroTrade Wholesale (demo)", 5],
  ["BPF-FCS-2201", "brake_pads_front", "Front brake pads — Ford Focus", focus, true, 3, 1, 41, "AutoParts North (demo)", 3],
  ["BPF-COR-1401", "brake_pads_front", "Front brake pads — Toyota Corolla", corolla, true, 0, 2, 44, "CityParts Express (demo)", 2],
  ["BPF-CIV-1301", "brake_pads_front", "Front brake pads — Honda Civic (fitment unverified)", civic, false, 2, 1, 43, "CityParts Express (demo)", 2],
  ["BDF-GLF-1202", "brake_discs_front", "Front brake discs (pair) — VW Golf", golf, true, 0, 1, 96, "AutoParts North (demo)", 3],
  ["BDF-BMW-3202", "brake_discs_front", "Front brake discs (pair) — BMW 320d", bmw, true, 0, 1, 138, "EuroTrade Wholesale (demo)", 5],
  ["BDF-FCS-2202", "brake_discs_front", "Front brake discs (pair) — Ford Focus", focus, true, 2, 1, 88, "AutoParts North (demo)", 3],
  ["BDF-COR-1402", "brake_discs_front", "Front brake discs (pair) — Toyota Corolla", corolla, true, 1, 1, 92, "CityParts Express (demo)", 2],
  ["BPR-GLF-1203", "brake_pads_rear", "Rear brake pads — VW Golf", golf, true, 3, 1, 38, "AutoParts North (demo)", 3],
  ["BPR-FCS-2203", "brake_pads_rear", "Rear brake pads — Ford Focus", focus, true, 2, 1, 34, "AutoParts North (demo)", 3],
  ["BDR-GLF-1204", "brake_discs_rear", "Rear brake discs (pair) — VW Golf", golf, true, 1, 1, 78, "AutoParts North (demo)", 3],
  ["BFL-DOT4-1L", "brake_fluid", "Brake fluid DOT 4, 1 L", any, true, 12, 4, 11, "AutoParts North (demo)", 2],
  ["BAT-70AH-VFT", "battery", "Battery 70 Ah — VW/Ford/Toyota", expand(g([["Volkswagen", ["Golf"]], ["Ford", ["Focus", "Fiesta"]], ["Toyota", ["Corolla"]]])), true, 3, 2, 98, "CityParts Express (demo)", 1],
  ["BAT-60AH-NRP", "battery", "Battery 60 Ah — Nissan/Renault/Peugeot", expand(g([["Nissan", ["Qashqai"]], ["Renault", ["Clio"]], ["Peugeot", ["308"]]])), true, 0, 2, 86, "CityParts Express (demo)", 1],
  ["ACR-R134A", "ac_refrigerant", "A/C refrigerant R134a 500 g", any, true, 2, 3, 42, "EuroTrade Wholesale (demo)", 3],
  ["SPK-VAG-TSI", "spark_plugs_set", "Spark plug set — VW Group TSI", vw, true, 4, 2, 36, "EuroTrade Wholesale (demo)", 4],
  ["SPK-FRD-ECO", "spark_plugs_set", "Spark plug set — Ford EcoBoost", ford, true, 2, 2, 39, "AutoParts North (demo)", 2],
  ["TBK-FRD-1601", "timing_belt_kit", "Timing belt kit — Ford Focus/Fiesta", ford, true, 1, 1, 148, "AutoParts North (demo)", 3],
  ["TBK-GLF-1602", "timing_belt_kit", "Timing belt kit — VW Golf TDI", golf, true, 2, 1, 162, "EuroTrade Wholesale (demo)", 4],
  ["WPM-FRD-1701", "water_pump", "Water pump — Ford Focus/Fiesta", ford, true, 1, 1, 72, "AutoParts North (demo)", 3],
  ["WPM-GLF-1702", "water_pump", "Water pump — VW Golf", golf, true, 2, 1, 79, "EuroTrade Wholesale (demo)", 4],
  ["SRB-FRD-1801", "serpentine_belt", "Serpentine belt — Ford (fitment unverified)", ford, false, 2, 1, 31, "AutoParts North (demo)", 2],
  ["SRB-GLF-1802", "serpentine_belt", "Serpentine belt — VW Golf", golf, true, 3, 1, 33, "EuroTrade Wholesale (demo)", 4],
  ["CLT-G12-5L", "coolant", "Coolant G12 5 L", any, true, 9, 3, 19, "AutoParts North (demo)", 2],
  ["CLK-FCS-1901", "clutch_kit", "Clutch kit — Ford Focus", focus, true, 0, 1, 235, "EuroTrade Wholesale (demo)", 5],
  ["CLK-GLF-1902", "clutch_kit", "Clutch kit — VW Golf", golf, true, 1, 1, 249, "EuroTrade Wholesale (demo)", 5],
  ["SHF-GLF-2001", "shock_absorber_front", "Front shock absorber — VW Golf", golf, true, 4, 2, 84, "AutoParts North (demo)", 3],
  ["SHF-FCS-2002", "shock_absorber_front", "Front shock absorber — Ford Focus", focus, true, 2, 2, 79, "AutoParts North (demo)", 3],
  ["WBF-GLF-2101", "wheel_bearing_front", "Front wheel bearing — VW Golf", golf, true, 3, 1, 54, "AutoParts North (demo)", 3],
  ["WBF-FCS-2102", "wheel_bearing_front", "Front wheel bearing — Ford Focus", focus, true, 1, 1, 49, "AutoParts North (demo)", 3],
  ["WBF-COR-2103", "wheel_bearing_front", "Front wheel bearing — Toyota Corolla", corolla, true, 2, 1, 58, "CityParts Express (demo)", 2],
  ["WIP-UNI-600", "wiper_blades", "Wiper blade set 600/450 mm (universal)", any, true, 8, 3, 21, "CityParts Express (demo)", 1],
];
void VWG;

export function startingParts(): Part[] {
  return T.map(([sku, kind, name, compat, compatVerified, quantity, minStock, unitCost, supplier, leadDays], i) => ({
    id: `P-${String(i + 1).padStart(3, "0")}`, sku, kind, name, compat, compatVerified, quantity, minStock, unitCost, supplier, leadDays,
  }));
}
