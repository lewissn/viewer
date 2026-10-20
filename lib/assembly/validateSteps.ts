/**
 * Geometric Step Validator
 *
 * Checks a rule-based assembly order against the model itself. Every part is
 * reduced to its world-space bounding box at the assembled position, and each
 * step is replayed in order:
 *
 * - Supported: every part added in a step touches something already built, or
 *   something added in the same step that does. Catches shelves, handles and
 *   rails hanging in mid-air because their step came before the panel they
 *   fix to. The first carcass step is exempt — it starts the build.
 * - Insertable: a part has a clear path from outside the assembly to its place.
 *   Its box is swept along its explode direction; the path is blocked when the
 *   part would have to pass through a panel that is already fitted. Catches
 *   shelves trapped between panels and panels fitted before the parts they
 *   cover.
 *
 * Joints show up in the exports two ways: as small overlaps (12mm housings
 * and tenons, 9mm back grooves) on MDF builds, and as face contact with a
 * dowel or cam through it on cam-and-dowel builds. Neither is a collision in
 * itself. What matters is the travel: a part may push straight onto its
 * joints, and a thin panel (a back, a drawer bottom) may slide along a groove,
 * but a full-thickness panel cannot slide sideways past the tenons, dowels
 * and cams that hold its edges unless that is the direction the guide already
 * moves it in.
 *
 * When the authored explode direction is blocked but another direction is
 * clear (a shelf dropping in through a top that is already fitted, where it
 * can slide in from the open side instead), the part is insertable and the
 * clear direction is reported so the animation can follow it. Only when no
 * direction is clear is the step order itself wrong.
 *
 * repairStepOrder() then searches for the smallest reordering — moving a
 * step, or one group out of a step, earlier or later — that removes issues,
 * keeping the rule-based order wherever it already works.
 *
 * Pure module: no viewer or THREE.js dependencies, so it runs in Node for the
 * regression harness as well as in the browser.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Box {
  min: Vec3;
  max: Vec3;
}

export interface ValidationPart {
  /** Unique within the model (the controller uses the part's index) */
  id: string;
  name: string;
  /** Resolved group key — the step generator's unit of ordering */
  group: string;
  /** World-space bounds at the assembled position */
  box: Box;
  /**
   * World-space directions the part can arrive from: each points from the
   * assembled position toward where the part starts. The first is the authored
   * explode direction and is used whenever its path is clear; the rest are
   * fallbacks, tried in order of closeness to it.
   */
  directions: Vec3[];
}

export interface ValidationStep {
  groupKeys: string[];
  /**
   * Built away from the carcass as a separate sub-assembly (a drawer box on
   * the bench). Not checked and not added to the build — the step that fits
   * those groups into the cabinet is.
   */
  subassembly?: boolean;
}

export type ValidationIssueKind =
  /** Touches nothing already built — would float in mid-air */
  | "unsupported"
  /** No clear path in: every direction passes through a fitted panel */
  | "blocked"
  /** Belongs to no step of the rule-based guide (caught by the final step) */
  | "unplaced";

export interface ValidationIssue {
  /** Index into the step list that was validated */
  step: number;
  part: string;
  group: string;
  kind: ValidationIssueKind;
}

export interface ValidationOptions {
  /**
   * Groups that never block another part's path: doors swing open and drawers
   * pull out, so a shelf can still go in behind them.
   */
  openableGroups?: Iterable<string>;
  /**
   * Loose parts placed by hand (removable shelves on pins, hanging rails).
   * They can be angled in past face frames and rails, so only their support
   * is checked.
   */
  looseGroups?: Iterable<string>;
  /**
   * Parts fixed to the room rather than the cabinet (pelmets, skirting,
   * fillers). Their path in is checked, but they need not touch the cabinet.
   */
  freestandingGroups?: Iterable<string>;
  /**
   * World-space bounds of the hardware (dowels, cams, hinges). Two panels in
   * face contact with a fitting through both are pinned together, so one can
   * only be pushed onto the other, not slid along it.
   */
  fittings?: Box[];
}

export interface ValidationResult {
  issues: ValidationIssue[];
  /** Index into each checked part's `directions` of the path chosen for it */
  directionIndex: Map<string, number>;
}

export interface RepairResult<S extends ValidationStep> {
  steps: S[];
  result: ValidationResult;
  /** Human-readable list of the changes made, in order */
  moves: string[];
  /**
   * Steps (from `steps`) that a move created or repositioned. Their copy was
   * written for their original place in the order and may no longer fit.
   */
  touched: Set<S>;
}

