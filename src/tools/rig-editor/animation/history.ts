import { animationLibrariesEqual, immutableAnimationLibrary } from "./immutable";
import type { AnimationLibrary } from "./types";

type AnimationCommand = { readonly label: string; readonly before: AnimationLibrary; readonly after: AnimationLibrary };
type Transaction = { readonly label: string; readonly before: AnimationLibrary };

export class AnimationCommandHistory {
  private undoStack: AnimationCommand[] = [];
  private redoStack: AnimationCommand[] = [];
  private current: AnimationLibrary;
  private transaction: Transaction | null = null;

  constructor(initial: AnimationLibrary) { this.current = immutableAnimationLibrary(initial); }

  get present(): AnimationLibrary { return this.current; }
  get canUndo(): boolean { return this.undoStack.length > 0; }
  get canRedo(): boolean { return this.redoStack.length > 0; }
  get undoCount(): number { return this.undoStack.length; }
  get activeTransaction(): boolean { return this.transaction !== null; }
  getUndoLabel(): string | null { return this.undoStack.at(-1)?.label ?? null; }
  getRedoLabel(): string | null { return this.redoStack.at(-1)?.label ?? null; }

  reset(library: AnimationLibrary): AnimationLibrary {
    this.current = immutableAnimationLibrary(library);
    this.undoStack = [];
    this.redoStack = [];
    this.transaction = null;
    return this.current;
  }

  execute(label: string, transform: (library: AnimationLibrary) => AnimationLibrary): AnimationLibrary {
    if (this.transaction) throw new Error("Cannot execute an animation command during an active transaction");
    const before = this.current;
    const after = immutableAnimationLibrary(transform(before));
    if (animationLibrariesEqual(before, after)) return this.current;
    this.undoStack.push({ label, before, after });
    this.redoStack = [];
    this.current = after;
    return this.current;
  }

  beginTransaction(label: string): void {
    if (this.transaction) throw new Error("An animation transaction is already active");
    this.transaction = { label, before: this.current };
  }

  updateTransaction(library: AnimationLibrary): AnimationLibrary {
    if (!this.transaction) throw new Error("No animation transaction is active");
    this.current = immutableAnimationLibrary(library);
    return this.current;
  }

  commitTransaction(): AnimationLibrary {
    const transaction = this.transaction;
    if (!transaction) throw new Error("No animation transaction is active");
    this.transaction = null;
    if (!animationLibrariesEqual(transaction.before, this.current)) {
      this.undoStack.push({ label: transaction.label, before: transaction.before, after: this.current });
      this.redoStack = [];
    }
    return this.current;
  }

  cancelTransaction(): AnimationLibrary {
    if (!this.transaction) return this.current;
    this.current = this.transaction.before;
    this.transaction = null;
    return this.current;
  }

  undo(): AnimationLibrary {
    if (this.transaction) this.cancelTransaction();
    const command = this.undoStack.pop();
    if (!command) return this.current;
    this.redoStack.push(command);
    this.current = command.before;
    return this.current;
  }

  redo(): AnimationLibrary {
    if (this.transaction) this.cancelTransaction();
    const command = this.redoStack.pop();
    if (!command) return this.current;
    this.undoStack.push(command);
    this.current = command.after;
    return this.current;
  }
}
