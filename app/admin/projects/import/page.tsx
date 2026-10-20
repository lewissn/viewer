"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { classifyPart } from "@/lib/classifyPart";
import { parseCabinetCsv } from "@/lib/parseCabinetCsv";
import {
  detectProject,
  stripCommonRoot,
  type DetectedCabinet,
  type DetectionResult,
} from "@/lib/importFolder";
import { readDataTransfer, readFileList, readZip } from "@/lib/readImportSource";
import { uploadAndBuildCabinets, type UploadProgress } from "@/lib/uploadImport";
import {
  candidatesToCabinets,
  splitProjectModels,
  staleMessage,
  type ProjectSplitResult,
  type SplitCandidate,
} from "@/lib/projectSplitImport";
import { CATEGORY_LABELS } from "@/lib/fittings";

type Stage = "drop" | "review" | "uploading" | "done";

/**
 * Where the cabinets come from: per-cabinet model + CSV exports, or the
 * whole-project model split into cabinets.
 */
type Mode = "pairs" | "split";

export default function ImportProjectPage() {
  const [stage, setStage] = useState<Stage>("drop");
  const [dragging, setDragging] = useState(false);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState("");

  const [detection, setDetection] = useState<DetectionResult | null>(null);
  const [projectId, setProjectId] = useState("");
  const [projectName, setProjectName] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [excluded, setExcluded] = useState<Set<string>>(new Set());

  const [mode, setMode] = useState<Mode>("pairs");
  const [splitting, setSplitting] = useState(false);
  const [split, setSplit] = useState<ProjectSplitResult | null>(null);
  const [splitNames, setSplitNames] = useState<Record<string, string>>({});
  const [splitIncluded, setSplitIncluded] = useState<Set<string>>(new Set());
  const [importedCount, setImportedCount] = useState(0);

  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [importWarnings, setImportWarnings] = useState<string[]>([]);
  const [savedProjectId, setSavedProjectId] = useState("");

  const folderInputRef = useRef<HTMLInputElement>(null);
  const zipInputRef = useRef<HTMLInputElement>(null);

  const baseUrl =
    process.env.NEXT_PUBLIC_BASE_URL ||
    (typeof window !== "undefined" ? window.location.origin : "");

  const runSplit = useCallback(async (result: DetectionResult) => {
    setSplitting(true);
    setError("");
    try {
      const out = await splitProjectModels(result.projectModels);
      setSplit(out);
      setSplitNames(Object.fromEntries(out.candidates.map((c) => [c.key, c.suggestedName])));
      // Cabinets are in by default; loose parts and accessories are opt-in
      setSplitIncluded(
        new Set(out.candidates.filter((c) => c.kind === "cabinet").map((c) => c.key))
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not split the project model.");
    } finally {
      setSplitting(false);
    }
  }, []);

  const applySource = useCallback(
    (rootName: string, rawEntries: Parameters<typeof stripCommonRoot>[0]) => {
      const { root, entries } = stripCommonRoot(rawEntries);
      const folderName = root || rootName;
      const result = detectProject(entries, folderName);

      setDetection(result);
      setProjectId(result.projectId);
      setProjectName(result.projectName);
      setCustomerName(result.customerName);
      setExcluded(new Set());
      setSplit(null);
      setStage("review");

      // Per-cabinet exports win when there are any; otherwise split the
      // whole-project model straight away.
      if (result.cabinets.length === 0 && result.projectModels.length > 0) {
        setMode("split");
        runSplit(result);
      } else {
        setMode("pairs");
      }
    },
    [runSplit]
  );

  function switchMode(next: Mode) {
    setMode(next);
    if (next === "split" && !split && detection) runSplit(detection);
  }

  const handleFiles = useCallback(
    async (files: FileList | File[]) => {
      setError("");
      setReading(true);
      try {
        const list = Array.from(files);
        // A single .zip is unpacked; anything else is treated as a folder pick
        if (list.length === 1 && /\.zip$/i.test(list[0].name)) {
          const source = await readZip(list[0]);
          applySource(source.rootName, source.entries);
        } else {
          const source = readFileList(list);
          applySource(source.rootName, source.entries);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not read those files.");
      } finally {
        setReading(false);
      }
    },
    [applySource]
  );

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      setError("");
      setReading(true);
      try {
        const source = await readDataTransfer(e.dataTransfer);
        applySource(source.rootName, source.entries);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not read that folder.");
      } finally {
        setReading(false);
      }
    },
    [applySource]
  );

  function toggleExcluded(code: string) {
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  }

  function toggleSplitIncluded(key: string) {
    setSplitIncluded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const includedCabinets =
    detection?.cabinets.filter((c) => !excluded.has(`${c.code}-${c.index}`)) ?? [];
  const includedCandidates =
    split?.candidates.filter((c) => splitIncluded.has(c.key)) ?? [];
  const includedCount =
    mode === "split" ? includedCandidates.length : includedCabinets.length;

  async function handleImport() {
    if (!detection) return;
    if (!projectId.trim()) {
      setError("Enter an order number before importing.");
      return;
    }
    if (includedCount === 0) {
      setError("Select at least one cabinet to import.");
      return;
    }
    if (mode === "split" && includedCandidates.some((c) => !(splitNames[c.key] ?? "").trim())) {
      setError("Give every included cabinet a name.");
      return;
    }

    setError("");
    setStage("uploading");
    setProgress({ done: 0, total: 0, current: "" });

    try {
      // Split cabinets go up as synthetic per-cabinet exports
      const toUpload: DetectedCabinet[] =
        mode === "split"
          ? candidatesToCabinets(
              includedCandidates.map((candidate) => ({
                candidate,
                name: splitNames[candidate.key] ?? candidate.suggestedName,
              }))
            )
          : includedCabinets;

      const { cabinets, warnings } = await uploadAndBuildCabinets(
        projectId.trim(),
        toUpload,
        setProgress
      );

      const res = await fetch("/api/projects/upsert", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: projectId.trim(),
          projectName: projectName.trim() || projectId.trim(),
          customerName: customerName.trim() || undefined,
          cabinets,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Could not save the project.");
        setStage("review");
        return;
      }

      setImportWarnings(warnings);
      setImportedCount(cabinets.length);
      setSavedProjectId(data.project.project_id);
      setStage("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed.");
      setStage("review");
    }
  }

  function reset() {
    setStage("drop");
    setDetection(null);
    setSplit(null);
    setMode("pairs");
    setError("");
    setProgress(null);
    setImportWarnings([]);
    setSavedProjectId("");
  }

  const customerUrl = savedProjectId ? `${baseUrl}/project/${savedProjectId}` : "";

  return (
    <div className="min-h-screen bg-[#fafafa] px-4 py-12 sm:px-6">
      <div className="w-full max-w-3xl mx-auto">
        <div className="text-center mb-8">
          <h1 className="text-[28px] font-semibold tracking-tight text-[#1d1d1f]">
            Import Order Folder
          </h1>
          <p className="mt-2 text-[15px] text-[#86868b]">
            Drop the customer folder in — cabinets, parts, fittings and textures
            are sorted out for you
          </p>
        </div>

        <div className="flex items-center gap-3 mb-6">
          <Link href="/admin/projects" className="text-[13px] text-[#0071e3] hover:underline">
            &larr; All Projects
          </Link>
        </div>

        {error && (
          <div className="mb-6 rounded-xl bg-[#fff5f5] border border-[#fecaca] px-4 py-3 text-[14px] text-[#dc2626]">
            {error}
          </div>
        )}

        {/* ── Drop zone ── */}
        {stage === "drop" && (
          <div className="bg-white rounded-2xl shadow-[0_0_0_1px_rgba(0,0,0,0.04),0_2px_12px_rgba(0,0,0,0.06)] p-8">
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={handleDrop}
              className={`rounded-2xl border-2 border-dashed px-6 py-16 text-center transition-all ${
                dragging
                  ? "border-[#0071e3] bg-[#0071e3]/5"
                  : "border-[#d2d2d7] bg-[#fafafa]"
              }`}
            >
              {reading ? (
                <div className="flex flex-col items-center gap-3">
                  <div className="w-6 h-6 border-2 border-[#d2d2d7] border-t-[#0071e3] rounded-full animate-spin" />
                  <p className="text-[14px] text-[#86868b]">Reading files...</p>
                </div>
              ) : (
                <>
                  <p className="text-[17px] font-medium text-[#1d1d1f]">
                    Drop the order folder here
                  </p>
                  <p className="mt-2 text-[14px] text-[#86868b]">
                    e.g. &ldquo;Sarah Culloty #11569&rdquo; &mdash; or a zip of it
                  </p>
                  <div className="mt-6 flex items-center justify-center gap-3">
                    <button
                      onClick={() => folderInputRef.current?.click()}
                      className="rounded-xl bg-[#0071e3] px-5 py-2.5 text-[14px] font-medium text-white hover:bg-[#0077ed] transition-all active:scale-[0.98]"
                    >
                      Choose Folder
                    </button>
                    <button
                      onClick={() => zipInputRef.current?.click()}
                      className="rounded-xl bg-white px-5 py-2.5 text-[14px] font-medium text-[#1d1d1f] border border-[#d2d2d7] hover:bg-[#f5f5f7] transition-all active:scale-[0.98]"
                    >
                      Choose Zip
                    </button>
                  </div>
                </>
              )}
            </div>

            <input
              ref={folderInputRef}
              type="file"
              // Non-standard but universally supported attributes for folder picking
              {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
              multiple
              hidden
              onChange={(e) => e.target.files && handleFiles(e.target.files)}
            />
            <input
              ref={zipInputRef}
              type="file"
              accept=".zip"
              hidden
              onChange={(e) => e.target.files && handleFiles(e.target.files)}
            />

            <div className="mt-6 rounded-xl bg-[#f5f5f7] p-5">
              <p className="text-[12px] font-semibold text-[#86868b] uppercase tracking-wider mb-2">
                What it looks for
              </p>
              <p className="text-[13px] text-[#424245] leading-relaxed">
                The project&rsquo;s own export &mdash;{" "}
                <span className="font-mono">Sarah Culloty - 11569.3ds</span> and
                its texture folder &mdash; is split into cabinets for you. The
                .pb-proj is used to check the model is up to date, and the
                hardware list for fittings. If the folder has per-cabinet
                exports (<span className="font-mono">TDB LHS.3ds</span> +{" "}
                <span className="font-mono">TDB LHS.CSV</span>), those are used
                instead. PDFs are skipped.
              </p>
            </div>
          </div>
        )}

        {/* ── Review ── */}
        {stage === "review" && detection && (
          <>
            {mode === "split" && split && split.stale.length > 0 && (
              <div
                role="alert"
                className="mb-6 rounded-2xl border-2 border-[#f59e0b] bg-[#fffbeb] px-5 py-4"
              >
                <p className="text-[15px] font-semibold text-[#92400e]">
                  The project model may be out of date
                </p>
                {split.stale.map((s) => (
                  <p key={s.modelPath} className="mt-1.5 text-[13px] text-[#92400e] leading-relaxed">
                    {staleMessage(s)}
                  </p>
                ))}
              </div>
            )}

            <div className="bg-white rounded-2xl shadow-[0_0_0_1px_rgba(0,0,0,0.04),0_2px_12px_rgba(0,0,0,0.06)] p-6 mb-6">
              <h2 className="text-[13px] font-semibold text-[#86868b] uppercase tracking-wider mb-4">
                Project Details
              </h2>
              <div className="grid gap-4 sm:grid-cols-3">
                <Field label="Order Number" value={projectId} onChange={setProjectId} mono />
                <Field label="Project Name" value={projectName} onChange={setProjectName} />
                <Field label="Customer" value={customerName} onChange={setCustomerName} />
              </div>
              {detection.warnings.map((w, i) => (
                <p key={i} className="mt-3 text-[13px] text-[#92400e]">
                  {w}
                </p>
              ))}
            </div>

            <SourceSwitch
              mode={mode}
              pairCount={detection.cabinets.length}
              projectModels={detection.projectModels.map((m) => m.model.path)}
              onSwitch={switchMode}
            />

            {mode === "split" && (
              <SplitReview
                splitting={splitting}
                result={split}
                multipleModels={detection.projectModels.length > 1}
                names={splitNames}
                included={splitIncluded}
                onRename={(key, name) => setSplitNames((prev) => ({ ...prev, [key]: name }))}
                onToggle={toggleSplitIncluded}
              />
            )}

            {mode === "pairs" && (
            <div className="bg-white rounded-2xl shadow-[0_0_0_1px_rgba(0,0,0,0.04),0_2px_12px_rgba(0,0,0,0.06)] p-6 mb-6">
              <h2 className="text-[13px] font-semibold text-[#86868b] uppercase tracking-wider mb-4">
                Cabinets Found ({detection.cabinets.length})
              </h2>

              {detection.cabinets.length === 0 ? (
                <p className="text-[14px] text-[#86868b] py-4">
                  No model + CSV pairs in that folder.
                </p>
              ) : (
                <div className="space-y-3">
                  {detection.cabinets.map((cab) => {
                    const key = `${cab.code}-${cab.index}`;
                    const isExcluded = excluded.has(key);
                    return (
                      <CabinetRow
                        key={key}
                        code={cab.code}
                        index={cab.index}
                        duplicate={
                          detection.cabinets.filter((c) => c.code === cab.code).length > 1
                        }
                        csvName={cab.csv?.path ?? ""}
                        modelName={cab.model.path}
                        modelSize={cab.model.size}
                        textureCount={cab.textures.length}
                        csvBlob={cab.csv?.data ?? new Blob()}
                        excluded={isExcluded}
                        onToggle={() => toggleExcluded(key)}
                      />
                    );
                  })}
                </div>
              )}
            </div>
            )}

            {detection.skipped.length > 0 && (
              <details className="bg-white rounded-2xl shadow-[0_0_0_1px_rgba(0,0,0,0.04),0_2px_12px_rgba(0,0,0,0.06)] p-6 mb-6">
                <summary className="text-[13px] font-semibold text-[#86868b] uppercase tracking-wider cursor-pointer">
                  Skipped Files ({detection.skipped.length})
                </summary>
                <ul className="mt-4 space-y-1.5">
                  {detection.skipped.map((s, i) => (
                    <li key={i} className="text-[12px] text-[#424245]">
                      <span className="font-mono">{s.path}</span>
                      <span className="text-[#86868b]"> &mdash; {s.reason}</span>
                    </li>
                  ))}
                </ul>
              </details>
            )}

            <div className="flex items-center gap-3">
              <button
                onClick={handleImport}
                disabled={includedCount === 0 || splitting}
                className="rounded-xl bg-[#0071e3] px-6 py-3 text-[15px] font-medium text-white hover:bg-[#0077ed] transition-all active:scale-[0.98] disabled:opacity-50"
              >
                Import {includedCount} Cabinet
                {includedCount !== 1 ? "s" : ""}
              </button>
              <button
                onClick={reset}
                className="rounded-xl bg-white px-5 py-3 text-[15px] font-medium text-[#1d1d1f] border border-[#d2d2d7] hover:bg-[#f5f5f7] transition-all active:scale-[0.98]"
              >
                Start Over
              </button>
            </div>
          </>
        )}

        {/* ── Uploading ── */}
        {stage === "uploading" && (
          <div className="bg-white rounded-2xl shadow-[0_0_0_1px_rgba(0,0,0,0.04),0_2px_12px_rgba(0,0,0,0.06)] p-8">
            <div className="flex items-center gap-3 mb-5">
              <div className="w-5 h-5 border-2 border-[#d2d2d7] border-t-[#0071e3] rounded-full animate-spin" />
              <p className="text-[15px] font-medium text-[#1d1d1f]">
                Uploading files...
              </p>
            </div>
            <div className="h-2 rounded-full bg-[#f5f5f7] overflow-hidden">
              <div
                className="h-full bg-[#0071e3] transition-all duration-300"
                style={{
                  width: progress?.total
                    ? `${(progress.done / progress.total) * 100}%`
                    : "0%",
                }}
              />
            </div>
            <p className="mt-3 text-[13px] text-[#86868b]">
              {progress?.total
                ? `${progress.done} of ${progress.total} — ${progress.current}`
                : "Preparing..."}
            </p>
          </div>
        )}

        {/* ── Done ── */}
        {stage === "done" && (
          <div className="bg-white rounded-2xl shadow-[0_0_0_1px_rgba(0,0,0,0.04),0_2px_12px_rgba(0,0,0,0.06)] p-8">
            <h2 className="text-[19px] font-semibold text-[#1d1d1f] mb-1">
              Assembly guide ready
            </h2>
            <p className="text-[14px] text-[#86868b] mb-6">
              {importedCount} cabinet
              {importedCount !== 1 ? "s" : ""} imported for{" "}
              {projectName || projectId}.
            </p>

            <div className="flex items-center gap-2 bg-[#f5f5f7] rounded-lg px-4 py-3">
              <span className="flex-1 text-[14px] text-[#1d1d1f] truncate font-mono">
                {customerUrl}
              </span>
              <button
                onClick={() => navigator.clipboard.writeText(customerUrl)}
                className="shrink-0 rounded-lg bg-white px-3 py-1.5 text-[13px] font-medium text-[#1d1d1f] border border-[#d2d2d7] hover:bg-[#f5f5f7] transition-all active:scale-95"
              >
                Copy
              </button>
            </div>

            {importWarnings.length > 0 && (
              <details className="mt-5 rounded-xl bg-[#fffbeb] border border-[#fde68a] p-4">
                <summary className="text-[13px] text-[#92400e] cursor-pointer font-medium">
                  {importWarnings.length} warning
                  {importWarnings.length !== 1 ? "s" : ""}
                </summary>
                <ul className="mt-2 space-y-1">
                  {importWarnings.map((w, i) => (
                    <li key={i} className="text-[12px] text-[#92400e]">
                      {w}
                    </li>
                  ))}
                </ul>
              </details>
            )}

            <div className="mt-6 flex items-center gap-3">
              <a
                href={customerUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-xl bg-[#1d1d1f] px-5 py-2.5 text-[14px] font-medium text-white hover:bg-[#333] transition-all active:scale-[0.98]"
              >
                Open Guide
              </a>
              <Link
                href={`/admin/projects/${savedProjectId}`}
                className="rounded-xl bg-white px-5 py-2.5 text-[14px] font-medium text-[#1d1d1f] border border-[#d2d2d7] hover:bg-[#f5f5f7] transition-all active:scale-[0.98]"
              >
                Edit Project
              </Link>
              <button
                onClick={reset}
                className="text-[14px] text-[#0071e3] hover:underline"
              >
                Import another
              </button>
            </div>
          </div>
        )}

        <p className="mt-6 text-center text-[12px] text-[#86868b]">
          The Cabinet Shop &mdash; Internal Tool
        </p>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  mono,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  mono?: boolean;
}) {
  return (
    <div>
      <label className="block text-[12px] font-medium text-[#86868b] mb-1">
        {label}
      </label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`w-full rounded-lg border border-[#d2d2d7] bg-white px-3 py-2 text-[14px] text-[#1d1d1f] outline-none transition-all focus:border-[#0071e3] focus:ring-4 focus:ring-[#0071e3]/10 ${
          mono ? "font-mono" : ""
        }`}
      />
    </div>
  );
}

/**
 * One detected cabinet. Parses its CSV on demand so the review screen can show
 * the part and fitting counts the guide will actually be built from, before
 * anything is uploaded.
 */
function CabinetRow({
  code,
  index,
  duplicate,
  csvName,
  modelName,
  modelSize,
  textureCount,
  csvBlob,
  excluded,
  onToggle,
}: {
  code: string;
  index: number;
  duplicate: boolean;
  csvName: string;
  modelName: string;
  modelSize: number;
  textureCount: number;
  csvBlob: Blob;
  excluded: boolean;
  onToggle: () => void;
}) {
  const [summary, setSummary] = useState<{
    parts: number;
    fittings: number;
    groups: string[];
    warnings: string[];
  } | null>(null);

  useEffect(() => {
    let active = true;
    csvBlob.text().then((text) => {
      if (!active) return;
      const { parts, fittings, warnings } = parseCabinetCsv(text);
      const groups = Array.from(
        new Set(parts.map((p) => classifyPart(p).groupKey))
      ).sort();
      setSummary({ parts: parts.length, fittings: fittings.length, groups, warnings });
    });
    return () => {
      active = false;
    };
  }, [csvBlob]);

  return (
    <div
      className={`rounded-xl border p-4 transition-all ${
        excluded ? "border-[#e5e5ea] bg-[#fafafa] opacity-60" : "border-[#e5e5ea]"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-[15px] font-medium text-[#1d1d1f]">
            {code}
            {duplicate && <span className="text-[#86868b] ml-1">({index + 1})</span>}
          </h3>
          <p className="text-[12px] text-[#86868b] mt-0.5">
            {summary
              ? `${summary.parts} parts · ${summary.groups.length} groups · ${summary.fittings} fittings`
              : "Reading parts..."}
            {" · "}
            {(modelSize / 1_000_000).toFixed(1)} MB
            {textureCount > 0 && ` · ${textureCount} texture${textureCount !== 1 ? "s" : ""}`}
          </p>
          <p className="text-[11px] text-[#86868b] font-mono mt-1 truncate">
            {modelName} + {csvName}
          </p>
        </div>
        <button
          onClick={onToggle}
          className="shrink-0 text-[12px] text-[#0071e3] hover:underline"
        >
          {excluded ? "Include" : "Exclude"}
        </button>
      </div>

      {summary?.warnings.map((w, i) => (
        <p key={i} className="mt-2 text-[12px] text-[#92400e]">
          {w}
        </p>
      ))}

      {summary && summary.groups.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {summary.groups.map((g) => (
            <span
              key={g}
              className="inline-block rounded-md bg-[#f5f5f7] px-2 py-0.5 text-[11px] text-[#424245]"
            >
              {g}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

const CARD =
  "bg-white rounded-2xl shadow-[0_0_0_1px_rgba(0,0,0,0.04),0_2px_12px_rgba(0,0,0,0.06)] p-6 mb-6";

/**
 * Choose between per-cabinet exports and splitting the project model. Only
 * shown when the folder has both.
 */
function SourceSwitch({
  mode,
  pairCount,
  projectModels,
  onSwitch,
}: {
  mode: Mode;
  pairCount: number;
  projectModels: string[];
  onSwitch: (mode: Mode) => void;
}) {
  if (pairCount === 0 || projectModels.length === 0) return null;
  const options: { value: Mode; label: string }[] = [
    { value: "pairs", label: `Per-cabinet exports (${pairCount})` },
    { value: "split", label: "Split the project model" },
  ];
  return (
    <div className={CARD}>
      <h2 className="text-[13px] font-semibold text-[#86868b] uppercase tracking-wider mb-3">
        Cabinets From
      </h2>
      <div role="radiogroup" className="inline-flex flex-wrap rounded-xl bg-[#f5f5f7] p-1">
        {options.map((o) => (
          <button
            key={o.value}
            role="radio"
            aria-checked={mode === o.value}
            onClick={() => onSwitch(o.value)}
            className={`rounded-lg px-4 py-2 text-[13px] font-medium transition-all focus-visible:outline-2 focus-visible:outline-[#0071e3] ${
              mode === o.value
                ? "bg-white text-[#1d1d1f] shadow-[0_1px_3px_rgba(0,0,0,0.1)]"
                : "text-[#86868b] hover:text-[#1d1d1f]"
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>
      <p className="mt-3 text-[12px] text-[#86868b]">
        The folder has per-cabinet exports and{" "}
        <span className="font-mono">{projectModels.join(", ")}</span>. Per-cabinet
        exports are usually the more recent.
      </p>
    </div>
  );
}

const KIND_SECTIONS: { kind: SplitCandidate["kind"]; title: string; hint: string }[] = [
  {
    kind: "cabinet",
    title: "Cabinets",
    hint: "Rename each one to what the customer will recognise.",
  },
  {
    kind: "loose",
    title: "Loose Parts",
    hint: "Fillers and sub-assemblies without a full carcass. Left out unless you include them.",
  },
  {
    kind: "accessories",
    title: "Accessories",
    hint: "Pelmets, skirting and other pieces running past a single cabinet. Left out unless you include them.",
  },
];

/** Review of the cabinets split out of the project model(s). */
function SplitReview({
  splitting,
  result,
  multipleModels,
  names,
  included,
  onRename,
  onToggle,
}: {
  splitting: boolean;
  result: ProjectSplitResult | null;
  multipleModels: boolean;
  names: Record<string, string>;
  included: Set<string>;
  onRename: (key: string, name: string) => void;
  onToggle: (key: string) => void;
}) {
  if (splitting || !result) {
    return (
      <div className={CARD}>
        <div className="flex items-center gap-3">
          <div className="w-5 h-5 border-2 border-[#d2d2d7] border-t-[#0071e3] rounded-full animate-spin" />
          <p className="text-[14px] text-[#86868b]">Splitting the project model into cabinets...</p>
        </div>
      </div>
    );
  }

  const cabinets = result.candidates.filter((c) => c.kind === "cabinet");
  const fromList = cabinets.filter((c) => c.fittings.source === "hardware-list").length;
  const fromModel = cabinets.filter(
    (c) => c.fittings.source === "model" && c.fittings.fittings.length > 0
  ).length;
  const none = cabinets.length - fromList - fromModel;

  return (
    <>
      <div className={CARD}>
        <h2 className="text-[13px] font-semibold text-[#86868b] uppercase tracking-wider mb-2">
          Fittings
        </h2>
        <ul className="space-y-1 text-[13px] text-[#424245] leading-relaxed">
          {fromList > 0 && (
            <li>
              <span className="font-medium text-[#1d1d1f]">{fromList}</span> cabinet
              {fromList !== 1 ? "s" : ""}: full list from the PolyBoard hardware list,
              checked against the model.
            </li>
          )}
          {fromModel > 0 && (
            <li>
              <span className="font-medium text-[#1d1d1f]">{fromModel}</span> cabinet
              {fromModel !== 1 ? "s" : ""}: counted from the hardware drawn in the model
              &mdash; cams, back pins, corner screws, shelf pins, hinges, handles and
              anti-tip brackets. Screws, runners, legs and wall brackets aren&rsquo;t
              drawn, so they&rsquo;re not listed.
            </li>
          )}
          {none > 0 && (
            <li>
              <span className="font-medium text-[#1d1d1f]">{none}</span> cabinet
              {none !== 1 ? "s" : ""}: no fittings found.
            </li>
          )}
        </ul>
        {result.warnings.map((w, i) => (
          <p key={i} className="mt-3 text-[13px] text-[#92400e]">
            {w}
          </p>
        ))}
      </div>

      {KIND_SECTIONS.map(({ kind, title, hint }) => {
        const list = result.candidates.filter((c) => c.kind === kind);
        if (list.length === 0 && kind !== "cabinet") return null;
        return (
          <div key={kind} className={CARD}>
            <h2 className="text-[13px] font-semibold text-[#86868b] uppercase tracking-wider">
              {title} ({list.length})
            </h2>
            <p className="mt-1 mb-4 text-[12px] text-[#86868b]">{hint}</p>
            {list.length === 0 ? (
              <p className="text-[14px] text-[#86868b] py-2">
                No cabinets found in the project model.
              </p>
            ) : (
              <div className="space-y-3">
                {list.map((c) => (
                  <SplitRow
                    key={c.key}
                    candidate={c}
                    name={names[c.key] ?? ""}
                    included={included.has(c.key)}
                    showModel={multipleModels}
                    onRename={(n) => onRename(c.key, n)}
                    onToggle={() => onToggle(c.key)}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

/** One split cabinet: include toggle, editable name, size and fittings. */
function SplitRow({
  candidate: c,
  name,
  included,
  showModel,
  onRename,
  onToggle,
}: {
  candidate: SplitCandidate;
  name: string;
  included: boolean;
  showModel: boolean;
  onRename: (name: string) => void;
  onToggle: () => void;
}) {
  const inputId = `name-${c.key}`;
  const { width, height, depth } = c.dims;
  const fittingCount = c.fittings.fittings.length;
  const sourceLabel =
    fittingCount === 0
      ? "no fittings"
      : c.fittings.source === "hardware-list"
        ? "from hardware list"
        : "counted from model";

  return (
    <div
      className={`rounded-xl border p-4 transition-all ${
        included ? "border-[#e5e5ea]" : "border-[#e5e5ea] bg-[#fafafa]"
      }`}
    >
      <div className="flex items-start gap-3">
        <input
          type="checkbox"
          checked={included}
          onChange={onToggle}
          aria-label={`Include ${name || c.suggestedName}`}
          className="mt-8 h-4 w-4 shrink-0 accent-[#0071e3]"
        />
        <div className={`min-w-0 flex-1 ${included ? "" : "opacity-60"}`}>
          <label htmlFor={inputId} className="block text-[12px] font-medium text-[#86868b] mb-1">
            Name
          </label>
          <input
            id={inputId}
            type="text"
            value={name}
            onChange={(e) => onRename(e.target.value)}
            className="w-full rounded-lg border border-[#d2d2d7] bg-white px-3 py-2 text-[14px] text-[#1d1d1f] outline-none transition-all focus:border-[#0071e3] focus:ring-4 focus:ring-[#0071e3]/10"
          />
          <p className="text-[12px] text-[#86868b] mt-1.5">
            {Math.round(width)} W × {Math.round(height)} H × {Math.round(depth)} D mm ·{" "}
            {c.panelCount} panels · {c.hardwareCount} hardware
            {c.textures.length > 0 &&
              ` · ${c.textures.length} texture${c.textures.length !== 1 ? "s" : ""}`}
            {showModel && (
              <>
                {" · "}
                <span className="font-mono">{c.modelPath}</span>
              </>
            )}
          </p>

          {c.groupKeys.length > 0 && (
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {c.groupKeys.map((g) => (
                <span
                  key={g}
                  className="inline-block rounded-md bg-[#f5f5f7] px-2 py-0.5 text-[11px] text-[#424245]"
                >
                  {g}
                </span>
              ))}
            </div>
          )}

          {(fittingCount > 0 || c.fittings.notes.length > 0) && (
            <details className="mt-2.5">
              <summary className="cursor-pointer text-[12px] text-[#0071e3]">
                {fittingCount} fitting{fittingCount !== 1 ? "s" : ""} · {sourceLabel}
              </summary>
              <ul className="mt-2 grid gap-x-6 gap-y-0.5 sm:grid-cols-2">
                {c.fittings.fittings.map((f) => (
                  <li key={f.partId} className="text-[12px] text-[#424245]">
                    {f.label} <span className="text-[#86868b]">×{f.qty}</span>
                    <span className="text-[#86868b]">
                      {" "}
                      · {CATEGORY_LABELS[f.category] ?? f.category}
                    </span>
                  </li>
                ))}
              </ul>
              {c.fittings.notes.map((n, i) => (
                <p key={i} className="mt-1.5 text-[12px] text-[#92400e]">
                  {n}
                </p>
              ))}
            </details>
          )}
        </div>
      </div>
    </div>
  );
}
