/**
 * Prompt builders for the passive loop. Kept in one place so the memory
 * behaviour is easy to read and tune. The compaction prompt is the heart of
 * the homeostatic principle: it always works from (rolling summary + bounded
 * window), never the full transcript.
 */

export interface CompactionInput {
  previousSummary: string;
  windowText: string;
  existingDecisions: string[];
  existingActionItems: string[];
  existingOpenQuestions: string[];
  targetWords: number;
}

export interface CompactionOutput {
  rollingSummary: string;
  newDecisions: string[];
  newActionItems: string[];
  newOpenQuestions: string[];
}

const bullets = (items: string[]): string =>
  items.length ? items.map((i) => `- ${i}`).join("\n") : "(none yet)";

export function buildCompactionPrompt(input: CompactionInput): string {
  return `You are the passive memory loop of a live meeting agent. You maintain a bounded,
structured memory of an ongoing meeting. You never see the full transcript — only the
rolling summary so far plus the most recent window of conversation. The window may
overlap with content already in the summary; integrate only what is genuinely new.

== PREVIOUS_ROLLING_SUMMARY ==
${input.previousSummary || "(empty — the meeting just started)"}

== RECENT_TRANSCRIPT_WINDOW ==
${input.windowText || "(empty)"}

== ALREADY_CAPTURED_DECISIONS ==
${bullets(input.existingDecisions)}

== ALREADY_CAPTURED_ACTION_ITEMS ==
${bullets(input.existingActionItems)}

== ALREADY_CAPTURED_OPEN_QUESTIONS ==
${bullets(input.existingOpenQuestions)}

TASK:
1. Produce an UPDATED rolling summary that folds in anything new from the window.
   - Keep it UNDER ${input.targetWords} words. Compress older detail aggressively;
     preserve decisions, who-is-doing-what, the current topic, and unresolved threads.
   - It must be self-contained: a reader (human or agent) should understand the state
     of the meeting from the summary alone.
2. Extract items found in the window that are NOT already captured above:
   - newDecisions: choices the group actually settled on (not mere discussion).
   - newActionItems: concrete tasks. Include the owner as "@name" when stated.
   - newOpenQuestions: unresolved questions or undecided threads.
   Return ONLY genuinely new items; do not repeat already-captured ones.

Respond with ONLY a single valid JSON object, no markdown, no code fences:
{
  "rollingSummary": "string",
  "newDecisions": ["string"],
  "newActionItems": ["string"],
  "newOpenQuestions": ["string"]
}`;
}

export interface FinalSummaryInput {
  callName: string;
  rollingSummary: string;
  decisions: string[];
  actionItems: string[];
  openQuestions: string[];
}

export interface ActiveInput {
  /** The utterance that addressed Mex. */
  utterance: string;
  speaker: string;
  rollingSummary: string;
  window: string;
  participants: string;
  decisions: string[];
  actionItems: string[];
  openQuestions: string[];
  /** Bounded .mex/context + patterns when a scaffold is present; "" otherwise. */
  repoContext: string;
}

export interface ActiveOutput {
  /** false if "mex" wasn't actually directed at the bot — then we stay silent. */
  addressed: boolean;
  action: "answer" | "log_decision" | "log_action_item" | "log_open_question" | "repo_action" | "none";
  /** For log_* actions: the text to record. For repo_action: the task to carry out. "" otherwise. */
  item: string;
  /** Plain-text chat reply to post. Empty for repo_action (the action brain writes it). */
  message: string;
}

export function buildActivePrompt(i: ActiveInput): string {
  const repoBlock = i.repoContext
    ? `\n== REPO CONTEXT (from this repo's .mex scaffold; authoritative) ==\n${i.repoContext}\n`
    : "";
  return `You are Mex, an AI agent with a seat in a live meeting. Someone said your name.
You do NOT speak out loud — you reply in the meeting chat. Replies are PLAIN TEXT
(no markdown, no hyperlinks — Google Meet renders neither). Be concise: 1–3 sentences.
You also maintain the meeting's structured memory.

== ROLLING_SUMMARY ==
${i.rollingSummary || "(empty)"}

== RECENT_TRANSCRIPT (most recent last) ==
${i.window || "(empty)"}

== PARTICIPANTS ==
${i.participants || "(unknown)"}

== DECISIONS_SO_FAR ==
${bullets(i.decisions)}

== ACTION_ITEMS_SO_FAR ==
${bullets(i.actionItems)}

== OPEN_QUESTIONS_SO_FAR ==
${bullets(i.openQuestions)}
${repoBlock}
Your name "Mex" is frequently mis-transcribed by live speech-to-text (e.g.
"max", "mecks", "next", "mux"). When one of those appears and the speaker is
clearly addressing the AI notetaker, treat it as your name. If it's clearly a
real person's name or unrelated speech, set addressed=false.

The line that addressed you (from ${i.speaker}):
"${i.utterance}"

Decide how to respond, then output ONLY this JSON (no markdown, no code fences):
{
  "addressed": boolean,
  "action": "answer" | "log_decision" | "log_action_item" | "log_open_question" | "none",
  "item": "string",
  "message": "string"
}

Guidance:
- "Mex, summarize where we are" → action "answer"; message = a tight summary from memory.
- "Mex, remember/log that as a decision" → action "log_decision"; item = the decision
  (infer the specifics from the recent transcript); message = a short confirmation.
- "Mex, make an action item for <person> to <task>" → action "log_action_item";
  item = "@<person>: <task>"; message = confirmation.
- "Mex, that's an open question" → action "log_open_question"; item = the question.
- A request to DO something in the repo — "Mex, create an issue for that", "open a
  PR", "update the architecture notes", "make a task for X" → action "repo_action";
  item = a clear, self-contained description of the task grounded in what was said
  (e.g. "Create a GitHub issue for the decision to move the v2 API to cursor-based
  pagination; include the rationale discussed."); leave message "" (the action is
  carried out separately and writes its own confirmation).
- A question you can answer from the memory or repo context → action "answer".
- If "mex" was NOT actually directed at you (mentioned in passing, talking ABOUT mex,
  etc.) → set addressed=false, action "none", item "", message "".
- Never invent decisions/owners that weren't said. If unsure what to record, use
  action "answer" and ask a brief clarifying question instead.`;
}

