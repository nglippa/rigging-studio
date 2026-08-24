import { createDiagnosticZip, type DiagnosticPackageFile } from "../../rigging/ai-vision/diagnosticPackage";
import { parseGeneratedCharacterProject, serializeGeneratedCharacterProject, type GeneratedCharacterProject } from "./generatedCharacterProject";

const encoder = new TextEncoder(); const decoder = new TextDecoder();
const asFile = (name: string, source: string): DiagnosticPackageFile => ({ name, data: encoder.encode(source) });
const imageExtension = (contentType: string): string => contentType.includes("webp") ? "webp" : contentType.includes("jpeg") ? "jpg" : "png";

async function fetchBinary(source: string, fetcher: typeof fetch): Promise<{ readonly data: Uint8Array; readonly extension: string }> {
  if (source.startsWith("data:")) {
    const [header, payload = ""] = source.split(",", 2); const contentType = header.match(/^data:([^;]+)/)?.[1] ?? "image/png";
    const bytes = header.includes(";base64") ? Uint8Array.from(atob(payload), (char) => char.charCodeAt(0)) : encoder.encode(decodeURIComponent(payload));
    return { data: bytes, extension: imageExtension(contentType) };
  }
  const response = await fetcher(source); if (!response.ok) throw new Error(`Could not package image ${source} (${response.status})`);
  return { data: new Uint8Array(await response.arrayBuffer()), extension: imageExtension(response.headers.get("content-type") ?? "image/png") };
}

export async function buildCharacterProjectFiles(project: GeneratedCharacterProject, fetcher: typeof fetch = fetch): Promise<readonly DiagnosticPackageFile[]> {
  const files: DiagnosticPackageFile[] = [asFile("manifest.json", serializeGeneratedCharacterProject(project)), asFile("generation/metadata.json", `${JSON.stringify(project.generationMetadata, null, 2)}\n`)];
  if (project.rigDefinition) files.push(asFile("rig/rig.json", `${JSON.stringify(project.rigDefinition, null, 2)}\n`));
  if (project.sourceImage) { const source = await fetchBinary(project.sourceImage.image, fetcher); files.push({ name: `source.${source.extension}`, data: source.data }); }
  for (const part of project.extractedParts) { const image = await fetchBinary(part.image, fetcher); files.push({ name: `parts/${part.partId}.${image.extension}`, data: image.data }); }
  return files;
}

export async function createCharacterProjectZip(project: GeneratedCharacterProject, fetcher: typeof fetch = fetch): Promise<Blob> {
  return createDiagnosticZip(await buildCharacterProjectFiles(project, fetcher));
}

export function readStoredZip(bytes: Uint8Array): ReadonlyMap<string, Uint8Array> {
  const files = new Map<string, Uint8Array>(); const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); let cursor = 0;
  while (cursor + 30 <= bytes.length && view.getUint32(cursor, true) === 0x04034b50) {
    const method = view.getUint16(cursor + 8, true); if (method !== 0) throw new Error("Only uncompressed character project ZIP files are supported");
    const size = view.getUint32(cursor + 18, true); const nameLength = view.getUint16(cursor + 26, true); const extraLength = view.getUint16(cursor + 28, true);
    const nameStart = cursor + 30; const dataStart = nameStart + nameLength + extraLength; const dataEnd = dataStart + size;
    if (dataEnd > bytes.length) throw new Error("Character project ZIP is truncated");
    const name = decoder.decode(bytes.slice(nameStart, nameStart + nameLength));
    if (files.has(name)) throw new Error(`Character project ZIP contains a duplicate path: ${name}`);
    files.set(name, bytes.slice(dataStart, dataEnd)); cursor = dataEnd;
  }
  return files;
}

export function importCharacterProjectArchive(bytes: Uint8Array): GeneratedCharacterProject {
  const files = readStoredZip(bytes); const manifest = files.get("manifest.json"); if (!manifest) throw new Error("Character project ZIP is missing manifest.json");
  let input: unknown; try { input = JSON.parse(decoder.decode(manifest)) as unknown; } catch { throw new Error("Character project manifest is invalid JSON"); }
  const parsed = parseGeneratedCharacterProject(input); if (!parsed.success) throw new Error(parsed.message);
  const mime = (name: string): string => name.endsWith(".webp") ? "image/webp" : name.endsWith(".jpg") ? "image/jpeg" : "image/png";
  const dataUrl = (name: string, data: Uint8Array): string => { let binary = ""; data.forEach((value) => { binary += String.fromCharCode(value); }); return `data:${mime(name)};base64,${btoa(binary)}`; };
  const sourceEntry = [...files.entries()].find(([name]) => /^source\.(png|jpg|webp)$/.test(name));
  const partImages = new Map<string, string>();
  files.forEach((data, name) => { const match = name.match(/^parts\/(.+)\.(png|jpg|webp)$/); if (match) partImages.set(match[1], dataUrl(name, data)); });
  const sourceImage = parsed.data.sourceImage && sourceEntry ? { ...parsed.data.sourceImage, image: dataUrl(sourceEntry[0], sourceEntry[1]) } : parsed.data.sourceImage;
  const extractedParts = parsed.data.extractedParts.map((part) => ({ ...part, image: partImages.get(part.partId) ?? part.image }));
  const rigDefinition = parsed.data.rigDefinition ? { ...parsed.data.rigDefinition, attachments: parsed.data.rigDefinition.attachments.map((attachment) => ({ ...attachment, imagePath: partImages.get(attachment.id) ?? attachment.imagePath })) } : undefined;
  return { ...parsed.data, sourceImage, extractedParts, rigDefinition, skins: rigDefinition?.skins ?? parsed.data.skins };
}
