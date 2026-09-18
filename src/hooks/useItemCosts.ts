import { useRepoMemo } from "@/hooks/useRepoData";
import { buildAverageCosts, type ItemCost } from "@/lib/avgCost";
import {
  ItemRepo,
  PurchaseRepo,
  SalesRepo,
  SaleReturnRepo,
  PurchaseReturnRepo,
  StockAdjustmentRepo,
} from "@/repositories";

/**
 * Every item's average rate and the money still tied up in it, keyed by item id.
 *
 * One place that wires the six collections together, because four screens need
 * the same map — the Items list, an item's own page, Inventory and the stock
 * report — and the figure they show has to be the same figure on all of them.
 * Wiring it up separately per screen is how one of them quietly ends up
 * passing, say, no stock adjustments and reporting a different rate.
 *
 * Keyed on the repo version (useRepoMemo), so it recomputes when a bill lands
 * and not on every render: it replays the whole document history.
 */
export function useItemCosts(): Map<string, ItemCost> {
  return useRepoMemo(
    () =>
      buildAverageCosts({
        items: ItemRepo.all(),
        purchases: PurchaseRepo.all(),
        sales: SalesRepo.all(),
        saleReturns: SaleReturnRepo.all(),
        purchaseReturns: PurchaseReturnRepo.all(),
        adjustments: StockAdjustmentRepo.all(),
      }),
    [],
  );
}

/**
 * What an item's remaining stock is worth: the money still to recover on it.
 *
 * This is the client's own basis — total buying less what sales have already
 * brought in — so it equals the item's Average rate times the carats left, and
 * a row showing all three multiplies out. It replaces carats x latest purchase
 * price, which was only ever a proxy and disagreed with the Average beside it.
 *
 * It can be NEGATIVE, and that is meaningful rather than a fault: a lot that
 * has already sold for more than it cost has nothing left to recover, and what
 * remains is clear profit. Callers show that in red rather than hiding it.
 */
export function stockValueOf(costs: Map<string, ItemCost>, itemId: string): number {
  return costs.get(itemId)?.restValue ?? 0;
}
