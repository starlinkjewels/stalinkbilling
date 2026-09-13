import type { Invoice, Item, Return, StockAdjustment } from "@/types";

const r2 = (n: number) => Math.round(n * 100) / 100;

export interface ItemCost {
  /**
   * Weighted average cost of the stock STILL ON HAND — the break-even rate.
   * Sell below this and the line loses money.
   */
  avgCost: number;
  /** The quantity that average was arrived at. Tracks Item.stock. */
  onHand: number;
  /** onHand x avgCost — what the remaining stock actually cost to acquire. */
  value: number;
  /** False when the item has no purchase history at all, so `avgCost` is only
   * the catalogue purchase price rather than a figure derived from what was
   * really paid. The UI says so rather than presenting a guess as a fact. */
  derived: boolean;
}

/** One stock movement, in the order it happened. */
interface Move {
  date: string;
  created: string;
  qty: number;
  /** Acquisition rate for an inward move; ignored for outward ones. */
  rate?: number;
}

/**
 * Moving weighted average cost per item.
 *
 * What the client asked for, in their words: goods bought at a price go into a
 * pool, what is sold comes back out of it, and the average of what remains is
 * the least they can sell at without making a loss.
 *
 * That is the standard moving-weighted-average (AVCO) method:
 *
 *   in  : avg = (onHand x avg + qty x rate) / (onHand + qty);  onHand += qty
 *   out : onHand -= qty                                     ;  avg unchanged
 *
 * Only INWARD moves can change the average — selling stock never changes what
 * the rest of it cost. This is deliberately NOT the same figure as the P&L's
 * cost of goods sold, which values each sale at the cost snapshot taken on its
 * own line (see computeCogs). Both are legitimate and they answer different
 * questions: COGS asks "what did the goods on THIS bill cost", this asks "what
 * is the floor price for what is left on the shelf". Nothing here writes to a
 * document or changes a stored total — it is derived, read-only, and recomputed
 * from history every time, so it cannot drift the way a stored running total
 * can.
 *
 * Built in ONE pass over every document for ALL items at once: the items list
 * needs this for every row, and asking per item would re-scan every invoice
 * once per item.
 */
export function buildAverageCosts(input: {
  items: Item[];
  purchases: Invoice[];
  sales: Invoice[];
  saleReturns: Return[];
  purchaseReturns: Return[];
  adjustments: StockAdjustment[];
}): Map<string, ItemCost> {
  const moves = new Map<string, Move[]>();
  const push = (itemId: string, m: Move) => {
    const list = moves.get(itemId);
    if (list) list.push(m);
    else moves.set(itemId, [m]);
  };

  const collectLines = (
    docs: { date: string; createdAt: string; lineItems: Invoice["lineItems"] }[],
    sign: 1 | -1,
    rateOf?: (l: Invoice["lineItems"][number]) => number | undefined,
  ) => {
    for (const d of docs) {
      for (const l of d.lineItems) {
        push(l.itemId, {
          date: d.date,
          created: d.createdAt ?? "",
          qty: sign * l.qty,
          rate: rateOf?.(l),
        });
      }
    }
  };

  // A purchase line's `price` is already the LANDED per-unit cost in rupees:
  // an international bill converts foreignPrice at the exchange rate and adds
  // the per-piece carry cost into this very field (see Invoice.carryCostPerUnit),
  // so freight and customs are in the average rather than missing from it.
  collectLines(input.purchases, 1, (l) => l.price * (1 - (l.discountPct ?? 0) / 100));
  collectLines(input.purchaseReturns, -1);
  collectLines(input.sales, -1);
  // Goods coming back from a customer re-enter at what they COST, never at
  // what they were sold for — crediting stock at the sale price would inflate
  // the average by the whole margin and quietly raise the break-even price.
  // `costPrice` is the snapshot taken when the line was billed; with no
  // snapshot the running average is used, which leaves the average untouched.
  collectLines(input.saleReturns, 1, (l) => l.costPrice);

  for (const a of input.adjustments) {
    push(a.itemId, {
      date: a.date,
      created: a.createdAt ?? "",
      qty: a.type === "add" ? a.qty : -a.qty,
      // An adjustment carries no price. Adding stock at the running average
      // is the neutral choice: valuing found stock at zero would drag the
      // break-even below what the goods really cost.
      rate: undefined,
    });
  }

  const out = new Map<string, ItemCost>();
  for (const item of input.items) {
    const list = moves.get(item.id) ?? [];
    list.sort((a, b) => a.date.localeCompare(b.date) || a.created.localeCompare(b.created));

    // Opening stock is seeded at the item's purchase price — the only cost
    // this app ever records for stock that predates its first bill. Same
    // fallback computeCogs uses, so the two agree about untraded items.
    let onHand = item.openingStock || 0;
    let avg = item.purchasePrice || 0;

    for (const m of list) {
      if (m.qty > 0) {
        const rate = m.rate ?? avg;
        // Only average against a POSITIVE holding. Blending into a negative
        // (oversold) balance divides by a quantity heading through zero and
        // produces a wild rate; restocking from a short position simply takes
        // the incoming rate as the new average.
        avg = onHand > 0 ? (onHand * avg + m.qty * rate) / (onHand + m.qty) : rate;
        onHand += m.qty;
      } else {
        // Selling never changes what the remaining stock cost.
        onHand += m.qty;
      }
    }

    onHand = r2(onHand);
    const derived = list.some((m) => m.qty > 0 && m.rate != null);
    out.set(item.id, {
      avgCost: r2(avg),
      onHand,
      value: r2(onHand * avg),
      derived,
    });
  }
  return out;
}
