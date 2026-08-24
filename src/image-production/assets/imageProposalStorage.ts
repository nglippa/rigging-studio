import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { imageProposalSchema, parseImageProposal, type ImageApprovalPolicy, type ImageProposal } from "../proposals/imageProposal";

const SAFE_ID = /^[a-zA-Z0-9_-]{1,160}$/;
const SAFE_IMAGE_FILE = /^[a-zA-Z0-9._-]+\.(png|jpg|jpeg)$/;
const within = (candidate: string, root: string): boolean => {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
};

export type ManagedProposalImage = {
  readonly imageAssetId: string;
  readonly imageFileName: string;
  readonly filePath: string;
  readonly width: number;
  readonly height: number;
  readonly mimeType: "image/png" | "image/jpeg";
};

export type ImageProposalStorageOptions = { readonly cwd?: string };

export class ImageProposalStorage {
  readonly rootDirectory: string;
  readonly approvalPolicyDirectory: string;
  constructor(options: ImageProposalStorageOptions = {}) {
    this.rootDirectory = path.resolve(options.cwd ?? process.cwd(), ".rigging-studio", "image-production", "proposals");
    this.approvalPolicyDirectory = path.resolve(this.rootDirectory, "..", "approval-policies");
  }

  async readApprovalPolicy(projectId: string): Promise<ImageApprovalPolicy> {
    this.assertId(projectId, "project ID");
    const file = path.join(this.approvalPolicyDirectory, `${projectId}.json`);
    try {
      const value = JSON.parse(await readFile(file, "utf8")) as { readonly projectId?: unknown; readonly approvalPolicy?: unknown };
      if (value.projectId !== projectId || (value.approvalPolicy !== "manual" && value.approvalPolicy !== "agent_recommendation")) throw new Error("Invalid approval policy record");
      return value.approvalPolicy;
    } catch (error: unknown) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return "manual";
      throw error;
    }
  }

  async writeApprovalPolicy(projectId: string, approvalPolicy: ImageApprovalPolicy): Promise<void> {
    this.assertId(projectId, "project ID");
    await mkdir(this.approvalPolicyDirectory, { recursive: true });
    const target = path.join(this.approvalPolicyDirectory, `${projectId}.json`);
    type PolicyChange = { readonly from: ImageApprovalPolicy; readonly to: ImageApprovalPolicy; readonly changedAt: string };
    let previous: { readonly projectId: string; readonly approvalPolicy: ImageApprovalPolicy; readonly initialPolicy: "manual"; readonly changes: readonly PolicyChange[] } = {
      projectId, approvalPolicy: "manual", initialPolicy: "manual", changes: [],
    };
    try {
      const value = JSON.parse(await readFile(target, "utf8")) as typeof previous;
      if (value.projectId !== projectId || (value.approvalPolicy !== "manual" && value.approvalPolicy !== "agent_recommendation") || !Array.isArray(value.changes)) throw new Error("Invalid approval policy record");
      previous = value;
    } catch (error: unknown) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
    }
    const changes = previous.approvalPolicy === approvalPolicy
      ? previous.changes
      : [...previous.changes, { from: previous.approvalPolicy, to: approvalPolicy, changedAt: new Date().toISOString() }];
    const record = { projectId, approvalPolicy, initialPolicy: "manual" as const, changes };
    const temporary = path.join(this.approvalPolicyDirectory, `${projectId}-${crypto.randomUUID()}.tmp`);
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx" });
    await rename(temporary, target);
  }

  proposalDirectory(proposalId: string): string {
    this.assertId(proposalId, "proposal ID");
    const directory = path.resolve(this.rootDirectory, proposalId);
    if (!within(directory, this.rootDirectory)) throw new Error("Proposal path escaped the managed image-production directory");
    return directory;
  }

  async create(proposal: ImageProposal): Promise<void> {
    const validated = imageProposalSchema.parse(proposal);
    const directory = this.proposalDirectory(validated.proposalId);
    await mkdir(directory, { recursive: true });
    await this.writeProposal(validated);
  }

  async writeProposal(proposal: ImageProposal): Promise<void> {
    const validated = imageProposalSchema.parse(proposal);
    const directory = this.proposalDirectory(validated.proposalId);
    await mkdir(directory, { recursive: true });
    const target = path.join(directory, "metadata.json");
    const temporary = path.join(directory, `metadata-${crypto.randomUUID()}.tmp`);
    await writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, { flag: "wx" });
    await rename(temporary, target);
  }

  async readProposal(proposalId: string): Promise<ImageProposal> {
    const file = path.join(this.proposalDirectory(proposalId), "metadata.json");
    try { return parseImageProposal(JSON.parse(await readFile(file, "utf8")) as unknown); }
    catch (error: unknown) { throw new Error(error instanceof Error && /Invalid image proposal/.test(error.message) ? error.message : `Image proposal ${proposalId} does not exist`); }
  }

  async list(projectId?: string): Promise<readonly ImageProposal[]> {
    let entries: readonly string[] = [];
    try { entries = await readdir(this.rootDirectory); } catch { return []; }
    const proposals: ImageProposal[] = [];
    for (const entry of entries) {
      if (!SAFE_ID.test(entry)) continue;
      try {
        const proposal = await this.readProposal(entry);
        if (!projectId || proposal.projectId === projectId) proposals.push(proposal);
      } catch { /* retain malformed proposal directories for diagnostics without exposing them */ }
    }
    return proposals.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async writeCandidate(proposalId: string, candidateId: string, bytes: Uint8Array, mimeType: "image/png" | "image/jpeg"): Promise<ManagedProposalImage> {
    this.assertId(candidateId, "candidate ID");
    const dimensions = inspectImage(bytes, mimeType);
    const extension = mimeType === "image/png" ? "png" : "jpg";
    const digest = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
    const imageFileName = `${candidateId}-${digest}.${extension}`;
    const directory = this.proposalDirectory(proposalId);
    await mkdir(directory, { recursive: true });
    const filePath = path.resolve(directory, imageFileName);
    if (!within(filePath, directory)) throw new Error("Candidate path escaped the proposal directory");
    await writeFile(filePath, bytes, { flag: "wx" }).catch((error: unknown) => {
      if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") return;
      throw error;
    });
    return { imageAssetId: `proposal:${proposalId}:${candidateId}`, imageFileName, filePath, width: dimensions.width, height: dimensions.height, mimeType };
  }

  async writeContactSheet(proposalId: string, bytes: Uint8Array): Promise<{ readonly fileName: string; readonly filePath: string }> {
    inspectImage(bytes, "image/png");
    const directory = this.proposalDirectory(proposalId); await mkdir(directory, { recursive: true });
    const fileName = "candidate-contact-sheet.png";
    const filePath = path.resolve(directory, fileName);
    await writeFile(filePath, bytes);
    return { fileName, filePath };
  }

  async readAsset(proposalId: string, fileName: string): Promise<Uint8Array> {
    if (!SAFE_IMAGE_FILE.test(fileName) && fileName !== "candidate-contact-sheet.png") throw new Error("Invalid managed proposal asset name");
    const directory = this.proposalDirectory(proposalId);
    const filePath = path.resolve(directory, fileName);
    if (!within(filePath, directory)) throw new Error("Proposal asset path escaped the managed directory");
    return readFile(filePath);
  }

  assetPath(proposalId: string, fileName: string): string | null {
    try {
      if (!SAFE_IMAGE_FILE.test(fileName)) return null;
      const directory = this.proposalDirectory(proposalId); const filePath = path.resolve(directory, fileName);
      return within(filePath, directory) ? filePath : null;
    } catch { return null; }
  }

  private assertId(value: string, label: string): void { if (!SAFE_ID.test(value)) throw new Error(`Invalid ${label}`); }
}

export function inspectImage(bytes: Uint8Array, expectedMimeType: "image/png" | "image/jpeg"): { readonly width: number; readonly height: number } {
  if (bytes.length > 24 * 1024 * 1024) throw new Error("Image exceeds the 24 MB managed proposal limit");
  if (expectedMimeType === "image/png") {
    if (bytes.length < 24 || bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) throw new Error("Provider output is not a valid PNG");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); const width = view.getUint32(16); const height = view.getUint32(20);
    if (!width || !height) throw new Error("Provider PNG dimensions are invalid");
    return { width, height };
  }
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error("Provider output is not a valid JPEG");
  let offset = 2; const sof = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  while (offset + 8 < bytes.length) {
    if (bytes[offset] !== 0xff) { offset += 1; continue; }
    const marker = bytes[offset + 1]; const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
    if (sof.has(marker)) return { height: (bytes[offset + 5] << 8) | bytes[offset + 6], width: (bytes[offset + 7] << 8) | bytes[offset + 8] };
    if (length < 2) break; offset += length + 2;
  }
  throw new Error("Provider JPEG dimensions could not be read");
}
