import type { ByteSource } from "./bytes.js";

export type MemberKind = "file" | "dir" | "symlink" | "hardlink" | "other";

/** One member as a format reader found it. `name` is exactly what the archive
 *  says, which may be absolute, contain `..`, or repeat another member's —
 *  `archive.ts` decides what is safe to show, so the readers never have to. */
export interface RawMember {
  name: string;
  kind: MemberKind;
  /** The archive's claim; displayed, never relied on. */
  size: number | null;
  mtimeMs: number;
  /** A link's target, when the format stores it in the header (tar). */
  link?: string;
  /** Opens the body. May throw `MemberError` (encrypted, unsupported). */
  open?: () => ByteSource;
  /** A link's target, when the format stores it as the body (zip). */
  readLink?: () => Promise<string>;
}
