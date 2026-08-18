import type { Metadata } from "next";
import { RigLab } from "./RigLab";
import "./rig-lab.css";

export const metadata: Metadata = {
  title: "Rig Lab · Rig Studio",
  description: "Interactive PixiJS runtime lab for modular 2D skeletal animation.",
};

export default function RigLabPage() {
  return <RigLab />;
}
