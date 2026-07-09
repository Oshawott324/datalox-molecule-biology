# SnapGene-Core Roadmap

**Begins after V1 trustworthy vertical ships (MB6 + HB1-HB4).**

This roadmap is intentionally narrow. Current implementation priority remains `docs/v1-trustworthy-vertical.md`: close the trustworthy demo spine before adding breadth. This document lists the post-V1 SnapGene-core work only.

For commercial-tool connectors and cross-product strategy, see `C:\Users\fangxf\Research Tools\datalox-review-2026-07\06-COMMERCIAL-MOLBIO-MCP-PLAN.md`.

## Post-V1 Tool Scope

1. `edit_sequence`
   - Insert, delete, replace, mutate.
   - Requires `expectedRevision`.
   - Returns new revision, diff summary, and affected features.

2. `simulate_restriction_ligation`
   - Use enzyme cut models and compatible-end rules from `simulate_assembly`.
   - Produce candidate product sequence, junction report, and regenerated-site evidence.
   - This is the Phase 1 demo revision path with `edit_sequence`: open pUC19 -> simulate EcoRI/BamHI digest -> insert payload -> verify diagnostic sites -> render gel/map artifacts.

3. `simulate_gibson`
   - Homology overlap validation.
   - Product construction.
   - Junction report.

4. `simulate_golden_gate`
   - Type IIS enzyme model.
   - Overhang compatibility.
   - Orientation validation.
   - Product construction and failure reasons.

5. Circular ORF support
   - Detect origin-spanning ORFs on circular molecules.
   - Preserve explicit assumptions in outputs.

6. Alternative genetic codes
   - Add genetic-code selection to ORF and translation tools.
   - Stamp genetic-code table version in outputs and provenance.

7. Degenerate motif search for `find_features`
   - Support IUPAC-aware degenerate motif queries.
   - This does not reverse the V1 policy that molecule input sequences remain unambiguous unless a later spec changes it.

8. Degenerate enzyme recognition
   - Support NEB-style degenerate enzyme recognition sequences, e.g. `GANTC` for HinfI and `CTRYAG` for SfcI.
   - This is larger than motif search because it changes the current supported-enzyme model and requires revisiting palindromic/non-palindromic assumptions.

9. SnapGene-core eval corpus
   - Make the eval corpus a named deliverable, not an incidental fixture folder.
   - It is required before claiming agent-native SnapGene parity for the scoped workflows.

## Eval Corpus Deliverable

Create a fixed corpus with:

- 5 common public plasmids.
- 3 circular constructs with ORFs spanning the origin.
- 3 degenerate motif / degenerate enzyme examples.
- 3 Golden Gate assemblies.
- 3 Gibson assemblies.
- 5 Sanger verification cases.
- 3 GenBank round-trip files.

Each case should store:

- input files;
- expected JSON summary;
- expected exported GenBank where applicable;
- expected artifact hashes or image snapshots where stable;
- tool versions;
- parameter manifest;
- evaluator script version.

## Success Criteria

Datalox can credibly claim "agent-native SnapGene" when:

- an agent can design a plasmid;
- simulate cloning;
- detect design failures;
- revise the construct;
- verify expected sequence;
- export GenBank;
- render map/gel artifacts;
- produce a replayable provenance bundle;
- pass fixed evals against commercial/reference outputs.

## Explicitly Out Of Scope Here

Do not copy cross-repo work into this roadmap. The following stay in the review-folder commercial plan or future connector repos:

- Geneious bridge.
- CLC Server MCP.
- Blast2GO / OmicsBox MCP.
- Benchling connector.
- Training/eval policy across commercial tools.
- Commercial integration map.
- Cross-product build order.
