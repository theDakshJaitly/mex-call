import React, { useCallback, useMemo, useState } from "react";
import { spawnSync } from "node:child_process";
import { Box, Text, useInput, useStdout } from "ink";
import TextInput from "ink-text-input";
import { buildMarkdownReport } from "./meter.js";
import { Banner, BANNER_WIDTH } from "./banner.js";
import {
  gatherDoctorReport,
  smokeTestAssemblyAi,
  readMeetingEventsForCall,
  listArchivedCalls,
  scaffoldDiff,
  type Check,
} from "./doctor.js";
import { LiveStore } from "./store.js";
import { loadTuiDefaults, saveTuiDefaults, tuiConfigPath, type TuiDefaults } from "./config.js";

/** Config the Launch screen produces; App turns it into `join` flags. */
export interface LaunchConfig {
  meetUrl: string;
  transport: "recall" | "vexa";
  provider: string; // "" = default resolution
  actions: boolean;
  botName?: string;
}

// --- Reusable arrow-key menu -------------------------------------------------

export interface MenuItem {
  label: string;
  value: string;
  hint?: string;
}

export function Menu(props: {
  items: MenuItem[];
  onSelect: (value: string) => void;
  isActive?: boolean;
}): React.ReactElement {
  const { items } = props;
  const [index, setIndex] = useState(0);
  const active = props.isActive ?? true;
  useInput(
    (input, key) => {
      if (key.upArrow) setIndex((i) => (i - 1 + items.length) % items.length);
      else if (key.downArrow) setIndex((i) => (i + 1) % items.length);
      else if (key.return) props.onSelect(items[Math.min(index, items.length - 1)]!.value);
      else if (input) {
        const hit = items.findIndex((it) => it.label.toLowerCase().startsWith(input.toLowerCase()));
        if (hit >= 0) setIndex(hit);
      }
    },
    { isActive: active }
  );
  return (
    <Box flexDirection="column">
      {items.map((it, i) => (
        <Text key={it.value} color={i === index ? "cyan" : undefined}>
          {i === index ? "❯ " : "  "}
          {it.label}
          {it.hint ? <Text dimColor> — {it.hint}</Text> : null}
        </Text>
      ))}
    </Box>
  );
}

// --- Home --------------------------------------------------------------------

export function Home(props: { onSelect: (v: string) => void }): React.ReactElement {
  const { stdout } = useStdout();
  const wideEnough = (stdout?.columns ?? 80) >= BANNER_WIDTH + 2;
  return (
    <Box flexDirection="column" paddingX={1}>
      {wideEnough ? (
        <Banner />
      ) : (
        <Text bold>
          🎙  <Text color="#4169E1">mex</Text>
          <Text color="green">-Call</Text>
        </Text>
      )}
      <Text dimColor>live meeting agent → structured, agent-readable repo memory</Text>
      <Box marginTop={1}>
        <Menu
          onSelect={props.onSelect}
          items={[
            { label: "Join a meeting", value: "join", hint: "paste a Meet link" },
            { label: "Doctor / pre-flight", value: "doctor", hint: "check keys, STT, brain" },
            { label: "Recent calls", value: "recent", hint: "browse archived calls" },
            { label: "Settings", value: "settings", hint: "config (read-only for now)" },
            { label: "Quit", value: "quit" },
          ]}
        />
      </Box>
      <Box marginTop={1}>
        <Text dimColor>↑↓ move · enter select · Ctrl+C quit</Text>
      </Box>
    </Box>
  );
}

// --- Doctor ------------------------------------------------------------------

function checkIcon(level: Check["level"]): React.ReactElement {
  if (level === "pass") return <Text color="green">✓</Text>;
  if (level === "warn") return <Text color="yellow">⚠</Text>;
  return <Text color="red">✗</Text>;
}

