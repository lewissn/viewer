import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { generatePublicId } from "@/lib/id";
import type { CabinetInstance } from "@/lib/projects";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { projectId, projectName, customerName, cabinets } = body as {
      projectId?: string;
      projectName?: string;
      customerName?: string;
      cabinets?: CabinetInstance[];
    };

    if (!projectId || !projectId.trim()) {
      return NextResponse.json(
        { error: "Project ID is required." },
        { status: 400 }
      );
    }

    if (!projectName || !projectName.trim()) {
      return NextResponse.json(
        { error: "Project name is required." },
        { status: 400 }
      );
    }

    const trimmedProjectId = projectId.trim();
    const now = new Date().toISOString();

    // Check if project already exists
    const { data: existing } = await getSupabaseAdmin()
      .from("assembly_projects")
      .select("id")
      .eq("project_id", trimmedProjectId)
      .single();

    if (existing) {
      const { data, error } = await getSupabaseAdmin()
        .from("assembly_projects")
        .update({
          project_name: projectName.trim(),
          customer_name: customerName?.trim() || null,
          cabinets: cabinets ?? [],
          updated_at: now,
        })
        .eq("project_id", trimmedProjectId)
        .select()
        .single();

      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
      }

      return NextResponse.json({ project: data, created: false });
    }

    // Create new project
    const id = generatePublicId(trimmedProjectId);

    const { data, error } = await getSupabaseAdmin()
      .from("assembly_projects")
      .insert({
        id,
        project_id: trimmedProjectId,
        project_name: projectName.trim(),
        customer_name: customerName?.trim() || null,
        cabinets: cabinets ?? [],
        created_at: now,
        updated_at: now,
      })
      .select()
      .single();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ project: data, created: true });
  } catch {
    return NextResponse.json(
      { error: "Invalid request body." },
      { status: 400 }
    );
  }
}
