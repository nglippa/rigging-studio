import { evaluateAnimationAtTime } from "./evaluate";
import type { AnimationDefinition } from "../schema/types";
import type { RigPose } from "../runtime/types";
import { RigRuntime } from "../runtime/RigRuntime";

export class AnimationPlayer {
  private animation: AnimationDefinition | null = null;
  private time = 0;
  private speed = 1;
  private playing = false;
  private didComplete = false;
  private loopOverride: boolean | null = null;

  constructor(private readonly runtime: RigRuntime) {}

  play(animation: AnimationDefinition, restart = true): void {
    const changed = this.animation !== animation;
    this.animation = animation;
    if (restart || changed) this.time = 0;
    this.playing = true;
    this.didComplete = false;
    this.applyPose();
  }

  pause(): void {
    this.playing = false;
  }

  stop(): void {
    this.playing = false;
    this.didComplete = false;
    this.time = 0;
    this.runtime.resetToSetupPose();
  }

  restart(): void {
    if (!this.animation) return;
    this.time = 0;
    this.playing = true;
    this.didComplete = false;
    this.applyPose();
  }

  seek(time: number): void {
    if (!this.animation) return;
    this.time = this.normalizeTime(time);
    this.didComplete = !this.shouldLoop() && this.time >= this.animation.duration;
    this.applyPose();
  }

  update(deltaSeconds: number): void {
    if (!this.animation || !this.playing || deltaSeconds <= 0) return;
    const nextTime = this.time + deltaSeconds * this.speed;
    if (!this.shouldLoop() && nextTime >= this.animation.duration) {
      this.time = this.animation.duration;
      this.playing = false;
      this.didComplete = true;
    } else {
      this.time = this.normalizeTime(nextTime);
      this.didComplete = false;
    }
    this.applyPose();
  }

  setPlaybackSpeed(speed: number): void {
    if (!Number.isFinite(speed) || speed <= 0) throw new Error("Playback speed must be a positive finite number");
    this.speed = speed;
  }

  setLooping(loop: boolean | null): void {
    this.loopOverride = loop;
    if (this.animation) this.seek(this.time);
  }

  get currentAnimation(): AnimationDefinition | null { return this.animation; }
  get currentTime(): number { return this.time; }
  get playbackSpeed(): number { return this.speed; }
  get isPlaying(): boolean { return this.playing; }
  get completed(): boolean { return this.didComplete; }
  get duration(): number { return this.animation?.duration ?? 0; }
  get looping(): boolean { return this.shouldLoop(); }

  private shouldLoop(): boolean {
    return this.loopOverride ?? this.animation?.loop ?? false;
  }

  private normalizeTime(time: number): number {
    if (!this.animation) return 0;
    if (!this.shouldLoop()) return Math.min(this.animation.duration, Math.max(0, time));
    return ((time % this.animation.duration) + this.animation.duration) % this.animation.duration;
  }

  private applyPose(): void {
    if (!this.animation) return;
    const setupPose: RigPose = this.runtime.getSetupPose();
    this.runtime.setPose(evaluateAnimationAtTime(this.animation, setupPose, this.time));
  }
}