export interface ActionInput {
  task: string;
  repoRoot: string;
  rollingSummary: string;
  decisions: string[];
  actionItems: string[];
  participants: string;
}

/**
 * Prompt for the tool-enabled action brain (MVP 4). This runs as a real Claude
 * Code session IN the repo with gh/git/Write/Edit, so it can create issues,
 * draft docs/PRs, etc. It must finish with a one-line plain-text confirmation —
 * that line is posted into the meeting chat.
 */
export function buildActionPrompt(i: ActionInput): string {
  return `You are Mex, an AI agent with a seat in a live meeting and access to this repo.
Someone in the meeting asked you to do something in the repo. Carry it out now using
your tools, grounded in what was actually said.

REPO: ${i.repoRoot}

TASK:
${i.task}

LIVE MEETING CONTEXT (ground the work in this — do not invent beyond it):
== ROLLING SUMMARY ==
${i.rollingSummary || "(empty)"}
== DECISIONS ==
${bullets(i.decisions)}
== ACTION ITEMS ==
${bullets(i.actionItems)}
== PARTICIPANTS ==
${i.participants || "(unknown)"}

Guidelines:
- GitHub issues/PRs: use \`gh\` (e.g. \`gh issue create --title … --body …\`). If \`gh\`
  isn't authenticated or there's no remote, say so instead of guessing.
- Docs/notes: use Write/Edit. Keep changes minimal and clearly attributable to the
  call. Do NOT commit, push, or open PRs unless explicitly asked to.
- Don't invent decisions, owners, or facts that weren't in the meeting.
- If the task is ambiguous or unsafe, do the safest useful thing (e.g. a draft) and
  say what you did.

When finished, reply with EXACTLY ONE short plain-text sentence confirming what you
did (e.g. "Created issue #42: move v2 API to cursor pagination." or "Drafted updates
to docs/architecture.md"). No markdown — it goes straight into the meeting chat.`;
}

export function buildFollowUpEmailPrompt(i: FinalSummaryInput): string {
  return `The meeting "${i.callName}" just ended. Draft a concise follow-up email recapping it,
ready for a human to skim, edit, and send.

== ROLLING SUMMARY ==
${i.rollingSummary || "(empty)"}
== DECISIONS ==
${bullets(i.decisions)}
== ACTION ITEMS ==
${bullets(i.actionItems)}
== OPEN QUESTIONS ==
${bullets(i.openQuestions)}

Write Markdown with a Subject line, a one-paragraph recap, a "Decisions" list, a
"Next steps / owners" list (keep any @owner), and "Open questions". Keep it tight and
professional. Don't invent anything not above. Output ONLY the email.`;
}

export function buildProductSignalsPrompt(i: FinalSummaryInput): string {
  return `The meeting "${i.callName}" just ended. Extract product-relevant signals an agent or
PM would want later — especially from user-research / customer calls.

== ROLLING SUMMARY ==
${i.rollingSummary || "(empty)"}
== DECISIONS ==
${bullets(i.decisions)}
== ACTION ITEMS ==
${bullets(i.actionItems)}
== OPEN QUESTIONS ==
${bullets(i.openQuestions)}

Write Markdown with sections (omit any that are genuinely empty): Pain points,
Feature requests, Objections / risks, Notable quotes, Opportunities. Only include
signals actually present above — if there are none, say "No clear product signals in
this call." Output ONLY the Markdown.`;
}

export function buildFinalSummaryPrompt(input: FinalSummaryInput): string {
  return `The meeting "${input.callName}" has ended. Using the accumulated memory below,
write a final summary in Markdown for both humans and AI coding agents to consume later.

== ROLLING_SUMMARY ==
${input.rollingSummary || "(empty)"}

== DECISIONS ==
${bullets(input.decisions)}

== ACTION_ITEMS ==
${bullets(input.actionItems)}

== OPEN_QUESTIONS ==
${bullets(input.openQuestions)}

Write tight, skimmable Markdown with these sections (omit a section only if truly empty):
# Final summary — ${input.callName}
## Overview        (2-4 sentences: what this meeting was and what came out of it)
## Key decisions   (bulleted)
## Action items    (bulleted; keep any @owner)
## Open questions  (bulleted)
## Notable context (anything an agent working in this repo would want to know)

Output ONLY the Markdown. No preamble, no code fences around the whole thing.`;
}
