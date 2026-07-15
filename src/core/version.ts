import { WORKSPACE_SCHEMA, WORKSPACE_VERSION } from "./schema.js";

export const PACKAGE_NAME = "@datalox/molecule-biology";
export const PACKAGE_VERSION = "0.1.0";
export const MCP_PROTOCOL = "mcp-stdio";
export const AGENT_CONTRACT_VERSION = 1;
export const MCP_SCHEMA_VERSION = "1";
export const PROVENANCE_BUNDLE_VERSION = "1.0";
export const PROVENANCE_REDACTION_POLICY_VERSION = "1.0";

export const REQUIRED_V1_TOOLS = [
  "open_sequence",
  "get_sequence_context",
  "simulate_digest",
  "find_restriction_sites",
  "render_digest_gel",
  "render_plasmid_map",
  "validate_workspace",
] as const;

export const DEFERRED_SCIENTIFIC_CAVEATS = [
  "Restriction-site discovery is limited to the verified local enzyme table and palindromic recognition models; strandScope is reported with restriction outputs.",
  "CRISPR guide ranking in CR1 is filter/evidence based only; Azimuth/Doench efficacy scoring remains gated until CR2 validation fixtures and asset review are complete.",
  "Primer design requires the external primer3_core binary; specificity validation against NCBI BLAST is a future B-series tool.",
  "mRNA validation checks construct element order and integrity; codon optimization and immunogenicity optimization are deferred.",
] as const;

export type MolBioVersionHandshake = {
  packageName: typeof PACKAGE_NAME;
  packageVersion: typeof PACKAGE_VERSION;
  protocol: typeof MCP_PROTOCOL;
  agentContractVersion: typeof AGENT_CONTRACT_VERSION;
  workspaceSchema: typeof WORKSPACE_SCHEMA;
  workspaceVersion: typeof WORKSPACE_VERSION;
  provenanceBundleVersion: typeof PROVENANCE_BUNDLE_VERSION;
  toolCount: number;
  requiredTools: string[];
  availableTools: string[];
  caveats: string[];
};

export function buildVersionHandshake(availableTools: string[]): MolBioVersionHandshake {
  return {
    packageName: PACKAGE_NAME,
    packageVersion: PACKAGE_VERSION,
    protocol: MCP_PROTOCOL,
    agentContractVersion: AGENT_CONTRACT_VERSION,
    workspaceSchema: WORKSPACE_SCHEMA,
    workspaceVersion: WORKSPACE_VERSION,
    provenanceBundleVersion: PROVENANCE_BUNDLE_VERSION,
    toolCount: availableTools.length,
    requiredTools: [...REQUIRED_V1_TOOLS],
    availableTools,
    caveats: [...DEFERRED_SCIENTIFIC_CAVEATS],
  };
}
