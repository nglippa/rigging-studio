export type SnapshotCommand<T> = { readonly label: string; readonly before: T; readonly after: T };
export class SnapshotCommandHistory<T> {
  private undoStack: SnapshotCommand<T>[] = []; private redoStack: SnapshotCommand<T>[] = []; private current: T;
  constructor(initial: T, private readonly clone: (value: T) => T = (value) => structuredClone(value)) { this.current = clone(initial); }
  get present(): T { return this.current; } get canUndo(): boolean { return this.undoStack.length > 0; } get canRedo(): boolean { return this.redoStack.length > 0; }
  getUndoLabel(): string | null { return this.undoStack.at(-1)?.label ?? null; } getRedoLabel(): string | null { return this.redoStack.at(-1)?.label ?? null; }
  reset(value: T): T { this.current = this.clone(value); this.undoStack = []; this.redoStack = []; return this.current; }
  execute(label: string, transform: (value: T) => T): T { const before = this.current; const after = this.clone(transform(before)); if (JSON.stringify(before) === JSON.stringify(after)) return before; this.undoStack.push({ label, before, after }); this.redoStack = []; this.current = after; return after; }
  undo(): T { const command = this.undoStack.pop(); if (!command) return this.current; this.redoStack.push(command); this.current = command.before; return this.current; }
  redo(): T { const command = this.redoStack.pop(); if (!command) return this.current; this.undoStack.push(command); this.current = command.after; return this.current; }
}
