import type Database from "better-sqlite3";
import { priceMessage, priceMessageV1, legacyInputPriceV1 } from "./pricing.js";
import type { MessageUsage } from "./pricing.js";

// `brane cost reprice`: the explicit re-pricing the Cost Ledger section has
// always said the ledger makes possible. Entry rows carry the model and token
// counts that priced them, so a corrected price table can be applied to what
// was already recorded — including messages whose transcript is long gone.
//
// One fact is missing from older rows: `cache_write` holds 5-minute and
// 1-hour writes together, and they bill at 1.25× and 2× input. It is
// recoverable, because the amount on the row was produced by a known table
// (LEGACY_PRICES_V1) from exactly those tokens: pricing every write as
// 5-minute undershoots the amount by 0.75 × input × (1-hour tokens). A
// recovered split is accepted only if it is a whole number of tokens inside
// [0, cache_write] that reproduces the recorded amount; anything else — a row
// priced under a pricing.json override, say — is left alone and counted as
// unrecoverable. The first reprice writes the split it recovers, so later
// ones read it and never infer again.

/** Relative tolerance for "reproduces the recorded amount". Amounts are
 *  doubles computed once from integers, so an honest row matches to ~1e-15. */
const EPSILON = 1e-9;

interface LedgerRow {
  key: string;
  narrative_id: string;
  model: string;
  amount: number;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  cache_write_1h: number | null;
  speed: string | null;
}

/** The 1-hour share of a V1-priced row's `cache_write`, or null when the
 *  recorded amount admits no consistent split. Exported for the tests. */
export function recoverCacheWrite1h(row: {
  model: string;
  amount: number;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
}): number | null {
  const all5m: MessageUsage = {
    input: row.input,
    output: row.output,
    cacheRead: row.cache_read,
    cacheWrite5m: row.cache_write,
    cacheWrite1h: 0,
  };
  const pin = legacyInputPriceV1(row.model);
  const w1 = Math.round(((row.amount - priceMessageV1(row.model, all5m)) * 1e6) / (0.75 * pin));
  if (!(w1 >= 0 && w1 <= row.cache_write)) return null;
  const check = priceMessageV1(row.model, { ...all5m, cacheWrite5m: row.cache_write - w1, cacheWrite1h: w1 });
  const scale = Math.max(Math.abs(row.amount), 1e-6);
  return Math.abs(check - row.amount) <= EPSILON * scale ? w1 : null;
}

export interface RepriceModelLine {
  model: string;
  rows: number;
  changed: number;
  before: number;
  after: number;
}

export interface RepriceNarrativeLine {
  nid: string;
  /** Ledger sum before and after. */
  ledger_before: number;
  ledger_after: number;
  /** narratives.cost_amount before and after (null when never sampled). */
  column_before: number | null;
  column_after: number | null;
}

export interface RepriceResult {
  dry_run: boolean;
  /** Entry rows with a model and tokens — the ones a reprice can price. */
  scanned: number;
  changed: number;
  /** Rows whose 5m/1h split was recovered (and, unless dry, now recorded). */
  recovered: number;
  /** Rows whose split could not be recovered; their amount is left alone. */
  unrecoverable: number;
  models: RepriceModelLine[];
  narratives: RepriceNarrativeLine[];
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

/** Re-price every USD entry row that carries a model and token counts under
 *  the current table, and move each affected narrative's cached
 *  `cost_amount` by the same delta. Moving the column by the delta, rather
 *  than resetting it to the ledger sum, is deliberate: a column above the
 *  ledger sum holds pre-ledger cost from transcripts that may be gone
 *  (sampleNarrativeCostDetailed keeps it for that reason), and a reprice must
 *  correct the rows it touched without discarding that. One transaction; a
 *  dry run computes the same result and writes nothing. */
export function repriceLedger(db: Database.Database, opts: { dryRun?: boolean } = {}): RepriceResult {
  const rows = db
    .prepare(
      `SELECT key, narrative_id, model, amount, input, output, cache_read, cache_write, cache_write_1h, speed
         FROM usage_ledger
        WHERE unit = 'USD' AND model IS NOT NULL
          AND input IS NOT NULL AND output IS NOT NULL
          AND cache_read IS NOT NULL AND cache_write IS NOT NULL
        ORDER BY key`,
    )
    .all() as LedgerRow[];

  const models = new Map<string, RepriceModelLine>();
  const deltas = new Map<string, number>();
  const updates: Array<{ key: string; amount: number; w1: number }> = [];
  let recovered = 0;
  let unrecoverable = 0;

  for (const row of rows) {
    const line = models.get(row.model) ?? { model: row.model, rows: 0, changed: 0, before: 0, after: 0 };
    models.set(row.model, line);
    line.rows++;
    line.before += row.amount;

    let w1 = row.cache_write_1h;
    if (w1 === null) {
      w1 = recoverCacheWrite1h(row);
      if (w1 === null) {
        unrecoverable++;
        line.after += row.amount;
        continue;
      }
      recovered++;
    }
    const amount = priceMessage(row.model, {
      input: row.input,
      output: row.output,
      cacheRead: row.cache_read,
      cacheWrite5m: row.cache_write - w1,
      cacheWrite1h: w1,
      speed: row.speed ?? undefined,
    });
    line.after += amount;
    const changed = Math.abs(amount - row.amount) > EPSILON * Math.max(Math.abs(row.amount), 1e-6);
    if (changed) {
      line.changed++;
      deltas.set(row.narrative_id, (deltas.get(row.narrative_id) ?? 0) + (amount - row.amount));
    }
    if (changed || row.cache_write_1h === null) {
      updates.push({ key: row.key, amount: changed ? amount : row.amount, w1 });
    }
  }

  const ledgerSum = db.prepare(
    "SELECT SUM(amount) AS amount FROM usage_ledger WHERE narrative_id = ? AND unit = 'USD'",
  );
  const column = db.prepare("SELECT cost_amount, cost_unit FROM narratives WHERE id = ?");
  const narratives: RepriceNarrativeLine[] = [];
  for (const [nid, delta] of deltas) {
    const before = (ledgerSum.get(nid) as { amount: number | null }).amount ?? 0;
    const after = before + delta;
    const col = column.get(nid) as { cost_amount: number | null; cost_unit: string | null } | undefined;
    const colBefore = col && col.cost_unit === "USD" ? col.cost_amount : null;
    narratives.push({
      nid,
      ledger_before: round6(before),
      ledger_after: round6(after),
      column_before: colBefore,
      column_after: colBefore === null ? null : round6(Math.max(after, colBefore + delta)),
    });
  }
  narratives.sort((a, b) => a.ledger_after - a.ledger_before - (b.ledger_after - b.ledger_before));

  if (!opts.dryRun) {
    const setRow = db.prepare("UPDATE usage_ledger SET amount = ?, cache_write_1h = ? WHERE key = ?");
    const setColumn = db.prepare("UPDATE narratives SET cost_amount = ? WHERE id = ? AND cost_unit = 'USD'");
    db.transaction(() => {
      for (const u of updates) setRow.run(u.amount, u.w1, u.key);
      for (const n of narratives) {
        if (n.column_after !== null) setColumn.run(n.column_after, n.nid);
      }
    })();
  }

  const modelLines = [...models.values()]
    .map((m) => ({ ...m, before: round6(m.before), after: round6(m.after) }))
    .sort((a, b) => b.before - a.before);
  return {
    dry_run: !!opts.dryRun,
    scanned: rows.length,
    changed: modelLines.reduce((n, m) => n + m.changed, 0),
    recovered,
    unrecoverable,
    models: modelLines,
    narratives,
  };
}
