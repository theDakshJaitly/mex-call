import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import TextInput from "ink-text-input";
import { CallController, type ControllerEvent } from "./controller.js";
import { useLiveState } from "./useLiveState.js";
import { StatusBar } from "./components.js";
import { TranscriptPanel, ActivityPanel, MemoryPanel, ParticipantsPanel, maxScroll } from "./panels.js";
import { EditOverlay, WakeReplayOverlay, TimelineScrubber, type CapturedItem, type TimelineMarker } from "./overlays.js";
import { usageFromState, buildMarkdownReport, usd } from "./meter.js";
import { bell, desktopNotify } from "./notify.js";
import type { LiveState } from "./store.js";

export interface LiveViewProps {
  repo: string;
  port: number;
  meetUrl: string;
  extraArgs: string[];
  /** Fires once when the spawned call exits (archived) — App shows the end screen. */
  onEnded: (data: { archivePath?: string }) => void;
}

type UiMode = "insert" | "command" | "search";
type PanelId = "transcript" | "memory" | "activity" | "participants";

const PANEL_ORDER: PanelId[] = ["transcript", "memory", "activity", "participants"];
const TYPED_MEX_RE = /^\s*mex\b/i;
const MIN_COLS = 70;
const MIN_ROWS = 18;
const STATUS_H = 5;
const FOOTER_H = 2;

interface Layout {
  ok: boolean;
  leftWidth: number;
  rightWidth: number;
  bodyHeight: number;
  memHeight: number;
  partHeight: number;
  activityHeight: number;
}

function computeLayout(cols: number, rows: number, present: number, left: number, extra: number): Layout {
  const activityHeight = Math.min(9, Math.max(5, Math.floor(rows * 0.22)));
  const bodyHeight = rows - STATUS_H - FOOTER_H - activityHeight - extra;
  if (cols < MIN_COLS || rows < MIN_ROWS || bodyHeight < 6) {
    return { ok: false, leftWidth: 0, rightWidth: 0, bodyHeight: 0, memHeight: 0, partHeight: 0, activityHeight: 0 };
  }
  const leftWidth = Math.floor(cols * 0.55);
  const rightWidth = cols - leftWidth;
  const partHeight = Math.min(Math.floor(bodyHeight * 0.4), Math.max(4, present + left + 3));
  const memHeight = bodyHeight - partHeight;
  return { ok: true, leftWidth, rightWidth, bodyHeight, memHeight, partHeight, activityHeight };
}

function clipboard(text: string): boolean {
  try {
    const r = spawnSync("pbcopy", { input: text });
    return !r.error && r.status === 0;
  } catch {
    return false;
  }
}

/** Map an "HH:MM:SS" activity clock to an epoch using the call's start date.
 *  Same-day approximation — fine for the scrubber's "shape of the meeting". */
function clockToEpoch(clock: string, ref: number): number {
  const [h, m, s] = clock.split(":").map(Number);
  const d = new Date(ref);
  d.setHours(h ?? 0, m ?? 0, s ?? 0, 0);
  return d.getTime();
}

/** The live command grid. Owns the controller (process model A) and all the
 *  in-call interaction; App routes to it and listens for `onEnded`. */
