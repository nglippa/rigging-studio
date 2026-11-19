import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { RigEditor } from "./rig-editor/RigEditor";
import { ProjectHydrationBoundary } from "./studio-ui/ProjectHydrationBoundary";
// The studio stages share one cascade. Every stage route loads the same three sheets in the same order,
// so moving between Parts and Rig never reorders them and restyles the shell.
import "./rig-editor/rig-editor.css";
import "./part-cutter/part-cutter.css";
import "./studio-ui/workstation.css";

export const metadata: Metadata = {
  title: "Rig Editor | Rig Studio",
  description: "The full modular character rig and animation editor.",
};

/**
 * The rig editor lives here with a stage (`/?mode=setup`, `test`, `animate`). Opening the app itself (`/` with no stage)
 * starts where a character starts: describing and generating it.
 */
export default async function Home({ searchParams }: { readonly searchParams?: Promise<Readonly<Record<string, string | string[] | undefined>>> }) {
  const params = (await searchParams) ?? {};
  if (!params.mode) redirect("/create-character");
  return <ProjectHydrationBoundary><RigEditor /></ProjectHydrationBoundary>;
}
