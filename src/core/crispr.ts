import { readMoleculeSequence } from "./context.js";
import { MoleculeError } from "./errors.js";
import type { GuideRankingEvidence } from "./schema.js";
import { reverseComplement } from "./sequence.js";

export type GrnaStrandOption = "both" | "+" | "-";
export type GrnaRange = [number, number];

export type DesignGrnasOptions = {
  pamType?: "SpCas9";
  guideLength?: number;
  strand?: GrnaStrandOption;
  gcRange?: GrnaRange;
  maxSeedHomopolymerRun?: number;
  offTargetMoleculeIds?: string[];
  maxOffTargetMismatches?: number;
};

export type DesignGrnasInput = {
  workspacePath: string;
  moleculeId: string;
  targetRegion: {
    start: number;
    end: number;
  };
  options?: DesignGrnasOptions;
};

export type OffTargetHit = {
  moleculeId: string;
  start: number;
  end: number;
  strand: "+" | "-";
  pam: string;
  mismatches: number;
  seedMismatches: number;
};

export type GuideCandidate = {
  sequence: string;
  pam: string;
  strand: "+" | "-";
  start: number;
  end: number;
  pamStart: number;
  pamEnd: number;
  gcPercent: number;
  seedRegionMaxHomopolymer: number;
  offTargets: OffTargetHit[];
  passingFilters: boolean;
  filterFailures: string[];
  rankingEvidence: GuideRankingEvidence;
};

export type DesignGrnasResult = {
  moleculeId: string;
  targetRegion: { start: number; end: number };
  pamType: "SpCas9";
  offTargetScope: "workspace_molecules_only";
  candidates: GuideCandidate[];
  nextAction: {
    tool: "upsert_grna";
    instruction: string;
  };
};

type NormalizedGrnaOptions = {
  pamType: "SpCas9";
  guideLength: 20;
  strand: GrnaStrandOption;
  gcRange: GrnaRange;
  maxSeedHomopolymerRun: number;
  offTargetMoleculeIds: string[];
  maxOffTargetMismatches: number;
};

type PamSite = {
  sequence: string;
  pam: string;
  strand: "+" | "-";
  start: number;
  end: number;
  pamStart: number;
  pamEnd: number;
};

export async function designGrnas(input: DesignGrnasInput): Promise<DesignGrnasResult> {
  const { molecule, sequence } = await readMoleculeSequence(input.workspacePath, input.moleculeId);
  if (molecule.alphabet !== "iupac_dna" || molecule.moleculeType !== "dna") {
    throw new MoleculeError("ALPHABET_MISMATCH", "gRNA design requires a DNA molecule.", {
      moleculeId: input.moleculeId,
      alphabet: molecule.alphabet,
      moleculeType: molecule.moleculeType,
    });
  }

  const options = normalizeGrnaOptions(input.options, input.moleculeId);
  validateRegion(input.targetRegion, sequence.length, "targetRegion");
  const candidates = scanSpCas9Guides(sequence, input.targetRegion, options);
  const offTargetSequences = await Promise.all(options.offTargetMoleculeIds.map(async (id) => {
    const resolved = await readMoleculeSequence(input.workspacePath, id);
    return { moleculeId: id, sequence: resolved.sequence };
  }));

  const withOffTargets = candidates.map((candidate) => withRankingEvidence({
    ...candidate,
    offTargets: findWorkspaceOffTargets(candidate, offTargetSequences, {
      sourceMoleculeId: input.moleculeId,
      maxMismatches: options.maxOffTargetMismatches,
    }),
  }));

  return {
    moleculeId: input.moleculeId,
    targetRegion: input.targetRegion,
    pamType: "SpCas9",
    offTargetScope: "workspace_molecules_only",
    candidates: rankGuideCandidates(withOffTargets),
    nextAction: {
      tool: "upsert_grna",
      instruction: "Select a candidate, then call upsert_grna with expectedRevision to persist it.",
    },
  };
}

export function scanSpCas9Guides(
  sequence: string,
  targetRegion: { start: number; end: number },
  options: Partial<NormalizedGrnaOptions> = {},
): GuideCandidate[] {
  validateRegion(targetRegion, sequence.length, "targetRegion");
  const normalized: NormalizedGrnaOptions = {
    pamType: "SpCas9",
    guideLength: 20,
    strand: options.strand ?? "both",
    gcRange: options.gcRange ?? [20, 80],
    maxSeedHomopolymerRun: options.maxSeedHomopolymerRun ?? 4,
    offTargetMoleculeIds: options.offTargetMoleculeIds ?? [],
    maxOffTargetMismatches: options.maxOffTargetMismatches ?? 3,
  };
  const sites = scanAllSpCas9Sites(sequence, normalized.strand).filter((site) => site.start >= targetRegion.start && site.end <= targetRegion.end);
  return sites.map((site) => annotateGuide(site, normalized));
}

