import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-server";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const { data, error } = await getSupabaseAdmin()
    .from("assembly_projects")
    .select("*")
    .eq("project_id", id)
    .single();

  if (error || !data) {
    return NextResponse.json(
      { error: "Project not found." },
      { status: 404 }
    );
  }

  return NextResponse.json({ project: data });
}
