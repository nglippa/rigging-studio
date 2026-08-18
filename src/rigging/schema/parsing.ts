import type { z } from "zod";
import { validateAnimationDefinition } from "../validation/animation";
import { failure, zodIssues, type ValidationIssue, type ValidationResult } from "../validation/issues";
import { validateRigDefinition } from "../validation/rig";
import { animationDefinitionSchema, rigDefinitionSchema } from "./schemas";
import type { AnimationDefinition, RigDefinition } from "./types";

const json = (source: string, label: string): ValidationResult<unknown> => {
  try { return { success: true, data: JSON.parse(source) as unknown }; }
  catch (error: unknown) {
    const issues: ValidationIssue[] = [{ code: "invalid_json", path: [], message: error instanceof Error ? error.message : "Invalid JSON" }];
    return failure(label, issues);
  }
};

const schemaParse = <T>(input: unknown, schema: z.ZodType<T>, label: string): ValidationResult<T> => {
  const result = schema.safeParse(input);
  return result.success ? { success: true, data: result.data } : failure(label, zodIssues(result.error.issues));
};

export const safeParseRigDefinition = (input: unknown): ValidationResult<RigDefinition> => {
  const result = schemaParse(input, rigDefinitionSchema, "Rig");
  if (!result.success) return result;
  const issues = validateRigDefinition(result.data);
  return issues.length ? failure("Rig", issues) : result;
};
export const safeParseRigJson = (source: string): ValidationResult<RigDefinition> => {
  const result = json(source, "Rig JSON");
  return result.success ? safeParseRigDefinition(result.data) : result;
};
export const safeParseAnimationDefinition = (input: unknown, rig?: RigDefinition): ValidationResult<AnimationDefinition> => {
  const result = schemaParse(input, animationDefinitionSchema, "Animation");
  if (!result.success) return result;
  const issues = validateAnimationDefinition(result.data, rig);
  return issues.length ? failure("Animation", issues) : result;
};
export const safeParseAnimationJson = (source: string, rig?: RigDefinition): ValidationResult<AnimationDefinition> => {
  const result = json(source, "Animation JSON");
  return result.success ? safeParseAnimationDefinition(result.data, rig) : result;
};
