import type { ResolvedFitting } from "./fittings";
import type { StepHelper } from "./assemblyGuides";

/**
 * Project & Cabinet Instance types for customer assembly guides.
 */

/**
 * One step of an admin-edited guide.
 *
 * A step is identified by the part groups it assembles (plus its drawer mode,
 * since the drawer groups appear twice: once to build a drawer and once to
 * slide them all in), never by its position — so an edited guide still lines
 * up after the model or the step generator changes.
 */
export interface StepOverride {
  groupKeys: string[];
  drawerMode?: "assembleFirst" | "insertAll";
  /** Replaces the generated instruction. Omitted = automatic text. */
  copy?: string;
  /** Replaces the generated helper blocks. Omitted = automatic helpers. */
  helpers?: StepHelper[];
  /** Left out of the customer guide */
  hidden?: boolean;
}

export interface GuideOverrides {
  /**
   * Admin-edited step list. When present it replaces the generated order.
   * Groups the model has that no step mentions are appended as their own
   * steps, so nothing disappears if the model changes.
   */
  steps?: StepOverride[];
  /** Mesh names left out of the guide entirely (e.g. a stray mesh) */
  excludedParts?: string[];
  /** Override explode offsets per groupKey */
  explodeOffsets?: Record<string, [number, number, number]>;
  /** Upper unit / dresser: bottom overlays sides, must be fitted AFTER sides */
  bottomOverlaysSides?: boolean;
  /** Top overlays sides: top must be fitted LAST, after the back but before the wall bar */
  topOverlaysSides?: boolean;
  /**
   * Structural back: full-thickness back cammed onto the carcass, fitted last
   * after the top. Undefined = auto-detect from the model's back thickness.
   */
  backFixedToCarcass?: boolean;
}

export interface CabinetInstance {
  cabinetId: string;
  cabinetName: string;
  /** Occurrence index for duplicate cabinet names (0-based) */
  cabinetIndex: number;
  /** URL to the per-cabinet model file (GLB/3DS) */
  modelFileUrl?: string;
  /**
   * Optional texture/material file URLs for the model (e.g. .jpg/.png/.bmp
   * referenced by a .3ds export). Loaded alongside the model so any
   * patterned/textured surfaces render correctly. Empty or omitted for
   * flat-colour models.
   */
  textureFileUrls?: string[];
  /** URL to the ERP CSV file for this cabinet */
  erpCsvUrl?: string;
  /** Part names from ERP for this cabinet instance */
  erpParts: string[];
  /** Resolved fittings with quantities from ERP */
  erpFittings?: ResolvedFitting[];
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
