"use client";

import { useEffect, useRef } from "react";

/**
 * Opens a page's own "create" form when it is reached with `?new=1`
 * (the header's "Crear" menu links that way), then drops the param so a
 * reload or the back button doesn't reopen it.
 *
 * Reads `window.location` instead of `useSearchParams` so the calling
 * page doesn't need a Suspense boundary. `ready` lets a page wait for
 * data the form depends on (e.g. pipeline stages).
 */
export function useOpenOnNewParam(open: () => void, ready = true) {
  const handled = useRef(false);
  const openRef = useRef(open);
  useEffect(() => {
    openRef.current = open;
  });

  useEffect(() => {
    if (handled.current || !ready) return;
    const url = new URL(window.location.href);
    if (url.searchParams.get("new") !== "1") return;
    handled.current = true;
    url.searchParams.delete("new");
    window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
    openRef.current();
  }, [ready]);
}
