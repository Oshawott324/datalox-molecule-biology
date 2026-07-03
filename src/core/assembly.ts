import { promises as fs } from "node:fs";
import path from "node:path";

import { MoleculeError } from "./errors.js";
import { findRestrictionSites, RESTRICTION_ENZYMES, type RestrictionSite } from "./enzymes.js";
import { readMoleculeSequence } from "./context.js";
import { workspaceRootFromPath } from "./paths.js";
import { reverseComplement, sequenceDigest } from "./sequence.js";

export const RESTRICTION_LIGATION_PROFILE_VERSION = "datalox_neb_ligation_profiles_v1";

export type RestrictionEndType = "five_prime_overhang" | "three_prime_overhang" | "blunt";

export type RestrictionLigationProfile = {
  enzyme: string;
  recognitionSequence: string;
  topCutOffset: number;
  bottomCutOffset: number;
  endType: RestrictionEndType;
  overhangSequence: string;
  source: "NEB";
  sourceUrl: string;
};

export type RestrictionFragmentEnd = {
  enzyme: string;
  endType: RestrictionEndType;
  overhangSequence: string;
  ligationProfileVersion: typeof RESTRICTION_LIGATION_PROFILE_VERSION;
};

export type RestrictionEndCompatibility = {
  compatible: boolean;
  left: RestrictionFragmentEnd;
  right: RestrictionFragmentEnd;
  reason?: "END_TYPE_MISMATCH" | "OVERHANG_MISMATCH";
};

export type AssemblyFragmentSelector = "largest_fragment";

export type AssemblySourceSegment = {
  start: number;
  end: number;
  strand: "+" | "-";
};

export type AssemblyFragment = {
  id: string;
  size: number;
  start: number;
  end: number;
  circular: boolean;
  sourceSegments: AssemblySourceSegment[];
};

export type ResolveAssemblyFragmentsInput = {
  workspacePath: string;
  moleculeId: string;
  enzymes: string[];
  selector?: AssemblyFragmentSelector;
};

export type ResolvedAssemblyFragments = {
  moleculeId: string;
  topology: "linear" | "circular";
  length: number;
  enzymes: string[];
  sites: RestrictionSite[];
  cutIndexes: number[];
  fragments: AssemblyFragment[];
  selectedFragment: AssemblyFragment;
};

export type AssemblyOrientation = "forward" | "reverse" | "both";

export type AssemblyInputFragment = {
  resolved: ResolvedAssemblyFragments;
  sequence: string;
};

export type AssemblyJunction = {
  leftSource: { role: "vector" | "insert"; moleculeId: string; enzyme: string; side: "left" | "right" };
  rightSource: { role: "vector" | "insert"; moleculeId: string; enzyme: string; side: "left" | "right" };
  compatible: true;
  endType: RestrictionEndType;
  overhangSequence: string;
  regeneratedRecognitionSequence?: string;
};

export type AssemblyCandidateEnd = {
  role: "vector" | "insert";
  moleculeId: string;
  enzyme: string;
  side: "left" | "right";
  endType: RestrictionEndType;
  overhangSequence: string;
  ligationProfileVersion: typeof RESTRICTION_LIGATION_PROFILE_VERSION;
};

export type AssemblyCandidate = {
  candidateId: string;
  name: string;
  topology: "circular" | "linear";
  length: number;
  sequence: string;
  sequenceDigest: string;
  orientation: "forward" | "reverse";
  sourceSegments: Array<{
    role: "vector_backbone" | "insert";
    moleculeId: string;
    segments: AssemblySourceSegment[];
  }>;
  junctions: AssemblyJunction[];
  ends: AssemblyCandidateEnd[];
};

export type ConstructRestrictionLigationCandidatesInput = {
  vector: AssemblyInputFragment;
  insert: AssemblyInputFragment;
  orientation?: AssemblyOrientation;
  topology?: "circular" | "linear";
};

