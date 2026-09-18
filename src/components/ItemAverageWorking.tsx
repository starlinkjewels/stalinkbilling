import { useState } from "react";
import {
  ItemRepo,
  SalesRepo,
  PurchaseRepo,
  SaleReturnRepo,
  PurchaseReturnRepo,
  StockAdjustmentRepo,
} from "@/repositories";
import { useRepoMemo } from "@/hooks/useRepoData";
import { itemWorking, type WorkingRow } from "@/lib/avgCost";
import { fmtDateShort, fmtMoney, fmtQty } from "@/lib/format";
import type { Item } from "@/types";
import { ChevronDown, ChevronRight, Calculator } from "lucide-react";

/**
 * The client's own average working, printed the way they keep it in Excel:
 * a purchase half and a sale half, line by line, each column totalled, with
 * the per-carat figure falling out of the two totals at the top.
 *
 * Why this exists at all: the Average shown elsewhere is one number, and one
 * number cannot be checked. When it disagreed with their sheet there was no
 * way to tell whether the method was wrong or a bill had been entered
 * differently — so this shows the whole working, on the rows the app actually
 * holds. A mismatch can now be found on the line where it happens.
 *
 * It does NOT recompute anything: itemWorking shares its measurement rules
 * with buildAverageCosts, and the audit pins their totals together, so what
 * is printed here is the arithmetic behind the Average stat above it.
 */
export function ItemAverageWorking({ item }: { item: Item }) {
  const [open, setOpen] = useState(true);

  const w = useRepoMemo(
    () =>
      itemWorking(item.id, {
        item: ItemRepo.get(item.id) ?? item,
        purchases: PurchaseRepo.all(),
        sales: SalesRepo.all(),
        saleReturns: SaleReturnRepo.all(),
        purchaseReturns: PurchaseReturnRepo.all(),
        adjustments: StockAdjustmentRepo.all(),
      }),
    [item.id],
  );

  const unit = item.unit || "ct";

  return (
    <div className="bg-white border rounded-lg shadow-sm overflow-hidden max-w-5xl mx-auto mb-5">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full px-5 py-3 border-b flex items-center gap-2 text-left hover:bg-gray-50 transition"
      >
        {open ? (
          <ChevronDown className="h-4 w-4 text-gray-400" />
        ) : (
          <ChevronRight className="h-4 w-4 text-gray-400" />
        )}
        <Calculator className="h-4 w-4 text-primary" />
        <p className="text-sm font-bold text-gray-800">Average Working</p>
        <p className="text-[11px] text-gray-400 ml-1 hidden sm:block">
          every purchase and sale behind the average
        </p>
      </button>

      {open && (
        <>
          {/* The three figures their sheet carries at the top. */}
          <div className="grid grid-cols-3 border-b bg-primary-soft/40">
            <Head label="Total Rs" value={fmtMoney(w.restValue)} />
            <Head label={`Per ${unit}`} value={w.restQty > 0 ? fmtMoney(w.restRate) : "—"} strong />
            <Head label="Stock" value={`${fmtQty(w.restQty)} ${unit}`} last />
          </div>

          <div className="overflow-x-auto">
            <Half
              title="Purchase"
              rows={w.purchases}
              unit={unit}
              qty={w.boughtQty}
              taxable={w.boughtValue}
              gst={w.boughtGst}
              /* The purchase half is totalled EX-GST — that GST comes back as
                 input credit, so it was never a cost of the goods. */
              countedColumn="taxable"
            />
            <Half
              title="Sale"
              rows={w.sales}
              unit={unit}
              qty={w.soldQty}
              taxable={w.soldValue - w.soldGst}
              gst={w.soldGst}
              /* The sale half is totalled INCLUDING GST — that is the money
                 the customer actually handed over against the bill. */
              countedColumn="gross"
            />
          </div>

          {/* The subtraction itself, spelled out, so the per-carat figure above
              can be checked without doing the sum in your head. */}
          <div className="px-5 py-3 border-t bg-gray-50 text-[12px] text-gray-600 space-y-1">
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="tabular-nums font-semibold text-gray-800">
                {fmtQty(w.boughtValue)}
              </span>
              <span className="text-gray-400">purchased</span>
              <span className="text-gray-400">−</span>
              <span className="tabular-nums font-semibold text-gray-800">
                {fmtQty(w.soldValue)}
              </span>
              <span className="text-gray-400">sold</span>
              <span className="text-gray-400">=</span>
              <span className="tabular-nums font-bold text-gray-900">{fmtQty(w.restValue)}</span>
              <span className="text-gray-400">still to recover</span>
            </p>
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="tabular-nums font-semibold text-gray-800">
                {fmtQty(w.restValue)}
              </span>
              <span className="text-gray-400">÷</span>
              <span className="tabular-nums font-semibold text-gray-800">
                {fmtQty(w.restQty)} {unit}
              </span>
              {w.adjustQty !== 0 && (
                <span className="text-gray-400">
                  (includes {w.adjustQty > 0 ? "+" : "−"}
                  {fmtQty(Math.abs(w.adjustQty))} {unit} stock correction)
                </span>
              )}
              <span className="text-gray-400">=</span>
              <span className="tabular-nums font-bold text-primary">
                {w.restQty > 0 ? fmtQty(w.restRate) : "—"}
              </span>
              <span className="text-gray-400">per {unit}</span>
            </p>
          </div>
        </>
      )}
    </div>
  );
}

