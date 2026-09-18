import type { Invoice, Item, Return, StockAdjustment } from "@/types";

const r2 = (n: number) => Math.round(n * 100) / 100;

export interface ItemCost {
  /* ---- Bought ---------------------------------------------------------- */
  /** Every carat ever bought: opening stock + purchases − purchase returns. */
  boughtQty: number;
  /** What all of that cost, as entered, after any line discount. */
  boughtValue: number;
  /** boughtValue / boughtQty — the trade's "Total Buying ÷ Total Carat". */
  avgBuyRate: number;

  /* ---- Sold ------------------------------------------------------------ */
  /** Carats sold, net of anything customers sent back. */
  soldQty: number;
  /** What those sales brought in, on the same basis as boughtValue, net of
   * anything sent back. See lineValue. */
  soldValue: number;

  /* ---- Rest ------------------------------------------------------------ */
  /** Carats still on hand. Tracks Item.stock, adjustments included. */
  restQty: number;
  /** boughtValue − soldValue: the money still tied up in this item. */
  restValue: number;
  /** restValue / restQty — what the remaining carats must still fetch. */
  restRate: number;

  /** False when the item has no purchase history at all, so the rates rest on
   * the catalogue purchase price rather than on what was really paid. The UI
   * says so rather than presenting a guess as a fact. */
  derived: boolean;
}

