# QualityGuard — 6-step demo walkthrough

Scripted tour for interviews (~5 minutes). Run `npm run setup`, `npm run generate`,
`npm run train`, `npm run dev` first. Terminal will print the model evaluation table.

## 1. Read the terminal output first

`npm run train` prints:
- Feature importance ranking (surface_roughness_ra and hardness_hrc should lead)
- Test-set precision/recall/F1 at both 0.5 and the optimal threshold
- Confusion matrix at the optimal threshold

Point at the difference between threshold 0.5 and optimal. Say: "on 8% defect rate data,
0.5 is not a principled cut-off — the optimal threshold is wherever the F1 trade-off
between false alarms and missed defects is best for this facility."

## 2. Inspections tab — the data

Open 📋 Inspections. Toggle “Defects only”. Point at a `surface_defect` row and note the
high Ra value; point at a `hardness_failure` row and note HRC outside 58–62. The features
are directly visible — the model is learning what a quality engineer would already flag
by hand.

## 3. SPC Charts — the statistical process control story

Open 📊 SPC Charts, select `surface_roughness_ra`. Find a red out-of-control point and
read the rule aloud (e.g., “Rule 2: 2 of 3 beyond 2σ”). Then switch to `hardness_hrc`
and look for a Rule 4 run signal — 8 points on the same side of the centre line, still
within UCL/LCL. Say: “SPC catches assignable causes that a simple alarm threshold misses;
the ML model catches the non-linear combinations that SPC misses."

## 4. Model metrics tab — the evaluation

Open 🧠 Model metrics. Drag the threshold slider from 0.2 to 0.8 and watch the confusion
matrix update live. At 0.2: high recall, many FP. At 0.8: high precision, many FN. Say:
"neither extreme is right; the optimal threshold is a business decision about the relative
cost of a field return vs. the cost of scrapping a good part."

Scroll to feature importance. `surface_roughness_ra` and `hardness_hrc` should be #1 and
#2 — which matches domain knowledge. When the ML ranking agrees with the process engineer,
that’s validation; when it disagrees, that’s discovery.

## 5. Predict tab — the SHAP-style attribution

Sign in (`inspector@ironclad.test` / `ChangeMe123!`). Hit **Run prediction** with the
default suspicious-part values (high Ra, low HRC, night shift). The result should be
**DEFECT** with positive attributions for `surface_roughness_ra` and `hardness_hrc`.

Now change `surface_roughness_ra` to `1.0` and `hardness_hrc` to `60.0` and rerun.
The probability should drop sharply and those features should flip to near-zero or
negative attribution. Say: “perturbation attribution lets a quality engineer understand
*why* this specific part was flagged, not just that it was.”

## 6. Prove it’s deterministic (optional)

```bash
npm run generate   # blocked if data exists — same seed = same data
npm run train      # same model every time
```

## Curl quickies

```bash
# defect summary
curl 'http://localhost:3000/api/inspections?limit=5' | head -c 600

# model metrics at threshold 0.6
curl 'http://localhost:3000/api/metrics?threshold=0.6' | head -c 800

# SPC chart for Ra
curl 'http://localhost:3000/api/inspections?spc_feature=surface_roughness_ra' | head -c 800
```
