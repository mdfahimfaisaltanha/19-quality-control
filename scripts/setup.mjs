// Idempotent schema + seed for QualityGuard.
// Usage: npm run setup  (then: npm run generate, npm run train)

import { readFileSync } from "node:fs"
import { randomBytes, scryptSync } from "node:crypto"
import pg from "pg"

try {
  const env = readFileSync(new URL("../.env.local", import.meta.url), "utf8")
  for (const line of env.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
  }
} catch {}

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set. Copy .env.example to .env.local and fill it in.")
  process.exit(1)
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL })
await client.connect()

function hashPassword(password) {
  const salt = randomBytes(16)
  const hash = scryptSync(password, salt, 32, { N: 16384 })
  return `scrypt:${salt.toString("hex")}:${hash.toString("hex")}`
}

console.log("Creating schema (idempotent)\u2026")

await client.query(`
  CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    role TEXT NOT NULL CHECK (role IN ('inspector','manager')),
    password_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS users_sessions (
    token TEXT PRIMARY KEY,
    user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS production_lines (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    part_number TEXT NOT NULL,
    nominal_diameter NUMERIC(8,4) NOT NULL,
    nominal_length NUMERIC(8,4) NOT NULL,
    tolerance_diameter NUMERIC(6,4) NOT NULL,
    tolerance_length NUMERIC(6,4) NOT NULL
  );

  CREATE TABLE IF NOT EXISTS inspections (
    id SERIAL PRIMARY KEY,
    production_line_id INT NOT NULL REFERENCES production_lines(id),
    part_number TEXT NOT NULL,
    inspected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    diameter_mm NUMERIC(10,4) NOT NULL,
    length_mm NUMERIC(10,4) NOT NULL,
    surface_roughness_ra NUMERIC(8,4) NOT NULL,
    hardness_hrc NUMERIC(6,2) NOT NULL,
    temp_celsius NUMERIC(7,2) NOT NULL,
    pressure_bar NUMERIC(7,3) NOT NULL,
    shift TEXT NOT NULL CHECK (shift IN ('morning','afternoon','night')),
    operator_id INT NOT NULL,
    material_batch TEXT NOT NULL,
    is_defect BOOLEAN NOT NULL DEFAULT false,
    defect_type TEXT CHECK (defect_type IN ('dimensional_out_of_spec','surface_defect','hardness_failure','assembly_reject'))
  );

  CREATE INDEX IF NOT EXISTS idx_inspections_line ON inspections(production_line_id);
  CREATE INDEX IF NOT EXISTS idx_inspections_defect ON inspections(is_defect);
  CREATE INDEX IF NOT EXISTS idx_inspections_at ON inspections(inspected_at);

  CREATE TABLE IF NOT EXISTS model_predictions (
    id SERIAL PRIMARY KEY,
    inspection_id INT NOT NULL REFERENCES inspections(id) UNIQUE,
    probability REAL NOT NULL,
    predicted_defect BOOLEAN NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS model_store (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    model_data JSONB NOT NULL,
    metadata JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
`)

// ---- users -----------------------------------------------------------------
const { rows: existingUsers } = await client.query(`SELECT count(*)::int AS n FROM users`)
if (existingUsers[0].n > 0) {
  console.log("Users already seeded \u2014 skipping.")
} else {
  const password = process.env.SEED_PASSWORD || "ChangeMe123!"
  const users = [
    { name: "Asel Nurlanovna", email: "inspector@ironclad.test", role: "inspector" },
    { name: "Omar Farouk", email: "manager@ironclad.test", role: "manager" },
  ]
  for (const u of users) {
    await client.query(
      `INSERT INTO users (name, email, role, password_hash) VALUES ($1, $2, $3, $4)`,
      [u.name, u.email, u.role, hashPassword(password)]
    )
  }
  console.log(`Seeded ${users.length} users (password = SEED_PASSWORD, default ChangeMe123!)`)
  for (const u of users) console.log(`  ${u.email}  (${u.role})`)
}

// ---- production lines -----------------------------------------------------
const { rows: existingLines } = await client.query(`SELECT count(*)::int AS n FROM production_lines`)
if (existingLines[0].n > 0) {
  console.log("Production lines already seeded \u2014 skipping.")
} else {
  const lines = [
    { name: "Line A \u2014 Shafts",    part: "IPC-SH-25", diam: 25.0, len: 80.0, tolD: 0.05, tolL: 0.1 },
    { name: "Line B \u2014 Bushings",  part: "IPC-BU-32", diam: 32.0, len: 45.0, tolD: 0.04, tolL: 0.08 },
    { name: "Line C \u2014 Pins",      part: "IPC-PN-12", diam: 12.0, len: 60.0, tolD: 0.03, tolL: 0.06 },
    { name: "Line D \u2014 Sleeves",   part: "IPC-SL-40", diam: 40.0, len: 100.0, tolD: 0.06, tolL: 0.12 },
  ]
  for (const l of lines) {
    await client.query(
      `INSERT INTO production_lines (name, part_number, nominal_diameter, nominal_length, tolerance_diameter, tolerance_length)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [l.name, l.part, l.diam, l.len, l.tolD, l.tolL]
    )
  }
  console.log(`Seeded ${lines.length} production lines.`)
}

console.log("\nDone. Next steps:")
console.log("  npm run generate   # 2000 synthetic inspection records (seed 42)")
console.log("  npm run train      # train random forest, score all inspections, print metrics")
console.log("  npm run dev        # open the dashboard at http://localhost:3000")

await client.end()
