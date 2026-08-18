import type { Container } from "pixi.js";

export const CHARACTER_VISUAL_BACKENDS = ["legacySprite", "modularRig"] as const;
export type CharacterVisualBackendKind = (typeof CHARACTER_VISUAL_BACKENDS)[number];
export const CHARACTER_FACINGS = ["left", "right"] as const;
export type CharacterFacing = (typeof CHARACTER_FACINGS)[number];
export const EQUIPMENT_SLOTS = ["head", "face", "hair", "torso", "legs", "feet", "shoulders", "back", "mainHand", "offHand", "accessory", "cape", "tail"] as const;
export type EquipmentSlot = (typeof EQUIPMENT_SLOTS)[number];

export type CharacterBounds = { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
export type AnimationCompleteEvent = { readonly action: string; readonly clipId: string };
export type AnimationCompleteListener = (event: AnimationCompleteEvent) => void;

export type EquipmentAttachmentTransform = {
  readonly offsetX?: number;
  readonly offsetY?: number;
  readonly rotation?: number;
  readonly scaleX?: number;
  readonly scaleY?: number;
  readonly pivotX?: number;
  readonly pivotY?: number;
  readonly tint?: number;
};

export type EquipmentItemDefinition = {
  readonly id: string;
  readonly slot: EquipmentSlot;
  readonly attachmentId: string | null;
  readonly transform: EquipmentAttachmentTransform;
  readonly animationOverrides: Readonly<Record<string, EquipmentAttachmentTransform>>;
};

export type CharacterAnimationAsset = {
  readonly id: string;
  readonly path?: string;
  readonly legacyFramePaths: readonly string[];
  readonly legacyFps: number;
  readonly loop?: boolean;
  readonly fallbackClipId?: string;
};

export type CharacterAppearanceDefinition = {
  readonly schemaVersion: 1;
  readonly characterId: string;
  readonly visualBackend: CharacterVisualBackendKind;
  readonly rigId: string | null;
  readonly rigPath?: string;
  readonly skinId: string | null;
  readonly equipmentSlots: Readonly<Partial<Record<EquipmentSlot, string | null>>>;
  readonly equipmentRigSlots: Readonly<Partial<Record<EquipmentSlot, string>>>;
  readonly equipmentCatalog: Readonly<Record<string, EquipmentItemDefinition>>;
  readonly palette: { readonly baseTint: number; readonly namedTints: Readonly<Record<string, number>> };
  readonly animationMapping: Readonly<Record<string, string>>;
  readonly animations: Readonly<Record<string, CharacterAnimationAsset>>;
  readonly fallbackAnimation: string;
  readonly directionalBehavior: { readonly strategy: "horizontalFlip"; readonly authoredFacing: CharacterFacing };
  readonly scale: number;
  readonly worldOffset: { readonly x: number; readonly y: number };
  readonly snapToPixels: boolean;
  readonly shadow: { readonly enabled: boolean; readonly offsetX: number; readonly offsetY: number; readonly radiusX: number; readonly radiusY: number; readonly alpha: number; readonly color: number };
  readonly expressionSlotId?: string;
  readonly expressionMapping: Readonly<Record<string, string | null>>;
  readonly legacy: { readonly imagePath: string; readonly width: number; readonly height: number; readonly anchorX: number; readonly anchorY: number };
};

export type CharacterAppearanceSave = {
  readonly saveVersion: 1;
  readonly characterId: string;
  readonly skinId: string | null;
  readonly equipment: Readonly<Partial<Record<EquipmentSlot, string | null>>>;
  readonly tint: number;
  readonly expression: string | null;
};

export interface CharacterVisualBackend {
  readonly kind: CharacterVisualBackendKind | "placeholder";
  readonly container: Container;
  load(): Promise<void>;
  destroy(): void;
  update(deltaSeconds: number): void;
  setPosition(x: number, y: number): void;
  setFacing(facing: CharacterFacing): void;
  playAnimation(action: string, restart?: boolean): void;
  stopAnimation(): void;
  setPlaybackSpeed(speed: number): void;
  setVisible(visible: boolean): void;
  setTint(tint: number): void;
  setEquipment(slot: EquipmentSlot, itemId: string | null): void;
  setSkin(skinId: string | null): void;
  setExpression(expression: string | null): void;
  setLayer(layer: number): void;
  getBounds(): CharacterBounds;
  onAnimationComplete(listener: AnimationCompleteListener): () => void;
  setDebugDisplay(showBones: boolean, showBounds: boolean): void;
  getLoadedAssets(): readonly string[];
}

export type CharacterVisualWarning = { readonly characterId: string; readonly backend: CharacterVisualBackendKind | "placeholder"; readonly message: string };