export type SimulateAssemblyInput = {
  workspacePath: string;
  method: "restriction_ligation";
  vector: {
    moleculeId: string;
    leftEnzyme: string;
    rightEnzyme?: string;
    fragment?: AssemblyFragmentSelector;
  };
  insert: {
    moleculeId: string;
    leftEnzyme: string;
    rightEnzyme?: string;
    fragment?: AssemblyFragmentSelector;
    orientation?: AssemblyOrientation;
  };
  product?: {
    moleculeId?: string;
    name?: string;
    topology?: "circular" | "linear";
  };
};

export type AssemblyArtifact = {
  kind: "genbank";
  path: string;
  relativePath: string;
  mimeType: "chemical/x-genbank";
  description: string;
};

export type SimulateAssemblyCandidate = Omit<AssemblyCandidate, "sequence"> & {
  artifacts: AssemblyArtifact[];
};

export type SimulateAssemblyResult = {
  method: "restriction_ligation";
  workspacePath: string;
  vector: ResolvedAssemblyFragments;
  insert: ResolvedAssemblyFragments;
  candidates: SimulateAssemblyCandidate[];
  nextAction: {
    tool: "open_sequence";
    instruction: string;
  };
};

export const RESTRICTION_LIGATION_PROFILES: Record<string, RestrictionLigationProfile> = {
  EcoRI: {
    enzyme: "EcoRI",
    recognitionSequence: "GAATTC",
    topCutOffset: 1,
    bottomCutOffset: 5,
    endType: "five_prime_overhang",
    overhangSequence: "AATT",
    source: "NEB",
    sourceUrl: "https://www.neb.com/en/products/r0101-ecori",
  },
  BamHI: {
    enzyme: "BamHI",
    recognitionSequence: "GGATCC",
    topCutOffset: 1,
    bottomCutOffset: 5,
    endType: "five_prime_overhang",
    overhangSequence: "GATC",
    source: "NEB",
    sourceUrl: "https://www.neb.com/en/products/r0136-bamhi",
  },
  BglII: {
    enzyme: "BglII",
    recognitionSequence: "AGATCT",
    topCutOffset: 1,
    bottomCutOffset: 5,
    endType: "five_prime_overhang",
    overhangSequence: "GATC",
    source: "NEB",
    sourceUrl: "https://www.neb.com/en/products/r0144-bglii",
  },
  SmaI: {
    enzyme: "SmaI",
    recognitionSequence: "CCCGGG",
    topCutOffset: 3,
    bottomCutOffset: 3,
    endType: "blunt",
    overhangSequence: "",
    source: "NEB",
    sourceUrl: "https://www.neb.com/en/products/r0141-smai",
  },
  XmaI: {
    enzyme: "XmaI",
    recognitionSequence: "CCCGGG",
    topCutOffset: 1,
    bottomCutOffset: 5,
    endType: "five_prime_overhang",
    overhangSequence: "CCGG",
    source: "NEB",
    sourceUrl: "https://www.neb.com/en-us/products/r0180-xmai",
  },
  KpnI: {
    enzyme: "KpnI",
    recognitionSequence: "GGTACC",
    topCutOffset: 5,
    bottomCutOffset: 1,
    endType: "three_prime_overhang",
    overhangSequence: "GTAC",
    source: "NEB",
    sourceUrl: "https://www.neb.com/en/products/r0142-kpni",
  },
  PstI: {
    enzyme: "PstI",
    recognitionSequence: "CTGCAG",
    topCutOffset: 5,
    bottomCutOffset: 1,
    endType: "three_prime_overhang",
    overhangSequence: "TGCA",
    source: "NEB",
    sourceUrl: "https://www.neb.com/en/products/r0140-psti",
  },
};

export function resolveLigationProfile(enzyme: string): RestrictionLigationProfile {
  if (RESTRICTION_ENZYMES[enzyme] === undefined) {
    throw new MoleculeError("INVALID_ARGUMENT", "Restriction enzyme is not in the deterministic local table.", {
      enzyme,
      availableEnzymes: Object.keys(RESTRICTION_ENZYMES),
    });
  }
  const profile = RESTRICTION_LIGATION_PROFILES[enzyme];
  if (profile === undefined) {
    throw new MoleculeError("UNSUPPORTED_ENZYME_PROFILE", "Restriction enzyme does not have a verified ligation-end profile.", {
      enzyme,
      ligationProfileVersion: RESTRICTION_LIGATION_PROFILE_VERSION,
      supportedEnzymes: Object.keys(RESTRICTION_LIGATION_PROFILES),
    });
  }
  return profile;
}

