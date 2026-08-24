import type { RigDefinition } from "@/src/rigging/schema/types";

export function selectionChainForBone(rig: RigDefinition, boneId: string): { readonly parentId: string | null; readonly childIds: readonly string[]; readonly relatedIds: ReadonlySet<string> } {
  const parentId = rig.bones.find((bone) => bone.id === boneId)?.parentId ?? null;
  const childIds = rig.bones.filter((bone) => bone.parentId === boneId).map((bone) => bone.id);
  return { parentId, childIds, relatedIds: new Set([boneId, ...(parentId ? [parentId] : []), ...childIds]) };
}
