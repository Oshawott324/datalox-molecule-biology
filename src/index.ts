export const packageName = "@datalox/molecule-biology";

export type {
  Alphabet,
  CoordinateSegment,
  Feature,
  Molecule,
  MoleculeWorkspace,
  MoleculeType,
  Primer,
  SourceFormat,
  Strand,
  Topology,
} from "./core/schema.js";

export { WORKSPACE_SCHEMA, WORKSPACE_VERSION } from "./core/schema.js";
export {
  validateWorkspace,
  validateWorkspaceOrThrow,
  readWorkspace,
  writeWorkspaceFile,
  writeWorkspaceTransaction,
} from "./core/workspace.js";
export type { WorkspaceTransactionResult } from "./core/workspace.js";
export { getSequenceContext, listMoleculeSummaries, readMoleculeSequence } from "./core/context.js";
export type { MoleculeSummary, SequenceContext, SequenceContextOptions } from "./core/context.js";
export { closeManagedSequenceEditors, openSequenceEditor, startSequenceEditorServer } from "./ui/index.js";
export type { OpenSequenceEditorResult, SequenceEditorServer, SequenceEditorServerOptions } from "./ui/index.js";
export { sequenceDigest, normalizeSequence, reverseComplement } from "./core/sequence.js";
export { extractCircularRegion, extractSegments, validateSegments } from "./core/coordinates.js";
export { MoleculeError, WorkspaceRevisionError, WorkspaceValidationError } from "./core/errors.js";
export { parseFasta } from "./core/fasta.js";
export { parseGenBank, parseFeatureLocation } from "./core/genbank.js";
export { importSequenceFile } from "./core/import.js";
export type { ImportSequenceFileOptions, ImportSequenceFileResult } from "./core/import.js";
export { deleteFeature, deletePrimer, upsertFeature, upsertPrimer } from "./core/writes.js";
export type {
  DeleteFeaturePayload,
  DeletePrimerPayload,
  UpsertFeaturePayload,
  UpsertPrimerOptions,
  UpsertPrimerPayload,
} from "./core/writes.js";
export {
  designPrimers,
  designGrnas,
  exportGenBank,
  findOrfs,
  findRestrictionSites,
  RESTRICTION_ENZYMES,
  RESTRICTION_ENZYME_TABLE_VERSION,
  resolveEnzymes,
  renderDigestGel,
  simulateDigest,
  simulatePcr,
  STANDARD_GENETIC_CODE,
  STANDARD_GENETIC_CODE_VERSION,
  translateDnaSequence,
  translateRegion,
  alignSequences,
} from "./core/deterministic.js";
export { FEATURE_COLORS, featureColor, renderPlasmidMap } from "./core/render-map.js";
export type { PlasmidMapCutSite, RenderPlasmidMapOptions, RenderPlasmidMapResult } from "./core/render-map.js";
export { formatPrimer3BoulderInput, normalizePrimerDesignOptions, parsePrimer3Output } from "./core/primer-design.js";
export type {
  DigestFragment,
  DesignedPrimer,
  DesignGrnasInput,
  DesignGrnasOptions,
  DesignGrnasResult,
  DesignPrimersInput,
  DesignPrimersOptions,
  DesignPrimersResult,
  ExportGenBankResult,
  FindOrfsOptions,
  FindRestrictionSitesOptions,
  GelBand,
  GelFragment,
  GelLane,
  GuideCandidate,
  OrfResult,
  OrfStrand,
  PcrProduct,
  PrimerPairCandidate,
  OffTargetHit,
  RestrictionEnzyme,
  RestrictionSite,
  RenderDigestGelOptions,
  RenderDigestGelResult,
  SimulateDigestResult,
  SimulatePcrResult,
  TranslateRegionOptions,
  TranslateRegionResult,
  AlignmentResult,
  AlignSequencesOptions,
} from "./core/deterministic.js";
export {
  handleDeleteFeature,
  handleDeletePrimer,
  handleDesignGrnas,
  handleDesignPrimers,
  handleDoctor,
  handleExportGenBank,
  handleFindOrfs,
  handleFindRestrictionSites,
  handleRenderDigestGel,
  handleRenderPlasmidMap,
  handleGetSequenceContext,
  handleListMolecules,
  handleOpenSequence,
  handleOpenSequenceEditor,
  handleOpenWorkspace,
  handleReadWorkspace,
  handleReverseComplement,
  handleSimulateDigest,
  handleSimulatePcr,
  handleTranslateRegion,
  handleUpsertFeature,
  handleUpsertPrimer,
  handleValidateWorkspace,
  handleAlignSequences,
  moleculeToolDescriptors,
  runToolHandler,
  toolFailure,
  toolFailureFromError,
  toolHandlers,
  moleculeAgentContract,
  toolSuccess,
  workspacePathFromInput,
} from "./tools/index.js";
export type {
  AgentContract,
  AlignSequencesInput,
  DeleteFeatureInput,
  DeletePrimerInput,
  DesignGrnasToolInput,
  DesignPrimersToolInput,
  EnzymeInput,
  ExportGenBankInput,
  ExpectedRevisionInput,
  FindOrfsInput,
  MoleculeToolInput,
  OpenSequenceInput,
  OpenSequenceEditorInput,
  ReverseComplementInput,
  SequenceContextInput,
  SimulatePcrInput,
  RenderPlasmidMapInput,
  RenderDigestGelInput,
  TranslateRegionInput,
  ToolDescriptor,
  ToolErrorEnvelope,
  ToolInputByName,
  ToolName,
  ToolNextAction,
  ToolResultEnvelope,
  ToolSuccessEnvelope,
  UpsertFeatureInput,
  UpsertPrimerInput,
  WorkspaceInput,
} from "./tools/index.js";
export {
  createReplayRecorder,
  packReplayBundle,
  recordToolCall,
  replayToolObservation,
  runReplayDemo,
  sha256Json,
  stableJsonStringify,
  verifyReplayBundle,
} from "./replay/index.js";
export {
  callMoleculeMcpTool,
  createMoleculeMcpServer,
  listMoleculeMcpTools,
  runMoleculeMcpServer,
  toolEnvelopeToMcpResult,
} from "./mcp/index.js";
export type {
  JsonPrimitive,
  JsonValue,
  PackReplayBundleOptions,
  PackReplayBundleResult,
  ReplayBundleManifest,
  ReplayManifestRecord,
  ReplayRecorder,
  ReplayToolRecord,
  ReplayWorkspaceSummary,
  RunReplayDemoOptions,
  RunReplayDemoResult,
  VerifyReplayBundleResult,
} from "./replay/index.js";
