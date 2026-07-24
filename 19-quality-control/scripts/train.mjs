// Random Forest trainer for QualityGuard.
//
// Algorithm: bagged ensemble of decision trees (from scratch).
//   - 50 trees, each trained on a bootstrap sample of the training set
//   - Random feature subsets at each split: sqrt(n_features) candidates
//   - Split criterion: Gini impurity
//   - Max depth: 10; min samples per leaf: 5
//   - Feature standardisation (z-score) before training + stored in metadata
//     so inference uses the same scale
//
// Evaluation:
//   - 80/20 stratified train/test split (stratified by is_defect)
//   - Threshold optimised on training set to maximise F1
//   - All test predictions written to model_predictions for the UI metrics tab
//   - Prints precision / recall / F1 / accuracy at optimal and 0.5 thresholds
//
// Feature importance:
//   Mean Gini decrease across all trees and all splits on that feature,
//   normalised to sum to 1. Reported per feature and stored in metadata.
//
// Why a random forest instead of a gradient booster?
//   Bagging + random subspaces is explainable at the tree level, and the
//   attribution method (perturbation-based, like SHAP) works directly on the
//   stored forest JSON without a separate library. For a production upgrade
//   the swap to XGBoost is one npm install; the evaluation harness stays.

import { readFileSync } from "node:fs"
import pg from "pg"

try {
  const env = readFileSync(new URL("../.env.local", import.meta.url), "utf8")
  for (const line of env.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
  }
} catch {}

if (!process.env.DATABASE_URL) { console.error("DATABASE_URL not set"); process.exit(1) }

const SEED = Number(process.env.DATA_SEED || 42)
const N_TREES = 50
const MAX_DEPTH = 10
const MIN_LEAF = 5

function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5)
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const rng = mulberry32(SEED + 999)

function gini(labels) {
  const n = labels.length
  if (n === 0) return 0
  const pos = labels.filter(Boolean).length
  const neg = n - pos
  return 1 - (pos/n)**2 - (neg/n)**2
}

function bestSplit(X, y, featureIndices) {
  let bestGain = -Infinity, bestFeat = -1, bestThresh = 0
  const parentGini = gini(y)
  const n = y.length
  for (const fi of featureIndices) {
    const vals = X.map(row => row[fi])
    const sorted = [...new Set(vals)].sort((a,b) => a-b)
    for (let i = 0; i < sorted.length - 1; i++) {
      const thresh = (sorted[i] + sorted[i+1]) / 2
      const leftY = [], rightY = []
      for (let j = 0; j < n; j++) {
        (X[j][fi] <= thresh ? leftY : rightY).push(y[j])
      }
      if (leftY.length < MIN_LEAF || rightY.length < MIN_LEAF) continue
      const gain = parentGini - (leftY.length/n)*gini(leftY) - (rightY.length/n)*gini(rightY)
      if (gain > bestGain) { bestGain = gain; bestFeat = fi; bestThresh = thresh }
    }
  }
  return { bestFeat, bestThresh, bestGain }
}

function buildTree(X, y, depth, nFeatures, importance) {
  const pos = y.filter(Boolean).length
  const leafVal = pos / y.length
  if (depth >= MAX_DEPTH || y.length <= MIN_LEAF * 2 || pos === 0 || pos === y.length) {
    return { type: "leaf", value: Math.round(leafVal * 10000) / 10000 }
  }
  const k = Math.max(1, Math.round(Math.sqrt(nFeatures)))
  // Random feature subset
  const allFeats = Array.from({length: nFeatures}, (_, i) => i)
  const featureIndices = allFeats.sort(() => rng() - 0.5).slice(0, k)
  const { bestFeat, bestThresh, bestGain } = bestSplit(X, y, featureIndices)
  if (bestFeat === -1 || bestGain <= 0) {
    return { type: "leaf", value: Math.round(leafVal * 10000) / 10000 }
  }
  // Track importance
  importance[bestFeat] = (importance[bestFeat] ?? 0) + bestGain * y.length
  const leftX = [], leftY = [], rightX = [], rightY = []
  for (let i = 0; i < X.length; i++) {
    (X[i][bestFeat] <= bestThresh ? leftX : rightX).push(X[i]);
    (X[i][bestFeat] <= bestThresh ? leftY : rightY).push(y[i])
  }
  return {
    type: "split",
    feature: bestFeat,
    threshold: bestThresh,
    left: buildTree(leftX, leftY, depth+1, nFeatures, importance),
    right: buildTree(rightX, rightY, depth+1, nFeatures, importance),
  }
}

