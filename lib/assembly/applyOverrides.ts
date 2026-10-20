/**
 * Admin guide overrides
 *
 * Applies a cabinet's edited step list (GuideOverrides.steps) on top of the
 * automatically generated steps, and provides the edit operations the admin
 * guide editor uses (reorder, merge, split, move a group, hide).
 *
 * Steps are matched by their group keys (plus drawer mode), never by index,
 * so an edited guide survives the model or the step generator changing:
 * - groups the edit mentions that the model no longer has are dropped
 *   (reported as stale);
 * - groups the model has that the edit does not mention are appended as
 *   their own steps (reported as appended), so nothing silently disappears.
 *
 * Pure: no viewer or DOM access, so it can be tested in Node.
 */

import type { StepHelper } from "../assemblyGuides";
import type { StepOverride } from "../projects";

export type DrawerMode = "assembleFirst" | "insertAll";

/** A generated step — the shape the step generator produces */
export interface GuideStepInput {
  groupKeys: string[];
  copy: string;
  drawerMode?: DrawerMode;
  helpers?: StepHelper[];
  usesFittings?: boolean;
}

/** Where a resolved field came from */
export type FieldSource =
  /** Typed by staff */
  | "override"
  /** The generated step with exactly these groups */
  | "auto"
  /** Borrowed from the generated step(s) these groups came from (merged/split) */
  | "derived";

export interface ResolvedStep extends GuideStepInput {
  hidden: boolean;
  /**
   * auto     = generated step, no edit saved for this cabinet
   * override = from the saved step list
   * appended = model groups the saved list doesn't mention
   */
  origin: "auto" | "override" | "appended";
  copySource: FieldSource;
  helpersSource: FieldSource;
}

export interface ResolvedGuide {
  /** Every step in order, hidden ones included (filter on `hidden` for the customer guide) */
  steps: ResolvedStep[];
  /** True when the cabinet has a saved step list */
  usingOverride: boolean;
  /** Groups added at the end because the saved list doesn't mention them */
  appendedGroups: string[];
  /** Groups the saved list mentions that the model no longer has */
  staleGroups: string[];
}

/** Group keys present in the model that no step (hidden or not) assembles */
export function unplacedGroups(
  resolved: ResolvedGuide,
  presentGroups: Iterable<string>
): string[] {
  const placed = new Set(resolved.steps.flatMap((s) => s.groupKeys));
  return Array.from(new Set(presentGroups)).filter((g) => !placed.has(g));
}

// ── Resolve ──

/** Drawer groups appear in two steps; steps only cover groups within the same mode */
function modeClass(mode?: DrawerMode): string {
  return mode ?? "";
}

function sameGroups(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((k) => set.has(k));
}

