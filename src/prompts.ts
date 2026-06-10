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