export function restrictionEndFromProfile(profile: RestrictionLigationProfile): RestrictionFragmentEnd {
  return {
    enzyme: profile.enzyme,
    endType: profile.endType,
    overhangSequence: profile.overhangSequence,
    ligationProfileVersion: RESTRICTION_LIGATION_PROFILE_VERSION,
  };
}

export function compatibleRestrictionEnds(
  left: RestrictionFragmentEnd,
  right: RestrictionFragmentEnd,
): RestrictionEndCompatibility {
  if (left.endType !== right.endType) {
    return { compatible: false, left, right, reason: "END_TYPE_MISMATCH" };
  }
  if (left.endType === "blunt" && left.overhangSequence === "" && right.overhangSequence === "") {
    return { compatible: true, left, right };
  }
  if (reverseComplement(left.overhangSequence) !== right.overhangSequence) {
    return { compatible: false, left, right, reason: "OVERHANG_MISMATCH" };
  }
  return { compatible: true, left, right };
}

export function regeneratedRecognitionSequence(
  leftSequence: string,
  rightSequence: string,
  profile: RestrictionLigationProfile,
): string | undefined {
  const span = profile.recognitionSequence.length - 1;
  const junction = `${leftSequence.slice(-span)}${rightSequence.slice(0, span)}`;
  return junction.includes(profile.recognitionSequence) ? profile.recognitionSequence : undefined;
}

export function assemblyFragmentsFromCutIndexes(
  length: number,
  topology: "linear" | "circular",
  cutIndexes: number[],
): AssemblyFragment[] {
  if (!Number.isInteger(length) || length < 1) {
    throw new MoleculeError("INVALID_ARGUMENT", "length must be a positive integer.", { length });
  }
  const normalized = uniqueSortedCutIndexes(length, topology, cutIndexes);
  return topology === "circular"
    ? circularAssemblyFragments(length, normalized)
    : linearAssemblyFragments(length, normalized);
}

export async function resolveAssemblyFragmentsForMolecule(
  input: ResolveAssemblyFragmentsInput,
): Promise<ResolvedAssemblyFragments> {
  if (!Array.isArray(input.enzymes) || input.enzymes.length === 0 || input.enzymes.length > 2) {
    throw new MoleculeError("INVALID_ARGUMENT", "W3 assembly fragment resolution requires one or two enzymes.", {
      enzymes: input.enzymes,
    });
  }
  for (const enzyme of input.enzymes) {
    resolveLigationProfile(enzyme);
  }

  const { molecule, sequence } = await readMoleculeSequence(input.workspacePath, input.moleculeId);
  if (molecule.moleculeType !== "dna" || molecule.alphabet !== "iupac_dna") {
    throw new MoleculeError("ALPHABET_MISMATCH", "Assembly fragment resolution requires a DNA molecule.", {
      moleculeId: input.moleculeId,
      moleculeType: molecule.moleculeType,
      alphabet: molecule.alphabet,
    });
  }

  const sites = await findRestrictionSites(input.workspacePath, input.moleculeId, input.enzymes);
  const sitesByEnzyme = new Map<string, RestrictionSite[]>();
  for (const enzyme of input.enzymes) sitesByEnzyme.set(enzyme, []);
  for (const site of sites) {
    sitesByEnzyme.get(site.enzyme)?.push(site);
  }

  for (const enzyme of input.enzymes) {
    const enzymeSites = sitesByEnzyme.get(enzyme) ?? [];
    if (enzymeSites.length === 0) {
      throw new MoleculeError("NO_CUT_SITE", "Required restriction enzyme does not cut the molecule.", {
        moleculeId: input.moleculeId,
        enzyme,
      });
    }
    if (enzymeSites.length > 1) {
      throw new MoleculeError("AMBIGUOUS_CUT_SITES", "Required restriction enzyme cuts the molecule more than once in W3 fragment resolution.", {
        moleculeId: input.moleculeId,
        enzyme,
        cutPositions: enzymeSites.map((site) => site.cutPosition),
      });
    }
  }

  const cutIndexes = sites.map((site) => site.cutIndex);
  const fragments = assemblyFragmentsFromCutIndexes(sequence.length, molecule.topology, cutIndexes);
  const selectedFragment = selectAssemblyFragment(fragments, input.selector ?? "largest_fragment");
  return {
    moleculeId: input.moleculeId,
    topology: molecule.topology,
    length: sequence.length,
    enzymes: input.enzymes,
    sites,
    cutIndexes,
    fragments,
    selectedFragment,
  };
}

