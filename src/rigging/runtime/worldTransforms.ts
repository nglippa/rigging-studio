import { matrixFromTransform, transformPoint } from "../math/matrix";
import type { RigDefinition } from "../schema/types";
import type { RigPose, WorldBoneTransform, WorldTransforms } from "./types";

export function computeWorldTransforms(rig: RigDefinition, pose: RigPose): WorldTransforms {
  const definitions = new Map(rig.bones.map((bone) => [bone.id, bone]));
  const world: Record<string, WorldBoneTransform> = {};
  const resolving = new Set<string>();
  const resolve = (boneId: string): WorldBoneTransform => {
    if (world[boneId]) return world[boneId];
    if (resolving.has(boneId)) throw new Error(`Cannot compute cyclic bone hierarchy at "${boneId}"`);
    const definition = definitions.get(boneId);
    const local = pose.bones[boneId];
    if (!definition || !local) throw new Error(`Missing runtime bone "${boneId}"`);
    resolving.add(boneId);
    let result: WorldBoneTransform;
    if (definition.parentId === null) {
      result = { ...local, matrix: matrixFromTransform(local) };
    } else {
      const parent = resolve(definition.parentId);
      const position = transformPoint(parent.matrix, { x: local.x, y: local.y });
      const transform = {
        x: position.x,
        y: position.y,
        rotation: local.rotation + (definition.inheritRotation ? parent.rotation : 0),
        scaleX: local.scaleX * (definition.inheritScale ? parent.scaleX : 1),
        scaleY: local.scaleY * (definition.inheritScale ? parent.scaleY : 1),
      };
      result = { ...transform, matrix: matrixFromTransform(transform) };
    }
    resolving.delete(boneId);
    world[boneId] = result;
    return result;
  };
  rig.bones.forEach((bone) => resolve(bone.id));
  return world;
}
