import { useEffect, useState } from "react";
import { LiveStore, type LiveState } from "./store.js";

/** Subscribe a component to the live-call files. Polls (mtime-gated) so an idle
 *  call is nearly free; the runtime already debounces its writes. */
export function useLiveState(liveDir: string): LiveState {
  const [state, setState] = useState<LiveState>(() => new LiveStore(liveDir).read());
  useEffect(() => {
    const store = new LiveStore(liveDir);
    return store.watch(setState, 500);
  }, [liveDir]);
  return state;
}
