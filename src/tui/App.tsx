import React, { useState } from "react";
import { useApp, useInput } from "ink";
import { LiveView } from "./LiveView.js";
import {
  Home,
  DoctorScreen,
  LaunchScreen,
  RecentScreen,
  SettingsScreen,
  EndScreen,
  type LaunchConfig,
} from "./screens.js";

export interface AppProps {
  repo: string;
  port: number;
  /** Pre-filled link (e.g. a future `mex-call <url>`) → straight into the call. */
  meetUrl?: string;
}

type Screen = "home" | "doctor" | "launch" | "live" | "ended" | "recent" | "settings";

/** Turn the Launch screen's config into `mex-call join` flags. */
function launchArgs(cfg: LaunchConfig): string[] {
  const a: string[] = [];
  if (cfg.transport === "vexa") a.push("--transport", "vexa");
  if (cfg.provider) a.push("--provider", cfg.provider);
  if (!cfg.actions) a.push("--no-actions");
  if (cfg.botName) a.push("--bot-name", cfg.botName);
  return a;
}

const DEFAULT_CONFIG = (meetUrl: string): LaunchConfig => ({
  meetUrl,
  transport: "recall",
  provider: "",
  actions: true,
});

/**
 * Screen router. The live grid (LiveView) owns the call + the control socket;
 * every other screen is a small read-only/form view around it. Kept thin on
 * purpose — the risky, process-driving logic stays isolated in LiveView.
 */
export function App(props: AppProps): React.ReactElement {
  const { exit } = useApp();
  const [screen, setScreen] = useState<Screen>(props.meetUrl ? "live" : "home");
  const [config, setConfig] = useState<LaunchConfig>(DEFAULT_CONFIG(props.meetUrl ?? ""));
  const [endArchive, setEndArchive] = useState<string | undefined>(undefined);
  const [nonce, setNonce] = useState(0);

  // Ctrl+C quits from any non-live screen (LiveView handles it itself, gracefully).
  useInput(
    (input, key) => {
      if (key.ctrl && input === "c") exit();
    },
    { isActive: screen !== "live" }
  );

  const startCall = (cfg: LaunchConfig) => {
    setConfig(cfg);
    setNonce((n) => n + 1);
    setScreen("live");
  };

  switch (screen) {
    case "home":
      return (
        <Home
          onSelect={(v) => {
            if (v === "join") setScreen("launch");
            else if (v === "doctor") setScreen("doctor");
            else if (v === "recent") setScreen("recent");
            else if (v === "settings") setScreen("settings");
            else if (v === "quit") exit();
          }}
        />
      );
    case "doctor":
      return <DoctorScreen repo={props.repo} onBack={() => setScreen("home")} onProceed={() => setScreen("launch")} />;
    case "launch":
      return <LaunchScreen repo={props.repo} onBack={() => setScreen("home")} onLaunch={startCall} />;
    case "recent":
      return <RecentScreen repo={props.repo} onBack={() => setScreen("home")} />;
    case "settings":
      return <SettingsScreen repo={props.repo} onBack={() => setScreen("home")} />;
    case "ended":
      return (
        <EndScreen
          repo={props.repo}
          archivePath={endArchive}
          onHome={() => setScreen("home")}
          onQuit={() => exit()}
        />
      );
    case "live":
      return (
        <LiveView
          key={nonce}
          repo={props.repo}
          port={props.port}
          meetUrl={config.meetUrl}
          extraArgs={launchArgs(config)}
          onEnded={(d) => {
            setEndArchive(d.archivePath);
            setScreen("ended");
          }}
        />
      );
  }
}
