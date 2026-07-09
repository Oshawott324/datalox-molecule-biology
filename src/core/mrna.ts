import { getSequenceContext } from "./context.js";
import { MoleculeError } from "./errors.js";
import type { Feature } from "./schema.js";

/**
 * M1 `validate_mrna_construct`.
 *
 * Validates that a molecule's workspace features contain the required mRNA elements in
 * 5'->3' order and that each element passes deterministic biological-integrity checks.
 * This is validation, not design: the agent supplies the element map (by featureId,
 * explicit coordinates, or by leaving resolution to a feature-type scan) and this tool
 * reports pass/warning/fail per check. No heuristics, no network.
 */

export type MrnaElementType =
  | "five_utr"
  | "kozak"
  | "cds"
  | "three_utr"
  | "polya_signal"
  | "polya_tail"
  | "t7_promoter"
  | "sp6_promoter"
  | "ivt_site";

export type MrnaTemplateType = "mrna" | "plasmid_template";

export type MrnaElementReference = {
  type: MrnaElementType;
  featureId?: string;
  coordinates?: { start: number; end: number };
};

export type ValidateMrnaConstructInput = {
  moleculeId: string;
  templateType: MrnaTemplateType;
  elements: MrnaElementReference[];
};

export type MrnaCheckStatus = "pass" | "warning" | "fail";

export type MrnaCheck = {
  checkId: string;
  element: string;
  status: MrnaCheckStatus;
  detail: string;
  coordinates?: { start: number; end: number };
};

export type ValidateMrnaConstructResult = {
  moleculeId: string;
  templateType: MrnaTemplateType;
  checks: MrnaCheck[];
  passCount: number;
  warningCount: number;
  failCount: number;
  summary: "valid" | "valid_with_warnings" | "invalid";
};

type ResolvedElement = {
  type: MrnaElementType;
  start: number;
  end: number;
  source: "coordinates" | "feature" | "inferred";
};

const STOP_CODONS = new Set(["TAA", "TAG", "TGA"]);

// Expected 5'->3' order rank. Lower rank must not start after a higher-rank element.
const ELEMENT_ORDER_RANK: Record<MrnaElementType, number> = {
  t7_promoter: 0,
  sp6_promoter: 0,
  five_utr: 1,
  kozak: 2,
  cds: 3,
  three_utr: 4,
  polya_signal: 5,
  polya_tail: 6,
  ivt_site: 7,
};

