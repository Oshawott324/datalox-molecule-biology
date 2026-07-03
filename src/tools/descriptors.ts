export type JsonSchemaObject = {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties: false;
};

export type ToolDescriptor = {
  name: string;
  description: string;
  inputSchema: JsonSchemaObject;
};

const workspaceProperties = {
  workspacePath: { type: "string", description: "Path to molecule.workspace.json." },
  workspaceDir: { type: "string", description: "Directory containing molecule.workspace.json." },
  checkSequenceDigests: { type: "boolean", description: "Validate stored sequence file digests while reading." },
};

const expectedRevisionProperty = { type: "integer", minimum: 0 };
const moleculeProperties = {
  workspacePath: workspaceProperties.workspacePath,
  workspaceDir: workspaceProperties.workspaceDir,
  moleculeId: { type: "string" },
  molecule: { type: "string", description: "Alias for moleculeId." },
};

export const moleculeToolDescriptors = [
  {
    name: "open_sequence",
    description: "Import a FASTA or GenBank sequence file into a molecule workspace.",
    inputSchema: {
      type: "object",
      required: ["inputPath", "workspaceDir"],
      additionalProperties: false,
      properties: {
        inputPath: { type: "string", description: "Path to a FASTA or GenBank sequence file." },
        workspaceDir: workspaceProperties.workspaceDir,
        format: { type: "string", enum: ["auto", "fasta", "genbank"] },
        moleculeId: { type: "string" },
        expectedRevision: { type: "integer", minimum: 0 },
      },
    },
  },
  {
    name: "open_workspace",
    description: "Open and validate a molecule workspace.",
    inputSchema: {
      type: "object",
      required: ["workspacePath"],
      additionalProperties: false,
      properties: workspaceProperties,
    },
  },
  {
    name: "open_sequence_editor",
    description: "Open a compact local sequence and plasmid workspace editor.",
    inputSchema: {
      type: "object",
      required: ["workspacePath"],
      additionalProperties: false,
      properties: {
        ...workspaceProperties,
        moleculeId: { type: "string" },
        host: { type: "string" },
        port: { type: "integer", minimum: 0 },
      },
    },
  },
  {
    name: "read_workspace",
    description: "Read and validate a molecule workspace.",
    inputSchema: {
      type: "object",
      required: ["workspacePath"],
      additionalProperties: false,
      properties: workspaceProperties,
    },
  },
  {
    name: "validate_workspace",
    description: "Validate a molecule workspace and return structured validation issues.",
    inputSchema: {
      type: "object",
      required: ["workspacePath"],
      additionalProperties: false,
      properties: workspaceProperties,
    },
  },
  {
    name: "list_molecules",
    description: "List molecules in a validated workspace.",
    inputSchema: {
      type: "object",
      required: ["workspacePath"],
      additionalProperties: false,
      properties: {
        workspacePath: workspaceProperties.workspacePath,
        workspaceDir: workspaceProperties.workspaceDir,
      },
    },
  },
  {
    name: "get_sequence_context",
    description: "Read molecule context, features, primers, and optional sequence for a region.",
    inputSchema: {
      type: "object",
      required: ["workspacePath"],
      additionalProperties: false,
      properties: {
        ...moleculeProperties,
        start: { type: "integer", minimum: 1 },
        end: { type: "integer", minimum: 1 },
        strand: { type: "string", enum: ["+", "-", "none"] },
        includeSequence: { type: "boolean" },
      },
    },
  },
  {
    name: "upsert_feature",
    description: "Create or update a feature through a revision-safe workspace write.",
    inputSchema: {
      type: "object",
      required: ["workspacePath", "expectedRevision", "feature"],
      additionalProperties: false,
      properties: { ...workspaceProperties, expectedRevision: expectedRevisionProperty, feature: { type: "object" } },
    },
  },
  {
    name: "delete_feature",
    description: "Delete a feature through a revision-safe workspace write.",
    inputSchema: {
      type: "object",
      required: ["workspacePath", "expectedRevision", "featureId"],
      additionalProperties: false,
      properties: { ...workspaceProperties, expectedRevision: expectedRevisionProperty, featureId: { type: "string" } },
    },
  },
  {
    name: "upsert_primer",
    description: "Create or update a primer through a revision-safe workspace write.",
    inputSchema: {
      type: "object",
      required: ["workspacePath", "expectedRevision", "primer"],
      additionalProperties: false,
      properties: { ...workspaceProperties, expectedRevision: expectedRevisionProperty, primer: { type: "object" }, bindToMolecule: { type: "boolean" } },
    },
  },
  {
    name: "delete_primer",
    description: "Delete a primer through a revision-safe workspace write.",
    inputSchema: {
      type: "object",
      required: ["workspacePath", "expectedRevision", "primerId"],
      additionalProperties: false,
      properties: { ...workspaceProperties, expectedRevision: expectedRevisionProperty, primerId: { type: "string" } },
    },
  },
  {
    name: "reverse_complement",
    description: "Return the reverse complement of an explicit DNA/RNA sequence.",
    inputSchema: {
      type: "object",
      required: ["sequence"],
      additionalProperties: false,
      properties: { sequence: { type: "string" } },
    },
  },
  {
    name: "translate_region",
    description: "Translate a DNA region using the standard genetic code.",
    inputSchema: {
      type: "object",
      required: ["workspacePath", "moleculeId", "start", "end"],
      additionalProperties: false,
      properties: { ...moleculeProperties, start: { type: "integer", minimum: 1 }, end: { type: "integer", minimum: 1 }, strand: { type: "string", enum: ["+", "-", "none"] }, geneticCode: { type: "string", enum: ["standard"] } },
    },
  },
  {
    name: "find_orfs",
    description: "Find deterministic ORFs in a DNA molecule.",
    inputSchema: {
      type: "object",
      required: ["workspacePath", "moleculeId"],
      additionalProperties: false,
      properties: { ...moleculeProperties, minAa: { type: "integer", minimum: 0 }, startCodons: { type: "array", items: { type: "string" } }, stopCodons: { type: "array", items: { type: "string" } }, strands: { type: "array", items: { type: "string", enum: ["+", "-"] } } },
    },
  },
  {
    name: "find_restriction_sites",
    description: "Find restriction enzyme sites from the deterministic local enzyme table.",
    inputSchema: {
      type: "object",
      required: ["workspacePath", "moleculeId", "enzymes"],
      additionalProperties: false,
      properties: { ...moleculeProperties, enzymes: { type: "array", items: { type: "string" } } },
    },
  },
  {
    name: "simulate_digest",
    description: "Simulate a deterministic restriction digest.",
    inputSchema: {
      type: "object",
      required: ["workspacePath", "moleculeId", "enzymes"],
      additionalProperties: false,
      properties: { ...moleculeProperties, enzymes: { type: "array", items: { type: "string" } } },
    },
  },
  {
    name: "simulate_pcr",
    description: "Simulate deterministic exact-match PCR.",
    inputSchema: {
      type: "object",
      required: ["workspacePath", "moleculeId", "forwardPrimer", "reversePrimer"],
      additionalProperties: false,
      properties: { ...moleculeProperties, forwardPrimer: { type: "string" }, reversePrimer: { type: "string" } },
    },
  },
  {
    name: "simulate_assembly",
    description: "Simulate read-only restriction-ligation assembly candidates and write GenBank candidate artifacts.",
    inputSchema: {
      type: "object",
      required: ["workspacePath", "method", "vector", "insert"],
      additionalProperties: false,
      properties: {
        workspacePath: workspaceProperties.workspacePath,
        workspaceDir: workspaceProperties.workspaceDir,
        method: { type: "string", enum: ["restriction_ligation"] },
        vector: {
          type: "object",
          required: ["moleculeId", "leftEnzyme"],
          additionalProperties: false,
          properties: {
            moleculeId: { type: "string" },
            leftEnzyme: { type: "string" },
            rightEnzyme: { type: "string" },
            fragment: { type: "string", enum: ["largest_fragment"] },
          },
        },
        insert: {
          type: "object",
          required: ["moleculeId", "leftEnzyme"],
          additionalProperties: false,
          properties: {
            moleculeId: { type: "string" },
            leftEnzyme: { type: "string" },
            rightEnzyme: { type: "string" },
            fragment: { type: "string", enum: ["largest_fragment"] },
            orientation: { type: "string", enum: ["forward", "reverse", "both"] },
          },
        },
        product: {
          type: "object",
          additionalProperties: false,
          properties: {
            moleculeId: { type: "string" },
            name: { type: "string" },
            topology: { type: "string", enum: ["circular", "linear"] },
          },
        },
      },
    },
  },
  {
    name: "export_genbank",
    description: "Export a molecule and workspace features to GenBank.",
    inputSchema: {
      type: "object",
      required: ["workspacePath", "moleculeId", "outputPath"],
      additionalProperties: false,
      properties: { ...moleculeProperties, outputPath: { type: "string" } },
    },
  },
  {
    name: "render_plasmid_map",
    description: "Render a deterministic circular plasmid SVG map artifact.",
    inputSchema: {
      type: "object",
      required: ["workspacePath", "moleculeId"],
      additionalProperties: false,
      properties: {
        ...moleculeProperties,
        outputPath: { type: "string" },
        width: { type: "integer", minimum: 1 },
        height: { type: "integer", minimum: 1 },
        showPrimers: { type: "boolean" },
        cutSites: {
          type: "array",
          items: {
            type: "object",
            required: ["enzyme", "position"],
            additionalProperties: false,
            properties: {
              enzyme: { type: "string" },
              position: { type: "integer", minimum: 1 },
            },
          },
        },
      },
    },
  },
  {
    name: "render_digest_gel",
    description: "Render a deterministic SVG gel artifact from digest or PCR fragment sizes.",
    inputSchema: {
      type: "object",
      required: ["workspacePath", "gelId", "lanes"],
      additionalProperties: false,
      properties: {
        workspacePath: workspaceProperties.workspacePath,
        workspaceDir: workspaceProperties.workspaceDir,
        gelId: { type: "string" },
        lanes: {
          type: "array",
          items: {
            type: "object",
            required: ["label", "fragments"],
            additionalProperties: false,
            properties: {
              label: { type: "string" },
              fragments: {
                type: "array",
                items: {
                  type: "object",
                  required: ["size"],
                  additionalProperties: false,
                  properties: {
                    size: { type: "integer", minimum: 1 },
                    label: { type: "string" },
                  },
                },
              },
            },
          },
        },
        customLadder: { type: "array", items: { type: "integer", minimum: 1 } },
        outputPath: { type: "string" },
        width: { type: "integer", minimum: 1 },
        height: { type: "integer", minimum: 1 },
      },
    },
  },
  {
    name: "align_sequences",
    description: "Align two sequences with deterministic Needleman-Wunsch global or Smith-Waterman local alignment.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        workspacePath: workspaceProperties.workspacePath,
        workspaceDir: workspaceProperties.workspaceDir,
        sequence: {
          type: "string",
          description: "Raw query sequence. Provide this or moleculeId."
        },
        targetSequence: {
          type: "string",
          description: "Raw target sequence. Provide this or targetMoleculeId."
        },
        moleculeId: {
          type: "string",
          description: "Workspace molecule id for the query sequence."
        },
        targetMoleculeId: {
          type: "string",
          description: "Workspace molecule id for the target sequence."
        },
        mode: {
          type: "string",
          enum: ["global", "local"],
          description: "Alignment mode. global = Needleman-Wunsch; local = Smith-Waterman. Default global."
        },
        match: {
          type: "integer",
          description: "Match score (default 1)."
        },
        mismatch: {
          type: "integer",
          description: "Mismatch score (default -1)."
        },
        gap: {
          type: "integer",
          description: "Linear gap penalty (default -2)."
        },
      },
    },
  },
  {
    name: "design_primers",
    description: "Design PCR primer candidates with the external primer3_core binary and return read-only structured candidates.",
    inputSchema: {
      type: "object",
      required: ["workspacePath", "moleculeId", "target"],
      additionalProperties: false,
      properties: {
        ...moleculeProperties,
        target: {
          type: "object",
          required: ["start", "end"],
          additionalProperties: false,
          properties: {
            start: { type: "integer", minimum: 1 },
            end: { type: "integer", minimum: 1 },
          },
        },
        options: {
          type: "object",
          additionalProperties: false,
          properties: {
            productSizeRange: { type: "array", items: { type: "number" } },
            tmRange: { type: "array", items: { type: "number" } },
            primerSizeRange: { type: "array", items: { type: "number" } },
            numReturn: { type: "integer", minimum: 1 },
            leftOverhang: { type: "string" },
            rightOverhang: { type: "string" },
          },
        },
      },
    },
  },
  {
    name: "design_grnas",
    description: "Design SpCas9 NGG guide RNA candidates with deterministic PAM scanning and workspace-scale off-target reporting.",
    inputSchema: {
      type: "object",
      required: ["workspacePath", "moleculeId", "targetRegion"],
      additionalProperties: false,
      properties: {
        ...moleculeProperties,
        targetRegion: {
          type: "object",
          required: ["start", "end"],
          additionalProperties: false,
          properties: {
            start: { type: "integer", minimum: 1 },
            end: { type: "integer", minimum: 1 },
          },
        },
        options: {
          type: "object",
          additionalProperties: false,
          properties: {
            pamType: { type: "string", enum: ["SpCas9"] },
            guideLength: { type: "integer", minimum: 1 },
            strand: { type: "string", enum: ["both", "+", "-"] },
            gcRange: { type: "array", items: { type: "number" } },
            maxSeedHomopolymerRun: { type: "integer", minimum: 1 },
            offTargetMoleculeIds: { type: "array", items: { type: "string" } },
            maxOffTargetMismatches: { type: "integer", minimum: 0 },
          },
        },
      },
    },
  },
] satisfies ToolDescriptor[];
