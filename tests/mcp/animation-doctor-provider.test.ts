import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PNG } from "pngjs";
import { AstraAnimationDoctorProvider } from "../../mcp/vision-review/AstraAnimationDoctorProvider";
import { inspectDoctorPacket } from "../../src/animation-doctor/evidence";
import { measureDoctorMotion } from "../../src/animation-doctor/metrics";
import { canonicalProjectStateDigest } from "../../src/project-storage/digest";
import type { LocalProjectSnapshot } from "../../src/project-storage/types";

async function packet() {
  const rig = JSON.parse(await readFile("tests/fixtures/golden/void-ranger/rig.json", "utf8"));
  const animations = JSON.parse(await readFile("tests/fixtures/golden/void-ranger/animations.json", "utf8"));
  const snapshot: LocalProjectSnapshot = { storageVersion: 1, project: null, localProjectId: "provider-copy", rig, animations, selectedSkinId: rig.defaultSkinId };
  const identity = { projectId: "provider-copy", projectSessionToken: "session", revision: 1, clipId: animations.animations[0].id, beforeDigest: canonicalProjectStateDigest(snapshot) };
  const image = PNG.sync.write(new PNG({ width: 1, height: 1 }));
  const metrics = measureDoctorMotion(rig, animations.animations[0], { contacts: [], grips: [] });
  return inspectDoctorPacket(snapshot, identity, 0, metrics, metrics, [{ id: "v0-frame-0", time: 0, sha256: createHash("sha256").update(image).digest("hex"), dataUrl: `data:image/png;base64,${image.toString("base64")}` }]);
}
const verdict = { issues: [], edits: [], visualScore: .7, expectedImprovement: "Keep existing motion", rerenderRequired: false, requests: [] };

describe("Astra motion provider transport", () => {
  it("pins the exact model, attaches hash-checked images and strict schema, disables broad tools", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "astra-provider-"));
    const runner = vi.fn(async (_command: string, args: readonly string[]) => {
      expect(args[args.indexOf("-m") + 1]).toBe("gpt-6-astra"); expect(args).toContain("features.shell_tool=false"); expect(args).toContain("features.plugins=false");
      expect(args).toContain("--ignore-user-config"); expect(args).toContain("--ignore-rules"); expect(args).toContain("--output-schema"); expect(args).toContain("-i");
      await writeFile(args[args.indexOf("--output-last-message") + 1], JSON.stringify(verdict)); return { stdout: "not persisted", stderr: "not persisted", exitCode: 0 };
    });
    const provider = new AstraAnimationDoctorProvider(root, runner); const result = await provider.review(await packet());
    expect(result.model).toBe("gpt-6-astra"); expect(result.review).toEqual(verdict); expect(runner).toHaveBeenCalledTimes(1);
    const audit = JSON.parse(await readFile(path.join(root, ".rigging-studio/diagnostics/animation-doctor-jobs", result.evidenceId, "audit.json"), "utf8"));
    expect(audit.sourceHashes).toHaveLength(1); expect(audit.inputHash).toMatch(/^[a-f0-9]{64}$/); expect(JSON.stringify(audit)).not.toContain("not persisted");
  });
  it("reports exact Astra version failure without fallback or raw process diagnostics", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "astra-provider-")); const runner = vi.fn(async () => { throw new Error("gpt-6-astra requires a newer version of Codex; private session diagnostic"); });
    await expect(new AstraAnimationDoctorProvider(root, runner).review(await packet())).rejects.toThrow("requires a newer Codex"); expect(runner).toHaveBeenCalledTimes(1);
    const directory = path.join(root, ".rigging-studio/diagnostics/animation-doctor-jobs"); const jobs = await readdir(directory);
    const audit = await readFile(path.join(directory, jobs[0], "audit.json"), "utf8"); expect(audit).not.toContain("private session diagnostic");
  });
  it("rejects image tampering before a provider call", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "astra-provider-")); const runner = vi.fn(); const input = await packet(); input.images[0].sha256 = "0".repeat(64);
    await expect(new AstraAnimationDoctorProvider(root, runner).review(input)).rejects.toThrow(/hash/); expect(runner).not.toHaveBeenCalled();
  });
  it("rejects invalid model output and never returns an unvalidated proposal", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "astra-provider-")); const runner = vi.fn(async (_command: string, args: readonly string[]) => { await writeFile(args[args.indexOf("--output-last-message") + 1], JSON.stringify({ ...verdict, arbitraryMutation: {} })); return { stdout: "", stderr: "", exitCode: 0 }; });
    await expect(new AstraAnimationDoctorProvider(root, runner).review(await packet())).rejects.toThrow(/invalid structured/);
  });
  it("rejects unrelated project state in the focused packet", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "astra-provider-")); const runner = vi.fn();
    await expect(new AstraAnimationDoctorProvider(root, runner).review({ ...await packet(), project: { credentials: "forbidden" } })).rejects.toThrow(); expect(runner).not.toHaveBeenCalled();
  });
});
