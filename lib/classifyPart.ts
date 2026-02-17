/**
 * Part Classification Engine
 *
 * Normalizes part names and classifies them into logical groups
 * for dynamic assembly guide generation. Uses priority-ordered rules
 * to avoid collisions (e.g. "Back Plinth" → Plinth, not Back).
 */

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
 * Classify a part name into a group key + optional subtype.
 * Rules are evaluated in priority order to prevent collisions.
 */
export function classifyPart(name: string): Classification {
  const norm = normalizeName(name);

  // 1) DRAWERS — "um d" token takes absolute precedence
  if (norm.includes("um d") || norm.includes("um-d")) {
    if (norm.startsWith("left side")) return { groupKey: "Drawer Box", subtype: "Left" };
    if (norm.startsWith("right side")) return { groupKey: "Drawer Box", subtype: "Right" };
    if (norm.startsWith("back")) return { groupKey: "Drawer Box", subtype: "Back" };
    if (norm.startsWith("bottom")) return { groupKey: "Drawer Box", subtype: "Bottom" };
    // Drawer front / generic drawer mesh (e.g. "UM-D [1]")
    return { groupKey: "Drawer" };
  }

  // 2) BOOKCASE FACE FRAMES — "bookcase" + "ff" tokens
  if (containsTokens(norm, ["bookcase", "ff"])) {
    if (hasToken(norm, "ucb")) return { groupKey: "Face Frame", subtype: "Top" };
    if (hasToken(norm, "lu")) return { groupKey: "Face Frame", subtype: "Left" };
    if (hasToken(norm, "ru")) return { groupKey: "Face Frame", subtype: "Right" };
    if (hasToken(norm, "icb")) return { groupKey: "Face Frame", subtype: "Divider" };
    return { groupKey: "Face Frame" };
  }

  // 3) EXPLICIT FACE FRAMES — "left/right/top face frame"
  if (norm.startsWith("left face frame")) return { groupKey: "Face Frame", subtype: "Left" };
  if (norm.startsWith("right face frame")) return { groupKey: "Face Frame", subtype: "Right" };
  if (norm.startsWith("top face frame")) return { groupKey: "Face Frame", subtype: "Top" };

  // 4) BACK PLINTH — must come before generic Back and Plinth checks
  if (norm.startsWith("back plinth")) return { groupKey: "Plinth" };

  // 5) BACK VARIANTS — but exclude anything with "plinth" token
  if (!hasToken(norm, "plinth")) {
    if (norm.startsWith("double back")) return { groupKey: "Back" };
    if (norm.startsWith("back panel")) return { groupKey: "Back" };
    if (norm.startsWith("back")) return { groupKey: "Back" };
  }

  // 6) REAR SUPPORTS
  if (norm.startsWith("rear brace")) return { groupKey: "Rear Brace" };
  if (norm.startsWith("wall bar")) return { groupKey: "Rear Brace" };

  // 7) FILLERS
  if (norm.startsWith("filler side")) return { groupKey: "Filler", subtype: "Side" };
  if (norm.startsWith("filler front")) return { groupKey: "Filler", subtype: "Front" };
  if (norm.startsWith("filler")) return { groupKey: "Filler" };

  // 8) STANDARD CARCASS — longest-match-wins (ordered longest first)
  const carcassPrefixes: [string, string][] = [
    ["vertical division", "Vertical Division"],
    ["counter top", "Counter Top"],
    ["left side", "Left Side"],
    ["right side", "Right Side"],
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

  // 9) Unknown — use the raw normalized name as group key
  return { groupKey: "Other" };
}

// ── Default step template (order for guide generation) ──

export const DEFAULT_STEP_TEMPLATE: {
  groupKeys: string[];
  copy: string;
}[] = [
  { groupKeys: ["Bottom", "Plinth"], copy: "Connect the bottom and plinth panels." },
  { groupKeys: ["Vertical Division", "Top"], copy: "Fit the divider and top panel." },
  { groupKeys: ["Face Frame"], copy: "Attach the face frames." },
  { groupKeys: ["Left Side", "Right Side"], copy: "Attach the left and right sides." },
  { groupKeys: ["Rear Brace"], copy: "Fit the rear braces and wall bars." },
  { groupKeys: ["Back"], copy: "Secure the back panels to square the cabinet." },
  { groupKeys: ["Door"], copy: "Fit the doors to the carcass." },
  { groupKeys: ["Drawer Box", "Drawer"], copy: "Assemble and fit the drawers." },
  { groupKeys: ["Counter Top"], copy: "Place the counter top to finish." },
  { groupKeys: ["Shelf"], copy: "Insert the shelves." },
  { groupKeys: ["Filler"], copy: "Fit the filler pieces." },
];

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
  "Drawer Box": [0, -0.5, 1.2],
  Drawer: [0, -0.5, 1.2],
  Shelf: [0, 0.6, 0.4],
  Filler: [1.2, 0, 0.5],
  Hinge: [0, 0, 1.3],
  Other: [0, 0.5, 0.5],
};

// ── Guide generation ──

export interface GeneratedStep {
  groupKeys: string[];
  copy: string;
}

export interface GeneratedGuide {
  steps: GeneratedStep[];
  explodeOffsets: Record<string, [number, number, number]>;
  /** All group keys found in the model */
  detectedGroups: string[];
}

/**
 * Generate an assembly guide from a list of part names.
 * Classifies each name, groups by groupKey, then builds steps
 * from the default template (only including groups that exist).
 */
export function generateGuideFromParts(
  partNames: string[],
  overrides?: {
    stepOrder?: string[];
    stepCopy?: Record<string, string>;
    explodeOffsets?: Record<string, [number, number, number]>;
  }
): GeneratedGuide {
  // Classify all parts and collect groups
  const groupSet = new Set<string>();
  for (const name of partNames) {
    const { groupKey } = classifyPart(name);
    groupSet.add(groupKey);
  }

  const detectedGroups = Array.from(groupSet);

  // Build steps from template, only including groups that have parts
  const steps: GeneratedStep[] = [];

  for (const template of DEFAULT_STEP_TEMPLATE) {
    const presentKeys = template.groupKeys.filter((k) => groupSet.has(k));
    if (presentKeys.length === 0) continue;

    const copy = overrides?.stepCopy?.[presentKeys[0]] ?? template.copy;
    steps.push({ groupKeys: presentKeys, copy });
  }

  // Check for groups not covered by the template
  const coveredGroups = new Set(steps.flatMap((s) => s.groupKeys));
  for (const group of detectedGroups) {
    if (!coveredGroups.has(group) && group !== "Other") {
      steps.push({
        groupKeys: [group],
        copy: `Fit the ${group.toLowerCase()} parts.`,
      });
    }
  }

  // Build explode offsets (defaults + overrides)
  const explodeOffsets: Record<string, [number, number, number]> = {
    ...DEFAULT_EXPLODE_OFFSETS,
    ...overrides?.explodeOffsets,
  };

  return { steps, explodeOffsets, detectedGroups };
}
