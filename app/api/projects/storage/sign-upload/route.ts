import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { PROJECT_FILES_BUCKET } from "@/lib/importFolder";

/**
 * Issues signed upload URLs so the browser can push model and texture files
 * straight to Supabase Storage.
 *
 * Uploading through this route instead would cap files at the serverless body
 * limit (4.5MB on Vercel) — a single cabinet .3ds is routinely larger. The
 * service-role key stays server-side; the browser only ever sees short-lived
 * per-path upload URLs.
 *
 * POST body: { paths: string[] }
 * Returns: { uploads: { path, token, publicUrl }[] }
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { paths } = body as { paths?: string[] };

    if (!Array.isArray(paths) || paths.length === 0) {
      return NextResponse.json(
        { error: "At least one path is required." },
        { status: 400 }
      );
    }

    if (paths.length > 500) {
      return NextResponse.json(
        { error: "Too many files in one request (max 500)." },
        { status: 400 }
      );
    }

    const storage = getSupabaseAdmin().storage.from(PROJECT_FILES_BUCKET);

    const uploads = await Promise.all(
      paths.map(async (path) => {
        // upsert lets a re-import of the same order overwrite in place, so
        // customer links keep working after a revised export.
        const { data, error } = await storage.createSignedUploadUrl(path, {
          upsert: true,
        });
        if (error || !data) {
          throw new Error(`${path}: ${error?.message ?? "could not sign upload"}`);
        }
        const { data: pub } = storage.getPublicUrl(path);
        return { path, token: data.token, publicUrl: pub.publicUrl };
      })
    );

    return NextResponse.json({ uploads });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Could not prepare uploads.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
