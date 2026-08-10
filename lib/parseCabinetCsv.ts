/**
 * Per-cabinet ERP CSV parsing.
 *
 * The ERP exports one CSV per cabinet alongside the .3ds, e.g. "TDB LHS.CSV":
 *
 *   a----CS-MDF; 18.30,1304.40,259.40,Top      <- panel: col4 is the part name
 *   a----CS-MDF; 18.30,2001.70,291.70,Left Side
 *   30mm Screw (Counter-top Screw Holes),6     <- fitting: col1 name, col2 qty
 *
 * Panels carry a value in column 4; fittings only have a name and a quantity.
 * Runs identically on the server (fetch-csv route) and in the browser (folder
 * import), so a cabinet parses the same however it reaches us.
 */

import { resolveFittings, type ResolvedFitting } from "./fittings";

export interface CabinetCsvResult {
  parts: string[];
  fittings: ResolvedFitting[];
  rawFittings: { name: string; qty: number }[];
  warnings: string[];
}

/** Parse a single CSV line respecting quoted fields */
export function parseCSVLine(line: string): string[] {
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

/**
 * Parse a cabinet CSV into part names and resolved fittings.
 *
 * @param csvText raw CSV contents
 * @param column  1-indexed column holding the part name (ERP default: 4)
 */
export function parseCabinetCsv(csvText: string, column = 4): CabinetCsvResult {
  const colIndex = column - 1;
  const warnings: string[] = [];
  const parts: string[] = [];
  const rawFittings: { name: string; qty: number }[] = [];

  const lines = csvText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length === 0) {
    return { parts: [], fittings: [], rawFittings: [], warnings: ["Empty CSV file."] };
  }

  // Skip header row if the part-name column looks like a heading
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

    // Panel row: has data in the part-name column
    if (fields.length > colIndex && fields[colIndex].trim()) {
      parts.push(fields[colIndex].trim());
      continue;
    }

    // Fitting row: col1 = name, col2 = qty (and the part-name column is empty)
    const fittingName = fields[0]?.trim();
    const fittingQtyStr = fields[1]?.trim();
    if (fittingName && fittingQtyStr) {
      const qty = parseFloat(fittingQtyStr);
      if (!isNaN(qty) && qty > 0) {
        rawFittings.push({ name: fittingName, qty });
        continue;
      }
    }

    if (fields.some((f) => f.trim())) {
      warnings.push(`Line ${i + 1}: could not parse as panel or fitting. Skipped.`);
    }
  }

  return { parts, fittings: resolveFittings(rawFittings), rawFittings, warnings };
}
