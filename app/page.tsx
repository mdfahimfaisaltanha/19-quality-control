"use client"

import { useCallback, useEffect, useState } from "react"

type InspectionRow = {
  id: number
  line_name: string
  part_number: string
  inspected_at: string
  diameter_mm: number
  length_mm: number
  surface_roughness_ra: number
  hardness_hrc: number
  temp_celsius: number
  pressure_bar: number
  shift: string
  is_defect: boolean
  defect_type: string | null
}

type Summary = { total: number; defects: number; defect_rate_pct: number }

type Metrics = {
  scored: boolean
  threshold: number
  confusion: { tp: number; fp: number; tn: number; fn: number }
  metrics: { precision: number; recall: number; f1: number; accuracy: number }
  sweep: Array<{ threshold: number; precision: number; recall: number }>
  feature_importance: Record<string, number>
  defect_types: Array<{ defect_type: string; cnt: number }>
}

type SpcChart = {
  feature: string
  ucl_mean: number; lcl_mean: number; cl_mean: number
  ucl_range: number; cl_range: number
  points: Array<{ subgroup: number; mean: number; range: number; timestamp: string; out_of_control: boolean; rule_violated: string | null }>
}

type PredResult = {
  probability: number
  is_defect: boolean
  threshold: number
  attributions: Record<string, number>
}

type User = { id: number; name: string; email: string; role: string }

const DEFECT_LABELS: Record<string, string> = {
  dimensional_out_of_spec: "Dimensional",
  surface_defect: "Surface",
  hardness_failure: "Hardness",
  assembly_reject: "Assembly",
}

const SPC_FEATURES = [
  { key: "diameter_mm", label: "Diameter (mm)" },
  { key: "length_mm", label: "Length (mm)" },
  { key: "surface_roughness_ra", label: "Surface Roughness Ra (μm)" },
  { key: "hardness_hrc", label: "Hardness (HRC)" },
  { key: "temp_celsius", label: "Process Temp (°C)" },
  { key: "pressure_bar", label: "Process Pressure (bar)" },
]

function pct(v: number) { return `${(v * 100).toFixed(1)}%` }
function r3(v: number) { return Math.round(v * 1000) / 1000 }

export default function Home() {
  const [tab, setTab] = useState<"inspections" | "spc" | "model" | "predict">("inspections")
  const [user, setUser] = useState<User | null>(null)

  useEffect(() => {
    fetch("/api/auth").then(r => r.json()).then(d => setUser(d.user)).catch(() => {})
  }, [])

  return (
    <main>
      <h1>🔧 QualityGuard</h1>
      <p className="subtitle">
        Defect detection ML pipeline for Ironclad Precision Parts — random forest from scratch,
        SPC control charts, SHAP-style root-cause attribution, and a what-if inspection desk.
      </p>
      <div className="tabs">
        <button className={tab==="inspections" ? "active" : ""} onClick={() => setTab("inspections")}>📋 Inspections</button>
        <button className={tab==="spc" ? "active" : ""} onClick={() => setTab("spc")}>📊 SPC Charts</button>
        <button className={tab==="model" ? "active" : ""} onClick={() => setTab("model")}>🧠 Model metrics</button>
        <button className={tab==="predict" ? "active" : ""} onClick={() => setTab("predict")}>🔎 Predict</button>
      </div>
      {tab === "inspections" && <InspectionsTab />}
      {tab === "spc" && <SpcTab />}
      {tab === "model" && <ModelTab />}
      {tab === "predict" && <PredictTab user={user} setUser={setUser} />}
    </main>
  )
}

