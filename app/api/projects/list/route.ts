import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-server";

/**
 * List assembly projects with optional search.
 *
 * GET /api/projects/list?q=smith&limit=50&offset=0
 */
export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const q = searchParams.get("q")?.trim() ?? "";
  const limit = Math.min(Number(searchParams.get("limit")) || 50, 200);
  const offset = Number(searchParams.get("offset")) || 0;

  let query = getSupabaseAdmin()
    .from("assembly_projects")
    .select("id, project_id, project_name, customer_name, cabinets, created_at, updated_at", {
      count: "exact",
    })
    .order("updated_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (q) {
    // Search across project_id, project_name, and customer_name
    query = query.or(
      `project_id.ilike.%${q}%,project_name.ilike.%${q}%,customer_name.ilike.%${q}%`
    );
  }

  const { data, error, count } = await query;

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ projects: data ?? [], total: count ?? 0 });
}
