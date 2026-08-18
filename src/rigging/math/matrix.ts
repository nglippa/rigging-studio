export type Point = { readonly x: number; readonly y: number };
export type Matrix2D = { readonly a: number; readonly b: number; readonly c: number; readonly d: number; readonly tx: number; readonly ty: number };
export type Transform2D = { readonly x: number; readonly y: number; readonly rotation: number; readonly scaleX: number; readonly scaleY: number };

export const IDENTITY_MATRIX: Matrix2D = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };

export function matrixFromTransform(transform: Transform2D): Matrix2D {
  const cosine = Math.cos(transform.rotation);
  const sine = Math.sin(transform.rotation);
  return {
    a: cosine * transform.scaleX, b: sine * transform.scaleX,
    c: -sine * transform.scaleY, d: cosine * transform.scaleY,
    tx: transform.x, ty: transform.y,
  };
}

export const multiplyMatrices = (parent: Matrix2D, local: Matrix2D): Matrix2D => ({
  a: parent.a * local.a + parent.c * local.b,
  b: parent.b * local.a + parent.d * local.b,
  c: parent.a * local.c + parent.c * local.d,
  d: parent.b * local.c + parent.d * local.d,
  tx: parent.a * local.tx + parent.c * local.ty + parent.tx,
  ty: parent.b * local.tx + parent.d * local.ty + parent.ty,
});

export const transformPoint = (matrix: Matrix2D, point: Point): Point => ({
  x: matrix.a * point.x + matrix.c * point.y + matrix.tx,
  y: matrix.b * point.x + matrix.d * point.y + matrix.ty,
});

export function invertMatrix(matrix: Matrix2D): Matrix2D | null {
  const determinant = matrix.a * matrix.d - matrix.b * matrix.c;
  if (Math.abs(determinant) < Number.EPSILON) return null;
  const inverse = 1 / determinant;
  return {
    a: matrix.d * inverse, b: -matrix.b * inverse, c: -matrix.c * inverse, d: matrix.a * inverse,
    tx: (matrix.c * matrix.ty - matrix.d * matrix.tx) * inverse,
    ty: (matrix.b * matrix.tx - matrix.a * matrix.ty) * inverse,
  };
}
