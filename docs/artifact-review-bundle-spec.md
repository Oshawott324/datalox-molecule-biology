# Artifact Review Bundle Spec (UI-5)

Status: draft spec. Architecture decision doc for how agent-produced artifacts
reach a human for verification. No implementation until reviewed.

This is UI-5 in the near-term UI track. It is not a rendering task; it is the
decision about how the maps, gels, BLAST results, and provenance the agent
produces become human-verifiable inside an agent host (Claude Desktop, Codex,
Cursor). That choice is the multiplier on every visual artifact, so it is specced
before code.

## The Decision

**Primary path: a single self-contained static HTML review bundle.** MCP
resources are deferred; returning artifact paths remains the always-available
floor.

### Options considered

| Option | Pro | Con | Verdict |
|---|---|---|---|
| Return artifact paths only | Trivial; already done | Human opens files manually; artifacts exist but are not surfaced | Floor, not the story |
| MCP resources | Protocol-native; host-integrated | Host support is inconsistent (SVG resource rendering varies); couples us to evolving host capabilities | Deferred enhancement |
| Local viewer URL (HTTP server) | Rich interactive view; full control | Server lifecycle, port, cleanup, security; not portable to remote/hosted contexts (see `open_sequence_editor`) | Rejected for v1 |
| Static HTML review bundle | Self-contained, portable, offline, demo/attach-friendly; IS the provenance story | Static (no interactivity); regenerated per checkpoint | **Chosen** |

### Why static-first

- **Lowest dependency.** No host feature support required, no local-server
  lifecycle. Every current artifact (SVG map, SVG gel, GenBank, FASTA, gRNA
  markdown, BLAST JSON) is text, so a single self-contained HTML can inline all
  of them with no binary assets.
- **It is the provenance story.** One openable file containing the inlined
  visuals, the digest/hit tables, and a human-readable replay summary is the
  tangible "everything the agent saw and did" artifact -- offline, attachable to
  a PR, email, or investor deck.
- **It converges with UI-4 export.** The review bundle is the human-readable
  face of the checkpoint/export bundle. They share one generator, so UI-4 does
  not need its own format (see "Relationship to Provenance and Export").
- **MCP resources are additive later.** They layer over the same generated
  artifacts without discarding the bundle.

## Bundle Contents

A single `review.html` containing:

1. **Header:** workspace id, final revision, generated-at timestamp,
   tool/package version. Local absolute paths are omitted by default; include
   them only when `includeLocalPaths: true` is explicitly set for local-only
   review.
2. **Molecule summary:** per molecule -- id, name, length, topology, alphabet,
   sequence digest.
3. **Inlined visual artifacts:** the plasmid map SVG and digest gel SVG inlined
   directly (SVG is XML text; no external references).
4. **Structured result tables:** restriction sites, digest fragments, BLAST hit
   summary (summarized, never raw `qseq`/`hseq`/`midline`), primer/gRNA lists.
5. **Human-readable replay summary:** an ordered, camera-friendly narrative of
   the tool calls the agent made (derived only from verified provenance bundle
   records), e.g. "opened pUC19 -> inserted NotI payload -> validated ->
   rendered map."
6. **Embedded machine-readable manifest:** a `<script type="application/json"
   id="datalox-review-manifest">` block so the single file is both
   human-viewable and machine-parseable (artifact list, provenance `bundleId`,
   workspace revision, digests).

Artifacts are **inlined**, not linked, so `review.html` is one portable file.
Because all current artifacts are text, this is feasible without a binary
sidecar; revisit only if a future artifact is binary (e.g. a raster image).

## Generating Tool

```ts
type RenderReviewBundleInput = {
  workspacePath: string;
  outputPath?: string;          // workspace-relative; default reports/review/review.html
  artifacts?: Array<{           // explicit artifact descriptors from prior tool envelopes
    kind: string;
    path: string;
    mimeType?: string;
    description?: string;
  }>;
  replayBundlePath?: string;    // explicit path to .datalox/replay-bundles/<id>
  includeReplaySummary?: boolean; // default true when replayBundlePath is provided
  moleculeIds?: string[];       // default: all molecules in the workspace
  includeLocalPaths?: boolean;   // default false; true only for local debugging
};

type RenderReviewBundleResult = {
  outputPath: string;
  moleculeIds: string[];
  includedArtifacts: Array<{ kind: string; path: string; missing?: boolean }>;
  provenanceBundleId?: string;
  provenanceVerified?: boolean;
  revision: number;
};
```

