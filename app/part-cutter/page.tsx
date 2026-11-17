import type { Metadata } from "next";
import { PartCutterWorkspace } from "./PartCutterWorkspace";
import { ProjectHydrationBoundary } from "../studio-ui/ProjectHydrationBoundary";
// The studio stages share one cascade. Every stage route loads the same three sheets in the same order,
// so moving between Parts and Rig never reorders them and restyles the shell.
import "../rig-editor/rig-editor.css";
import "./part-cutter.css";
import "../studio-ui/workstation.css";

export const metadata: Metadata = {
  title: "Part Cutter | Rig Studio",
  description: "Cut a complete character sprite into semantic, rig-ready parts.",
};

export default function PartCutterPage() { return <ProjectHydrationBoundary><PartCutterWorkspace /></ProjectHydrationBoundary>; }