/**
 * Item economics the way the diamond trade actually keeps them.
 *
 * This is the client's own working, from their spreadsheet:
 *
 *     bought   5.20 ct    33,332
 *              2.84 ct   101,372
 *              ────────────────────
 *              8.04 ct   134,704     per ct  16,754.23
 *
 *     sale     2.45 ct    25,051
 *     rest     5.59 ct   109,653     per ct  19,615.92
 *
 * Two rates, and they are NOT the same figure:
 *
 *   avgBuyRate = total buying / total carat
 *       What has been paid per carat across the whole book. It never moves
 *       when something is sold.
 *
 *   restRate   = (total buying − sales realised) / carats left
 *       A running BREAK-EVEN: the money still sunk in this item, spread over
 *       what is left to sell it out of. Note what this does — the 2.45 ct
 *       above went out at 10,224.90/ct, below the 16,754.23 it had cost, so
 *       the rate the REMAINING stone has to fetch rises to 19,615.92. That is
 *       the number the trade prices against, and it is the whole point of
 *       keeping it this way.
 *
 * This deliberately replaces a moving weighted average (AVCO), which is the
 * textbook method and was what this file did first. AVCO holds the rate flat
 * through a sale — it would have answered 16,754.23 for the rest above, and
 * so would never have told them they were now under water on the lot.
 *
 * Both sides are measured the same way — the line value as entered, after any
 * line discount; see lineValue for why GST is not added to either. Nothing
 * here is written to a document or to a stored total: it is derived read-only
 * from history on every call, so it cannot drift the way a running total can.
 *
 * Built in ONE pass over every document for ALL items at once — the items
 * list needs this per row, and asking per item would re-scan every invoice
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
  /**
   * What a line is worth to this calculation: its line value, after any line
   * discount — the same measure on BOTH sides, so the subtraction is like for
   * like.
   *
   * GST is deliberately NOT added to the sale side. It was, briefly, because
   * the client's CVD spreadsheet reconciles as "purchases ex-GST less sales
   * INCLUDING GST". That is true of the spreadsheet and false of this app,
   * because the two are fed differently: the rate entered on a bill here
   * already carries the money the customer hands over. Adding GST on top of
   * it counted the tax twice, and it moved a live average the client prices
   * against — CVD went from 16,521.38 to 14,869.41 — which is exactly the
   * kind of silent change a stored figure must never make.
   *
   * If sale rates are ever entered ex-GST instead, this is the one line that
   * would need to change, and the averages would move the day it did.
   */
  const lineValue = (l: Invoice["lineItems"][number]) =>
    l.qty * l.price * (1 - (l.discountPct ?? 0) / 100);

  interface Tally {
    boughtQty: number;
    boughtValue: number;
    soldQty: number;
    soldValue: number;
    adjustQty: number;
    /** Whether any real purchase line was seen, as opposed to only an
     * opening-stock seed. */
    sawPurchase: boolean;
  }
  const tally = new Map<string, Tally>();
  const of = (id: string): Tally => {
    let t = tally.get(id);
    if (!t) {
      t = {
        boughtQty: 0,
        boughtValue: 0,
        soldQty: 0,
        soldValue: 0,
        adjustQty: 0,
        sawPurchase: false,
      };
      tally.set(id, t);
    }
    return t;
  };

  const addLines = (
    docs: { lineItems: Invoice["lineItems"] }[],
    side: "bought" | "sold",
    sign: 1 | -1,
  ) => {
    for (const d of docs) {
      for (const l of d.lineItems) {
        const t = of(l.itemId);
        if (side === "bought") {
          t.boughtQty += sign * l.qty;
          t.boughtValue += sign * lineValue(l);
          if (sign === 1) t.sawPurchase = true;
        } else {
          t.soldQty += sign * l.qty;
          t.soldValue += sign * lineValue(l);
        }
      }
    }
  };

  // A purchase line's `price` is already the LANDED per-unit cost in rupees:
  // an international bill converts foreignPrice at the exchange rate and adds
  // the per-piece carry cost into this very field (see Invoice.carryCostPerUnit),
  // so freight and customs are in the rate rather than missing from it.
  addLines(input.purchases, "bought", 1);
  // Goods sent back to the supplier were never really bought — they come out
  // of the buying pool at exactly what they went in for.
  addLines(input.purchaseReturns, "bought", -1);
  addLines(input.sales, "sold", 1);
  // Money handed back to a customer un-realises that sale, so the stock (and
  // the money still to recover on it) comes back with it.
  addLines(input.saleReturns, "sold", -1);

  for (const a of input.adjustments) {
    // A correction moves carats but no money: it can't change what was paid
    // or received. It does change how many carats the outstanding money has
    // to be recovered across, which is why it counts toward restQty only.
    of(a.itemId).adjustQty += a.type === "add" ? a.qty : -a.qty;
  }

  const out = new Map<string, ItemCost>();
  for (const item of input.items) {
    const t = tally.get(item.id);
    // Opening stock counts as bought — it is stock the business owns and paid
    // for, and leaving it out would quote a rate over only the carats that
    // happen to have a bill in this app. Its cost is the catalogue purchase
    // price, the only figure recorded for stock predating the first bill.
    const boughtQty = r2((item.openingStock || 0) + (t?.boughtQty ?? 0));
    const boughtValue = r2(
      (item.openingStock || 0) * (item.purchasePrice || 0) + (t?.boughtValue ?? 0),
    );
    const soldQty = r2(t?.soldQty ?? 0);
    const soldValue = r2(t?.soldValue ?? 0);

    // bought − sold + adjustments is exactly how Item.stock is maintained, so
    // this figure and the Stock column can never disagree.
    const restQty = r2(boughtQty - soldQty + (t?.adjustQty ?? 0));
    const restValue = r2(boughtValue - soldValue);

    out.set(item.id, {
      boughtQty,
      boughtValue,
      // Guarded: everything bought and then returned leaves a zero divisor,
      // and a rate of Infinity on an item card is worse than no rate at all.
      avgBuyRate: boughtQty > 0 ? r2(boughtValue / boughtQty) : 0,
      soldQty,
      soldValue,
      restQty,
      restValue,
      // Same guard. Sold out (or oversold) leaves nothing to spread the
      // remaining money across, and the answer is "no rate", not a number.
      restRate: restQty > 0 ? r2(restValue / restQty) : 0,
      derived: !!t?.sawPurchase,
    });
  }
  return out;
}
