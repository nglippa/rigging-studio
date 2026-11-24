/**
 * The real pieces behind the Studio work queue: Command Center's heavy-model lease, the Studio media service's admission
 * status, and the ComfyUI playground gate that starts and stops the engine on the Mac Studio.
 *
 * Settings (all optional; with no COMFYUI_WAKE_URL the engine is treated as a local one and only queued):
 *   COMFYUI_WAKE_URL      the gate (http://10.77.77.2:8193/): GET starts the engine, POST /stop stops it, GET /status reports.
 *   CC_HEAVY_LEASE        Command Center's lease file. Default: ~/Projects/command-center/basic-qwen-bonsai/.research/heavy-model.lease
 *   CC_HEAVY_LEASE_HOST   SSH host holding that file, when Command Center runs on another Mac (on the Studio: "mini").
 *   CC_MEDIA_STATUS_URL   the media service status. Default: http://10.77.77.2:11436/cc/media/status
 *   CC_STATE_URL          Command Center's operational state, whose queue depth decides when a long job hands the Studio
 *                         over. Default: http://127.0.0.1:8787/api/operational-state/v2 when Command Center is on this Mac.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { StudioWorkQueue, type StudioLease } from "./StudioWorkQueue";

/**
 * Holds the lock in a child process, as Command Center's HeavyLease does (fcntl.flock LOCK_EX | LOCK_NB, pid written into
 * the file). The lock lives exactly as long as that process: when the bridge exits or crashes, the child's stdin closes, it
 * exits and the lock is freed, so a lease can never be left stale.
 */
const HOLDER = [
  "import fcntl, os, sys",
  "p = os.path.expanduser(sys.argv[1])",
  "if not os.path.isdir(os.path.dirname(p)):",
  "    print('ABSENT', flush=True); sys.exit(0)",
  "h = open(p, 'a+')",
  "try:",
  "    fcntl.flock(h, fcntl.LOCK_EX | fcntl.LOCK_NB)",
  "except BlockingIOError:",
  "    print('BUSY', flush=True); sys.exit(0)",
  "h.seek(0); h.truncate(); h.write('%d\\n' % os.getpid()); h.flush()",
  "print('HELD', flush=True)",
  "sys.stdin.read()",
].join("\n");
const HOLDER_ARGS = ["-c", `import base64;exec(base64.b64decode('${Buffer.from(HOLDER).toString("base64")}'))`];

export class CommandCenterLease implements StudioLease {
  private holder: ChildProcessWithoutNullStreams | null = null;
  private absentLogged = false;

  constructor(private readonly file: string, private readonly host: string | null, private readonly log: (message: string) => void = () => undefined) {}

  async tryAcquire(): Promise<boolean> {
    if (this.holder) return true;
    const child = this.host
      ? spawn("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "ServerAliveInterval=15", this.host, "/usr/bin/python3", ...HOLDER_ARGS.map((arg, index) => index ? `"${arg}"` : arg), `"${this.file}"`])
      : spawn("/usr/bin/python3", [...HOLDER_ARGS, this.file]);
    const answer = await new Promise<string>((resolve) => {
      let output = "";
      child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); if (/HELD|BUSY|ABSENT/.test(output)) resolve(output.trim()); });
      child.on("error", (error) => resolve(`ERROR ${error.message}`));
      child.on("exit", () => resolve(output.trim() || "EXITED"));
    });
    if (answer.startsWith("HELD")) { this.holder = child; return true; }
    child.stdin.end();
    if (answer.startsWith("BUSY")) return false;
    // No Command Center here (or the host cannot be reached): there is no lease to respect. Said once, then not again.
    if (!this.absentLogged) { this.log(`Command Center lease unavailable (${answer.slice(0, 120)}); using the Studio status checks only`); this.absentLogged = true; }
    return true;
  }

  async release(): Promise<void> {
    const holder = this.holder; this.holder = null;
    if (!holder) return;
    await new Promise<void>((resolve) => { holder.once("exit", () => resolve()); holder.stdin.end(); setTimeout(() => { holder.kill(); resolve(); }, 5_000); });
  }
}

/** The Studio media service's admission rules (publishing_media.generate): no busy job, no resident Ollama model, no critical pressure. */
export async function studioAdmission(statusUrl: string): Promise<string | null> {
  let status: { busy_job?: unknown; ollama_resident?: unknown; pressure_level?: unknown };
  try {
    const response = await fetch(statusUrl, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) return null;
    status = await response.json() as typeof status;
  } catch { return null; } // the media service may be down; the lease and the gate's own guard still apply
  if (status.busy_job) return "The Studio media service is running a Command Center job; waiting for it to finish";
  if (Array.isArray(status.ollama_resident) && status.ollama_resident.length) return `An Ollama model is loaded on the Studio (${status.ollama_resident.join(", ")}); waiting for it to unload`;
  if (typeof status.pressure_level === "number" && status.pressure_level >= 4) return "The Studio is under critical memory pressure; waiting";
  return null;
}

