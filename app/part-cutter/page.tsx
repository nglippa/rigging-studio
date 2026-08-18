import type { Metadata } from "next";
import { PartCutterWorkspace } from "./PartCutterWorkspace";
import "./part-cutter.css";

export const metadata: Metadata = {
  title: "Part Cutter | Rig Studio",
  description: "Cut a complete character sprite into semantic, rig-ready parts.",
};

export default function PartCutterPage() { return <PartCutterWorkspace />; }
