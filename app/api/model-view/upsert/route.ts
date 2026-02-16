import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { normalizeUrls, validateUrls } from "@/lib/urls";
import { generatePublicId } from "@/lib/id";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { jobNumber, urlsText } = body as {
      jobNumber?: string;
      urlsText?: string;
    };

    if (!jobNumber || !jobNumber.trim()) {
      return NextResponse.json(
        { error: "Job number is required." },
        { status: 400 }
      );
    }

    if (!urlsText || !urlsText.trim()) {
      return NextResponse.json(
        { error: "At least one URL is required." },
        { status: 400 }
      );
    }

    const trimmedJob = jobNumber.trim();
    const urls = normalizeUrls(urlsText);
    const validation = validateUrls(urls);

    if (!validation.valid) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }

    // Check if job already exists
    const { data: existing } = await getSupabaseAdmin()
      .from("model_views")
      .select("id")
      .eq("job_number", trimmedJob)
      .single();

    if (existing) {
      // Update existing record — keep the same public ID
      const { data, error } = await getSupabaseAdmin()
        .from("model_views")
        .update({ model_urls: urls, updated_at: new Date().toISOString() })
        .eq("job_number", trimmedJob)
        .select()
        .single();

      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
      }

      return NextResponse.json({ modelView: data, created: false });
    }

    // Create new record
    const publicId = generatePublicId(trimmedJob);

    const { data, error } = await getSupabaseAdmin()
      .from("model_views")
      .insert({
        id: publicId,
        job_number: trimmedJob,
        model_urls: urls,
      })
      .select()
      .single();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ modelView: data, created: true });
  } catch {
    return NextResponse.json(
      { error: "Invalid request body." },
      { status: 400 }
    );
  }
}
