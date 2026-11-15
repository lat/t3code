export type Rgb = [number, number, number]

export type DitherColor =
  | "green"
  | "blue"
  | "purple"
  | "pink"
  | "orange"
  | "red"
  | "grey"
  | "white"
  | "coral"

export type Seed = { fill: Rgb; line: Rgb; star: Rgb }

// Each seed: the area-fill hue, the bright series line, and the star sparkle.
export const PALETTE: Record<DitherColor, Seed> = {
  green: { fill: [40, 210, 110], line: [150, 255, 180], star: [200, 255, 220] },
  blue: { fill: [53, 143, 243], line: [150, 200, 255], star: [205, 228, 255] },
  purple: {
    fill: [150, 110, 255],
    line: [200, 175, 255],
    star: [225, 210, 255],
  },
  pink: { fill: [240, 90, 190], line: [255, 170, 220], star: [255, 205, 235] },
  orange: {
    fill: [255, 150, 50],
    line: [255, 195, 130],
    star: [255, 220, 175],
  },
  red: { fill: [240, 70, 70], line: [255, 150, 140], star: [255, 195, 185] },
  white: { fill: [222, 226, 238], line: [255, 255, 255], star: [255, 255, 255] },
  coral: { fill: [217, 119, 87], line: [240, 170, 145], star: [255, 210, 190] },
  // No-data: a muted grey so empty metrics read as "nothing here".
  grey: { fill: [92, 92, 100], line: [140, 140, 150], star: [165, 165, 175] },
}

export const rgb = ([r, g, b]: Rgb, k = 1, a = 1) =>
  `rgba(${Math.round(r * k)},${Math.round(g * k)},${Math.round(b * k)},${a})`

/** A palette name, or a raw fill whose line and star shades are lifted toward white. */
export type SeriesColor = DitherColor | Rgb

const lift = ([r, g, b]: Rgb, t: number): Rgb => [
  r + (255 - r) * t,
  g + (255 - g) * t,
  b + (255 - b) * t,
]

export const seedOfColor = (color: SeriesColor): Seed =>
  typeof color === "string"
    ? PALETTE[color]
    : { fill: color, line: lift(color, 0.45), star: lift(color, 0.7) }

export const isDitherColor = (value: unknown): value is DitherColor =>
  typeof value === "string" && value in PALETTE
