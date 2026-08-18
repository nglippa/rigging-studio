export type EditorItemType = "bone" | "slot" | "attachment" | "skin";

export type EditorSelection = {
  readonly type: EditorItemType;
  readonly id: string;
};

export type BoneAuthoringPatch = {
  readonly x?: number;
  readonly y?: number;
  readonly rotation?: number;
};
