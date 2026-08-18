import type { ComfyApiWorkflow, LoadedTrustedWorkflow } from "../workflows/workflowManifest";

export type ImageProviderQueueState = { readonly running: number; readonly pending: number };
export type ImageProviderStatus = {
  readonly provider: string;
  readonly reachable: boolean;
  readonly url: string;
  readonly queue: ImageProviderQueueState;
  readonly message: string;
};

export type ImageProviderProgress = {
  readonly phase: "queued" | "sampling" | "decoding" | "collecting";
  readonly percent?: number;
  readonly nodeId?: string;
  readonly message: string;
};

export type ImageProviderOutput = {
  readonly bytes: Uint8Array;
  readonly mimeType: "image/png" | "image/jpeg";
  readonly providerAsset: { readonly filename: string; readonly subfolder: string; readonly type: string };
};

export type ImageProviderExecutionResult = {
  readonly promptId: string;
  readonly outputs: readonly ImageProviderOutput[];
  readonly warnings: readonly string[];
};

export interface ImageProductionProvider {
  readonly id: string;
  readonly name: string;
  status(): Promise<ImageProviderStatus>;
  inspectDependencies(workflow: LoadedTrustedWorkflow): Promise<{ readonly available: boolean; readonly missingNodeClasses: readonly string[]; readonly missingModels: readonly string[] }>;
  submit(workflow: ComfyApiWorkflow): Promise<{ readonly promptId: string; readonly queueNumber?: number }>;
  waitForCompletion(promptId: string, outputNodeId: string, onProgress?: (progress: ImageProviderProgress) => void): Promise<ImageProviderExecutionResult>;
  uploadImage?(name: string, bytes: Uint8Array, mimeType: "image/png" | "image/jpeg", overwrite?: boolean): Promise<string>;
  cancel?(promptId: string): Promise<boolean>;
}