export function DoctorScreen(props: {
  repo: string;
  onBack: () => void;
  onProceed: () => void;
}): React.ReactElement {
  const [report] = useState(() => gatherDoctorReport(props.repo));
  const [smoke, setSmoke] = useState<{ running?: boolean; ok?: boolean; detail?: string }>();

  const runSmoke = useCallback(async () => {
    const key = process.env.ASSEMBLYAI_API_KEY;
    if (!key) {
      setSmoke({ ok: false, detail: "no ASSEMBLYAI_API_KEY — set it for the reliable STT path" });
      return;
    }
    setSmoke({ running: true });
    const r = await smokeTestAssemblyAi(key);
    setSmoke(r);
  }, []);

  useInput((input, key) => {
    if (key.escape || input === "b") props.onBack();
    else if (input === "t") void runSmoke();
    else if (input === "j" || key.return) props.onProceed();
  });

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color="cyan">
        Doctor — pre-flight
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {report.checks.map((c, i) => (
          <Text key={i}>
            {checkIcon(c.level)} <Text bold>{c.label}</Text> <Text dimColor>— {c.detail}</Text>
          </Text>
        ))}
      </Box>

      {report.sttWeak ? (
        <Box marginTop={1} borderStyle="round" borderColor="red" paddingX={1} flexDirection="column">
          <Text color="red" bold>
            ⚠ Wake-word detection will be unreliable on this run.
          </Text>
          <Text>
            Recall's built-in STT frequently mis-hears “Mex”. Set <Text bold>ASSEMBLYAI_API_KEY</Text> (repo .env or
            ~/.mex-call.env) and it auto-switches to the accurate path. Joining anyway is allowed, but you've been warned.
          </Text>
        </Box>
      ) : null}

      <Box marginTop={1} flexDirection="column">
        <Text>
          STT connectivity smoke test:{" "}
          {smoke?.running ? (
            <Text color="yellow">testing…</Text>
          ) : smoke ? (
            smoke.ok ? (
              <Text color="green">✓ {smoke.detail}</Text>
            ) : (
              <Text color="red">✗ {smoke.detail}</Text>
            )
          ) : (
            <Text dimColor>press [t] to test the configured AssemblyAI key</Text>
          )}
        </Text>
        <Text dimColor>(full “say ‘Mex, test’” mic loopback comes later — needs local mic capture)</Text>
      </Box>

      <Box marginTop={1}>
        <Text>
          {report.greenLight ? (
            <Text color="green">● ready to join</Text>
          ) : (
            <Text color="red">● not ready — fix the ✗ items above</Text>
          )}
        </Text>
      </Box>
      <Text dimColor>[t] STT test · [j]/enter join · [b]/esc back</Text>
    </Box>
  );
}

// --- Launch ------------------------------------------------------------------

const PROVIDERS = ["", "native", "assembly", "recallai_streaming", "meeting_captions"];
const MODELS = ["", "sonnet", "opus"];

