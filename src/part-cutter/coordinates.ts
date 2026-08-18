export type ViewportRect = Pick<DOMRect, "left" | "top" | "width" | "height">;

export function viewportPointToSource(clientX: number, clientY: number, rect: ViewportRect, sourceWidth: number, sourceHeight: number) {
  const width = Math.max(1, rect.width); const height = Math.max(1, rect.height);
  return {
    x: Math.max(0, Math.min(sourceWidth, (clientX - rect.left) / width * sourceWidth)),
    y: Math.max(0, Math.min(sourceHeight, (clientY - rect.top) / height * sourceHeight)),
  };
}
