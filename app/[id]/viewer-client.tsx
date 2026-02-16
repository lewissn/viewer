"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import Image from "next/image";

/** Regex to detect "door" parts — extend this pattern as needed */
const DOOR_PATTERN = /\bdoor\b/i;

/** Default edge colour (dark grey — visible on white cabinets) */
const DEFAULT_EDGE_COLOR = "#444444";
const EDGE_THRESHOLD = 1; // degrees

interface PartInfo {
  name: string;
  width: number;
  height: number;
  depth: number;
}

interface Props {
  modelUrls: string[];
  jobNumber: string;
}

/** Convert hex like "#ff00aa" to {r,g,b} 0-255 */
function hexToRgb(hex: string) {
  const h = hex.replace("#", "");
  return {
    r: parseInt(h.substring(0, 2), 16),
    g: parseInt(h.substring(2, 4), 16),
    b: parseInt(h.substring(4, 6), 16),
  };
}

export default function ViewerClient({ modelUrls, jobNumber }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<any>(null);
  const ovRef = useRef<any>(null);

  const [doorsVisible, setDoorsVisible] = useState(true);
  const [selectedPart, setSelectedPart] = useState<PartInfo | null>(null);
  const [hasSelection, setHasSelection] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [showEdges, setShowEdges] = useState(false);
  const [edgeColor, setEdgeColor] = useState(DEFAULT_EDGE_COLOR);
  const [menuOpen, setMenuOpen] = useState(false);

  // Track hidden mesh instance IDs (using the o3dv internal mesh instance references)
  const hiddenMeshInstances = useRef<Set<any>>(new Set());
  const doorsVisibleRef = useRef(true);
  const selectedUserData = useRef<any>(null);

  // --- Highlight helper ---
  function applyHighlight(userData: any | null) {
    const OV = ovRef.current;
    const viewer = viewerRef.current?.GetViewer();
    if (!viewer || !OV) return;

    const highlightColor = new OV.RGBColor(0, 113, 227); // Apple blue
    viewer.SetMeshesHighlight(highlightColor, (ud: any) => {
      if (!ud?.originalMeshInstance || !userData?.originalMeshInstance)
        return false;
      return ud.originalMeshInstance === userData.originalMeshInstance;
    });
    viewer.Render();
  }

  const initViewer = useCallback(async () => {
    if (!containerRef.current) return;

    const OV = await import("online-3d-viewer");
    ovRef.current = OV;

    // Initialise the embedded viewer with load callbacks
    const embeddedViewer = new OV.EmbeddedViewer(containerRef.current, {
      backgroundColor: new OV.RGBAColor(250, 250, 250, 255),
      defaultColor: new OV.RGBColor(200, 200, 200),
      edgeSettings: new OV.EdgeSettings(false, new OV.RGBColor(0, 0, 0), EDGE_THRESHOLD),
      onModelLoaded: () => {
        setLoading(false);
      },
      onModelLoadFailed: () => {
        setLoading(false);
        setLoadError(
          "Failed to load the 3D model. The file may be unavailable."
        );
      },
    });

    viewerRef.current = embeddedViewer;

    // Handle click-to-select via the underlying viewer
    const viewer = embeddedViewer.GetViewer();
    viewer.SetMouseClickHandler(
      (button: number, mouseCoords: { x: number; y: number }) => {
        if (button !== 1) return;

        const userData = viewer.GetMeshUserDataUnderMouse(
          OV.IntersectionMode.MeshOnly,
          mouseCoords
        );

        if (!userData || !userData.originalMeshInstance) {
          setSelectedPart(null);
          setHasSelection(false);
          selectedUserData.current = null;
          applyHighlight(null);
          return;
        }

        selectedUserData.current = userData;
        setHasSelection(true);
        applyHighlight(userData);

        const meshInstance = userData.originalMeshInstance;
        const nodeName =
          meshInstance.node?.GetName?.() ||
          meshInstance.GetMesh?.()?.GetName?.() ||
          "Unknown Part";

        // Compute bounding box via the exported GetBoundingBox utility
        let width = 0,
          height = 0,
          depth = 0;
        try {
          const box = OV.GetBoundingBox(meshInstance);
          if (box) {
            const min = box.GetMin();
            const max = box.GetMax();
            width = Math.round(Math.abs(max.x - min.x));
            height = Math.round(Math.abs(max.y - min.y));
            depth = Math.round(Math.abs(max.z - min.z));
          }
        } catch {
          // Bounding box calculation can fail on some meshes
        }

        setSelectedPart({ name: nodeName, width, height, depth });
      }
    );

    // Load model from URL list
    embeddedViewer.LoadModelFromUrlList(modelUrls);
  }, [modelUrls]);

  useEffect(() => {
    initViewer();
    return () => {
      if (viewerRef.current) {
        try {
          viewerRef.current.Destroy();
        } catch {
          // Viewer may already be destroyed
        }
      }
    };
  }, [initViewer]);

  // Listen for fullscreen changes
  useEffect(() => {
    function handleFsChange() {
      setIsFullscreen(!!document.fullscreenElement);
    }
    document.addEventListener("fullscreenchange", handleFsChange);
    return () =>
      document.removeEventListener("fullscreenchange", handleFsChange);
  }, []);

  // --- Visibility helper ---
  function applyVisibility() {
    const viewer = viewerRef.current?.GetViewer();
    if (!viewer) return;

    viewer.SetMeshesVisibility((userData: any) => {
      if (!userData?.originalMeshInstance) return true;
      if (hiddenMeshInstances.current.has(userData.originalMeshInstance)) return false;
      if (!doorsVisibleRef.current) {
        const mi = userData.originalMeshInstance;
        const name = mi.node?.GetName?.() || mi.GetMesh?.()?.GetName?.() || "";
        if (DOOR_PATTERN.test(name)) return false;
      }
      return true;
    });
    viewer.Render();
  }

  // --- Edge helpers ---
  function applyEdgeSettings(show: boolean, color: string) {
    const OV = ovRef.current;
    const viewer = viewerRef.current?.GetViewer();
    if (!viewer || !OV) return;

    const rgb = hexToRgb(color);
    viewer.SetEdgeSettings(
      new OV.EdgeSettings(show, new OV.RGBColor(rgb.r, rgb.g, rgb.b), EDGE_THRESHOLD)
    );
    viewer.Render();
  }

  // --- Control handlers ---

  function toggleDoors() {
    const newVisible = !doorsVisible;
    setDoorsVisible(newVisible);
    doorsVisibleRef.current = newVisible;
    applyVisibility();
  }

  function hideSelected() {
    if (!selectedUserData.current?.originalMeshInstance) return;

    hiddenMeshInstances.current.add(
      selectedUserData.current.originalMeshInstance
    );
    applyVisibility();
    applyHighlight(null);
    setSelectedPart(null);
    setHasSelection(false);
    selectedUserData.current = null;
  }

  function showAll() {
    hiddenMeshInstances.current.clear();
    setDoorsVisible(true);
    doorsVisibleRef.current = true;
    applyVisibility();
  }

  function resetView() {
    showAll();
    applyHighlight(null);
    setSelectedPart(null);
    setHasSelection(false);
    selectedUserData.current = null;
    const viewer = viewerRef.current?.GetViewer();
    if (viewer) {
      viewer.FitSphereToWindow(viewer.GetBoundingSphere(false), true);
    }
  }

  function toggleFullscreen() {
    const el = containerRef.current?.parentElement;
    if (!el) return;
    if (!document.fullscreenElement) {
      el.requestFullscreen();
    } else {
      document.exitFullscreen();
    }
  }

  function handleToggleEdges() {
    const next = !showEdges;
    setShowEdges(next);
    applyEdgeSettings(next, edgeColor);
  }

  function handleEdgeColorChange(color: string) {
    setEdgeColor(color);
    if (showEdges) {
      applyEdgeSettings(true, color);
    }
  }

  // --- Render helpers ---
  const controlButtons = (
    <>
      <ControlButton
        onClick={toggleDoors}
        active={!doorsVisible}
        title={doorsVisible ? "Hide Doors" : "Show Doors"}
        label="Doors"
      >
        <DoorIcon />
      </ControlButton>
      <ControlButton
        onClick={hideSelected}
        disabled={!hasSelection}
        title="Hide Selected"
        label="Hide"
      >
        <EyeOffIcon />
      </ControlButton>
      <ControlButton onClick={showAll} title="Show All" label="Show All">
        <EyeIcon />
      </ControlButton>
      <ControlButton onClick={resetView} title="Reset View" label="Reset">
        <ResetIcon />
      </ControlButton>

      {/* Edges toggle + colour */}
      <div className="flex items-center gap-1">
        <ControlButton
          onClick={handleToggleEdges}
          active={showEdges}
          title="Show Edges"
          label="Edges"
        >
          <EdgesIcon />
        </ControlButton>
        {showEdges && (
          <label
            title="Edge colour"
            className="relative flex items-center justify-center w-9 h-9 rounded-xl backdrop-blur-xl bg-white/70 shadow-[0_1px_8px_rgba(0,0,0,0.08)] cursor-pointer overflow-hidden"
          >
            <div
              className="w-4 h-4 rounded-full border border-white/60"
              style={{ backgroundColor: edgeColor }}
            />
            <input
              type="color"
              value={edgeColor}
              onChange={(e) => handleEdgeColorChange(e.target.value)}
              className="absolute inset-0 opacity-0 cursor-pointer"
            />
          </label>
        )}
      </div>

      <ControlButton
        onClick={toggleFullscreen}
        active={isFullscreen}
        title="Fullscreen"
        label="Full"
      >
        <FullscreenIcon />
      </ControlButton>
      <ControlButton
        onClick={() => setShowHelp(!showHelp)}
        active={showHelp}
        title="Help"
        label="Help"
      >
        <HelpIcon />
      </ControlButton>
    </>
  );

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
              Job #{jobNumber}
            </span>
          </div>
        </div>

        {/* Desktop controls (hidden on mobile) */}
        <div className="pointer-events-auto hidden sm:flex items-center gap-1.5">
          {controlButtons}
        </div>

        {/* Mobile hamburger (visible on mobile only) */}
        <div className="pointer-events-auto sm:hidden">
          <button
            onClick={() => setMenuOpen(!menuOpen)}
            className={`
              flex items-center justify-center w-9 h-9 rounded-xl backdrop-blur-xl transition-all
              ${
                menuOpen
                  ? "bg-[#0071e3] text-white shadow-[0_2px_8px_rgba(0,113,227,0.3)]"
                  : "bg-white/70 text-[#1d1d1f] shadow-[0_1px_8px_rgba(0,0,0,0.08)]"
              }
            `}
          >
            {menuOpen ? <CloseIcon /> : <MenuIcon />}
          </button>
        </div>
      </div>

      {/* Mobile menu panel */}
      {menuOpen && (
        <div className="absolute top-16 right-4 z-30 sm:hidden backdrop-blur-xl bg-white/90 rounded-2xl shadow-[0_4px_24px_rgba(0,0,0,0.12)] p-3">
          <div className="flex flex-col gap-1.5">{controlButtons}</div>
        </div>
      )}

      {/* Help overlay */}
      {showHelp && (
        <div className="absolute top-16 right-4 sm:right-6 z-30 backdrop-blur-xl bg-white/80 rounded-2xl shadow-[0_4px_24px_rgba(0,0,0,0.12)] p-5 max-w-[280px]">
          <h3 className="text-[14px] font-semibold text-[#1d1d1f] mb-3">
            Controls
          </h3>
          <div className="space-y-2 text-[13px] text-[#424245]">
            <p>
              <b>Rotate:</b> Left-click + drag
            </p>
            <p>
              <b>Pan:</b> Right-click + drag
            </p>
            <p>
              <b>Zoom:</b> Scroll wheel / pinch
            </p>
            <p>
              <b>Select:</b> Click on a part
            </p>
          </div>
        </div>
      )}

      {/* Selected part info chip */}
      {selectedPart && (
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-20 backdrop-blur-xl bg-white/80 rounded-2xl shadow-[0_4px_24px_rgba(0,0,0,0.12)] px-5 py-3.5 max-w-[90vw]">
          <p className="text-[14px] font-semibold text-[#1d1d1f] truncate">
            {selectedPart.name}
          </p>
          <p className="text-[13px] text-[#86868b] mt-0.5">
            {selectedPart.width} &times; {selectedPart.height} &times;{" "}
            {selectedPart.depth} mm
          </p>
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
        style={{ visibility: loading || loadError ? "hidden" : "visible" }}
      />

    </div>
  );
}

/* ─── Shared button component ─── */

function ControlButton({
  children,
  onClick,
  active,
  disabled,
  title,
  label,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  active?: boolean;
  disabled?: boolean;
  title?: string;
  label?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`
        flex items-center justify-center gap-1.5 sm:w-9 h-9 rounded-xl backdrop-blur-xl transition-all px-3 sm:px-0
        ${
          active
            ? "bg-[#0071e3] text-white shadow-[0_2px_8px_rgba(0,113,227,0.3)]"
            : "bg-white/70 text-[#1d1d1f] shadow-[0_1px_8px_rgba(0,0,0,0.08)] hover:bg-white/90"
        }
        ${disabled ? "opacity-30 cursor-not-allowed" : "active:scale-90"}
      `}
    >
      {children}
      {label && (
        <span className="sm:hidden text-[12px] font-medium">{label}</span>
      )}
    </button>
  );
}