export function LaunchScreen(props: {
  repo: string;
  onLaunch: (cfg: LaunchConfig) => void;
  onBack: () => void;
}): React.ReactElement {
  const defaults = useMemo(() => loadTuiDefaults(), []);
  const [step, setStep] = useState<"link" | "options">("link");
  const [meetUrl, setMeetUrl] = useState("");
  const [transport, setTransport] = useState<"recall" | "vexa">(defaults.transport);
  const [provider, setProvider] = useState(defaults.provider);
  const [actions, setActions] = useState(defaults.actions);

  const looksLikeMeet = /meet\.google\.com\//i.test(meetUrl);

  useInput(
    (input, key) => {
      if (step !== "options") return;
      if (key.escape || input === "b") setStep("link");
    },
    { isActive: step === "options" }
  );

  if (step === "link") {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold color="cyan">
          Join a meeting
        </Text>
        <Text dimColor>Memory writes to {props.repo}/.mex/meetings/</Text>
        <Box marginTop={1}>
          <Text color="cyan">link › </Text>
          <TextInput
            value={meetUrl}
            onChange={setMeetUrl}
            onSubmit={(v) => {
              if (v.trim()) setStep("options");
            }}
            placeholder="https://meet.google.com/abc-defg-hij"
          />
        </Box>
        {meetUrl && !looksLikeMeet ? <Text color="yellow">⚠ not a meet.google.com link — continue if you're sure</Text> : null}
        <Text dimColor>enter → options · esc back</Text>
      </Box>
    );
  }

  const providerLabel = provider || "default (auto)";
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color="cyan">
        Join — options
      </Text>
      <Text dimColor>{meetUrl}</Text>
      <Box marginTop={1}>
        <Menu
          onSelect={(v) => {
            if (v === "transport") setTransport((t) => (t === "recall" ? "vexa" : "recall"));
            else if (v === "provider") setProvider((p) => PROVIDERS[(PROVIDERS.indexOf(p) + 1) % PROVIDERS.length]!);
            else if (v === "actions") setActions((a) => !a);
            else if (v === "join")
              props.onLaunch({ meetUrl, transport, provider, actions, botName: defaults.botName || undefined });
          }}
          items={[
            { label: `Transport: ${transport}`, value: "transport", hint: "↵ to toggle recall/vexa" },
            { label: `STT provider: ${providerLabel}`, value: "provider", hint: "↵ to cycle" },
            { label: `In-call repo actions: ${actions ? "on" : "off"}`, value: "actions", hint: "↵ to toggle" },
            { label: "Join now ▸", value: "join" },
          ]}
        />
      </Box>
      <Text dimColor>↑↓ move · enter select/toggle · [b]/esc back to link</Text>
    </Box>
  );
}

// --- Recent calls ------------------------------------------------------------

export function RecentScreen(props: { repo: string; onBack: () => void }): React.ReactElement {
  const calls = useMemo(() => listArchivedCalls(props.repo), [props.repo]);
  const mex = useMemo(() => gatherDoctorReport(props.repo).mex, [props.repo]);
  const [selected, setSelected] = useState<string | null>(null);

  useInput((input, key) => {
    if (key.escape || input === "b") {
      if (selected) setSelected(null);
      else props.onBack();
    }
  });

  if (selected) {
    const state = new LiveStore(selected).read();
    const events = mex.present ? readMeetingEventsForCall(props.repo, mex.mexDir, selected) : [];
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold color="cyan">
          {selected.split("/").pop()}
        </Text>
        <Text dimColor wrap="truncate-end">
          {state.summary || "(no summary)"}
        </Text>
        <Text>
          {state.decisions.length} decisions · {state.actionItems.length} actions · {state.openQuestions.length} open
          questions
        </Text>
        {mex.present ? (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>mex timeline ({events.length})</Text>
            {events.length === 0 ? (
              <Text dimColor>(no events logged for this call)</Text>
            ) : (
              events.slice(0, 10).map((e, i) => (
                <Text key={i} wrap="truncate-end">
                  <Text dimColor>{e.timestamp?.slice(0, 10) ?? ""} </Text>
                  <Text color="green">{e.kind}</Text> · {e.message}
                </Text>
              ))
            )}
          </Box>
        ) : (
          <Text dimColor>no mex scaffold — run `mex-call setup` to get a queryable timeline</Text>
        )}
        <Text dimColor>[b]/esc back</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color="cyan">
        Recent calls
      </Text>
      {calls.length === 0 ? (
        <Text dimColor>No archived calls yet under {props.repo}/.mex/meetings/</Text>
      ) : (
        <Box marginTop={1}>
          <Menu onSelect={(v) => setSelected(v)} items={calls.map((c) => ({ label: c.name, value: c.path }))} />
        </Box>
      )}
      <Text dimColor>↑↓ move · enter open · [b]/esc back</Text>
    </Box>
  );
}

// --- Settings (read-only for Slice 3; editable in Slice 4) -------------------

