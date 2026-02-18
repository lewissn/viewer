"use client";

import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { useSearchParams } from "next/navigation";
import Image from "next/image";
import type { Project, CabinetInstance } from "@/lib/projects";
import {
  AssemblyGuideController,
  type ControllerState,
} from "@/lib/assemblyGuideController";
import { buildProjectNavigation } from "@/lib/navigation";
import { DesktopSidebar, MobileNav } from "@/app/assembly/side-nav";

/* eslint-disable @typescript-eslint/no-explicit-any */

interface Props {
  project: Project;
}

export default function ProjectClient({ project }: Props) {
  const searchParams = useSearchParams();
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
      embeddedViewer.LoadModelFromUrlList([cabinet.modelFileUrl]);
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

  return (
    <div className="flex w-screen h-screen bg-[#fafafa] overflow-hidden">
      {/* Desktop sidebar */}
      <DesktopSidebar sections={navSections} fittings={activeCabinet?.erpFittings} />

      {/* Main viewer area */}
      <div className="relative flex-1 h-screen overflow-hidden">
        {/* Top bar */}
        <div className="absolute top-0 left-0 right-0 z-20 flex items-center justify-between px-4 sm:px-6 py-3 pointer-events-none">
          <div className="pointer-events-auto flex items-center gap-2">
            <MobileNav sections={navSections} fittings={activeCabinet?.erpFittings} />
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

          {!wizardOpen && !loading && !loadError && hasCabinet && (
            <div className="pointer-events-auto">
              <button
                onClick={handleReopen}
                className="flex items-center gap-1.5 h-9 px-3 rounded-xl backdrop-blur-xl bg-white/70 text-[#1d1d1f] shadow-[0_1px_8px_rgba(0,0,0,0.08)] hover:bg-white/90 transition-all active:scale-95 text-[13px] font-medium"
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
              <div className="bg-white rounded-2xl shadow-[0_8px_40px_rgba(0,0,0,0.12)] max-w-lg w-full max-h-[85vh] overflow-y-auto animate-scale-in">
                {/* Header */}
                <div className="px-6 pt-6 pb-4 border-b border-[#f0f0f0]">
                  <p className="text-[12px] font-medium text-[#0071e3] uppercase tracking-wider mb-1">
                    Assembly Guide
                  </p>
                  <h2 className="text-[22px] font-semibold text-[#1d1d1f]">
                    Welcome{project.customerName ? `, ${project.customerName}` : ""}!
                  </h2>
                  <p className="mt-1 text-[14px] text-[#86868b]">
                    {project.projectName}
                  </p>
                </div>

                {/* Content */}
                <div className="px-6 py-5 space-y-5">
                  <p className="text-[14px] text-[#424245] leading-relaxed">
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
                      <h4 className="text-[14px] font-semibold text-[#1d1d1f] mb-0.5">
                        Prepare your space
                      </h4>
                      <p className="text-[13px] text-[#424245] leading-relaxed">
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
                      <h4 className="text-[14px] font-semibold text-[#1d1d1f] mb-0.5">
                        Unpack and organise panels
                      </h4>
                      <p className="text-[13px] text-[#424245] leading-relaxed">
                        Lay out all panels for the cabinet you are about to
                        build. Familiarise yourself with each piece — the
                        printed labels on the edges will match the part names
                        shown in the guide.
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
                      <h4 className="text-[14px] font-semibold text-[#1d1d1f] mb-0.5">
                        Sort your fittings
                      </h4>
                      <p className="text-[13px] text-[#424245] leading-relaxed">
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
                      <h4 className="text-[14px] font-semibold text-[#1d1d1f] mb-0.5">
                        Pre-insert cams, cam pins and hinge plates
                      </h4>
                      <p className="text-[13px] text-[#424245] leading-relaxed">
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
                      <h4 className="text-[14px] font-semibold text-[#1d1d1f] mb-0.5">
                        Tools you will need
                      </h4>
                      <p className="text-[13px] text-[#424245] leading-relaxed">
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
                    className="text-[13px] text-[#86868b] hover:text-[#1d1d1f] transition-colors"
                  >
                    Skip
                  </button>
                  <button
                    onClick={() => setShowWelcome(false)}
                    className="px-6 py-2.5 rounded-full bg-[#0071e3] text-white text-[14px] font-medium hover:bg-[#0077ed] transition-colors active:scale-95"
                  >
                    Get Started
                  </button>
                </div>
              </div>
            ) : (
              <div className="text-center">
                <h2 className="text-[20px] font-semibold text-[#1d1d1f] mb-2">
                  {project.projectName}
                </h2>
                {project.customerName && (
                  <p className="text-[14px] text-[#86868b] mb-4">
                    {project.customerName}
                  </p>
                )}
                <p className="text-[15px] text-[#424245] text-center max-w-sm">
                  Select a cabinet from the sidebar to begin.
                </p>
              </div>
            )}
          </div>
        )}

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
          style={{
            visibility:
              loading || loadError || !hasCabinet ? "hidden" : "visible",
          }}
        />

        {/* Wizard modal */}
        {wizardOpen && !loading && !loadError && hasCabinet && (
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
                          i <= stepIndex ? "#0071e3" : "#d2d2d7",
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
                      {cabinetTitle}
                    </h3>
                    <p className="text-[14px] text-[#424245] leading-relaxed mb-4">
                      Follow the step-by-step guide to assemble your cabinet.
                      Each step highlights the parts to fit.
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
                          {stepIndex + 1 >= state.totalSteps
                            ? "Finish"
                            : "Next"}
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
                      Your {cabinetTitle.toLowerCase()} is fully assembled. You
                      can restart the guide or close this panel.
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
    </div>
  );
}