/* ─── Icons (minimal inline SVGs) ─── */

function MenuIcon() {
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
        d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5"
      />
    </svg>
  );
}

function CloseIcon() {
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
        d="M6 18L18 6M6 6l12 12"
      />
    </svg>
  );
}

function DoorIcon() {
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
        d="M3 21h18M5 21V5a2 2 0 012-2h5l5 2v16"
      />
      <circle cx="14" cy="12" r="1" fill="currentColor" />
    </svg>
  );
}

function EyeOffIcon() {
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
        d="M3.98 8.223A10.477 10.477 0 001.934 12c1.292 4.338 5.31 7.5 10.066 7.5.993 0 1.953-.138 2.863-.395M6.228 6.228A10.45 10.45 0 0112 4.5c4.756 0 8.773 3.162 10.065 7.498a10.523 10.523 0 01-4.293 5.774M6.228 6.228L3 3m3.228 3.228l3.65 3.65m7.894 7.894L21 21m-3.228-3.228l-3.65-3.65m0 0a3 3 0 10-4.243-4.243m4.242 4.242L9.88 9.88"
      />
    </svg>
  );
}

function EyeIcon() {
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
        d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z"
      />
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
      />
    </svg>
  );
}

function ResetIcon() {
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
        d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182"
      />
    </svg>
  );
}

function EdgesIcon() {
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
        d="M21 7.5l-9-5.25L3 7.5m18 0l-9 5.25m9-5.25v9l-9 5.25M3 7.5l9 5.25M3 7.5v9l9 5.25m0-9v9"
      />
    </svg>
  );
}

function FullscreenIcon() {
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
        d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75h-4.5m4.5 0v4.5m0-4.5L15 9m5.25 11.25h-4.5m4.5 0v-4.5m0 4.5L15 15"
      />
    </svg>
  );
}

function HelpIcon() {
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
        d="M9.879 7.519c1.171-1.025 3.071-1.025 4.242 0 1.172 1.025 1.172 2.687 0 3.712-.203.179-.43.326-.67.442-.745.361-1.45.999-1.45 1.827v.75M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9 5.25h.008v.008H12v-.008z"
      />
    </svg>
  );
}