export async function validateMrnaConstruct(
  workspacePath: string,
  input: ValidateMrnaConstructInput,
): Promise<ValidateMrnaConstructResult> {
  const { moleculeId, templateType, elements } = input;
  const context = await getSequenceContext(workspacePath, moleculeId, {
    includeSequence: true,
    includeFeatures: true,
    includePrimers: false,
    includeGuides: false,
  });
  const sequence = context.sequence ?? "";
  const normalized = sequence.toUpperCase().replace(/U/g, "T");
  const length = context.molecule.length;
  const features = context.features ?? [];

  const resolved = new Map<MrnaElementType, ResolvedElement>();
  for (const element of elements) {
    const entry = resolveElement(element, features, length);
    if (entry && !resolved.has(element.type)) {
      resolved.set(element.type, entry);
    }
  }

  const checks: MrnaCheck[] = [];

  // Required-element presence.
  for (const requirement of requiredElements(templateType)) {
    const present = requirement.anyOf.some((type) => resolved.has(type));
    if (!present) {
      checks.push({
        checkId: "ELEMENT_PRESENT",
        element: requirement.label,
        status: "fail",
        detail: `Required element ${requirement.label} was not resolved from a featureId, coordinates, or a feature-type scan.`,
      });
    }
  }

  checks.push(elementOrderCheck(resolved));

  const cds = resolved.get("cds");
  if (cds) {
    checks.push(...cdsChecks(cds, normalized));
    checks.push(kozakCheck(cds, normalized, length));
  }

  const threeUtr = resolved.get("three_utr");
  if (threeUtr) {
    checks.push(polyaSignalCheck(threeUtr, resolved.get("polya_tail"), normalized, length));
  }

  if (templateType === "plasmid_template") {
    const promoter = resolved.get("t7_promoter") ?? resolved.get("sp6_promoter");
    const fiveUtr = resolved.get("five_utr");
    if (promoter && fiveUtr) {
      const ok = promoter.end < fiveUtr.start;
      checks.push({
        checkId: "PROMOTER_UPSTREAM_OF_5UTR",
        element: promoter.type,
        status: ok ? "pass" : "fail",
        detail: ok
          ? `Promoter ends at ${promoter.end}, upstream of the 5'UTR start at ${fiveUtr.start}.`
          : `Promoter ends at ${promoter.end}, which is not upstream of the 5'UTR start at ${fiveUtr.start}.`,
        coordinates: { start: promoter.start, end: promoter.end },
      });
    }

    const ivt = resolved.get("ivt_site");
    const polya = resolved.get("polya_signal") ?? resolved.get("polya_tail");
    if (ivt && polya) {
      const ok = ivt.start > polya.end;
      checks.push({
        checkId: "IVT_SITE_DOWNSTREAM_OF_POLYA",
        element: "ivt_site",
        status: ok ? "pass" : "fail",
        detail: ok
          ? `IVT linearization site starts at ${ivt.start}, downstream of the polyadenylation element ending at ${polya.end}.`
          : `IVT linearization site starts at ${ivt.start}, which is not downstream of the polyadenylation element ending at ${polya.end}.`,
        coordinates: { start: ivt.start, end: ivt.end },
      });
    }
  }

  return summarize(moleculeId, templateType, checks);
}

function requiredElements(templateType: MrnaTemplateType): Array<{ label: string; anyOf: MrnaElementType[] }> {
  const base: Array<{ label: string; anyOf: MrnaElementType[] }> = [
    { label: "five_utr", anyOf: ["five_utr"] },
    { label: "cds", anyOf: ["cds"] },
    { label: "three_utr", anyOf: ["three_utr"] },
  ];
  if (templateType === "plasmid_template") {
    base.push({ label: "t7_promoter|sp6_promoter", anyOf: ["t7_promoter", "sp6_promoter"] });
    base.push({ label: "ivt_site", anyOf: ["ivt_site"] });
  }
  return base;
}

function resolveElement(element: MrnaElementReference, features: Feature[], length: number): ResolvedElement | undefined {
  if (element.coordinates) {
    const { start, end } = element.coordinates;
    assertInRange(start, end, length, element.type);
    return { type: element.type, start, end, source: "coordinates" };
  }
  if (element.featureId !== undefined) {
    const feature = features.find((candidate) => candidate.id === element.featureId);
    if (!feature) {
      throw new MoleculeError("FEATURE_NOT_FOUND", "Feature referenced by an mRNA element was not found.", {
        elementType: element.type,
        featureId: element.featureId,
      });
    }
    const span = featureSpan(feature);
    return { type: element.type, start: span.start, end: span.end, source: "feature" };
  }
  const inferred = features.find((candidate) => featureMatchesType(candidate, element.type));
  if (!inferred) return undefined;
  const span = featureSpan(inferred);
  return { type: element.type, start: span.start, end: span.end, source: "inferred" };
}

function featureSpan(feature: Feature): { start: number; end: number } {
  if (feature.segments.length === 0) {
    throw new MoleculeError("INVALID_ARGUMENT", "Feature has no coordinate segments.", { featureId: feature.id });
  }
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  for (const segment of feature.segments) {
    if (segment.start < start) start = segment.start;
    if (segment.end > end) end = segment.end;
  }
  return { start, end };
}

