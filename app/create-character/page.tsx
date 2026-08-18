import type { Metadata } from "next";
import { CreateCharacterWorkspace } from "./CreateCharacterWorkspace";
import "./create-character.css";

export const metadata: Metadata = {
  title: "Create Character | Rig Studio",
  description: "Generate, prepare, rig, validate, and open a modular 2D character.",
};

export default function CreateCharacterPage() { return <CreateCharacterWorkspace />; }
