import { scryptSync, randomBytes, timingSafeEqual } from "node:crypto"
import { cookies } from "next/headers"
import { pool } from "./db"

export type SessionUser = {
  id: number
  name: string
  email: string
  role: "inspector" | "manager"
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16)
  const hash = scryptSync(password, salt, 32, { N: 16384 })
  return `scrypt:${salt.toString("hex")}:${hash.toString("hex")}`
}

export function verifyPassword(password: string, stored: string): boolean {
  const [, saltHex, hashHex] = stored.split(":")
  if (!saltHex || !hashHex) return false
  const salt = Buffer.from(saltHex, "hex")
  const expected = Buffer.from(hashHex, "hex")
  const actual = scryptSync(password, salt, 32, { N: 16384 })
  return timingSafeEqual(actual, expected)
}

export async function getSession(): Promise<SessionUser | null> {
  const token = cookies().get("qg_session")?.value
  if (!token) return null
  const { rows } = await pool.query(
    `SELECT u.id, u.name, u.email, u.role
     FROM users_sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = $1 AND s.expires_at > now()`,
    [token],
  )
  return rows[0] ?? null
}

export async function createSession(userId: number): Promise<string> {
  const token = randomBytes(32).toString("hex")
  await pool.query(
    `INSERT INTO users_sessions (token, user_id, expires_at) VALUES ($1, $2, now() + interval '8 hours')`,
    [token, userId],
  )
  return token
}

export async function deleteSession(token: string): Promise<void> {
  await pool.query(`DELETE FROM users_sessions WHERE token = $1`, [token])
}