function dedupeHelpers(helpers: StepHelper[]): StepHelper[] {
  const seen = new Set<string>();
  return helpers.filter((h) => {
    const key = `${h.title}\n${h.content}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function fallbackCopy(groupKeys: string[]): string {
  return `Fit the ${groupKeys.join(", ").toLowerCase()} parts.`;
}

/**
 * Resolve the steps a cabinet's guide should show.
 *
 * @param generated     steps from the generator, in generated order
 * @param overrides     the cabinet's saved overrides (only `steps` is read)
 * @param presentGroups group keys that have parts in the model; defaults to
 *                      every group the generated steps mention
 */
export function resolveGuideSteps(
  generated: GuideStepInput[],
  overrides?: { steps?: StepOverride[] },
  presentGroups?: Iterable<string>
): ResolvedGuide {
  const saved = overrides?.steps;
  if (!saved) {
    return {
      steps: generated.map((s) => ({
        ...s,
        hidden: false,
        origin: "auto",
        copySource: "auto",
        helpersSource: "auto",
      })),
      usingOverride: false,
      appendedGroups: [],
      staleGroups: [],
    };
  }

  const present = new Set(
    presentGroups ?? generated.flatMap((s) => s.groupKeys)
  );
  const steps: ResolvedStep[] = [];
  const stale = new Set<string>();
  // Groups already assembled by a step, per drawer-mode class
  const covered = new Map<string, Set<string>>();
  const coveredIn = (mode?: DrawerMode) => {
    const c = modeClass(mode);
    if (!covered.has(c)) covered.set(c, new Set());
    return covered.get(c)!;
  };

  for (const o of saved) {
    const cov = coveredIn(o.drawerMode);
    const keys: string[] = [];
    for (const k of o.groupKeys) {
      if (!present.has(k)) {
        stale.add(k);
        continue;
      }
      // A group belongs to one step per mode class; first mention wins
      if (cov.has(k) || keys.includes(k)) continue;
      keys.push(k);
    }
    if (keys.length === 0) continue;
    keys.forEach((k) => cov.add(k));

    const sameMode = generated.filter(
      (g) => modeClass(g.drawerMode) === modeClass(o.drawerMode)
    );
    const exact = sameMode.find((g) => sameGroups(g.groupKeys, keys));
    const sources = exact
      ? [exact]
      : sameMode.filter((g) => g.groupKeys.some((k) => keys.includes(k)));

    let copy: string;
    let copySource: FieldSource;
    if (o.copy !== undefined) {
      copy = o.copy;
      copySource = "override";
    } else if (exact) {
      copy = exact.copy;
      copySource = "auto";
    } else {
      copy =
        Array.from(new Set(sources.map((s) => s.copy))).join(" ") ||
        fallbackCopy(keys);
      copySource = "derived";
    }

    let helpers: StepHelper[] | undefined;
    let helpersSource: FieldSource;
    if (o.helpers !== undefined) {
      helpers = o.helpers;
      helpersSource = "override";
    } else if (exact) {
      helpers = exact.helpers;
      helpersSource = "auto";
    } else {
      const merged = dedupeHelpers(sources.flatMap((s) => s.helpers ?? []));
      helpers = merged.length > 0 ? merged : undefined;
      helpersSource = "derived";
    }

    steps.push({
      groupKeys: keys,
      copy,
      drawerMode: o.drawerMode,
      helpers,
      usesFittings: sources.some((s) => s.usesFittings) || undefined,
      hidden: !!o.hidden,
      origin: "override",
      copySource,
      helpersSource,
    });
  }

  // Append whatever the saved list doesn't cover, keeping groups that the
  // generator put together in one step together.
  const appended: string[] = [];
  for (const g of generated) {
    const cov = coveredIn(g.drawerMode);
    const missing = g.groupKeys.filter((k) => present.has(k) && !cov.has(k));
    if (missing.length === 0) continue;
    missing.forEach((k) => cov.add(k));
    appended.push(...missing.filter((k) => !appended.includes(k)));
    const whole = missing.length === g.groupKeys.length;
    steps.push({
      groupKeys: missing,
      copy: g.copy,
      drawerMode: g.drawerMode,
      helpers: g.helpers,
      usesFittings: g.usesFittings,
      hidden: false,
      origin: "appended",
      copySource: whole ? "auto" : "derived",
      helpersSource: whole ? "auto" : "derived",
    });
  }

  return {
    steps,
    usingOverride: true,
    appendedGroups: appended,
    staleGroups: Array.from(stale),
  };
}

// ── Edit operations (used by the admin guide editor) ──
//
// Each takes the currently resolved steps and returns the new saved step
// list. Only text staff actually typed is stored, so automatic copy keeps
// improving for steps they didn't reword.

/** Saved form of the resolved steps (appended steps become part of the list) */
export function toOverrides(steps: ResolvedStep[]): StepOverride[] {
  return steps.map((s) => {
    const o: StepOverride = { groupKeys: [...s.groupKeys] };
    if (s.drawerMode) o.drawerMode = s.drawerMode;
    if (s.copySource === "override") o.copy = s.copy;
    if (s.helpersSource === "override") o.helpers = s.helpers ?? [];
    if (s.hidden) o.hidden = true;
    return o;
  });
}

/** Whether two steps can share groups (drawer steps only combine with their own kind) */
export function canCombine(a: ResolvedStep, b: ResolvedStep): boolean {
  return modeClass(a.drawerMode) === modeClass(b.drawerMode);
}

export function moveStep(
  steps: ResolvedStep[],
  from: number,
  to: number
): StepOverride[] {
  const out = toOverrides(steps);
  if (from < 0 || from >= out.length || to < 0 || to >= out.length) return out;
  const [step] = out.splice(from, 1);
  out.splice(to, 0, step);
  return out;
}

/** Merge step `index` with the one after it */
export function mergeWithNext(
  steps: ResolvedStep[],
  index: number
): StepOverride[] {
  const out = toOverrides(steps);
  const a = steps[index];
  const b = steps[index + 1];
  if (!a || !b || !canCombine(a, b)) return out;

  const merged: StepOverride = {
    groupKeys: [...a.groupKeys, ...b.groupKeys.filter((k) => !a.groupKeys.includes(k))],
  };
  if (a.drawerMode) merged.drawerMode = a.drawerMode;
  // Keep typed text: if either step was reworded, combine both texts
  if (a.copySource === "override" || b.copySource === "override") {
    merged.copy = [a.copy, b.copy].filter((c) => c.trim()).join(" ");
  }
  if (a.helpersSource === "override" || b.helpersSource === "override") {
    merged.helpers = dedupeHelpers([...(a.helpers ?? []), ...(b.helpers ?? [])]);
  }
  if (a.hidden && b.hidden) merged.hidden = true;

  out.splice(index, 2, merged);
  return out;
}

/** Take one group out of step `index` and make it its own step right after */
export function splitGroup(
  steps: ResolvedStep[],
  index: number,
  groupKey: string
): StepOverride[] {
  const out = toOverrides(steps);
  const step = out[index];
  if (!step || step.groupKeys.length < 2 || !step.groupKeys.includes(groupKey)) {
    return out;
  }
  step.groupKeys = step.groupKeys.filter((k) => k !== groupKey);
  const split: StepOverride = { groupKeys: [groupKey] };
  if (step.drawerMode) split.drawerMode = step.drawerMode;
  if (step.hidden) split.hidden = true;
  out.splice(index + 1, 0, split);
  return out;
}

/** Move one group from step `from` into step `to`; an emptied step is removed */
export function moveGroup(
  steps: ResolvedStep[],
  from: number,
  groupKey: string,
  to: number
): StepOverride[] {
  const out = toOverrides(steps);
  const src = out[from];
  const dst = out[to];
  if (
    !src ||
    !dst ||
    from === to ||
    !src.groupKeys.includes(groupKey) ||
    !canCombine(steps[from], steps[to])
  ) {
    return out;
  }
  src.groupKeys = src.groupKeys.filter((k) => k !== groupKey);
  if (!dst.groupKeys.includes(groupKey)) dst.groupKeys.push(groupKey);
  if (src.groupKeys.length === 0) out.splice(from, 1);
  return out;
}

/** Add a group no step assembles (e.g. "Other") as a new last step */
export function addGroupStep(
  steps: ResolvedStep[],
  groupKey: string
): StepOverride[] {
  const out = toOverrides(steps);
  out.push({ groupKeys: [groupKey] });
  return out;
}

export function updateStep(
  steps: ResolvedStep[],
  index: number,
  patch: Partial<Pick<StepOverride, "copy" | "helpers" | "hidden">>
): StepOverride[] {
  const out = toOverrides(steps);
  const step = out[index];
  if (!step) return out;
  for (const [key, value] of Object.entries(patch) as [
    keyof typeof patch,
    unknown,
  ][]) {
    if (value === undefined || value === false) delete step[key];
    else (step as unknown as Record<string, unknown>)[key] = value;
  }
  return out;
}
