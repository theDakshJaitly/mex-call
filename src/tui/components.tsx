import React from "react";
import { Box, Text, Static } from "ink";
import type { StatusJson, TranscriptLine, ActivityLine } from "./store.js";

/** Presentational pieces for the Slice 1 live view. No state, no I/O. */

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

function duration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}

interface Badge {
  text: string;
  color: string;
}

function statusBadge(status: string | undefined, ended: boolean | undefined): Badge {
  if (ended) return { text: "⚪ ended", color: "gray" };
  switch (status) {
    case "recording":
      return { text: "🟢 recording", color: "green" };
    case "in_call":
      return { text: "🟢 in call", color: "green" };
    case "waiting_room":
      return { text: "🟡 waiting room", color: "yellow" };
    case "joining":
      return { text: "🟡 joining", color: "yellow" };
    case "failed":
      return { text: "🔴 failed", color: "red" };
    case "ending":
      return { text: "⏹ ending", color: "gray" };
    default:
      return { text: `⚪ ${status ?? "starting"}`, color: "gray" };
  }
}

export function StatusBar(props: {
  status: StatusJson | null;
  transport?: string;
  sttBadge?: string;
  ngrokReady: boolean;
  controlConnected: boolean;
  elapsedMs: number;
  width?: number;
}): React.ReactElement {
  const { status } = props;
  const badge = statusBadge(status?.status, status?.ended);
  const name = status?.callName ?? "mex-call";
  const counts = status?.counts;
  const meta: string[] = [];
  if (status?.meetUrl) meta.push(status.meetUrl.replace(/^https?:\/\//, ""));
  if (props.transport) meta.push(props.transport);
  if (props.sttBadge) meta.push(props.sttBadge);
  meta.push(`ngrok ${props.ngrokReady ? "✓" : "…"}`);
  meta.push(`ctrl ${props.controlConnected ? "✓" : "…"}`);
  if (counts) meta.push(`${counts.participants} ppl`);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} width={props.width}>
      <Box justifyContent="space-between">
        <Text bold>🎙 mex-call · {name}</Text>
        <Text color={badge.color}>
          {badge.text} · {duration(props.elapsedMs)}
        </Text>
      </Box>
      <Text dimColor>{meta.join("  ·  ")}</Text>
      {counts ? (
        <Text>
          <Text color="green">{counts.decisions}</Text> decisions ·{" "}
          <Text color="yellow">{counts.actionItems}</Text> actions ·{" "}
          <Text color="magenta">{counts.openQuestions}</Text> open qs
        </Text>
      ) : null}
    </Box>
  );
}

/**
 * Append-only transcript via <Static> (§8): Ink renders only newly-arrived lines
 * once into the scrollback and never re-paints the rest, so a long meeting never
 * thrashes the screen. Terminal scrollback IS the scroll here — an in-app scroll
 * viewport belongs to Slice 2, where the transcript becomes a bordered panel.
 */
export function Transcript({ lines }: { lines: TranscriptLine[] }): React.ReactElement {
  return (
    <Static items={lines}>
      {(line, index) => (
        <Box key={index}>
          <Text dimColor>[{line.ts}] </Text>
          <Text color="cyan">{line.speaker}: </Text>
          <Text>{line.text}</Text>
        </Box>
      )}
    </Static>
  );
}

/** A compact tail of the activity feed — the live channel where a type-to-Mex
 *  reply ("✅ replied: …") surfaces. The full Activity panel is Slice 2. */
export function ActivityTail({ activity }: { activity: ActivityLine[] }): React.ReactElement {
  const tail = activity.slice(-4);
  return (
    <Box flexDirection="column" paddingX={1}>
      {tail.length === 0 ? (
        <Text dimColor>(no activity yet)</Text>
      ) : (
        tail.map((a, i) => (
          <Text key={i} dimColor>
            {a.icon} {a.text}
          </Text>
        ))
      )}
    </Box>
  );
}