export async function simulateAssembly(input: SimulateAssemblyInput): Promise<SimulateAssemblyResult> {
  if (input.method !== "restriction_ligation") {
    throw new MoleculeError("INVALID_ARGUMENT", "W3 simulateAssembly only supports restriction_ligation.", { method: input.method });
  }
  const vectorEnzymes = enzymesFromSideInput(input.vector.leftEnzyme, input.vector.rightEnzyme);
  const insertEnzymes = enzymesFromSideInput(input.insert.leftEnzyme, input.insert.rightEnzyme);
  const [vectorResolved, insertResolved] = await Promise.all([
    resolveAssemblyFragmentsForMolecule({
      workspacePath: input.workspacePath,
      moleculeId: input.vector.moleculeId,
      enzymes: vectorEnzymes,
      selector: input.vector.fragment ?? "largest_fragment",
    }),
    resolveAssemblyFragmentsForMolecule({
      workspacePath: input.workspacePath,
      moleculeId: input.insert.moleculeId,
      enzymes: insertEnzymes,
      selector: input.insert.fragment ?? "largest_fragment",
    }),
  ]);
  const [vectorSequence, insertSequence] = await Promise.all([
    readMoleculeSequence(input.workspacePath, input.vector.moleculeId),
    readMoleculeSequence(input.workspacePath, input.insert.moleculeId),
  ]);
  const candidates = constructRestrictionLigationCandidates({
    vector: { resolved: vectorResolved, sequence: vectorSequence.sequence },
    insert: { resolved: insertResolved, sequence: insertSequence.sequence },
    orientation: input.insert.orientation ?? "forward",
    topology: input.product?.topology ?? "circular",
  });
  const withArtifacts: SimulateAssemblyCandidate[] = [];
  const productName = input.product?.name ?? input.product?.moleculeId;
  for (const candidate of candidates) {
    const artifactMoleculeId = input.product?.moleculeId === undefined
      ? undefined
      : candidates.length === 1
        ? input.product.moleculeId
        : `${input.product.moleculeId}_${candidate.orientation}`;
    const artifactName = productName === undefined
      ? undefined
      : candidates.length === 1
        ? productName
        : `${productName} ${candidate.orientation}`;
    const artifact = await writeAssemblyCandidateGenBank(input.workspacePath, candidate, {
      moleculeId: artifactMoleculeId,
      name: artifactName,
    });
    const { sequence: _sequence, ...publicCandidate } = candidate;
    void _sequence;
    withArtifacts.push({
      ...publicCandidate,
      name: artifactName ?? publicCandidate.name,
      artifacts: [artifact],
    });
  }
  return {
    method: "restriction_ligation",
    workspacePath: path.resolve(input.workspacePath),
    vector: vectorResolved,
    insert: insertResolved,
    candidates: withArtifacts,
    nextAction: {
      tool: "open_sequence",
      instruction: "Choose one candidate GenBank artifact, then call open_sequence with expectedRevision to persist it.",
    },
  };
}