export function findWorkspaceOffTargets(
  candidate: GuideCandidate,
  references: Array<{ moleculeId: string; sequence: string }>,
  options: { sourceMoleculeId: string; maxMismatches: number },
): OffTargetHit[] {
  const hits: OffTargetHit[] = [];
  for (const reference of references) {
    for (const site of scanAllSpCas9Sites(reference.sequence, "both")) {
      if (
        reference.moleculeId === options.sourceMoleculeId &&
        site.start === candidate.start &&
        site.end === candidate.end &&
        site.pamStart === candidate.pamStart &&
        site.pamEnd === candidate.pamEnd &&
        site.strand === candidate.strand
      ) {
        continue;
      }
      const mismatches = countMismatches(candidate.sequence, site.sequence);
      if (mismatches <= options.maxMismatches) {
        hits.push({
          moleculeId: reference.moleculeId,
          start: site.start,
          end: site.end,
          strand: site.strand,
          pam: site.pam,
          mismatches,
          seedMismatches: countMismatches(candidate.sequence.slice(8), site.sequence.slice(8)),
        });
      }
    }
  }
  return hits.sort((a, b) => a.mismatches - b.mismatches || a.seedMismatches - b.seedMismatches || a.moleculeId.localeCompare(b.moleculeId) || a.start - b.start || strandOrder(a.strand) - strandOrder(b.strand));
}

export function normalizeGrnaOptions(options: DesignGrnasOptions = {}, sourceMoleculeId?: string): NormalizedGrnaOptions {
  if (options.pamType !== undefined && options.pamType !== "SpCas9") {
    throw new MoleculeError("INVALID_ARGUMENT", "pamType must be 'SpCas9' in CR1.", { pamType: options.pamType });
  }
  if (options.guideLength !== undefined && options.guideLength !== 20) {
    throw new MoleculeError("INVALID_ARGUMENT", "guideLength must be 20 in CR1.", { guideLength: options.guideLength });
  }
  const strand = options.strand ?? "both";
  if (strand !== "both" && strand !== "+" && strand !== "-") {
    throw new MoleculeError("INVALID_ARGUMENT", "strand must be 'both', '+', or '-'.", { strand });
  }
  const gcRange = validateRange(options.gcRange ?? [20, 80], "gcRange");
  const maxSeedHomopolymerRun = options.maxSeedHomopolymerRun ?? 4;
  if (!Number.isInteger(maxSeedHomopolymerRun) || maxSeedHomopolymerRun < 1) {
    throw new MoleculeError("INVALID_ARGUMENT", "maxSeedHomopolymerRun must be a positive integer.", { maxSeedHomopolymerRun });
  }
  const maxOffTargetMismatches = options.maxOffTargetMismatches ?? 3;
  if (!Number.isInteger(maxOffTargetMismatches) || maxOffTargetMismatches < 0) {
    throw new MoleculeError("INVALID_ARGUMENT", "maxOffTargetMismatches must be a non-negative integer.", { maxOffTargetMismatches });
  }
  const offTargetMoleculeIds = options.offTargetMoleculeIds ?? (sourceMoleculeId ? [sourceMoleculeId] : []);
  if (!Array.isArray(offTargetMoleculeIds) || !offTargetMoleculeIds.every((id) => typeof id === "string" && id.length > 0)) {
    throw new MoleculeError("INVALID_ARGUMENT", "offTargetMoleculeIds must be non-empty strings.", { offTargetMoleculeIds });
  }
  return {
    pamType: "SpCas9",
    guideLength: 20,
    strand,
    gcRange,
    maxSeedHomopolymerRun,
    offTargetMoleculeIds,
    maxOffTargetMismatches,
  };
}

