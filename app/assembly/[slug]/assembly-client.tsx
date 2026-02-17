"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import Image from "next/image";
import type { AssemblyGuide } from "@/lib/assemblyGuides";
import {
  AssemblyGuideController,
  type ControllerState,
} from "@/lib/assemblyGuideController";

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

  const initViewer = useCallback(async () => {
    if (!containerRef.current) return;

    const OV = await import("online-3d-viewer");

    const controller = new AssemblyGuideController(guide);
    controllerRef.current = controller;

    controller.subscribe((newState) => {
      setState({ ...newState });
    });

    const embeddedViewer = new OV.EmbeddedViewer(containerRef.current, {
      backgroundColor: new OV.RGBAColor(250, 250, 250, 255),
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
    <div className="relative w-screen h-screen bg-[#fafafa] overflow-hidden">
      {/* Top bar */}
      <div className="absolute top-0 left-0 right-0 z-20 flex items-center justify-between px-4 sm:px-6 py-3 pointer-events-none">
        {/* Left: branding */}
        <div className="pointer-events-auto">
          <div className="backdrop-blur-xl bg-white/70 rounded-xl px-4 py-2 shadow-[0_1px_8px_rgba(0,0,0,0.08)] flex items-center">
            <Image
              src="/logo.png"
              alt="The Cabinet Shop"
              width={120}
              height={32}
              className="h-6 w-auto"
              priority
            />
            <span className="ml-2 text-[12px] text-[#86868b]">
              Assembly Guide
            </span>
          </div>
        </div>

        {/* Right: reopen wizard button (when wizard is closed) */}
        {!wizardOpen && !loading && !loadError && (
          <div className="pointer-events-auto">
            <button
              onClick={handleReopen}
              className="flex items-center gap-1.5 h-9 px-3 rounded-xl backdrop-blur-xl bg-white/70 text-[#1d1d1f] shadow-[0_1px_8px_rgba(0,0,0,0.08)] hover:bg-white/90 transition-all active:scale-95 text-[13px] font-medium"
            >
              <GuideIcon />
              Guide
            </button>
          </div>
        )}
      </div>

      {/* Loading state */}
      {loading && (
        <div className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-[#fafafa]">
          <div className="w-8 h-8 border-[3px] border-[#d2d2d7] border-t-[#0071e3] rounded-full animate-spin" />
          <p className="mt-4 text-[14px] text-[#86868b]">
            Loading 3D model...
          </p>
        </div>
      )}

      {/* Error state */}
      {loadError && !loading && (
        <div className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-[#fafafa] px-6">
          <div className="w-12 h-12 rounded-full bg-[#fff5f5] flex items-center justify-center mb-4">
            <svg
              className="w-6 h-6 text-[#dc2626]"
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
          <p className="text-[15px] text-[#1d1d1f] font-medium text-center">
            {loadError}
          </p>
        </div>
      )}

      {/* 3D Viewer container */}
      <div
        ref={containerRef}
        className="w-full h-full"
        style={{ visibility: loading || loadError ? "hidden" : "visible" }}
      />

      {/* Wizard modal */}
      {wizardOpen && !loading && !loadError && (
        <div className="absolute bottom-4 sm:bottom-6 left-1/2 -translate-x-1/2 z-40 w-[calc(100%-2rem)] sm:w-auto sm:min-w-[360px] sm:max-w-[420px]">
          <div className="backdrop-blur-xl bg-white/90 rounded-2xl shadow-[0_8px_40px_rgba(0,0,0,0.12)] overflow-hidden">
            {/* Progress bar */}
            {state.totalSteps > 0 && (
              <div className="flex gap-0.5 px-5 pt-4">
                {state.activeSteps.map((_, i) => (
                  <div
                    key={i}
                    className="h-1 flex-1 rounded-full transition-colors duration-300"
                    style={{
                      backgroundColor:
                        i < stepIndex
                          ? "#0071e3"
                          : i === stepIndex
                            ? "#0071e3"
                            : "#d2d2d7",
                      opacity: i <= stepIndex ? 1 : 0.5,
                    }}
                  />
                ))}
              </div>
            )}

            <div className="px-5 py-4">
              {/* Intro state */}
              {isIntro && (
                <>
                  <h3 className="text-[17px] font-semibold text-[#1d1d1f] mb-1">
                    {guide.title}
                  </h3>
                  <p className="text-[14px] text-[#424245] leading-relaxed mb-4">
                    Follow the step-by-step guide to assemble your cabinet. Each
                    step highlights the parts to fit.
                  </p>
                  <div className="flex items-center justify-between">
                    <button
                      onClick={handleClose}
                      className="text-[13px] text-[#86868b] hover:text-[#1d1d1f] transition-colors"
                    >
                      Close
                    </button>
                    <button
                      onClick={handleNext}
                      className="px-5 py-2 rounded-full bg-[#0071e3] text-white text-[13px] font-medium hover:bg-[#0077ed] transition-colors active:scale-95"
                    >
                      Start Assembly
                    </button>
                  </div>
                </>
              )}

              {/* Step state */}
              {currentStepData && !isComplete && (
                <>
                  <p className="text-[12px] text-[#86868b] mb-1">
                    Step {stepIndex + 1} of {state.totalSteps}
                  </p>
                  <p className="text-[15px] text-[#1d1d1f] font-medium leading-relaxed mb-4">
                    {currentStepData.copy}
                  </p>
                  <div className="flex items-center justify-between">
                    <button
                      onClick={handleBack}
                      disabled={state.isAnimating}
                      className="text-[13px] text-[#86868b] hover:text-[#1d1d1f] transition-colors disabled:opacity-30"
                    >
                      Back
                    </button>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={handleClose}
                        className="text-[13px] text-[#86868b] hover:text-[#1d1d1f] transition-colors"
                      >
                        Close
                      </button>
                      <button
                        onClick={handleNext}
                        disabled={state.isAnimating}
                        className="px-5 py-2 rounded-full bg-[#0071e3] text-white text-[13px] font-medium hover:bg-[#0077ed] transition-colors active:scale-95 disabled:opacity-50"
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
                    <div className="w-5 h-5 rounded-full bg-[#34c759] flex items-center justify-center flex-shrink-0">
                      <svg
                        className="w-3 h-3 text-white"
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
                    <h3 className="text-[17px] font-semibold text-[#1d1d1f]">
                      Assembly Complete
                    </h3>
                  </div>
                  <p className="text-[14px] text-[#424245] leading-relaxed mb-4">
                    Your {guide.title.toLowerCase()} is fully assembled. You can
                    restart the guide or close this panel to explore the model.
                  </p>
                  <div className="flex items-center justify-between">
                    <button
                      onClick={handleClose}
                      className="text-[13px] text-[#86868b] hover:text-[#1d1d1f] transition-colors"
                    >
                      Close
                    </button>
                    <button
                      onClick={handleRestart}
                      className="px-5 py-2 rounded-full bg-[#0071e3] text-white text-[13px] font-medium hover:bg-[#0077ed] transition-colors active:scale-95"
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