export function constructRestrictionLigationCandidates(
  input: ConstructRestrictionLigationCandidatesInput,
): AssemblyCandidate[] {
  const orientation = input.orientation ?? "forward";
  if (orientation !== "forward" && orientation !== "reverse" && orientation !== "both") {
    throw new MoleculeError("INVALID_ARGUMENT", "orientation must be 'forward', 'reverse', or 'both'.", { orientation });
  }
  const orientations: Array<"forward" | "reverse"> = orientation === "both" ? ["forward", "reverse"] : [orientation];
  return orientations.map((candidateOrientation) => constructRestrictionLigationCandidate(input, candidateOrientation));
}

async function writeAssemblyCandidateGenBank(
  workspacePath: string,
  candidate: AssemblyCandidate,
  product: { moleculeId?: string; name?: string } = {},
): Promise<AssemblyArtifact> {
  const workspaceRoot = workspaceRootFromPath(workspacePath);
  const safeId = safeArtifactId(product.moleculeId ?? candidate.candidateId);
  const relativePath = path.join("reports", "assembly", `${safeId}.gb`);
  const outputPath = path.join(workspaceRoot, relativePath);
  const escaped = path.relative(workspaceRoot, outputPath);
  if (escaped.startsWith("..") || path.isAbsolute(escaped)) {
    throw new MoleculeError("INVALID_ARGUMENT", "Assembly artifact path must stay inside the workspace.", { relativePath });
  }
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, formatAssemblyCandidateGenBank(candidate, {
    locusName: product.moleculeId ?? candidate.candidateId,
    displayName: product.name ?? candidate.candidateId,
  }), "utf8");
  return {
    kind: "genbank",
    path: outputPath,
    relativePath,
    mimeType: "chemical/x-genbank",
    description: `Candidate restriction-ligation product ${candidate.candidateId}.`,
  };
}

export function selectAssemblyFragment(
  fragments: AssemblyFragment[],
  selector: AssemblyFragmentSelector = "largest_fragment",
): AssemblyFragment {
  if (selector !== "largest_fragment") {
    throw new MoleculeError("INVALID_ARGUMENT", "W3 only supports largest_fragment selection.", { selector });
  }
  if (fragments.length === 0) {
    throw new MoleculeError("INVALID_ARGUMENT", "At least one fragment is required for selection.");
  }
  const sorted = [...fragments].sort((left, right) => right.size - left.size || left.id.localeCompare(right.id));
  const largest = sorted[0];
  const tied = sorted.filter((fragment) => fragment.size === largest.size);
  if (tied.length > 1) {
    throw new MoleculeError("AMBIGUOUS_FRAGMENT_SELECTION", "Largest-fragment selection has a size tie.", {
      selector,
      tiedFragments: tied.map((fragment) => ({
        id: fragment.id,
        size: fragment.size,
        start: fragment.start,
        end: fragment.end,
        circular: fragment.circular,
      })),
    });
  }
  return largest;
}

export function extractAssemblyFragmentSequence(sequence: string, fragment: AssemblyFragment): string {
  return fragment.sourceSegments.map((segment) => sequence.slice(segment.start - 1, segment.end)).join("");
}