export function SettingsScreen(props: { repo: string; onBack: () => void }): React.ReactElement {
  const report = useMemo(() => gatherDoctorReport(props.repo), [props.repo]);
  const [d, setD] = useState<TuiDefaults>(() => loadTuiDefaults());
  const [editing, setEditing] = useState<null | "botName" | "keyterms">(null);
  const [buf, setBuf] = useState("");
  const [saved, setSaved] = useState<string>();

  useInput((input, key) => {
    if (editing) {
      if (key.escape) setEditing(null);
      return;
    }
    if (key.escape || input === "b") props.onBack();
  });

  if (editing) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold color="cyan">
          Settings — edit {editing}
        </Text>
        <Box marginTop={1}>
          <Text color="cyan">{editing} › </Text>
          <TextInput
            value={buf}
            onChange={setBuf}
            onSubmit={(v) => {
              setD((s) => ({ ...s, [editing]: v.trim() }));
              setSaved(undefined);
              setEditing(null);
            }}
            placeholder={editing === "keyterms" ? "Mex, OAuth, Postgres" : "Mex (notetaker)"}
          />
        </Box>
        <Text dimColor>enter save · esc cancel</Text>
      </Box>
    );
  }

  const handle = (v: string) => {
    setSaved(undefined);
    if (v === "transport") setD((s) => ({ ...s, transport: s.transport === "recall" ? "vexa" : "recall" }));
    else if (v === "provider") setD((s) => ({ ...s, provider: PROVIDERS[(PROVIDERS.indexOf(s.provider) + 1) % PROVIDERS.length]! }));
    else if (v === "actions") setD((s) => ({ ...s, actions: !s.actions }));
    else if (v === "model") setD((s) => ({ ...s, model: MODELS[(MODELS.indexOf(s.model) + 1) % MODELS.length]! }));
    else if (v === "botName") {
      setBuf(d.botName);
      setEditing("botName");
    } else if (v === "keyterms") {
      setBuf(d.keyterms);
      setEditing("keyterms");
    } else if (v === "save") {
      setSaved(saveTuiDefaults(d) ? `saved → ${tuiConfigPath()}` : "save failed");
    }
  };

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color="cyan">
        Settings
      </Text>
      <Text dimColor>Editable defaults the Join screen pre-fills (saved to ~/.mex-call.tui.json). Keys stay in env — read-only here.</Text>
      <Box marginTop={1}>
        <Menu
          onSelect={handle}
          items={[
            { label: `Transport: ${d.transport}`, value: "transport" },
            { label: `STT provider: ${d.provider || "auto"}`, value: "provider" },
            { label: `In-call repo actions: ${d.actions ? "on" : "off"}`, value: "actions" },
            { label: `Bot name: ${d.botName || "(default)"}`, value: "botName" },
            { label: `Keyterms: ${d.keyterms || "(default: Mex)"}`, value: "keyterms" },
            { label: `Model: ${d.model || "(default)"}`, value: "model" },
            { label: "Save defaults ▸", value: "save" },
          ]}
        />
      </Box>
      <Box flexDirection="column" marginTop={1}>
        <Text dimColor>keys (read-only):</Text>
        <Text>
          {" "}RECALL_API_KEY {process.env.RECALL_API_KEY ? <Text color="green">✓</Text> : <Text color="red">✗</Text>} ·
          ASSEMBLYAI_API_KEY {report.hasAssemblyKey ? <Text color="green">✓</Text> : <Text color="yellow">✗</Text>} ·
          VEXA_API_KEY {process.env.VEXA_API_KEY ? <Text color="green">✓</Text> : <Text dimColor>✗</Text>} · brain:{" "}
          {report.brain ?? "none"}
        </Text>
      </Box>
      {saved ? <Text color="green">{saved}</Text> : null}
      <Text dimColor>↑↓ move · enter toggle/edit · [b]/esc back</Text>
    </Box>
  );
}

// --- End-of-call (§7 — event-log funnel is first-class) ----------------------

