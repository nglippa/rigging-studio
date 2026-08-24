import type { Metadata } from "next";
import { PartCutterWorkspace } from "./PartCutterWorkspace";
import { ProjectHydrationBoundary } from "../studio-ui/ProjectHydrationBoundary";
import "./part-cutter.css";

export const metadata: Metadata = {
  title: "Part Cutter | Rig Studio",
  description: "Cut a complete character sprite into semantic, rig-ready parts.",
};

export default function PartCutterPage() { return <ProjectHydrationBoundary><PartCutterWorkspace /></ProjectHydrationBoundary>; }
