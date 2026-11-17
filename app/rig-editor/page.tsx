import type { Metadata } from "next";
import { RigEditor } from "./RigEditor";
import { ProjectHydrationBoundary } from "../studio-ui/ProjectHydrationBoundary";
// The studio stages share one cascade. Every stage route loads the same three sheets in the same order,
// so moving between Parts and Rig never reorders them and restyles the shell.
import "./rig-editor.css";
import "../part-cutter/part-cutter.css";
import "../studio-ui/workstation.css";

export const metadata: Metadata = {
  title: "Rig Editor | Rig Studio",
  description: "Visual setup-pose and dope-sheet animation authoring for modular PixiJS rigs.",
};

export default function RigEditorPage() {
  return <ProjectHydrationBoundary><RigEditor /></ProjectHydrationBoundary>;
}
