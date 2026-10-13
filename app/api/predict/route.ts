import { NextRequest, NextResponse } from "next/server"
import { pool } from "@/lib/db"
import { getSession } from "@/lib/auth"
import type { TreeNode, ForestModel } from "@/lib/types"

function traverseTree(node: TreeNode, features: Record<string, number>): number {
  if (node.type === "leaf") return node.value
  const val = features[node.feature] ?? 0
  return val <= node.threshold
    ? traverseTree(node.left, features)
    : traverseTree(node.right, features)
}

function predict(
  forest: ForestModel,
  features: Record<string, number>,
): { probability: number; attributions: Record<string, number> } {
  const votes = forest.trees.map((t) => traverseTree(t, features))
  const probability = votes.reduce((s, v) => s + v, 0) / votes.length

  // Attribution: perturb each feature, measure probability delta.
  // Simple but transparent: the impact is the mean change across all trees when
  // this feature is set to its mean vs its actual value.
  const attributions: Record<string, number> = {}
  for (const feat of forest.features) {
    const perturbed = { ...features, [feat]: 0 } // baseline = 0 (features are z-scored in training)
    const pertVotes = forest.trees.map((t) => traverseTree(t, perturbed))
    const pertProb = pertVotes.reduce((s, v) => s + v, 0) / pertVotes.length
    attributions[feat] = Math.round((probability - pertProb) * 1000) / 1000
  }

  return { probability: Math.round(probability * 10000) / 10000, attributions }
}

export async function POST(req: NextRequest) {
  const user = await getSession()
  if (!user) return NextResponse.json({ error: "Authentication required" }, { status: 401 })

  const body = await req.json()
  const { diameter_mm, length_mm, surface_roughness_ra, hardness_hrc, temp_celsius, pressure_bar, shift } = body

  // Validate
  const required = ["diameter_mm", "length_mm", "surface_roughness_ra", "hardness_hrc", "temp_celsius", "pressure_bar", "shift"]
  for (const k of required) {
    if (body[k] === undefined || body[k] === null || body[k] === "")
      return NextResponse.json({ error: `Missing required field: ${k}` }, { status: 422 })
  }

  // Load model
  const { rows } = await pool.query(
    `SELECT model_data, metadata FROM model_store WHERE name = 'rf_v1' ORDER BY created_at DESC LIMIT 1`,
  )
  if (rows.length === 0)
    return NextResponse.json({ error: "No trained model found — run: npm run train" }, { status: 409 })

  const forest = rows[0].model_data as ForestModel
  const meta = rows[0].metadata as { means: Record<string, number>; stds: Record<string, number> }

  // Encode shift as numbers (one-hot: morning=0/1, night=0/1; afternoon is reference)
  const rawFeatures: Record<string, number> = {
    diameter_mm: Number(diameter_mm),
    length_mm: Number(length_mm),
    surface_roughness_ra: Number(surface_roughness_ra),
    hardness_hrc: Number(hardness_hrc),
    temp_celsius: Number(temp_celsius),
    pressure_bar: Number(pressure_bar),
    shift_morning: shift === "morning" ? 1 : 0,
    shift_night: shift === "night" ? 1 : 0,
  }

  // Standardise using training set means/stds
  const features: Record<string, number> = {}
  for (const [k, v] of Object.entries(rawFeatures)) {
    const mean = meta.means[k] ?? 0
    const std = meta.stds[k] ?? 1
    features[k] = std === 0 ? 0 : (v - mean) / std
  }

  const result = predict(forest, features)
  const is_defect = result.probability >= forest.threshold

  return NextResponse.json({
    probability: result.probability,
    is_defect,
    threshold: forest.threshold,
    attributions: result.attributions,
    inputs: { diameter_mm, length_mm, surface_roughness_ra, hardness_hrc, temp_celsius, pressure_bar, shift },
  })
}
