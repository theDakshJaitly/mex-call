/**
 * Vexa identifies meetings by platform + native_meeting_id, not a full URL. For
 * Google Meet the native id is the `abc-defg-hij` code in the meeting URL. The
 * runtime is given a Meet URL (same arg Recall takes), so the adapter extracts
 * the code here.
 */
export interface NativeMeeting {
  platform: "google_meet";
  nativeId: string;
}

const MEET_CODE = /[a-z]{3}-[a-z]{4}-[a-z]{3}/i;

export function parseGoogleMeetId(meetingUrl: string): NativeMeeting {
  const input = (meetingUrl ?? "").trim();
  // From a full URL (host-anchored so we don't match codes in query strings).
  const urlMatch = input.match(new RegExp(`meet\\.google\\.com/(${MEET_CODE.source})`, "i"));
  if (urlMatch) return { platform: "google_meet", nativeId: urlMatch[1]!.toLowerCase() };
  // Or a bare code.
  const bare = input.match(new RegExp(`^(${MEET_CODE.source})$`, "i"));
  if (bare) return { platform: "google_meet", nativeId: bare[1]!.toLowerCase() };
  throw new Error(
    `Vexa transport: could not parse a Google Meet id (abc-defg-hij) from "${meetingUrl}".`
  );
}
