import type { Metadata } from "next";
import { GamePilot } from "./GamePilot";
import "./game-pilot.css";

export const metadata: Metadata = { title: "Character Runtime · Rig Studio", description: "Full game-facing runtime inspector for legacy and modular character visuals." };
export default function GamePilotPage() { return <GamePilot />; }
