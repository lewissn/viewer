/**
 * Part Classification Engine
 *
 * Normalizes part names and classifies them into logical groups
 * for dynamic assembly guide generation. Uses priority-ordered rules
 * to avoid collisions (e.g. "Back Plinth" → Plinth, not Back).
 */

import { generateSteps } from "./assembly/stepGenerator";
import type { GuideOverrides } from "./projects";

// ── Normalisation ──

export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[-_\[\](){}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ── Classification ──

export interface Classification {
  groupKey: string;
  subtype?: string;
}

function hasToken(norm: string, token: string): boolean {
  return norm.split(" ").includes(token);
}

function containsTokens(norm: string, tokens: string[]): boolean {
  return tokens.every((t) => hasToken(norm, t));
}

/**
 * Get the effective group key for grouping/highlighting.
 * When subtype exists, returns "GroupKey - Subtype" for finer grouping.
 */
export function getEffectiveGroupKey(c: Classification): string {
  return c.subtype ? `${c.groupKey} - ${c.subtype}` : c.groupKey;
}

/** Drawer index from part name, e.g. "Left Side UM-D [2]_1" -> "[2]_1" */
const DRAWER_INDEX_RE = /\[\d+\]_\d+/;

export function extractDrawerIndex(name: string): string | undefined {
  const m = name.match(DRAWER_INDEX_RE);
  return m ? m[0] : undefined;
}

/** Drawer-type code after normalisation, e.g. "um d" (UM-D) or "45 d" (45-D) */
const DRAWER_TYPE_RE = /(^| )([a-z]{1,3}|\d{1,3}) d( |$)/;

/**
 * Classify a part name into a group key + optional subtype.
 * Rules are evaluated in priority order to prevent collisions
 * (e.g. "Left Side UM-D" -> Drawer Box - Left, not Left Side).
 */
export function classifyPart(name: string): Classification {
  const norm = normalizeName(name);

  // 1) DRAWERS — a drawer-type code ending in "-D" ("UM-D" undermount,
  // "45-D", ...) takes absolute precedence
  if (DRAWER_TYPE_RE.test(norm)) {
    if (norm.startsWith("left side")) return { groupKey: "Drawer Box - Left" };
    if (norm.startsWith("right side")) return { groupKey: "Drawer Box - Right" };
    if (norm.startsWith("back")) return { groupKey: "Drawer Box - Back" };
    if (norm.startsWith("bottom")) return { groupKey: "Drawer Box - Bottom" };
    return { groupKey: "Drawer" };
  }

  // 2) BOOKCASE FACE FRAMES — "bookcase" + "ff" tokens
  if (containsTokens(norm, ["bookcase", "ff"])) {
    if (hasToken(norm, "ucb")) return { groupKey: "Face Frame - Top" };
    if (hasToken(norm, "lu")) return { groupKey: "Face Frame - Left" };
    if (hasToken(norm, "ru")) return { groupKey: "Face Frame - Right" };
    if (hasToken(norm, "icb")) return { groupKey: "Face Frame - Divider" };
    return { groupKey: "Face Frame" };
  }

  // 3) EXPLICIT FACE FRAMES — "left/right/top/divider face frame"
  if (norm.startsWith("left face frame")) return { groupKey: "Face Frame - Left" };
  if (norm.startsWith("right face frame")) return { groupKey: "Face Frame - Right" };
  if (norm.startsWith("top face frame")) return { groupKey: "Face Frame - Top" };
  if (norm.startsWith("divider face frame")) return { groupKey: "Face Frame - Divider" };

  // 4) BACK / REAR PLINTH — must come before generic Back, Rear and Plinth checks
  // Both "Back Plinth" and "Rear Plinth" are plinths fitted at the rear and
  // assembled with the standard plinth onto the bottom panel.
  if (norm.startsWith("back plinth") || norm.startsWith("rear plinth")) {
    return { groupKey: "Plinth" };
  }

  // 5) BACK VARIANTS — exclude anything with "plinth" token
  if (!hasToken(norm, "plinth")) {
    if (norm.startsWith("double back")) return { groupKey: "Back" };
    if (norm.startsWith("back panel")) return { groupKey: "Back" };
    if (norm.startsWith("back")) return { groupKey: "Back" };
    // Split backs on tall units: a thin upper back above a fixed shelf and
    // full-thickness lower backs below it
    if (norm.startsWith("upper back")) return { groupKey: "Back" };
    if (norm.startsWith("lower back")) return { groupKey: "Back" };
  }

  // 5b) WARDROBE FITTINGS — fitted inside the finished carcass
  if (norm.startsWith("hanging rail")) return { groupKey: "Hanging Rail" };

  // 5c) INSTALLATION TRIM — fitted on site once the cabinet is in position
  if (norm.startsWith("pelmet")) return { groupKey: "Pelmet" };
  if (norm.startsWith("skirting")) return { groupKey: "Skirting" };

  // 6) REAR SUPPORTS (Rear Brace / Wall Bar)
  if (norm.startsWith("rear brace")) return { groupKey: "Rear Brace" };
  if (norm.startsWith("wall bar")) return { groupKey: "Rear Brace" };

  // 7) FILLERS
  if (norm.startsWith("filler side")) return { groupKey: "Filler - Side" };
  if (norm.startsWith("filler front")) return { groupKey: "Filler - Front" };
  if (norm.startsWith("filler")) return { groupKey: "Filler" };

  // 8) STANDARD CARCASS — longest-match-wins (ordered longest first)
  // Fixed Shelf before generic Shelf; Mobile Shelf is a removable shelf variant
  const carcassPrefixes: [string, string][] = [
    ["vertical division", "Vertical Division"],
    ["vertical divider", "Vertical Division"],
    ["counter top", "Counter Top"],
    ["left side", "Left Side"],
    ["right side", "Right Side"],
    ["fixed shelf", "Fixed Shelf"],
    ["fixed shelves", "Fixed Shelf"],
    ["mobile shelf", "Shelf"],
    ["bottom", "Bottom"],
    ["plinth", "Plinth"],
    ["top", "Top"],
    ["door", "Door"],
    ["shelf", "Shelf"],
    ["hinge", "Hinge"],
  ];

  for (const [prefix, groupKey] of carcassPrefixes) {
    if (norm.startsWith(prefix)) return { groupKey };
  }

  // 9) Unknown
  return { groupKey: "Other" };
}

// ── Default explode offsets per group key ──

// Offsets are [x, y, z] direction multipliers: X left(-)/right(+), Y down(-)/up(+), Z back(-)/front(+).
// Each part starts at assembledPos + offset * baseDistance and animates TO assembledPos.
// The axes are the model file's own: in PolyBoard .3ds exports (Z-up, which
// the viewer turns upright) that makes Y the depth (front -, rear +) and Z the
// height (down -, up +). The step validator re-points any part whose offset
// would carry it through a panel that is already fitted.
export const DEFAULT_EXPLODE_OFFSETS: Record<string, [number, number, number]> = {
  Bottom: [0, -1, 0],
  Plinth: [0, -1.4, 0],
  Top: [0, 1, 0],
  "Vertical Division": [0, 1, 0],
  "Left Side": [-1, 0, 0],
  "Right Side": [1, 0, 0],
  Back: [0, 0, 1.2],
  // Straight in from the back: wall bars go in after the back panel, between
  // the sides they are cammed to
  "Rear Brace": [0, 1, 0],
  Door: [0, -1.4, 0],
  "Counter Top": [0, 1.3, 0],
  "Face Frame": [0, 0, 1.0],
  "Face Frame - Top": [0, 0, 1.0],
  "Face Frame - Left": [0, 0, 1.0],
  "Face Frame - Right": [0, 0, 1.0],
  "Face Frame - Divider": [0, 0, 1.0],
  "Drawer Box - Left": [0, -1.2, 0],
  "Drawer Box - Right": [0, -1.2, 0],
  "Drawer Box - Back": [0, -1.2, 0],
  "Drawer Box - Bottom": [0, -1.2, 0],
  Drawer: [0, -1.2, 0],
  "Fixed Shelf": [0, 0, 0.8],
  // Centre/outer subgroups are produced by geometric refinement on
  // multi-divider units, never by name classification — same motion as the
  // parent group so a split cabinet animates identically to an unsplit one.
  "Fixed Shelf - Centre": [0, 0, 0.8],
  "Fixed Shelf - Outer": [0, 0, 0.8],
  Shelf: [0, 0, 0.8],
  "Filler - Side": [1.2, 0, 0],
  "Filler - Front": [0, 0, 1.0],
  Filler: [1.2, 0, 0.5],
  Hinge: [0, 0, 1.3],
  "Hanging Rail": [0, -1, 0],
  Pelmet: [0, 0, 1],
  Skirting: [0, -1.4, 0],
  Other: [0, 0.5, 0.5],
};

/** Explode offset for a structural back: straight in from the rear */
const STRUCTURAL_BACK_OFFSET: [number, number, number] = [0, 1.2, 0];

// ── Guide generation ──

import type { StepHelper } from "./assemblyGuides";

export interface GeneratedStep {
  groupKeys: string[];
  copy: string;
  drawerMode?: "assembleFirst" | "insertAll";
  helpers?: StepHelper[];
  usesFittings?: boolean;
  /**
   * Catch-all step holding groups the rule-based order has no place for, so
   * no part stays hidden for the whole guide. Its parts are reported as
   * validation issues.
   */
  leftover?: boolean;
}

export interface GeneratedGuide {
  steps: GeneratedStep[];
  explodeOffsets: Record<string, [number, number, number]>;
  /** All group keys found in the model */
  detectedGroups: string[];
}

/**
 * Generate an assembly guide from a set of already-resolved group keys.
 * Use this when groups have been refined beyond name classification
 * (e.g. geometric reassignment of bare face-frame parts).
 */
export function generateGuideFromGroups(
  groupSet: Set<string>,
  overrides?: GuideOverrides,
  groupCounts?: Record<string, number>
): GeneratedGuide {
  const detectedGroups = Array.from(groupSet);

  // Generate steps via rule-based step generator
  const steps = generateSteps(groupSet, {
    bottomOverlaysSides: overrides?.bottomOverlaysSides,
    topOverlaysSides: overrides?.topOverlaysSides,
    backFixedToCarcass: overrides?.backFixedToCarcass,
    dividerCount: groupCounts?.["Vertical Division"],
  });

  // Build explode offsets (defaults + overrides). A structural back is
  // lowered onto the rear of the carcass rather than slid down grooves, so
  // it comes in from behind.
  const explodeOffsets: Record<string, [number, number, number]> = {
    ...DEFAULT_EXPLODE_OFFSETS,
    ...(overrides?.backFixedToCarcass ? { Back: STRUCTURAL_BACK_OFFSET } : {}),
    ...overrides?.explodeOffsets,
  };

  const generatedSteps: GeneratedStep[] = steps.map((s) => ({
    groupKeys: s.groupKeys,
    copy: s.copy,
    drawerMode: s.drawerMode,
    helpers: s.helpers,
    usesFittings: s.usesFittings,
  }));

  // Every group must appear in some step — a group the rules do not know
  // would otherwise stay hidden until the guide is complete.
  const placed = new Set(generatedSteps.flatMap((s) => s.groupKeys));
  const leftover = detectedGroups.filter((g) => !placed.has(g));
  if (leftover.length > 0) {
    generatedSteps.push({
      groupKeys: leftover,
      copy: "Fit the remaining parts.",
      leftover: true,
    });
  }

  return {
    steps: generatedSteps,
    explodeOffsets,
    detectedGroups,
  };
}

/**
 * Generate an assembly guide from a list of part names.
 * Uses the rule-based step generator for correct ordering.
 */
export function generateGuideFromParts(
  partNames: string[],
  overrides?: GuideOverrides
): GeneratedGuide {
  // Classify all parts and collect groups (with counts, so the step generator
  // can tell a single-divider cabinet from a multi-column one)
  const groupSet = new Set<string>();
  const groupCounts: Record<string, number> = {};
  for (const name of partNames) {
    const { groupKey } = classifyPart(name);
    groupSet.add(groupKey);
    groupCounts[groupKey] = (groupCounts[groupKey] ?? 0) + 1;
  }
  return generateGuideFromGroups(groupSet, overrides, groupCounts);
}
