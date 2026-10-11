/**
 * A short "Safari on iPhone" for a User-Agent header, for the Devices list.
 * It is a label for a human telling rows apart, not a detection anyone should
 * branch on: User-Agents lie (an iPad asks for desktop sites as a Mac), and
 * that is fine here — the row also shows where and when it was seen.
 *
 * Order matters: every Chromium browser also says "Chrome" and "Safari", and
 * every iOS browser is WebKit underneath and says "Safari" or nothing.
 */

const BROWSERS: Array<[RegExp, string]> = [
  [/\bEdg(?:e|A|iOS)?\//, "Edge"],
  [/\bOPR\/|\bOPiOS\//, "Opera"],
  [/\bFirefox\/|\bFxiOS\//, "Firefox"],
  [/\bCriOS\//, "Chrome"],
  [/\bChrome\//, "Chrome"],
  [/\bVersion\/[\d.]+.*\bSafari\//, "Safari"],
];

const PLATFORMS: Array<[RegExp, string]> = [
  [/\biPhone\b/, "iPhone"],
  [/\biPad\b/, "iPad"],
  [/\bAndroid\b/, "Android"],
  [/\bCrOS\b/, "ChromeOS"],
  [/\bMacintosh\b|\bMac OS X\b/, "macOS"],
  [/\bWindows\b/, "Windows"],
  [/\bLinux\b/, "Linux"],
];

export function describeUserAgent(ua: string | null | undefined): string | null {
  if (!ua) return null;
  const browser = BROWSERS.find(([re]) => re.test(ua))?.[1];
  const platform = PLATFORMS.find(([re]) => re.test(ua))?.[1];
  if (browser && platform) return `${browser} on ${platform}`;
  // An app saved to an iPhone's home screen drops the Safari token and keeps
  // only WebKit's.
  if (platform && /\bAppleWebKit\//.test(ua)) return `Web app on ${platform}`;
  if (browser) return browser;
  if (platform) return platform;
  // Not a browser: `node`, `curl/8.7.1`. Its product name is the best label.
  const product = /^([A-Za-z][\w.-]*)/.exec(ua)?.[1];
  return product && product !== "Mozilla" ? product : null;
}
