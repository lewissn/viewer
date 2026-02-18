"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import type { AssemblyGuide } from "@/lib/assemblyGuides";
import {
  AssemblyGuideController,
  type ControllerState,
} from "@/lib/assemblyGuideController";
import { DesktopSidebar, MobileNav } from "../side-nav";
import { useTheme } from "@/lib/theme-context";

interface Props {
  guide: AssemblyGuide;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export default function AssemblyClient({ guide }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<any>(null);
  const controllerRef = useRef<AssemblyGuideController | null>(null);

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [wizardOpen, setWizardOpen] = useState(true);
  const [state, setState] = useState<ControllerState>({
    currentStep: -1,
    totalSteps: 0,
    activeSteps: [],
    isAnimating: false,
  });

  const { theme } = useTheme();

  const initViewer = useCallback(async () => {
    if (!containerRef.current) return;

    const OV = await import("online-3d-viewer");

    const controller = new AssemblyGuideController(guide);
    controllerRef.current = controller;

    controller.subscribe((newState) => {
      setState({ ...newState });
    });

    // Theme-aware background: light = warm off-white, dark = charcoal
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
        controller.init(embeddedViewer, OV);
      },
      onModelLoadFailed: () => {
        setLoading(false);
        setLoadError("Failed to load the 3D model. Please try again later.");
      },
    });

    viewerRef.current = embeddedViewer;
    embeddedViewer.LoadModelFromUrlList([guide.modelUrl]);
  }, [guide]);

  useEffect(() => {
    initViewer();
    return () => {
      controllerRef.current?.destroy();
      try {
        viewerRef.current?.Destroy();
      } catch {
        // Viewer may already be destroyed
      }
    };
  }, [initViewer]);

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

  // ── State derived values ──

  const isIntro = state.currentStep === -1;
  const isComplete = state.currentStep >= state.totalSteps;
  const stepIndex = state.currentStep;
  const currentStepData =
    stepIndex >= 0 && stepIndex < state.totalSteps
      ? state.activeSteps[stepIndex]
      : null;

  return (
    <div className="flex w-screen h-screen bg-[var(--background)] overflow-hidden transition-colors">
      {/* Desktop sidebar */}
      <DesktopSidebar />

      {/* Main viewer area */}
      <div className="relative flex-1 h-screen overflow-hidden">
        {/* Top bar — active cabinet/guide name */}
        <div className="absolute top-0 left-0 right-0 z-20 flex items-center justify-between px-4 sm:px-6 py-3 pointer-events-none">
          <div className="pointer-events-auto flex items-center gap-2">
            <MobileNav />
            <div className="backdrop-blur-xl bg-[var(--card-bg)] rounded-xl px-4 py-2 shadow-[0_1px_8px_rgba(0,0,0,0.08)] flex items-center min-w-0 max-w-[70vw] sm:max-w-md">
              <span className="text-[14px] font-medium text-[var(--foreground)] truncate">
                {guide.title}
              </span>
            </div>
          </div>

          {/* Right: reopen wizard button (when wizard is closed) */}
          {!wizardOpen && !loading && !loadError && (
            <div className="pointer-events-auto">
              <button
                onClick={handleReopen}
                className="flex items-center gap-1.5 h-9 px-3 rounded-xl backdrop-blur-xl bg-[var(--card-bg)] text-[var(--foreground)] shadow-[0_1px_8px_rgba(0,0,0,0.08)] hover:opacity-90 transition-all active:scale-95 text-[13px] font-medium"
              >
                <GuideIcon />
                Guide
              </button>
            </div>
          )}
        </div>

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

      {/* 3D Viewer container — subtle gradient frame */}
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
        style={{ visibility: loading || loadError ? "hidden" : "visible" }}
      />

      {/* Wizard modal */}
      {wizardOpen && !loading && !loadError && (
        <div className="absolute bottom-4 sm:bottom-6 left-1/2 -translate-x-1/2 z-40 w-[calc(100%-2rem)] sm:w-auto sm:min-w-[360px] sm:max-w-[420px]">
          <div className="backdrop-blur-xl bg-[var(--card-bg)] rounded-2xl shadow-[0_8px_40px_rgba(0,0,0,0.12)] overflow-hidden border border-[var(--sidebar-border)]/50">
            {/* Progress bar — stronger visibility */}
            {state.totalSteps > 0 && (
              <div className="flex gap-1 px-5 pt-4">
                {state.activeSteps.map((_, i) => (
                  <div
                    key={i}
                    className="h-1.5 flex-1 rounded-full transition-all duration-300"
                    style={{
                      backgroundColor:
                        i <= stepIndex
                          ? "var(--accent)"
                          : "var(--muted)",
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
              {/* Intro state */}
              {isIntro && (
                <>
                  <h3 className="text-[17px] font-semibold text-[var(--foreground)] mb-1">
                    {guide.title}
                  </h3>
                  <p className="text-[14px] text-[var(--muted)] leading-relaxed mb-4">
                    Follow the step-by-step guide to assemble your cabinet. Each
                    step highlights the parts to fit.
                  </p>
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
                  <p className="text-[15px] text-[var(--foreground)] font-medium leading-relaxed mb-4">
                    {currentStepData.copy}
                  </p>
                  <div className="flex items-center justify-between">
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
                        {stepIndex + 1 >= state.totalSteps ? "Finish" : "Next"}
                      </button>
                    </div>
                  </div>
                </>
              )}

              {/* Complete state */}
              {isComplete && (
                <>
                  <div className="flex items-center gap-2 mb-1">
                    <div className="w-6 h-6 rounded-full bg-emerald-500 flex items-center justify-center flex-shrink-0 shadow-[0_0_12px_rgba(16,185,129,0.4)]">
                      <svg
                        className="w-3.5 h-3.5 text-white"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={3}
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M4.5 12.75l6 6 9-13.5"
                        />
                      </svg>
                    </div>
                    <h3 className="text-[17px] font-semibold text-[var(--foreground)]">
                      Assembly Complete
                    </h3>
                  </div>
                  <p className="text-[14px] text-[var(--muted)] leading-relaxed mb-4">
                    Your {guide.title.toLowerCase()} is fully assembled. You can
                    restart the guide or close this panel to explore the model.
                  </p>
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

/* ─── Icons ─── */

function GuideIcon() {
  return (
    <svg
      className="w-4 h-4"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={1.5}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25"
      />
    </svg>
  );
}
