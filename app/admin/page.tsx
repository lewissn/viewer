"use client";

import { useState } from "react";
import Link from "next/link";

interface ModelView {
  id: string;
  job_number: string;
  model_urls: string[];
  created_at: string;
  updated_at: string;
}

export default function AdminPage() {
  const [jobNumber, setJobNumber] = useState("");
  const [urlsText, setUrlsText] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{
    modelView: ModelView;
    created: boolean;
  } | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  const baseUrl =
    process.env.NEXT_PUBLIC_BASE_URL ||
    (typeof window !== "undefined" ? window.location.origin : "");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    setResult(null);
    setCopied(false);

    try {
      const res = await fetch("/api/model-view/upsert", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobNumber, urlsText }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Something went wrong.");
        return;
      }

      setResult(data);
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  function getViewerUrl() {
    if (!result) return "";
    return `${baseUrl}/${result.modelView.id}`;
  }

  async function handleCopy() {
    await navigator.clipboard.writeText(getViewerUrl());
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="min-h-screen bg-[#fafafa] flex items-center justify-center px-4 py-12 sm:px-6">
      <div className="w-full max-w-xl">
        {/* Header */}
        <div className="text-center mb-10">
          <h1 className="text-[28px] font-semibold tracking-tight text-[#1d1d1f]">
            Cabinet Viewer
          </h1>
          <p className="mt-2 text-[15px] text-[#86868b]">
            Generate a 3D viewer link for your customer
          </p>
        </div>

        {/* Card */}
        <div className="bg-white rounded-2xl shadow-[0_0_0_1px_rgba(0,0,0,0.04),0_2px_12px_rgba(0,0,0,0.06)] p-8">
          <form onSubmit={handleSubmit} className="space-y-6">
            {/* Job Number */}
            <div>
              <label
                htmlFor="jobNumber"
                className="block text-[13px] font-medium text-[#1d1d1f] mb-2"
              >
                Job Number
              </label>
              <input
                id="jobNumber"
                type="text"
                required
                value={jobNumber}
                onChange={(e) => setJobNumber(e.target.value)}
                placeholder="e.g. 2395"
                className="w-full rounded-xl border border-[#d2d2d7] bg-white px-4 py-3 text-[15px] text-[#1d1d1f] placeholder-[#86868b] outline-none transition-all focus:border-[#0071e3] focus:ring-4 focus:ring-[#0071e3]/10"
              />
            </div>

            {/* URLs */}
            <div>
              <label
                htmlFor="urls"
                className="block text-[13px] font-medium text-[#1d1d1f] mb-2"
              >
                Dropbox File URLs
              </label>
              <textarea
                id="urls"
                required
                value={urlsText}
                onChange={(e) => setUrlsText(e.target.value)}
                placeholder={"Paste one URL per line\nhttps://www.dropbox.com/..."}
                rows={6}
                className="w-full rounded-xl border border-[#d2d2d7] bg-white px-4 py-3 text-[15px] text-[#1d1d1f] placeholder-[#86868b] outline-none transition-all focus:border-[#0071e3] focus:ring-4 focus:ring-[#0071e3]/10 resize-none font-mono text-[13px]"
              />
              <p className="mt-1.5 text-[12px] text-[#86868b]">
                Include the .3ds model file and all texture/material files
              </p>
            </div>

            {/* Error */}
            {error && (
              <div className="rounded-xl bg-[#fff5f5] border border-[#fecaca] px-4 py-3 text-[14px] text-[#dc2626]">
                {error}
              </div>
            )}

            {/* Submit */}
            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-xl bg-[#0071e3] px-6 py-3.5 text-[15px] font-medium text-white transition-all hover:bg-[#0077ED] active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? (
                <span className="flex items-center justify-center gap-2">
                  <svg
                    className="animate-spin h-4 w-4"
                    viewBox="0 0 24 24"
                    fill="none"
                  >
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="3"
                    />
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                    />
                  </svg>
                  Generating...
                </span>
              ) : (
                "Generate / Update Link"
              )}
            </button>
          </form>

          {/* Result */}
          {result && (
            <div className="mt-8 pt-8 border-t border-[#f0f0f0]">
              <div className="rounded-xl bg-[#f5f5f7] p-5">
                <p className="text-[12px] font-medium text-[#86868b] uppercase tracking-wider mb-3">
                  {result.created ? "New link created" : "Link updated"}
                </p>

                {/* URL display */}
                <div className="flex items-center gap-2 bg-white rounded-lg border border-[#d2d2d7] px-4 py-3">
                  <span className="flex-1 text-[14px] text-[#1d1d1f] truncate font-mono">
                    {getViewerUrl()}
                  </span>
                  <button
                    onClick={handleCopy}
                    className="shrink-0 rounded-lg bg-[#f5f5f7] px-3 py-1.5 text-[13px] font-medium text-[#1d1d1f] transition-all hover:bg-[#e8e8ed] active:scale-95"
                  >
                    {copied ? "Copied!" : "Copy"}
                  </button>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-3 mt-4">
                  <a
                    href={getViewerUrl()}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex-1 text-center rounded-lg bg-[#1d1d1f] px-4 py-2.5 text-[13px] font-medium text-white transition-all hover:bg-[#333] active:scale-[0.98]"
                  >
                    Open Viewer
                  </a>
                </div>

                {/* Timestamp */}
                <p className="mt-4 text-[12px] text-[#86868b]">
                  Last updated:{" "}
                  {new Date(result.modelView.updated_at).toLocaleString()}
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Assembly Guides */}
        <Link
          href="/admin/projects"
          className="mt-6 block bg-white rounded-2xl shadow-[0_0_0_1px_rgba(0,0,0,0.04),0_2px_12px_rgba(0,0,0,0.06)] p-6 transition-all hover:shadow-[0_0_0_1px_rgba(0,0,0,0.04),0_4px_20px_rgba(0,0,0,0.1)] active:scale-[0.99]"
        >
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-[17px] font-semibold text-[#1d1d1f]">
                Assembly Guides
              </h2>
              <p className="mt-1 text-[14px] text-[#86868b]">
                Create and manage customer assembly guide projects
              </p>
            </div>
            <span className="text-[20px] text-[#86868b]">&rarr;</span>
          </div>
        </Link>

        {/* Footer */}
        <p className="mt-6 text-center text-[12px] text-[#86868b]">
          The Cabinet Shop &mdash; Internal Tool
        </p>
      </div>
    </div>
  );
}