// Canonical GenBank feature-type mapping from docs/mrna-construct-spec.md conventions table.
function featureMatchesType(feature: Feature, type: MrnaElementType): boolean {
  switch (type) {
    case "five_utr":
      return feature.type === "5'UTR";
    case "three_utr":
      return feature.type === "3'UTR";
    case "cds":
      return feature.type === "CDS";
    case "polya_signal":
      return feature.type === "polyA_signal";
    case "polya_tail":
      return feature.type === "polyA_site";
    case "kozak":
      return feature.type === "regulatory" && qualifierIncludes(feature, "regulatory_class", "ribosome_binding_site");
    case "t7_promoter":
      return feature.type === "promoter" && qualifierIncludes(feature, "note", "T7");
    case "sp6_promoter":
      return feature.type === "promoter" && qualifierIncludes(feature, "note", "SP6");
    case "ivt_site":
      return feature.type === "misc_feature" && qualifierIncludes(feature, "note", "IVT_linearization_site");
    default:
      return false;
  }
}

function qualifierIncludes(feature: Feature, key: string, needle: string): boolean {
  const raw = feature.qualifiers?.[key];
  if (raw === undefined) return false;
  const values = Array.isArray(raw) ? raw : [raw];
  const target = needle.toUpperCase();
  return values.some((value) => value.toUpperCase().includes(target));
}

function elementOrderCheck(resolved: Map<MrnaElementType, ResolvedElement>): MrnaCheck {
  const ordered = [...resolved.values()].sort((a, b) => ELEMENT_ORDER_RANK[a.type] - ELEMENT_ORDER_RANK[b.type]);
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    if (previous.start > current.start) {
      return {
        checkId: "ELEMENT_ORDER",
        element: `${previous.type},${current.type}`,
        status: "fail",
        detail: `${previous.type} starts at ${previous.start}, after the later-expected ${current.type} at ${current.start}. Elements must be in 5'->3' order.`,
      };
    }
    // Kozak is permitted to overlap the UTR/CDS boundary; all other adjacent resolved
    // elements must be non-overlapping.
    const isKozakAdjacent = previous.type === "kozak" || current.type === "kozak";
    if (!isKozakAdjacent && previous.end >= current.start) {
      return {
        checkId: "ELEMENT_ORDER",
        element: `${previous.type},${current.type}`,
        status: "fail",
        detail: `${previous.type} (1..${previous.end}) overlaps ${current.type} (${current.start}..${current.end}). Adjacent mRNA elements must not overlap.`,
      };
    }
  }
  return {
    checkId: "ELEMENT_ORDER",
    element: "construct",
    status: "pass",
    detail: `Resolved elements are in 5'->3' order: ${ordered.map((entry) => entry.type).join(" < ") || "(none)"}.`,
  };
}

function cdsChecks(cds: ResolvedElement, normalized: string): MrnaCheck[] {
  const cdsSeq = normalized.slice(cds.start - 1, cds.end);
  const coordinates = { start: cds.start, end: cds.end };
  const results: MrnaCheck[] = [];

  const firstCodon = cdsSeq.slice(0, 3);
  results.push({
    checkId: "CDS_STARTS_WITH_ATG",
    element: "cds",
    status: firstCodon === "ATG" ? "pass" : "fail",
    detail: firstCodon === "ATG" ? "CDS starts with ATG." : `CDS starts with ${firstCodon || "(too short)"}, not ATG.`,
    coordinates,
  });

  const cdsLength = cds.end - cds.start + 1;
  const remainder = cdsLength % 3;
  results.push({
    checkId: "CDS_IN_FRAME",
    element: "cds",
    status: remainder === 0 ? "pass" : "fail",
    detail: remainder === 0 ? `CDS length ${cdsLength} is divisible by 3.` : `CDS length ${cdsLength} is not divisible by 3 (remainder ${remainder}).`,
    coordinates,
  });

  const lastCodon = cdsSeq.slice(-3);
  const hasStop = cdsSeq.length >= 3 && STOP_CODONS.has(lastCodon);
  results.push({
    checkId: "CDS_HAS_STOP_CODON",
    element: "cds",
    status: hasStop ? "pass" : "fail",
    detail: hasStop ? `CDS ends with stop codon ${lastCodon}.` : `CDS ends with ${lastCodon || "(too short)"}, not a stop codon (TAA/TAG/TGA).`,
    coordinates,
  });

  const fullCodons = Math.floor(cdsSeq.length / 3);
  let prematureAt: { position: number; codon: string } | undefined;
  for (let codon = 0; codon < fullCodons - 1; codon += 1) {
    const triplet = cdsSeq.slice(codon * 3, codon * 3 + 3);
    if (STOP_CODONS.has(triplet)) {
      prematureAt = { position: cds.start + codon * 3, codon: triplet };
      break;
    }
  }
  results.push({
    checkId: "CDS_NO_PREMATURE_STOP",
    element: "cds",
    status: prematureAt ? "fail" : "pass",
    detail: prematureAt
      ? `In-frame stop codon ${prematureAt.codon} found at position ${prematureAt.position}, before the final codon.`
      : "No premature in-frame stop codons in the CDS.",
    coordinates,
  });

  return results;
}

