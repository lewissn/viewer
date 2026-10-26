"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type {
  CabinetInstance,
  GuideOverrides,
  StepOverride,
} from "@/lib/projects";
import type { StepHelper } from "@/lib/assemblyGuides";
import type { GeneratedStep } from "@/lib/classifyPart";
import {
  AssemblyGuideController,
  type ControllerState,
} from "@/lib/assemblyGuideController";
import {
  addGroupStep,
  canCombine,
  mergeWithNext,
  moveGroup,
  moveStep,
  resolveGuideSteps,
  splitGroup,
  unplacedGroups,
  updateStep,
  type ResolvedStep,
} from "@/lib/assembly/applyOverrides";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Admin guide editor for one cabinet: the cabinet's model in the real guide
 * controller next to its step list. Staff reorder, merge, split and reword
 * steps, hide steps and exclude stray parts; the preview rebuilds as they go.
 * Saving hands the resulting GuideOverrides back to the project page.
 */

type Flags = Pick<
  GuideOverrides,
  "bottomOverlaysSides" | "topOverlaysSides" | "backFixedToCarcass"
>;

interface Draft {
  /** Undefined = automatic step list */
  steps?: StepOverride[];
  excluded: string[];
  flags: Flags;
}

interface Snapshot {
  generatedSteps: GeneratedStep[];
  groupParts: Record<string, string[]>;
  /** Steps the guide puts before the editable ones (fitting the face frames) */
  leadSteps: number;
}

interface Props {
  cabinet: CabinetInstance;
  /** Cabinet label shown in the header */
  title: string;
  /** Persist the cabinet's new overrides. Resolves to an error message, or null on success. */
  onSave: (overrides: GuideOverrides) => Promise<string | null>;
  onClose: () => void;
}

function draftFrom(o?: GuideOverrides): Draft {
  return {
    steps: o?.steps,
    excluded: o?.excludedParts ?? [],
    flags: {
      bottomOverlaysSides: o?.bottomOverlaysSides,
      topOverlaysSides: o?.topOverlaysSides,
      backFixedToCarcass: o?.backFixedToCarcass,
    },
  };
}

/** What the guide controller needs; text edits don't change the 3D preview */
function previewOverrides(d: Draft): GuideOverrides {
  return {
    ...d.flags,
    steps: d.steps?.map(({ groupKeys, drawerMode, hidden }) => ({
      groupKeys,
      drawerMode,
      hidden,
    })),
    excludedParts: d.excluded,
  };
}

const structureKey = (d: Draft) => JSON.stringify(previewOverrides(d));
const draftKey = (d: Draft) => JSON.stringify(d);

/** Index in the customer guide (hidden steps skipped) for a step in the full list */
function activeIndexFor(steps: ResolvedStep[], index: number): number {
  if (index < 0 || index >= steps.length) return -1;
  const before = steps.slice(0, index).filter((s) => !s.hidden).length;
  return steps[index].hidden ? before - 1 : before;
}

function resolve(snap: Snapshot, steps?: StepOverride[]) {
  return resolveGuideSteps(
    snap.generatedSteps,
    { steps },
    Object.keys(snap.groupParts)
  );
}

