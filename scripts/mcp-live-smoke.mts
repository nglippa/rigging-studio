import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const sleep = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));
const asRecord = (value: unknown): Readonly<Record<string, unknown>> | undefined => value !== null && typeof value === "object" ? value as Readonly<Record<string, unknown>> : undefined;
const transport = new StdioClientTransport({ command: "npm", args: ["run", "mcp"], cwd: process.cwd(), stderr: "pipe" });
const client = new Client({ name: "rigging-studio-live-smoke", version: "1.0.0" });
transport.stderr?.on("data", (chunk) => process.stderr.write(chunk));

try {
  await client.connect(transport);
  let status: Readonly<Record<string, unknown>> | undefined;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const response = await client.callTool({ name: "studio_get_status", arguments: { includeActivity: false } });
    status = asRecord(response.structuredContent);
    if (status?.connected === true) break;
    await sleep(250);
  }
  if (status?.connected !== true) throw new Error("The browser Studio did not connect to the MCP bridge");

  const rigResponse = await client.callTool({ name: "rig_get_summary", arguments: { includeHierarchy: true, includeFull: false } });
  const rigResult = rigResponse.structuredContent as { readonly rig?: { readonly bones?: readonly { readonly id: string; readonly rotation: number }[] } } | undefined;
  const head = rigResult?.rig?.bones?.find((bone) => bone.id === "head") ?? rigResult?.rig?.bones?.find((bone) => /head/i.test(bone.id));
  if (!head) throw new Error("No head bone was found in the active rig");

  const targetRotation = Math.max(-360, Math.min(360, head.rotation + 7));
  const changed = await client.callTool({ name: "rig_rotate_bone", arguments: { boneId: head.id, rotation: targetRotation, unit: "degrees" } });
  if (changed.isError) throw new Error("The live rig edit failed");
  const validation = await client.callTool({ name: "validation_get", arguments: { includeDetails: true } });
  process.stdout.write(`${JSON.stringify({
    connected: status.connected,
    selectedBoneId: head.id,
    previousRotation: head.rotation,
    currentRotation: targetRotation,
    validation: validation.structuredContent,
    instruction: "The edit remains in normal UI history; use the editor Undo button to restore it.",
  }, null, 2)}\n`);
  await sleep(8_000);
} finally {
  await client.close();
}
