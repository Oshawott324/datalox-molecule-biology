export const WORKSPACE_SCHEMA = "datalox.molecule.workspace";
export const WORKSPACE_VERSION = 1;

export type Strand = "+" | "-" | "none";
export type Topology = "linear" | "circular";
export type MoleculeType = "dna" | "rna" | "protein";
export type Alphabet = "iupac_dna" | "iupac_rna" | "protein";
export type SourceFormat = "fasta" | "genbank";

export type CoordinateSegment = {
  start: number;
  end: number;
  strand: Strand;
};

export type Molecule = {
  id: string;
  name: string;
  path: string;
  sourceFormat: SourceFormat;
  sequenceDigest: string;
  length: number;
  topology: Topology;
  moleculeType: MoleculeType;
  alphabet: Alphabet;
  description?: string;
};

export type Feature = {
  id: string;
  moleculeId: string;
  name: string;
  type: string;
  segments: CoordinateSegment[];
  qualifiers?: Record<string, string | string[]>;
  source?: {
    kind: "import" | "agent" | "tool";
    tool?: string;
  };
};

export type PrimerBinding = {
  segments: CoordinateSegment[];
  mismatches: unknown[];
};

export type Primer = {
  id: string;
  name: string;
  sequence: string;
  moleculeId?: string;
  binding?: PrimerBinding;
  metadata?: Record<string, unknown>;
};

export type GuideRankingEvidence = {
  passingFilters: boolean;
  filterFailures: string[];
  offTargetHitCount: number;
  gcDistanceFrom50: number;
  guideStart: number;
  strand: "+" | "-";
  efficacyScoreIncluded: false;
};

export type GuideRecord = {
  id: string;
  moleculeId: string;
  name: string;
  sequence: string;
  pam: string;
  strand: "+" | "-";
  start: number;
  end: number;
  pamStart: number;
  pamEnd: number;
  pamType: "SpCas9";
  gcPercent: number;
  seedRegionMaxHomopolymer: number;
  offTargetScope: "workspace_molecules_only";
  offTargetHitCount: number;
  rankingEvidence: GuideRankingEvidence;
  sourceTool: "design_grnas";
};

export type MoleculeWorkspace = {
  schema: typeof WORKSPACE_SCHEMA;
  version: typeof WORKSPACE_VERSION;
  revision: number;
  workspaceId: string;
  createdAt: string;
  updatedAt: string;
  molecules: Molecule[];
  features: Feature[];
  primers: Primer[];
  guides: GuideRecord[];
  constructs: unknown[];
  experiments: unknown[];
  auditEvents: unknown[];
};
