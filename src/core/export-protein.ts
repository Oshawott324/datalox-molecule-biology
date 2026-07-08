import { promises as fs } from "node:fs";
import path from "node:path";

import { MoleculeError } from "./errors.js";
import { workspaceRootFromPath } from "./paths.js";
import { translateRegion } from "./translate.js";

export type ExportProteinFastaOptions = {
  cdsStart: number; // 1-based inclusive
  cdsEnd: number; // 1-based inclusive
  proteinId?: string; // FASTA header id, defaults to moleculeId
  outputPath?: string;
};

export type ExportProteinFastaResult = {
  moleculeId: string;
  proteinId: string;
  region: { start: number; end: number };
  /** Full translated amino-acid string, including any trailing stop `*`. */
  aminoAcids: string;
  /** Residue count written to the FASTA body (after trimming a trailing stop). */
  proteinLength: number;
  /** True when a single trailing stop `*` was removed from the FASTA body. */
  stopTrimmed: boolean;
  outputPath: string;
  relativePath: string;
  mimeType: "text/x-fasta";
};

const FASTA_WRAP = 60;

/**
 * X1 structural bridge: translate a CDS region and write the protein sequence to a
 * FASTA artifact for downstream structure tools (AlphaFold3 / ESMFold). This is a
 * thin, read-only wrapper over `translateRegion` — it does not mutate the workspace.
 *
 * The translated CDS ends in a stop codon, which `translateRegion` renders as `*`.
 * Structure tools reject `*` as a residue, so a single trailing stop is stripped from
 * the FASTA body. Internal `*` characters are left untouched: judging CDS integrity is
 * `validate_mrna_construct`'s job, not this tool's.
 */
export async function exportProteinFasta(
  workspacePath: string,
  moleculeId: string,
  options: ExportProteinFastaOptions,
): Promise<ExportProteinFastaResult> {
  const { cdsStart, cdsEnd } = options;
  const translation = await translateRegion(workspacePath, moleculeId, {
    start: cdsStart,
    end: cdsEnd,
    strand: "+",
  });

  const aminoAcids = translation.aminoAcids;
  const stopTrimmed = aminoAcids.endsWith("*");
  const fastaProtein = stopTrimmed ? aminoAcids.slice(0, -1) : aminoAcids;

  const proteinId = sanitizeProteinId(options.proteinId ?? moleculeId);
  const workspaceRoot = workspaceRootFromPath(workspacePath);
  const relativePath = options.outputPath
    ? path.relative(workspaceRoot, path.isAbsolute(options.outputPath) ? options.outputPath : path.join(workspaceRoot, options.outputPath))
    : path.join("reports", "proteins", `${proteinId}.fa`);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new MoleculeError("INVALID_ARGUMENT", "Protein FASTA outputPath must stay inside the workspace.", {
      outputPath: options.outputPath,
      workspaceRoot,
    });
  }
  const outputPath = path.join(workspaceRoot, relativePath);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, formatFasta(proteinId, fastaProtein), "utf8");

  return {
    moleculeId,
    proteinId,
    region: { start: cdsStart, end: cdsEnd },
    aminoAcids,
    proteinLength: fastaProtein.length,
    stopTrimmed,
    outputPath,
    relativePath,
    mimeType: "text/x-fasta",
  };
}

function sanitizeProteinId(proteinId: string): string {
  const cleaned = proteinId.replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 80);
  return cleaned.length > 0 ? cleaned : "protein";
}

function formatFasta(proteinId: string, sequence: string): string {
  const lines = [`>${proteinId}`];
  for (let index = 0; index < sequence.length; index += FASTA_WRAP) {
    lines.push(sequence.slice(index, index + FASTA_WRAP));
  }
  // A zero-length body still needs a trailing newline after the header.
  return `${lines.join("\n")}\n`;
}