function constructRestrictionLigationCandidate(
  input: ConstructRestrictionLigationCandidatesInput,
  orientation: "forward" | "reverse",
): AssemblyCandidate {
  const vectorSequence = extractAssemblyFragmentSequence(input.vector.sequence, input.vector.resolved.selectedFragment);
  const insertForwardSequence = extractAssemblyFragmentSequence(input.insert.sequence, input.insert.resolved.selectedFragment);
  const insertSequence = orientation === "forward" ? insertForwardSequence : reverseComplement(insertForwardSequence);
  const vectorEnds = orderedFragmentEnds(input.vector.resolved, "forward");
  const insertEnds = orderedFragmentEnds(input.insert.resolved, orientation);

  const directJunctionCompatibility = compatibleRestrictionEnds(vectorEnds.right.end, insertEnds.left.end);
  const closingJunctionCompatibility = compatibleRestrictionEnds(insertEnds.right.end, vectorEnds.left.end);
  if (!directJunctionCompatibility.compatible || !closingJunctionCompatibility.compatible) {
    throw new MoleculeError("INCOMPATIBLE_RESTRICTION_ENDS", "Restriction fragment ends are not compatible for ligation.", {
      orientation,
      directJunction: directJunctionCompatibility,
      closingJunction: closingJunctionCompatibility,
    });
  }

  const productSequence = `${vectorSequence}${insertSequence}`;
  const directJunction = assemblyJunction(
    { role: "vector", moleculeId: input.vector.resolved.moleculeId, enzyme: vectorEnds.right.enzyme, side: "right" },
    { role: "insert", moleculeId: input.insert.resolved.moleculeId, enzyme: insertEnds.left.enzyme, side: "left" },
    directJunctionCompatibility.left,
    vectorSequence,
    insertSequence,
  );
  const closingJunction = assemblyJunction(
    { role: "insert", moleculeId: input.insert.resolved.moleculeId, enzyme: insertEnds.right.enzyme, side: "right" },
    { role: "vector", moleculeId: input.vector.resolved.moleculeId, enzyme: vectorEnds.left.enzyme, side: "left" },
    closingJunctionCompatibility.left,
    insertSequence,
    vectorSequence,
  );

  return {
    candidateId: `candidate_${orientation}`,
    name: `candidate_${orientation}`,
    topology: input.topology ?? "circular",
    length: productSequence.length,
    sequence: productSequence,
    sequenceDigest: sequenceDigest(productSequence),
    orientation,
    sourceSegments: [
      {
        role: "vector_backbone",
        moleculeId: input.vector.resolved.moleculeId,
        segments: input.vector.resolved.selectedFragment.sourceSegments,
      },
      {
        role: "insert",
        moleculeId: input.insert.resolved.moleculeId,
        segments: orientedInsertSegments(input.insert.resolved.selectedFragment.sourceSegments, orientation),
      },
    ],
    junctions: [directJunction, closingJunction],
    ends: [
      assemblyCandidateEnd("vector", input.vector.resolved.moleculeId, "left", vectorEnds.left),
      assemblyCandidateEnd("vector", input.vector.resolved.moleculeId, "right", vectorEnds.right),
      assemblyCandidateEnd("insert", input.insert.resolved.moleculeId, "left", insertEnds.left),
      assemblyCandidateEnd("insert", input.insert.resolved.moleculeId, "right", insertEnds.right),
    ],
  };
}

function assemblyCandidateEnd(
  role: "vector" | "insert",
  moleculeId: string,
  side: "left" | "right",
  boundary: { enzyme: string; end: RestrictionFragmentEnd },
): AssemblyCandidateEnd {
  return {
    role,
    moleculeId,
    enzyme: boundary.enzyme,
    side,
    endType: boundary.end.endType,
    overhangSequence: boundary.end.overhangSequence,
    ligationProfileVersion: boundary.end.ligationProfileVersion,
  };
}

function orderedFragmentEnds(
  resolved: ResolvedAssemblyFragments,
  orientation: "forward" | "reverse",
): {
  left: { enzyme: string; end: RestrictionFragmentEnd };
  right: { enzyme: string; end: RestrictionFragmentEnd };
} {
  if (resolved.sites.length === 0 || resolved.sites.length > 2) {
    throw new MoleculeError("INVALID_ARGUMENT", "Resolved assembly fragments must have one or two sites.", {
      moleculeId: resolved.moleculeId,
      siteCount: resolved.sites.length,
    });
  }
  const fragment = resolved.selectedFragment;
  const leftCutIndex = fragment.start === 1 ? 0 : fragment.start - 1;
  const rightCutIndex = resolved.topology === "circular" && fragment.circular && fragment.end === resolved.length ? 0 : fragment.end;
  const leftSite = siteAtCutIndex(resolved, leftCutIndex);
  const rightSite = siteAtCutIndex(resolved, rightCutIndex);
  const left = { enzyme: leftSite.enzyme, end: restrictionEndFromProfile(resolveLigationProfile(leftSite.enzyme)) };
  const right = { enzyme: rightSite.enzyme, end: restrictionEndFromProfile(resolveLigationProfile(rightSite.enzyme)) };
  return orientation === "forward" ? { left, right } : { left: right, right: left };
}

