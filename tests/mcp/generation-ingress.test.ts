import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ManagedGenerationStorage } from "../../mcp/storage/managedGenerationStorage";

const fixture = new URL("../../public/rig-test/body-base.png", import.meta.url);

describe("managed generation ingress", () => {
  it("copies an approved novel PNG, detects dimensions, and preserves metadata", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "rig-generation-ingress-"));
    const approved = path.join(cwd, "approved"); await mkdir(approved);
    const source = path.join(approved, "novel.png"); await copyFile(fixture, source);
    const storage = new ManagedGenerationStorage({ cwd, approvedRoots: [approved], now: () => new Date("2026-08-17T12:00:00.000Z") });
    const result = await storage.ingest({
      projectId: "character-test", imageSource: { type: "local_path", path: source }, generationId: "imagegen-1",
      provider: "imagegen", prompt: "novel mage", accepted: false, metadata: { model: "imagegen", attempt: 1 },
    }, "http://127.0.0.1:47831");
    expect(result.managedImage).toMatchObject({ width: 60, height: 152, mimeType: "image/png" });
    expect(result.managedImage.image).toContain("/generations/");
    expect(result.managedImage.sourceArtifact).toContain(path.join(".rigging-studio", "generations"));
    expect((await readFile(result.managedImage.sourceArtifact)).length).toBeGreaterThan(100);
    const sidecar = JSON.parse(await readFile(`${result.managedImage.sourceArtifact}.json`, "utf8")) as Record<string, unknown>;
    expect(sidecar).toMatchObject({ generationId: "imagegen-1", provider: "imagegen", width: 60, height: 152 });
  });

  it("accepts data URLs but rejects missing, outside-root, traversal, and unsupported paths", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "rig-generation-security-"));
    const approved = path.join(cwd, "approved"); await mkdir(approved);
    const source = path.join(approved, "source.png"); await copyFile(fixture, source);
    const unsupported = path.join(approved, "source.txt"); await writeFile(unsupported, "not an image");
    const storage = new ManagedGenerationStorage({ cwd, approvedRoots: [approved] });
    const base = { projectId: "p", generationId: "g", provider: "imagegen", prompt: "p", accepted: false, metadata: {} } as const;
    const dataUrl = `data:image/png;base64,${(await readFile(source)).toString("base64")}`;
    await expect(storage.ingest({ ...base, imageSource: { type: "data_url", dataUrl } }, "http://127.0.0.1:1")).resolves.toMatchObject({ managedImage: { width: 60, height: 152 } });
    await expect(storage.ingest({ ...base, imageSource: { type: "local_path", path: path.join(approved, "missing.png") } }, "http://127.0.0.1:1")).rejects.toThrow("does not exist");
    await expect(storage.ingest({ ...base, imageSource: { type: "local_path", path: "/etc/hosts" } }, "http://127.0.0.1:1")).rejects.toThrow("outside approved");
    await expect(storage.ingest({ ...base, imageSource: { type: "local_path", path: path.join(approved, "..", "..", "etc", "passwd") } }, "http://127.0.0.1:1")).rejects.toThrow();
    await expect(storage.ingest({ ...base, imageSource: { type: "local_path", path: unsupported } }, "http://127.0.0.1:1")).rejects.toThrow("Unsupported image type");
  });
});