type Axis = 0 | 1 | 2;
const AXES: Axis[] = [0, 1, 2];

interface Interval3 {
  min: [number, number, number];
  max: [number, number, number];
}

const toArr = (v: Vec3): [number, number, number] => [v.x, v.y, v.z];
const toInterval = (b: Box): Interval3 => ({ min: toArr(b.min), max: toArr(b.max) });
const extent = (b: Interval3, a: Axis) => b.max[a] - b.min[a];
const thickness = (b: Interval3) => Math.min(extent(b, 0), extent(b, 1), extent(b, 2));

/** Overlap of A (displaced by t·d) and B along one axis; negative = gap */
function overlapAt(A: Interval3, B: Interval3, d: number[], t: number, a: Axis) {
  return (
    Math.min(A.max[a] + t * d[a], B.max[a]) -
    Math.max(A.min[a] + t * d[a], B.min[a])
  );
}

/**
 * Tolerances scale with the model's panel thickness, so the checks hold
 * whatever units the model was exported in.
 */
interface Tolerances {
  /** Overlap at or below this is face contact, not interference */
  contact: number;
  /** Gap at or below this still counts as touching (inset door reveals) */
  supportGap: number;
  /** Parts thinner than this sit in grooves and may slide along them */
  thinPanel: number;
}

function computeTolerances(parts: { box: Interval3 }[]): Tolerances {
  const ts = parts
    .map((p) => thickness(p.box))
    .filter((t) => t > 0 && isFinite(t))
    .sort((p, q) => p - q);
  // Median part thickness — carcass board (18mm on every model seen so far)
  const T = ts.length > 0 ? ts[Math.floor(ts.length / 2)] : 18;
  return {
    contact: 0.05 * T,
    supportGap: 0.3 * T,
    thinPanel: 0.6 * T,
  };
}

interface PreparedPart {
  id: string;
  name: string;
  group: string;
  box: Interval3;
  /** Unit directions, in the caller's order */
  dirs: number[][];
  /** Indices into `dirs` in the order they are tried */
  order: number[];
  thin: boolean;
}

/**
 * Can A travel along -d (from far out along d) to its assembled position
 * without passing through B?
 */
function pathClear(
  A: PreparedPart,
  B: PreparedPart,
  d: number[],
  authored: boolean,
  pin: Axis | null,
  tol: Tolerances
): boolean {
  const o0 = AXES.map((a) => overlapAt(A.box, B.box, d, 0, a));

  // Engaged at the assembled position: A's edge sits in B's housing, a tenon
  // in a slot, or A is dowelled to B's face. Pushing straight into the joint
  // is how it goes together; sliding along it is only possible for a thin
  // panel in a groove, or when the guide already moves the part that way (a
  // divider slid along its housings).
  const engaged = pin !== null || AXES.every((a) => o0[a] > tol.contact);
  if (engaged) {
    let p: Axis = pin ?? 0;
    if (pin === null) for (const a of AXES) if (o0[a] < o0[p]) p = a;
    const cA = (A.box.min[p] + A.box.max[p]) / 2;
    const cB = (B.box.min[p] + B.box.max[p]) / 2;
    const side = Math.sign(cA - cB);
    const len = Math.hypot(d[0], d[1], d[2]);
    const pushesIn = side !== 0 && (d[p] * side) / len >= 0.7;
    if (!pushesIn && !(A.thin || authored)) return false;
  }

  // Never interacting: separated (or only touching) on an axis the travel
  // does not change.
  for (const a of AXES) {
    if (Math.abs(d[a]) < 1e-9 && o0[a] <= tol.contact) return true;
  }

  // Sweep: the path is blocked when, at some point on the way in, A overlaps
  // B on every axis and digs deeper on a moving axis than it does once
  // assembled — i.e. it passes through B rather than seating against it.
  const ts = new Set<number>([0]);
  for (const a of AXES) {
    if (Math.abs(d[a]) < 1e-9) continue;
    const thresholds = [0, tol.contact, o0[a] + tol.contact];
    const cands = [
      (B.box.min[a] - A.box.min[a]) / d[a],
      (B.box.max[a] - A.box.max[a]) / d[a],
      (B.box.min[a] - A.box.max[a]) / d[a],
      (B.box.max[a] - A.box.min[a]) / d[a],
    ];
    for (const c of thresholds) {
      cands.push((c + B.box.min[a] - A.box.max[a]) / d[a]);
      cands.push((B.box.max[a] - A.box.min[a] - c) / d[a]);
    }
    for (const t of cands) if (t > 0 && isFinite(t)) ts.add(t);
  }
  const sorted = [...ts].sort((p, q) => p - q);
  sorted.push(sorted[sorted.length - 1] * 2 + 1);
  for (let i = 0; i + 1 < sorted.length; i++) {
    for (const t of [(sorted[i] + sorted[i + 1]) / 2, sorted[i + 1]]) {
      const o = AXES.map((a) => overlapAt(A.box, B.box, d, t, a));
      if (!o.every((v) => v > tol.contact)) continue;
      if (AXES.some((a) => Math.abs(d[a]) > 1e-9 && o[a] > o0[a] + tol.contact)) {
        return false;
      }
    }
  }
  return true;
}

