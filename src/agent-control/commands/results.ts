export type CommandWarning = { readonly code: string; readonly message: string };
export type CommandError = { readonly code: string; readonly message: string; readonly path?: string };
export type CommandResult<T extends object = Record<string, never>> =
  | ({ readonly success: true; readonly warnings: readonly CommandWarning[] } & T)
  | { readonly success: false; readonly warnings: readonly CommandWarning[]; readonly errors: readonly CommandError[] };

export const commandFailure = (code: string, message: string, path?: string): CommandResult => ({
  success: false,
  warnings: [],
  errors: [{ code, message, ...(path ? { path } : {}) }],
});

