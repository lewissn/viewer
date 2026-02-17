/**
 * ERP CSV Parser
 *
 * Parses a CSV with columns: projectName, cabinetName, partName
 * Groups rows into cabinet instances by contiguous cabinetName blocks.
 */

import { type CabinetInstance, makeCabinetId } from "./projects";

interface ParsedRow {
  projectName: string;
  cabinetName: string;
  partName: string;
}

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

export interface ErpParseResult {
  projectName: string;
  cabinets: CabinetInstance[];
  warnings: string[];
}

/**
 * Parse an ERP CSV string into a project name + cabinet instances.
 *
 * Expected columns (at minimum):
 *   col1: projectName
 *   col2: cabinetName
 *   col3: partName
 *
 * Groups rows by cabinetName into contiguous blocks.
 * For each contiguous block, creates a CabinetInstance with incrementing index.
 */
export function parseErpCsv(csvText: string): ErpParseResult {
  const warnings: string[] = [];
  const lines = csvText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length === 0) {
    return { projectName: "", cabinets: [], warnings: ["Empty CSV file."] };
  }

  // Check if first line is a header
  const firstFields = parseCSVLine(lines[0]);
  let startIndex = 0;
  if (
    firstFields.length >= 3 &&
    firstFields[0].toLowerCase().includes("project") &&
    firstFields[1].toLowerCase().includes("cabinet")
  ) {
    startIndex = 1; // skip header
  }

  // Parse rows
  const rows: ParsedRow[] = [];
  for (let i = startIndex; i < lines.length; i++) {
    const fields = parseCSVLine(lines[i]);
    if (fields.length < 3) {
      warnings.push(`Line ${i + 1}: expected at least 3 columns, got ${fields.length}. Skipped.`);
      continue;
    }
    rows.push({
      projectName: fields[0],
      cabinetName: fields[1],
      partName: fields[2],
    });
  }

  if (rows.length === 0) {
    return { projectName: "", cabinets: [], warnings: [...warnings, "No valid data rows found."] };
  }

  const projectName = rows[0].projectName;

  // Group into contiguous blocks by cabinetName
  const blocks: { cabinetName: string; parts: string[] }[] = [];
  let currentBlock: { cabinetName: string; parts: string[] } | null = null;

  for (const row of rows) {
    if (!currentBlock || currentBlock.cabinetName !== row.cabinetName) {
      currentBlock = { cabinetName: row.cabinetName, parts: [] };
      blocks.push(currentBlock);
    }
    if (row.partName) {
      currentBlock.parts.push(row.partName);
    }
  }

  // Count occurrences of each cabinet name for indexing
  const nameCount = new Map<string, number>();
  for (const block of blocks) {
    nameCount.set(block.cabinetName, (nameCount.get(block.cabinetName) ?? 0) + 1);
  }

  // Build cabinet instances with indexes
  const nameIndexTracker = new Map<string, number>();
  const cabinets: CabinetInstance[] = [];

  for (const block of blocks) {
    const idx = nameIndexTracker.get(block.cabinetName) ?? 0;
    nameIndexTracker.set(block.cabinetName, idx + 1);

    cabinets.push({
      cabinetId: makeCabinetId(block.cabinetName, idx),
      cabinetName: block.cabinetName,
      cabinetIndex: idx,
      erpParts: block.parts,
    });
  }

  return { projectName, cabinets, warnings };
}
