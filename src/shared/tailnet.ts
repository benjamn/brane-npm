/** One tailnet per browser origin.
 *
 *  Every daemon a browser has melded keeps its token in that origin's
 *  `localStorage`, so anything that runs script in the origin — a renderer bug
 *  fed by a hostile daemon — can read all of them, and a page on your tailnet
 *  can use them against your daemons directly. A meld link is the cheap way to
 *  get a hostile daemon in: a stranger stands one up behind Tailscale Funnel,
 *  which gives it a real `*.ts.net` name and certificate, and sends the link.
 *
 *  The rule that makes that harmless: an origin holds daemons from one trust
 *  domain only, and the domain is read off the host the browser itself
 *  connects to, never off anything the daemon says about itself. For a
 *  MagicDNS name (`mac.tail1234.ts.net`, what `brane meld` always writes) the
 *  domain is the tailnet (`tail1234.ts.net`): only Tailscale issues names and
 *  certificates under it, so a daemon cannot claim to be in a tailnet it is
 *  not in. Any other host (a LAN IP, a raw Tailscale IP, a public name) is a
 *  domain of exactly itself. Loopback is the exception that is no domain at
 *  all: only this machine can serve it, so it is accepted beside any tailnet,
 *  and it never decides one. So a browser that melded `tail1234.ts.net`
 *  refuses a link to `evil.tail5678.ts.net` before it contacts it, and using
 *  another tailnet takes another browser (or profile), or forgetting this
 *  one's daemons first. See SECURITY.md, "One tailnet per browser".
 *
 *  Pure, so the test suite drives it without a DOM. */

/** The hostname of a `host[:port]` as the app stores it, lower-cased, without
 *  brackets or a trailing dot; `null` when it is not a host at all. */
export function hostnameOf(host: string): string | null {
  const trimmed = host.trim();
  if (!trimmed || /[/?#@\s]/.test(trimmed)) return null;
  try {
    const name = new URL(`http://${trimmed}`).hostname.toLowerCase();
    return name.replace(/^\[(.*)\]$/, "$1").replace(/\.$/, "") || null;
  } catch {
    return null;
  }
}

function isLoopback(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "::1" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)
  );
}

/** The tailnet a MagicDNS name belongs to — `tail1234.ts.net` for
 *  `mac.tail1234.ts.net` — or `null` for any other host. */
export function tailnetOf(host: string): string | null {
  const name = hostnameOf(host);
  if (!name) return null;
  const labels = name.split(".");
  if (labels.length < 4 || labels.at(-1) !== "net" || labels.at(-2) !== "ts") return null;
  if (labels.some((l) => l === "")) return null;
  return labels.slice(-3).join(".");
}

/** The domain every loopback spelling shares. */
export const LOOPBACK = "localhost";

/** The trust domain a daemon at `host` belongs to: its tailnet, `localhost`
 *  for every loopback spelling, or else the hostname itself. `null` for
 *  something that is not a host. */
export function trustDomainOf(host: string): string | null {
  const name = hostnameOf(host);
  if (!name) return null;
  if (isLoopback(name)) return LOOPBACK;
  return tailnetOf(name) ?? name;
}

export type MeldHostVerdict =
  | {
      ok: true;
      domain: string;
      /** This meld decides the browser's domain: none is held yet, apart
       *  from loopback. The one meld the rule can't screen, so the app warns
       *  before it. */
      setsHome: boolean;
    }
  | {
      ok: false;
      /** The candidate's domain, or `null` when the host did not parse. */
      domain: string | null;
      /** The domains this browser already holds daemons from. */
      home: string[];
    };

/** May a browser that already holds daemons at `existingHosts` add one at
 *  `candidate`? A loopback daemon, always: only this machine can serve one,
 *  and its token beside a tailnet's is exposed to nobody that tailnet's
 *  aren't. Anything else, when the browser holds no domain yet (the meld
 *  picks it, and `setsHome` says so), or when the domain is one it already
 *  holds — a browser melded before this rule may hold two, and adding to
 *  either exposes nothing new. Loopback never counts as holding a domain: a
 *  browser with only loopback daemons still has its domain to pick, and that
 *  pick is screened like a first meld, since a stranger's daemon there could
 *  reach the loopback one from this very browser. Hosts that do not parse
 *  are ignored on the existing side and refused on the candidate side. */
export function checkMeldHost(candidate: string, existingHosts: readonly string[]): MeldHostVerdict {
  const home = [
    ...new Set(existingHosts.map(trustDomainOf).filter((d): d is string => d !== null && d !== LOOPBACK)),
  ].sort();
  const domain = trustDomainOf(candidate);
  if (domain === null) return { ok: false, domain, home };
  if (domain === LOOPBACK) return { ok: true, domain, setsHome: false };
  if (home.length === 0) return { ok: true, domain, setsHome: true };
  if (home.includes(domain)) return { ok: true, domain, setsHome: false };
  return { ok: false, domain, home };
}

/** Whether a meld link the rule allowed gets the first-meld warning: the
 *  browser holds no daemon at all, or this meld picks its domain. Never on
 *  the daemon's own origin (`candidate` is the page's host): that is where
 *  Isolate lands, from the operator's own app, and if the daemon were
 *  hostile the card would be drawn by its own bundle, warning about nothing.
 *  Only a page some other origin serves — the shared app — can warn honestly. */
export function isFirstMeld(
  existingHosts: readonly string[],
  verdict: Extract<MeldHostVerdict, { ok: true }>,
  candidate: string,
  pageHost: string,
): boolean {
  if (candidate.toLowerCase() === pageHost.toLowerCase()) return false;
  return existingHosts.length === 0 || verdict.setsHome;
}

/** The refusal in words, for the meld card and the add-daemon form. */
export function meldRefusalMessage(candidate: string, verdict: Extract<MeldHostVerdict, { ok: false }>): string {
  if (verdict.domain === null) return `"${candidate}" is not a daemon address.`;
  const home = verdict.home.join(" and ");
  return (
    `${hostnameOf(candidate) ?? candidate} is on ${verdict.domain}, but this browser's daemons are on ${home}. ` +
    `A browser holds daemons from one tailnet only, so that no daemon can reach another tailnet's tokens. ` +
    `To use it, open the link in another browser or profile, or remove this browser's daemons first.`
  );
}