function touches(A: PreparedPart, B: PreparedPart, tol: Tolerances) {
  return AXES.every(
    (a) =>
      Math.min(A.box.max[a], B.box.max[a]) - Math.max(A.box.min[a], B.box.min[a]) >=
      -tol.supportGap
  );
}

/**
 * The axis two panels are dowelled or cammed together along: they meet face
 * to face on that axis and the joint carries a fitting — either one passing
 * into both panels (a dowel), or a flat connector symbol lying across the
 * joint, which is how the exports mark each cam connector. A fitting buried
 * in one panel and only touching the other (a screw block) leaves the panel
 * free to slide. Null if they are not pinned.
 */
function pinAxis(
  A: PreparedPart,
  B: PreparedPart,
  fittings: Interval3[],
  tol: Tolerances
): Axis | null {
  const o = AXES.map(
    (a) => Math.min(A.box.max[a], B.box.max[a]) - Math.max(A.box.min[a], B.box.min[a])
  );
  if (o.some((v) => v < -tol.contact)) return null;
  const faces = AXES.filter((a) => o[a] <= tol.contact);
  if (faces.length !== 1) return null;
  const overlapWith = (f: Interval3, P: PreparedPart) =>
    AXES.map((a) => Math.min(f.max[a], P.box.max[a]) - Math.max(f.min[a], P.box.min[a]));
  const enters = (f: Interval3, P: PreparedPart) =>
    overlapWith(f, P).every((v) => v > tol.contact);
  const meets = (f: Interval3, P: PreparedPart) =>
    overlapWith(f, P).every((v) => v > -tol.contact);
  const isMarker = (f: Interval3) => thickness(f) <= tol.contact;
  return fittings.some(
    (f) => (enters(f, A) && enters(f, B)) || (isMarker(f) && meets(f, A) && meets(f, B))
  )
    ? faces[0]
    : null;
}

function prepare(parts: ValidationPart[], fittingBoxes: Box[] = []) {
  const boxes = parts.map((p) => toInterval(p.box));
  const tol = computeTolerances(boxes.map((box) => ({ box })));
  const fittings = fittingBoxes.map(toInterval);
  const pinCache = new Map<string, Axis | null>();
  const pinned = (A: PreparedPart, B: PreparedPart) => {
    const key = `${A.id}|${B.id}`;
    let axis = pinCache.get(key);
    if (axis === undefined) {
      axis = pinAxis(A, B, fittings, tol);
      pinCache.set(key, axis);
    }
    return axis;
  };

  // Model centre, to rank fallback directions: of two equally good ones, the
  // one leading out of the nearer face of the model is the natural way in.
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const b of boxes) {
    for (const a of AXES) {
      lo[a] = Math.min(lo[a], b.min[a]);
      hi[a] = Math.max(hi[a], b.max[a]);
    }
  }

  const prepared: PreparedPart[] = parts.map((p, i) => {
    const box = boxes[i];
    const norm = (v: Vec3) => {
      const l = Math.hypot(v.x, v.y, v.z) || 1;
      return [v.x / l, v.y / l, v.z / l];
    };
    const [first, ...rest] = p.directions.map(norm);
    const outward = (d: number[]) =>
      AXES.reduce<number>((s, a) => {
        const half = (hi[a] - lo[a]) / 2 || 1;
        const c = (box.min[a] + box.max[a]) / 2 - (lo[a] + hi[a]) / 2;
        return s + (d[a] * c) / half;
      }, 0);
    const dot = (u: number[], v: number[]) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
    const ranked = first
      ? rest
          .map((d, k) => ({ d, k }))
          .sort(
            (u, v) =>
              dot(v.d, first) - dot(u.d, first) ||
              outward(v.d) - outward(u.d) ||
              u.k - v.k
          )
      : [];
    return {
      id: p.id,
      name: p.name,
      group: p.group,
      box,
      // Keep the caller's indices so the chosen one can be reported back
      dirs: first ? [first, ...rest] : [],
      order: first ? [0, ...ranked.map((r) => r.k + 1)] : [],
      thin: thickness(box) < tol.thinPanel,
    };
  });

  return { prepared, tol, pinned };
}

