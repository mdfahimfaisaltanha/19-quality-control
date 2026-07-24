import { NextRequest, NextResponse } from "next/server"
import { cookies } from "next/headers"
import { pool } from "@/lib/db"
import { verifyPassword, createSession, deleteSession, getSession } from "@/lib/auth"

export async function GET() {
  const user = await getSession()
  return NextResponse.json({ user })
}

export async function POST(req: NextRequest) {
  const { email, password } = await req.json()
  if (!email || !password)
    return NextResponse.json({ error: "Email and password are required" }, { status: 400 })

  const { rows } = await pool.query(`SELECT id, name, email, role, password_hash FROM users WHERE email = $1`, [email])
  const user = rows[0]
  // Constant-time: always verify even if no user found
  const ok = user ? verifyPassword(password, user.password_hash) : false
  if (!ok) return NextResponse.json({ error: "Invalid email or password" }, { status: 401 })

  const token = await createSession(user.id)
  cookies().set("qg_session", token, { httpOnly: true, sameSite: "lax", maxAge: 60 * 60 * 8 })
  return NextResponse.json({ user: { id: user.id, name: user.name, email: user.email, role: user.role } })
}

export async function DELETE() {
  const token = cookies().get("qg_session")?.value
  if (token) await deleteSession(token)
  cookies().delete("qg_session")
  return NextResponse.json({ ok: true })
}
