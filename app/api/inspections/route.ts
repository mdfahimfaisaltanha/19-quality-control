import { NextRequest, NextResponse } from "next/server"
import { pool } from "@/lib/db"
import { buildSpcChart } from "@/lib/spc"

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const lineId = searchParams.get("line_id")
  const defectOnly = searchParams.get("defect_only") === "1"
  const feature = searchParams.get("spc_feature") // e.g. "diameter_mm"
  const limit = Math.min(Number(searchParams.get("limit") || 200), 2000)

  // SPC chart mode
  if (feature) {
    const allowed = ["diameter_mm", "length_mm", "surface_roughness_ra", "hardness_hrc", "temp_celsius", "pressure_bar"]
    if (!allowed.includes(feature))
      return NextResponse.json({ error: `Unknown feature. Allowed: ${allowed.join(", ")}` }, { status: 400 })

    const q = lineId
      ? `SELECT ${feature} AS value, inspected_at AS timestamp FROM inspections WHERE production_line_id = $1 ORDER BY inspected_at LIMIT 1000`
      : `SELECT ${feature} AS value, inspected_at AS timestamp FROM inspections ORDER BY inspected_at LIMIT 1000`
    const { rows } = lineId ? await pool.query(q, [lineId]) : await pool.query(q)
    const obs = rows.map((r) => ({ value: Number(r.value), timestamp: r.timestamp }))
    return NextResponse.json(buildSpcChart(feature, obs, 5))
  }

  // List mode
  const conditions: string[] = []
  const params: unknown[] = []
  if (lineId) { conditions.push(`i.production_line_id = $${params.length + 1}`); params.push(lineId) }
  if (defectOnly) conditions.push("i.is_defect = true")
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""

  const { rows } = await pool.query(
    `SELECT i.id, i.production_line_id, pl.name AS line_name, i.part_number,
            to_char(i.inspected_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS inspected_at,
            i.diameter_mm, i.length_mm, i.surface_roughness_ra, i.hardness_hrc,
            i.temp_celsius, i.pressure_bar, i.shift, i.operator_id,
            i.material_batch, i.is_defect, i.defect_type
     FROM inspections i JOIN production_lines pl ON pl.id = i.production_line_id
     ${where}
     ORDER BY i.inspected_at DESC
     LIMIT $${params.length + 1}`,
    [...params, limit],
  )

  const summary = await pool.query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE is_defect)::int AS defects,
            round(count(*) FILTER (WHERE is_defect)::numeric / count(*)::numeric * 100, 2) AS defect_rate_pct
     FROM inspections`,
  )

  return NextResponse.json({ summary: summary.rows[0], inspections: rows })
}
