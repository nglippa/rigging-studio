import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { safeParseAnimationDefinition, safeParseRigDefinition, safeParseRigJson } from "../../src/rigging/schema/parsing";
import { resolveAssetUrl } from "../../src/rigging/assets/attachmentAssets";
import { validAnimation, validRig } from "./fixtures";

describe("rig and animation schemas", () => {
  it("preserves session-local and remote attachment URLs", () => {
    expect(resolveAssetUrl("blob:http://localhost/upload", "/assets")).toBe("blob:http://localhost/upload");
    expect(resolveAssetUrl("https://cdn.example/part.png", "/assets")).toBe("https://cdn.example/part.png");
    expect(resolveAssetUrl("parts/body.png", "/assets")).toBe("/assets/parts/body.png");
  });

  it("parses valid current-version definitions", () => {
    const rig = safeParseRigDefinition(validRig());
    expect(rig.success).toBe(true);
    expect(safeParseAnimationDefinition(validAnimation(), rig.success ? rig.data : undefined).success).toBe(true);
  });

  it("loads and validates the public JSON fixtures together", async () => {
    const [rigSource, ...animationSources] = await Promise.all([
      readFile(new URL("../../public/rig-test/minimal-rig.json", import.meta.url), "utf8"),
      readFile(new URL("../../public/rig-test/idle-animation.json", import.meta.url), "utf8"),
      readFile(new URL("../../public/rig-test/animations/walk.json", import.meta.url), "utf8"),
      readFile(new URL("../../public/rig-test/animations/attack.json", import.meta.url), "utf8"),
    ]);
    const rig = safeParseRigJson(rigSource);
    expect(rig.success).toBe(true);
    if (rig.success) animationSources.forEach((animationSource) => {
      expect(safeParseAnimationDefinition(JSON.parse(animationSource) as unknown, rig.data).success).toBe(true);
    });
  });

  it("returns useful JSON and strict-property errors", () => {
    const malformed = safeParseRigJson("{ nope");
    expect(malformed.success).toBe(false);
    if (!malformed.success) expect(malformed.issues[0].code).toBe("invalid_json");
    const withTypo = { ...validRig(), canvas: { width: 100, height: 100, widht: 100 } };
    const parsed = safeParseRigDefinition(withTypo);
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.message).toContain("canvas");
  });

  it("rejects unsupported animation properties and easing", () => {
    const unsupportedProperty = { ...validAnimation(), tracks: [{ ...validAnimation().tracks[0], property: "skewX" }] };
    const unsupportedEasing = { ...validAnimation(), tracks: [{ ...validAnimation().tracks[0], keyframes: [{ time: 0, value: 0, easing: "bounce" }] }] };
    expect(safeParseAnimationDefinition(unsupportedProperty, validRig()).success).toBe(false);
    expect(safeParseAnimationDefinition(unsupportedEasing, validRig()).success).toBe(false);
  });
});