export function EndScreen(props: {
  repo: string;
  archivePath?: string;
  onHome: () => void;
  onQuit: () => void;
}): React.ReactElement {
  const archive = useMemo(
    () => (props.archivePath ? new LiveStore(props.archivePath).read() : null),
    [props.archivePath]
  );
  const mex = useMemo(() => gatherDoctorReport(props.repo).mex, [props.repo]);
  const events = useMemo(
    () => (props.archivePath && mex.present ? readMeetingEventsForCall(props.repo, mex.mexDir, props.archivePath) : []),
    [props.archivePath, mex]
  );
  // Read-only decision-vs-scaffold diff (§6) — a preview of contradiction
  // detection for mex users; never writes the scaffold.
  const diffs = useMemo(
    () => (mex.present && archive ? scaffoldDiff(mex.mexDir, archive.decisions) : []),
    [mex, archive]
  );

  const [copied, setCopied] = useState(false);
  useInput((input, key) => {
    if (input === "q") props.onQuit();
    else if (input === "m") {
      if (archive) {
        const r = spawnSync("pbcopy", { input: buildMarkdownReport(archive) });
        setCopied(!r.error && r.status === 0);
      }
    } else if (key.escape || key.return || input === "h") props.onHome();
  });

  const d = archive?.decisions.length ?? 0;
  const a = archive?.actionItems.length ?? 0;
  const q = archive?.openQuestions.length ?? 0;
  const captured = d + a + q;

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold>⚪ Call ended</Text>
      {props.archivePath ? (
        <Text>
          Archived → <Text color="cyan">{props.archivePath}</Text>
        </Text>
      ) : (
        <Text dimColor>Archiving…</Text>
      )}
      <Text dimColor>
        {d} decisions · {a} action items · {q} open questions captured
      </Text>

      {mex.present ? (
        <Box marginTop={1} borderStyle="round" borderColor="green" paddingX={1} flexDirection="column">
          <Text color="green" bold>
            ✅ {events.length || captured} item(s) logged to your mex timeline (source: meeting)
          </Text>
          {events.slice(0, 6).map((e, i) => (
            <Text key={i} wrap="truncate-end">
              <Text dimColor>{e.kind}</Text> · {e.message}
            </Text>
          ))}
          <Text dimColor>Run `mex timeline` to review — each ties back to this call.</Text>
        </Box>
      ) : null}

      {mex.present && diffs.length > 0 ? (
        <Box marginTop={1} borderStyle="round" borderColor="yellow" paddingX={1} flexDirection="column">
          <Text color="yellow" bold>
            ⚖ {diffs.length} decision(s) touch something your scaffold already has a stance on:
          </Text>
          {diffs.slice(0, 4).map((f, i) => (
            <Box key={i} flexDirection="column">
              <Text wrap="truncate-end">• decided: {f.decision}</Text>
              <Text dimColor wrap="truncate-end">
                {"  "}↳ {f.file}: {f.line}
              </Text>
            </Box>
          ))}
          <Text dimColor>Read-only preview — review for contradictions; nothing was written to the scaffold.</Text>
        </Box>
      ) : null}

      {!mex.present && captured > 0 ? (
        <Box marginTop={1} borderStyle="round" borderColor="yellow" paddingX={1} flexDirection="column">
          <Text color="yellow" bold>
            These {captured} captured items are going nowhere your coding agent can reach.
          </Text>
          <Text>
            They're notes in your repo now. With mex they become a permanent, queryable decision log tied to this repo —
            so your agent can answer <Text italic>why</Text> you chose something months from now, not just what the code
            says today.
          </Text>
          <Text color="cyan">Run `mex-call setup` to wire it in.</Text>
        </Box>
      ) : null}

      <Box marginTop={1}>
        <Text dimColor>[m] copy as markdown{copied ? <Text color="green"> ✓ copied</Text> : ""} · [h]/enter home · [q] quit</Text>
      </Box>
    </Box>
  );
}
