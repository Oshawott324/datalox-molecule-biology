import { promises as fs } from "node:fs";
import path from "node:path";

import { MoleculeError } from "./errors.js";
import { workspaceRootFromPath } from "./paths.js";
import { readWorkspace } from "./workspace.js";

export type GelFragment = {
  size: number;
  label?: string;
};

export type GelLane = {
  label: string;
  fragments: GelFragment[];
};

export type GelBand = {
  laneIndex: number;
  laneLabel: string;
  fragmentIndex: number;
  size: number;
  y: number;
  label?: string;
  isLadder: boolean;
  outOfLadderRange: boolean;
  rangeWarning?: string;
};

export type RenderDigestGelOptions = {
  outputPath?: string;
  width?: number;
  height?: number;
  customLadder?: number[];
};

export type RenderDigestGelResult = {
  gelId: string;
  outputPath: string;
  relativePath: string;
  mimeType: "image/svg+xml";
  width: number;
  height: number;
  laneCount: number;
  ladder: number[];
  bands: GelBand[];
  rules: {
    migrationScale: "log10_fragment_size";
    supportedFragments: "linear_digest_or_pcr_products";
    ladderLane: "leftmost_default_or_custom_ladder";
    calibrationRange: "ladder_min_to_ladder_max";
  };
};

type RenderBand = GelBand & {
  x: number;
};

const DEFAULT_WIDTH = 720;
const DEFAULT_HEIGHT = 520;
const DEFAULT_LADDER = [250, 500, 750, 1000, 1500, 2000, 3000, 4000, 5000, 6000, 8000, 10000];

export async function renderDigestGel(
  workspacePath: string,
  gelId: string,
  lanes: GelLane[],
  options: RenderDigestGelOptions = {},
): Promise<RenderDigestGelResult> {
  await readWorkspace(workspacePath, { checkSequenceDigests: true });
  assertSafeGelId(gelId);
  const normalizedLanes = normalizeLanes(lanes);
  const ladder = normalizeLadder(options.customLadder ?? DEFAULT_LADDER);
  const width = positiveInteger(options.width ?? DEFAULT_WIDTH, "width");
  const height = positiveInteger(options.height ?? DEFAULT_HEIGHT, "height");
  const workspaceRoot = workspaceRootFromPath(workspacePath);
  const relativePath = options.outputPath
    ? path.relative(workspaceRoot, path.isAbsolute(options.outputPath) ? options.outputPath : path.join(workspaceRoot, options.outputPath))
    : path.join("reports", "gels", `${gelId}.gel.svg`);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new MoleculeError("INVALID_ARGUMENT", "Gel outputPath must stay inside the workspace.", {
      outputPath: options.outputPath,
      workspaceRoot,
    });
  }
  const outputPath = path.join(workspaceRoot, relativePath);

  const render = computeBands(normalizedLanes, ladder, width, height);
  const svg = renderSvg({
    gelId,
    width,
    height,
    lanes: normalizedLanes,
    bands: render.renderBands,
  });

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, svg, "utf8");

  return {
    gelId,
    outputPath,
    relativePath,
    mimeType: "image/svg+xml",
    width,
    height,
    laneCount: normalizedLanes.length + 1,
    ladder,
    bands: render.bands,
    rules: {
      migrationScale: "log10_fragment_size",
      supportedFragments: "linear_digest_or_pcr_products",
      ladderLane: "leftmost_default_or_custom_ladder",
      calibrationRange: "ladder_min_to_ladder_max",
    },
  };
}