function Head({
  label,
  value,
  strong,
  last,
}: {
  label: string;
  value: string;
  strong?: boolean;
  last?: boolean;
}) {
  return (
    <div className={`px-4 py-2.5 ${last ? "" : "border-r border-primary/15"}`}>
      <p className="text-[9px] font-semibold uppercase tracking-wider text-gray-500">{label}</p>
      <p
        className={`tabular-nums font-bold ${strong ? "text-[16px] text-primary" : "text-[14px] text-gray-800"}`}
      >
        {value}
      </p>
    </div>
  );
}

/** One half of the sheet — purchases or sales — with its column totals. */
function Half({
  title,
  rows,
  unit,
  qty,
  taxable,
  gst,
  countedColumn,
}: {
  title: string;
  rows: WorkingRow[];
  unit: string;
  qty: number;
  taxable: number;
  gst: number;
  /** Which money column adds up to the total this side contributes. It is
   * tinted in the table so the asymmetry between the two halves is visible
   * rather than something you have to be told about. */
  countedColumn: "taxable" | "gross";
}) {
  const counted = (c: "taxable" | "gross") =>
    c === countedColumn ? "bg-primary-soft/40 font-semibold text-gray-900" : "text-gray-600";

  return (
    <table className="w-full text-[12px] border-collapse min-w-[680px]">
      <thead>
        <tr className="bg-gray-100">
          <th
            colSpan={8}
            className="px-4 py-1.5 text-left text-[10px] font-bold uppercase tracking-wider text-gray-600 border-b border-gray-200"
          >
            {title}
          </th>
        </tr>
        <tr className="bg-gray-50">
          {["Date", title === "Sale" ? "Bill No" : "Ref", "Party"].map((h) => (
            <th
              key={h}
              className="px-4 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-gray-500 border-b border-gray-200 whitespace-nowrap"
            >
              {h}
            </th>
          ))}
          {[unit, `P/${unit}`, "Total Rs", "GST", "Total GST"].map((h) => (
            <th
              key={h}
              className="px-4 py-2 text-right text-[10px] font-semibold uppercase tracking-wider text-gray-500 border-b border-gray-200 whitespace-nowrap"
            >
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 ? (
          <tr>
            <td colSpan={8} className="text-center py-6 text-gray-400">
              No {title.toLowerCase()} entries yet
            </td>
          </tr>
        ) : (
          rows.map((r, i) => (
            <tr key={`${r.id}-${i}`} className="border-b border-gray-100 hover:bg-gray-50/60">
              <td className="px-4 py-2 text-gray-600 whitespace-nowrap">
                {r.date ? fmtDateShort(r.date) : "—"}
              </td>
              <td className="px-4 py-2 font-mono text-[11px] text-blue-600 whitespace-nowrap">
                {r.ref}
                {/* A negative row is a return, not a keying mistake. */}
                {r.isReturn && (
                  <span className="ml-1 text-[9px] font-sans font-semibold uppercase text-rose-500">
                    ret
                  </span>
                )}
              </td>
              <td className="px-4 py-2 font-medium text-gray-800 max-w-[180px] truncate">
                {r.party}
              </td>
              <td
                className={`px-4 py-2 text-right tabular-nums ${r.qty < 0 ? "text-rose-600" : "text-gray-800"}`}
              >
                {fmtQty(r.qty)}
              </td>
              <td className="px-4 py-2 text-right tabular-nums text-gray-600">{fmtQty(r.rate)}</td>
              <td className={`px-4 py-2 text-right tabular-nums ${counted("taxable")}`}>
                {fmtQty(r.taxable)}
              </td>
              <td className="px-4 py-2 text-right tabular-nums text-gray-500">{fmtQty(r.gst)}</td>
              <td className={`px-4 py-2 text-right tabular-nums ${counted("gross")}`}>
                {fmtQty(r.gross)}
              </td>
            </tr>
          ))
        )}
      </tbody>
      <tfoot>
        <tr className="border-y-2 border-gray-200 bg-gray-50">
          <td
            colSpan={3}
            className="px-4 py-2 text-[10px] font-bold uppercase tracking-wider text-gray-600"
          >
            Total
          </td>
          <td className="px-4 py-2 text-right tabular-nums font-bold text-gray-900">
            {fmtQty(qty)}
          </td>
          {/* Per-carat across the whole half — total money over total carat,
              which is not the average of the P/ct column above it. */}
          <td className="px-4 py-2 text-right tabular-nums font-semibold text-gray-600">
            {qty ? fmtQty((countedColumn === "gross" ? taxable + gst : taxable) / qty) : "—"}
          </td>
          <td className={`px-4 py-2 text-right tabular-nums font-bold ${counted("taxable")}`}>
            {fmtQty(taxable)}
          </td>
          <td className="px-4 py-2 text-right tabular-nums font-semibold text-gray-500">
            {fmtQty(gst)}
          </td>
          <td className={`px-4 py-2 text-right tabular-nums font-bold ${counted("gross")}`}>
            {fmtQty(taxable + gst)}
          </td>
        </tr>
      </tfoot>
    </table>
  );
}
