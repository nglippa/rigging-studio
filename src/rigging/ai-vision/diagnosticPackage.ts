import type { AnimationDefinition } from "../schema/types";
import type { VisualReview } from "./visualReviewSchema";
import type { VisualReviewContext } from "./visualReviewPromptBuilder";

export type DiagnosticPackageFile = { readonly name: string; readonly data: Uint8Array };
const encoder = new TextEncoder();
const textFile = (name: string, text: string): DiagnosticPackageFile => ({ name, data: encoder.encode(text) });

export const buildDiagnosticPackageFiles = async (input: {
  readonly contactSheet: Blob;
  readonly context: VisualReviewContext;
  readonly animation: AnimationDefinition;
  readonly reviewRequest: string;
  readonly reviewResponse?: VisualReview;
}): Promise<readonly DiagnosticPackageFile[]> => {
  const rigContext: Omit<VisualReviewContext, "animation"> = {
    animationGoal: input.context.animationGoal,
    rig: input.context.rig,
    groundPlaneY: input.context.groundPlaneY,
    feet: input.context.feet,
    constraints: input.context.constraints,
    knownWarnings: input.context.knownWarnings,
    capture: input.context.capture,
  };
  return [
    { name: "contact-sheet.png", data: new Uint8Array(await input.contactSheet.arrayBuffer()) },
    textFile("rig-context.json", `${JSON.stringify(rigContext, null, 2)}\n`),
    textFile("animation.json", `${JSON.stringify(input.animation, null, 2)}\n`),
    textFile("review-request.txt", `${input.reviewRequest}\n`),
    ...(input.reviewResponse ? [textFile("review-response.json", `${JSON.stringify(input.reviewResponse, null, 2)}\n`)] : []),
  ];
};

const crcTable = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});
const crc32 = (data: Uint8Array): number => {
  let crc = 0xffffffff;
  data.forEach((value) => { crc = crcTable[(crc ^ value) & 0xff] ^ (crc >>> 8); });
  return (crc ^ 0xffffffff) >>> 0;
};
const write16 = (view: DataView, offset: number, value: number): void => view.setUint16(offset, value, true);
const write32 = (view: DataView, offset: number, value: number): void => view.setUint32(offset, value, true);

export const createDiagnosticZip = (files: readonly DiagnosticPackageFile[]): Blob => {
  const names = files.map((file) => encoder.encode(file.name));
  const localSize = files.reduce((sum, file, index) => sum + 30 + names[index].length + file.data.length, 0);
  const centralSize = files.reduce((sum, _file, index) => sum + 46 + names[index].length, 0);
  const output = new Uint8Array(localSize + centralSize + 22); const view = new DataView(output.buffer);
  let cursor = 0; const offsets: number[] = [];
  files.forEach((file, index) => {
    offsets.push(cursor); const name = names[index]; const crc = crc32(file.data);
    write32(view, cursor, 0x04034b50); write16(view, cursor + 4, 20); write16(view, cursor + 6, 0); write16(view, cursor + 8, 0);
    write16(view, cursor + 10, 0); write16(view, cursor + 12, 0); write32(view, cursor + 14, crc); write32(view, cursor + 18, file.data.length); write32(view, cursor + 22, file.data.length); write16(view, cursor + 26, name.length); write16(view, cursor + 28, 0);
    output.set(name, cursor + 30); output.set(file.data, cursor + 30 + name.length); cursor += 30 + name.length + file.data.length;
  });
  const centralOffset = cursor;
  files.forEach((file, index) => {
    const name = names[index]; const crc = crc32(file.data);
    write32(view, cursor, 0x02014b50); write16(view, cursor + 4, 20); write16(view, cursor + 6, 20); write16(view, cursor + 8, 0); write16(view, cursor + 10, 0); write16(view, cursor + 12, 0); write16(view, cursor + 14, 0);
    write32(view, cursor + 16, crc); write32(view, cursor + 20, file.data.length); write32(view, cursor + 24, file.data.length); write16(view, cursor + 28, name.length); write16(view, cursor + 30, 0); write16(view, cursor + 32, 0); write16(view, cursor + 34, 0); write16(view, cursor + 36, 0); write32(view, cursor + 38, 0); write32(view, cursor + 42, offsets[index]);
    output.set(name, cursor + 46); cursor += 46 + name.length;
  });
  write32(view, cursor, 0x06054b50); write16(view, cursor + 4, 0); write16(view, cursor + 6, 0); write16(view, cursor + 8, files.length); write16(view, cursor + 10, files.length); write32(view, cursor + 12, centralSize); write32(view, cursor + 16, centralOffset); write16(view, cursor + 20, 0);
  return new Blob([output], { type: "application/zip" });
};