function computeBands(lanes: GelLane[], ladder: number[], width: number, height: number): { bands: GelBand[]; renderBands: RenderBand[] } {
  const laneLabels = ["Ladder", ...lanes.map((lane) => lane.label)];
  const left = 78;
  const right = width - 38;
  const laneSpacing = laneLabels.length === 1 ? 0 : (right - left) / (laneLabels.length - 1);
  const top = 82;
  const bottom = height - 58;
  const minSize = Math.min(...ladder);
  const maxSize = Math.max(...ladder);
  const bands: GelBand[] = [];
  const renderBands: RenderBand[] = [];

  const addBand = (band: Omit<GelBand, "y" | "outOfLadderRange" | "rangeWarning">): void => {
    const belowRange = band.size < minSize;
    const aboveRange = band.size > maxSize;
    const rangeWarning = belowRange
      ? `below ladder range (${minSize}-${maxSize} bp)`
      : aboveRange
        ? `above ladder range (${minSize}-${maxSize} bp)`
        : undefined;
    const y = gelY(clamp(band.size, minSize, maxSize), minSize, maxSize, top, bottom);
    const next = {
      ...band,
      y,
      outOfLadderRange: rangeWarning !== undefined,
      ...(rangeWarning ? { rangeWarning } : {}),
    };
    bands.push(next);
    renderBands.push({ ...next, x: left + band.laneIndex * laneSpacing });
  };

  ladder.forEach((size, fragmentIndex) => addBand({
    laneIndex: 0,
    laneLabel: "Ladder",
    fragmentIndex,
    size,
    label: `${size} bp`,
    isLadder: true,
  }));

  lanes.forEach((lane, laneOffset) => {
    lane.fragments.forEach((fragment, fragmentIndex) => addBand({
      laneIndex: laneOffset + 1,
      laneLabel: lane.label,
      fragmentIndex,
      size: fragment.size,
      ...(fragment.label ? { label: fragment.label } : {}),
      isLadder: false,
    }));
  });

  return { bands, renderBands };
}

