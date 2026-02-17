import { notFound } from "next/navigation";
import { ASSEMBLY_GUIDES } from "@/lib/assemblyGuides";
import AssemblyClient from "./assembly-client";

interface PageProps {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({ params }: PageProps) {
  const { slug } = await params;
  const guide = ASSEMBLY_GUIDES[slug];
  if (!guide) return {};

  return {
    title: `${guide.title} — Assembly Guide — The Cabinet Shop`,
    description: `Step-by-step assembly guide for the ${guide.title}`,
  };
}

export default async function AssemblyPage({ params }: PageProps) {
  const { slug } = await params;
  const guide = ASSEMBLY_GUIDES[slug];

  if (!guide) {
    notFound();
  }

  return <AssemblyClient guide={guide} />;
}
