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

/**
 * Classify a part name into a group key + optional subtype.
 * Rules are evaluated in priority order to prevent collisions
 * (e.g. "Left Side UM-D" -> Drawer Box - Left, not Left Side).
 */
export function classifyPart(name: string): Classification {
  const norm = normalizeName(name);

  // 1) DRAWERS — "um d" / "um-d" token takes absolute precedence
  if (norm.includes("um d") || norm.includes("um-d")) {
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

  // 4) BACK PLINTH — must come before generic Back and Plinth checks
  if (norm.startsWith("back plinth")) return { groupKey: "Plinth" };

  // 5) BACK VARIANTS — exclude anything with "plinth" token
  if (!hasToken(norm, "plinth")) {
    if (norm.startsWith("double back")) return { groupKey: "Back" };
    if (norm.startsWith("back panel")) return { groupKey: "Back" };
    if (norm.startsWith("back")) return { groupKey: "Back" };
  }

  // 6) REAR SUPPORTS (Rear Brace / Wall Bar)
  if (norm.startsWith("rear brace")) return { groupKey: "Rear Brace" };
  if (norm.startsWith("wall bar")) return { groupKey: "Rear Brace" };

  // 7) FILLERS
  if (norm.startsWith("filler side")) return { groupKey: "Filler - Side" };
  if (norm.startsWith("filler front")) return { groupKey: "Filler - Front" };
  if (norm.startsWith("filler")) return { groupKey: "Filler" };

  // 8) STANDARD CARCASS — longest-match-wins (ordered longest first)
  // Fixed Shelf before generic Shelf (naming convention for fixed-only)
  const carcassPrefixes: [string, string][] = [
    ["vertical division", "Vertical Division"],
    ["vertical divider", "Vertical Division"],
    ["counter top", "Counter Top"],
    ["left side", "Left Side"],
    ["right side", "Right Side"],
    ["fixed shelf", "Fixed Shelf"],
    ["fixed shelves", "Fixed Shelf"],
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

export const DEFAULT_EXPLODE_OFFSETS: Record<string, [number, number, number]> = {
  Bottom: [0, -1, 0],
  Plinth: [0, -1.4, 0.3],
  Top: [0, 1, 0],
  "Vertical Division": [0, 0.3, 0.5],
  "Left Side": [-1, 0, 0],
  "Right Side": [1, 0, 0],
  Back: [0, 0, -1.2],
  "Rear Brace": [0, 0.2, -1],
  Door: [0, 0, 1.4],
  "Counter Top": [0, 1.3, 0.3],
  "Face Frame": [0, 0, 1.0],
  "Face Frame - Top": [0, 0, 1.0],
  "Face Frame - Left": [0, 0, 1.0],
  "Face Frame - Right": [0, 0, 1.0],
  "Face Frame - Divider": [0, 0, 1.0],
  "Drawer Box - Left": [0, -0.5, 1.2],
  "Drawer Box - Right": [0, -0.5, 1.2],
  "Drawer Box - Back": [0, -0.5, 1.2],
  "Drawer Box - Bottom": [0, -0.5, 1.2],
  Drawer: [0, -0.5, 1.2],
  "Fixed Shelf": [0, 0.6, 0.4],
  Shelf: [0, 0.6, 0.4],
  "Filler - Side": [1.2, 0, 0.5],
  "Filler - Front": [1.2, 0, 0.5],
  Filler: [1.2, 0, 0.5],
  Hinge: [0, 0, 1.3],
  Other: [0, 0.5, 0.5],
};

// ── Guide generation ──

export interface GeneratedStep {
  groupKeys: string[];
  copy: string;
  drawerMode?: "assembleFirst" | "insertAll";
}

export interface GeneratedGuide {
  steps: GeneratedStep[];
  explodeOffsets: Record<string, [number, number, number]>;
  /** All group keys found in the model */
  detectedGroups: string[];
}

/**
 * Generate an assembly guide from a list of part names.
 * Uses the rule-based step generator for correct ordering.
 */
export function generateGuideFromParts(
  partNames: string[],
  overrides?: GuideOverrides
): GeneratedGuide {
  // Classify all parts and collect groups
  const groupSet = new Set<string>();
  for (const name of partNames) {
    const { groupKey } = classifyPart(name);
    groupSet.add(groupKey);
  }

  const detectedGroups = Array.from(groupSet);

  // Generate steps via rule-based step generator
  const steps = generateSteps(groupSet, {
    bottomOverlaysSides: overrides?.bottomOverlaysSides,
  });

  // Build explode offsets (defaults + overrides)
  const explodeOffsets: Record<string, [number, number, number]> = {
    ...DEFAULT_EXPLODE_OFFSETS,
    ...overrides?.explodeOffsets,
  };

  return {
    steps: steps.map((s) => ({
      groupKeys: s.groupKeys,
      copy: s.copy,
      drawerMode: s.drawerMode,
    })),
    explodeOffsets,
    detectedGroups,
  };
}