function scanAllSpCas9Sites(sequence: string, strand: GrnaStrandOption): PamSite[] {
  const sites: PamSite[] = [];
  for (let index = 0; index <= sequence.length - 3; index += 1) {
    const pam = sequence.slice(index, index + 3);
    if ((strand === "both" || strand === "+") && isNgG(pam)) {
      const protospacerStart = index - 20;
      if (protospacerStart >= 0) {
        sites.push({
          sequence: sequence.slice(protospacerStart, index),
          pam,
          strand: "+",
          start: protospacerStart + 1,
          end: index,
          pamStart: index + 1,
          pamEnd: index + 3,
        });
      }
    }
    if ((strand === "both" || strand === "-") && isCcn(pam)) {
      const protospacerStart = index + 3;
      const protospacerEnd = index + 23;
      if (protospacerEnd <= sequence.length) {
        sites.push({
          sequence: reverseComplement(sequence.slice(protospacerStart, protospacerEnd)),
          pam: reverseComplement(pam),
          strand: "-",
          start: protospacerStart + 1,
          end: protospacerEnd,
          pamStart: index + 1,
          pamEnd: index + 3,
        });
      }
    }
  }
  return sites.sort((a, b) => a.start - b.start || a.end - b.end || strandOrder(a.strand) - strandOrder(b.strand));
}

function annotateGuide(site: PamSite, options: NormalizedGrnaOptions): GuideCandidate {
  const gcPercent = Math.round((gcCount(site.sequence) / site.sequence.length) * 10000) / 100;
  const seedRegionMaxHomopolymer = maxHomopolymerRun(site.sequence.slice(8));
  const filterFailures: string[] = [];
  if (gcPercent < options.gcRange[0] || gcPercent > options.gcRange[1]) filterFailures.push("GC_OUT_OF_RANGE");
  if (seedRegionMaxHomopolymer > options.maxSeedHomopolymerRun) filterFailures.push("SEED_HOMOPOLYMER_TOO_LONG");
  return {
    ...site,
    gcPercent,
    seedRegionMaxHomopolymer,
    offTargets: [],
    passingFilters: filterFailures.length === 0,
    filterFailures,
    rankingEvidence: {
      passingFilters: filterFailures.length === 0,
      filterFailures: [...filterFailures],
      offTargetHitCount: 0,
      gcDistanceFrom50: Math.round(Math.abs(gcPercent - 50) * 100) / 100,
      guideStart: site.start,
      strand: site.strand,
      efficacyScoreIncluded: false,
    },
  };
}

function withRankingEvidence(candidate: GuideCandidate): GuideCandidate {
  return {
    ...candidate,
    rankingEvidence: {
      passingFilters: candidate.passingFilters,
      filterFailures: [...candidate.filterFailures],
      offTargetHitCount: candidate.offTargets.length,
      gcDistanceFrom50: Math.round(Math.abs(candidate.gcPercent - 50) * 100) / 100,
      guideStart: candidate.start,
      strand: candidate.strand,
      efficacyScoreIncluded: false,
    },
  };
}

function rankGuideCandidates(candidates: GuideCandidate[]): GuideCandidate[] {
  return [...candidates].sort((a, b) =>
    Number(b.passingFilters) - Number(a.passingFilters) ||
    a.offTargets.length - b.offTargets.length ||
    Math.abs(a.gcPercent - 50) - Math.abs(b.gcPercent - 50) ||
    a.start - b.start ||
    a.end - b.end ||
    strandOrder(a.strand) - strandOrder(b.strand)
  );
}

function validateRegion(region: { start: number; end: number }, moleculeLength: number, name: string): void {
  if (!Number.isInteger(region.start) || !Number.isInteger(region.end) || region.start < 1 || region.end < 1 || region.start > region.end || region.end > moleculeLength) {
    throw new MoleculeError("COORDINATE_OUT_OF_RANGE", `${name} coordinates are invalid.`, { [name]: region, moleculeLength });
  }
}

function validateRange(value: GrnaRange, name: string): GrnaRange {
  if (!Array.isArray(value) || value.length !== 2 || !value.every((entry) => typeof entry === "number" && Number.isFinite(entry)) || value[0] < 0 || value[1] > 100 || value[0] > value[1]) {
    throw new MoleculeError("INVALID_ARGUMENT", `${name} must be an ordered 0-100 range.`, { [name]: value });
  }
  return value;
}

function isNgG(value: string): boolean {
  return value.length === 3 && value[1] === "G" && value[2] === "G";
}

function isCcn(value: string): boolean {
  return value.length === 3 && value[0] === "C" && value[1] === "C";
}

function gcCount(sequence: string): number {
  return [...sequence].filter((base) => base === "G" || base === "C").length;
}

function maxHomopolymerRun(sequence: string): number {
  let max = 0;
  let current = 0;
  let previous = "";
  for (const base of sequence) {
    current = base === previous ? current + 1 : 1;
    previous = base;
    if (current > max) max = current;
  }
  return max;
}

function countMismatches(left: string, right: string): number {
  let mismatches = 0;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) mismatches += 1;
  }
  return mismatches;
}

function strandOrder(strand: "+" | "-"): number {
  return strand === "+" ? 0 : 1;
}
