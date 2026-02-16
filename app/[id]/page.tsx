import { notFound } from "next/navigation";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import ViewerClient from "./viewer-client";

interface Props {
  params: Promise<{ id: string }>;
}

export default async function ViewerPage({ params }: Props) {
  const { id } = await params;

  const { data, error } = await getSupabaseAdmin()
    .from("model_views")
    .select("*")
    .eq("id", id)
    .single();

  if (error || !data) {
    notFound();
  }

  return (
    <ViewerClient
      modelUrls={data.model_urls as string[]}
      jobNumber={data.job_number}
    />
  );
}