function renderSvg(input: {
  gelId: string;
  width: number;
  height: number;
  lanes: GelLane[];
  bands: RenderBand[];
}): string {
  const laneLabels = ["Ladder", ...input.lanes.map((lane) => lane.label)];
  const left = 78;
  const right = input.width - 38;
  const top = 56;
  const wellY = 74;
  const bottom = input.height - 40;
  const laneSpacing = laneLabels.length === 1 ? 0 : (right - left) / (laneLabels.length - 1);
  const laneElements = laneLabels.map((label, index) => {
    const x = left + index * laneSpacing;
    return [
      `<rect class="lane-track" x="${format(x - 14)}" y="${top}" width="28" height="${format(bottom - top)}" fill="#D9E1DF"/>`,
      `<rect x="${format(x - 13)}" y="${wellY}" width="26" height="8" rx="3" fill="#B9C5C2"/>`,
      `<text class="lane-label" x="${format(x)}" y="${input.height - 16}" text-anchor="middle">${escapeXml(label)}</text>`,
    ].join("\n  ");
  });
  const bandElements = input.bands.map((band) => {
    const bandWidth = band.isLadder ? 24 : 34;
    const stroke = band.outOfLadderRange ? "#B23A48" : band.isLadder ? "#465A64" : "#151B1A";
    const opacity = band.isLadder ? "0.78" : "0.88";
    const dash = band.outOfLadderRange ? ' stroke-dasharray="5 3"' : "";
    const title = `${band.laneLabel}: ${band.size} bp${band.rangeWarning ? `, ${band.rangeWarning}` : ""}`;
    return `<line x1="${format(band.x - bandWidth / 2)}" y1="${format(band.y)}" x2="${format(band.x + bandWidth / 2)}" y2="${format(band.y)}" stroke="${stroke}" stroke-width="5" stroke-linecap="round" opacity="${opacity}"${dash}><title>${escapeXml(title)}</title></line>`;
  });
  const ladderLabels = input.bands
    .filter((band) => band.isLadder)
    .map((band) => `<text class="ladder-label" x="${format(band.x - 24)}" y="${format(band.y + 4)}" text-anchor="end">${escapeXml(formatSizeLabel(band.size))}</text>`);
  const warningLabels = input.bands
    .filter((band) => !band.isLadder && band.rangeWarning !== undefined)
    .map((band) => `<text class="warning-label" x="${format(band.x + 23)}" y="${format(band.y - 7)}">${escapeXml(`${band.size} bp ${band.rangeWarning}`)}</text>`);

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${input.width}" height="${input.height}" viewBox="0 0 ${input.width} ${input.height}" role="img" aria-label="${escapeXml(input.gelId)} digest gel">
  <style>
    text { font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; fill: #1f2927; }
    .title { font-size: 15px; font-weight: 700; }
    .meta { font-size: 12px; fill: #5d6a66; }
    .lane-label { font-size: 11px; fill: #3a4643; }
    .ladder-label { font-size: 10px; fill: #465A64; }
    .warning-label { font-size: 10px; fill: #B23A48; }
  </style>
  <rect width="100%" height="100%" fill="#ffffff"/>
  <text class="title" x="22" y="27">${escapeXml(input.gelId)}</text>
  <text class="meta" x="22" y="46">log10-scaled linear DNA fragment migration</text>
  <rect x="48" y="56" width="${format(input.width - 76)}" height="${format(input.height - 96)}" rx="8" fill="#EEF4F2" stroke="#CDD8D5"/>
  ${laneElements.join("\n  ")}
  ${bandElements.join("\n  ")}
  ${ladderLabels.join("\n  ")}
  ${warningLabels.join("\n  ")}
</svg>
`;
}

function gelY(size: number, minSize: number, maxSize: number, top: number, bottom: number): number {
  const logMin = Math.log10(minSize);
  const logMax = Math.log10(maxSize);
  if (logMax === logMin) return (top + bottom) / 2;
  return top + ((logMax - Math.log10(size)) / (logMax - logMin)) * (bottom - top);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function formatSizeLabel(size: number): string {
  return size >= 1000 && size % 1000 === 0 ? `${size / 1000} kb` : `${size} bp`;
}

function normalizeLanes(lanes: GelLane[]): GelLane[] {
  if (!Array.isArray(lanes) || lanes.length === 0) {
    throw new MoleculeError("INVALID_ARGUMENT", "lanes must be a non-empty array.");
  }
  return lanes.map((lane, index) => {
    if (typeof lane !== "object" || lane === null || Array.isArray(lane)) {
      throw new MoleculeError("INVALID_ARGUMENT", "Each lane must be an object.", { index });
    }
    if (typeof lane.label !== "string" || lane.label.length === 0) {
      throw new MoleculeError("INVALID_ARGUMENT", "Lane label must be a non-empty string.", { index, label: lane.label });
    }
    if (!Array.isArray(lane.fragments) || lane.fragments.length === 0) {
      throw new MoleculeError("INVALID_ARGUMENT", "Lane fragments must be a non-empty array.", { index });
    }
    return {
      label: lane.label,
      fragments: lane.fragments.map((fragment, fragmentIndex) => normalizeFragment(fragment, index, fragmentIndex)),
    };
  });
}

function normalizeFragment(fragment: GelFragment, laneIndex: number, fragmentIndex: number): GelFragment {
  if (typeof fragment !== "object" || fragment === null || Array.isArray(fragment)) {
    throw new MoleculeError("INVALID_ARGUMENT", "Fragment must be an object.", { laneIndex, fragmentIndex });
  }
  const size = positiveInteger(fragment.size, "fragment.size");
  if (fragment.label !== undefined && (typeof fragment.label !== "string" || fragment.label.length === 0)) {
    throw new MoleculeError("INVALID_ARGUMENT", "Fragment label must be a non-empty string when provided.", {
      laneIndex,
      fragmentIndex,
      label: fragment.label,
    });
  }
  return fragment.label ? { size, label: fragment.label } : { size };
}

function normalizeLadder(ladder: number[]): number[] {
  if (!Array.isArray(ladder) || ladder.length === 0) {
    throw new MoleculeError("INVALID_ARGUMENT", "customLadder must be a non-empty array when provided.");
  }
  return ladder.map((size, index) => positiveInteger(size, `customLadder[${index}]`));
}

function assertSafeGelId(gelId: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(gelId)) {
    throw new MoleculeError("INVALID_ARGUMENT", "gelId must contain only letters, numbers, underscores, or hyphens.", { gelId });
  }
}

function positiveInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new MoleculeError("INVALID_ARGUMENT", `${name} must be a positive integer.`, { [name]: value });
  }
  return value;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function format(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(3);
}
