import React from "react";
import { Box, Text } from "ink";
import type { TranscriptLine, ActivityLine, ParticipantsState } from "./store.js";

/**
 * Slice 2 panels for the live command grid. These are bounded REACTIVE viewports,
 * not <Static>. Rationale (TUI_EXECUTION_PLAN §8 explicitly says "decide the
 * boundary deliberately"): Ink's <Static> paints full-width above the live frame
 * and cannot be confined to a bordered grid cell, so it's incompatible with the
 * panel-grid layout Slice 2 requires. We instead render only the visible window
 * (last N rows) per panel — bounded work per frame — and the store is mtime-gated,
 * so the §8 concern (thrashing by re-painting a huge log every frame) doesn't
 * apply. The full-stream <Static> transcript from Slice 1 still exists for a
 * future full-screen "transcript focus" view.
 */

/** Bottom-anchored slice of `items` that fits `height` rows, honoring a scroll
 *  offset measured from the bottom (0 = stick to latest). */
export function viewport<T>(
  items: T[],
  height: number,
  offsetFromBottom: number
): { slice: T[]; hiddenAbove: number; hiddenBelow: number } {
  const h = Math.max(1, height);
  const maxOffset = Math.max(0, items.length - h);
  const off = Math.min(Math.max(0, offsetFromBottom), maxOffset);
  const end = items.length - off;
  const start = Math.max(0, end - h);
  return { slice: items.slice(start, end), hiddenAbove: start, hiddenBelow: items.length - end };
}

/** Clamp a scroll offset to the valid range for the current item count + height. */
export function maxScroll(itemCount: number, height: number): number {
  return Math.max(0, itemCount - Math.max(1, height));
}

interface PanelProps {
  title: string;
  width: number;
  /** Outer height including border + title row. */
  height: number;
  focused?: boolean;
  count?: number;
  subtitle?: string;
  children: React.ReactNode;
}

/** Bordered panel with a title row; content is clipped to its row budget so a
 *  panel can never overflow and break the grid. */
export function Panel(props: PanelProps): React.ReactElement {
  const innerHeight = Math.max(1, props.height - 3); // 2 border rows + 1 title row
  return (
    <Box
      flexDirection="column"
      width={props.width}
      height={props.height}
      borderStyle="round"
      borderColor={props.focused ? "cyan" : "gray"}
      paddingX={1}
      overflow="hidden"
    >
      <Box>
        <Text bold color={props.focused ? "cyan" : undefined}>
          {props.title}
        </Text>
        {props.count != null ? <Text dimColor> ({props.count})</Text> : null}
        {props.subtitle ? <Text dimColor> {props.subtitle}</Text> : null}
      </Box>
      <Box flexDirection="column" height={innerHeight} overflow="hidden">
        {props.children}
      </Box>
    </Box>
  );
}

export function TranscriptPanel(props: {
  lines: TranscriptLine[];
  width: number;
  height: number;
  focused: boolean;
  scroll: number;
  query?: string;
  /** Absolute index into the FILTERED lines to highlight (transcript→decision
   *  promote cursor). When set, the viewport keeps it visible. */
  cursor?: number;
}): React.ReactElement {
  const q = props.query?.trim().toLowerCase();
  const lines = q
    ? props.lines.filter((l) => l.text.toLowerCase().includes(q) || l.speaker.toLowerCase().includes(q))
    : props.lines;
  const rows = Math.max(1, props.height - 3);
  const len = lines.length;
  // When a cursor is active, center the window on it; otherwise bottom-anchor
  // with the scroll offset (Slice 2 behaviour).
  let start: number;
  if (props.cursor != null) {
    start = Math.min(Math.max(0, props.cursor - Math.floor(rows / 2)), Math.max(0, len - rows));
  } else {
    const off = Math.min(Math.max(0, props.scroll), Math.max(0, len - rows));
    start = Math.max(0, len - rows - off);
  }
  const slice = lines.slice(start, start + rows);
  const hiddenAbove = start;
  const subtitle =
    (q ? `/${props.query} · ${len} hits` : "") + (hiddenAbove > 0 ? ` ↑${hiddenAbove}` : "");
  return (
    <Panel
      title="TRANSCRIPT"
      width={props.width}
      height={props.height}
      focused={props.focused}
      subtitle={subtitle || undefined}
    >
      {slice.length === 0 ? (
        <Text dimColor>{q ? "(no matches)" : "(waiting for speech…)"}</Text>
      ) : (
        slice.map((l, i) => {
          const selected = props.cursor != null && start + i === props.cursor;
          return (
            <Text key={i} wrap="truncate-end">
              <Text color={selected ? "cyan" : undefined}>{selected ? "▸ " : ""}</Text>
              <Text dimColor>[{l.ts}] </Text>
              <Text color="cyan">{l.speaker}: </Text>
              <Text inverse={selected}>{l.text}</Text>
            </Text>
          );
        })
      )}
    </Panel>
  );
}