/**
 * Replay the steps in order and report every part that is unsupported or
 * cannot be inserted. Parts in groups no step mentions are ignored here — the
 * controller reports those as "unplaced" when it collects them into a final
 * step.
 */
export function validateSteps(
  parts: ValidationPart[],
  steps: ValidationStep[],
  options: ValidationOptions = {}
): ValidationResult {
  return validatePrepared(prepare(parts, options.fittings), steps, options);
}

function validatePrepared(
  ctx: ReturnType<typeof prepare>,
  steps: ValidationStep[],
  options: ValidationOptions
): ValidationResult {
  const { prepared, tol, pinned } = ctx;
  const openable = new Set(options.openableGroups ?? []);
  const loose = new Set(options.looseGroups ?? []);
  const freestanding = new Set(options.freestandingGroups ?? []);
  const byGroup = new Map<string, PreparedPart[]>();
  for (const p of prepared) {
    const list = byGroup.get(p.group) ?? [];
    list.push(p);
    byGroup.set(p.group, list);
  }

  const issues: ValidationIssue[] = [];
  const directionIndex = new Map<string, number>();
  const built: PreparedPart[] = [];
  let carcassStarted = false;

  steps.forEach((step, stepIdx) => {
    if (step.subassembly) return;
    const added = step.groupKeys.flatMap((k) => byGroup.get(k) ?? []);
    if (added.length === 0) return;

    // ── Insertable ──
    const blockers = built.filter((b) => !openable.has(b.group));
    for (const part of added) {
      if (loose.has(part.group)) {
        directionIndex.set(part.id, 0);
        continue;
      }
      let chosen = -1;
      for (const k of part.order) {
        const d = part.dirs[k];
        if (blockers.every((b) => pathClear(part, b, d, k === 0, pinned(part, b), tol))) {
          chosen = k;
          break;
        }
      }
      if (chosen >= 0) directionIndex.set(part.id, chosen);
      else
        issues.push({ step: stepIdx, part: part.name, group: part.group, kind: "blocked" });
    }

    // ── Supported ──
    // Flood out from everything already built through contacts among this
    // step's parts. The first carcass step starts the build, so it is exempt
    // (the assembly-first flow lays out loose dividers that only the next
    // step's shelves join up).
    const reached = new Set<PreparedPart>();
    const queue: PreparedPart[] = [];
    for (const p of added) {
      if (
        !carcassStarted ||
        freestanding.has(p.group) ||
        built.some((b) => touches(p, b, tol))
      ) {
        reached.add(p);
        queue.push(p);
      }
    }
    while (queue.length) {
      const cur = queue.pop()!;
      for (const p of added) {
        if (!reached.has(p) && touches(cur, p, tol)) {
          reached.add(p);
          queue.push(p);
        }
      }
    }
    for (const p of added) {
      if (!reached.has(p)) {
        issues.push({ step: stepIdx, part: p.name, group: p.group, kind: "unsupported" });
      }
    }

    built.push(...added);
    carcassStarted = true;
  });

  return { issues, directionIndex };
}

/**
 * Find the smallest change to the step order that removes validation issues.
 *
 * Works on the first failing step each round. Candidates are: moving that
 * whole step to another position, bringing a later step forward to just
 * before it (the panel a floating part needs), and moving just the failing
 * group out of it — into another existing step, or into a step of its own.
 * The candidate with
 * the fewest remaining issues wins, ties going to the smallest move, and a
 * move is only taken if it strictly reduces the issue count, so the
 * rule-based order is kept wherever it already validates.
 *
 * `split` builds the step used when a group is moved out on its own.
 */