function kozakCheck(cds: ResolvedElement, normalized: string, length: number): MrnaCheck {
  const minus3 = cds.start - 3;
  const plus4 = cds.start + 3;
  if (minus3 < 1 || plus4 > length) {
    return {
      checkId: "KOZAK_CONTEXT",
      element: "cds",
      status: "warning",
      detail: "Molecule is too short to read the -3 and +4 Kozak context around the start codon.",
      coordinates: { start: cds.start, end: cds.end },
    };
  }
  const baseMinus3 = normalized[minus3 - 1];
  const basePlus4 = normalized[plus4 - 1];
  const strongMinus3 = baseMinus3 === "A" || baseMinus3 === "G";
  const strongPlus4 = basePlus4 === "G";
  const bothStrong = strongMinus3 && strongPlus4;
  return {
    checkId: "KOZAK_CONTEXT",
    element: "cds",
    status: bothStrong ? "pass" : "warning",
    detail: bothStrong
      ? `Strong Kozak context: ${baseMinus3} at -3 and G at +4.`
      : `Suboptimal Kozak context: -3 is ${baseMinus3} (want A/G), +4 is ${basePlus4} (want G).`,
    coordinates: { start: cds.start, end: cds.end },
  };
}

function polyaSignalCheck(
  threeUtr: ResolvedElement,
  polyaTail: ResolvedElement | undefined,
  normalized: string,
  length: number,
): MrnaCheck {
  const windowStart = threeUtr.start;
  const windowEnd = Math.min(length, threeUtr.end + 30);
  const region = normalized.slice(windowStart - 1, windowEnd);
  const found = /AATAAA|ATTAAA/.test(region);
  const tailNote = polyaTail ? " An encoded polyA tail is annotated." : "";
  return {
    checkId: "POLYA_SIGNAL_PRESENT",
    element: "three_utr",
    status: found ? "pass" : "warning",
    detail: found
      ? `PolyA signal hexamer (AATAAA/ATTAAA) found within the 3'UTR and up to 30 bases downstream.${tailNote}`
      : `No polyA signal hexamer (AATAAA/ATTAAA) within the 3'UTR and up to 30 bases downstream.${tailNote}`,
    coordinates: { start: windowStart, end: windowEnd },
  };
}

function summarize(moleculeId: string, templateType: MrnaTemplateType, checks: MrnaCheck[]): ValidateMrnaConstructResult {
  let passCount = 0;
  let warningCount = 0;
  let failCount = 0;
  for (const check of checks) {
    if (check.status === "pass") passCount += 1;
    else if (check.status === "warning") warningCount += 1;
    else failCount += 1;
  }
  const summary = failCount > 0 ? "invalid" : warningCount > 0 ? "valid_with_warnings" : "valid";
  return { moleculeId, templateType, checks, passCount, warningCount, failCount, summary };
}

function assertInRange(start: number, end: number, length: number, elementType: MrnaElementType): void {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > length) {
    throw new MoleculeError("COORDINATE_OUT_OF_RANGE", "mRNA element coordinates are invalid.", {
      elementType,
      start,
      end,
      length,
    });
  }
}
