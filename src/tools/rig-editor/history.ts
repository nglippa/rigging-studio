import type { RigDefinition } from "../../rigging/schema/types";
import { immutableRig, rigsEqual } from "./immutable";

export type RigCommand = {
  readonly label: string;
  readonly before: RigDefinition;
  readonly after: RigDefinition;
};

type Transaction = { readonly label: string; readonly before: RigDefinition };

export class RigCommandHistory {
  private undoStack: RigCommand[] = [];
  private redoStack: RigCommand[] = [];
  private current: RigDefinition;
  private transaction: Transaction | null = null;

  constructor(initialRig: RigDefinition) {
    this.current = immutableRig(initialRig);
  }

  get present(): RigDefinition { return this.current; }
  get canUndo(): boolean { return this.undoStack.length > 0; }
  get canRedo(): boolean { return this.redoStack.length > 0; }
  get undoCount(): number { return this.undoStack.length; }
  get redoCount(): number { return this.redoStack.length; }
  get activeTransaction(): boolean { return this.transaction !== null; }

  reset(rig: RigDefinition): RigDefinition {
    this.current = immutableRig(rig);
    this.undoStack = [];
    this.redoStack = [];
    this.transaction = null;
    return this.current;
  }

  execute(label: string, transform: (rig: RigDefinition) => RigDefinition): RigDefinition {
    if (this.transaction) throw new Error("Cannot execute a command during an active transaction");
    const before = this.current;
    const after = immutableRig(transform(before));
    if (rigsEqual(before, after)) return this.current;
    this.undoStack.push({ label, before, after });
    this.redoStack = [];
    this.current = after;
    return this.current;
  }

  beginTransaction(label: string): void {
    if (this.transaction) throw new Error("A history transaction is already active");
    this.transaction = { label, before: this.current };
  }

  updateTransaction(rig: RigDefinition): RigDefinition {
    if (!this.transaction) throw new Error("No history transaction is active");
    this.current = immutableRig(rig);
    return this.current;
  }

  commitTransaction(): RigDefinition {
    const transaction = this.transaction;
    if (!transaction) throw new Error("No history transaction is active");
    this.transaction = null;
    if (!rigsEqual(transaction.before, this.current)) {
      this.undoStack.push({ label: transaction.label, before: transaction.before, after: this.current });
      this.redoStack = [];
    }
    return this.current;
  }

  cancelTransaction(): RigDefinition {
    if (!this.transaction) return this.current;
    this.current = this.transaction.before;
    this.transaction = null;
    return this.current;
  }

  undo(): RigDefinition {
    if (this.transaction) this.cancelTransaction();
    const command = this.undoStack.pop();
    if (!command) return this.current;
    this.redoStack.push(command);
    this.current = command.before;
    return this.current;
  }

  redo(): RigDefinition {
    if (this.transaction) this.cancelTransaction();
    const command = this.redoStack.pop();
    if (!command) return this.current;
    this.undoStack.push(command);
    this.current = command.after;
    return this.current;
  }

  getUndoLabel(): string | null { return this.undoStack.at(-1)?.label ?? null; }
  getRedoLabel(): string | null { return this.redoStack.at(-1)?.label ?? null; }
}
