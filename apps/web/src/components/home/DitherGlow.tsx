import { useLayoutEffect, useRef } from "react";

import { BAYER4 } from "../dither-kit/pixel";
import { observeResize } from "../../lib/observeResize";
import {
  ACCENT_VARIABLES,
  parseRgbKey,
  type Rgb,
  TEXT_VARIABLES,
  useThemeRgbKey,
} from "./useThemeRgb";

const CELL_PX = 3;
const MAX_COLS = 900;
const MAX_ROWS = 600;
// Ordered-dither cells blend from a dimmed accent at the rim to the text color at the core.
const RIM_SHADE = 0.75;

function paintGlow(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  accent: Rgb,
  text: Rgb,
) {
  const context = canvas.getContext("2d");
  if (!context || width <= 0 || height <= 0) return;
  const cols = Math.min(MAX_COLS, Math.max(8, Math.round(width / CELL_PX)));
  const rows = Math.min(MAX_ROWS, Math.max(8, Math.round(height / CELL_PX)));
  canvas.width = cols;
  canvas.height = rows;
  const image = context.createImageData(cols, rows);
  const rim = accent.map((channel) => channel * RIM_SHADE);
  const core = text.map((channel, index) => (channel + accent[index]!) / 2);
  const centerX = cols / 2;
  // The glow sits behind the headline and composer, above the dashboard.
  const centerY = rows * 0.3;
  const radiusX = Math.max(cols * 0.48, 1);
  const radiusY = Math.max(rows * 0.5, 1);
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < cols; x += 1) {
      const dx = (x - centerX) / radiusX;
      const dy = (y - centerY) / radiusY;
      const falloff = Math.max(0, 1 - Math.sqrt(dx * dx + dy * dy));
      const density = falloff ** 1.7;
      if (density <= 0.002) continue;
      const lit = density * 0.9 > BAYER4[y & 3]![x & 3]!;
      const alpha = lit ? 0.22 + 0.6 * density : 0.1 * density;
      const blend = density ** 2;
      const offset = (y * cols + x) * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        image.data[offset + channel] = rim[channel]! + (core[channel]! - rim[channel]!) * blend;
      }
      image.data[offset + 3] = Math.round(alpha * 255);
    }
  }
  context.putImageData(image, 0, 0);
}

/** Static ordered-dither glow behind the new thread hero, in the theme's accent. */
export function DitherGlow() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const accentKey = useThemeRgbKey(ACCENT_VARIABLES, "#4a68f0");
  const textKey = useThemeRgbKey(TEXT_VARIABLES, "#f2f4fa");
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- paints the canvas from its measured size and theme colors, repainting through a ResizeObserver
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const accent = parseRgbKey(accentKey);
    const text = parseRgbKey(textKey);
    const paint = () => {
      const box = canvas.getBoundingClientRect();
      paintGlow(canvas, box.width, box.height, accent, text);
    };
    paint();
    return observeResize(canvas, paint);
  }, [accentKey, textKey]);
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      <div data-dither-glow-wash className="absolute inset-0" />
      <canvas ref={canvasRef} className="absolute inset-0 size-full [image-rendering:pixelated]" />
    </div>
  );
}
