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
  flags: { bottomOverlaysSides?: boolean } = {}
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
  const fixedShelfCount = count("Fixed Shelf");
  const hasRearBrace = has("Rear Brace");
  const overlayBottom = flags.bottomOverlaysSides ?? false;

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

  // ── Build Time Estimate ──

  let minutes = 20;
  minutes += dividerCount * 10;
  minutes += Math.floor(fixedShelfCount / 4) * 10;
  if (fixedShelfCount > 0 && fixedShelfCount < 4) minutes += 10;
  if (hasDrawers) minutes += 15;
  if (hasFaceFrames) minutes += 10;
  if (overlayBottom) minutes += 10;

  // ── Difficulty ──

  let score = 0;
  if (dividerCount > 0) score++;
  if (fixedShelfCount > 0) score++;
  if (hasDrawers) score++;
  if (hasFaceFrames) score++;
  if (overlayBottom) score++;

  const difficulty: CabinetBuildSummary["difficulty"] =
    score <= 1 ? "Easy" : score <= 3 ? "Moderate" : "Advanced";

  // ── Conditional Notes ──

  const notes: string[] = [];

  if (fixedShelfCount > 0) {
    notes.push("Fixed shelves must be installed before side panels.");
  }
  if (hasFaceFrames) {
    notes.push(
      "Face frames must be fitted before access becomes restricted."
    );
  }
  if (overlayBottom) {
    notes.push("Bottom panel is fitted after sides.");
  }
  if (hasDrawers) {
    notes.push("Drawer assembly is completed later in this guide.");
  }

  return { features, estimatedMinutes: minutes, difficulty, notes };
}
