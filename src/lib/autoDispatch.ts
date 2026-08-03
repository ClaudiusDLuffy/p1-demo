import { createServerClient } from "./supabase/server";
import type { ParsedWorkOrder } from "./emailParser";
import { normalizeStateCode } from "./billingRules";

type DispatchRule = {
  territory: string[];
  trades: string[];
  contractorEmail: string;
  contractorName: string;
};

const DISPATCH_RULES: DispatchRule[] = [
  {
    territory: ["Dallas", "DFW"],
    trades: ["hvac", "refrigeration"],
    contractorEmail: "scrcdallastexas@gmail.com",
    contractorName: "Derek Starnes",
  },
  {
    territory: ["Dallas", "DFW"],
    trades: ["slurpee", "beverage"],
    contractorEmail: "matthew@beardsrefrigeration.com",
    contractorName: "Matthew Beard",
  },
  {
    territory: ["Dallas", "DFW"],
    trades: ["ems"],
    contractorEmail: "AMGservice01@outlook.com",
    contractorName: "Anderson Mechanical",
  },
  {
    territory: ["Houston"],
    trades: ["hvac", "refrigeration", "ice"],
    contractorEmail: "service@archerref.com",
    contractorName: "Chris Archer",
  },
  {
    territory: ["Virginia", "VA", "Virginia Beach"],
    trades: ["hvac", "refrigeration", "ice"],
    contractorEmail: "pro.ops.inc@gmail.com",
    contractorName: "Pro-Ops",
  },
];

const containsAny = (text: string, values: string[]) => {
  const normalized = text.toLowerCase();
  return values.some(value => normalized.includes(value.toLowerCase()));
};

const normalize = (value: string | null | undefined) => (value || "").trim().toLowerCase();

export const requiresManualContractorAssignment = (parsed: ParsedWorkOrder) =>
  ["TX", "FL"].includes(normalizeStateCode(parsed.state));

export const detectDispatchTrade = (parsed: ParsedWorkOrder): string | null => {
  const lineOfService = normalize(parsed.lineOfService);
  const businessService = normalize(parsed.businessService);
  const category = normalize(parsed.category);

  if (lineOfService.includes("frozen beverage") || businessService.includes("slurpee")) return "slurpee";
  if (lineOfService.includes("ems") || businessService.includes("ems")) return "ems";
  if (lineOfService.includes("hvac") || category.includes("hvac") || businessService.includes("hvac")) return "hvac";
  if (lineOfService.includes("refrigeration") || businessService.includes("refrigeration")) return "refrigeration";
  if (/\bice\b/.test(lineOfService) || /\bice\b/.test(category)) return "ice";
  return null;
};

export const detectDispatchTerritory = (parsed: ParsedWorkOrder): string[] => {
  const city = normalize(parsed.city);
  const state = normalize(parsed.state);
  const address = parsed.address || "";
  const parts = address.split(",").map(part => part.trim());
  const parsedCity = city || normalize(parts[1]);
  const parsedState = state || normalize(parts[2]);

  if (parsedState === "fl") return ["Florida", "FL"];
  if (parsedState === "va" || parsedCity === "virginia beach") return ["Virginia", "VA", "Virginia Beach"];
  if (["houston", "league city", "stafford"].includes(parsedCity)) return ["Houston"];
  if ([
    "addison",
    "arlington",
    "carrollton",
    "dallas",
    "denton",
    "fort worth",
    "frisco",
    "garland",
    "grand prairie",
    "irving",
    "justin",
    "mckinney",
    "mesquite",
    "plano",
    "richardson",
  ].includes(parsedCity)) {
    return ["Dallas", "DFW"];
  }
  if (parsedState === "tx") return ["Texas", "TX"];
  return [parsed.city, parsed.state].filter(Boolean) as string[];
};

export async function resolveContractor(
  parsed: ParsedWorkOrder,
): Promise<{ contractorId: string | null; contractorEmail?: string | null; contractorName?: string | null; reason: string }> {
  if (requiresManualContractorAssignment(parsed)) {
    const state = normalizeStateCode(parsed.state);
    return { contractorId: null, reason: `manual assignment required for ${state}` };
  }

  const territoryText = detectDispatchTerritory(parsed).join(" ");
  const trade = detectDispatchTrade(parsed);
  const tradeText = trade || "";

  const vaOverride = containsAny(territoryText, ["Virginia", "VA", "Virginia Beach"]);
  const rule = vaOverride
    ? DISPATCH_RULES.find(item => item.contractorEmail === "pro.ops.inc@gmail.com")
    : DISPATCH_RULES.find(item =>
      containsAny(territoryText, item.territory) && containsAny(tradeText, item.trades),
    );

  if (!rule) {
    return { contractorId: null, reason: "no routing rule" };
  }

  try {
    const sb = createServerClient();
    const { data, error } = await sb
      .from("profiles")
      .select("id,email,name")
      .ilike("email", rule.contractorEmail)
      .maybeSingle();

    if (error) {
      console.error("Contractor lookup failed", error);
      return { contractorId: null, reason: `routing matched ${rule.contractorName}, but lookup failed` };
    }

    if (!data?.id) {
      return { contractorId: null, reason: `routing matched ${rule.contractorName}, but profile was not found` };
    }

    return {
      contractorId: data.id,
      contractorEmail: data.email,
      contractorName: data.name || rule.contractorName,
      reason: vaOverride
        ? `matched ${rule.contractorName} by VA territory`
        : `matched ${rule.contractorName} by territory/trade`,
    };
  } catch (err) {
    console.error("Contractor routing error", err);
    return { contractorId: null, reason: `routing matched ${rule.contractorName}, but lookup errored` };
  }
}
