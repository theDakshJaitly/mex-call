import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";

/**
 * "mex-Call" in figlet's Colossal FIGfont, embedded as a constant so there's no
 * runtime figlet dependency or font-file read. Rendered green with an optional
 * shimmer: a brighter-green band sweeps diagonally across the glyphs.
 */
const BANNER_LINES = [
  "                                       .d8888b.           888 888",
  "                                      d88P  Y88b          888 888",
  "                                      888    888          888 888",
  "88888b.d88b.   .d88b.  888  888       888         8888b.  888 888",
  "888 \"888 \"88b d8P  Y8b `Y8bd8P'       888            \"88b 888 888",
  "888  888  888 88888888   X88K  888888 888    888 .d888888 888 888",
  "888  888  888 Y8b.     .d8\"\"8b.       Y88b  d88P 888  888 888 888",
  "888  888  888  \"Y8888  888  888        \"Y8888P\"  \"Y888888 888 888",
];

/** Widest glyph row — callers use this to decide whether the banner fits. */
export const BANNER_WIDTH = Math.max(...BANNER_LINES.map((l) => l.length));

/** Column where "mex" ends and "-Call" begins (measured: "mex" is 31 cols wide
 *  in Colossal). Left of it is royal blue, right of it green; the split lands in
 *  the whitespace gap so the boundary is invisible. */
const SPLIT = 31;
const BLUE = "#4169E1"; // royal blue
const GREEN = "green";

/**
 * Only the blue wake word "mex" is alive: a horizontal wave of blue shades drifts
 * across it (gradient flow) while the whole word breathes brighter/dimmer (pulse).
 * "-Call" stays steady green — so the eye is drawn to the thing you actually say.
 */
const BLUE_PALETTE = ["#1E3A8A", "#2E4FC4", "#4169E1", "#5C7CFA", "#7CA0FF", "#A5C0FF"];
const FRAME_MS = 80;
const FLOW = 0.18; // gradient drift speed (per frame)
const RIPPLE = 0.45; // per-column wavelength of the flow
const SKEW = 0.15; // per-line phase offset → a slight diagonal
const PULSE = 0.06; // breathing speed

/** Color for one glyph cell. `frame === null` = static (royal-blue mex / green). */
function colorAt(col: number, line: number, frame: number | null): string {
  if (col >= SPLIT) return GREEN; // "-Call" is steady
  if (frame === null) return BLUE; // static mex
  const wave = Math.sin(col * RIPPLE + line * SKEW - frame * FLOW); // flowing gradient
  const breath = Math.sin(frame * PULSE); // global pulse
  const level = (wave * 0.6 + breath * 0.7 + 1.3) / 2.6; // combine → ~[0,1]
  const idx = Math.min(BLUE_PALETTE.length - 1, Math.max(0, Math.round(level * (BLUE_PALETTE.length - 1))));
  return BLUE_PALETTE[idx]!;
}

/** One glyph row. Consecutive same-color chars are coalesced into runs so a
 *  frame is a handful of <Text> nodes per line, not one per character. */
function BannerLine({ text, index, frame }: { text: string; index: number; frame: number | null }): React.ReactElement {
  const runs: { text: string; color: string }[] = [];
  for (let c = 0; c < text.length; c++) {
    const color = colorAt(c, index, frame);
    const last = runs[runs.length - 1];
    if (last && last.color === color) last.text += text[c];
    else runs.push({ text: text[c]!, color });
  }
  return (
    <Text>
      {runs.map((r, i) => (
        <Text key={i} color={r.color}>
          {r.text}
        </Text>
      ))}
    </Text>
  );
}

/** The mex-Call wordmark. `animate={false}` renders it static (royal-blue mex). */
export function Banner({ animate = true }: { animate?: boolean }): React.ReactElement {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!animate) return;
    const t = setInterval(() => setFrame((f) => (f + 1) % 100000), FRAME_MS);
    return () => clearInterval(t);
  }, [animate]);
  const phase = animate ? frame : null;
  return (
    <Box flexDirection="column">
      {BANNER_LINES.map((line, i) => (
        <BannerLine key={i} text={line} index={i} frame={phase} />
      ))}
    </Box>
  );
}