/** Jobs waiting in Command Center's queue (operational-state v2 `queueDepth`, the total's pending); null when not readable. */
export function commandCenterPending(state: unknown): number | null {
  const depth = (state as { sections?: { queueDepth?: { status?: unknown; items?: unknown } } } | null)?.sections?.queueDepth;
  if (!depth || depth.status === "unavailable" || !Array.isArray(depth.items)) return null;
  const total = depth.items.find((item: { kind?: unknown }) => item?.kind === "total") as { pending?: unknown } | undefined;
  return typeof total?.pending === "number" && Number.isFinite(total.pending) ? total.pending : null;
}

export async function commandCenterDemand(stateUrl: string): Promise<number | null> {
  try {
    const response = await fetch(stateUrl, { signal: AbortSignal.timeout(5_000) });
    return response.ok ? commandCenterPending(await response.json()) : null;
  } catch { return null; } // Command Center down or unreachable: nothing to hand over to
}

type GateStatus = { readonly engine?: string; readonly ready?: boolean; readonly guard_refusal?: string | null };

async function gateStatus(gate: URL): Promise<GateStatus | null> {
  try { const response = await fetch(new URL("status", gate), { signal: AbortSignal.timeout(5_000) }); return response.ok ? await response.json() as GateStatus : null; }
  catch { return null; }
}

/** Starts the engine through the gate and waits until ComfyUI itself answers. */
export async function startEngine(wakeUrl: string, engineReachable: () => Promise<boolean>, timeoutMs = 120_000): Promise<void> {
  if (await engineReachable()) return;
  try { await fetch(wakeUrl, { signal: AbortSignal.timeout(15_000) }); } catch { /* still starting; polling decides */ }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    if (await engineReachable()) return;
    const status = await gateStatus(new URL(wakeUrl));
    if (status?.engine === "stopped" && status.guard_refusal) throw new Error(`The Mac Studio refused to start ComfyUI: ${status.guard_refusal}`);
  }
  const status = await gateStatus(new URL(wakeUrl));
  if (status?.engine === "running") throw new Error("ComfyUI is running on the Mac Studio but this Mac cannot reach it at its local address (127.0.0.1:8188). Start the forward with npm run studio:up");
  throw new Error("ComfyUI on the Mac Studio did not start within two minutes");
}

/** Stops the engine through the gate (POST /stop) and confirms it stopped. */
export async function stopEngine(wakeUrl: string, timeoutMs = 30_000): Promise<void> {
  const gate = new URL(wakeUrl);
  const response = await fetch(new URL("stop", gate), { method: "POST", signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`The gate refused to stop ComfyUI (HTTP ${response.status})`);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = await gateStatus(gate);
    if (status?.engine === "stopped") return;
    if (Date.now() >= deadline) throw new Error("ComfyUI was asked to stop but was still running 30 s later");
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

const DEFAULT_LEASE = path.join(os.homedir(), "Projects", "command-center", "basic-qwen-bonsai", ".research", "heavy-model.lease");

/** The queue for this bridge, configured from the environment. */
export function createStudioQueue(engineReachable: () => Promise<boolean>, log: (message: string) => void = (message) => console.error(message)): StudioWorkQueue {
  const wakeUrl = process.env.COMFYUI_WAKE_URL;
  if (!wakeUrl) return new StudioWorkQueue({ lease: null, admit: async () => null, start: async () => undefined, stop: async () => undefined, log });
  const host = process.env.CC_HEAVY_LEASE_HOST || null;
  const file = process.env.CC_HEAVY_LEASE || (host ? "~/Projects/command-center/basic-qwen-bonsai/.research/heavy-model.lease" : DEFAULT_LEASE);
  const lease = host || existsSync(path.dirname(file)) ? new CommandCenterLease(file, host, log) : null;
  if (!lease) log("Command Center is not on this Mac and CC_HEAVY_LEASE_HOST is unset: Studio jobs use the Studio status checks only");
  const statusUrl = process.env.CC_MEDIA_STATUS_URL ?? "http://10.77.77.2:11436/cc/media/status";
  const stateUrl = process.env.CC_STATE_URL || (host ? null : "http://127.0.0.1:8787/api/operational-state/v2");
  return new StudioWorkQueue({
    lease, log,
    demand: lease && stateUrl ? () => commandCenterDemand(stateUrl) : undefined,
    admit: () => studioAdmission(statusUrl),
    start: () => startEngine(wakeUrl, engineReachable),
    stop: () => stopEngine(wakeUrl),
  });
}
