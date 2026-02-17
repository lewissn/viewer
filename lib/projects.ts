/**
 * Project & Cabinet Instance types for customer assembly guides.
 */

export interface GuideOverrides {
  /** Override step ordering by groupKey list */
  stepOrder?: string[];
  /** Override step copy text, keyed by groupKey */
  stepCopy?: Record<string, string>;
  /** Override explode offsets per groupKey */
  explodeOffsets?: Record<string, [number, number, number]>;
}

export interface CabinetInstance {
  cabinetId: string;
  cabinetName: string;
  /** Occurrence index for duplicate cabinet names (0-based) */
  cabinetIndex: number;
  /** URL to the per-cabinet model file (GLB/3DS) */
  modelFileUrl?: string;
  /** URL to the ERP CSV file for this cabinet */
  erpCsvUrl?: string;
  /** Part names from ERP for this cabinet instance */
  erpParts: string[];
  /** Optional per-cabinet guide overrides from admin */
  guideOverrides?: GuideOverrides;
}

export interface Project {
  id: string;
  projectId: string;
  projectName: string;
  customerName?: string;
  cabinets: CabinetInstance[];
  createdAt: string;
  updatedAt: string;
}

/** Display label for a cabinet instance (handles duplicates) */
export function cabinetDisplayName(cab: CabinetInstance, totalWithName: number): string {
  if (totalWithName <= 1) return cab.cabinetName;
  return `${cab.cabinetName} (${cab.cabinetIndex + 1})`;
}

/** Generate a slug-safe cabinet ID from name + index */
export function makeCabinetId(name: string, index: number): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
  return `${slug}-${index}`;
}
