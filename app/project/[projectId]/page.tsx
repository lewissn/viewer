import { notFound } from "next/navigation";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import type { Project } from "@/lib/projects";
import ProjectClient from "./project-client";

interface PageProps {
  params: Promise<{ projectId: string }>;
}

export async function generateMetadata({ params }: PageProps) {
  const { projectId } = await params;

  const { data } = await getSupabaseAdmin()
    .from("assembly_projects")
    .select("project_name, customer_name")
    .eq("project_id", projectId)
    .single();

  if (!data) return {};

  return {
    title: `${data.project_name} — Assembly Guides — The Cabinet Shop`,
    description: `Assembly guides for ${data.project_name}`,
  };
}

export default async function ProjectPage({ params }: PageProps) {
  const { projectId } = await params;

  const { data, error } = await getSupabaseAdmin()
    .from("assembly_projects")
    .select("*")
    .eq("project_id", projectId)
    .single();

  if (error || !data) {
    notFound();
  }

  const project: Project = {
    id: data.id,
    projectId: data.project_id,
    projectName: data.project_name,
    customerName: data.customer_name,
    cabinets: data.cabinets ?? [],
    createdAt: data.created_at,
    updatedAt: data.updated_at,
  };

  return <ProjectClient project={project} />;
}
