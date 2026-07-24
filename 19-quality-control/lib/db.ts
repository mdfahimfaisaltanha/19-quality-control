import { Pool } from "pg"

declare global {
  // eslint-disable-next-line no-var
  var __pgPool: Pool | undefined
}

if (!global.__pgPool) {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set. Copy .env.example to .env.local and fill it in.")
  }
  global.__pgPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 })
}

export const pool = global.__pgPool
