"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";

interface ProjectSummary {
  id: string;
  project_id: string;
  project_name: string;
  customer_name: string | null;
  cabinets: { cabinetId: string }[];
  created_at: string;
  updated_at: string;
}

export default function AdminProjectsPage() {
  // Create form
  const [projectId, setProjectId] = useState("");
  const [projectName, setProjectName] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState<string | null>(null);

  // Project list
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState("");
  const [listLoading, setListLoading] = useState(true);

  const fetchProjects = useCallback(async (q: string) => {
    setListLoading(true);
    try {
      const res = await fetch(
        `/api/projects/list?q=${encodeURIComponent(q)}&limit=50`
      );
      if (res.ok) {
        const data = await res.json();
        setProjects(data.projects);
        setTotal(data.total);
      }
    } catch {
      // silently fail
    } finally {
      setListLoading(false);
    }
  }, []);

  // Initial load
  useEffect(() => {
    fetchProjects("");
  }, [fetchProjects]);

  // Debounced search
  useEffect(() => {
    const timer = setTimeout(() => {
      fetchProjects(search);
    }, 300);
    return () => clearTimeout(timer);
  }, [search, fetchProjects]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    setCreated(null);

    try {
      const res = await fetch("/api/projects/upsert", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: projectId.trim(),
          projectName: projectName.trim(),
          customerName: customerName.trim() || undefined,
          cabinets: [],
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Something went wrong.");
        return;
      }

      setCreated(data.project.project_id);
      // Refresh the list
      fetchProjects(search);
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  function formatDate(iso: string) {
    return new Date(iso).toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  }

  return (
    <div className="min-h-screen bg-[#fafafa] px-4 py-12 sm:px-6">
      <div className="w-full max-w-2xl mx-auto">
        {/* Header */}
        <div className="text-center mb-10">
          <h1 className="text-[28px] font-semibold tracking-tight text-[#1d1d1f]">
            Assembly Guides
          </h1>
          <p className="mt-2 text-[15px] text-[#86868b]">
            Create and manage customer assembly guide projects
          </p>
        </div>

        {/* Navigation */}
        <div className="flex items-center gap-3 mb-6">
          <Link
            href="/admin"
            className="text-[13px] text-[#0071e3] hover:underline"
          >
            &larr; Back to Admin
          </Link>
        </div>

        {/* Import folder — the fast path for a normal order */}
        <Link
          href="/admin/projects/import"
          className="mb-6 block bg-white rounded-2xl shadow-[0_0_0_1px_rgba(0,0,0,0.04),0_2px_12px_rgba(0,0,0,0.06)] p-6 transition-all hover:shadow-[0_0_0_1px_rgba(0,0,0,0.04),0_4px_20px_rgba(0,0,0,0.1)] active:scale-[0.99]"
        >
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-[17px] font-semibold text-[#1d1d1f]">
                Import Order Folder
              </h2>
              <p className="mt-1 text-[14px] text-[#86868b]">
                Drop in the customer folder or a zip — cabinets, parts, fittings
                and textures are sorted out automatically
              </p>
            </div>
            <span className="text-[20px] text-[#86868b] ml-4 shrink-0">&rarr;</span>
          </div>
        </Link>

        {/* Create project card */}
        <details className="bg-white rounded-2xl shadow-[0_0_0_1px_rgba(0,0,0,0.04),0_2px_12px_rgba(0,0,0,0.06)] p-8 mb-8">
          <summary className="text-[17px] font-semibold text-[#1d1d1f] mb-6 cursor-pointer">
            Create Project Manually
          </summary>

          <form onSubmit={handleCreate} className="space-y-5">
            <div>
              <label
                htmlFor="projectId"
                className="block text-[13px] font-medium text-[#1d1d1f] mb-2"
              >
                Project / Order ID
              </label>
              <input
                id="projectId"
                type="text"
                required
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
                placeholder="e.g. ORD-10452"
                className="w-full rounded-xl border border-[#d2d2d7] bg-white px-4 py-3 text-[15px] text-[#1d1d1f] placeholder-[#86868b] outline-none transition-all focus:border-[#0071e3] focus:ring-4 focus:ring-[#0071e3]/10"
              />
            </div>

            <div>
              <label
                htmlFor="projectName"
                className="block text-[13px] font-medium text-[#1d1d1f] mb-2"
              >
                Project Name
              </label>
              <input
                id="projectName"
                type="text"
                required
                value={projectName}
                onChange={(e) => setProjectName(e.target.value)}
                placeholder="e.g. Smith Kitchen"
                className="w-full rounded-xl border border-[#d2d2d7] bg-white px-4 py-3 text-[15px] text-[#1d1d1f] placeholder-[#86868b] outline-none transition-all focus:border-[#0071e3] focus:ring-4 focus:ring-[#0071e3]/10"
              />
            </div>

            <div>
              <label
                htmlFor="customerName"
                className="block text-[13px] font-medium text-[#1d1d1f] mb-2"
              >
                Customer Name{" "}
                <span className="text-[#86868b] font-normal">(optional)</span>
              </label>
              <input
                id="customerName"
                type="text"
                value={customerName}
                onChange={(e) => setCustomerName(e.target.value)}
                placeholder="e.g. John Smith"
                className="w-full rounded-xl border border-[#d2d2d7] bg-white px-4 py-3 text-[15px] text-[#1d1d1f] placeholder-[#86868b] outline-none transition-all focus:border-[#0071e3] focus:ring-4 focus:ring-[#0071e3]/10"
              />
            </div>

            {error && (
              <div className="rounded-xl bg-[#fff5f5] border border-[#fecaca] px-4 py-3 text-[14px] text-[#dc2626]">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-xl bg-[#0071e3] px-6 py-3.5 text-[15px] font-medium text-white transition-all hover:bg-[#0077ED] active:scale-[0.98] disabled:opacity-50"
            >
              {loading ? "Creating..." : "Create Project"}
            </button>
          </form>

          {created && (
            <div className="mt-6 pt-6 border-t border-[#f0f0f0]">
              <div className="rounded-xl bg-[#f0fdf4] border border-[#bbf7d0] px-4 py-3">
                <p className="text-[14px] text-[#166534] mb-2">
                  Project created successfully!
                </p>
                <Link
                  href={`/admin/projects/${created}`}
                  className="text-[14px] text-[#0071e3] hover:underline font-medium"
                >
                  Open project editor &rarr;
                </Link>
              </div>
            </div>
          )}
        </details>

        {/* Existing Projects */}
        <div className="bg-white rounded-2xl shadow-[0_0_0_1px_rgba(0,0,0,0.04),0_2px_12px_rgba(0,0,0,0.06)] p-8">
          <div className="flex items-center justify-between mb-5">
            <h2 className="text-[17px] font-semibold text-[#1d1d1f]">
              Existing Projects
            </h2>
            <span className="text-[13px] text-[#86868b]">
              {total} project{total !== 1 ? "s" : ""}
            </span>
          </div>

          {/* Search */}
          <div className="mb-5">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by project ID, name, or customer..."
              className="w-full rounded-xl border border-[#d2d2d7] bg-[#f5f5f7] px-4 py-3 text-[14px] text-[#1d1d1f] placeholder-[#86868b] outline-none transition-all focus:border-[#0071e3] focus:ring-4 focus:ring-[#0071e3]/10 focus:bg-white"
            />
          </div>

          {/* List */}
          {listLoading && projects.length === 0 ? (
            <div className="flex justify-center py-8">
              <div className="w-6 h-6 border-2 border-[#d2d2d7] border-t-[#0071e3] rounded-full animate-spin" />
            </div>
          ) : projects.length === 0 ? (
            <p className="text-[14px] text-[#86868b] text-center py-8">
              {search
                ? "No projects match your search."
                : "No projects yet. Create one above to get started."}
            </p>
          ) : (
            <div className="space-y-2">
              {projects.map((p) => (
                <Link
                  key={p.id}
                  href={`/admin/projects/${p.project_id}`}
                  className="block rounded-xl border border-[#e5e5ea] p-4 transition-all hover:border-[#0071e3]/30 hover:bg-[#f5f5f7]/50 active:scale-[0.995]"
                >
                  <div className="flex items-center justify-between">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <h3 className="text-[15px] font-medium text-[#1d1d1f] truncate">
                          {p.project_name}
                        </h3>
                        <span className="shrink-0 rounded-md bg-[#f5f5f7] px-2 py-0.5 text-[11px] text-[#86868b] font-mono">
                          {p.project_id}
                        </span>
                      </div>
                      <div className="flex items-center gap-3 mt-1">
                        {p.customer_name && (
                          <span className="text-[13px] text-[#86868b]">
                            {p.customer_name}
                          </span>
                        )}
                        <span className="text-[12px] text-[#86868b]">
                          {p.cabinets?.length ?? 0} cabinet
                          {(p.cabinets?.length ?? 0) !== 1 ? "s" : ""}
                        </span>
                        <span className="text-[12px] text-[#86868b]">
                          Updated {formatDate(p.updated_at)}
                        </span>
                      </div>
                    </div>
                    <span className="shrink-0 text-[16px] text-[#86868b] ml-3">
                      &rarr;
                    </span>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>

        <p className="mt-6 text-center text-[12px] text-[#86868b]">
          The Cabinet Shop &mdash; Internal Tool
        </p>
      </div>
    </div>
  );
}
