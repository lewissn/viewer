import Link from "next/link";

export default function NotFound() {
  return (
    <div className="min-h-screen bg-[#fafafa] flex flex-col items-center justify-center px-6">
      <h1 className="text-[72px] font-bold text-[#d2d2d7] leading-none">
        404
      </h1>
      <p className="mt-4 text-[17px] text-[#1d1d1f] font-medium">
        This viewer link doesn&apos;t exist
      </p>
      <p className="mt-2 text-[14px] text-[#86868b]">
        The link may have been removed or the ID is incorrect.
      </p>
      <Link
        href="/admin"
        className="mt-8 rounded-xl bg-[#0071e3] px-6 py-3 text-[15px] font-medium text-white transition-all hover:bg-[#0077ED] active:scale-[0.98]"
      >
        Go to Admin
      </Link>
    </div>
  );
}
