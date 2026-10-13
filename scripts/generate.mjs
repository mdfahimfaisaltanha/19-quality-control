// Synthetic inspection data generator — 2000 records across 4 production lines.
//
// Defect causes (realistic, distinct, model-learnable):
//   dimensional_out_of_spec  — diameter or length beyond tolerance (± multiplier)
//   surface_defect           — Ra > 2.5 μm (surface roughness too high)
//   hardness_failure         — HRC outside 58–62 (heat-treat problem)
//   assembly_reject          — combination of minor deviations that stack up
//
// Overall defect rate ~8-10% (realistic for precision machining).
// Night shift has 1.4x higher defect probability (operator fatigue).
// Material batch "B22" is a bad batch (1.6x higher defect probability).
// Line C (small pins) has tighter tolerance — inherently harder to hit.
//
// Seed: DATA_SEED (default 42). Deterministic, reproducible.

import { readFileSync } from "node:fs"
import pg from "pg"

try {
  const env = readFileSync(new URL("../.env.local", import.meta.url), "utf8")
  for (const line of env.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
  }
} catch {}

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set.")
  process.exit(1)
}

const SEED = Number(process.env.DATA_SEED || 42)
function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5)
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const rng = mulberry32(SEED)
function gaussian(mean, std) {
  const u1 = Math.max(rng(), 1e-9)
  return mean + std * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * rng())
}
function pick(arr) { return arr[Math.floor(rng() * arr.length)] }

const N = 2000
const SHIFTS = ["morning", "afternoon", "night"]
const BATCHES = ["A21", "A22", "B21", "B22", "C21", "C22"]
const BAD_BATCH = "B22"

const client = new pg.Client({ connectionString: process.env.DATABASE_URL })
await client.connect()

const already = await client.query(`SELECT count(*)::int AS n FROM inspections`)
if (already.rows[0].n > 0) {
  console.log(`inspections already has ${already.rows[0].n} rows — refusing to double-generate.`)
  console.log(`To regenerate: TRUNCATE model_predictions, inspections RESTART IDENTITY;`)
  await client.end()
  process.exit(0)
}

const { rows: lines } = await client.query(`SELECT * FROM production_lines ORDER BY id`)
if (lines.length === 0) {
  console.error("No production lines — run: npm run setup")
  await client.end()
  process.exit(1)
}

const startDate = new Date()
startDate.setDate(startDate.getDate() - 60)

console.log(`Seed ${SEED}: generating ${N} inspection records across ${lines.length} lines\u2026`)

const records = []
for (let i = 0; i < N; i++) {
  const line = pick(lines)
  const shift = pick(SHIFTS)
  const batch = pick(BATCHES)
  const operatorId = Math.floor(rng() * 8) + 1
  const inspectedAt = new Date(startDate.getTime() + (i / N) * 60 * 86400_000)

  // Base measurements with noise
  let diam = gaussian(Number(line.nominal_diameter), 0.02)
  let len = gaussian(Number(line.nominal_length), 0.04)
  let ra = Math.max(0.2, gaussian(1.2, 0.25))
  let hrc = gaussian(60, 0.8)
  let temp = gaussian(195, 4)
  let pressure = gaussian(8.0, 0.3)

  // Defect probability base
  let defectProb = 0.07
  if (shift === "night") defectProb *= 1.4
  if (batch === BAD_BATCH) defectProb *= 1.6
  // Line C tighter tolerance
  if (line.name.includes("Pins")) defectProb *= 1.25

  const isDefect = rng() < defectProb
  let defectType = null

  if (isDefect) {
    const r = rng()
    if (r < 0.3) {
      defectType = "dimensional_out_of_spec"
      // Push diameter or length outside tolerance
      if (rng() < 0.5) diam += (rng() < 0.5 ? 1 : -1) * (Number(line.tolerance_diameter) * (1.2 + rng()))
      else len += (rng() < 0.5 ? 1 : -1) * (Number(line.tolerance_length) * (1.2 + rng()))
    } else if (r < 0.55) {
      defectType = "surface_defect"
      ra = 2.5 + rng() * 2.5  // Ra 2.5–5.0 μm
    } else if (r < 0.78) {
      defectType = "hardness_failure"
      hrc = rng() < 0.5 ? gaussian(54, 1.5) : gaussian(65, 1.5)  // too soft or too hard
    } else {
      defectType = "assembly_reject"
      // Multiple small deviations that stack up
      diam += (rng() < 0.5 ? 1 : -1) * Number(line.tolerance_diameter) * 0.8
      ra += 0.5 + rng() * 0.8
      hrc += (rng() < 0.5 ? 1 : -1) * 2
    }
  }

  records.push([
    line.id, line.part_number, inspectedAt.toISOString(),
    Math.round(diam * 10000) / 10000,
    Math.round(len * 10000) / 10000,
    Math.round(ra * 10000) / 10000,
    Math.round(hrc * 100) / 100,
    Math.round(temp * 100) / 100,
    Math.round(pressure * 1000) / 1000,
    shift, operatorId, batch, isDefect, defectType
  ])
}

// Batch insert
const BATCH_SIZE = 100
for (let i = 0; i < records.length; i += BATCH_SIZE) {
  const batch = records.slice(i, i + BATCH_SIZE)
  const params = []
  const values = batch.map((r, j) => {
    params.push(...r)
    const o = j * 14
    return `($${o+1},$${o+2},$${o+3}::timestamptz,$${o+4},$${o+5},$${o+6},$${o+7},$${o+8},$${o+9},$${o+10},$${o+11},$${o+12},$${o+13},$${o+14})`
  }).join(",")
  await client.query(
    `INSERT INTO inspections (production_line_id,part_number,inspected_at,diameter_mm,length_mm,surface_roughness_ra,hardness_hrc,temp_celsius,pressure_bar,shift,operator_id,material_batch,is_defect,defect_type) VALUES ${values}`,
    params
  )
}

const { rows: summary } = await client.query(
  `SELECT count(*)::int AS total, count(*) FILTER (WHERE is_defect)::int AS defects,
          round(count(*) FILTER (WHERE is_defect)::numeric / count(*)::numeric * 100, 1) AS rate
   FROM inspections`
)
console.log(`\nGenerated ${summary[0].total} inspections: ${summary[0].defects} defects (${summary[0].rate}% defect rate)`)
console.log(`\nBreakdown by shift:`)
const { rows: byShift } = await client.query(
  `SELECT shift, count(*)::int AS n, count(*) FILTER (WHERE is_defect)::int AS def FROM inspections GROUP BY shift ORDER BY shift`
)
for (const r of byShift) console.log(`  ${r.shift.padEnd(12)} ${r.n} total, ${r.def} defects (${Math.round(r.def/r.n*100)}%)`)

console.log(`\nNext: npm run train`)
await client.end()
