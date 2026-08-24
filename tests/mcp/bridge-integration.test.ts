import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { BRIDGE_PROTOCOL_VERSION } from "../../src/agent-control/protocol/messages";
import { StudioBridgeServer } from "../../mcp/transport/StudioBridgeServer";
import { createGeneratedCharacterProject } from "../../src/character-generation/project/generatedCharacterProject";
import { LOCAL_PROJECT_STORAGE_VERSION } from "../../src/project-storage/types";

const bridges: StudioBridgeServer[] = [];
const sockets: WebSocket[] = [];
afterEach(async () => {
  sockets.splice(0).forEach((socket) => socket.close());
  await Promise.all(bridges.splice(0).map((bridge) => bridge.close()));
});

const connectStudio = async (port: number, sessionId: string): Promise<WebSocket> => {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`); sockets.push(socket);
  await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  socket.send(JSON.stringify({ type: "hello", protocolVersion: BRIDGE_PROTOCOL_VERSION, sessionId, client: "rigging-studio-browser" }));
  return socket;
};

const availablePort = async (bridge: StudioBridgeServer): Promise<number | null> => {
  try { return await bridge.waitUntilListening(); }
  catch (error: unknown) {
    if (error instanceof Error && /EPERM|operation not permitted/i.test(error.message)) return null;
    throw error;
  }
};

describe("localhost Studio bridge", () => {
  it("restores a trusted custom storage-root selection across bridge startup", async () => {
    if (process.env.RIGGING_STUDIO_PROJECTS_ROOT) return;
    const cwd = mkdtempSync(path.join(tmpdir(), "rigging-studio-root-config-")); const customRoot = path.join(cwd, "chosen-projects");
    mkdirSync(path.join(cwd, ".rigging-studio"), { recursive: true }); writeFileSync(path.join(cwd, ".rigging-studio/storage-config.json"), JSON.stringify({ storageVersion: 1, root: customRoot }));
    const bridge = new StudioBridgeServer({ port: 0, cwd }); bridges.push(bridge); const port = await availablePort(bridge); if (port === null) return;
    const response = await fetch(`http://127.0.0.1:${port}/project-storage/status`); expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ root: customRoot, available: true, writable: true });
  });

  it("persists managed projects across bridge restarts without browser storage", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "rigging-studio-durable-")); const project = createGeneratedCharacterProject("Restart proof", "disk");
    const first = new StudioBridgeServer({ port: 0, cwd }); bridges.push(first); const firstPort = await availablePort(first); if (firstPort === null) return;
    const saved = await fetch(`http://127.0.0.1:${firstPort}/project-storage/save`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ snapshot: { storageVersion: LOCAL_PROJECT_STORAGE_VERSION, project, rig: null, animations: null, selectedSkinId: null } }) });
    expect(saved.status).toBe(200); const savedProject = await saved.json() as { readonly projectId: string }; await first.close(); bridges.splice(bridges.indexOf(first), 1);
    const restarted = new StudioBridgeServer({ port: 0, cwd }); bridges.push(restarted); const secondPort = await availablePort(restarted); if (secondPort === null) return;
    const listed = await fetch(`http://127.0.0.1:${secondPort}/project-storage/projects`); expect(listed.status).toBe(200);
    expect((await listed.json() as { readonly projects: readonly { readonly projectId: string }[] }).projects.map((entry) => entry.projectId)).toContain(savedProject.projectId);
    const loaded = await fetch(`http://127.0.0.1:${secondPort}/project-storage/load`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId: savedProject.projectId }) });
    expect(loaded.status).toBe(200); expect(await loaded.json()).toMatchObject({ snapshot: { project: { name: "Restart proof" }, rig: null, animations: null } });
    expect((await fetch(`http://127.0.0.1:${secondPort}/project-storage/assets/${savedProject.projectId}/..%2F..%2Fpackage.json`)).status).not.toBe(200);
  });

  it("handles sequential calls, persists fixed-path previews, and reconnects", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "rigging-studio-bridge-"));
    const bridge = new StudioBridgeServer({ port: 0, cwd, requestTimeoutMs: 2_000 }); bridges.push(bridge);
    const port = await availablePort(bridge); if (port === null) return;
    const first = await connectStudio(port, "session-one");
    first.on("message", (raw) => {
      const request = JSON.parse(raw.toString()) as { id: string; tool: string };
      const result = request.tool === "preview_render"
        ? { success: true, warnings: [], preview: { renderId: "render-test", imageBase64: Buffer.from("png-bytes").toString("base64"), mimeType: "image/png", width: 64, height: 64, frameCount: 2 } }
        : { success: true, warnings: [], connected: true, sequence: request.id };
      first.send(JSON.stringify({ type: "response", protocolVersion: BRIDGE_PROTOCOL_VERSION, id: request.id, result }));
    });
    const one = await bridge.request("studio_get_status", { includeActivity: false });
    expect(one).toMatchObject({ success: true, connected: true });
    const preview = await bridge.request("preview_render", { animationId: "idle", mode: "contact_sheet", frameCount: 2, width: 320, overlays: [] });
    expect(preview).toMatchObject({ preview: { imagePath: expect.stringContaining("render-test.png"), resourceUri: "rigging://active-project/preview/latest" } });
    expect(readFileSync(bridge.previewPath!, "utf8")).toBe("png-bytes");

    await new Promise<void>((resolve) => { first.once("close", () => resolve()); first.close(); });
    const second = await connectStudio(port, "session-two");
    second.on("message", (raw) => {
      const request = JSON.parse(raw.toString()) as { id: string };
      second.send(JSON.stringify({ type: "response", protocolVersion: BRIDGE_PROTOCOL_VERSION, id: request.id, result: { success: true, warnings: [], reconnected: true } }));
    });
    const afterReconnect = await bridge.request("studio_get_status", { includeActivity: false });
    expect(afterReconnect).toMatchObject({ success: true, reconnected: true });
    expect(bridge.activeSessionId).toBe("session-two");
  });

  it("ignores malformed browser messages and times out once without automatic retries", async () => {
    const bridge = new StudioBridgeServer({ port: 0, requestTimeoutMs: 30 }); bridges.push(bridge);
    const port = await availablePort(bridge); if (port === null) return;
    const socket = await connectStudio(port, "malformed-session");
    let requestCount = 0;
    socket.on("message", () => { requestCount += 1; socket.send("not-json"); });
    await expect(bridge.request("validation_get", { includeDetails: true })).rejects.toThrow("timed out");
    expect(requestCount).toBe(1);
  });

  it("supports the browser HTTP polling fallback without duplicating commands", async () => {
    const bridge = new StudioBridgeServer({ port: 0, requestTimeoutMs: 1_000 }); bridges.push(bridge);
    const port = await availablePort(bridge); if (port === null) return;
    const baseUrl = `http://127.0.0.1:${port}`;
    const hello = await fetch(`${baseUrl}/hello`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "hello", protocolVersion: BRIDGE_PROTOCOL_VERSION, sessionId: "poll-session", client: "rigging-studio-browser" }),
    });
    expect(hello.status).toBe(204);

    const resultPromise = bridge.request("studio_get_status", { includeActivity: false });
    const polled = await fetch(`${baseUrl}/poll?sessionId=poll-session`);
    expect(polled.status).toBe(200);
    const request = await polled.json() as { readonly id: string; readonly tool: string };
    expect(request.tool).toBe("studio_get_status");
    const response = await fetch(`${baseUrl}/response`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "response", protocolVersion: BRIDGE_PROTOCOL_VERSION, id: request.id, result: { success: true, warnings: [], transport: "poll" } }),
    });
    expect(response.status).toBe(204);
    await expect(resultPromise).resolves.toMatchObject({ success: true, transport: "poll" });
    expect(bridge.activeSessionId).toBe("poll-session");
  });

  it("normalizes approved image ingress and serves only the managed copy", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "rigging-studio-ingress-"));
    const sourceDir = path.join(cwd, "public", "rig-test"); mkdirSync(sourceDir, { recursive: true });
    const sourcePath = path.join(sourceDir, "source.png"); copyFileSync(new URL("../../public/rig-test/body-base.png", import.meta.url), sourcePath);
    const bridge = new StudioBridgeServer({ port: 0, cwd, requestTimeoutMs: 2_000 }); bridges.push(bridge);
    const port = await availablePort(bridge); if (port === null) return;
    const socket = await connectStudio(port, "ingress-session");
    socket.on("message", (raw) => {
      const request = JSON.parse(raw.toString()) as { readonly id: string; readonly tool: string; readonly input: Record<string, unknown> };
      socket.send(JSON.stringify({ type: "response", protocolVersion: BRIDGE_PROTOCOL_VERSION, id: request.id, result: { success: true, warnings: [], normalized: request.input } }));
    });
    const result = await bridge.ingestGeneration({
      projectId: "character-test", imageSource: { type: "local_path", path: sourcePath }, generationId: "novel-1",
      provider: "imagegen", prompt: "novel", accepted: false, metadata: {},
    }) as { readonly normalized: { readonly managedImage: { readonly image: string; readonly width: number; readonly height: number } } };
    expect(result.normalized.managedImage).toMatchObject({ width: 60, height: 152 });
    const served = await fetch(result.normalized.managedImage.image);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/png");
    expect((await served.arrayBuffer()).byteLength).toBeGreaterThan(100);
    expect((await fetch(`http://127.0.0.1:${port}/generations/..%2Fpackage.json`)).status).toBe(404);
  });
});
