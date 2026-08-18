import type { z } from "zod";

export type ValidationPathSegment = string | number;
export type ValidationIssue = {
  readonly code: string;
  readonly path: readonly ValidationPathSegment[];
  readonly message: string;
  readonly severity?: "error" | "warning";
  readonly objectId?: string;
  readonly mode?: "prepare" | "setup" | "animate";
  readonly suggestedAction?: string;
};
export type ValidationResult<T> =
  | { readonly success: true; readonly data: T }
  | { readonly success: false; readonly issues: readonly ValidationIssue[]; readonly message: string };

export const formatValidationPath = (path: readonly ValidationPathSegment[]): string => path.reduce<string>(
  (result, segment) => typeof segment === "number" ? `${result}[${segment}]` : result ? `${result}.${segment}` : segment,
  "",
) || "definition";

export const failure = (label: string, issues: readonly ValidationIssue[]): Extract<ValidationResult<never>, { success: false }> => ({
  success: false,
  issues,
  message: `${label} validation failed: ${issues.map((issue) => `${formatValidationPath(issue.path)}: ${issue.message}`).join("; ")}`,
});

export const zodIssues = (issues: readonly z.core.$ZodIssue[]): ValidationIssue[] => issues.map((issue) => ({
  code: issue.code,
  path: issue.path.filter((part): part is ValidationPathSegment => typeof part === "string" || typeof part === "number"),
  message: issue.message,
}));