export function LiveView(props: LiveViewProps): React.ReactElement {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const liveDir = join(props.repo, ".mex", "meetings", "live");

  const [dims, setDims] = useState({ cols: stdout?.columns ?? 80, rows: stdout?.rows ?? 24 });
  useEffect(() => {
    if (!stdout) return;
    const onResize = () => setDims({ cols: stdout.columns, rows: stdout.rows });
    stdout.on("resize", onResize);
    return () => void stdout.off("resize", onResize);
  }, [stdout]);

  const [mode, setMode] = useState<UiMode>("insert");
  const [input, setInput] = useState("");
  const [search, setSearch] = useState("");
  const [focus, setFocus] = useState<PanelId>("transcript");
  const [scroll, setScroll] = useState<{ transcript: number; activity: number }>({ transcript: 0, activity: 0 });
  const [paused, setPaused] = useState(false);
  const [ngrokReady, setNgrokReady] = useState(false);
  const [controlConnected, setControlConnected] = useState(false);
  const [transport, setTransport] = useState<string>();
  const [sttBadge, setSttBadge] = useState<string>();
  const [sttWeak, setSttWeak] = useState(false);
  const [startError, setStartError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  // Slice 4: transcript→decision cursor, edit/wake overlays.
  const [cursor, setCursor] = useState(-1); // -1 = unset → bottom line
  const [overlay, setOverlay] = useState<null | "edit" | "wake">(null);
  const [editCursor, setEditCursor] = useState(0);
  const [editingItem, setEditingItem] = useState(false);
  const [editBuf, setEditBuf] = useState("");
  // Slice 5: latency HUD, notifications, error surfacing.
  const [timing, setTiming] = useState<{ count: number; sumMs: number; lastMs: number }>({ count: 0, sumMs: 0, lastMs: 0 });
  const [notify, setNotify] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);

  const controllerRef = useRef<CallController | null>(null);
  const archiveRef = useRef<string | undefined>(undefined);
  const live = useLiveState(liveDir);
  const frozenRef = useRef<LiveState | null>(null);
  const view = paused && frozenRef.current ? frozenRef.current : live;
  const elapsedMs = view.status?.elapsedMs ?? 0;

  // Filtered transcript (same predicate as the panel) — the source for the
  // promote cursor so its index lines up with what's rendered.
  const filteredTranscript = useMemo(() => {
    const ql = search.trim().toLowerCase();
    return ql
      ? view.transcript.filter((l) => l.text.toLowerCase().includes(ql) || l.speaker.toLowerCase().includes(ql))
      : view.transcript;
  }, [view.transcript, search]);
  const curIdx = cursor < 0 ? Math.max(0, filteredTranscript.length - 1) : Math.min(cursor, Math.max(0, filteredTranscript.length - 1));

  // Flattened captured items (per-kind index preserved) for the edit overlay.
  const captured: CapturedItem[] = useMemo(
    () => [
      ...view.decisions.map((text, index) => ({ kind: "decision" as const, index, text })),
      ...view.actionItems.map((text, index) => ({ kind: "action" as const, index, text })),
      ...view.openQuestions.map((text, index) => ({ kind: "question" as const, index, text })),
    ],
    [view.decisions, view.actionItems, view.openQuestions]
  );

  // Scrubber markers: wake hits (epoch) + logged/repo-action activity (clock→epoch).
  const startedAt = view.status?.startedAt ?? Date.now();
  const nowTs = view.status?.updatedAt ?? Date.now();
  const markers: TimelineMarker[] = useMemo(() => {
    const wake = view.wakeEvents.map((w) => ({
      at: w.ts,
      char: "▲",
      color: w.outcome === "addressed" ? "cyan" : w.outcome === "ignored" ? "yellow" : "red",
    }));
    const acts = view.activity
      .filter((a) => a.icon === "📝" || a.icon === "🔧")
      .map((a) => ({ at: clockToEpoch(a.ts, startedAt), char: "◆", color: a.icon === "📝" ? "green" : "magenta" }));
    return [...wake, ...acts];
  }, [view.wakeEvents, view.activity, startedAt]);

  const usingAssembly = /assembly/i.test(sttBadge ?? "");
  const usage = usageFromState(view, usingAssembly);

  // Notifications (off by default): bell + desktop ping on a new Mex reply or a
  // new participant. A baseline ref avoids firing a burst for pre-existing state.
  const notifyBaseRef = useRef<{ wakeAddressed: number; present: number } | null>(null);
  useEffect(() => {
    const wakeAddressed = view.wakeEvents.filter((w) => w.outcome === "addressed").length;
    const present = view.participants.present.length;
    const base = notifyBaseRef.current;
    if (base && notify) {
      if (wakeAddressed > base.wakeAddressed) {
        bell();
        desktopNotify("mex-call", "Mex responded");
      }
      if (present > base.present) {
        bell();
        desktopNotify("mex-call", "someone joined the call");
      }
    }
    notifyBaseRef.current = { wakeAddressed, present };
  }, [view.wakeEvents, view.participants, notify]);

  const onEvent = useCallback(
    (ev: ControllerEvent) => {
      if (ev.type === "log") {
        const t = /transport:\s*(\w+)/i.exec(ev.line);
        if (t) setTransport(t[1]!.toLowerCase());
        const stt = /\bstt:\s*([^(]+)/i.exec(ev.line);
        if (stt) setSttBadge(stt[1]!.trim());
        if (/recall built-in|recallai_streaming/i.test(ev.line)) setSttWeak(true);
        if (/native assemblyai|assemblyai v3/i.test(ev.line)) setSttWeak(false);
        if (/ngrok ready|tunnel ready/i.test(ev.line)) setNgrokReady(true);
        if (/control channel connected/i.test(ev.line)) setControlConnected(true);
      } else if (ev.type === "archived") {
        archiveRef.current = ev.path;
      } else if (ev.type === "timing") {
        setTiming((t) => ({ count: t.count + 1, sumMs: t.sumMs + ev.totalMs, lastMs: ev.totalMs }));
      } else if (ev.type === "error") {
        setErrors((e) => [...e.slice(-19), ev.line]);
      } else if (ev.type === "exit") {
        props.onEnded({ archivePath: archiveRef.current });
      }
    },
    [props]
  );

  useEffect(() => {
    const controller = new CallController(onEvent);
    controllerRef.current = controller;
    let cancelled = false;
    controller
      .start({ meetUrl: props.meetUrl, repo: props.repo, port: props.port, extraArgs: props.extraArgs })
      .then(() => {
        if (!cancelled) setControlConnected(controller.connected);
      })
      .catch((err: unknown) => {
        if (!cancelled) setStartError((err as Error).message);
      });
    return () => {
      cancelled = true;
      controller.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const flash = (msg: string) => {
    setNotice(msg);
    setTimeout(() => setNotice((n) => (n === msg ? undefined : n)), 2500);
  };

  const doLeave = useCallback(() => {
    flash("leaving — archiving the call…");
    void controllerRef.current?.leave();
  }, []);
  const doSummary = useCallback(() => {
    flash("force-summary requested");
    void controllerRef.current?.forceSummary();
  }, []);
  const quit = useCallback(() => {
    void controllerRef.current?.leave().catch(() => {});
    controllerRef.current?.dispose();
    exit();
  }, [exit]);

  const togglePause = useCallback(() => {
    setPaused((p) => {
      frozenRef.current = !p ? live : null;
      flash(!p ? "paused (live stream frozen)" : "resumed");
      return !p;
    });
  }, [live]);

  const scrollFocused = useCallback(
    (delta: number) => {
      setScroll((s) => {
        if (focus === "transcript")
          return { ...s, transcript: Math.min(Math.max(0, s.transcript + delta), maxScroll(view.transcript.length, 1)) };
        if (focus === "activity")
          return { ...s, activity: Math.min(Math.max(0, s.activity + delta), maxScroll(view.activity.length, 1)) };
        return s;
      });
    },
    [focus, view.transcript.length, view.activity.length]
  );

  const copyFocused = useCallback(() => {
    let text = "";
    if (focus === "transcript") text = view.transcript.map((l) => l.raw).join("\n");
    else if (focus === "activity") text = view.activity.map((a) => a.raw).join("\n");
    else if (focus === "participants")
      text = [...view.participants.present, ...view.participants.left.map((n) => `${n} (left)`)].join("\n");
    else
      text = [
        view.summary && `## Summary\n${view.summary}`,
        view.decisions.length && `## Decisions\n${view.decisions.map((d) => `- ${d}`).join("\n")}`,
        view.actionItems.length && `## Action items\n${view.actionItems.map((d) => `- ${d}`).join("\n")}`,
        view.openQuestions.length && `## Open questions\n${view.openQuestions.map((d) => `- ${d}`).join("\n")}`,
      ]
        .filter(Boolean)
        .join("\n\n");
    flash(text && clipboard(text) ? `copied ${focus} to clipboard` : "nothing to copy / clipboard unavailable");
  }, [focus, view]);

  const toggleNotify = useCallback(() => {
    setNotify((n) => {
      flash(!n ? "notifications on (bell + desktop)" : "notifications off");
      return !n;
    });
  }, []);

  const exportMarkdown = useCallback(() => {
    const md = buildMarkdownReport(view);
    flash(clipboard(md) ? "copied call as markdown" : "clipboard unavailable");
  }, [view]);

  const moveCursor = useCallback(
    (delta: number) => {
      const len = filteredTranscript.length;
      if (len === 0) return;
      const base = cursor < 0 ? len - 1 : cursor;
      setCursor(Math.min(Math.max(0, base + delta), len - 1));
    },
    [cursor, filteredTranscript.length]
  );

  const promoteCursor = useCallback(
    (kind: "decision" | "action" | "question") => {
      const line = filteredTranscript[curIdx];
      if (!line) return;
      flash(`promoted to ${kind}: ${line.text.slice(0, 50)}`);
      void controllerRef.current?.promote(line.text, kind);
    },
    [filteredTranscript, curIdx]
  );

  const submitEdit = useCallback(
    (value: string) => {
      const it = captured[editCursor];
      setEditingItem(false);
      if (it) {
        flash(`edited ${it.kind}`);
        void controllerRef.current?.editItem(it.kind, it.index, value.trim());
      }
    },
    [captured, editCursor]
  );

  const removeAtEditCursor = useCallback(() => {
    const it = captured[editCursor];
    if (it) {
      flash(`removed ${it.kind}`);
      void controllerRef.current?.editItem(it.kind, it.index, "");
    }
  }, [captured, editCursor]);

  const submit = useCallback(
    (value: string) => {
      const v = value.trim();
      setInput("");
      if (!v) return;
      const lower = v.toLowerCase();
      if (lower === "/leave" || lower === "/l") return doLeave();
      if (lower === "/summary" || lower === "/s") return doSummary();
      if (lower === "/quit" || lower === "/q") return quit();
      if (TYPED_MEX_RE.test(v)) {
        flash(`→ Mex: ${v.slice(0, 60)}`);
        void controllerRef.current?.typeToMex(v);
      } else {
        flash(`→ chat: ${v.slice(0, 60)}`);
        void controllerRef.current?.sendChat(v);
      }
    },
    [doLeave, doSummary, quit]
  );

  useInput((inputCh, key) => {
    if (key.ctrl && inputCh === "c") return quit();

    // Overlays take over input while open (rendered instead of the grid).
    if (overlay === "edit") {
      if (editingItem) {
        if (key.escape) setEditingItem(false);
        return; // the TextInput handles the rest
      }
      if (key.escape || inputCh === "q") return setOverlay(null);
      if (key.upArrow) setEditCursor((c) => Math.max(0, c - 1));
      else if (key.downArrow) setEditCursor((c) => Math.min(Math.max(0, captured.length - 1), c + 1));
      else if (inputCh === "e" || key.return) {
        const it = captured[editCursor];
        if (it) {
          setEditBuf(it.text);
          setEditingItem(true);
        }
      } else if (inputCh === "x") removeAtEditCursor();
      return;
    }
    if (overlay === "wake") {
      if (key.escape || inputCh === "w" || inputCh === "q") setOverlay(null);
      return;
    }

    if (mode === "insert") {
      if (key.escape) setMode("command");
      return;
    }
    if (mode === "search") {
      if (key.escape) {
        setSearch("");
        setMode("command");
      }
      return;
    }
    // command mode
    if (inputCh === "i" || key.return) setMode("insert");
    else if (inputCh === "/") setMode("search");
    else if (key.tab) setFocus((f) => PANEL_ORDER[(PANEL_ORDER.indexOf(f) + 1) % PANEL_ORDER.length]!);
    else if (key.upArrow) focus === "transcript" ? moveCursor(-1) : scrollFocused(+1);
    else if (key.downArrow) focus === "transcript" ? moveCursor(+1) : scrollFocused(-1);
    else if (inputCh === "p") togglePause();
    else if (inputCh === "c") copyFocused();
    else if (inputCh === "m") exportMarkdown();
    else if (inputCh === "n") toggleNotify();
    else if (inputCh === "e") {
      setEditCursor(0);
      setEditingItem(false);
      setOverlay("edit");
    } else if (inputCh === "w") setOverlay("wake");
    else if (focus === "transcript" && (inputCh === "d" || inputCh === "a" || inputCh === "o"))
      promoteCursor(inputCh === "d" ? "decision" : inputCh === "a" ? "action" : "question");
    else if (inputCh === "l") doLeave();
    else if (inputCh === "s") doSummary();
    else if (inputCh === "q") quit();
  });

  // Overlays render INSTEAD of the grid (Ink has no z-index).
  if (overlay === "edit") {
    return (
      <EditOverlay
        items={captured}
        cursor={editCursor}
        editing={editingItem}
        buf={editBuf}
        onBuf={setEditBuf}
        onSubmit={submitEdit}
        width={dims.cols}
        height={dims.rows}
      />
    );
  }
  if (overlay === "wake") {
    return <WakeReplayOverlay events={view.wakeEvents} width={dims.cols} height={dims.rows} />;
  }

  const latestError = errors[errors.length - 1];
  const warnLine = sttWeak || startError || latestError;
  const avgS = timing.count ? (timing.sumMs / timing.count / 1000).toFixed(1) : "—";
  const lastS = timing.lastMs ? (timing.lastMs / 1000).toFixed(1) : "—";
  const layout = computeLayout(
    dims.cols,
    dims.rows,
    view.participants.present.length,
    view.participants.left.length,
    (warnLine ? 1 : 0) + (mode === "search" ? 1 : 0) + 2 // +1 timeline scrubber, +1 latency/cost HUD
  );

  if (!layout.ok) {
    return (
      <Box flexDirection="column">
        <Text>
          Terminal too small for the grid ({dims.cols}×{dims.rows}). Need ≥ {MIN_COLS}×{MIN_ROWS}.
        </Text>
        <Text dimColor>Resize, or run `mex-call join &lt;link&gt;` headless.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <StatusBar
        status={view.status}
        transport={transport}
        sttBadge={sttBadge}
        ngrokReady={ngrokReady}
        controlConnected={controlConnected}
        elapsedMs={elapsedMs}
        width={dims.cols}
      />
      <Box justifyContent="space-between">
        <Text dimColor>
          ⚡ reply ~avg <Text color="cyan">{avgS}s</Text> last {lastS}s · 💰 ~<Text color="cyan">{usd(usage.totalUsd)}</Text>{" "}
          ({usage.brainCalls} calls{usingAssembly ? ` + ${usage.sttMinutes.toFixed(1)}m STT` : ""})
        </Text>
        <Text dimColor>🔔 {notify ? <Text color="green">on</Text> : "off"}</Text>
      </Box>
      {latestError ? (
        <Text color="red" wrap="truncate-end">
          ⚠ {errors.length > 1 ? `${errors.length} errors · ` : ""}
          {latestError}
        </Text>
      ) : sttWeak ? (
        <Text color="red" wrap="truncate-end">
          ⚠ Recall built-in STT — wake-word (“Mex”) detection unreliable; set ASSEMBLYAI_API_KEY and rejoin.
        </Text>
      ) : startError ? (
        <Text color="red" wrap="truncate-end">
          ⚠ {startError}
        </Text>
      ) : null}

      <Box>
        <TranscriptPanel
          lines={view.transcript}
          width={layout.leftWidth}
          height={layout.bodyHeight}
          focused={focus === "transcript"}
          scroll={scroll.transcript}
          query={search || undefined}
          cursor={focus === "transcript" ? curIdx : undefined}
        />
        <Box flexDirection="column" width={layout.rightWidth}>
          <MemoryPanel
            summary={view.summary}
            decisions={view.decisions}
            actionItems={view.actionItems}
            openQuestions={view.openQuestions}
            width={layout.rightWidth}
            height={layout.memHeight}
            focused={focus === "memory"}
            scroll={0}
          />
          <ParticipantsPanel
            participants={view.participants}
            width={layout.rightWidth}
            height={layout.partHeight}
            focused={focus === "participants"}
          />
        </Box>
      </Box>

      <TimelineScrubber width={dims.cols} startedAt={startedAt} now={nowTs} markers={markers} />

      <ActivityPanel
        activity={view.activity}
        width={dims.cols}
        height={layout.activityHeight}
        focused={focus === "activity"}
        scroll={scroll.activity}
      />

      {mode === "search" ? (
        <Box>
          <Text color="yellow">/ </Text>
          <TextInput value={search} onChange={setSearch} onSubmit={() => setMode("command")} placeholder="filter transcript…" />
        </Box>
      ) : null}

      <Box>
        <Text color={mode === "insert" ? "cyan" : "gray"}>{mode === "insert" ? "› " : "— "}</Text>
        {mode === "insert" ? (
          <TextInput
            value={input}
            onChange={setInput}
            onSubmit={submit}
            placeholder='"Mex, …" command · chat message · /leave /summary /quit'
          />
        ) : (
          <Text dimColor>
            cmd {paused ? "· ⏸ PAUSED " : ""}· <Text color="cyan">{focus}</Text> — [i]type [tab]panel [↑↓]
            {focus === "transcript" ? "cursor [d/a/o]promote" : "scroll"} [/]search [p]ause [c]opy [m]d [n]otify [e]dit
            [w]ake [l]eave [s]ummary [q]uit
          </Text>
        )}
      </Box>
      <Box justifyContent="space-between">
        <Text dimColor>
          {mode === "insert" ? "[esc] command mode" : "[i] insert"} ·{controlConnected ? " ctrl ✓" : " connecting…"}
        </Text>
        {notice ? <Text color="green">{notice}</Text> : <Text> </Text>}
      </Box>
    </Box>
  );
}
