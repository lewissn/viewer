/**
 * Cabinet Build Summary
 *
 * Analyzes detected part groups to generate a context-aware build overview:
 * feature checklist, estimated build time, difficulty rating, and
 * conditional assembly notes.
 */

export interface CabinetFeature {
  label: string;
  count?: number;
}

export interface CabinetBuildSummary {
  features: CabinetFeature[];
  estimatedMinutes: number;
  difficulty: "Easy" | "Moderate" | "Advanced";
  notes: string[];
}

/**
 * Build a context-aware summary from detected groups and part counts.
 *
 * @param detectedGroups - All group keys found in the model
 * @param groupCounts    - Map of groupKey → number of parts in that group
 * @param flags          - Cabinet flags (e.g. bottomOverlaysSides)
 */
export function buildCabinetSummary(
  detectedGroups: string[],
  groupCounts: Record<string, number>,
  flags: { bottomOverlaysSides?: boolean; topOverlaysSides?: boolean } = {}
): CabinetBuildSummary {
  const has = (key: string) => detectedGroups.includes(key);
  const count = (key: string) => groupCounts[key] ?? 0;

  const hasFaceFrames =
    has("Face Frame") ||
    has("Face Frame - Top") ||
    has("Face Frame - Left") ||
    has("Face Frame - Right") ||
    has("Face Frame - Divider");

  const drawerBoxCount = Math.max(
    count("Drawer"),
    count("Drawer Box - Left"),
    count("Drawer Box - Right"),
    count("Drawer Box - Back"),
    count("Drawer Box - Bottom")
  );
  const hasDrawers = drawerBoxCount > 0;

  const dividerCount = count("Vertical Division");
  // Multi-divider units have their shelves split into centre/outer subgroups by
  // geometric refinement, so the total spans all three keys.
  const fixedShelfCount =
    count("Fixed Shelf") +
    count("Fixed Shelf - Centre") +
    count("Fixed Shelf - Outer");
  const centreShelfCount = count("Fixed Shelf - Centre");
  const hasRearBrace = has("Rear Brace");
  const overlayBottom = flags.bottomOverlaysSides ?? false;
  const overlayTop = flags.topOverlaysSides ?? false;

  // ── Features ──

  const features: CabinetFeature[] = [];

  if (dividerCount > 0) {
    features.push({ label: "Vertical Divisions", count: dividerCount });
  }
  if (fixedShelfCount > 0) {
    features.push({ label: "Fixed Shelves", count: fixedShelfCount });
  }
  if (hasFaceFrames) {
    const subtypes: string[] = [];
    if (has("Face Frame - Top")) subtypes.push("top");
    if (has("Face Frame - Left")) subtypes.push("left");
    if (has("Face Frame - Right")) subtypes.push("right");
    if (has("Face Frame - Divider")) subtypes.push("divider");
    const detail = subtypes.length > 0 ? ` (${subtypes.join(", ")})` : "";
    features.push({ label: `Face Frames${detail}` });
  }
  if (hasDrawers) {
    features.push({ label: "Drawers", count: drawerBoxCount });
  }
  if (hasRearBrace) {
    features.push({ label: "Rear Brace" });
  }
  if (overlayBottom) {
    features.push({ label: "Overlay Bottom" });
  }
  if (overlayTop) {
    features.push({ label: "Overlay Top" });
  }

  // ── Build Time Estimate ──

  let minutes = 20;
  minutes += dividerCount * 10;
  minutes += Math.floor(fixedShelfCount / 4) * 10;
  if (fixedShelfCount > 0 && fixedShelfCount < 4) minutes += 10;
  if (hasDrawers) minutes += 15;
  if (hasFaceFrames) minutes += 10;
  if (overlayBottom) minutes += 10;
  if (overlayTop) minutes += 10;

  // ── Difficulty ──

  let score = 0;
  if (dividerCount > 0) score++;
  if (fixedShelfCount > 0) score++;
  if (hasDrawers) score++;
  if (hasFaceFrames) score++;
  if (overlayBottom) score++;
  if (overlayTop) score++;

  const difficulty: CabinetBuildSummary["difficulty"] =
    score <= 1 ? "Easy" : score <= 3 ? "Moderate" : "Advanced";

  // ── Conditional Notes ──

  const notes: string[] = [];

  if (overlayBottom) {
    notes.push(
      "Upper unit — build flat, front-edge-down. Bottom panel is fitted last."
    );
  } else {
    notes.push(
      "Build with front edges facing the floor. Stand upright once the back is fitted."
    );
  }
  if (overlayTop) {
    notes.push(
      "Top panel overlays the sides — it is fitted last, after the back but before the wall bar."
    );
  }
  // Mirrors the step generator: centre shelves mean the build starts from the
  // divider assembly rather than the base panel.
  if (centreShelfCount > 0) {
    notes.push(
      `${dividerCount} dividers make ${dividerCount + 1} columns. Build the dividers and their shelves as one assembly first — the inner column(s) close up once the dividers meet the base panel, so those shelves cannot be added later.`
    );
  } else if (dividerCount > 0) {
    notes.push(
      "Dividers form the inner structure and must be connected early."
    );
  }
  if (fixedShelfCount > 0 && centreShelfCount === 0) {
    notes.push("Fixed shelves must be installed before side panels.");
  }
  if (hasFaceFrames) {
    notes.push(
      "Attach face frames to their panels before connecting the cabinet."
    );
  }
  if (hasDrawers) {
    notes.push("Drawers are assembled first, then inserted after the carcass.");
  }

  return { features, estimatedMinutes: minutes, difficulty, notes };
}
