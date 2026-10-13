# QualityGuard — Manufacturing Quality Control

Defect detection ML pipeline for a fictional precision parts manufacturer
(**Ironclad Precision Parts**): 2000 seeded inspection records across 4 production lines,
a **random forest classifier implemented from scratch** with Gini-impurity splitting and
bootstrap aggregation, **SPC control charts** (X-bar with Western Electric rules),
**SHAP-style perturbation attribution** per prediction, and a full precision/recall/F1
evaluation suite.

Next.js 14 (App Router) + TypeScript + PostgreSQL. No ML libraries.

## Architecture

```
scripts/generate.mjs          scripts/train.mjs                   Next.js app
┌───────────────────┐    ┌─────────────────────────┐    ┌──────────────────────┐
│ 2000 inspections   │    │ Random Forest from scratch:   │    │ 📋 Inspection log    │
│ 4 production lines │───▶│  50 trees, Gini split,         │───▶│ 📊 SPC charts         │
│ 4 defect types     │    │  bootstrap bags, sqrt feats,  │    │ 🧠 Model metrics     │
│ night-shift bias   │    │  optimal threshold (F1),      │    │    confusion, P/R/F1 │
│ bad material batch │    │  feature importance (Gini)    │    │ 🔎 Predict + SHAP   │
└───────────────────┘    └─────────────────────────┘    └──────────────────────┘
         Postgres: users · production_lines · inspections · model_predictions · model_store
```

## Design

1. **Random forest from scratch, no ML libraries.** Each tree uses Gini-impurity best-split
   search over a random sqrt(n_features) subset of features at each node (the defining trick
   that makes trees diverse). Bootstrap sampling decorrelates the trees. The result is a
   50-element JSONB array of nested split/leaf objects, stored in Postgres and loaded at
   inference time — no sidecar, no file system dependency in production.

2. **Threshold optimised on training set, reported on held-out test set.** The default
   threshold of 0.5 is almost never optimal on imbalanced data (~8% defect rate). The trainer
   sweeps thresholds on the training fold, picks the F1-maximising cut-off, and reports *both*
   0.5 and the optimal threshold on the held-out test set so the numbers are honest.

3. **Feature importance = mean Gini decrease.** Accumulated across all 50 trees at every split
   on a given feature, weighted by the number of samples reaching that split, and normalised.
   This is exactly what scikit-learn's `feature_importances_` computes — the implementation
   here is ~10 lines and produces the same ranking.

4. **Perturbation-based attribution (SHAP-style).** For each prediction, each feature is set
   to its training-set mean (z-score = 0) and the probability change is measured. Positive
   delta = this feature is pushing toward defect. This is not exact SHAP (which requires
   exponential marginalisation), but it's transparent, fast, and interview-defensible.

5. **SPC with Western Electric rules.** X-bar control charts use Shewhart A₂/D₄ constants
   for subgroup size 5. Four WE rules are implemented: 1-point beyond 3σ, 2-of-3 beyond 2σ,
   4-of-5 beyond 1σ, and 8-consecutive same side. These flag assignable (special) causes
   that a control limit alone would miss.

6. **Engineered defect structure.** The synthetic data has learnable signal:
   - Surface defects: Ra > 2.5 μm (direct feature)
   - Hardness failures: HRC outside 58–62 (direct feature)
   - Dimensional: diameter/length outside tolerance (direct features)
   - Night shift: 1.4× baseline defect probability (shift feature)
   - Material batch B22: 1.6× baseline (not a model feature — residual unexplained variance)

## Getting started

```bash
npm install
cp .env.example .env.local   # set DATABASE_URL (Neon/Supabase free tier)
npm run setup                # schema + 2 users + 4 production lines
npm run generate             # 2000 synthetic inspection records (seed 42)
npm run train                # random forest, evaluation, write predictions
npm run dev                  # http://localhost:3000
```

Sign-in (predict desk): `inspector@ironclad.test` / `manager@ironclad.test` with `SEED_PASSWORD`
(default `ChangeMe123!`).

## API

| Method | Route | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/api/inspections` | — | List inspections (filters: `line_id`, `defect_only=1`, `limit`); summary stats |
| GET | `/api/inspections?spc_feature=` | — | X-bar SPC chart for a measurement feature |
| GET | `/api/metrics?threshold=` | — | Confusion matrix, P/R/F1, threshold sweep, feature importance |
| POST | `/api/predict` | session | Score a new part reading with attributions |
| GET/POST/DELETE | `/api/auth` | — | Session check / login / logout |

## Defect taxonomy

| Type | Root cause | ML signal |
| --- | --- | --- |
| `dimensional_out_of_spec` | Tool wear, thermal expansion | Diameter / length deviation |
| `surface_defect` | Coolant failure, worn insert | Ra μm spike |
| `hardness_failure` | Heat-treat process drift | HRC out of 58–62 range |
| `assembly_reject` | Stacked minor tolerances | Combination of small deviations |

## Edge cases handled

| # | Edge case | Behavior |
| --- | --- | --- |
| 1 | Class imbalance (~8% defects) | Threshold optimised on training F1, not default 0.5 |
| 2 | Not enough SPC subgroups | Returns empty points array gracefully |
| 3 | No trained model | `/api/predict` returns 409 with a clear run-train message |
| 4 | Double generation | `generate` refuses if rows exist; prints exact TRUNCATE |
| 5 | Unknown SPC feature | 400 with allowed list |
| 6 | Missing predict fields | 422 per missing field |
| 7 | Model retraining | `train` deletes old predictions + model store before rewriting |
| 8 | Unauthenticated predict | 401 — prediction requires a session |

## Honesty notes

- **Material batch is not a model feature.** Batch B22's higher defect rate is unexplained
  variance from the model's perspective — it shows up as residual prediction error, which is
  honest. Real improvement would require adding batch as a categorical feature.
- **Perturbation attribution ≠ SHAP.** True SHAP marginalises over all feature subsets
  (2^n evaluations). Perturbation to the training mean is a fast approximation. The ranking
  is usually correct; the magnitude is not guaranteed.
- **The forest is stored as JSONB.** Loading 50 trees at inference time is fast for 2000
  inspections. For 200,000 inspections you'd pre-score in a batch job (the `train` script
  already does this) and serve from the `model_predictions` table.

## Deploying

- **App:** Vercel (Next.js defaults).
- **Postgres:** Neon or Supabase free tier.
- Run `setup`/`generate`/`train` once from your machine against the production `DATABASE_URL`.
  Retrain on a schedule as new inspection data arrives.
