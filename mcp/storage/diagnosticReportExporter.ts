import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { JsonValue } from "../../src/rigging/schema/types";

export type DiagnosticReportType = "torture_test" | "project_validation" | "agent_run";
export type DiagnosticReportRequest = {
  readonly reportType: DiagnosticReportType;
  readonly name: string;
  readonly json: Readonly<Record<string, JsonValue>>;
  readonly markdown?: string;
  readonly overwrite: boolean;
};
export type DiagnosticReportResult = {
  readonly success: true;
  readonly reportId: string;
  readonly reportType: DiagnosticReportType;
  readonly timestamp: string;
  readonly jsonReportPath: string;
  readonly markdownReportPath?: string;
  readonly warnings: readonly never[];
};

type Options = { readonly cwd?: string; readonly now?: () => Date };
const within = (candidate: string, root: string): boolean => {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
};
export const sanitizeReportName = (value: string): string => value
  .toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "diagnostic-report";

export class DiagnosticReportExporter {
  readonly directory: string;
  private readonly now: () => Date;

  constructor(options: Options = {}) {
    this.directory = path.resolve(options.cwd ?? process.cwd(), ".rigging-studio", "diagnostics");
    this.now = options.now ?? (() => new Date());
  }

  async export(request: DiagnosticReportRequest): Promise<DiagnosticReportResult> {
    await mkdir(this.directory, { recursive: true });
    const timestamp = this.now().toISOString();
    const stamp = timestamp.replace(/[:.]/g, "-");
    const base = sanitizeReportName(request.name);
    const reportId = `${request.reportType}-${stamp}`;
    const stem = request.overwrite ? base : await this.availableStem(`${base}-${stamp}`);
    const jsonReportPath = this.fixedPath(`${stem}.json`);
    const markdownReportPath = request.markdown === undefined ? undefined : this.fixedPath(`${stem}.md`);
    const flag = request.overwrite ? "w" : "wx";
    await writeFile(jsonReportPath, `${JSON.stringify(request.json, null, 2)}\n`, { flag });
    if (markdownReportPath && request.markdown !== undefined) await writeFile(markdownReportPath, request.markdown.endsWith("\n") ? request.markdown : `${request.markdown}\n`, { flag });
    return { success: true, reportId, reportType: request.reportType, timestamp, jsonReportPath, ...(markdownReportPath ? { markdownReportPath } : {}), warnings: [] };
  }

  async exportTortureTest(results: Readonly<Record<string, JsonValue>>, markdown: string, overwrite: boolean): Promise<DiagnosticReportResult> {
    const canonicalJson = this.fixedPath("torture-test-results.json");
    const canonicalMarkdown = this.fixedPath("torture-test-report.md");
    await mkdir(this.directory, { recursive: true });
    if (overwrite) {
      const timestamp = this.now().toISOString();
      await writeFile(canonicalJson, `${JSON.stringify(results, null, 2)}\n`);
      await writeFile(canonicalMarkdown, markdown.endsWith("\n") ? markdown : `${markdown}\n`);
      return { success: true, reportId: `torture_test-${timestamp.replace(/[:.]/g, "-")}`, reportType: "torture_test", timestamp, jsonReportPath: canonicalJson, markdownReportPath: canonicalMarkdown, warnings: [] };
    }
    const canonicalExists = await Promise.all([canonicalJson, canonicalMarkdown].map(async (candidate) => access(candidate).then(() => true).catch(() => false))).then((values) => values.some(Boolean));
    if (!canonicalExists) {
      const timestamp = this.now().toISOString();
      await writeFile(canonicalJson, `${JSON.stringify(results, null, 2)}\n`, { flag: "wx" });
      await writeFile(canonicalMarkdown, markdown.endsWith("\n") ? markdown : `${markdown}\n`, { flag: "wx" });
      return { success: true, reportId: `torture_test-${timestamp.replace(/[:.]/g, "-")}`, reportType: "torture_test", timestamp, jsonReportPath: canonicalJson, markdownReportPath: canonicalMarkdown, warnings: [] };
    }
    return this.export({ reportType: "torture_test", name: "torture-test-results", json: results, markdown, overwrite: false });
  }

  private async availableStem(base: string): Promise<string> {
    for (let suffix = 1; suffix < 10_000; suffix += 1) {
      const candidate = suffix === 1 ? base : `${base}-${suffix}`;
      const jsonExists = await access(this.fixedPath(`${candidate}.json`)).then(() => true).catch(() => false);
      const markdownExists = await access(this.fixedPath(`${candidate}.md`)).then(() => true).catch(() => false);
      if (!jsonExists && !markdownExists) return candidate;
    }
    throw new Error("Could not allocate a unique diagnostic report filename");
  }

  private fixedPath(fileName: string): string {
    if (fileName !== path.basename(fileName)) throw new Error("Diagnostic filename cannot contain a path");
    const candidate = path.resolve(this.directory, fileName);
    if (!within(candidate, this.directory)) throw new Error("Diagnostic report path escaped its fixed directory");
    return candidate;
  }
}
