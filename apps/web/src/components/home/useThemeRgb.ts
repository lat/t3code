import { useSyncExternalStore } from "react";

export type Rgb = [number, number, number];

let probe: CanvasRenderingContext2D | null = null;

/** Resolves any CSS color (hex, rgb, oklch, color-mix) to sRGB through a 1px canvas. */
function toRgb(color: string): Rgb | null {
  probe ??= document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  if (!probe || !color) return null;
  probe.clearRect(0, 0, 1, 1);
  probe.fillStyle = "#000";
  probe.fillStyle = color;
  probe.fillRect(0, 0, 1, 1);
  const [r = 0, g = 0, b = 0] = probe.getImageData(0, 0, 1, 1).data;
  return [r, g, b];
}

function readVariable(names: readonly string[]): string {
  const style = getComputedStyle(document.documentElement);
  for (const name of names) {
    const value = style.getPropertyValue(name).trim();
    if (value) return value;
  }
  return "";
}

// Themes apply as inline custom properties and a data attribute on <html>.
function subscribe(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["style", "class", "data-theme-id"],
  });
  return () => observer.disconnect();
}

/**
 * The first defined CSS variable among `names`, as an `r,g,b` key that only changes when the
 * resolved color does. Parse it with {@link parseRgbKey}.
 */
export function useThemeRgbKey(names: readonly string[], fallback: string): string {
  return useSyncExternalStore(
    subscribe,
    () => (toRgb(readVariable(names)) ?? toRgb(fallback) ?? [0, 0, 0]).join(","),
    () => "128,128,128",
  );
}

export function parseRgbKey(key: string): Rgb {
  const [r = 0, g = 0, b = 0] = key.split(",").map(Number);
  return [r, g, b];
}

/** The theme's accent, falling back to the action color on themes without one. */
export const ACCENT_VARIABLES = ["--app-theme-accent", "--primary"] as const;
export const TEXT_VARIABLES = ["--foreground"] as const;
