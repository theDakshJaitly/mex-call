/**
 * Resolve the public URL that Recall should POST realtime events to.
 *
 * Order:
 *   1. MEXCALL_PUBLIC_URL env (production domain, or a manually-started tunnel).
 *   2. A running ngrok agent — queried via its local API (no need to copy/paste
 *      the URL). Free-tier ngrok URLs change on restart; that's an accepted dev
 *      annoyance, not solved here.
 *
 * We never spawn ngrok ourselves; the dev runs `ngrok http <port>` separately.
 */
export async function resolvePublicUrl(port: number): Promise<{ url: string; source: string }> {
  const fromEnv = process.env.MEXCALL_PUBLIC_URL?.trim();
  if (fromEnv) return { url: fromEnv.replace(/\/+$/, ""), source: "MEXCALL_PUBLIC_URL" };

  const ngrok = await detectNgrok(port);
  if (ngrok) return { url: ngrok, source: "ngrok" };

  throw new Error(
    [
      "No public URL for Recall webhooks.",
      `Start a tunnel to this runtime, e.g.:  ngrok http ${port}`,
      "…then re-run (mex-call auto-detects the ngrok URL), or set MEXCALL_PUBLIC_URL=https://your-domain",
    ].join("\n  ")
  );
}

interface NgrokTunnel {
  public_url?: string;
  proto?: string;
  config?: { addr?: string };
}

async function detectNgrok(port: number): Promise<string | null> {
  try {
    const res = await fetch("http://127.0.0.1:4040/api/tunnels", { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    const body = (await res.json()) as { tunnels?: NgrokTunnel[] };
    const tunnels = body.tunnels ?? [];

    // Prefer an https tunnel pointing at our port; otherwise any https tunnel.
    const matchesPort = (t: NgrokTunnel) => (t.config?.addr ?? "").endsWith(`:${port}`);
    const https = tunnels.filter((t) => t.proto === "https" && t.public_url);
    const best = https.find(matchesPort) ?? https[0];
    return best?.public_url?.replace(/\/+$/, "") ?? null;
  } catch {
    return null;
  }
}
