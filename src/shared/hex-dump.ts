// The hex view's two rules, window-free so the daemon (which decides a file
// is binary) and the app (which lays the bytes out) agree without a browser.

/** Bytes a binary file is served in, per request. 16 KB is 1,024 rows: enough
 *  to read a header by, and few enough DOM lines for a phone. */
export const HEX_PAGE_BYTES = 16 * 1024;

/** How far into a file the binary check looks — git's figure. */
export const BINARY_SNIFF_BYTES = 8000;

export const HEX_ROW_BYTES = 16;

/** Columns a row takes at `rowBytes` bytes: offset, gap, bytes, group gap,
 *  space, gutter. What the view measures against its width. */
export function hexRowColumns(rowBytes: number): number {
  return 8 + 2 + rowBytes * 3 + (rowBytes > 8 ? 1 : 0) + 1 + rowBytes;
}

/** A file is binary if a NUL appears in its first 8000 bytes: git's rule, and
 *  the one every diff tool and pager the operator uses already agrees with.
 *  UTF-16 text reads as binary under it, which is what git shows too. */
export function looksBinary(head: Uint8Array): boolean {
  const n = Math.min(head.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < n; i++) if (head[i] === 0) return true;
  return false;
}

/** One row of the dump, in its three columns. `hex` holds each byte as two
 *  digits and a space, with one more space between the halves of a 16-byte
 *  row, so byte j starts at `hexColumnOf(j, rowBytes)`; `ascii` holds one
 *  character per byte. A short final row is padded so its gutter still lines
 *  up with the rows above it. */
export interface HexRow {
  offset: string;
  hex: string;
  ascii: string;
}

export function hexRows(bytes: Uint8Array, offset = 0, rowBytes = HEX_ROW_BYTES): HexRow[] {
  const rows: HexRow[] = [];
  for (let at = 0; at < bytes.length; at += rowBytes) {
    let hex = "";
    let ascii = "";
    for (let j = 0; j < rowBytes; j++) {
      if (j === 8) hex += " ";
      const i = at + j;
      if (i < bytes.length) {
        const b = bytes[i];
        hex += (b < 16 ? "0" : "") + b.toString(16) + " ";
        ascii += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ".";
      } else {
        hex += "   ";
      }
    }
    rows.push({ offset: hexOffset(offset + at), hex, ascii });
  }
  return rows;
}

/** Where byte `j` of a row starts in its `hex` column. */
export function hexColumnOf(j: number, rowBytes = HEX_ROW_BYTES): number {
  return j * 3 + (rowBytes > 8 && j >= 8 ? 1 : 0);
}

/** `xxd`'s layout: an 8-digit offset, the bytes (sixteen to a row in two
 *  groups of eight, or eight to a row on a phone), and the printable-ASCII
 *  gutter. `offset` is where `bytes` starts in the file, so a later page
 *  numbers its rows where they are. */
export function hexDumpRows(bytes: Uint8Array, offset = 0, rowBytes = HEX_ROW_BYTES): string[] {
  return hexRows(bytes, offset, rowBytes).map((r) => `${r.offset}  ${r.hex} ${r.ascii}`);
}

/** Eight hex digits, more past 4 GiB — the column widens rather than wraps. */
export function hexOffset(n: number): string {
  const s = n.toString(16);
  return s.length >= 8 ? s : "0".repeat(8 - s.length) + s;
}
