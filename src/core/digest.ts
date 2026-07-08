import { findRestrictionSites, restrictionStrandScope, type RestrictionSite, type RestrictionStrandScope } from "./enzymes.js";
import { readMoleculeSequence } from "./context.js";

export type DigestFragment = {
  size: number;
  start: number;
  end: number;
  circular: boolean;
};

export type SimulateDigestResult = {
  moleculeId: string;
  topology: "linear" | "circular";
  length: number;
  enzymes: string[];
  strandScope: RestrictionStrandScope;
  sites: RestrictionSite[];
  fragments: DigestFragment[];
};

export async function simulateDigest(workspacePath: string, moleculeId: string, enzymes: string[]): Promise<SimulateDigestResult> {
  const { molecule, sequence } = await readMoleculeSequence(workspacePath, moleculeId);
  const sites = await findRestrictionSites(workspacePath, moleculeId, enzymes);
  const cutIndexes = Array.from(new Set(sites.map((site) => site.cutIndex).filter((cutIndex) => (
    molecule.topology === "circular" ? cutIndex >= 0 && cutIndex < sequence.length : cutIndex > 0 && cutIndex < sequence.length
  )))).sort((a, b) => a - b);
  const fragments = molecule.topology === "circular" ? circularFragments(sequence.length, cutIndexes) : linearFragments(sequence.length, cutIndexes);
  return {
    moleculeId,
    topology: molecule.topology,
    length: sequence.length,
    enzymes,
    strandScope: restrictionStrandScope(),
    sites,
    fragments,
  };
}

function linearFragments(length: number, cutIndexes: number[]): DigestFragment[] {
  const boundaries = [0, ...cutIndexes, length];
  const fragments: DigestFragment[] = [];
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const startIndex = boundaries[index];
    const endIndex = boundaries[index + 1];
    fragments.push({
      size: endIndex - startIndex,
      start: startIndex + 1,
      end: endIndex,
      circular: false,
    });
  }
  return fragments;
}

function circularFragments(length: number, cutIndexes: number[]): DigestFragment[] {
  if (cutIndexes.length <= 1) {
    const cutIndex = cutIndexes[0];
    const start = cutIndex === undefined || cutIndex === 0 ? 1 : cutIndex + 1;
    const end = cutIndex === undefined || cutIndex === 0 ? length : cutIndex;
    return [{ size: length, start, end, circular: true }];
  }

  const fragments: DigestFragment[] = [];
  for (let index = 0; index < cutIndexes.length; index += 1) {
    const current = cutIndexes[index];
    const next = cutIndexes[(index + 1) % cutIndexes.length];
    if (next > current) {
      fragments.push({ size: next - current, start: current + 1, end: next, circular: false });
    } else {
      fragments.push({ size: length - current + next, start: current + 1, end: next, circular: true });
    }
  }
  return fragments;
}
