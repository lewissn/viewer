import { NextRequest, NextResponse } from "next/server";
import { resolveFittings, type ResolvedFitting } from "@/lib/fittings";

/**
 * Fetches a CSV file from a remote URL and extracts:
 *  - Panel/part names from column 4
 *  - Fittings (name in col1, qty in col2) from rows that lack col4 data
 *
 * POST body: { url: string, column?: number }
 * Returns: { parts: string[], fittings: ResolvedFitting[], rawFittings: { name, qty }[], warnings: string[] }
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { url, column = 4 } = body as { url?: string; column?: number };

    if (!url || !url.trim()) {
      return NextResponse.json(
        { error: "CSV URL is required." },
        { status: 400 }
      );
    }

    // Fetch the remote CSV
    const csvRes = await fetch(url, {
      headers: { Accept: "text/csv, text/plain, */*" },
    });

    if (!csvRes.ok) {
      return NextResponse.json(
        { error: `Failed to fetch CSV: ${csvRes.status} ${csvRes.statusText}` },
        { status: 400 }
      );
    }

    const csvText = await csvRes.text();

    const colIndex = column - 1; // convert to 0-indexed
    const warnings: string[] = [];
    const parts: string[] = [];
    const rawFittings: { name: string; qty: number }[] = [];

    const lines = csvText
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    if (lines.length === 0) {
      return NextResponse.json({
        parts: [],
        fittings: [] as ResolvedFitting[],
        rawFittings: [],
        warnings: ["Empty CSV file."],
      });
    }

    // Skip header row if first row looks like a header
    const firstFields = parseCSVLine(lines[0]);
    let startIndex = 0;
    if (firstFields.length > colIndex) {
      const headerVal = firstFields[colIndex].toLowerCase();
      if (
        headerVal.includes("part") ||
        headerVal.includes("name") ||
        headerVal.includes("component") ||
        headerVal.includes("description")
      ) {
        startIndex = 1;
      }
    }

    for (let i = startIndex; i < lines.length; i++) {
      const fields = parseCSVLine(lines[i]);

      // Panel row: has data in column 4 (col1=material, col2=length, col3=width, col4=name)
      if (fields.length > colIndex && fields[colIndex].trim()) {
        parts.push(fields[colIndex].trim());
        continue;
      }

      // Fitting row: col1=name, col2=qty (and col4 is empty/missing)
      const fittingName = fields[0]?.trim();
      const fittingQtyStr = fields[1]?.trim();
      if (fittingName && fittingQtyStr) {
        const qty = parseFloat(fittingQtyStr);
        if (!isNaN(qty) && qty > 0) {
          rawFittings.push({ name: fittingName, qty });
          continue;
        }
      }

      // Row doesn't match either pattern
      if (fields.some((f) => f.trim())) {
        warnings.push(`Line ${i + 1}: could not parse as panel or fitting. Skipped.`);
      }
    }

    // Resolve fittings via aliases → canonical parts
    const fittings = resolveFittings(rawFittings);

    return NextResponse.json({ parts, fittings, rawFittings, warnings });
  } catch {
    return NextResponse.json(
      { error: "Invalid request." },
      { status: 400 }
    );
  }
}

/** Parse a single CSV line respecting quoted fields */
function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        fields.push(current.trim());
        current = "";
      } else {
        current += ch;
      }
    }
  }
  fields.push(current.trim());
  return fields;
}
