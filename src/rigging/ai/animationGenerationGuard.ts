export type AnimationGenerationToken = { readonly sequence: number; readonly sourceFingerprint: string };

/** Keeps asynchronous provider results isolated from newer animation/project state. */
export class AnimationGenerationGuard {
  private sequence = 0;
  private sourceFingerprint = "";

  setSource(sourceFingerprint: string): void {
    if (sourceFingerprint === this.sourceFingerprint) return;
    this.sourceFingerprint = sourceFingerprint;
    this.sequence += 1;
  }

  begin(sourceFingerprint: string): AnimationGenerationToken {
    this.setSource(sourceFingerprint);
    this.sequence += 1;
    return { sequence: this.sequence, sourceFingerprint };
  }

  isCurrent(token: AnimationGenerationToken, sourceFingerprint: string): boolean {
    return token.sequence === this.sequence && token.sourceFingerprint === sourceFingerprint && sourceFingerprint === this.sourceFingerprint;
  }

  invalidate(): void { this.sequence += 1; }
}
