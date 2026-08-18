import { AnimationPlayer } from "../../rigging/animation/AnimationPlayer";
import { RigRuntime } from "../../rigging/runtime/RigRuntime";
import type { AnimationDefinition, RigDefinition } from "../../rigging/schema/types";
import type { RigPose } from "../../rigging/runtime/types";

export class RigEditorPreview {
  readonly runtime: RigRuntime;
  readonly player: AnimationPlayer;
  private active = false;

  constructor(rig: RigDefinition) {
    this.runtime = new RigRuntime(rig);
    this.player = new AnimationPlayer(this.runtime);
  }

  enter(animation: AnimationDefinition): void {
    this.active = true;
    this.player.play(animation);
  }

  update(deltaSeconds: number): void {
    if (this.active) this.player.update(deltaSeconds);
  }

  leave(): RigPose {
    this.active = false;
    this.player.stop();
    return this.runtime.getPose();
  }

  get isActive(): boolean { return this.active; }
}
