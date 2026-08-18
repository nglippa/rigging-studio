import type { Metadata } from "next";
import { RigEditor } from "./RigEditor";
import "./rig-editor.css";

export const metadata: Metadata = {
  title: "Rig Editor | Rig Studio",
  description: "Visual setup-pose and dope-sheet animation authoring for modular PixiJS rigs.",
};

export default function RigEditorPage() {
  return <RigEditor />;
}
