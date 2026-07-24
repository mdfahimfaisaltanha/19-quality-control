import type { Metadata } from "next"
import "./globals.css"

export const metadata: Metadata = {
  title: "QualityGuard — Ironclad Precision Parts",
  description: "Manufacturing defect detection, SPC charts, and root-cause attribution",
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header>
          <div className="header-inner">
            <span className="logo">🔧 QualityGuard</span>
            <span className="sub">Ironclad Precision Parts • QA Dashboard</span>
          </div>
        </header>
        <div className="container">{children}</div>
      </body>
    </html>
  )
}
