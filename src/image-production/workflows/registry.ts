import { readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { IMAGE_PRODUCTION_CAPABILITIES, type ImageProductionCapability } from "../proposals/imageProposal";
import { comfyApiWorkflowSchema, trustedWorkflowManifestSchema, validateWorkflowCompatibility, type LoadedTrustedWorkflow } from "./workflowManifest";

export type TrustedWorkflowCapabilityStatus = {
  readonly capability: ImageProductionCapability;
  readonly capabilityAvailable: boolean;
  readonly workflowId?: string;
  readonly reason?: string;
  readonly requiredModels: readonly string[];
};

export type TrustedWorkflowRegistryOptions = { readonly rootDirectory?: string };

export class TrustedWorkflowRegistry {
  readonly rootDirectory: string;
  private loaded: ReadonlyMap<ImageProductionCapability, LoadedTrustedWorkflow> | null = null;
  private statuses: readonly TrustedWorkflowCapabilityStatus[] | null = null;

  constructor(options: TrustedWorkflowRegistryOptions = {}) {
    this.rootDirectory = path.resolve(options.rootDirectory ?? path.join(process.cwd(), "comfy-workflows"));
  }

  async listCapabilities(force = false): Promise<readonly TrustedWorkflowCapabilityStatus[]> {
    await this.load(force);
    return this.statuses ?? [];
  }

  async require(capability: ImageProductionCapability): Promise<LoadedTrustedWorkflow> {
    await this.load();
    const workflow = this.loaded?.get(capability);
    if (workflow) return workflow;
    const status = this.statuses?.find((candidate) => candidate.capability === capability);
    throw new Error(status?.reason ?? `Trusted workflow capability ${capability} is unavailable`);
  }

  private async load(force = false): Promise<void> {
    if (this.loaded && !force) return;
    const found = new Map<ImageProductionCapability, LoadedTrustedWorkflow>();
    const failures = new Map<ImageProductionCapability, string>();
    let files: readonly string[] = [];
    try { files = (await readdir(this.rootDirectory)).filter((file) => file.endsWith(".manifest.json")); }
    catch { files = []; }
    for (const file of files) {
      try {
        const manifestPath = path.resolve(this.rootDirectory, file);
        const canonicalRoot = await realpath(this.rootDirectory);
        const canonicalManifest = await realpath(manifestPath);
        if (path.dirname(canonicalManifest) !== canonicalRoot) throw new Error("Manifest must be directly inside the trusted workflow directory");
        const manifest = trustedWorkflowManifestSchema.parse(JSON.parse(await readFile(canonicalManifest, "utf8")) as unknown);
        const workflowPath = path.resolve(this.rootDirectory, manifest.workflowFile);
        if (path.dirname(workflowPath) !== this.rootDirectory) throw new Error("Workflow path escaped the trusted workflow directory");
        const canonicalWorkflow = await realpath(workflowPath);
        if (path.dirname(canonicalWorkflow) !== canonicalRoot) throw new Error("Workflow must be directly inside the trusted workflow directory");
        const workflow = comfyApiWorkflowSchema.parse(JSON.parse(await readFile(canonicalWorkflow, "utf8")) as unknown);
        const compatibility = validateWorkflowCompatibility(manifest, workflow);
        if (compatibility.length) throw new Error(compatibility.join("; "));
        if (found.has(manifest.capability)) throw new Error(`Duplicate manifest for ${manifest.capability}`);
        found.set(manifest.capability, { manifest, workflow, manifestPath: canonicalManifest, workflowPath: canonicalWorkflow });
      } catch (error: unknown) {
        const capability = await this.readCapabilityBestEffort(path.resolve(this.rootDirectory, file));
        if (capability) failures.set(capability, error instanceof Error ? error.message : "Workflow manifest failed validation");
      }
    }
    this.loaded = found;
    this.statuses = IMAGE_PRODUCTION_CAPABILITIES.map((capability) => {
      const entry = found.get(capability);
      return entry
        ? { capability, capabilityAvailable: true, workflowId: entry.manifest.id, requiredModels: entry.manifest.requiredModels }
        : { capability, capabilityAvailable: false, reason: failures.get(capability) ?? `No trusted ${capability} workflow manifest and API-format workflow pair was detected`, requiredModels: [] };
    });
  }

  private async readCapabilityBestEffort(filePath: string): Promise<ImageProductionCapability | null> {
    try {
      const input = JSON.parse(await readFile(filePath, "utf8")) as { capability?: unknown };
      return IMAGE_PRODUCTION_CAPABILITIES.includes(input.capability as ImageProductionCapability) ? input.capability as ImageProductionCapability : null;
    } catch { return null; }
  }
}
