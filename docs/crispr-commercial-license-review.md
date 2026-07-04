# CRISPR Scoring Commercial License Review

Status: internal review required before CR2 product implementation.

This note separates product/commercial licensing questions from the technical
CR2 validation gate in `docs/crispr-scoring-validation.md`.

## Current Position

- CR1 `design_grnas` is implemented without external CRISPR scoring assets.
- CR2 should not copy, vendor, redistribute, or package Azimuth code, model
  files, serialized weights, or reference data until this review is complete.
- The repo may keep technical validation scripts and source links that require
  a user-provided external Azimuth environment.

## Assets To Review

| Asset | Current finding | Product decision |
|---|---|---|
| Azimuth repository code | License file is BSD-3-Clause. | TBD: confirm acceptable for intended use before copying code. |
| Azimuth saved model / pickle assets | Not reviewed. | TBD: confirm license and redistribution status. |
| Training data | Not reviewed. | TBD: confirm provenance and use restrictions. |
| README example scores | Used only as validation references. | TBD: confirm whether shipping as test fixtures is acceptable. |
| Python dependencies pulled by Azimuth | Not reviewed. | TBD: review if distributed in an image or installer. |

## Cleanup Options For Future Commercialization

1. Keep Azimuth as a user-installed optional dependency and do not redistribute
   it with this package.
2. Provide a Docker image only after dependency and model-asset review.
3. Replace Azimuth with a separately licensed scorer if commercial constraints
   make redistribution or hosted use unsuitable.
4. Keep CR1-only guide design as the default commercial-safe baseline until CR2
   is cleared.

## Do Not Do

- Do not paste model coefficients or serialized model data into TypeScript.
- Do not vendor Azimuth source or model files into this repo without review.
- Do not call any unvalidated heuristic score `Azimuth`, `Rule Set 2`, or
  `Doench 2016`.
- Do not silently substitute CR1 ranking for CR2 efficacy scoring.
