import { promises as fs } from "node:fs";
import path from "node:path";

import { getSequenceContext } from "./context.js";
import { MoleculeError } from "./errors.js";
import type { CoordinateSegment, Feature, Primer } from "./schema.js";
import { workspaceRootFromPath } from "./paths.js";

export type PlasmidMapCutSite = {
  enzyme: string;
  position: number;
};

export type RenderPlasmidMapOptions = {
  outputPath?: string;
  width?: number;
  height?: number;
  cutSites?: PlasmidMapCutSite[];
  showPrimers?: boolean;
};

export type RenderPlasmidMapResult = {
  moleculeId: string;
  outputPath: string;
  relativePath: string;
  mimeType: "image/svg+xml";
  width: number;
  height: number;
  length: number;
  renderedFeatureIds: string[];
  renderedPrimerIds: string[];
  renderedCutSites: PlasmidMapCutSite[];
  rules: {
    baseOneAngle: "12_o_clock";
    direction: "clockwise";
    featureSortKey: "minimum_segment_start_then_minimum_segment_end_then_id";
    multiSegmentRendering: "one_arc_per_segment_one_label_per_feature";
    labelPlacement: "feature_anchor_midpoint_with_radius_staggered_by_sorted_index";
    primerRendering: "bound_primers_only_one_arrow_per_binding_segment";
    cutSiteRendering: "caller_supplied_ticks_at_cut_position";
  };
};

type RenderableFeature = Feature & {
  sortStart: number;
  sortEnd: number;
};

const DEFAULT_WIDTH = 720;
const DEFAULT_HEIGHT = 560;

export const FEATURE_COLORS: Record<string, string> = {
  CDS: "#E9A227",
  gene: "#E9A227",
  promoter: "#4CAF50",
  terminator: "#E53935",
  rep_origin: "#78909C",
  primer_bind: "#AB47BC",
  RBS: "#29B6F6",
  regulatory: "#26A69A",
  misc_feature: "#90A4AE",
};

export function featureColor(type: string): string {
  return FEATURE_COLORS[type] ?? "#546E7A";
}

export async function renderPlasmidMap(
  workspacePath: string,
  moleculeId: string,
  options: RenderPlasmidMapOptions = {},
): Promise<RenderPlasmidMapResult> {
  const context = await getSequenceContext(workspacePath, moleculeId, { includeSequence: false });
  if (context.molecule.topology !== "circular" || context.molecule.moleculeType !== "dna") {
    throw new MoleculeError("INVALID_ARGUMENT", "render_plasmid_map requires a circular DNA molecule.", {
      moleculeId,
      topology: context.molecule.topology,
      moleculeType: context.molecule.moleculeType,
    });
  }

  const width = positiveInteger(options.width ?? DEFAULT_WIDTH, "width");
  const height = positiveInteger(options.height ?? DEFAULT_HEIGHT, "height");
  const workspaceRoot = workspaceRootFromPath(workspacePath);
  const relativePath = options.outputPath
    ? path.relative(workspaceRoot, path.isAbsolute(options.outputPath) ? options.outputPath : path.join(workspaceRoot, options.outputPath))
    : path.join("reports", "maps", `${moleculeId}.plasmid.svg`);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new MoleculeError("INVALID_ARGUMENT", "Plasmid map outputPath must stay inside the workspace.", {
      outputPath: options.outputPath,
      workspaceRoot,
    });
  }
  const outputPath = path.join(workspaceRoot, relativePath);

  const features = (context.features ?? [])
    .filter((feature) => feature.type !== "source")
    .map(renderableFeature)
    .sort((left, right) => left.sortStart - right.sortStart || left.sortEnd - right.sortEnd || left.id.localeCompare(right.id));
  const primers = options.showPrimers
    ? (context.primers ?? [])
      .filter((primer) => primer.moleculeId === moleculeId && primer.binding && primer.binding.segments.length > 0)
      .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
    : [];
  const cutSites = normalizeCutSites(options.cutSites ?? [], context.molecule.length);
  const svg = renderSvg({
    moleculeName: context.molecule.name,
    moleculeId,
    length: context.molecule.length,
    features,
    primers,
    cutSites,
    width,
    height,
  });

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, svg, "utf8");

  return {
    moleculeId,
    outputPath,
    relativePath,
    mimeType: "image/svg+xml",
    width,
    height,
    length: context.molecule.length,
    renderedFeatureIds: features.map((feature) => feature.id),
    renderedPrimerIds: primers.map((primer) => primer.id),
    renderedCutSites: cutSites,
    rules: {
      baseOneAngle: "12_o_clock",
      direction: "clockwise",
      featureSortKey: "minimum_segment_start_then_minimum_segment_end_then_id",
      multiSegmentRendering: "one_arc_per_segment_one_label_per_feature",
      labelPlacement: "feature_anchor_midpoint_with_radius_staggered_by_sorted_index",
      primerRendering: "bound_primers_only_one_arrow_per_binding_segment",
      cutSiteRendering: "caller_supplied_ticks_at_cut_position",
    },
  };
}

