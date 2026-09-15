import type { Invoice, Payment } from "@/types";

/**
 * Year-wise sale bill numbers — `INV-2026-0001`.
 *
 * Three parts: the prefix from Settings, the financial year, and a serial that
 * restarts at 1 each year.
 *
 * The year is the INDIAN FINANCIAL year (1 April – 31 March), named by the year
 * it starts in: every bill from 1 Apr 2026 to 31 Mar 2027 is an ...-2026-....
 * series, and 1 April 2027 opens ...-2027-0001. That is the year a GST return
 * is filed against, so it is the one a bill series has to follow — a series
 * that rolled over on 1 January would split a single filing year in two.
 *
 * The year comes from the BILL'S OWN DATE, never from today. Back-dating a
 * bill into last year has to put it in last year's series, or the series stops
 * meaning anything.
 *
 * Only sale bills are numbered this way. A purchase bill carries the
 * supplier's own number and a credit/debit note keeps its own run, so both
 * stay on the plain running serial in nextInvoiceNumber.
 */

/** The financial year a date falls in, named by its starting year.
 * 2026-03-31 -> 2025 (the 2025-26 year); 2026-04-01 -> 2026. */
export function financialYearOf(dateIso: string): number {
  const d = new Date(dateIso);
  if (isNaN(d.getTime())) return new Date().getFullYear();
  // getMonth() is 0-based, so April is 3.
  return d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
}

/** "INV-" + 2026 + 0001 -> "INV-2026-0001". */
export function formatBillNumber(prefix: string, fy: number, serial: number): string {
  return `${prefix}${fy}-${String(serial).padStart(4, "0")}`;
}

/**
 * Read a year-wise number back apart, or null if it isn't one.
 *
 * Deliberately anchored to the END of the string and NOT to the current
 * prefix: a bill saved before the prefix was last changed in Settings still
 * has to be recognised as belonging to its year's series, or the next number
 * would collide with it.
 */
export function parseBillNumber(
  number: string,
): { prefix: string; fy: number; serial: number } | null {
  const m = (number ?? "").trim().match(/^(.*?)(\d{4})-(\d+)$/);
  if (!m) return null;
  const fy = parseInt(m[2], 10);
  // A four-digit run that isn't a plausible year is a coincidence in some
  // other numbering scheme (e.g. "2627/586"), not a series marker.
  if (fy < 2000 || fy > 2200) return null;
  return { prefix: m[1], fy, serial: parseInt(m[3], 10) };
}

/**
 * The next sale bill number for `date`'s financial year.
 *
 * Scans only that year's own series for the highest serial, so each year
 * counts from 1 independently. Numbers that predate year-wise numbering (a
 * plain `INV-0009`) are simply not part of any series and are skipped —
 * they can't collide, since the year segment makes the strings different.
 */
export function nextYearwiseNumber(
  prefix: string,
  date: string,
  existing: { number: string }[],
): string {
  const fy = financialYearOf(date);
  let highest = 0;
  for (const inv of existing) {
    const parsed = parseBillNumber(inv.number);
    if (parsed && parsed.fy === fy && parsed.serial > highest) highest = parsed.serial;
  }
  return formatBillNumber(prefix, fy, highest + 1);
}

export interface RenumberRow {
  id: string;
  date: string;
  partyName: string;
  from: string;
  to: string;
  /** Returns whose originalRef points at this bill and must follow the rename. */
  returns: number;
  /** Payments whose allocation/ref names this bill and must follow it. */
  payments: number;
}

export interface RenumberPlan {
  /** Only the bills whose number actually changes. */
  rows: RenumberRow[];
  /** Bills already correctly numbered — counted, not listed. */
  unchanged: number;
  /** Financial years covered, ascending. */
  years: number[];
  hasWork: boolean;
}

/**
 * What renumbering every sale bill year-wise WOULD do — computed, shown, and
 * only then applied.
 *
 * A bill number is on paper a customer already holds and in GST returns that
 * may already be filed, so this is never a one-click action: the caller shows
 * this plan first. Same shape, and the same reason, as planDataRepair.
 *
 * Bills are ordered by their own date (then by when they were entered, so two
 * bills on one day keep the order they were written in) and numbered from 1
 * within each financial year. That is the order the series is supposed to be
 * in; anything else would just re-shuffle the same numbers.
 */
