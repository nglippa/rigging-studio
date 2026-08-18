import type { BoneDefinition, RigDefinition } from "../schema/types";
import type { ValidationIssue } from "./issues";

export function validateBoneHierarchy(rig: RigDefinition): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const indexes = new Map<string, number>();
  rig.bones.forEach((bone, index) => {
    const first = indexes.get(bone.id);
    if (first !== undefined) issues.push({ code: "duplicate_bone_id", path: ["bones", index, "id"], message: `Bone "${bone.id}" duplicates bones[${first}]` });
    else indexes.set(bone.id, index);
  });

  const roots = rig.bones.filter((bone) => bone.parentId === null);
  if (roots.length !== 1) issues.push({ code: "invalid_root_count", path: ["bones"], message: `Expected exactly one root bone; found ${roots.length}` });
  const rootIndex = indexes.get(rig.rootBoneId);
  if (rootIndex === undefined) issues.push({ code: "missing_root_bone", path: ["rootBoneId"], message: `Root bone "${rig.rootBoneId}" does not exist` });
  else if (rig.bones[rootIndex].parentId !== null) issues.push({ code: "root_has_parent", path: ["rootBoneId"], message: `Root bone "${rig.rootBoneId}" must have parentId null` });

  rig.bones.forEach((bone, index) => {
    if (bone.parentId !== null && !indexes.has(bone.parentId)) issues.push({
      code: "missing_parent", path: ["bones", index, "parentId"], message: `Parent bone "${bone.parentId}" does not exist`,
    });
  });

  const bones = new Map<string, BoneDefinition>();
  rig.bones.forEach((bone) => { if (!bones.has(bone.id)) bones.set(bone.id, bone); });
  const state = new Map<string, "visiting" | "visited">();
  const stack: string[] = [];
  const reported = new Set<string>();
  const visit = (boneId: string): void => {
    if (state.get(boneId) === "visited") return;
    if (state.get(boneId) === "visiting") {
      const start = Math.max(0, stack.indexOf(boneId));
      const cycle = [...stack.slice(start), boneId];
      const key = [...new Set(cycle)].sort().join("|");
      if (!reported.has(key)) {
        reported.add(key);
        issues.push({ code: "bone_cycle", path: ["bones"], message: `Bone cycle detected: ${cycle.join(" -> ")}` });
      }
      return;
    }
    state.set(boneId, "visiting");
    stack.push(boneId);
    const parentId = bones.get(boneId)?.parentId;
    if (parentId && bones.has(parentId)) visit(parentId);
    stack.pop();
    state.set(boneId, "visited");
  };
  bones.forEach((_bone, boneId) => visit(boneId));
  return issues;
}
