import { NextRequest, NextResponse } from "next/server"
import { pool } from "@/lib/db"

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const threshold = Math.max(0, Math.min(1, Number(searchParams.get("threshold") || 0.5)))

  // Pull stored model predictions
  const { rows: preds } = await pool.query(
    `SELECT i.is_defect AS actual, mp.probability
     FROM model_predictions mp JOIN inspections i ON i.id = mp.inspection_id`,
  )
  if (preds.length === 0)
    return NextResponse.json({ scored: false, results: [] })

  // Confusion matrix at this threshold
  let tp = 0, fp = 0, tn = 0, fn = 0
  for (const p of preds) {
    const predicted = p.probability >= threshold
    if (predicted && p.actual) tp++
    else if (predicted && !p.actual) fp++
    else if (!predicted && !p.actual) tn++
    else fn++
  }
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp)
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn)
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall)
  const accuracy = (tp + tn) / preds.length

  // Threshold sweep 5% – 95% step 5
  const sweep = []
  for (let t = 0.05; t <= 0.95; t += 0.05) {
    let stp = 0, sfp = 0, sfn = 0
    for (const p of preds) {
      const predicted = p.probability >= t
      if (predicted && p.actual) stp++
      else if (predicted && !p.actual) sfp++
      else if (!predicted && p.actual) sfn++
    }
    const sp = stp + sfp === 0 ? 0 : stp / (stp + sfp)
    const sr = stp + sfn === 0 ? 0 : stp / (stp + sfn)
    sweep.push({ threshold: Math.round(t * 100) / 100, precision: sp, recall: sr })
  }

  // Feature importance from trained model
  const { rows: model } = await pool.query(
    `SELECT metadata FROM model_store WHERE name = 'rf_v1' ORDER BY created_at DESC LIMIT 1`,
  )
  const featureImportance: Record<string, number> = model[0]?.metadata?.feature_importance ?? {}

  // Defect type breakdown
  const { rows: dtypes } = await pool.query(
    `SELECT defect_type, count(*)::int AS cnt FROM inspections WHERE is_defect GROUP BY defect_type ORDER BY cnt DESC`,
  )

  return NextResponse.json({
    scored: true,
    threshold,
    confusion: { tp, fp, tn, fn },
    metrics: {
      precision: Math.round(precision * 10000) / 10000,
      recall: Math.round(recall * 10000) / 10000,
      f1: Math.round(f1 * 10000) / 10000,
      accuracy: Math.round(accuracy * 10000) / 10000,
    },
    sweep,
    feature_importance: featureImportance,
    defect_types: dtypes,
  })
}