function siteAtCutIndex(resolved: ResolvedAssemblyFragments, cutIndex: number): RestrictionSite {
  const site = resolved.sites.find((candidate) => candidate.cutIndex === cutIndex);
  if (!site) {
    throw new MoleculeError("INVALID_ARGUMENT", "Selected assembly fragment boundary does not match a resolved restriction site.", {
      moleculeId: resolved.moleculeId,
      cutIndex,
      resolvedCutIndexes: resolved.sites.map((candidate) => candidate.cutIndex),
    });
  }
  return site;
}

function assemblyJunction(
  leftSource: AssemblyJunction["leftSource"],
  rightSource: AssemblyJunction["rightSource"],
  end: RestrictionFragmentEnd,
  leftSequence: string,
  rightSequence: string,
): AssemblyJunction {
  const profile = resolveLigationProfile(leftSource.enzyme);
  const regenerated = regeneratedRecognitionSequence(leftSequence, rightSequence, profile)
    ?? regeneratedRecognitionSequence(leftSequence, rightSequence, resolveLigationProfile(rightSource.enzyme));
  return {
    leftSource,
    rightSource,
    compatible: true,
    endType: end.endType,
    overhangSequence: end.overhangSequence,
    ...(regenerated ? { regeneratedRecognitionSequence: regenerated } : {}),
  };
}

function orientedInsertSegments(
  segments: AssemblySourceSegment[],
  orientation: "forward" | "reverse",
): AssemblySourceSegment[] {
  if (orientation === "forward") return segments;
  return [...segments].reverse().map((segment) => ({
    start: segment.start,
    end: segment.end,
    strand: segment.strand === "+" ? "-" : "+",
  }));
}

function enzymesFromSideInput(leftEnzyme: string, rightEnzyme?: string): string[] {
  if (typeof leftEnzyme !== "string" || leftEnzyme.length === 0) {
    throw new MoleculeError("INVALID_ARGUMENT", "leftEnzyme must be a non-empty string.", { leftEnzyme });
  }
  if (rightEnzyme !== undefined && (typeof rightEnzyme !== "string" || rightEnzyme.length === 0)) {
    throw new MoleculeError("INVALID_ARGUMENT", "rightEnzyme must be a non-empty string when provided.", { rightEnzyme });
  }
  return rightEnzyme === undefined || rightEnzyme === leftEnzyme ? [leftEnzyme] : [leftEnzyme, rightEnzyme];
}

function safeArtifactId(value: string): string {
  if (!/^[A-Za-z0-9_.-]+$/.test(value)) {
    throw new MoleculeError("INVALID_ARGUMENT", "Assembly artifact id may contain only letters, numbers, underscore, dot, and dash.", {
      value,
    });
  }
  return value;
}

function formatAssemblyCandidateGenBank(
  candidate: AssemblyCandidate,
  names: { locusName: string; displayName: string },
): string {
  const locus = safeArtifactId(names.locusName).padEnd(14).slice(0, 14);
  const lines = [
    `LOCUS       ${locus} ${String(candidate.length).padStart(7)} bp    DNA    ${candidate.topology.padEnd(8)} 03-JUL-2026`,
    `DEFINITION  ${names.displayName}; simulated restriction-ligation candidate ${candidate.candidateId}.`,
    "FEATURES             Location/Qualifiers",
    `     source          1..${candidate.length}`,
    `                     /label="${escapeQualifier(names.displayName)}"`,
    `                     /note="Simulated restriction-ligation candidate; not persisted to workspace."`,
    ...candidate.junctions.flatMap((junction, index) => formatJunctionFeature(junction, index + 1, candidate.length)),
    "ORIGIN",
    ...formatOrigin(candidate.sequence),
    "//",
  ];
  return `${lines.join("\n")}\n`;
}

