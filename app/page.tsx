import type { Metadata } from "next";
import { RigEditor } from "./rig-editor/RigEditor";
import "./rig-editor/rig-editor.css";

export const metadata: Metadata = {
  title: "Rig Editor | Rig Studio",
  description: "The full modular character rig and animation editor.",
};

export default function Home() {
  return <RigEditor />;
}
