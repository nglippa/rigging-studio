import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { JsonValue } from "../../src/rigging/schema/types";
import type { ManagedGenerationIngress } from "../../src/agent-control/validation/managedGenerationIngress";

export type GenerationImportSource =
  | { readonly type: "local_path"; readonly path: string }
  | { readonly type: "data_url"; readonly dataUrl: string }
  | { readonly type: "provider_asset"; readonly path: string; readonly assetId?: string };

export type GenerationImportRequest = {
  readonly projectId?: string;
  readonly imageSource: GenerationImportSource;
  readonly generationId: string;
  readonly provider: string;
  readonly prompt: string;
  readonly accepted: boolean;
  readonly generationMode?: "imported_external" | "provider_generated";
  readonly operation?: "CHARACTER_GENERATION" | "CHARACTER_VARIANT" | "OCCLUSION_RECONSTRUCTION" | "PART_REPAIR" | "BACKGROUND_REMOVAL" | "ALPHA_EDGE_CLEANUP" | "EQUIPMENT_VARIANT" | "HAND_REPAIR";
  readonly targetPartId?: string;
  readonly metadata: Readonly<Record<string, JsonValue>>;
};

type ImageInfo = { readonly mimeType: "image/png" | "image/jpeg"; readonly extension: "png" | "jpg"; readonly width: number; readonly height: number };
type StorageOptions = { readonly cwd?: string; readonly approvedRoots?: readonly string[]; readonly now?: () => Date };

const MAX_IMAGE_BYTES = 24 * 1024 * 1024;
const within = (candidate: string, root: string): boolean => {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
};
const safeSegment = (value: string): string => value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "generation";

export function inspectSupportedImage(bytes: Uint8Array): ImageInfo {
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error("Image exceeds the 24 MB ingress limit");
  if (bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const width = view.getUint32(16); const height = view.getUint32(20);
    if (!width || !height) throw new Error("PNG dimensions are invalid");
    return { mimeType: "image/png", extension: "png", width, height };
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    const sof = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
    while (offset + 8 < bytes.length) {
      if (bytes[offset] !== 0xff) { offset += 1; continue; }
      const marker = bytes[offset + 1];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x00 || marker === 0xd8) { offset += 2; continue; }
      const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
      if (length < 2 || offset + length + 2 > bytes.length) break;
      if (sof.has(marker)) {
        const height = (bytes[offset + 5] << 8) | bytes[offset + 6];
        const width = (bytes[offset + 7] << 8) | bytes[offset + 8];
        if (!width || !height) throw new Error("JPEG dimensions are invalid");
        return { mimeType: "image/jpeg", extension: "jpg", width, height };
      }
      offset += length + 2;
    }
    throw new Error("JPEG dimensions could not be read");
  }
  throw new Error("Unsupported image type; only PNG and JPEG are accepted");
}

export class ManagedGenerationStorage {
  readonly directory: string;
  readonly approvedRoots: readonly string[];
  private readonly now: () => Date;

  constructor(options: StorageOptions = {}) {
    const cwd = path.resolve(options.cwd ?? process.cwd());
    this.directory = path.resolve(cwd, ".rigging-studio", "generations");
    this.now = options.now ?? (() => new Date());
    const configured = (process.env.RIGGING_STUDIO_GENERATION_IMPORT_ROOTS ?? "").split(path.delimiter).filter(Boolean);
    this.approvedRoots = (options.approvedRoots ?? [
      path.resolve(cwd, ".rigging-studio", "ingress"),
      path.resolve(cwd, ".rigging-studio", "image-production"),
      path.resolve(cwd, "public", "rig-test"),
      path.resolve(process.env.CODEX_HOME ?? path.join(homedir(), ".codex"), "generated_images"),
      ...configured.map((entry) => path.resolve(entry)),
    ]).map((entry) => path.resolve(entry));
  }

  async ingest(request: GenerationImportRequest, assetBaseUrl: string): Promise<ManagedGenerationIngress> {
    const bytes = request.imageSource.type === "data_url"
      ? this.decodeDataUrl(request.imageSource.dataUrl)
      : await this.readApprovedPath(request.imageSource.path);
    const info = inspectSupportedImage(bytes);
    await mkdir(this.directory, { recursive: true });
    const digest = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
    const stamp = this.now().toISOString().replace(/[:.]/g, "-");
    const fileName = `${stamp}-${safeSegment(request.projectId ?? "unassigned")}-${digest}.${info.extension}`;
    const filePath = path.resolve(this.directory, fileName);
    if (!within(filePath, this.directory)) throw new Error("Managed generation path escaped its fixed directory");
    await writeFile(filePath, bytes, { flag: "wx" }).catch(async (error: unknown) => {
      if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") return;
      throw error;
    });
    const metadataPath = `${filePath}.json`;
    await writeFile(metadataPath, `${JSON.stringify({
      generationId: request.generationId, provider: request.provider, prompt: request.prompt, accepted: request.accepted,
      generationMode: request.generationMode ?? "imported_external", operation: request.operation ?? "CHARACTER_GENERATION", targetPartId: request.targetPartId,
      metadata: request.metadata, width: info.width, height: info.height, mimeType: info.mimeType,
      importedAt: this.now().toISOString(), sourceType: request.imageSource.type,
    }, null, 2)}\n`, { flag: "wx" }).catch(async (error: unknown) => {
      if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") return;
      throw error;
    });
    return {
      projectId: request.projectId, generationId: request.generationId, provider: request.provider, prompt: request.prompt,
      accepted: request.accepted, generationMode: request.generationMode ?? "imported_external", operation: request.operation ?? "CHARACTER_GENERATION", targetPartId: request.targetPartId, metadata: request.metadata,
      managedImage: {
        image: `${assetBaseUrl.replace(/\/$/, "")}/generations/${encodeURIComponent(fileName)}`,
        sourceArtifact: filePath, width: info.width, height: info.height, mimeType: info.mimeType,
      },
      ingressToken: randomBytes(24).toString("hex"),
    };
  }

  assetPath(fileName: string): string | null {
    if (fileName !== path.basename(fileName) || !/^[a-zA-Z0-9._-]+\.(png|jpg)$/.test(fileName)) return null;
    const candidate = path.resolve(this.directory, fileName);
    return within(candidate, this.directory) ? candidate : null;
  }

  private decodeDataUrl(dataUrl: string): Uint8Array {
    const match = /^data:(image\/(?:png|jpeg));base64,([a-zA-Z0-9+/=\s]+)$/.exec(dataUrl);
    if (!match) throw new Error("Image data URL must be a base64 PNG or JPEG");
    const bytes = Buffer.from(match[2], "base64");
    if (!bytes.length) throw new Error("Image data URL is empty");
    return bytes;
  }

  private async readApprovedPath(inputPath: string): Promise<Uint8Array> {
    const resolved = await realpath(path.resolve(inputPath)).catch(() => { throw new Error(`Generation image does not exist: ${inputPath}`); });
    const canonicalRoots = await Promise.all(this.approvedRoots.map(async (root) => realpath(root).catch(() => path.resolve(root))));
    if (!canonicalRoots.some((root) => within(resolved, root))) throw new Error("Generation image path is outside approved ingress directories");
    const fileStat = await stat(resolved);
    if (!fileStat.isFile()) throw new Error("Generation image path must reference a file");
    if (fileStat.size > MAX_IMAGE_BYTES) throw new Error("Image exceeds the 24 MB ingress limit");
    return readFile(resolved);
  }
}
