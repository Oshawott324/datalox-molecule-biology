/**
 * Deterministic pairwise alignment.
 *
 * The core is pure: it takes two sequence strings plus scoring parameters and
 * returns either a Needleman-Wunsch global alignment or a Smith-Waterman local
 * alignment. Sequence resolution (raw strings vs workspace molecule IDs)
 * happens in the tool handler, not here.
 *
 * Linear gap penalty: every gap column costs `gap` points (this is classic
 * dynamic programming, not affine). Default scoring: match +1, mismatch -1,
 * gap -2. Traceback prefers a diagonal (match/mismatch) step, then a gap in the
 * target, then a gap in the query, so identical inputs always produce identical
 * output. No uppercase normalization, no ambiguity codes, no heuristics, no
 * network: the caller passes uppercase sequences if it wants case-insensitive
 * matching.
 */

import { assertUnambiguousDnaSequence } from "./sequence.js";

export type AlignMode = "global" | "local";

export type AlignmentResult = {
  mode: AlignMode;
  queryAligned: string; // query with gaps inserted, e.g. "ACG-T"
  targetAligned: string; // target with gaps inserted, e.g. "ACGAT"
  identityPercent: number; // 0-100, two decimal places
  identicalPositions: number;
  alignedLength: number; // includes gap columns
  mismatches: number;
  gaps: number;
  score: number;
  scoringParams: {
    match: number;
    mismatch: number;
    gap: number;
  };
  queryAlignedStart?: number; // local mode only, 1-based inclusive coordinate in query
  queryAlignedEnd?: number; // local mode only, 1-based inclusive coordinate in query
  targetAlignedStart?: number; // local mode only, 1-based inclusive coordinate in target
  targetAlignedEnd?: number; // local mode only, 1-based inclusive coordinate in target
};

export type AlignSequencesOptions = {
  mode?: AlignMode; // default: "global"
  match?: number; // default: 1
  mismatch?: number; // default: -1
  gap?: number; // default: -2
};

const DEFAULT_MATCH = 1;
const DEFAULT_MISMATCH = -1;
const DEFAULT_GAP = -2;

export function alignSequences(
  query: string,
  target: string,
  options: AlignSequencesOptions = {},
): AlignmentResult {
  const mode = options.mode ?? "global";
  const match = options.match ?? DEFAULT_MATCH;
  const mismatch = options.mismatch ?? DEFAULT_MISMATCH;
  const gap = options.gap ?? DEFAULT_GAP;
  assertUnambiguousDnaSequence(query, "query");
  assertUnambiguousDnaSequence(target, "target");

  if (mode === "local") {
    return alignLocal(query, target, { match, mismatch, gap });
  }
  return alignGlobal(query, target, { match, mismatch, gap });
}

function alignGlobal(
  query: string,
  target: string,
  scoringParams: AlignmentResult["scoringParams"],
): AlignmentResult {
  const { match, mismatch, gap } = scoringParams;
  const m = query.length;
  const n = target.length;

  // Score matrix, (m + 1) x (n + 1). Row/column 0 are pure-gap prefixes.
  const score: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 1; i <= m; i += 1) score[i][0] = i * gap;
  for (let j = 1; j <= n; j += 1) score[0][j] = j * gap;

  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      const diagonal = score[i - 1][j - 1] + (query[i - 1] === target[j - 1] ? match : mismatch);
      const up = score[i - 1][j] + gap; // gap in target
      const left = score[i][j - 1] + gap; // gap in query
      score[i][j] = Math.max(diagonal, up, left);
    }
  }

  // Traceback from (m, n) to the origin, preferring diagonal, then up, then left.
  const queryColumns: string[] = [];
  const targetColumns: string[] = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0) {
      const s = query[i - 1] === target[j - 1] ? match : mismatch;
      if (score[i][j] === score[i - 1][j - 1] + s) {
        queryColumns.push(query[i - 1]);
        targetColumns.push(target[j - 1]);
        i -= 1;
        j -= 1;
        continue;
      }
    }
    if (i > 0 && score[i][j] === score[i - 1][j] + gap) {
      queryColumns.push(query[i - 1]);
      targetColumns.push("-");
      i -= 1;
      continue;
    }
    queryColumns.push("-");
    targetColumns.push(target[j - 1]);
    j -= 1;
  }

  const queryAligned = queryColumns.reverse().join("");
  const targetAligned = targetColumns.reverse().join("");
  return summarizeAlignment("global", queryAligned, targetAligned, score[m][n], scoringParams);
}

function alignLocal(
  query: string,
  target: string,
  scoringParams: AlignmentResult["scoringParams"],
): AlignmentResult {
  const { match, mismatch, gap } = scoringParams;
  const m = query.length;
  const n = target.length;

  const score: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  let bestScore = 0;
  let bestI = 0;
  let bestJ = 0;

  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      const diagonal = score[i - 1][j - 1] + (query[i - 1] === target[j - 1] ? match : mismatch);
      const up = score[i - 1][j] + gap;
      const left = score[i][j - 1] + gap;
      const cellScore = Math.max(0, diagonal, up, left);
      score[i][j] = cellScore;
      if (cellScore > bestScore) {
        bestScore = cellScore;
        bestI = i;
        bestJ = j;
      }
    }
  }

  if (bestScore === 0) {
    return summarizeAlignment("local", "", "", 0, scoringParams);
  }

  const queryColumns: string[] = [];
  const targetColumns: string[] = [];
  let i = bestI;
  let j = bestJ;

  while (i > 0 && j > 0 && score[i][j] > 0) {
    const s = query[i - 1] === target[j - 1] ? match : mismatch;
    if (score[i][j] === score[i - 1][j - 1] + s) {
      queryColumns.push(query[i - 1]);
      targetColumns.push(target[j - 1]);
      i -= 1;
      j -= 1;
      continue;
    }
    if (score[i][j] === score[i - 1][j] + gap) {
      queryColumns.push(query[i - 1]);
      targetColumns.push("-");
      i -= 1;
      continue;
    }
    queryColumns.push("-");
    targetColumns.push(target[j - 1]);
    j -= 1;
  }

  const queryAligned = queryColumns.reverse().join("");
  const targetAligned = targetColumns.reverse().join("");
  return {
    ...summarizeAlignment("local", queryAligned, targetAligned, bestScore, scoringParams),
    queryAlignedStart: i + 1,
    queryAlignedEnd: bestI,
    targetAlignedStart: j + 1,
    targetAlignedEnd: bestJ,
  };
}

function summarizeAlignment(
  mode: AlignMode,
  queryAligned: string,
  targetAligned: string,
  score: number,
  scoringParams: AlignmentResult["scoringParams"],
): AlignmentResult {
  const alignedLength = queryAligned.length;
  let identicalPositions = 0;
  let mismatches = 0;
  let gaps = 0;

  for (let column = 0; column < alignedLength; column += 1) {
    const q = queryAligned[column];
    const t = targetAligned[column];
    if (q === "-" || t === "-") {
      gaps += 1;
    } else if (q === t) {
      identicalPositions += 1;
    } else {
      mismatches += 1;
    }
  }

  return {
    mode,
    queryAligned,
    targetAligned,
    identityPercent: alignedLength === 0 ? 100 : Math.round((identicalPositions / alignedLength) * 10000) / 100,
    identicalPositions,
    alignedLength,
    mismatches,
    gaps,
    score,
    scoringParams,
  };
}
