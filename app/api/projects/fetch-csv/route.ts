import { NextRequest, NextResponse } from "next/server";
import { parseCabinetCsv } from "@/lib/parseCabinetCsv";

/**
 * Fetches a cabinet CSV from a remote URL (e.g. a Dropbox share link) and
 * parses it into parts and fittings.
 *
 * Kept for projects wired up by URL; folder import parses the same CSVs in the
 * browser using the same parser.
 *
 * POST body: { url: string, column?: number }
 * Returns: { parts, fittings, rawFittings, warnings }
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { url, column = 4 } = body as { url?: string; column?: number };

    if (!url || !url.trim()) {
      return NextResponse.json({ error: "CSV URL is required." }, { status: 400 });
    }

    const csvRes = await fetch(url, {
      headers: { Accept: "text/csv, text/plain, */*" },
    });

    if (!csvRes.ok) {
      return NextResponse.json(
        { error: `Failed to fetch CSV: ${csvRes.status} ${csvRes.statusText}` },
        { status: 400 }
      );
    }

    return NextResponse.json(parseCabinetCsv(await csvRes.text(), column));
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
}
