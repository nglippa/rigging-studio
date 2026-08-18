import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DiagnosticReportExporter, sanitizeReportName } from "../../mcp/storage/diagnosticReportExporter";

describe("managed diagnostics export", () => {
  it("writes JSON and Markdown only under the diagnostics directory", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "rig-diagnostics-"));
    const exporter = new DiagnosticReportExporter({ cwd, now: () => new Date("2026-08-17T12:34:56.000Z") });
    const result = await exporter.export({ reportType: "agent_run", name: "../../agent run", json: { status: "blocked" }, markdown: "# Agent run", overwrite: false });
    expect(result.jsonReportPath.startsWith(`${path.join(cwd, ".rigging-studio", "diagnostics")}${path.sep}`)).toBe(true);
    expect(result.markdownReportPath?.startsWith(`${path.join(cwd, ".rigging-studio", "diagnostics")}${path.sep}`)).toBe(true);
    expect(path.basename(result.jsonReportPath)).not.toContain("..");
    expect(await readFile(result.jsonReportPath, "utf8")).toContain('"status": "blocked"');
    expect(await readFile(result.markdownReportPath!, "utf8")).toBe("# Agent run\n");
  });

  it("sanitizes names and allocates timestamp-collision revisions", async () => {
    expect(sanitizeReportName("../../Package.JSON $$$")).toBe("package-json");
    const cwd = await mkdtemp(path.join(tmpdir(), "rig-diagnostics-collision-"));
    const exporter = new DiagnosticReportExporter({ cwd, now: () => new Date("2026-08-17T12:34:56.000Z") });
    const first = await exporter.export({ reportType: "project_validation", name: "Validation", json: { pass: true }, overwrite: false });
    const second = await exporter.export({ reportType: "project_validation", name: "Validation", json: { pass: false }, overwrite: false });
    expect(second.jsonReportPath).not.toBe(first.jsonReportPath);
    expect(path.dirname(second.jsonReportPath)).toBe(exporter.directory);
  });

  it("uses canonical torture-test paths once and revisioned paths afterward", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "rig-torture-diagnostics-"));
    const exporter = new DiagnosticReportExporter({ cwd, now: () => new Date("2026-08-17T12:34:56.000Z") });
    const first = await exporter.exportTortureTest({ attempted: 1 }, "# Torture test", false);
    const second = await exporter.exportTortureTest({ attempted: 2 }, "# Torture test revision", false);
    expect(path.basename(first.jsonReportPath)).toBe("torture-test-results.json");
    expect(path.basename(first.markdownReportPath!)).toBe("torture-test-report.md");
    expect(second.jsonReportPath).not.toBe(first.jsonReportPath);
  });
});