- MCP tool `render_review_bundle`, returning artifact `kind: "review_bundle"`,
  `mimeType: "text/html"`.
- CLI `molecule-biology render-review-bundle <workspacePath>`.
- Read-only over the workspace: it reads existing artifacts and provenance and
  writes one HTML file. It does not mutate `molecule.workspace.json` and does not
  bump the workspace revision.
- Do not discover artifacts by recursively scanning `reports/`. The workspace
  does not have a canonical artifact index today, and scanning would turn this
  into a heuristic. The agent must pass `artifacts` from prior tool envelopes,
  or pass `replayBundlePath` so the generator can read artifact records from the
  provenance bundle.
- If a referenced artifact file is missing, include a visible placeholder in the
  HTML and list it in the manifest as `missing: true`, rather than failing the
  whole bundle. Do not silently drop it.
- `outputPath`, `artifacts[].path`, and `replayBundlePath` must resolve inside
  the workspace root unless the path points to an existing replay bundle under
  the workspace `.datalox/replay-bundles/` directory. Reject outside paths with
  `PATH_OUTSIDE_WORKSPACE`.
- When `replayBundlePath` is provided, verify the bundle before summarizing it.
  If verification fails, return a structured error; do not present unverified
  records as provenance.

## Relationship to Provenance and Export

Three layers, one generator, no duplication:

- **Provenance bundle** (`docs/provenance-bundle-schema.md`): the machine-readable
  append-only audit log -- immutable tool-call records, artifact digests, bundle
  hash. Already implemented.
- **Review bundle** (this spec, UI-5): the human-readable HTML view built FROM
  the provenance records and the artifacts. Reads provenance; never rewrites it.
- **Export/checkpoint bundle** (UI-4, later): a ZIP that packages
  `review.html` + the raw artifact files + the provenance manifest + a workspace
  snapshot. UI-4 reuses this generator and the same manifest; it does not define
  a new format. This is why UI-4 comes after UI-5 and gets no separate spec.

The review bundle references artifacts by inlining their content; the export ZIP
also ships the raw files so machine consumers get unmodified bytes.

## Determinism

`review.html` embeds non-reproducible content: BLAST results, generated-at
timestamps, and provenance bundle ids. It is therefore **not byte-deterministic**
and must never be hash-pinned or added to the eval corpus, exactly like the raw
BLAST artifact. It is a record for humans, not a reproducible tool output.

The deterministic *inputs* (plasmid map SVG, gel SVG) remain byte-stable and are
pinned by their own tests/corpus; the bundle just inlines them.

## Security and Portability

- **No network, no server, no scripts that fetch.** `review.html` is inert:
  inlined SVG and HTML only. No `<script src>` to a CDN, no external `<img>`,
  no local HTTP server. This keeps it portable, offline, and safe to attach.
- The embedded manifest `<script type="application/json">` is data, not
  executable; it is not run by the browser.
- Do not inline absolute filesystem paths that leak a user's home directory into
  a shareable file; prefer workspace-relative paths (reuse the existing
  path-redaction seam used for tool error output).
- Escape all non-SVG text artifacts before embedding (`GenBank`, `FASTA`,
  Markdown, JSON). Do not render Markdown as raw HTML in v1.
- Inline SVG only through one of two trusted paths:
  1. Prefer re-rendering first-party artifacts from workspace/tool state when
     the render parameters are available. Bytes produced by the local renderer
     do not need to trust a caller-supplied SVG file.
  2. When an existing SVG file must be inlined, parse it and enforce a strict
     element/attribute allowlist matching the SVG emitted by this repo's
     renderers (`svg`, `style`, `defs`, `marker`, `path`, `g`, `circle`, `line`,
     `rect`, `text`, `title`, `tspan`). Allowed attributes are limited to the
     renderer's static geometry/style fields (`xmlns`, `width`, `height`,
     `viewBox`, `role`, `aria-label`, `class`, `id`, `x`, `y`, `x1`, `y1`,
     `x2`, `y2`, `cx`, `cy`, `r`, `d`, `fill`, `stroke`, `stroke-width`,
     `stroke-linecap`, `text-anchor`, `dominant-baseline`, `font-weight`,
     `markerWidth`, `markerHeight`, `refX`, `refY`, `orient`, `markerUnits`,
     `transform`).
