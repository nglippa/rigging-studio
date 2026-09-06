import type { Metadata } from "next";
import { RigEditor } from "./rig-editor/RigEditor";
import { ProjectHydrationBoundary } from "./studio-ui/ProjectHydrationBoundary";
import "./rig-editor/rig-editor.css";
import "./studio-ui/workstation.css";

export const metadata: Metadata = {
  title: "Rig Editor | Rig Studio",
  description: "The full modular character rig and animation editor.",
};

export default function Home() {
  return <ProjectHydrationBoundary><RigEditor /></ProjectHydrationBoundary>;
}
