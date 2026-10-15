import { timingSafeEqual } from "crypto";
import { NextRequest, NextResponse } from "next/server";

/**
 * Staff-only gate for the admin side of the viewer.
 *
 * Customers are only ever sent links to their own guide (/project/…, /assembly/…,
 * or a /{id} viewer link), which stay public. Everything that lists, creates or
 * edits projects — the root page, /admin and the admin API routes — asks for
 * the staff password via HTTP Basic auth.
 *
 * Set ADMIN_PASSWORD (and optionally ADMIN_USERNAME, default "admin") in the
 * environment. With no password set, the gate stays shut in production and is
 * skipped in local development.
 */

const REALM = "The Cabinet Shop Admin";

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function isAuthorised(req: NextRequest, username: string, password: string): boolean {
  const header = req.headers.get("authorization");
  if (!header?.startsWith("Basic ")) return false;

  let decoded: string;
  try {
    decoded = atob(header.slice("Basic ".length));
  } catch {
    return false;
  }
  const sep = decoded.indexOf(":");
  if (sep < 0) return false;

  // Evaluate both so a wrong username takes as long as a wrong password
  const userOk = safeEqual(decoded.slice(0, sep), username);
  const passOk = safeEqual(decoded.slice(sep + 1), password);
  return userOk && passOk;
}

export function proxy(req: NextRequest) {
  const password = process.env.ADMIN_PASSWORD;
  const username = process.env.ADMIN_USERNAME || "admin";

  if (!password) {
    if (process.env.NODE_ENV === "development") return NextResponse.next();
    return new NextResponse("Admin access is not configured.", { status: 503 });
  }

  if (isAuthorised(req, username, password)) return NextResponse.next();

  return new NextResponse("Authentication required.", {
    status: 401,
    headers: { "WWW-Authenticate": `Basic realm="${REALM}", charset="UTF-8"` },
  });
}

export const config = {
  matcher: [
    "/",
    "/admin/:path*",
    // Project list/create/edit, CSV fetch and storage upload signing. The
    // customer project page reads Supabase server-side, not through these.
    "/api/projects/:path*",
    "/api/model-view/upsert",
  ],
};
