import { MoleculeError } from "./errors.js";
import type { Alphabet } from "./schema.js";
import { normalizeSequence } from "./sequence.js";

export type ParsedFastaRecord = {
  name: string;
  sequence: string;
};

export function parseFasta(content: string, alphabet: Alphabet = "iupac_dna"): ParsedFastaRecord[] {
  const records: ParsedFastaRecord[] = [];
  let currentName: string | null = null;
  let currentSequence: string[] = [];

  function finishRecord(): void {
    if (currentName === null) return;
    const sequence = normalizeSequence(currentSequence.join(""), alphabet);
    if (sequence.length === 0) {
      throw new MoleculeError("PARSE_ERROR", "FASTA record has no sequence content.", { record: currentName });
    }
    records.push({ name: currentName, sequence });
  }

  for (const [lineIndex, rawLine] of content.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    if (line.startsWith(">")) {
      finishRecord();
      const header = line.slice(1).trim();
      if (header.length === 0) {
        throw new MoleculeError("PARSE_ERROR", "FASTA header is empty.", { line: lineIndex + 1 });
      }
      currentName = header;
      currentSequence = [];
      continue;
    }
    if (currentName === null) {
      throw new MoleculeError("PARSE_ERROR", "FASTA sequence data appeared before the first header.", { line: lineIndex + 1 });
    }
    currentSequence.push(line);
  }

  finishRecord();
  if (records.length === 0) {
    throw new MoleculeError("PARSE_ERROR", "FASTA file has no records.");
  }
  return records;
}

export function formatSingleRecordFasta(name: string, sequence: string): string {
  const lines = [`>${name}`];
  for (let index = 0; index < sequence.length; index += 80) {
    lines.push(sequence.slice(index, index + 80));
  }
  return `${lines.join("\n")}\n`;
}