/* ------------------------------------------------------------------ */
/* Inspections                                                         */
/* ------------------------------------------------------------------ */
function InspectionsTab() {
  const [data, setData] = useState<{ summary: Summary; inspections: InspectionRow[] } | null>(null)
  const [defectOnly, setDefectOnly] = useState(false)

  useEffect(() => {
    fetch(`/api/inspections?defect_only=${defectOnly ? 1 : 0}&limit=200`)
      .then(r => r.json()).then(setData)
  }, [defectOnly])

  if (!data) return <div className="card"><p className="muted">Loading…</p></div>

  const { summary, inspections } = data
  return (
    <>
      <div className="stat-grid">
        <div className="stat"><div className="v">{summary.total.toLocaleString()}</div><div className="k">total inspections</div></div>
        <div className={`stat ${Number(summary.defect_rate_pct) > 10 ? "bad" : "warn"}`}>
          <div className="v">{summary.defect_rate_pct}%</div><div className="k">defect rate</div>
        </div>
        <div className="stat bad"><div className="v">{summary.defects}</div><div className="k">defective parts</div></div>
        <div className="stat good"><div className="v">{summary.total - summary.defects}</div><div className="k">passed</div></div>
      </div>
      <div className="card">
        <h2>Inspection log
          <label style={{display:"inline-flex",alignItems:"center",gap:6,marginLeft:16,fontWeight:400,fontSize:13}}>
            <input type="checkbox" checked={defectOnly} onChange={e => setDefectOnly(e.target.checked)} style={{width:"auto"}} />
            Defects only
          </label>
        </h2>
        <table>
          <thead><tr>
            <th>ID</th><th>Line</th><th>Inspected</th>
            <th>Ø mm</th><th>L mm</th><th>Ra μm</th><th>HRC</th>
            <th>Shift</th><th>Status</th><th>Defect type</th>
          </tr></thead>
          <tbody>
            {inspections.map(i => (
              <tr key={i.id} className={i.is_defect ? "defect" : ""}>
                <td className="mono">{i.id}</td>
                <td>{i.line_name}</td>
                <td className="mono">{i.inspected_at.slice(0,16)}</td>
                <td>{r3(i.diameter_mm)}</td>
                <td>{r3(i.length_mm)}</td>
                <td>{r3(i.surface_roughness_ra)}</td>
                <td>{r3(i.hardness_hrc)}</td>
                <td>{i.shift}</td>
                <td>{i.is_defect ? <span className="badge bad">DEFECT</span> : <span className="badge good">pass</span>}</td>
                <td className="muted">{i.defect_type ? (DEFECT_LABELS[i.defect_type] ?? i.defect_type) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

/* ------------------------------------------------------------------ */
/* SPC Charts                                                          */
/* ------------------------------------------------------------------ */
function SpcChartSvg({ chart }: { chart: SpcChart }) {
  const pts = chart.points
  if (pts.length < 2) return <p className="muted">Not enough subgroups for SPC.</p>
  const W = 900, H = 200, PADL = 50, PADB = 20, PADT = 10
  const vals = pts.map(p => p.mean)
  const minY = Math.min(...vals, chart.lcl_mean) * 0.998
  const maxY = Math.max(...vals, chart.ucl_mean) * 1.002
  const x = (i: number) => PADL + (i / Math.max(pts.length - 1, 1)) * (W - PADL - 10)
  const y = (v: number) => PADT + (1 - (v - minY) / (maxY - minY)) * (H - PADT - PADB)
  const line = (v: number, color: string, dash = "") => (
    <line x1={PADL} y1={y(v)} x2={W-10} y2={y(v)} stroke={color} strokeDasharray={dash} strokeWidth={1} />
  )
  const polyline = pts.map((p, i) => `${x(i)},${y(p.mean)}`).join(" ")
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`}>
      {line(chart.ucl_mean, "#e0607e", "4 3")} 
      {line(chart.cl_mean, "#10b981", "")}
      {line(chart.lcl_mean, "#e0607e", "4 3")}
      <text x={PADL-4} y={y(chart.ucl_mean)+4} fill="#e0607e" fontSize={10} textAnchor="end">UCL</text>
      <text x={PADL-4} y={y(chart.lcl_mean)+4} fill="#e0607e" fontSize={10} textAnchor="end">LCL</text>
      <text x={PADL-4} y={y(chart.cl_mean)+4} fill="#10b981" fontSize={10} textAnchor="end">CL</text>
      <polyline points={polyline} fill="none" stroke="#e9ecf2" strokeWidth={1.5} />
      {pts.map((p, i) => (
        <circle key={i} cx={x(i)} cy={y(p.mean)} r={p.out_of_control ? 5 : 3}
          fill={p.out_of_control ? "#e0607e" : "#60a5fa"} />
      ))}
    </svg>
  )
}

function SpcTab() {
  const [feature, setFeature] = useState("diameter_mm")
  const [chart, setChart] = useState<SpcChart | null>(null)

  useEffect(() => {
    fetch(`/api/inspections?spc_feature=${feature}`).then(r => r.json()).then(setChart)
  }, [feature])

  const ooc = chart?.points.filter(p => p.out_of_control) ?? []

  return (
    <div className="card">
      <h2>Statistical Process Control (X-bar chart)</h2>
      <p className="muted">Subgroup size 5. UCL/LCL at ±3σ using Shewhart A₂ constants. Red points = Western Electric rule violation (assignable cause).</p>
      <div className="form-grid" style={{maxWidth:360}}>
        <div>
          <label>Feature</label>
          <select value={feature} onChange={e => setFeature(e.target.value)}>
            {SPC_FEATURES.map(f => <option key={f.key} value={f.key}>{f.label}</option>)}
          </select>
        </div>
      </div>
      {chart && <SpcChartSvg chart={chart} />}
      {chart && (
        <div className="stat-grid">
          <div className="stat"><div className="v">{chart.points.length}</div><div className="k">subgroups</div></div>
          <div className={`stat ${ooc.length > 0 ? "bad" : "good"}`}>
            <div className="v">{ooc.length}</div><div className="k">out-of-control signals</div>
          </div>
          <div className="stat"><div className="v">{r3(chart.cl_mean)}</div><div className="k">centre line (X̄̄)</div></div>
          <div className="stat"><div className="v">{r3(chart.ucl_mean)} / {r3(chart.lcl_mean)}</div><div className="k">UCL / LCL</div></div>
        </div>
      )}
      {ooc.length > 0 && (
        <>
          <h3 style={{marginTop:12}}>Out-of-control signals</h3>
          <table>
            <thead><tr><th>Subgroup</th><th>Timestamp</th><th>Mean</th><th>Rule violated</th></tr></thead>
            <tbody>
              {ooc.map(p => (
                <tr key={p.subgroup}>
                  <td>{p.subgroup}</td>
                  <td className="mono">{String(p.timestamp).slice(0,16)}</td>
                  <td>{r3(p.mean)}</td>
                  <td className="muted">{p.rule_violated}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Model metrics                                                       */
/* ------------------------------------------------------------------ */
function ModelTab() {
  const [data, setData] = useState<Metrics | null>(null)
  const [threshold, setThreshold] = useState(0.5)

  useEffect(() => {
    fetch(`/api/metrics?threshold=${threshold}`).then(r => r.json()).then(setData)
  }, [threshold])

  if (!data) return <div className="card"><p className="muted">Loading…</p></div>
  if (!data.scored) return (
    <div className="card">
      <p className="muted">No model predictions yet — run <code>npm run train</code>, then refresh.</p>
    </div>
  )

  const { confusion: c, metrics: m, feature_importance: fi, sweep, defect_types } = data
  const fiEntries = Object.entries(fi).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
  const maxFi = Math.max(...fiEntries.map(e => Math.abs(e[1])), 0.001)
  const totalDefects = defect_types.reduce((s, r) => s + r.cnt, 0)

  // PR curve
  const W = 300, H = 200
  const prPts = sweep.map((s, i) => `${Math.round(s.precision * W)},${Math.round((1 - s.recall) * H)}`).join(" ")

  return (
    <>
      <div className="card">
        <h2>Model performance — Random Forest (50 trees, from scratch)</h2>
        <p className="muted">Threshold slider adjusts the classification cut-off on held-out test predictions. Push it high for fewer false alarms; push it low to catch more defects — the precision/recall trade-off priced in real confusion matrix cells.</p>
        <label style={{marginTop:8,marginBottom:12,display:"block"}}>
          Classification threshold: <strong>{threshold.toFixed(2)}</strong>
          <input type="range" min={0.05} max={0.95} step={0.05} value={threshold}
            onChange={e => setThreshold(Number(e.target.value))}
            style={{width:"100%",marginTop:6}} />
        </label>
        <div className="stat-grid">
          <div className="stat accent"><div className="v">{pct(m.precision)}</div><div className="k">precision (TP / TP+FP)</div></div>
          <div className="stat good"><div className="v">{pct(m.recall)}</div><div className="k">recall / sensitivity (TP / TP+FN)</div></div>
          <div className="stat"><div className="v">{pct(m.f1)}</div><div className="k">F1 score</div></div>
          <div className="stat"><div className="v">{pct(m.accuracy)}</div><div className="k">accuracy</div></div>
        </div>
        <h3>Confusion matrix</h3>
        <table style={{maxWidth:340}}>
          <thead><tr><th></th><th>Predicted pass</th><th>Predicted defect</th></tr></thead>
          <tbody>
            <tr><td><strong>Actual pass</strong></td><td className="mono" style={{color:"var(--good)"}}>{c.tn} TN</td><td className="mono" style={{color:"var(--bad)"}}>{c.fp} FP</td></tr>
            <tr><td><strong>Actual defect</strong></td><td className="mono" style={{color:"var(--bad)"}}>{c.fn} FN</td><td className="mono" style={{color:"var(--good)"}}>{c.tp} TP</td></tr>
          </tbody>
        </table>
      </div>

      <div className="card">
        <h2>Feature importance (mean Gini decrease)</h2>
        <p className="muted">Which measurement best separates defect from pass across all 50 trees.</p>
        {fiEntries.map(([feat, imp]) => (
          <div key={feat} style={{marginBottom:8}}>
            <div style={{display:"flex",justifyContent:"space-between",marginBottom:3}}>
              <span>{feat.replace(/_/g," ")}</span>
              <span className="muted">{r3(imp)}</span>
            </div>
            <div className="bar-wrap">
              <div className="bar-track"><div className="bar-fill" style={{width:`${(Math.abs(imp)/maxFi)*100}%`}} /></div>
            </div>
          </div>
        ))}
      </div>

      <div className="card">
        <h2>Defect type breakdown</h2>
        {defect_types.map(d => (
          <div key={d.defect_type} style={{marginBottom:8}}>
            <div style={{display:"flex",justifyContent:"space-between",marginBottom:3}}>
              <span>{d.defect_type.replace(/_/g," ")}</span>
              <span className="muted">{d.cnt} ({totalDefects > 0 ? Math.round(d.cnt/totalDefects*100) : 0}%)</span>
            </div>
            <div className="bar-wrap">
              <div className="bar-track"><div className="bar-fill warn" style={{width:`${(d.cnt/Math.max(totalDefects,1))*100}%`}} /></div>
            </div>
          </div>
        ))}
      </div>
    </>
  )
}

/* ------------------------------------------------------------------ */
/* Predict (what-if desk)                                              */
/* ------------------------------------------------------------------ */
function PredictTab({ user, setUser }: { user: User | null; setUser: (u: User | null) => void }) {
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [loginError, setLoginError] = useState("")

  const [form, setForm] = useState({
    diameter_mm: "25.08", length_mm: "80.21", surface_roughness_ra: "2.1",
    hardness_hrc: "56.2", temp_celsius: "198", pressure_bar: "8.5", shift: "night"
  })
  const [result, setResult] = useState<PredResult | null>(null)
  const [error, setError] = useState("")

  const login = async () => {
    setLoginError("")
    const res = await fetch("/api/auth", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) })
    const d = await res.json()
    if (!res.ok) { setLoginError(d.error ?? "Login failed"); return }
    setUser(d.user)
  }

  const run = async () => {
    setError(""); setResult(null)
    const res = await fetch("/api/predict", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...form, diameter_mm: Number(form.diameter_mm), length_mm: Number(form.length_mm), surface_roughness_ra: Number(form.surface_roughness_ra), hardness_hrc: Number(form.hardness_hrc), temp_celsius: Number(form.temp_celsius), pressure_bar: Number(form.pressure_bar) }) })
    const d = await res.json()
    if (!res.ok) { setError(d.error ?? "Prediction failed"); return }
    setResult(d)
  }

  if (!user) return (
    <div className="card">
      <h2>Sign in to use the prediction desk</h2>
      <p className="muted">Seeded accounts: <code>inspector@ironclad.test</code> / <code>manager@ironclad.test</code> with your <code>SEED_PASSWORD</code> (default <code>ChangeMe123!</code>).</p>
      <label>Email</label>
      <input value={email} onChange={e => setEmail(e.target.value)} placeholder="inspector@ironclad.test" style={{marginBottom:10}} />
      <label>Password</label>
      <input type="password" value={password} onChange={e => setPassword(e.target.value)} style={{marginBottom:10}} />
      {loginError && <p className="err-text">{loginError}</p>}
      <button className="primary" onClick={login}>Sign in</button>
    </div>
  )

  const attrs = result ? Object.entries(result.attributions).sort((a,b) => Math.abs(b[1]) - Math.abs(a[1])) : []
  const maxAttr = Math.max(...attrs.map(e => Math.abs(e[1])), 0.001)

  return (
    <div className="card">
      <h2>What-if prediction desk</h2>
      <p className="muted">Enter part measurements. The model scores defect probability and attributes the decision to each feature using perturbation-based attribution (SHAP-style). Default values are set to a suspicious part — high Ra, low HRC, night shift.</p>
      <div className="form-grid">
        {Object.entries(form).filter(([k]) => k !== "shift").map(([key, val]) => (
          <div key={key}>
            <label>{key.replace(/_/g," ")}</label>
            <input value={val} onChange={e => setForm(f => ({...f, [key]: e.target.value}))} />
          </div>
        ))}
        <div>
          <label>Shift</label>
          <select value={form.shift} onChange={e => setForm(f => ({...f, shift: e.target.value}))}>
            <option value="morning">Morning</option>
            <option value="afternoon">Afternoon</option>
            <option value="night">Night</option>
          </select>
        </div>
      </div>
      {error && <div className="error-box">{error}</div>}
      <button className="primary" onClick={run}>Run prediction</button>

      {result && (
        <>
          <div className="stat-grid" style={{marginTop:16}}>
            <div className={`stat ${result.is_defect ? "bad" : "good"}`}>
              <div className="v">{result.is_defect ? "DEFECT" : "PASS"}</div>
              <div className="k">prediction (threshold {result.threshold})</div>
            </div>
            <div className={`stat ${result.probability > 0.7 ? "bad" : result.probability > 0.4 ? "warn" : "good"}`}>
              <div className="v">{pct(result.probability)}</div>
              <div className="k">defect probability</div>
            </div>
          </div>
          <h3 style={{marginTop:12}}>Feature attributions (SHAP-style perturbation)</h3>
          <p className="muted" style={{marginBottom:10}}>Positive = pushes toward defect. Negative = pushes toward pass. Each value is the probability change when this feature is perturbed to its training mean.</p>
          {attrs.map(([feat, val]) => (
            <div key={feat} style={{marginBottom:8}}>
              <div style={{display:"flex",justifyContent:"space-between",marginBottom:3}}>
                <span>{feat.replace(/_/g," ")}</span>
                <span className={val > 0 ? "" : "muted"} style={val > 0 ? {color:"var(--bad)"} : {color:"var(--good)"}}>{val > 0 ? "+" : ""}{val}</span>
              </div>
              <div className="bar-wrap">
                <div className="bar-track">
                  <div className={`bar-fill ${val > 0 ? "bad" : ""}`} style={{width:`${(Math.abs(val)/maxAttr)*100}%`}} />
                </div>
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  )
}
