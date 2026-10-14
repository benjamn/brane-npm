/** In-app URL construction, in one place.
 *
 *  These exist so links can be real `<a href>` elements rather than tap
 *  handlers. An anchor is what makes ⌘-click, middle-click, "Copy link
 *  address", keyboard focus and the `link` role work — none of which a
 *  `<span onClick>` can offer. The handler still runs on a plain click and
 *  does client-side navigation; the href is what the browser falls back on
 *  for everything else.
 */

import { Platform } from "react-native";
import { withDaemonFragment } from "@shared/view-url";
import { getActiveDaemonBraneId } from "./registry";

const isWeb = Platform.OS === "web";

/** A click the browser would handle as "follow this link, here". Anything else
 *  — ⌘/ctrl/shift/alt, or a middle click — is the user asking for a new tab or
 *  window, and must be left to the browser. */
function isPlainClick(e: any): boolean {
  return e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
}

/** Props for a link that navigates inside the app.
 *
 *  On web this renders a real `<a href>` (react-native-web switches Text's host
 *  element to `a` as soon as `href` is set) and intercepts only plain clicks,
 *  so client-side routing still happens but ⌘-click opens a genuine new tab.
 *  `onClick` rather than `onPress` because RNW hands `onClick` the event and
 *  gives it priority. Native has no href, so it keeps the press handler.
 *
 *  The rendered href names this tab's daemon (`#daemon=`, see `DAEMON_PARAM`),
 *  since the new tab it opens has no active daemon of its own. A plain click
 *  runs `activate`, which navigates by the clean path, so the param only ever
 *  reaches an address bar in a tab that needs it.
 *
 *  Lives here rather than in the one component that first needed it: it is the
 *  behavioral half of the hrefs above, and every in-app reference — prose links
 *  in `Markdown`, the narrate targets in `ToolUseGroup` — has to click alike. */
export function inAppLinkProps(
  href: string | undefined,
  activate: () => void,
): Record<string, unknown> {
  if (!isWeb || !href) return { onPress: activate };
  return {
    href: withDaemonFragment(href, getActiveDaemonBraneId()),
    onClick: (e: any) => {
      if (!isPlainClick(e)) return;
      e.preventDefault();
      activate();
    },
  };
}

/** Whether the web app is running from the home screen (iOS "Add to Home
 *  Screen", an installed PWA) rather than in a browser tab. There a
 *  `target="_blank"` link leaves the app for a browser view, and on iOS that
 *  view does not share the app's storage: no melded daemons, so it opens on
 *  the meld screen whatever the link says. */
function isStandaloneApp(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia?.("(display-mode: standalone)").matches === true ||
    (window.navigator as { standalone?: boolean }).standalone === true
  );
}

/** Props for a link that always opens in a new tab or window, on web: a real
 *  anchor with `target="_blank"`, naming this tab's daemon for the same reason
 *  `inAppLinkProps` does. Every click is the browser's, plain ones included;
 *  `onOpen` runs alongside (closing the menu the link sat in, say) and must not
 *  navigate. Native has no tabs, and a home-screen web app has none worth
 *  leaving for (`isStandaloneApp`), so in both it is `fallback`, pressed. */
export function newTabLinkProps(
  href: string,
  onOpen: () => void,
  fallback: () => void,
): Record<string, unknown> {
  if (!isWeb || isStandaloneApp()) return { onPress: fallback };
  return {
    href: withDaemonFragment(href, getActiveDaemonBraneId()),
    hrefAttrs: { target: "_blank", rel: "noopener" },
    onClick: onOpen,
  };
}

/** A narrative, optionally scrolled to one event. */
export function narrativeHref(nid: string, seq?: number): string {
  return seq ? `/${nid}?scrollToSeq=${seq}` : `/${nid}`;
}

/** A file open in a narrative's Files tab, optionally at a line or range. */
export function fileHref(
  nid: string,
  path: string,
  line?: number,
  lineEnd?: number,
  pinned?: string,
): string {
  const params = new URLSearchParams({ tab: "files", path });
  if (line) params.set("line", lineEnd && lineEnd > line ? `${line}-${lineEnd}` : String(line));
  if (pinned) params.set("pinned", pinned);
  return `/${nid}?${params.toString()}`;
}