export default function GuideEditor({ cabinet, title, onSave, onClose }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<any>(null);
  const ovRef = useRef<any>(null);
  const controllerRef = useRef<AssemblyGuideController | null>(null);

  const [initialDraft] = useState(() => draftFrom(cabinet.guideOverrides));
  const [draft, setDraft] = useState<Draft>(initialDraft);
  // Latest draft, for the viewer callback that runs when the model loads
  const draftRef = useRef<Draft>(initialDraft);
  const [savedKey, setSavedKey] = useState(() => draftKey(initialDraft));
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [ctrl, setCtrl] = useState<ControllerState | null>(null);
  const [loadError, setLoadError] = useState("");
  const [selected, setSelected] = useState(-1);
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  const [pickedPart, setPickedPart] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(
    null
  );

  // ── Viewer + controller ──

  const modelUrl = cabinet.modelFileUrl;
  const textureKey = (cabinet.textureFileUrls ?? []).join("\n");
  // Fixed for the cabinet: the editor only changes its overrides
  const [fittingLocations] = useState(() => cabinet.fittingLocations);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !modelUrl) return;
    let cancelled = false;
    let downOnCanvas = false;
    const onMouseDown = (e: MouseEvent) => {
      downOnCanvas =
        e.target instanceof HTMLCanvasElement && container.contains(e.target);
    };

    (async () => {
      const OV = await import("online-3d-viewer");
      if (cancelled) return;
      ovRef.current = OV;
      container.innerHTML = "";

      const controller = new AssemblyGuideController();
      controllerRef.current = controller;
      controller.subscribe((s) => setCtrl({ ...s }));

      const viewer = new OV.EmbeddedViewer(container, {
        backgroundColor: new OV.RGBAColor(240, 238, 235, 255),
        defaultColor: new OV.RGBColor(200, 200, 200),
        edgeSettings: new OV.EdgeSettings(false, new OV.RGBColor(68, 68, 68), 1),
        onModelLoaded: () => {
          if (cancelled) return;
          controller.initDynamic(viewer, OV, previewOverrides(draftRef.current), fittingLocations);
          setSnapshot(controller.getEditorSnapshot());
        },
        onModelLoadFailed: () => {
          setLoadError("The 3D model could not be loaded. Check the model URL.");
        },
      });
      viewerRef.current = viewer;

      // Click a part to see its name (and exclude it if it's a stray mesh).
      // The viewer takes any mouseup on the page after a canvas click as
      // another click, so only count clicks that started on the canvas.
      window.addEventListener("mousedown", onMouseDown, true);
      const inner = viewer.GetViewer();
      inner.SetMouseClickHandler(
        (button: number, coords: { x: number; y: number }) => {
          if (button !== 1 || !downOnCanvas) return;
          const ud = inner.GetMeshUserDataUnderMouse(
            OV.IntersectionMode.MeshOnly,
            coords
          );
          const mi = ud?.originalMeshInstance;
          const name = mi
            ? mi.node?.GetName?.() || mi.GetMesh?.()?.GetName?.() || null
            : null;
          setPickedPart(name);
        }
      );

      const textures = textureKey.split("\n").filter((u) => u.trim());
      viewer.LoadModelFromUrlList([modelUrl, ...textures]);
    })();

    return () => {
      cancelled = true;
      window.removeEventListener("mousedown", onMouseDown, true);
      controllerRef.current?.destroy();
      controllerRef.current = null;
      try {
        viewerRef.current?.Destroy();
      } catch {
        // Already destroyed
      }
      viewerRef.current = null;
    };
  }, [modelUrl, textureKey, fittingLocations]);

  /** Re-run the guide controller with a new step structure */
  function rebuildPreview(d: Draft): Snapshot | null {
    const c = controllerRef.current;
    const viewer = viewerRef.current;
    const OV = ovRef.current;
    if (!c || !viewer || !OV || !snapshot) return snapshot;
    c.close(); // back to assembled positions before parts are re-collected
    c.initDynamic(viewer, OV, previewOverrides(d), fittingLocations);
    const snap = c.getEditorSnapshot();
    setSnapshot(snap);
    return snap;
  }

  function showStep(snap: Snapshot | null, d: Draft, index: number) {
    const c = controllerRef.current;
    if (!c || !snap) return;
    const ai = activeIndexFor(resolve(snap, d.steps).steps, index);
    if (ai < 0) c.restart();
    else c.jumpToStep(ai + snap.leadSteps);
  }

  /** Apply an edit: update the draft, rebuild the preview if the steps changed shape */
  function commit(next: Draft, nextSelected = selected) {
    const structural = structureKey(next) !== structureKey(draft);
    draftRef.current = next;
    setDraft(next);
    setSelected(nextSelected);
    setMessage(null);
    const snap = structural ? rebuildPreview(next) : snapshot;
    if (structural || nextSelected !== selected) {
      showStep(snap, next, nextSelected);
    }
  }

  function select(index: number) {
    setSelected(index);
    showStep(snapshot, draft, index);
  }

  // ── Derived ──

  const resolved = useMemo(
    () => (snapshot ? resolve(snapshot, draft.steps) : null),
    [snapshot, draft.steps]
  );
  const steps = resolved?.steps ?? [];
  const unplaced = useMemo(
    () =>
      resolved && snapshot
        ? unplacedGroups(resolved, Object.keys(snapshot.groupParts))
        : [],
    [resolved, snapshot]
  );
  const visibleCount = steps.filter((s) => !s.hidden).length;
  const isCustomised = draft.steps !== undefined || draft.excluded.length > 0;
  const dirty = draftKey(draft) !== savedKey;
  const partCount = (g: string) => snapshot?.groupParts[g]?.length ?? 0;
  const groupOf = (name: string) =>
    Object.entries(snapshot?.groupParts ?? {}).find(([, names]) =>
      names.includes(name)
    )?.[0];

  // ── Edits ──

  const setSteps = (next: StepOverride[], nextSelected = selected) =>
    commit({ ...draft, steps: next }, nextSelected);

  function excludePart(name: string) {
    if (draft.excluded.includes(name)) return;
    commit({ ...draft, excluded: [...draft.excluded, name] });
    setPickedPart(null);
  }

  function restorePart(name: string) {
    commit({ ...draft, excluded: draft.excluded.filter((n) => n !== name) });
  }

  function setFlag<K extends keyof Flags>(key: K, value: Flags[K]) {
    commit({ ...draft, flags: { ...draft.flags, [key]: value } });
  }

  function resetToAutomatic() {
    commit({ ...draft, steps: undefined, excluded: [] }, -1);
  }

  async function handleSave() {
    setSaving(true);
    setMessage(null);
    // Keep anything else stored on the cabinet (e.g. explode offsets), drop
    // the retired stepOrder/stepCopy fields, then write the draft over it.
    const rest: Record<string, unknown> = { ...cabinet.guideOverrides };
    for (const key of [
      "steps",
      "excludedParts",
      "stepOrder",
      "stepCopy",
      "bottomOverlaysSides",
      "topOverlaysSides",
      "backFixedToCarcass",
    ]) {
      delete rest[key];
    }
    const overrides: GuideOverrides = {
      ...(rest as GuideOverrides),
      ...draft.flags,
      ...(draft.steps ? { steps: draft.steps } : {}),
      ...(draft.excluded.length ? { excludedParts: draft.excluded } : {}),
    };
    const error = await onSave(overrides);
    setSaving(false);
    if (error) {
      setMessage({ ok: false, text: error });
    } else {
      setSavedKey(draftKey(draft));
      setMessage({ ok: true, text: "Guide saved." });
    }
  }

  function handleClose() {
    if (dirty && !window.confirm("Discard your unsaved guide changes?")) return;
    onClose();
  }

  // ── Preview controls ──

  const visibleIndices = steps
    .map((s, i) => (s.hidden ? -1 : i))
    .filter((i) => i >= 0);
  const selectedActive = activeIndexFor(steps, selected);
  const selectedStep = selected >= 0 ? steps[selected] : null;

  function stepBy(delta: number) {
    const pos = visibleIndices.indexOf(selected);
    const nextPos =
      pos < 0 ? (delta > 0 ? 0 : visibleIndices.length - 1) : pos + delta;
    if (nextPos < 0) return select(-1);
    if (nextPos >= visibleIndices.length) return;
    select(visibleIndices[nextPos]);
  }

  async function playStep() {
    const c = controllerRef.current;
    if (!c || !selectedStep || selectedStep.hidden) return;
    // The guide may open with steps of its own (fitting the face frames)
    const target = selectedActive + (snapshot?.leadSteps ?? 0);
    if (target <= 0) c.restart();
    else c.jumpToStep(target - 1);
    await c.next();
  }

  const animating = ctrl?.isAnimating ?? false;

  // ── Render ──

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-[#fafafa]">
      {/* Header */}
      <header className="flex shrink-0 items-center gap-3 border-b border-[#e5e5ea] bg-white px-4 py-3">
        <button
          onClick={handleClose}
          className="rounded-lg px-2 py-1 text-[13px] text-[#0071e3] hover:bg-[#f5f5f7]"
        >
          &larr; Back to project
        </button>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[16px] font-semibold text-[#1d1d1f]">
            Edit guide &middot; {title}
          </h2>
          <p className="text-[12px] text-[#86868b]">
            {snapshot
              ? `${visibleCount} steps for the customer${
                  steps.length > visibleCount
                    ? ` · ${steps.length - visibleCount} hidden`
                    : ""
                }`
              : "Loading model…"}
          </p>
        </div>
        <StatusBadge customised={isCustomised} dirty={dirty} />
        {isCustomised && (
          <button
            onClick={resetToAutomatic}
            disabled={!snapshot}
            className="rounded-lg px-3 py-1.5 text-[13px] font-medium text-[#1d1d1f] hover:bg-[#f5f5f7] disabled:opacity-50"
          >
            Reset to automatic
          </button>
        )}
        <button
          onClick={handleSave}
          disabled={saving || !dirty}
          className="rounded-xl bg-[#0071e3] px-4 py-2 text-[13px] font-medium text-white transition-all hover:bg-[#0077ed] active:scale-[0.98] disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save guide"}
        </button>
      </header>

      {message && (
        <div
          className={`shrink-0 px-4 py-2 text-[13px] ${
            message.ok
              ? "bg-[#f0fdf4] text-[#166534]"
              : "bg-[#fef2f2] text-[#991b1b]"
          }`}
        >
          {message.text}
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        {/* Preview */}
        <section className="relative h-[45vh] shrink-0 md:h-auto md:flex-1">
          <div ref={containerRef} className="absolute inset-0" />

          {!snapshot && !loadError && (
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-[#d2d2d7] border-t-[#0071e3]" />
            </div>
          )}
          {loadError && (
            <div className="absolute inset-0 flex items-center justify-center p-6 text-center text-[14px] text-[#dc2626]">
              {loadError}
            </div>
          )}

          {/* Clicked part */}
          {pickedPart && (
            <div className="absolute left-3 top-3 flex max-w-[calc(100%-24px)] items-center gap-3 rounded-xl bg-white/95 px-3 py-2 text-[12px] shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_4px_16px_rgba(0,0,0,0.08)]">
              <div className="min-w-0">
                <p className="truncate font-mono text-[#1d1d1f]">{pickedPart}</p>
                <p className="text-[#86868b]">
                  {groupOf(pickedPart) ?? "Fitting (shown only when finished)"}
                </p>
              </div>
              <button
                onClick={() => excludePart(pickedPart)}
                className="shrink-0 rounded-lg border border-[#d2d2d7] px-2 py-1 font-medium text-[#1d1d1f] hover:bg-[#f5f5f7]"
              >
                Exclude from guide
              </button>
              <button
                onClick={() => setPickedPart(null)}
                aria-label="Close part info"
                className="shrink-0 rounded-md px-1.5 text-[#86868b] hover:bg-[#f5f5f7]"
              >
                &times;
              </button>
            </div>
          )}

          {selectedStep?.hidden && (
            <div className="absolute right-3 top-3 rounded-lg bg-[#1d1d1f]/80 px-3 py-1.5 text-[12px] text-white">
              Hidden step &mdash; customers skip it
            </div>
          )}

          {/* Step controls */}
          {snapshot && (
            <div className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-xl bg-white/95 p-1 text-[13px] shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_4px_16px_rgba(0,0,0,0.08)]">
              <PreviewButton onClick={() => select(-1)} active={selected < 0}>
                Finished
              </PreviewButton>
              <PreviewButton onClick={() => stepBy(-1)} label="Previous step">
                &lsaquo;
              </PreviewButton>
              <span className="min-w-[96px] text-center tabular-nums text-[#1d1d1f]">
                {selected < 0
                  ? `${visibleCount} steps`
                  : selectedStep?.hidden
                    ? "Hidden step"
                    : `Step ${selectedActive + 1} of ${visibleCount}`}
              </span>
              <PreviewButton onClick={() => stepBy(1)} label="Next step">
                &rsaquo;
              </PreviewButton>
              <PreviewButton
                onClick={playStep}
                disabled={!selectedStep || selectedStep.hidden || animating}
              >
                Play step
              </PreviewButton>
            </div>
          )}
        </section>

        {/* Steps */}
        <aside className="min-h-0 flex-1 overflow-y-auto border-t border-[#e5e5ea] bg-white md:w-[440px] md:flex-none md:border-l md:border-t-0">
          {snapshot && resolved && (
            <div className="space-y-4 p-4">
              <Notices
                appended={resolved.appendedGroups}
                stale={resolved.staleGroups}
                unplaced={unplaced}
                excluded={draft.excluded}
                partCount={partCount}
                onAddGroup={(g) => setSteps(addGroupStep(steps, g), steps.length)}
                onRestorePart={restorePart}
              />

              <Construction flags={draft.flags} onChange={setFlag} />

              <ol className="space-y-2">
                {steps.map((step, i) => (
                  <StepCard
                    key={`${i}:${step.drawerMode ?? ""}:${step.groupKeys.join("|")}`}
                    step={step}
                    index={i}
                    steps={steps}
                    number={step.hidden ? null : activeIndexFor(steps, i) + 1}
                    selected={selected === i}
                    openGroups={openGroups}
                    partsOf={(g) => snapshot.groupParts[g] ?? []}
                    onSelect={() => select(selected === i ? -1 : i)}
                    onToggleGroup={(g) =>
                      setOpenGroups((o) => ({ ...o, [g]: !o[g] }))
                    }
                    onMove={(to) => setSteps(moveStep(steps, i, to), to)}
                    onMerge={() => setSteps(mergeWithNext(steps, i), i)}
                    onSplit={(g) => setSteps(splitGroup(steps, i, g), i)}
                    onMoveGroup={(g, to) => {
                      const next = moveGroup(steps, i, g, to);
                      const emptied = next.length < steps.length;
                      setSteps(next, emptied && to > i ? to - 1 : to);
                    }}
                    onUpdate={(patch) => setSteps(updateStep(steps, i, patch))}
                    onExcludePart={excludePart}
                  />
                ))}
              </ol>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

// ── Pieces ──

function StatusBadge({ customised, dirty }: { customised: boolean; dirty: boolean }) {
  if (dirty) {
    return (
      <span className="rounded-full bg-[#fffbeb] px-2.5 py-1 text-[12px] font-medium text-[#92400e]">
        Unsaved changes
      </span>
    );
  }
  return customised ? (
    <span className="rounded-full bg-[#eff6ff] px-2.5 py-1 text-[12px] font-medium text-[#0071e3]">
      Edited guide
    </span>
  ) : (
    <span className="rounded-full bg-[#f5f5f7] px-2.5 py-1 text-[12px] font-medium text-[#424245]">
      Automatic guide
    </span>
  );
}

function PreviewButton({
  children,
  onClick,
  disabled,
  active,
  label,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  label?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={`whitespace-nowrap rounded-lg px-3 py-1.5 font-medium transition-colors disabled:opacity-40 ${
        active ? "bg-[#1d1d1f] text-white" : "text-[#1d1d1f] hover:bg-[#f5f5f7]"
      }`}
    >
      {children}
    </button>
  );
}

function Notices({
  appended,
  stale,
  unplaced,
  excluded,
  partCount,
  onAddGroup,
  onRestorePart,
}: {
  appended: string[];
  stale: string[];
  unplaced: string[];
  excluded: string[];
  partCount: (g: string) => number;
  onAddGroup: (g: string) => void;
  onRestorePart: (name: string) => void;
}) {
  return (
    <>
      {appended.length > 0 && (
        <div className="rounded-xl border border-[#fde68a] bg-[#fffbeb] px-3 py-2.5 text-[12px] text-[#92400e]">
          <p className="font-medium">New in this model</p>
          <p className="mt-0.5">
            {appended.join(", ")} {appended.length === 1 ? "isn't" : "aren't"} in
            the saved order, so {appended.length === 1 ? "it was" : "they were"}{" "}
            added at the end. Move the steps marked &ldquo;New&rdquo; into place,
            then save.
          </p>
        </div>
      )}
      {stale.length > 0 && (
        <div className="rounded-xl bg-[#f5f5f7] px-3 py-2.5 text-[12px] text-[#424245]">
          No longer in the model, so left out: {stale.join(", ")}.
        </div>
      )}
      {unplaced.length > 0 && (
        <div className="rounded-xl bg-[#f5f5f7] px-3 py-2.5 text-[12px] text-[#424245]">
          <p>
            Not in any step &mdash; customers only see these on the finished
            cabinet:
          </p>
          <ul className="mt-1.5 space-y-1">
            {unplaced.map((g) => (
              <li key={g} className="flex items-center justify-between gap-2">
                <span>
                  {g}{" "}
                  <span className="text-[#86868b]">&middot; {partCount(g)} parts</span>
                </span>
                <button
                  onClick={() => onAddGroup(g)}
                  className="text-[12px] font-medium text-[#0071e3] hover:underline"
                >
                  Add as step
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {excluded.length > 0 && (
        <div className="rounded-xl bg-[#f5f5f7] px-3 py-2.5 text-[12px] text-[#424245]">
          <p>Excluded from the guide:</p>
          <ul className="mt-1.5 space-y-1">
            {excluded.map((name) => (
              <li key={name} className="flex items-center justify-between gap-2">
                <span className="truncate font-mono">{name}</span>
                <button
                  onClick={() => onRestorePart(name)}
                  className="shrink-0 text-[12px] font-medium text-[#0071e3] hover:underline"
                >
                  Restore
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

function Construction({
  flags,
  onChange,
}: {
  flags: Flags;
  onChange: <K extends keyof Flags>(key: K, value: Flags[K]) => void;
}) {
  const triState = (v: boolean | undefined) =>
    v === undefined ? "auto" : v ? "yes" : "no";
  const fromTriState = (v: string) => (v === "auto" ? undefined : v === "yes");
  const select =
    "rounded-lg border border-[#d2d2d7] bg-white px-2 py-1 text-[12px] text-[#1d1d1f] outline-none focus:border-[#0071e3]";

  return (
    <details className="rounded-xl border border-[#e5e5ea] px-3 py-2.5">
      <summary className="cursor-pointer text-[12px] font-medium text-[#424245]">
        Construction (changes the automatic order)
      </summary>
      <div className="mt-2 space-y-2 text-[12px] text-[#424245]">
        <label className="flex items-center justify-between gap-2">
          Bottom overlays sides (upper unit)
          <select
            className={select}
            value={flags.bottomOverlaysSides ? "yes" : "no"}
            onChange={(e) =>
              onChange("bottomOverlaysSides", e.target.value === "yes" || undefined)
            }
          >
            <option value="no">No</option>
            <option value="yes">Yes</option>
          </select>
        </label>
        <label className="flex items-center justify-between gap-2">
          Top overlays sides
          <select
            className={select}
            value={triState(flags.topOverlaysSides)}
            onChange={(e) => onChange("topOverlaysSides", fromTriState(e.target.value))}
          >
            <option value="auto">Auto-detect</option>
            <option value="yes">Yes</option>
            <option value="no">No</option>
          </select>
        </label>
        <label className="flex items-center justify-between gap-2">
          Full-thickness back
          <select
            className={select}
            value={triState(flags.backFixedToCarcass)}
            onChange={(e) =>
              onChange("backFixedToCarcass", fromTriState(e.target.value))
            }
          >
            <option value="auto">Auto-detect</option>
            <option value="yes">Yes</option>
            <option value="no">No</option>
          </select>
        </label>
      </div>
    </details>
  );
}

const DRAWER_MODE_LABEL: Record<string, string> = {
  assembleFirst: "Builds one drawer",
  insertAll: "Slides drawers in",
};

const SOURCE_NOTE: Record<string, string> = {
  auto: "Automatic text",
  derived: "Taken from the automatic steps these parts came from — check it reads right",
  override: "Edited",
};

function StepCard({
  step,
  index,
  steps,
  number,
  selected,
  openGroups,
  partsOf,
  onSelect,
  onToggleGroup,
  onMove,
  onMerge,
  onSplit,
  onMoveGroup,
  onUpdate,
  onExcludePart,
}: {
  step: ResolvedStep;
  index: number;
  steps: ResolvedStep[];
  number: number | null;
  selected: boolean;
  openGroups: Record<string, boolean>;
  partsOf: (g: string) => string[];
  onSelect: () => void;
  onToggleGroup: (g: string) => void;
  onMove: (to: number) => void;
  onMerge: () => void;
  onSplit: (g: string) => void;
  onMoveGroup: (g: string, to: number) => void;
  onUpdate: (patch: Partial<Pick<StepOverride, "copy" | "helpers" | "hidden">>) => void;
  onExcludePart: (name: string) => void;
}) {
  const next = steps[index + 1];
  const canMerge = !!next && canCombine(step, next);
  const targets = steps
    .map((s, i) => ({ s, i }))
    .filter(({ s, i }) => i !== index && canCombine(step, s));
  const helpers = step.helpers ?? [];
  const setHelpers = (h: StepHelper[]) => onUpdate({ helpers: h });

  return (
    <li
      className={`rounded-xl border transition-colors ${
        selected
          ? "border-[#0071e3] shadow-[0_0_0_3px_rgba(0,113,227,0.12)]"
          : "border-[#e5e5ea] hover:border-[#d2d2d7]"
      } ${step.hidden ? "bg-[#fafafa]" : "bg-white"}`}
    >
      {/* Summary row */}
      <div className="flex items-start gap-2 p-3">
        <button
          onClick={onSelect}
          className="flex min-w-0 flex-1 items-start gap-2.5 text-left"
          aria-expanded={selected}
        >
          <span
            className={`mt-0.5 flex h-6 min-w-6 shrink-0 items-center justify-center rounded-full px-1.5 text-[12px] font-semibold ${
              step.hidden
                ? "bg-[#e5e5ea] text-[#86868b]"
                : "bg-[#1d1d1f] text-white"
            }`}
          >
            {number ?? "–"}
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap gap-1">
              {step.groupKeys.map((g) => (
                <span
                  key={g}
                  className="rounded-md bg-[#f5f5f7] px-1.5 py-0.5 text-[11px] text-[#424245]"
                >
                  {g} <span className="text-[#86868b]">{partsOf(g).length}</span>
                </span>
              ))}
              {step.origin === "appended" && <Tag tone="amber">New</Tag>}
              {step.hidden && <Tag tone="grey">Hidden</Tag>}
              {step.drawerMode && (
                <Tag tone="grey">{DRAWER_MODE_LABEL[step.drawerMode]}</Tag>
              )}
            </span>
            <span
              className={`mt-1 block text-[13px] leading-snug ${
                step.hidden ? "text-[#86868b]" : "text-[#1d1d1f]"
              } ${selected ? "" : "line-clamp-2"}`}
            >
              {step.copy}
            </span>
          </span>
        </button>
        <div className="flex shrink-0 flex-col gap-0.5">
          <IconButton
            label="Move step up"
            disabled={index === 0}
            onClick={() => onMove(index - 1)}
          >
            <path d="M4 10l4-4 4 4" />
          </IconButton>
          <IconButton
            label="Move step down"
            disabled={index === steps.length - 1}
            onClick={() => onMove(index + 1)}
          >
            <path d="M4 6l4 4 4-4" />
          </IconButton>
        </div>
      </div>

      {/* Details */}
      {selected && (
        <div className="space-y-4 border-t border-[#f0f0f2] px-3 pb-3 pt-3">
          <div>
            <label
              htmlFor={`copy-${index}`}
              className="mb-1 block text-[12px] font-medium text-[#86868b]"
            >
              Instruction
            </label>
            <textarea
              id={`copy-${index}`}
              value={step.copy}
              onChange={(e) => onUpdate({ copy: e.target.value })}
              rows={3}
              className="w-full resize-y rounded-lg border border-[#d2d2d7] px-3 py-2 text-[13px] text-[#1d1d1f] outline-none focus:border-[#0071e3] focus:ring-4 focus:ring-[#0071e3]/10"
            />
            <SourceNote
              source={step.copySource}
              onReset={() => onUpdate({ copy: undefined })}
            />
          </div>

          <div>
            <p className="mb-1 text-[12px] font-medium text-[#86868b]">
              Tips ({helpers.length})
            </p>
            <div className="space-y-2">
              {helpers.map((h, hi) => (
                <div key={hi} className="rounded-lg border border-[#e5e5ea] p-2">
                  <div className="flex items-center gap-2">
                    <input
                      value={h.title}
                      aria-label={`Tip ${hi + 1} title`}
                      onChange={(e) =>
                        setHelpers(
                          helpers.map((x, xi) =>
                            xi === hi ? { ...x, title: e.target.value } : x
                          )
                        )
                      }
                      className="min-w-0 flex-1 rounded-md border border-transparent px-1.5 py-1 text-[12px] font-medium text-[#1d1d1f] outline-none hover:border-[#e5e5ea] focus:border-[#0071e3]"
                    />
                    <button
                      onClick={() => setHelpers(helpers.filter((_, xi) => xi !== hi))}
                      className="shrink-0 text-[12px] text-[#dc2626] hover:underline"
                    >
                      Remove
                    </button>
                  </div>
                  <textarea
                    value={h.content}
                    aria-label={`Tip ${hi + 1} text`}
                    onChange={(e) =>
                      setHelpers(
                        helpers.map((x, xi) =>
                          xi === hi ? { ...x, content: e.target.value } : x
                        )
                      )
                    }
                    rows={2}
                    className="mt-1 w-full resize-y rounded-md border border-[#e5e5ea] px-1.5 py-1 text-[12px] text-[#424245] outline-none focus:border-[#0071e3]"
                  />
                </div>
              ))}
            </div>
            <div className="mt-1.5 flex items-center justify-between">
              <button
                onClick={() =>
                  setHelpers([...helpers, { title: "Tip", content: "" }])
                }
                className="text-[12px] font-medium text-[#0071e3] hover:underline"
              >
                Add tip
              </button>
              <SourceNote
                source={step.helpersSource}
                onReset={() => onUpdate({ helpers: undefined })}
                compact
              />
            </div>
          </div>

          <div>
            <p className="mb-1 text-[12px] font-medium text-[#86868b]">Parts</p>
            <ul className="divide-y divide-[#f0f0f2] rounded-lg border border-[#e5e5ea]">
              {step.groupKeys.map((g) => {
                const parts = partsOf(g);
                const open = openGroups[g];
                return (
                  <li key={g} className="px-2.5 py-2">
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => onToggleGroup(g)}
                        className="min-w-0 flex-1 truncate text-left text-[12px] text-[#1d1d1f]"
                        aria-expanded={!!open}
                      >
                        <span className="mr-1 inline-block w-3 text-[#86868b]">
                          {open ? "▾" : "▸"}
                        </span>
                        {g}{" "}
                        <span className="text-[#86868b]">
                          &middot; {parts.length} {parts.length === 1 ? "part" : "parts"}
                        </span>
                      </button>
                      {step.groupKeys.length > 1 && (
                        <button
                          onClick={() => onSplit(g)}
                          className="shrink-0 text-[12px] font-medium text-[#0071e3] hover:underline"
                        >
                          Own step
                        </button>
                      )}
                      {targets.length > 0 && (
                        <select
                          aria-label={`Move ${g} to another step`}
                          value=""
                          onChange={(e) => onMoveGroup(g, Number(e.target.value))}
                          className="w-[92px] shrink-0 rounded-md border border-[#d2d2d7] bg-white px-1 py-0.5 text-[12px] text-[#1d1d1f] outline-none focus:border-[#0071e3]"
                        >
                          <option value="" disabled>
                            Move to…
                          </option>
                          {targets.map(({ s, i }) => (
                            <option key={i} value={i}>
                              {s.hidden
                                ? "Hidden"
                                : `Step ${activeIndexFor(steps, i) + 1}`}
                              : {s.groupKeys.join(", ")}
                            </option>
                          ))}
                        </select>
                      )}
                    </div>
                    {open && (
                      <ul className="mt-1.5 space-y-0.5 pl-4">
                        {parts.map((name, pi) => (
                          <li
                            key={`${name}-${pi}`}
                            className="group flex items-center justify-between gap-2 text-[11px]"
                          >
                            <span className="truncate font-mono text-[#424245]">
                              {name}
                            </span>
                            <button
                              onClick={() => onExcludePart(name)}
                              className="shrink-0 text-[#86868b] hover:text-[#dc2626] hover:underline"
                            >
                              Exclude
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={onMerge}
              disabled={!canMerge}
              title={
                next && !canMerge
                  ? "Drawer steps only combine with the same kind of drawer step"
                  : undefined
              }
              className="rounded-lg border border-[#d2d2d7] px-3 py-1.5 text-[12px] font-medium text-[#1d1d1f] hover:bg-[#f5f5f7] disabled:opacity-40"
            >
              Merge with next step
            </button>
            <button
              onClick={() => onUpdate({ hidden: !step.hidden })}
              className="rounded-lg border border-[#d2d2d7] px-3 py-1.5 text-[12px] font-medium text-[#1d1d1f] hover:bg-[#f5f5f7]"
            >
              {step.hidden ? "Show in guide" : "Hide from guide"}
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

function SourceNote({
  source,
  onReset,
  compact,
}: {
  source: ResolvedStep["copySource"];
  onReset: () => void;
  compact?: boolean;
}) {
  if (source === "override") {
    return (
      <p className={`text-[11px] text-[#86868b] ${compact ? "" : "mt-1"}`}>
        Edited &middot;{" "}
        <button onClick={onReset} className="text-[#0071e3] hover:underline">
          Use automatic
        </button>
      </p>
    );
  }
  if (compact) return null;
  return (
    <p
      className={`mt-1 text-[11px] ${
        source === "derived" ? "text-[#92400e]" : "text-[#86868b]"
      }`}
    >
      {SOURCE_NOTE[source]}
    </p>
  );
}

function Tag({ tone, children }: { tone: "amber" | "grey"; children: React.ReactNode }) {
  return (
    <span
      className={`rounded-md px-1.5 py-0.5 text-[11px] font-medium ${
        tone === "amber"
          ? "bg-[#fffbeb] text-[#92400e]"
          : "bg-[#f0f0f2] text-[#6e6e73]"
      }`}
    >
      {children}
    </span>
  );
}

function IconButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="flex h-6 w-6 items-center justify-center rounded-md text-[#424245] hover:bg-[#f5f5f7] disabled:opacity-30"
    >
      <svg
        viewBox="0 0 16 16"
        className="h-3.5 w-3.5"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        {children}
      </svg>
    </button>
  );
}
