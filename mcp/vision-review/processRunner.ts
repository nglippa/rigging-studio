import { execFile } from "node:child_process";

export type ProcessResult = { readonly stdout: string; readonly stderr: string; readonly exitCode: number };
export type ProcessRunner = (command: string, args: readonly string[], options?: { readonly cwd?: string; readonly timeoutMs?: number; readonly env?: NodeJS.ProcessEnv }) => Promise<ProcessResult>;

export const runProcess: ProcessRunner = (command, args, options = {}) => new Promise((resolve, reject) => {
  let timedOut = false;
  const child = execFile(command, [...args], { cwd: options.cwd, maxBuffer: 4 * 1024 * 1024, env: options.env }, (error, stdout, stderr) => {
    clearTimeout(timer);
    if (timedOut) { reject(new Error(`Process timed out: ${command}`)); return; }
    if (error) {
      const failure = error as NodeJS.ErrnoException & { code?: string | number; killed?: boolean; signal?: string };
      const detail = stderr.trim() || failure.message;
      if (failure.killed || /timed out/i.test(failure.message)) reject(new Error(`Process timed out: ${command}`));
      else if (failure.code === "ENOENT") reject(new Error(`Executable not found: ${command}`));
      else reject(new Error(`Process exited nonzero (${String(failure.code ?? "unknown")}): ${detail.slice(0, 2000)}`));
      return;
    }
    resolve({ stdout, stderr, exitCode: 0 });
  });
  child.stdin?.end();
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, options.timeoutMs ?? 10_000);
});

export const authenticatedCliEnvironment = (extra: Partial<NodeJS.ProcessEnv> = {}): NodeJS.ProcessEnv => {
  const environment: NodeJS.ProcessEnv = { NODE_ENV: process.env.NODE_ENV };
  const credentialName = /(?:^|_)(?:api_?key|token|secret|cookie|password|credentials?|authorization)(?:_|$)/i;
  Object.entries(process.env).forEach(([key, value]) => { if (!credentialName.test(key) && value !== undefined) environment[key] = value; });
  Object.entries(extra).forEach(([key, value]) => { if (!credentialName.test(key) && value !== undefined) environment[key] = value; });
  return environment;
};
