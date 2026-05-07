"use client";

import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { useSearchParams } from "next/navigation";
import type { Project, CabinetInstance } from "@/lib/projects";
import {
  AssemblyGuideController,
  type ControllerState,
} from "@/lib/assemblyGuideController";
import type { StepHelper } from "@/lib/assemblyGuides";
import { buildProjectNavigation } from "@/lib/navigation";
import { DesktopSidebar, MobileNav } from "@/app/assembly/side-nav";
import { useTheme } from "@/lib/theme-context";

/* eslint-disable @typescript-eslint/no-explicit-any */

interface Props {
  project: Project;
}

export default function ProjectClient({ project }: Props) {
  const searchParams = useSearchParams();
  const { theme } = useTheme();
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<any>(null);
  const controllerRef = useRef<AssemblyGuideController | null>(null);

  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [wizardOpen, setWizardOpen] = useState(true);
  const [showWelcome, setShowWelcome] = useState(true);
  const [activeCabinetId, setActiveCabinetId] = useState<string | null>(null);
  const [state, setState] = useState<ControllerState>({
    currentStep: -1,
    totalSteps: 0,
    activeSteps: [],
    isAnimating: false,
  });

  // Find active cabinet from URL params
  const cabinetParam = searchParams.get("cabinet");
  const activeCabinet = useMemo(
    () => project.cabinets.find((c) => c.cabinetId === cabinetParam) ?? null,
    [project.cabinets, cabinetParam]
  );

  // Build project-specific nav sections
  const navSections = useMemo(
    () =>
      buildProjectNavigation(project.projectId, project.cabinets),
    [project.projectId, project.cabinets]
  );

  // Load cabinet model when selection changes
  const loadCabinet = useCallback(
    async (cabinet: CabinetInstance) => {
      if (!containerRef.current || !cabinet.modelFileUrl) return;

      // Cleanup previous viewer
      controllerRef.current?.destroy();
      try {
        viewerRef.current?.Destroy();
      } catch {
        // May already be destroyed
      }

      // Clear the container
      containerRef.current.innerHTML = "";

      setLoading(true);
      setLoadError("");
      setWizardOpen(true);
      setState({
        currentStep: -1,
        totalSteps: 0,
        activeSteps: [],
        isAnimating: false,
      });

      const OV = await import("online-3d-viewer");

      const controller = new AssemblyGuideController();
      controllerRef.current = controller;

      controller.subscribe((newState) => {
        setState({ ...newState });
      });

      const isDark =
        typeof document !== "undefined" &&
        document.documentElement.classList.contains("dark");
      const bg = isDark ? { r: 44, g: 44, b: 46 } : { r: 240, g: 238, b: 235 };

      const embeddedViewer = new OV.EmbeddedViewer(containerRef.current, {
        backgroundColor: new OV.RGBAColor(bg.r, bg.g, bg.b, 255),
        defaultColor: new OV.RGBColor(200, 200, 200),
        edgeSettings: new OV.EdgeSettings(
          false,
          new OV.RGBColor(68, 68, 68),
          1
        ),
        onModelLoaded: () => {
          setLoading(false);
          controller.initDynamic(
            embeddedViewer,
            OV,
            cabinet.guideOverrides
          );
        },
        onModelLoadFailed: () => {
          setLoading(false);
          setLoadError(
            "Failed to load the 3D model. Please try again later."
          );
        },
      });

      viewerRef.current = embeddedViewer;
      // Load the model alongside any associated texture/material files so
      // patterned cabinets render with their correct surface (e.g. .3ds
      // exports reference external bitmap files).
      const textureUrls = (cabinet.textureFileUrls ?? []).filter(
        (u) => u && u.trim().length > 0
      );
      embeddedViewer.LoadModelFromUrlList([
        cabinet.modelFileUrl,
        ...textureUrls,
      ]);
      setActiveCabinetId(cabinet.cabinetId);
    },
    []
  );

  // React to cabinet param changes
  useEffect(() => {
    if (activeCabinet && activeCabinet.cabinetId !== activeCabinetId) {
      loadCabinet(activeCabinet);
    }
  }, [activeCabinet, activeCabinetId, loadCabinet]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      controllerRef.current?.destroy();
      try {
        viewerRef.current?.Destroy();
      } catch {
        // Viewer may already be destroyed
      }
    };
  }, []);

  // Update viewer background when theme changes
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    try {
      const isDark =
        document.documentElement.classList.contains("dark");
      const bg = isDark ? { r: 44, g: 44, b: 46 } : { r: 240, g: 238, b: 235 };
      import("online-3d-viewer").then((OV) => {
        const ovViewer = viewer.GetViewer?.();
        if (ovViewer?.SetBackgroundColor) {
          ovViewer.SetBackgroundColor(new OV.RGBAColor(bg.r, bg.g, bg.b, 255));
          ovViewer.Render?.();
        }
      });
    } catch {
      // Non-critical
    }
  }, [theme]);

  // ── Wizard actions ──

  function handleNext() {
    controllerRef.current?.next();
  }
  function handleBack() {
    controllerRef.current?.back();
  }
  function handleRestart() {
    controllerRef.current?.restart();
  }
  function handleClose() {
    controllerRef.current?.close();
    setWizardOpen(false);
  }
  function handleReopen() {
    controllerRef.current?.restart();
    setWizardOpen(true);
  }

  // ── Derived state ──

  const isIntro = state.currentStep === -1;
  const isComplete = state.currentStep >= state.totalSteps;
  const stepIndex = state.currentStep;
  const currentStepData =
    stepIndex >= 0 && stepIndex < state.totalSteps
      ? state.activeSteps[stepIndex]
      : null;

  const cabinetTitle = activeCabinet?.cabinetName ?? project.projectName;
  const hasCabinet = !!activeCabinet?.modelFileUrl;
  const hasFittings = (activeCabinet?.erpFittings?.length ?? 0) > 0;

  const isBackStep =
    currentStepData != null &&
    !isComplete &&
    currentStepData.prefixes.includes("Back");

  return (
    <div className="flex w-screen h-screen bg-[var(--background)] overflow-hidden transition-colors">
      {/* Desktop sidebar */}
      <DesktopSidebar
        sections={navSections}
        fittings={activeCabinet?.erpFittings}
        activeId={activeCabinet?.cabinetId}
      />

      {/* Main viewer area */}
      <div className="relative flex-1 h-screen overflow-hidden">
        {/* Top bar — active cabinet name */}
        <div className="absolute top-0 left-0 right-0 z-20 flex items-center justify-between px-4 sm:px-6 py-3 pointer-events-none">
          <div className="pointer-events-auto flex items-center gap-2">
            <MobileNav
              sections={navSections}
              fittings={activeCabinet?.erpFittings}
              activeId={activeCabinet?.cabinetId}
            />
            <div className="backdrop-blur-xl bg-[var(--card-bg)] rounded-xl px-4 py-2 shadow-[0_1px_8px_rgba(0,0,0,0.08)] flex items-center min-w-0 max-w-[70vw] sm:max-w-md">
              <span className="text-[14px] font-medium text-[var(--foreground)] truncate">
                {cabinetTitle}
              </span>
            </div>
          </div>

          {!wizardOpen && !loading && !loadError && hasCabinet && (
            <div className="pointer-events-auto">
              <button
                onClick={handleReopen}
                className="flex items-center gap-1.5 h-9 px-3 rounded-xl backdrop-blur-xl bg-[var(--card-bg)] text-[var(--foreground)] shadow-[0_1px_8px_rgba(0,0,0,0.08)] hover:opacity-90 transition-all active:scale-95 text-[13px] font-medium"
              >
                Guide
              </button>
            </div>
          )}
        </div>

        {/* Welcome intro — no cabinet selected */}
        {!hasCabinet && !loading && (
          <div className="absolute inset-0 z-10 flex items-center justify-center px-4">
            {showWelcome ? (
              <div className="bg-[var(--card-bg)] rounded-2xl shadow-[0_8px_40px_rgba(0,0,0,0.12)] max-w-lg w-full max-h-[85vh] overflow-y-auto animate-scale-in border border-[var(--sidebar-border)]/50">
                {/* Header */}
                <div className="px-6 pt-6 pb-4 border-b border-[var(--sidebar-border)]">
                  <p className="text-[12px] font-medium text-[var(--accent)] uppercase tracking-wider mb-1">
                    Assembly Guide
                  </p>
                  <h2 className="text-[22px] font-semibold text-[var(--foreground)]">
                    Welcome{project.customerName ? `, ${project.customerName}` : ""}!
                  </h2>
                  <p className="mt-1 text-[14px] text-[var(--muted)]">
                    {project.projectName}
                  </p>
                </div>

                {/* Content */}
                <div className="px-6 py-5 space-y-5">
                  <p className="text-[14px] text-[var(--muted)] leading-relaxed">
                    This interactive guide will walk you through assembling each
                    cabinet in your project step by step. Before you begin, take
                    a few minutes to prepare — it will make the whole process
                    smoother and quicker.
                  </p>

                  {/* Tip 1 */}
                  <div className="flex gap-3">
                    <div className="flex-shrink-0 w-8 h-8 rounded-full bg-[#f0f5ff] flex items-center justify-center mt-0.5">
                      <svg className="w-4 h-4 text-[#0071e3]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12l8.954-8.955c.44-.439 1.152-.439 1.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75M8.25 21h8.25" />
                      </svg>
                    </div>
                    <div>
                      <h4 className="text-[14px] font-semibold text-[var(--foreground)] mb-0.5">
                        Prepare your space
                      </h4>
                      <p className="text-[13px] text-[var(--muted)] leading-relaxed">
                        Clear a flat, clean area large enough to lay out all
                        your panels. A soft surface such as cardboard or a
                        blanket will protect panel faces from scratches.
                      </p>
                    </div>
                  </div>

                  {/* Tip 2 */}
                  <div className="flex gap-3">
                    <div className="flex-shrink-0 w-8 h-8 rounded-full bg-[#f0f5ff] flex items-center justify-center mt-0.5">
                      <svg className="w-4 h-4 text-[#0071e3]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M9 4.5v15m6-15v15m-10.875 0h15.75c.621 0 1.125-.504 1.125-1.125V5.625c0-.621-.504-1.125-1.125-1.125H4.125C3.504 4.5 3 5.004 3 5.625v12.75c0 .621.504 1.125 1.125 1.125z" />
                      </svg>
                    </div>
                    <div>
                      <h4 className="text-[14px] font-semibold text-[var(--foreground)] mb-0.5">
                        Unpack and organise panels
                      </h4>
                      <p className="text-[13px] text-[var(--muted)] leading-relaxed">
                        Lay out all panels for the cabinet you are about to
                        build. Familiarise yourself with each piece — the
                        printed labels on the edges will match the part names
                        shown in the guide. Refer to the provided{" "}
                        <strong>Exploded Diagrams</strong> which show the panel
                        numbering for each panel — these numbers correlate with
                        the Part Numbers on the labels.
                      </p>
                    </div>
                  </div>

                  {/* Tip 3 */}
                  <div className="flex gap-3">
                    <div className="flex-shrink-0 w-8 h-8 rounded-full bg-[#f0f5ff] flex items-center justify-center mt-0.5">
                      <svg className="w-4 h-4 text-[#0071e3]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M11.42 15.17l-5.384-3.08A1.615 1.615 0 015 10.683V6.748a1.615 1.615 0 011.036-1.506l5.384-3.08a1.615 1.615 0 011.16 0l5.384 3.08A1.615 1.615 0 0119 6.748v3.935a1.615 1.615 0 01-1.036 1.506l-5.384 3.08a1.615 1.615 0 01-1.16 0z" />
                      </svg>
                    </div>
                    <div>
                      <h4 className="text-[14px] font-semibold text-[var(--foreground)] mb-0.5">
                        Sort your fittings
                      </h4>
                      <p className="text-[13px] text-[var(--muted)] leading-relaxed">
                        Open all fitting bags and group them by type — cams,
                        screws, hinges, brackets, etc. Check the{" "}
                        <strong>Included Fittings</strong> list in the sidebar
                        to confirm everything is present.
                      </p>
                    </div>
                  </div>

                  {/* Tip 4 */}
                  <div className="flex gap-3">
                    <div className="flex-shrink-0 w-8 h-8 rounded-full bg-[#fff8eb] flex items-center justify-center mt-0.5">
                      <svg className="w-4 h-4 text-[#e67e00]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
                      </svg>
                    </div>
                    <div>
                      <h4 className="text-[14px] font-semibold text-[var(--foreground)] mb-0.5">
                        Pre-insert cams, cam pins and hinge plates
                      </h4>
                      <p className="text-[13px] text-[var(--muted)] leading-relaxed">
                        Before starting assembly, push all <strong>Rafix cam
                        pins</strong> into their pre-drilled holes, press the{" "}
                        <strong>Rafix cams</strong> into their housings (do not
                        turn yet), and screw <strong>hinge plates</strong> to
                        the inside of side panels. This saves a lot of time
                        during the build.
                      </p>
                    </div>
                  </div>

                  {/* Tip 5 */}
                  <div className="flex gap-3">
                    <div className="flex-shrink-0 w-8 h-8 rounded-full bg-[#f0f5ff] flex items-center justify-center mt-0.5">
                      <svg className="w-4 h-4 text-[#0071e3]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M11.48 3.499a.562.562 0 011.04 0l2.125 5.111a.563.563 0 00.475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 00-.182.557l1.285 5.385a.562.562 0 01-.84.61l-4.725-2.885a.563.563 0 00-.586 0L6.982 20.54a.562.562 0 01-.84-.61l1.285-5.386a.562.562 0 00-.182-.557l-4.204-3.602a.563.563 0 01.321-.988l5.518-.442a.563.563 0 00.475-.345L11.48 3.5z" />
                      </svg>
                    </div>
                    <div>
                      <h4 className="text-[14px] font-semibold text-[var(--foreground)] mb-0.5">
                        Tools you will need
                      </h4>
                      <p className="text-[13px] text-[var(--muted)] leading-relaxed">
                        A Pozidriv screwdriver (PZ2), a soft mallet or rubber
                        hammer, and a measuring tape. A cordless drill will
                        speed things up but is not essential.
                      </p>
                    </div>
                  </div>
                </div>

                {/* Footer */}
                <div className="px-6 pb-6 pt-2 flex items-center justify-between">
                  <button
                    onClick={() => setShowWelcome(false)}
                    className="text-[13px] text-[var(--muted)] hover:text-[var(--foreground)] transition-colors"
                  >
                    Skip
                  </button>
                  <button
                    onClick={() => setShowWelcome(false)}
                    className="px-6 py-2.5 rounded-full bg-[var(--accent)] text-white text-[14px] font-medium hover:opacity-90 transition-colors active:scale-95"
                  >
                    Get Started
                  </button>
                </div>
              </div>
            ) : (
              <div className="text-center">
                <h2 className="text-[20px] font-semibold text-[var(--foreground)] mb-2">
                  {project.projectName}
                </h2>
                {project.customerName && (
                  <p className="text-[14px] text-[var(--muted)] mb-4">
                    {project.customerName}
                  </p>
                )}
                <p className="text-[15px] text-[var(--muted)] text-center max-w-sm">
                  Select a cabinet from the sidebar to begin.
                </p>
              </div>
            )}
          </div>
        )}

        {/* Loading state */}
        {loading && (
          <div className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-[var(--background)]">
            <div className="w-8 h-8 border-[3px] border-[var(--muted)]/30 border-t-[var(--accent)] rounded-full animate-spin" />
            <p className="mt-4 text-[14px] text-[var(--muted)]">
              Loading 3D model...
            </p>
          </div>
        )}

        {/* Error state */}
        {loadError && !loading && (
          <div className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-[var(--background)] px-6">
            <div className="w-12 h-12 rounded-full bg-red-500/10 flex items-center justify-center mb-4">
              <svg
                className="w-6 h-6 text-red-500"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1.5}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z"
                />
              </svg>
            </div>
            <p className="text-[15px] text-[var(--foreground)] font-medium text-center">
              {loadError}
            </p>
          </div>
        )}

        {/* 3D Viewer — gradient frame */}
        <div
          className="absolute inset-0"
          style={{
            background:
              "radial-gradient(ellipse 80% 80% at 50% 50%, var(--viewer-bg) 0%, var(--background) 100%)",
          }}
        />
        <div
          ref={containerRef}
          className="absolute inset-0"
          style={{
            visibility:
              loading || loadError || !hasCabinet ? "hidden" : "visible",
          }}
        />

        {/* Square-check visual cue (back step only) */}
        {isBackStep && wizardOpen && !loading && (
          <div className="absolute inset-0 z-30 pointer-events-none">
            <svg className="w-full h-full" preserveAspectRatio="none">
              <line
                x1="15%" y1="15%" x2="85%" y2="75%"
                stroke="var(--accent)"
                strokeWidth="1"
                strokeDasharray="8 6"
                opacity="0.25"
              />
              <line
                x1="85%" y1="15%" x2="15%" y2="75%"
                stroke="var(--accent)"
                strokeWidth="1"
                strokeDasharray="8 6"
                opacity="0.25"
              />
              {/* Corner markers */}
              <circle cx="15%" cy="15%" r="6" fill="var(--accent)" opacity="0.2" />
              <circle cx="85%" cy="15%" r="6" fill="var(--accent)" opacity="0.2" />
              <circle cx="15%" cy="75%" r="6" fill="var(--accent)" opacity="0.2" />
              <circle cx="85%" cy="75%" r="6" fill="var(--accent)" opacity="0.2" />
            </svg>
          </div>
        )}

        {/* Wizard modal */}
        {wizardOpen && !loading && !loadError && hasCabinet && (
          <div className="absolute bottom-4 sm:bottom-6 left-1/2 -translate-x-1/2 z-40 w-[calc(100%-2rem)] sm:w-auto sm:min-w-[360px] sm:max-w-[420px]">
            <div className="backdrop-blur-xl bg-[var(--card-bg)] rounded-2xl shadow-[0_8px_40px_rgba(0,0,0,0.12)] overflow-hidden border border-[var(--sidebar-border)]/50">
              {/* Progress bar */}
              {state.totalSteps > 0 && (
                <div className="flex gap-1 px-5 pt-4">
                  {state.activeSteps.map((_, i) => (
                    <div
                      key={i}
                      className="h-1.5 flex-1 rounded-full transition-all duration-300"
                      style={{
                        backgroundColor:
                          i <= stepIndex ? "var(--accent)" : "var(--muted)",
                        opacity: i <= stepIndex ? 1 : 0.35,
                        boxShadow:
                          i === stepIndex
                            ? "0 0 8px rgba(0, 113, 227, 0.4)"
                            : "none",
                      }}
                    />
                  ))}
                </div>
              )}

              <div className="px-5 py-4">
                {/* Intro state — context-aware build summary */}
                {isIntro && (
                  <>
                    <h3 className="text-[17px] font-semibold text-[var(--foreground)] mb-0.5">
                      {cabinetTitle}
                    </h3>

                    {state.cabinetSummary ? (
                      <div className="space-y-3 mb-4">
                        {/* Build overview */}
                        {state.cabinetSummary.features.length > 0 && (
                          <div>
                            <p className="text-[11px] font-semibold text-[var(--muted)] uppercase tracking-wider mb-1.5">
                              Build Overview
                            </p>
                            <ul className="space-y-0.5">
                              {state.cabinetSummary.features.map((f, i) => (
                                <li
                                  key={i}
                                  className="flex items-center gap-2 text-[13px] text-[var(--foreground)]"
                                >
                                  <svg className="w-3 h-3 text-[var(--accent)] flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                                  </svg>
                                  <span>
                                    {f.label}
                                    {f.count != null && f.count > 1 && (
                                      <span className="text-[var(--muted)]"> ({f.count})</span>
                                    )}
                                  </span>
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}

                        {/* Estimate + difficulty */}
                        <div className="flex items-center gap-3">
                          <span className="text-[12px] text-[var(--muted)]">
                            ~{state.cabinetSummary.estimatedMinutes} mins
                          </span>
                          <DifficultyBadge level={state.cabinetSummary.difficulty} />
                        </div>

                        {/* Conditional notes */}
                        {state.cabinetSummary.notes.length > 0 && (
                          <div>
                            <p className="text-[11px] font-semibold text-[var(--muted)] uppercase tracking-wider mb-1.5">
                              Important
                            </p>
                            <ul className="space-y-1">
                              {state.cabinetSummary.notes.map((note, i) => (
                                <li
                                  key={i}
                                  className="flex items-start gap-2 text-[12px] text-[var(--muted)] leading-snug"
                                >
                                  <span className="text-amber-500 flex-shrink-0 mt-px">•</span>
                                  {note}
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </div>
                    ) : (
                      <p className="text-[14px] text-[var(--muted)] leading-relaxed mb-4">
                        Follow the step-by-step guide to assemble your cabinet.
                        Each step highlights the parts to fit.
                      </p>
                    )}

                    <div className="flex items-center justify-between">
                      <button
                        onClick={handleClose}
                        className="text-[13px] text-[var(--muted)] hover:text-[var(--foreground)] transition-colors"
                      >
                        Close
                      </button>
                      <button
                        onClick={handleNext}
                        className="px-5 py-2 rounded-full bg-[var(--accent)] text-white text-[13px] font-medium hover:opacity-90 transition-colors active:scale-95"
                      >
                        Start Assembly
                      </button>
                    </div>
                  </>
                )}

                {/* Step state */}
                {currentStepData && !isComplete && (
                  <>
                    <p className="text-[12px] text-[var(--muted)] mb-1">
                      Step {stepIndex + 1} of {state.totalSteps}
                    </p>
                    <p className="text-[15px] text-[var(--foreground)] font-medium leading-relaxed mb-2">
                      {currentStepData.copy}
                    </p>

                    {/* Fittings reference */}
                    {currentStepData.usesFittings && hasFittings && (
                      <p className="text-[11px] text-[var(--muted)] mb-2 flex items-center gap-1.5">
                        <svg className="w-3 h-3 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M11.42 15.17l-5.384-3.08A1.615 1.615 0 015 10.683V6.748a1.615 1.615 0 011.036-1.506l5.384-3.08a1.615 1.615 0 011.16 0l5.384 3.08A1.615 1.615 0 0119 6.748v3.935a1.615 1.615 0 01-1.036 1.506l-5.384 3.08a1.615 1.615 0 01-1.16 0z" />
                        </svg>
                        Uses fittings listed in the sidebar.
                      </p>
                    )}

                    {/* Drawer sub-steps (visual only) */}
                    {currentStepData.drawerMode === "assembleFirst" && (
                      <DrawerSubSteps />
                    )}

                    {/* Expandable helpers */}
                    {currentStepData.helpers && currentStepData.helpers.length > 0 && (
                      <div className="space-y-0 mb-1">
                        {currentStepData.helpers.map((helper, i) => (
                          <HelperAccordion key={`${stepIndex}-${i}`} helper={helper} />
                        ))}
                      </div>
                    )}

                    <div className="flex items-center justify-between mt-3">
                      <button
                        onClick={handleBack}
                        disabled={state.isAnimating}
                        className="text-[13px] text-[var(--muted)] hover:text-[var(--foreground)] transition-colors disabled:opacity-30"
                      >
                        Back
                      </button>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={handleClose}
                          className="text-[13px] text-[var(--muted)] hover:text-[var(--foreground)] transition-colors"
                        >
                          Close
                        </button>
                        <button
                          onClick={handleNext}
                          disabled={state.isAnimating}
                          className="px-5 py-2 rounded-full bg-[var(--accent)] text-white text-[13px] font-medium hover:opacity-90 transition-colors active:scale-95 disabled:opacity-50"
                        >
                          {stepIndex + 1 >= state.totalSteps
                            ? "Finish"
                            : "Next"}
                        </button>
                      </div>
                    </div>
                  </>
                )}

                {/* Complete state — confidence checklist */}
                {isComplete && (
                  <>
                    <div className="flex items-center gap-2 mb-2">
                      <div className="w-6 h-6 rounded-full bg-emerald-500 flex items-center justify-center flex-shrink-0 shadow-[0_0_12px_rgba(16,185,129,0.4)]">
                        <svg className="w-3.5 h-3.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                        </svg>
                      </div>
                      <h3 className="text-[17px] font-semibold text-[var(--foreground)]">
                        Assembly Complete
                      </h3>
                    </div>

                    <p className="text-[11px] font-semibold text-[var(--muted)] uppercase tracking-wider mb-1.5">
                      Before placing in position
                    </p>
                    <ul className="space-y-1.5 mb-4">
                      {(() => {
                        const groups = new Set(state.detectedGroups ?? []);
                        const fittingIds = new Set(
                          (activeCabinet?.erpFittings ?? []).map((f) => f.partId)
                        );
                        const items: string[] = [
                          "Cabinet is square — diagonals are equal",
                          "All Rafix cams are tight (but not over-tightened)",
                        ];
                        if (groups.has("Door")) {
                          items.push("Door gaps are even (~3mm all round)");
                        }
                        if (
                          groups.has("Drawer") ||
                          groups.has("Drawer Box - Left") ||
                          groups.has("Drawer Box - Right") ||
                          groups.has("Drawer Box - Back") ||
                          groups.has("Drawer Box - Bottom")
                        ) {
                          items.push("Drawers slide smoothly and clips are clicked in");
                        }
                        if (
                          fittingIds.has("ANTI_TILT_BRACKET") ||
                          fittingIds.has("ANTI_TILT_PLATE")
                        ) {
                          items.push("Anti-tilt bracket fitted and secured to the wall");
                        }
                        return items;
                      })().map((item, i) => (
                        <li key={i} className="flex items-start gap-2 text-[13px] text-[var(--foreground)]">
                          <span className="w-4 h-4 rounded border border-[var(--muted)]/30 flex-shrink-0 mt-0.5" />
                          {item}
                        </li>
                      ))}
                    </ul>

                    <div className="flex items-center justify-between">
                      <button
                        onClick={handleClose}
                        className="text-[13px] text-[var(--muted)] hover:text-[var(--foreground)] transition-colors"
                      >
                        Close
                      </button>
                      <button
                        onClick={handleRestart}
                        className="px-5 py-2 rounded-full bg-[var(--accent)] text-white text-[13px] font-medium hover:opacity-90 transition-colors active:scale-95"
                      >
                        Restart Guide
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ─── Supporting Components ─── */

const DRAWER_SUBSTEPS = [
  "Prepare drawer parts",
  "Build drawer box",
  "Fit corner clips",
  "Install runners",
  "Insert drawer",
  "Adjust alignment",
];

function DrawerSubSteps() {
  return (
    <div className="mb-2">
      <p className="text-[11px] font-semibold text-[var(--muted)] uppercase tracking-wider mb-1">
        Sub-steps
      </p>
      <ol className="space-y-0.5">
        {DRAWER_SUBSTEPS.map((label, i) => (
          <li
            key={i}
            className="flex items-center gap-2 text-[12px] text-[var(--muted)]"
          >
            <span className="w-4 text-right text-[10px] tabular-nums flex-shrink-0 opacity-50">
              {i + 1}.
            </span>
            {label}
          </li>
        ))}
      </ol>
    </div>
  );
}

function HelperAccordion({ helper }: { helper: StepHelper }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="border-t border-[var(--sidebar-border)]/30">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 w-full py-1.5 text-[12px] text-[var(--muted)] hover:text-[var(--foreground)] transition-colors"
      >
        <svg
          className={`w-3 h-3 flex-shrink-0 transition-transform duration-200 ${open ? "rotate-90" : ""}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M8.25 4.5l7.5 7.5-7.5 7.5"
          />
        </svg>
        <span className="font-medium">{helper.title}</span>
      </button>
      {open && (
        <p className="text-[12px] text-[var(--muted)] leading-relaxed pl-[18px] pb-2">
          {helper.content}
        </p>
      )}
    </div>
  );
}

function DifficultyBadge({
  level,
}: {
  level: "Easy" | "Moderate" | "Advanced";
}) {
  const colors: Record<string, string> = {
    Easy: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    Moderate: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
    Advanced: "bg-red-500/10 text-red-600 dark:text-red-400",
  };

  return (
    <span
      className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-[11px] font-medium ${colors[level]}`}
    >
      {level}
    </span>
  );
}