const MEX_ICON_COLOR: Record<string, string> = {
  "🎙": "cyan",
  "⌨️": "cyan",
  "✅": "green",
  "📝": "yellow",
  "🔧": "magenta",
  "💬": "blue",
};

export function ActivityPanel(props: {
  activity: ActivityLine[];
  width: number;
  height: number;
  focused: boolean;
  scroll: number;
}): React.ReactElement {
  const rows = Math.max(1, props.height - 3);
  const { slice, hiddenAbove } = viewport(props.activity, rows, props.scroll);
  return (
    <Panel
      title="ACTIVITY"
      width={props.width}
      height={props.height}
      focused={props.focused}
      subtitle={hiddenAbove > 0 ? `↑${hiddenAbove}` : undefined}
    >
      {slice.length === 0 ? (
        <Text dimColor>(nothing yet)</Text>
      ) : (
        slice.map((a, i) => (
          <Text key={i} wrap="truncate-end">
            <Text dimColor>{a.ts} </Text>
            <Text color={MEX_ICON_COLOR[a.icon]}>{a.icon} </Text>
            {a.text}
          </Text>
        ))
      )}
    </Panel>
  );
}

function ListSection(props: { label: string; color: string; items: string[]; max: number }): React.ReactElement {
  const tail = props.items.slice(-props.max);
  const more = props.items.length - tail.length;
  return (
    <Box flexDirection="column">
      <Text color={props.color} bold>
        {props.label} ({props.items.length})
      </Text>
      {more > 0 ? <Text dimColor> …{more} earlier</Text> : null}
      {tail.map((it, i) => (
        <Text key={i} wrap="truncate-end">
          {" "}
          • {it}
        </Text>
      ))}
    </Box>
  );
}

export function MemoryPanel(props: {
  summary: string;
  decisions: string[];
  actionItems: string[];
  openQuestions: string[];
  width: number;
  height: number;
  focused: boolean;
  scroll: number;
}): React.ReactElement {
  // Budget: a 2-row summary blurb, then the three lists share the rest. Outer
  // clipping is the safety net if a list runs long.
  const inner = Math.max(1, props.height - 3);
  const perList = Math.max(1, Math.floor((inner - 3) / 3));
  return (
    <Panel title="MEMORY" width={props.width} height={props.height} focused={props.focused}>
      <Box height={2} overflow="hidden" marginBottom={inner > 6 ? 1 : 0}>
        <Text dimColor wrap="truncate-end">
          {props.summary || "(summary building…)"}
        </Text>
      </Box>
      <ListSection label="Decisions" color="green" items={props.decisions} max={perList} />
      <ListSection label="Actions" color="yellow" items={props.actionItems} max={perList} />
      <ListSection label="Open Qs" color="magenta" items={props.openQuestions} max={perList} />
    </Panel>
  );
}

export function ParticipantsPanel(props: {
  participants: ParticipantsState;
  width: number;
  height: number;
  focused: boolean;
}): React.ReactElement {
  const { present, left } = props.participants;
  return (
    <Panel
      title="PARTICIPANTS"
      width={props.width}
      height={props.height}
      focused={props.focused}
      count={present.length}
    >
      {present.length === 0 ? (
        <Text dimColor>(waiting…)</Text>
      ) : (
        present.map((n, i) => (
          <Text key={i} wrap="truncate-end">
            <Text color="green">● </Text>
            {n}
          </Text>
        ))
      )}
      {left.length > 0 ? (
        <Text dimColor wrap="truncate-end">
          left: {left.join(", ")}
        </Text>
      ) : null}
    </Panel>
  );
}