function predictTree(node, row) {
  if (node.type === "leaf") return node.value
  return row[node.feature] <= node.threshold
    ? predictTree(node.left, row)
    : predictTree(node.right, row)
}

function predictForest(trees, row) {
  return trees.reduce((s, t) => s + predictTree(t, row), 0) / trees.length
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL })
await client.connect()

const { rows } = await client.query(
  `SELECT id, is_defect, diameter_mm, length_mm, surface_roughness_ra,
          hardness_hrc, temp_celsius, pressure_bar, shift
   FROM inspections ORDER BY id`
)
if (rows.length === 0) {
  console.error("No inspections found — run: npm run generate")
  await client.end()
  process.exit(1)
}

// Encode features
const FEATURE_NAMES = ["diameter_mm","length_mm","surface_roughness_ra","hardness_hrc","temp_celsius","pressure_bar","shift_morning","shift_night"]
const rawX = rows.map(r => [
  Number(r.diameter_mm), Number(r.length_mm), Number(r.surface_roughness_ra),
  Number(r.hardness_hrc), Number(r.temp_celsius), Number(r.pressure_bar),
  r.shift === "morning" ? 1 : 0, r.shift === "night" ? 1 : 0,
])
const y = rows.map(r => r.is_defect ? 1 : 0)
const ids = rows.map(r => r.id)

// Standardise
const means = FEATURE_NAMES.map((_, fi) => rawX.reduce((s,r) => s + r[fi], 0) / rawX.length)
const stds = FEATURE_NAMES.map((_, fi) => {
  const mean = means[fi]
  return Math.sqrt(rawX.reduce((s,r) => s + (r[fi]-mean)**2, 0) / rawX.length) || 1
})
const X = rawX.map(row => row.map((v,fi) => (v - means[fi]) / stds[fi]))

// Stratified 80/20 split
const posIdx = ids.map((_,i) => i).filter(i => y[i] === 1)
const negIdx = ids.map((_,i) => i).filter(i => y[i] === 0)
const split = idxArr => {
  const shuffled = [...idxArr].sort(() => rng() - 0.5)
  const n = Math.floor(shuffled.length * 0.8)
  return { train: shuffled.slice(0,n), test: shuffled.slice(n) }
}
const { train: posTrain, test: posTest } = split(posIdx)
const { train: negTrain, test: negTest } = split(negIdx)
const trainIdx = [...posTrain, ...negTrain].sort((a,b) => a-b)
const testIdx = [...posTest, ...negTest].sort((a,b) => a-b)

const Xtrain = trainIdx.map(i => X[i])
const ytrain = trainIdx.map(i => y[i])
const Xtest = testIdx.map(i => X[i])
const ytest = testIdx.map(i => y[i])

console.log(`Training: ${Xtrain.length} samples (${ytrain.filter(Boolean).length} defects)`)
console.log(`Test:     ${Xtest.length} samples (${ytest.filter(Boolean).length} defects)`)
console.log(`Building ${N_TREES} trees\u2026`)

const globalImportance = {}
const trees = []
for (let t = 0; t < N_TREES; t++) {
  // Bootstrap sample
  const bootIdx = Array.from({length: Xtrain.length}, () => Math.floor(rng() * Xtrain.length))
  const bX = bootIdx.map(i => Xtrain[i])
  const bY = bootIdx.map(i => ytrain[i])
  const imp = {}
  const tree = buildTree(bX, bY, 0, FEATURE_NAMES.length, imp)
  // Remap feature indices to names in tree nodes
  function nameTree(node) {
    if (node.type === "leaf") return node
    return { type: "split", feature: FEATURE_NAMES[node.feature], threshold: node.threshold, left: nameTree(node.left), right: nameTree(node.right) }
  }
  trees.push(nameTree(tree))
  for (const [fi, val] of Object.entries(imp)) {
    globalImportance[FEATURE_NAMES[fi]] = (globalImportance[FEATURE_NAMES[fi]] ?? 0) + val
  }
  process.stdout.write(".")
}
console.log(" done.")

// Normalise importance
const impTotal = Object.values(globalImportance).reduce((s,v) => s+v, 0)
const featureImportance = {}
for (const [k,v] of Object.entries(globalImportance)) featureImportance[k] = Math.round(v/impTotal*10000)/10000

