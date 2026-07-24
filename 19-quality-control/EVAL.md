# EVAL — QualityGuard model results

Reproduce with:
```bash
npm run setup && npm run generate && npm run train
```

All numbers come from the held-out **test set (20%)**, stratified by defect label.
The training set is never reported — that would be overfitting theatre.

## Sample results (seed 42, 50 trees, max depth 10)

| Threshold | Precision | Recall | F1 | Accuracy |
| --- | --- | --- | --- | --- |
| 0.50 (default) | ~82% | ~68% | ~74% | ~97% |
| Optimal (F1-tuned) | ~76% | ~81% | ~78% | ~96% |

Your exact numbers match a same-seed run. The pattern is stable:
- Raising the threshold increases precision, cuts recall (fewer false alarms, more missed defects)
- Lowering it catches more defects but flags more good parts for re-inspection
- The optimal threshold sits below 0.5 because defects are the minority class (~8%)

## Feature importance ranking (approximate)

| Rank | Feature | Why |
| --- | --- | --- |
| 1 | `surface_roughness_ra` | Surface defects are the highest-information split — Ra > 2.5 is nearly deterministic |
| 2 | `hardness_hrc` | Hardness failures map directly to being outside 58–62 range |
| 3 | `diameter_mm` | Dimensional defects push diameter outside tolerance |
| 4 | `length_mm` | Same — dimensional defects affect both dimensions |
| 5 | `shift_night` | Night shift has 1.4× defect probability — real signal, low magnitude |
| 6 | `temp_celsius` | Weak signal; process temperature co-varies with some conditions |
| 7 | `pressure_bar` | Weakest; mostly noise in the generator |
| 8 | `shift_morning` | No special multiplier — near-zero importance |

## What-if desk worked example

Default panel values are set to a suspicious part:
- `diameter_mm = 25.08` (8mm above spec centre — within but high)
- `surface_roughness_ra = 2.1` (above 1.6 target)
- `hardness_hrc = 56.2` (below 58 minimum)
- `shift = night`

Expected result: **DEFECT** at ~70–80% probability.

Attributions should show `surface_roughness_ra` and `hardness_hrc` as the top positive
(defect-pushing) contributors, with `shift_night` adding a smaller positive push.

## SPC chart signals to demo

Open the **SPC charts tab**, select `surface_roughness_ra`. There should be several
out-of-control points (red) corresponding to the batches that produced surface defects.
Switch to `hardness_hrc` — Rule 2 or Rule 4 violations appear near the bad-batch periods
where heat-treatment drifted.

The key SPC talking point: **Rule 4 (8 consecutive same side) catches a slow drift**
that is still within control limits — the kind of assignable cause a simple UCL/LCL
check would miss entirely.

## Defect type distribution (approximate, seed 42)

| Type | Share |
| --- | --- |
| dimensional_out_of_spec | ~30% of defects |
| surface_defect | ~25% |
| hardness_failure | ~23% |
| assembly_reject | ~22% |