function formatJunctionFeature(junction: AssemblyJunction, index: number, productLength: number): string[] {
  const location = index === 1 ? String(productLength) : "1";
  const regenerated = junction.regeneratedRecognitionSequence
    ? [`                     /regenerated_site="${escapeQualifier(junction.regeneratedRecognitionSequence)}"`]
    : [];
  return [
    `     misc_feature    ${location}`,
    `                     /label="junction_${index}"`,
    `                     /note="${escapeQualifier(`${junction.leftSource.enzyme} to ${junction.rightSource.enzyme}; ${junction.endType}; overhang ${junction.overhangSequence || "blunt"}`)}"`,
    ...regenerated,
  ];
}

function escapeQualifier(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function formatOrigin(sequence: string): string[] {
  const lower = sequence.toLowerCase();
  const lines: string[] = [];
  for (let index = 0; index < lower.length; index += 60) {
    const chunk = lower.slice(index, index + 60);
    const grouped = chunk.match(/.{1,10}/g)?.join(" ") ?? "";
    lines.push(`${String(index + 1).padStart(9)} ${grouped}`);
  }
  return lines;
}

function uniqueSortedCutIndexes(length: number, topology: "linear" | "circular", cutIndexes: number[]): number[] {
  if (!Array.isArray(cutIndexes)) {
    throw new MoleculeError("INVALID_ARGUMENT", "cutIndexes must be an array.", { cutIndexes });
  }
  const valid = cutIndexes.map((cutIndex) => {
    if (!Number.isInteger(cutIndex)) {
      throw new MoleculeError("INVALID_ARGUMENT", "cutIndexes entries must be integers.", { cutIndex });
    }
    if (topology === "circular") {
      if (cutIndex < 0 || cutIndex >= length) {
        throw new MoleculeError("COORDINATE_OUT_OF_RANGE", "Circular cut index must be within [0, length).", { cutIndex, length });
      }
      return cutIndex;
    }
    if (cutIndex <= 0 || cutIndex >= length) {
      throw new MoleculeError("COORDINATE_OUT_OF_RANGE", "Linear cut index must be within (0, length).", { cutIndex, length });
    }
    return cutIndex;
  });
  return [...new Set(valid)].sort((left, right) => left - right);
}

function linearAssemblyFragments(length: number, cutIndexes: number[]): AssemblyFragment[] {
  const boundaries = [0, ...cutIndexes, length];
  const fragments: AssemblyFragment[] = [];
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const startIndex = boundaries[index];
    const endIndex = boundaries[index + 1];
    fragments.push({
      id: `fragment_${index + 1}`,
      size: endIndex - startIndex,
      start: startIndex + 1,
      end: endIndex,
      circular: false,
      sourceSegments: [{ start: startIndex + 1, end: endIndex, strand: "+" }],
    });
  }
  return fragments;
}

function circularAssemblyFragments(length: number, cutIndexes: number[]): AssemblyFragment[] {
  if (cutIndexes.length <= 1) {
    const cutIndex = cutIndexes[0];
    const start = cutIndex === undefined || cutIndex === 0 ? 1 : cutIndex + 1;
    const end = cutIndex === undefined || cutIndex === 0 ? length : cutIndex;
    return [{
      id: "fragment_1",
      size: length,
      start,
      end,
      circular: true,
      sourceSegments: circularSourceSegments(length, start, end),
    }];
  }

  const fragments: AssemblyFragment[] = [];
  for (let index = 0; index < cutIndexes.length; index += 1) {
    const current = cutIndexes[index];
    const next = cutIndexes[(index + 1) % cutIndexes.length];
    const wraps = next <= current;
    const start = current + 1;
    const end = next === 0 ? length : next;
    fragments.push({
      id: `fragment_${index + 1}`,
      size: wraps ? length - current + next : next - current,
      start,
      end,
      circular: wraps,
      sourceSegments: circularSourceSegments(length, start, end),
    });
  }
  return fragments;
}

function circularSourceSegments(length: number, start: number, end: number): AssemblySourceSegment[] {
  if (start <= end) return [{ start, end, strand: "+" }];
  return [
    { start, end: length, strand: "+" },
    { start: 1, end, strand: "+" },
  ];
}