function renderSvg(input: {
  moleculeName: string;
  moleculeId: string;
  length: number;
  features: RenderableFeature[];
  primers: Primer[];
  cutSites: PlasmidMapCutSite[];
  width: number;
  height: number;
}): string {
  const centerX = input.width / 2;
  const centerY = input.height / 2;
  const radius = Math.min(input.width, input.height) * 0.31;
  const featureRadius = radius + 10;
  const primerRadius = radius - 13;
  const cutInnerRadius = radius - 11;
  const cutOuterRadius = radius + 22;
  const cutLabelRadius = radius + 78;
  const labelBaseRadius = radius + 58;
  const paths: string[] = [];
  const primerPaths: string[] = [];
  const cutTicks: string[] = [];
  const labels: string[] = [];

  input.features.forEach((feature, featureIndex) => {
    const color = featureColor(feature.type);
    feature.segments.forEach((segment) => {
      paths.push(`<path d="${arcPath(centerX, centerY, featureRadius, input.length, segment)}" fill="none" stroke="${color}" stroke-width="10" stroke-linecap="round"><title>${escapeXml(feature.name)}</title></path>`);
    });

    const anchor = anchorSegment(feature);
    const midpoint = segmentMidpoint(anchor, input.length);
    const labelRadius = labelBaseRadius + (featureIndex % 4) * 18;
    const point = polar(centerX, centerY, labelRadius, input.length, midpoint);
    const tickStart = polar(centerX, centerY, featureRadius + 8, input.length, midpoint);
    const textAnchor = point.x < centerX - 8 ? "end" : point.x > centerX + 8 ? "start" : "middle";
    labels.push(`<line x1="${format(tickStart.x)}" y1="${format(tickStart.y)}" x2="${format(point.x)}" y2="${format(point.y)}" stroke="#8b9692" stroke-width="1"/>`);
    labels.push(`<text x="${format(point.x)}" y="${format(point.y)}" text-anchor="${textAnchor}" dominant-baseline="middle">${escapeXml(feature.name)}</text>`);
  });

  input.primers.forEach((primer, primerIndex) => {
    const binding = primer.binding;
    if (!binding) return;
    binding.segments.forEach((segment, segmentIndex) => {
      const color = segment.strand === "-" ? "#D32F2F" : "#1976D2";
      const label = segmentIndex === 0 ? primer.name : `${primer.name} ${segmentIndex + 1}`;
      primerPaths.push(`<path d="${primerArcPath(centerX, centerY, primerRadius - (primerIndex % 3) * 7, input.length, segment)}" fill="none" stroke="${color}" stroke-width="5" stroke-linecap="round" marker-end="url(#primer-arrow-${segment.strand === "-" ? "reverse" : "forward"})"><title>${escapeXml(label)}</title></path>`);
      const midpoint = segmentMidpoint(segment, input.length);
      const point = polar(centerX, centerY, primerRadius - 26 - (primerIndex % 3) * 10, input.length, midpoint);
      const textAnchor = point.x < centerX - 8 ? "end" : point.x > centerX + 8 ? "start" : "middle";
      labels.push(`<text class="primer-label" x="${format(point.x)}" y="${format(point.y)}" text-anchor="${textAnchor}" dominant-baseline="middle">${escapeXml(label)}</text>`);
    });
  });

  input.cutSites.forEach((site, index) => {
    const inner = polar(centerX, centerY, cutInnerRadius, input.length, site.position);
    const outer = polar(centerX, centerY, cutOuterRadius, input.length, site.position);
    const point = polar(centerX, centerY, cutLabelRadius + (index % 5) * 14, input.length, site.position);
    const textAnchor = point.x < centerX - 8 ? "end" : point.x > centerX + 8 ? "start" : "middle";
    cutTicks.push(`<line x1="${format(inner.x)}" y1="${format(inner.y)}" x2="${format(outer.x)}" y2="${format(outer.y)}" stroke="#263238" stroke-width="2"><title>${escapeXml(site.enzyme)} cut at ${site.position}</title></line>`);
    cutTicks.push(`<text class="cut-label" x="${format(point.x)}" y="${format(point.y)}" text-anchor="${textAnchor}" dominant-baseline="middle">${escapeXml(site.enzyme)}</text>`);
  });

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${input.width}" height="${input.height}" viewBox="0 0 ${input.width} ${input.height}" role="img" aria-label="${escapeXml(input.moleculeName)} plasmid map">
  <style>
    text { font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-size: 13px; fill: #1f2927; }
    .meta { font-size: 12px; fill: #5d6a66; }
    .primer-label { font-size: 11px; fill: #2b3c39; }
    .cut-label { font-size: 11px; fill: #263238; font-weight: 700; }
  </style>
  <defs>
    <marker id="primer-arrow-forward" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto" markerUnits="strokeWidth"><path d="M 0 0 L 8 4 L 0 8 z" fill="#1976D2"/></marker>
    <marker id="primer-arrow-reverse" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto" markerUnits="strokeWidth"><path d="M 0 0 L 8 4 L 0 8 z" fill="#D32F2F"/></marker>
  </defs>
  <rect width="100%" height="100%" fill="#ffffff"/>
  <circle cx="${format(centerX)}" cy="${format(centerY)}" r="${format(radius)}" fill="none" stroke="#c9d3d0" stroke-width="9"/>
  ${primerPaths.join("\n  ")}
  ${paths.join("\n  ")}
  ${cutTicks.join("\n  ")}
  <text x="${format(centerX)}" y="${format(centerY - 8)}" text-anchor="middle" font-weight="700">${escapeXml(input.moleculeName)}</text>
  <text class="meta" x="${format(centerX)}" y="${format(centerY + 14)}" text-anchor="middle">${input.length} bp circular DNA</text>
  <text class="meta" x="${format(centerX)}" y="${format(centerY + 34)}" text-anchor="middle">${escapeXml(input.moleculeId)}</text>
  ${labels.join("\n  ")}
</svg>
`;
}

function renderableFeature(feature: Feature): RenderableFeature {
  const starts = feature.segments.map((segment) => segment.start);
  const ends = feature.segments.map((segment) => segment.end);
  return {
    ...feature,
    sortStart: Math.min(...starts),
    sortEnd: Math.min(...ends),
  };
}

function normalizeCutSites(cutSites: PlasmidMapCutSite[], moleculeLength: number): PlasmidMapCutSite[] {
  return cutSites.map((site, index) => {
    if (typeof site.enzyme !== "string" || site.enzyme.length === 0) {
      throw new MoleculeError("INVALID_ARGUMENT", "cutSites[].enzyme must be a non-empty string.", { index, cutSite: site });
    }
    const position = positiveInteger(site.position, `cutSites[${index}].position`);
    if (position > moleculeLength) {
      throw new MoleculeError("INVALID_ARGUMENT", "cutSites[].position must be within the molecule length.", {
        index,
        position,
        moleculeLength,
      });
    }
    return { enzyme: site.enzyme, position };
  }).sort((left, right) => left.position - right.position || left.enzyme.localeCompare(right.enzyme));
}

function anchorSegment(feature: RenderableFeature): CoordinateSegment {
  return [...feature.segments].sort((left, right) => left.start - right.start || left.end - right.end)[0];
}

function segmentMidpoint(segment: CoordinateSegment, length: number): number {
  if (segment.start <= segment.end) return (segment.start + segment.end + 1) / 2;
  const span = (length - segment.start + 1) + segment.end;
  return ((segment.start - 1 + span / 2) % length) + 1;
}

function arcPath(centerX: number, centerY: number, radius: number, length: number, segment: CoordinateSegment): string {
  const startPosition = segment.start;
  const endPosition = segment.start <= segment.end ? segment.end + 1 : segment.end + length + 1;
  const span = endPosition - startPosition;
  const start = polar(centerX, centerY, radius, length, startPosition);
  const end = polar(centerX, centerY, radius, length, ((endPosition - 1) % length) + 1);
  const largeArc = span > length / 2 ? 1 : 0;
  return `M ${format(start.x)} ${format(start.y)} A ${format(radius)} ${format(radius)} 0 ${largeArc} 1 ${format(end.x)} ${format(end.y)}`;
}

function primerArcPath(centerX: number, centerY: number, radius: number, length: number, segment: CoordinateSegment): string {
  if (segment.strand !== "-") return arcPath(centerX, centerY, radius, length, segment);
  const span = segment.end - segment.start + 1;
  const start = polar(centerX, centerY, radius, length, segment.end + 1 > length ? 1 : segment.end + 1);
  const end = polar(centerX, centerY, radius, length, segment.start);
  const largeArc = span > length / 2 ? 1 : 0;
  return `M ${format(start.x)} ${format(start.y)} A ${format(radius)} ${format(radius)} 0 ${largeArc} 0 ${format(end.x)} ${format(end.y)}`;
}

function polar(centerX: number, centerY: number, radius: number, length: number, position: number): { x: number; y: number } {
  const radians = (-90 + ((position - 1) * 360 / length)) * Math.PI / 180;
  return {
    x: centerX + radius * Math.cos(radians),
    y: centerY + radius * Math.sin(radians),
  };
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) {
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
