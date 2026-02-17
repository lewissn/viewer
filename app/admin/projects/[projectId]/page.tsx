"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import type { CabinetInstance } from "@/lib/projects";
import { classifyPart } from "@/lib/classifyPart";

interface ProjectData {
  id: string;
  project_id: string;
  project_name: string;
  customer_name: string | null;
  cabinets: CabinetInstance[];
}

export default function ProjectEditorPage() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;

  const [project, setProject] = useState<ProjectData | null>(null);
  const [loadError, setLoadError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState("");
  const [csvText, setCsvText] = useState("");
  const [parsing, setParsing] = useState(false);
  const [parseWarnings, setParseWarnings] = useState<string[]>([]);

  const baseUrl =
    process.env.NEXT_PUBLIC_BASE_URL ||
    (typeof window !== "undefined" ? window.location.origin : "");

  // Load project
  useEffect(() => {
    async function load() {
      const res = await fetch(`/api/projects/${projectId}`);
      if (!res.ok) {
        setLoadError("Project not found.");
        return;
      }
      const data = await res.json();
      setProject(data.project);
    }
    load();
  }, [projectId]);

  // Parse ERP CSV
  async function handleParseErp() {
    if (!csvText.trim() || !project) return;
    setParsing(true);
    setParseWarnings([]);

    try {
      const res = await fetch("/api/projects/parse-erp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ csvText }),
      });

      const data = await res.json();
      if (!res.ok) {
        setParseWarnings([data.error]);
        return;
      }

      setParseWarnings(data.warnings || []);

      // Merge parsed cabinets with existing ones (preserve model URLs)
      const existing = new Map(
        project.cabinets.map((c) => [c.cabinetId, c])
      );

      const merged: CabinetInstance[] = data.cabinets.map(
        (parsed: CabinetInstance) => {
          const ex = existing.get(parsed.cabinetId);
          return {
            ...parsed,
            modelFileUrl: ex?.modelFileUrl ?? parsed.modelFileUrl,
            guideOverrides: ex?.guideOverrides ?? parsed.guideOverrides,
          };
        }
      );

      setProject({ ...project, cabinets: merged });
    } catch {
      setParseWarnings(["Network error parsing CSV."]);
    } finally {
      setParsing(false);
    }
  }

  // Save project
  async function handleSave() {
    if (!project) return;
    setSaving(true);
    setSaveMsg("");

    try {
      const res = await fetch("/api/projects/upsert", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: project.project_id,
          projectName: project.project_name,
          customerName: project.customer_name,
          cabinets: project.cabinets,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        setSaveMsg(`Error: ${data.error}`);
        return;
      }

      setSaveMsg("Saved successfully.");
      setTimeout(() => setSaveMsg(""), 3000);
    } catch {
      setSaveMsg("Network error. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  // Update a cabinet's model URL
  function updateCabinetModelUrl(cabinetId: string, url: string) {
    if (!project) return;
    setProject({
      ...project,
      cabinets: project.cabinets.map((c) =>
        c.cabinetId === cabinetId ? { ...c, modelFileUrl: url } : c
      ),
    });
  }

  // Remove a cabinet
  function removeCabinet(cabinetId: string) {
    if (!project) return;
    setProject({
      ...project,
      cabinets: project.cabinets.filter((c) => c.cabinetId !== cabinetId),
    });
  }

  if (loadError) {
    return (
      <div className="min-h-screen bg-[#fafafa] flex items-center justify-center">
        <div className="text-center">
          <p className="text-[15px] text-[#dc2626] mb-4">{loadError}</p>
          <Link
            href="/admin/projects"
            className="text-[14px] text-[#0071e3] hover:underline"
          >
            &larr; Back to Projects
          </Link>
        </div>
      </div>
    );
  }

  if (!project) {
    return (
      <div className="min-h-screen bg-[#fafafa] flex items-center justify-center">
        <div className="w-6 h-6 border-2 border-[#d2d2d7] border-t-[#0071e3] rounded-full animate-spin" />
      </div>
    );
  }

  // Detect groups from ERP parts for each cabinet
  function getDetectedGroups(parts: string[]): string[] {
    const groups = new Set<string>();
    for (const name of parts) {
      const { groupKey } = classifyPart(name);
      groups.add(groupKey);
    }
    return Array.from(groups).sort();
  }

  const customerUrl = `${baseUrl}/project/${project.project_id}`;

  return (
    <div className="min-h-screen bg-[#fafafa] px-4 py-8 sm:px-6">
      <div className="max-w-3xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <Link
              href="/admin/projects"
              className="text-[13px] text-[#0071e3] hover:underline mb-1 block"
            >
              &larr; All Projects
            </Link>
            <h1 className="text-[24px] font-semibold text-[#1d1d1f]">
              {project.project_name}
            </h1>
            <p className="text-[14px] text-[#86868b]">
              {project.project_id}
              {project.customer_name && ` — ${project.customer_name}`}
            </p>
          </div>
          <button
            onClick={handleSave}
            disabled={saving}
            className="rounded-xl bg-[#0071e3] px-5 py-2.5 text-[14px] font-medium text-white hover:bg-[#0077ed] transition-all active:scale-[0.98] disabled:opacity-50"
          >
            {saving ? "Saving..." : "Save Project"}
          </button>
        </div>

        {saveMsg && (
          <div
            className={`mb-6 rounded-xl px-4 py-3 text-[14px] ${
              saveMsg.startsWith("Error")
                ? "bg-[#fff5f5] border border-[#fecaca] text-[#dc2626]"
                : "bg-[#f0fdf4] border border-[#bbf7d0] text-[#166534]"
            }`}
          >
            {saveMsg}
          </div>
        )}

        {/* Customer URL */}
        <div className="bg-white rounded-2xl shadow-[0_0_0_1px_rgba(0,0,0,0.04),0_2px_12px_rgba(0,0,0,0.06)] p-6 mb-6">
          <h2 className="text-[13px] font-semibold text-[#86868b] uppercase tracking-wider mb-3">
            Customer Link
          </h2>
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
        </div>

        {/* ERP Upload */}
        <div className="bg-white rounded-2xl shadow-[0_0_0_1px_rgba(0,0,0,0.04),0_2px_12px_rgba(0,0,0,0.06)] p-6 mb-6">
          <h2 className="text-[13px] font-semibold text-[#86868b] uppercase tracking-wider mb-3">
            ERP Data
          </h2>
          <textarea
            value={csvText}
            onChange={(e) => setCsvText(e.target.value)}
            placeholder={
              "Paste CSV data here (projectName, cabinetName, partName)\n\nSmith Kitchen,Low Double Cupboard,Bottom\nSmith Kitchen,Low Double Cupboard,Plinth\n..."
            }
            rows={8}
            className="w-full rounded-xl border border-[#d2d2d7] bg-white px-4 py-3 text-[13px] text-[#1d1d1f] placeholder-[#86868b] outline-none transition-all focus:border-[#0071e3] focus:ring-4 focus:ring-[#0071e3]/10 resize-none font-mono mb-3"
          />
          <button
            onClick={handleParseErp}
            disabled={parsing || !csvText.trim()}
            className="rounded-xl bg-[#1d1d1f] px-5 py-2.5 text-[14px] font-medium text-white hover:bg-[#333] transition-all active:scale-[0.98] disabled:opacity-50"
          >
            {parsing ? "Parsing..." : "Parse ERP CSV"}
          </button>
          {parseWarnings.length > 0 && (
            <div className="mt-3 rounded-xl bg-[#fffbeb] border border-[#fde68a] px-4 py-3">
              {parseWarnings.map((w, i) => (
                <p key={i} className="text-[13px] text-[#92400e]">
                  {w}
                </p>
              ))}
            </div>
          )}
        </div>

        {/* Cabinet Instances */}
        <div className="bg-white rounded-2xl shadow-[0_0_0_1px_rgba(0,0,0,0.04),0_2px_12px_rgba(0,0,0,0.06)] p-6">
          <h2 className="text-[13px] font-semibold text-[#86868b] uppercase tracking-wider mb-4">
            Cabinet Instances ({project.cabinets.length})
          </h2>

          {project.cabinets.length === 0 && (
            <p className="text-[14px] text-[#86868b] py-4">
              No cabinets yet. Upload an ERP CSV to populate.
            </p>
          )}

          <div className="space-y-4">
            {project.cabinets.map((cab) => {
              const groups = getDetectedGroups(cab.erpParts);
              const nameCount = project.cabinets.filter(
                (c) => c.cabinetName === cab.cabinetName
              ).length;

              return (
                <div
                  key={cab.cabinetId}
                  className="rounded-xl border border-[#e5e5ea] p-4"
                >
                  <div className="flex items-start justify-between mb-3">
                    <div>
                      <h3 className="text-[15px] font-medium text-[#1d1d1f]">
                        {cab.cabinetName}
                        {nameCount > 1 && (
                          <span className="text-[#86868b] ml-1">
                            ({cab.cabinetIndex + 1})
                          </span>
                        )}
                      </h3>
                      <p className="text-[12px] text-[#86868b]">
                        {cab.erpParts.length} parts &middot; {groups.length}{" "}
                        groups
                      </p>
                    </div>
                    <button
                      onClick={() => removeCabinet(cab.cabinetId)}
                      className="text-[12px] text-[#dc2626] hover:underline"
                    >
                      Remove
                    </button>
                  </div>

                  {/* Model URL */}
                  <div className="mb-3">
                    <label className="block text-[12px] font-medium text-[#86868b] mb-1">
                      Model File URL (GLB/3DS)
                    </label>
                    <input
                      type="text"
                      value={cab.modelFileUrl ?? ""}
                      onChange={(e) =>
                        updateCabinetModelUrl(cab.cabinetId, e.target.value)
                      }
                      placeholder="https://example.com/model.glb"
                      className="w-full rounded-lg border border-[#d2d2d7] bg-white px-3 py-2 text-[13px] text-[#1d1d1f] placeholder-[#86868b] outline-none transition-all focus:border-[#0071e3] focus:ring-4 focus:ring-[#0071e3]/10 font-mono"
                    />
                  </div>

                  {/* Detected groups */}
                  {groups.length > 0 && (
                    <div>
                      <p className="text-[12px] font-medium text-[#86868b] mb-1.5">
                        Detected Groups
                      </p>
                      <div className="flex flex-wrap gap-1.5">
                        {groups.map((g) => (
                          <span
                            key={g}
                            className="inline-block rounded-md bg-[#f5f5f7] px-2 py-0.5 text-[11px] text-[#424245]"
                          >
                            {g}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Part list (collapsed) */}
                  {cab.erpParts.length > 0 && (
                    <details className="mt-3">
                      <summary className="text-[12px] text-[#0071e3] cursor-pointer hover:underline">
                        Show {cab.erpParts.length} parts
                      </summary>
                      <ul className="mt-2 space-y-0.5">
                        {cab.erpParts.map((part, i) => {
                          const { groupKey } = classifyPart(part);
                          return (
                            <li
                              key={i}
                              className="text-[12px] text-[#424245] flex items-center gap-2"
                            >
                              <span className="font-mono">{part}</span>
                              <span className="text-[#86868b]">
                                &rarr; {groupKey}
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                    </details>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        <p className="mt-6 text-center text-[12px] text-[#86868b]">
          The Cabinet Shop &mdash; Internal Tool
        </p>
      </div>
    </div>
  );
}