export function repairStepOrder<S extends ValidationStep>(
  parts: ValidationPart[],
  initial: S[],
  split: (group: string, from: S) => S,
  options: ValidationOptions = {},
  maxRounds = 12
): RepairResult<S> {
  const ctx = prepare(parts, options.fittings);
  const run = (steps: S[]) => validatePrepared(ctx, steps, options);
  const countOf = (r: ValidationResult) => r.issues.length;

  let steps = initial.slice();
  let result = run(steps);
  const moves: string[] = [];
  let touched = new Set<S>();

  // Groups that also appear in a sub-assembly step (drawers) move only as a
  // whole step, so the sub-assembly and the fitting step stay paired.
  const subGroups = new Set(
    initial.filter((s) => s.subassembly).flatMap((s) => s.groupKeys)
  );
  const label = (s: S) => s.groupKeys.join(" + ");
  // The step that starts the build is exempt from the support check, so a
  // move must never hand that role to another step.
  const anchorOf = (list: S[]) => list.find((s) => !s.subassembly);

  for (let round = 0; round < maxRounds && result.issues.length > 0; round++) {
    const firstStep = Math.min(...result.issues.map((i) => i.step));
    const failing = steps[firstStep];
    const failingGroups = [
      ...new Set(result.issues.filter((i) => i.step === firstStep).map((i) => i.group)),
    ];

    interface Candidate {
      steps: S[];
      result: ValidationResult;
      cost: number;
      desc: string;
      moved: S[];
    }
    let best: Candidate | null = null;
    const consider = (cand: S[], cost: number, desc: string, moved: S[]) => {
      if (anchorOf(cand) !== anchorOf(steps)) return;
      const r = run(cand);
      if (countOf(r) >= countOf(result)) return;
      if (
        !best ||
        countOf(r) < countOf(best.result) ||
        (countOf(r) === countOf(best.result) && cost < best.cost)
      ) {
        best = { steps: cand, result: r, cost, desc, moved };
      }
    };

    // Whole step to another position (sub-assembly steps stay put)
    for (let j = 0; j < steps.length; j++) {
      if (j === firstStep || steps[j].subassembly) continue;
      const cand = steps.slice();
      cand.splice(firstStep, 1);
      cand.splice(j, 0, failing);
      consider(
        cand,
        Math.abs(j - firstStep),
        `moved step "${label(failing)}" ${j < firstStep ? "earlier" : "later"} (${firstStep + 1} → ${j + 1})`,
        [failing]
      );
    }

    // An earlier step pushed back to just after it — a panel in its way
    for (let k = 0; k < firstStep; k++) {
      if (steps[k].subassembly) continue;
      const cand = steps.slice();
      const [moved] = cand.splice(k, 1);
      cand.splice(firstStep, 0, moved);
      consider(
        cand,
        firstStep - k,
        `moved step "${label(moved)}" later (${k + 1} → ${firstStep + 1}), after "${label(failing)}"`,
        [moved]
      );
    }

    // A later step brought forward to just before it — the panel a floating
    // part fixes to, or one it has to go in ahead of
    for (let k = firstStep + 1; k < steps.length; k++) {
      if (steps[k].subassembly) continue;
      const cand = steps.slice();
      const [moved] = cand.splice(k, 1);
      cand.splice(firstStep, 0, moved);
      consider(
        cand,
        k - firstStep,
        `moved step "${label(moved)}" earlier (${k + 1} → ${firstStep + 1}), ahead of "${label(failing)}"`,
        [moved]
      );
    }

    // One failing group out of a multi-group step
    if (failing.groupKeys.length > 1) {
      for (const g of failingGroups) {
        if (subGroups.has(g)) continue;
        const rest = { ...failing, groupKeys: failing.groupKeys.filter((k) => k !== g) };
        const base = steps.slice();
        base[firstStep] = rest;

        // ...into another existing step
        for (let j = 0; j < base.length; j++) {
          if (j === firstStep || base[j].subassembly) continue;
          const cand = base.slice();
          const merged = { ...cand[j], groupKeys: [...cand[j].groupKeys, g] };
          cand[j] = merged;
          consider(
            cand,
            Math.abs(j - firstStep) + 0.25,
            `moved "${g}" from step ${firstStep + 1} into step ${j + 1} ("${label(base[j])}")`,
            [rest, merged]
          );
        }

        // ...into a step of its own
        for (let j = 0; j <= base.length; j++) {
          const cand = base.slice();
          const own = split(g, failing);
          cand.splice(j, 0, own);
          consider(
            cand,
            Math.abs(j - firstStep) + 0.5,
            `moved "${g}" out of step ${firstStep + 1} into its own step at ${j + 1}`,
            [rest, own]
          );
        }
      }
    }

    if (!best) break;
    const chosen: Candidate = best;
    steps = chosen.steps;
    result = chosen.result;
    moves.push(chosen.desc);
    touched = new Set(
      [...touched, ...chosen.moved].filter((s) => steps.includes(s))
    );
  }

  return { steps, result, moves, touched };
}
