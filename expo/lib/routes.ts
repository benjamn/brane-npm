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
 *  Lives here rather than in the one component that first needed it: it is the
 *  behavioral half of the hrefs above, and every in-app reference — prose links
 *  in `Markdown`, the narrate targets in `ToolUseGroup` — has to click alike. */
export function inAppLinkProps(
  href: string | undefined,
  activate: () => void,
): Record<string, unknown> {
  if (!isWeb || !href) return { onPress: activate };
  return {
    href,
    onClick: (e: any) => {
      if (!isPlainClick(e)) return;
      e.preventDefault();
      activate();
    },
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