export function planRenumber(
  prefix: string,
  sales: Invoice[],
  links: {
    returns: { originalRef?: string }[];
    payments: { allocations?: { invoiceId: string }[]; ref?: string }[];
  },
): RenumberPlan {
  const byYear = new Map<number, Invoice[]>();
  for (const inv of sales) {
    const fy = financialYearOf(inv.date);
    const list = byYear.get(fy);
    if (list) list.push(inv);
    else byYear.set(fy, [inv]);
  }

  const years = [...byYear.keys()].sort((a, b) => a - b);
  const rows: RenumberRow[] = [];
  let unchanged = 0;

  for (const fy of years) {
    const list = byYear.get(fy)!;
    list.sort(
      (a, b) =>
        a.date.localeCompare(b.date) || (a.createdAt ?? "").localeCompare(b.createdAt ?? ""),
    );
    list.forEach((inv, i) => {
      const to = formatBillNumber(prefix, fy, i + 1);
      const from = (inv.number ?? "").trim();
      if (from === to) {
        unchanged++;
        return;
      }
      rows.push({
        id: inv.id,
        date: inv.date,
        partyName: inv.partyName,
        from,
        to,
        returns: links.returns.filter((r) => (r.originalRef ?? "").trim() === from).length,
        payments: links.payments.filter(
          (p) =>
            p.allocations?.some((a) => a.invoiceId === inv.id) ||
            (p.ref ?? "")
              .split(",")
              .map((t) => t.trim())
              .includes(from),
        ).length,
      });
    });
  }

  return { rows, unchanged, years, hasWork: rows.length > 0 };
}

export interface RenumberWrites {
  sales: { id: string; number: string }[];
  returns: { id: string; originalRef: string }[];
  payments: { id: string; allocations?: Payment["allocations"]; ref?: string }[];
}

/**
 * Every write a renumber has to make — worked out as data, so the caller only
 * has to put it in a batch.
 *
 * A bill number is stored as TEXT in three more places than the bill itself: a
 * return's originalRef, a payment allocation's display number, and the legacy
 * comma-separated `ref` on older payments. Miss any of them and the link goes
 * stale — the return's over-return cap silently stops matching, and a payment
 * shows a bill number that no longer exists.
 *
 * Payment MATHS keys on invoiceId and is unaffected either way; this is about
 * keeping the human-readable links honest. Same cascade a single rename does
 * in InvoiceForm, pulled out here so the bulk path can be tested rather than
 * re-derived by eye.
 */
export function renumberWrites(
  rows: RenumberRow[],
  returns: { id: string; originalRef?: string }[],
  payments: Payment[],
): RenumberWrites {
  const byOldNumber = new Map(rows.map((r) => [r.from, r]));
  const byInvoiceId = new Map(rows.map((r) => [r.id, r]));

  const returnWrites: RenumberWrites["returns"] = [];
  for (const ret of returns) {
    const row = byOldNumber.get((ret.originalRef ?? "").trim());
    if (row) returnWrites.push({ id: ret.id, originalRef: row.to });
  }

  const paymentWrites: RenumberWrites["payments"] = [];
  for (const pay of payments) {
    let changed = false;
    let allocations = pay.allocations;
    if (pay.allocations?.some((a) => byInvoiceId.has(a.invoiceId))) {
      allocations = pay.allocations.map((a) => {
        const row = byInvoiceId.get(a.invoiceId);
        return row ? { ...a, number: row.to } : a;
      });
      changed = true;
    }
    let ref = pay.ref;
    if (pay.ref) {
      const tokens = pay.ref.split(",").map((t) => t.trim());
      if (tokens.some((t) => byOldNumber.has(t))) {
        ref = tokens.map((t) => byOldNumber.get(t)?.to ?? t).join(", ");
        changed = true;
      }
    }
    if (changed) paymentWrites.push({ id: pay.id, allocations, ref });
  }

  return {
    sales: rows.map((r) => ({ id: r.id, number: r.to })),
    returns: returnWrites,
    payments: paymentWrites,
  };
}