- "First-party" must be enforced by the re-render/allowlist path above, not by
  trusting the caller's declared `kind`. A caller-supplied
  `{ kind: "plasmid_map", path: "crafted.svg" }` is still untrusted.
- The SVG allowlist must reject any attribute beginning with `on` (case
  insensitive), any `href`/`xlink:href`, any URI scheme (`javascript:`, `data:`,
  `http:`, `https:`, `file:`), `<foreignObject>`, `<image>`, `<use>`, and CSS
  `url(...)` or `@import` inside `<style>`. If validation fails, do not inline
  the SVG; render an escaped text placeholder and mark the artifact as rejected
  in the manifest.
- Serialize the embedded manifest with raw-script escaping before placing it in
  `<script type="application/json">`: replace `<` with `\u003c`, `>` with
  `\u003e`, and `&` with `\u0026` in the JSON string. HTML entity escaping is
  not sufficient inside script raw-text elements. This prevents molecule names,
  artifact descriptions, or BLAST titles containing `</script>` from breaking
  out into executable HTML.
- Enforce a review-bundle input ceiling before inlining artifacts. If the total
  artifact bytes exceed the cap, include a visible placeholder for the skipped
  artifact and mark it `truncated: true` in the manifest; do not emit an
  unbounded HTML file.

## MCP Resources (deferred)

When host support matures, expose generated artifacts as MCP `resources` so a
host can list/render them natively. This is purely additive over the same files
and does not change the bundle format. Do not build it in v1; note it as the
next viewer enhancement.

## Scope Boundaries

| Feature | UI-5 v1 | Deferred |
|---|---|---|
| Single self-contained HTML review bundle | yes | -- |
| Inlined plasmid map + gel SVG | yes | -- |
| Structured result tables + BLAST summary | yes | -- |
| Human-readable replay summary from provenance | yes | -- |
| Embedded machine-readable manifest | yes | -- |
| Interactive/zoomable views | no | later (needs the local-viewer or web path) |
| MCP resources exposure | no | after host support |
| Export/checkpoint ZIP | no | UI-4, reuses this generator |
| Raster/binary artifact handling | no | only if a binary artifact is added |

## Test Contract

The bundle mixes deterministic and non-deterministic content, so tests assert
structure, not bytes:

- Given a workspace with a rendered map + gel, `render_review_bundle` produces an
  HTML file that contains the inlined map SVG and gel SVG (assert the SVG root
  markers are present inline, not as external references).
- The embedded manifest parses as JSON and lists the expected artifact kinds,
  workspace revision, and (when present) provenance `bundleId`.
- A missing artifact yields a visible placeholder and a manifest entry marked
  missing, not a thrown error.
- The generator does not scan `reports/`; tests pass explicit artifacts and/or
  an explicit replay bundle path.
- No `<script src=`, no external `<img src=` (http), no `file:` references, no
  SVG event-handler attributes, and no absolute home-dir paths appear in the
  output.
- A malicious or non-first-party SVG is not inlined, including cases with
  `javascript:`, `data:`, `href`/`xlink:href`, `<use>`, `<image>`, CSS
  `url(...)`, `@import`, and mixed-case `on*` event attributes such as
  `onbegin` or `onmouseover`.
- Manifest JSON containing `</script>`, `<`, `>`, or `&` remains contained in
  the JSON script block through `\u003c`/`\u003e`/`\u0026` escaping.
- A bundle-size cap produces a visible placeholder and manifest metadata instead
  of an unbounded HTML file.
- Do NOT byte-hash `review.html` and do NOT add it to the eval corpus; assert on
  presence/structure only.

## Guardrails Carried Forward

- Read-only over the workspace; no revision bump; no rewriting the provenance
  bundle.
- Non-reproducible artifact: keep out of determinism gates and the corpus.
- Agent-facing structured errors for tool-level failures (missing workspace,
  bad path), human-readable content only inside the generated HTML.
- Prose in this repo is ASCII: `->`, `--`, "section N".
