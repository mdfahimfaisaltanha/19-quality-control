// Statistical Process Control (SPC) helpers.
//
// X-bar and R charts with 3-sigma control limits.
// Control limits:
//   UCL_xbar = X-double-bar + A2 * R-bar
//   LCL_xbar = X-double-bar - A2 * R-bar
//   UCL_R    = D4 * R-bar
//   LCL_R    = D3 * R-bar (= 0 for n < 7)
//
// A2, D3, D4 are the standard Shewhart control chart constants for subgroup size n.
// Source: ASTM STP 15D / Montgomery "Introduction to Statistical Quality Control".
//
// Western Electric rules implemented:
//   Rule 1: 1 point beyond 3σ (UCL or LCL)
//   Rule 2: 2 of 3 consecutive points beyond 2σ on the same side
//   Rule 3: 4 of 5 consecutive points beyond 1σ on the same side
//   Rule 4: 8 consecutive points on the same side of the centre line
//
// These rules flag assignable (special) causes vs common-cause variation.

type SpcPoint = {
  subgroup: number
  mean: number
  range: number
  timestamp: string
  out_of_control: boolean
  rule_violated: string | null
}

type SpcChart = {
  feature: string
  ucl_mean: number
  lcl_mean: number
  cl_mean: number
  ucl_range: number
  cl_range: number
  points: SpcPoint[]
}

const CONSTANTS: Record<number, { A2: number; D3: number; D4: number }> = {
  2: { A2: 1.88, D3: 0, D4: 3.267 },
  3: { A2: 1.023, D3: 0, D4: 2.574 },
  4: { A2: 0.729, D3: 0, D4: 2.282 },
  5: { A2: 0.577, D3: 0, D4: 2.114 },
  6: { A2: 0.483, D3: 0, D4: 2.004 },
  7: { A2: 0.419, D3: 0.076, D4: 1.924 },
  8: { A2: 0.373, D3: 0.136, D4: 1.864 },
  10: { A2: 0.308, D3: 0.223, D4: 1.777 },
}

function nearest(n: number): { A2: number; D3: number; D4: number } {
  const keys = Object.keys(CONSTANTS)
    .map(Number)
    .sort((a, b) => a - b)
  for (let i = keys.length - 1; i >= 0; i--) {
    if (n >= keys[i]) return CONSTANTS[keys[i]]
  }
  return CONSTANTS[2]
}

export function buildSpcChart(
  feature: string,
  observations: Array<{ value: number; timestamp: string }>,
  subgroupSize = 5,
): SpcChart {
  const subgroups: Array<{ values: number[]; timestamp: string }> = []
  for (let i = 0; i + subgroupSize <= observations.length; i += subgroupSize) {
    const slice = observations.slice(i, i + subgroupSize)
    subgroups.push({ values: slice.map((o) => o.value), timestamp: slice[0].timestamp })
  }
  if (subgroups.length < 4) {
    // Not enough data for meaningful limits
    return { feature, ucl_mean: 0, lcl_mean: 0, cl_mean: 0, ucl_range: 0, cl_range: 0, points: [] }
  }

  const means = subgroups.map((g) => g.values.reduce((s, v) => s + v, 0) / g.values.length)
  const ranges = subgroups.map((g) => Math.max(...g.values) - Math.min(...g.values))

  const xBarBar = means.reduce((s, v) => s + v, 0) / means.length
  const rBar = ranges.reduce((s, v) => s + v, 0) / ranges.length
  const c = nearest(subgroupSize)

  const uclMean = xBarBar + c.A2 * rBar
  const lclMean = xBarBar - c.A2 * rBar
  const uclRange = c.D4 * rBar
  const lclRange = c.D3 * rBar
  const sigma = (c.A2 * rBar) / 3 // 1-sigma from A2 definition

  const points: SpcPoint[] = means.map((mean, i) => {
    let rule: string | null = null

    // Rule 1: beyond 3σ
    if (mean > uclMean || mean < lclMean) rule = "Rule 1: beyond 3σ"

    // Rule 2: 2 of 3 consecutive beyond 2σ on the same side
    if (!rule && i >= 2) {
      const window = [means[i - 2], means[i - 1], mean]
      const aboveTwo = window.filter((v) => v > xBarBar + 2 * sigma).length
      const belowTwo = window.filter((v) => v < xBarBar - 2 * sigma).length
      if (aboveTwo >= 2 || belowTwo >= 2) rule = "Rule 2: 2 of 3 beyond 2σ"
    }

    // Rule 3: 4 of 5 consecutive beyond 1σ on the same side
    if (!rule && i >= 4) {
      const window = [means[i - 4], means[i - 3], means[i - 2], means[i - 1], mean]
      const aboveOne = window.filter((v) => v > xBarBar + sigma).length
      const belowOne = window.filter((v) => v < xBarBar - sigma).length
      if (aboveOne >= 4 || belowOne >= 4) rule = "Rule 3: 4 of 5 beyond 1σ"
    }

    // Rule 4: 8 consecutive on the same side
    if (!rule && i >= 7) {
      const window = [means[i - 7], means[i - 6], means[i - 5], means[i - 4], means[i - 3], means[i - 2], means[i - 1], mean]
      if (window.every((v) => v > xBarBar) || window.every((v) => v < xBarBar))
        rule = "Rule 4: 8 consecutive same side"
    }

    return {
      subgroup: i + 1,
      mean: Math.round(mean * 10000) / 10000,
      range: Math.round(ranges[i] * 10000) / 10000,
      timestamp: subgroups[i].timestamp,
      out_of_control: rule !== null,
      rule_violated: rule,
    }
  })

  return {
    feature,
    ucl_mean: Math.round(uclMean * 10000) / 10000,
    lcl_mean: Math.round(lclMean * 10000) / 10000,
    cl_mean: Math.round(xBarBar * 10000) / 10000,
    ucl_range: Math.round(uclRange * 10000) / 10000,
    cl_range: Math.round(lclRange * 10000) / 10000,
    points,
  }
}
