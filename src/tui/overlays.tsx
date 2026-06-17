import React from "react";
import { Box, Text } from "ink";
import TextInput from "ink-text-input";
import type { WakeEventRecord } from "./store.js";
import { viewport } from "./panels.js";

/** One captured item, flattened across the three lists for the edit overlay. */
export interface CapturedItem {
  kind: "decision" | "action" | "question";
  /** Index WITHIN its kind's list — what edit-item needs. */
  index: number;
  text: string;
}

const KIND_COLOR: Record<CapturedItem["kind"], string> = {
  decision: "green",
  action: "yellow",
  question: "magenta",
};

/**
 * Full-screen overlay (Ink has no z-index; LiveView renders this INSTEAD of the
 * grid while active) to edit/remove captured items before finalize — the manual
 * correction path that pairs with transcript→decision promote.
 */
export function EditOverlay(props: {
  items: CapturedItem[];
  cursor: number;
  editing: boolean;
  buf: string;
  onBuf: (s: string) => void;
  onSubmit: (s: string) => void;
  width: number;
  height: number;
}): React.ReactElement {
  const rows = Math.max(3, props.height - 4);
  const { slice, hiddenAbove } = viewport(props.items, rows, Math.max(0, props.items.length - 1 - props.cursor));
  return (
    <Box flexDirection="column" width={props.width} height={props.height} borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">
        Edit captured items {hiddenAbove > 0 ? <Text dimColor>↑{hiddenAbove}</Text> : null}
      </Text>
      {props.items.length === 0 ? (
        <Text dimColor>(nothing captured yet)</Text>
      ) : (
        slice.map((item) => {
          const absIndex = props.items.indexOf(item);
          const selected = absIndex === props.cursor;
          if (selected && props.editing) {
            return (
              <Box key={`${item.kind}-${item.index}`}>
                <Text color={KIND_COLOR[item.kind]}>{item.kind[0]!.toUpperCase()} ✎ </Text>
                <TextInput value={props.buf} onChange={props.onBuf} onSubmit={props.onSubmit} />
              </Box>
            );
          }
          return (
            <Text key={`${item.kind}-${item.index}`} wrap="truncate-end">
              <Text color={selected ? "cyan" : undefined}>{selected ? "❯ " : "  "}</Text>
              <Text color={KIND_COLOR[item.kind]}>{item.kind[0]!.toUpperCase()} </Text>
              {item.text}
            </Text>
          );
        })
      )}
      <Box marginTop={1}>
        <Text dimColor>{props.editing ? "enter save · esc cancel" : "↑↓ move · [e]/enter edit · [x] remove · esc close"}</Text>
      </Box>
    </Box>
  );
}

/**
 * Wake-replay / "why didn't Mex respond?" overlay (§6). Read-only: shows what STT
 * actually heard around each wake, whether it was addressed, and how it
 * classified — turning a silent baffling failure into a legible one.
 */
export function WakeReplayOverlay(props: { events: WakeEventRecord[]; width: number; height: number }): React.ReactElement {
  const rows = Math.max(3, Math.floor((props.height - 4) / 2));
  const recent = props.events.slice(-rows).reverse(); // newest first
  return (
    <Box flexDirection="column" width={props.width} height={props.height} borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">
        Wake replay — what STT heard, and whether Mex responded
      </Text>
      {recent.length === 0 ? (
        <Text dimColor>(no wake attempts yet — say “Mex, …” or type a command)</Text>
      ) : (
        recent.map((e, i) => {
          const color = e.outcome === "addressed" ? "green" : e.outcome === "ignored" ? "yellow" : "red";
          const verdict =
            e.outcome === "addressed"
              ? `responded (${e.action})`
              : e.outcome === "ignored"
                ? "ignored — not classified as addressed to Mex"
                : "error — couldn't classify";
          return (
            <Box key={i} flexDirection="column">
              <Text wrap="truncate-end">
                <Text dimColor>{e.source === "typed" ? "⌨" : "🎙"} {e.speaker}: </Text>“{e.utterance}”
              </Text>
              <Text color={color} wrap="truncate-end">
                {"  "}↳ {verdict}
              </Text>
            </Box>
          );
        })
      )}
      <Box marginTop={1}>
        <Text dimColor>esc / [w] close</Text>
      </Box>
    </Box>
  );
}

export interface TimelineMarker {
  at: number;
  char: string;
  color: string;
}

/** A one-line "shape of the meeting" strip: markers placed across the call's
 *  duration (wake hits, logged items). Timestamps already exist on everything. */
export function TimelineScrubber(props: {
  width: number;
  startedAt: number;
  now: number;
  markers: TimelineMarker[];
}): React.ReactElement {
  const cells = Math.max(10, props.width - 4);
  const span = Math.max(1, props.now - props.startedAt);
  const chars = new Array<string>(cells).fill("·");
  const colors = new Array<string>(cells).fill("gray");
  for (const m of props.markers) {
    const pos = Math.min(cells - 1, Math.max(0, Math.floor(((m.at - props.startedAt) / span) * cells)));
    chars[pos] = m.char;
    colors[pos] = m.color;
  }
  return (
    <Box>
      <Text dimColor>⏱ </Text>
      <Text>
        {chars.map((c, i) => (
          <Text key={i} color={colors[i]}>
            {c}
          </Text>
        ))}
      </Text>
    </Box>
  );
}