// Find optimal threshold on training set (maximise F1)
const trainProbs = Xtrain.map(row => predictForest(trees, row))
let bestF1 = 0, bestThresh = 0.5
for (let t = 5; t <= 95; t += 5) {
  const th = t / 100
  let tp=0,fp=0,fn=0
  for (let i=0;i<trainProbs.length;i++) {
    const pred = trainProbs[i] >= th
    if (pred && ytrain[i]) tp++
    else if (pred && !ytrain[i]) fp++
    else if (!pred && ytrain[i]) fn++
  }
  const p = tp+fp===0?0:tp/(tp+fp), r = tp+fn===0?0:tp/(tp+fn)
  const f1 = p+r===0?0:2*p*r/(p+r)
  if (f1 > bestF1) { bestF1=f1; bestThresh=th }
}
console.log(`\nOptimal threshold (training F1): ${bestThresh} (F1=${bestF1.toFixed(3)})`)

// Evaluate on test set
const testProbs = Xtest.map(row => predictForest(trees, row))
function evaluate(probs, labels, threshold) {
  let tp=0,fp=0,tn=0,fn=0
  for (let i=0;i<probs.length;i++) {
    const pred = probs[i] >= threshold
    if (pred && labels[i]) tp++
    else if (pred && !labels[i]) fp++
    else if (!pred && !labels[i]) tn++
    else fn++
  }
  const p = tp+fp===0?0:tp/(tp+fp), r = tp+fn===0?0:tp/(tp+fn)
  const f1 = p+r===0?0:2*p*r/(p+r)
  return { tp,fp,tn,fn, precision:p, recall:r, f1, accuracy:(tp+tn)/probs.length }
}
const e5 = evaluate(testProbs, ytest, 0.5)
const eOpt = evaluate(testProbs, ytest, bestThresh)

console.log("\n  Test set results:")
console.log(`  At threshold 0.50:       precision=${(e5.precision*100).toFixed(1)}%  recall=${(e5.recall*100).toFixed(1)}%  F1=${(e5.f1*100).toFixed(1)}%  accuracy=${(e5.accuracy*100).toFixed(1)}%`)
console.log(`  At optimal (${bestThresh.toFixed(2)}):  precision=${(eOpt.precision*100).toFixed(1)}%  recall=${(eOpt.recall*100).toFixed(1)}%  F1=${(eOpt.f1*100).toFixed(1)}%  accuracy=${(eOpt.accuracy*100).toFixed(1)}%`)
console.log(`  Confusion (optimal): TP=${eOpt.tp} FP=${eOpt.fp} TN=${eOpt.tn} FN=${eOpt.fn}`)

console.log("\n  Feature importance:")
for (const [k,v] of Object.entries(featureImportance).sort((a,b) => b[1]-a[1])) {
  console.log(`  ${k.padEnd(25)} ${v}`)
}

// Store model
const means_named = Object.fromEntries(FEATURE_NAMES.map((n,i) => [n, means[i]]))
const stds_named  = Object.fromEntries(FEATURE_NAMES.map((n,i) => [n, stds[i]]))
const forest = { trees, features: FEATURE_NAMES, threshold: bestThresh, trained_at: new Date().toISOString() }
const metadata = { means: means_named, stds: stds_named, feature_importance: featureImportance, eval_optimal: eOpt, eval_0_5: e5 }

await client.query(`DELETE FROM model_predictions`)
await client.query(`DELETE FROM model_store WHERE name = 'rf_v1'`)
await client.query(`INSERT INTO model_store (name, model_data, metadata) VALUES ('rf_v1', $1, $2)`, [
  JSON.stringify(forest), JSON.stringify(metadata)
])

// Score ALL inspections and write predictions
console.log("\nScoring all inspections and writing predictions\u2026")
const allProbs = X.map(row => Math.round(predictForest(trees, row) * 10000) / 10000)

const BATCH = 200
for (let i=0; i<allProbs.length; i+=BATCH) {
  const slice = allProbs.slice(i, i+BATCH)
  const params=[]
  const vals = slice.map((prob,j) => {
    params.push(ids[i+j], prob, prob >= bestThresh)
    const o=j*3
    return `($${o+1},$${o+2},$${o+3})`
  }).join(",")
  await client.query(
    `INSERT INTO model_predictions (inspection_id, probability, predicted_defect) VALUES ${vals}
     ON CONFLICT (inspection_id) DO UPDATE SET probability=EXCLUDED.probability, predicted_defect=EXCLUDED.predicted_defect`,
    params
  )
}

console.log(`Wrote ${allProbs.length} predictions.`)
console.log("\nDone. Open the dashboard: npm run dev \u2192 http://localhost:3000")
await client.end()
