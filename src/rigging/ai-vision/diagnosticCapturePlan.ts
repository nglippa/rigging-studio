import type { AnimationDefinition } from "../schema/types";

export type DiagnosticOverlaySettings = {
  readonly bones: boolean;
  readonly boneNames: boolean;
  readonly jointPoints: boolean;
  readonly slotBounds: boolean;
  readonly groundLine: boolean;
  readonly rootTrajectory: boolean;
  readonly footTrajectories: boolean;
  readonly motionArcs: boolean;
};

export type DiagnosticCaptureOptions = {
  readonly frameCount?: number;
  readonly includeIndividualFrames?: boolean;
  readonly frameWidth?: number;
  readonly frameHeight?: number;
  readonly maxContactSheetWidth?: number;
  readonly backgroundColor?: string;
  readonly overlays?: Partial<DiagnosticOverlaySettings>;
  readonly locomotion?: boolean;
};

export type DiagnosticCapturePlan = {
  readonly frameCount: number;
  readonly times: readonly number[];
  readonly frameWidth: number;
  readonly frameHeight: number;
  readonly columns: number;
  readonly rows: number;
  readonly contactSheetWidth: number;
  readonly contactSheetHeight: number;
  readonly labelHeight: number;
  readonly includeIndividualFrames: boolean;
  readonly backgroundColor: string;
  readonly overlays: DiagnosticOverlaySettings;
};

const DEFAULT_OVERLAYS: DiagnosticOverlaySettings = {
  bones: true,
  boneNames: false,
  jointPoints: true,
  slotBounds: false,
  groundLine: true,
  rootTrajectory: true,
  footTrajectories: true,
  motionArcs: false,
};

const likelyLocomotion = (animation: AnimationDefinition): boolean => animation.loop && (
  /walk|run|locomotion|stride|jog/i.test(`${animation.id} ${animation.name}`)
  || animation.tracks.filter((track) => /leg|foot/i.test(track.boneId)).length >= 2
);

export const createDiagnosticCapturePlan = (animation: AnimationDefinition, options: DiagnosticCaptureOptions = {}): DiagnosticCapturePlan => {
  const locomotion = options.locomotion ?? likelyLocomotion(animation);
  const frameCount = Math.max(2, Math.min(24, Math.round(options.frameCount ?? (locomotion ? 12 : 8))));
  const frameWidth = Math.max(160, Math.min(640, Math.round(options.frameWidth ?? 420)));
  const frameHeight = Math.max(120, Math.min(640, Math.round(options.frameHeight ?? Math.round(frameWidth * .82))));
  const maxWidth = Math.max(frameWidth, Math.min(2400, Math.round(options.maxContactSheetWidth ?? 1600)));
  const columns = Math.max(1, Math.min(frameCount, Math.floor(maxWidth / frameWidth)));
  const rows = Math.ceil(frameCount / columns);
  const labelHeight = 22;
  const times = Array.from({ length: frameCount }, (_, index) => animation.loop
    ? animation.duration * index / frameCount
    : animation.duration * index / Math.max(1, frameCount - 1));
  return {
    frameCount,
    times,
    frameWidth,
    frameHeight,
    columns,
    rows,
    contactSheetWidth: columns * frameWidth,
    contactSheetHeight: rows * (frameHeight + labelHeight),
    labelHeight,
    includeIndividualFrames: options.includeIndividualFrames ?? false,
    backgroundColor: options.backgroundColor ?? "#101619",
    overlays: { ...DEFAULT_OVERLAYS, ...options.overlays },
  };
};
