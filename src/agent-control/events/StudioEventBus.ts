export const STUDIO_EVENT_TYPES = [
  "project.created", "project.opened", "project.changed", "generation.started", "generation.completed", "generation.failed",
  "segmentation.completed", "rig.changed", "bone.changed", "slot.changed", "skin.changed", "animation.changed",
  "animation.playback.changed", "preview.rendered", "validation.changed", "warning.added", "project.saved",
] as const;

export type StudioEventType = (typeof STUDIO_EVENT_TYPES)[number];
export type StudioEvent = {
  readonly id: string;
  readonly type: StudioEventType;
  readonly timestamp: string;
  readonly actor: string;
  readonly summary: string;
  readonly entityId?: string;
  readonly details?: Readonly<Record<string, string | number | boolean | null>>;
};

type Listener = (event: StudioEvent) => void;

export class StudioEventBus {
  private listeners = new Set<Listener>();

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: StudioEvent): void {
    this.listeners.forEach((listener) => listener(event));
  }
}

