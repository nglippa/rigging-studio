const DEGREES_PER_CIRCLE = 360;
const RADIANS_PER_CIRCLE = Math.PI * 2;

export const degreesToRadians = (degrees: number): number => degrees * RADIANS_PER_CIRCLE / DEGREES_PER_CIRCLE;
export const radiansToDegrees = (radians: number): number => radians * DEGREES_PER_CIRCLE / RADIANS_PER_CIRCLE;
