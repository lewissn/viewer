"use client";

import { useState } from "react";
import Link from "next/link";

export default function AdminProjectsPage() {
  const [projectId, setProjectId] = useState("");
  const [projectName, setProjectName] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState<string | null>(null);

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
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-[#fafafa] flex items-center justify-center px-4 py-12 sm:px-6">
      <div className="w-full max-w-xl">
        {/* Header */}
        <div className="text-center mb-10">
          <h1 className="text-[28px] font-semibold tracking-tight text-[#1d1d1f]">
            Assembly Guide Projects
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

        {/* Create project card */}
        <div className="bg-white rounded-2xl shadow-[0_0_0_1px_rgba(0,0,0,0.04),0_2px_12px_rgba(0,0,0,0.06)] p-8">
          <h2 className="text-[17px] font-semibold text-[#1d1d1f] mb-6">
            Create New Project
          </h2>

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
        </div>

        <p className="mt-6 text-center text-[12px] text-[#86868b]">
          The Cabinet Shop &mdash; Internal Tool
        </p>
      </div>
    </div>
  );
}
