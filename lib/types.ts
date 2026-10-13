export type DefectType =
  | "dimensional_out_of_spec"
  | "surface_defect"
  | "hardness_failure"
  | "assembly_reject"

export type Shift = "morning" | "afternoon" | "night"

export type Inspection = {
  id: number
  production_line_id: number
  line_name: string
  part_number: string
  inspected_at: string
  // Measured features
  diameter_mm: number       // nominal 25.00 mm
  length_mm: number         // nominal 80.00 mm
  surface_roughness_ra: number // Ra in μm, target ≤ 1.6
  hardness_hrc: number      // Rockwell C, target 58–62
  temp_celsius: number      // process temperature
  pressure_bar: number      // process pressure
  shift: Shift
  operator_id: number
  material_batch: string
  // Labels
  is_defect: boolean
  defect_type: DefectType | null
}

export type ProductionLine = {
  id: number
  name: string
  part_number: string
  nominal_diameter: number
  nominal_length: number
  tolerance_diameter: number // ± mm
  tolerance_length: number   // ± mm
}

export type TreeNode =
  | { type: "leaf"; value: number }  // probability of defect
  | { type: "split"; feature: string; threshold: number; left: TreeNode; right: TreeNode }

export type ForestModel = {
  trees: TreeNode[]
  features: string[]
  threshold: number  // default classification threshold
  trained_at: string
}

export type PredictionResult = {
  probability: number
  is_defect: boolean
  attributions: Record<string, number> // feature -> contribution score
}

export type SpcPoint = {
  subgroup: number
  mean: number
  range: number
  timestamp: string
  out_of_control: boolean
  rule_violated: string | null
}

export type SpcChart = {
  feature: string
  ucl_mean: number
  lcl_mean: number
  cl_mean: number
  ucl_range: number
  cl_range: number
  points: SpcPoint[]
}
