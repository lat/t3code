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
// Dither art reads as stepped anyway, so a low frame rate keeps the drift cheap.
const FRAME_MS = 1000 / 12;

interface GlowFrame {
  readonly context: CanvasRenderingContext2D;
  readonly image: ImageData;
  readonly cols: number;
  readonly rows: number;
  readonly rim: readonly number[];
  readonly core: readonly number[];
  /** Per-column and per-row shimmer, refilled each frame; their product ripples the rim. */
  readonly waveX: Float32Array;
  readonly waveY: Float32Array;
}

function glowFrame(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  accent: Rgb,
  text: Rgb,
): GlowFrame | null {
  const context = canvas.getContext("2d");
  if (!context || width <= 0 || height <= 0) return null;
  const cols = Math.min(MAX_COLS, Math.max(8, Math.round(width / CELL_PX)));
  const rows = Math.min(MAX_ROWS, Math.max(8, Math.round(height / CELL_PX)));
  canvas.width = cols;
  canvas.height = rows;
  return {
    context,
    image: context.createImageData(cols, rows),
    cols,
    rows,
    rim: accent.map((channel) => channel * RIM_SHADE),
    core: text.map((channel, index) => (channel + accent[index]!) / 2),
    waveX: new Float32Array(cols),
    waveY: new Float32Array(rows),
  };
}

/** Paints the glow at `seconds`; at 0 it is the resting shape. */
function paintGlow(frame: GlowFrame, seconds: number) {
  const { context, image, cols, rows, rim, core, waveX, waveY } = frame;
  // The glow sits behind the headline and composer, above the dashboard, and wanders a little.
  const centerX = cols / 2 + cols * 0.025 * Math.sin(seconds * 0.11);
  const centerY = rows * 0.3 + rows * 0.02 * Math.sin(seconds * 0.07 + 1.3);
  const breath = 1 + 0.035 * Math.sin(seconds * 0.19);
  const radiusX = Math.max(cols * 0.48 * breath, 1);
  const radiusY = Math.max(rows * 0.5 * breath, 1);
  for (let x = 0; x < cols; x += 1) {
    waveX[x] = Math.sin(((x - centerX) / radiusX) * 3.1 + seconds * 0.35);
  }
  for (let y = 0; y < rows; y += 1) {
    waveY[y] = Math.sin(((y - centerY) / radiusY) * 4.3 - seconds * 0.27);
  }
  const data = image.data;
  for (let y = 0; y < rows; y += 1) {
    const dy = (y - centerY) / radiusY;
    const bayerRow = BAYER4[y & 3]!;
    for (let x = 0; x < cols; x += 1) {
      const offset = (y * cols + x) * 4;
      const dx = (x - centerX) / radiusX;
      const falloff = Math.max(0, 1 - Math.sqrt(dx * dx + dy * dy) + 0.03 * waveX[x]! * waveY[y]!);
      const density = falloff ** 1.7;
      if (density <= 0.002) {
        data[offset + 3] = 0;
        continue;
      }
      const lit = density * 0.9 > bayerRow[x & 3]!;
      const alpha = lit ? 0.22 + 0.6 * density : 0.1 * density;
      const blend = density ** 2;
      for (let channel = 0; channel < 3; channel += 1) {
        data[offset + channel] = rim[channel]! + (core[channel]! - rim[channel]!) * blend;
      }
      data[offset + 3] = Math.round(alpha * 255);
    }
  }
  context.putImageData(image, 0, 0);
}

/** Ordered-dither glow behind the new thread hero, in the theme's accent, drifting slowly. */
export function DitherGlow() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const accentKey = useThemeRgbKey(ACCENT_VARIABLES, "#4a68f0");
  const textKey = useThemeRgbKey(TEXT_VARIABLES, "#f2f4fa");
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- paints the canvas from its measured size and theme colors, repainting through a ResizeObserver and a throttled animation frame loop
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const accent = parseRgbKey(accentKey);
    const text = parseRgbKey(textKey);
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const started = performance.now();
    let frame: GlowFrame | null = null;
    let lastPaint = 0;
    let request = 0;
    const seconds = () => (reducedMotion.matches ? 0 : (performance.now() - started) / 1000);
    const resize = () => {
      const box = canvas.getBoundingClientRect();
      frame = glowFrame(canvas, box.width, box.height, accent, text);
      if (frame) paintGlow(frame, seconds());
    };
    const tick = (at: number) => {
      request = requestAnimationFrame(tick);
      if (reducedMotion.matches || !frame || at - lastPaint < FRAME_MS) return;
      lastPaint = at;
      paintGlow(frame, seconds());
    };
    resize();
    request = requestAnimationFrame(tick);
    const stopObserving = observeResize(canvas, resize);
    return () => {
      cancelAnimationFrame(request);
      stopObserving();
    };
  }, [accentKey, textKey]);
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      <div data-dither-glow-wash className="absolute inset-0" />
      <canvas ref={canvasRef} className="absolute inset-0 size-full [image-rendering:pixelated]" />
    </div>
  );
}
