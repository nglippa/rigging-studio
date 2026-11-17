import type { Metadata } from "next";
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

export default function Home() {
  return <ProjectHydrationBoundary><RigEditor /></ProjectHydrationBoundary>;
}
