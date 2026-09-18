import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import {
  SalesRepo,
  PurchaseRepo,
  PartyRepo,
  ItemRepo,
  ExpenseRepo,
  BankRepo,
  PaymentRepo,
  SaleReturnRepo,
  PurchaseReturnRepo,
  CashAdjustmentRepo,
} from "@/repositories";
import { useRepoData } from "@/hooks/useRepoData";
import { useItemCosts } from "@/hooks/useItemCosts";
import type {
  Invoice,
  Return,
  Party,
  Item,
  Expense,
  BankAccount,
  Payment,
  CashAdjustment,
} from "@/types";
import { fmtMoney, ymd, fmtQty } from "@/lib/format";
import {
  netPartyPositions,
  cashFlows,
  netFlow,
  computeCogs,
  bankFlows,
  valueExTax,
  totalSettlementDiscount,
} from "@/lib/ledger";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import {
  ArrowDownLeft,
  ArrowUpRight,
  ChevronRight,
  ChevronDown,
  FileText,
  LayoutList,
  BookOpen,
  Users,
  Plus,
  Package,
  TrendingUp,
} from "lucide-react";

export const Route = createFileRoute("/")({ component: Dashboard });

type Period = "this_month" | "last_month" | "this_year";

// Local-timezone string ranges — comparing YYYY-MM-DD strings avoids the
// UTC shift that drops last-day/first-day transactions in Indian time
function getPeriodRange(period: Period): { start: string; end: string; label: string } {
  const now = new Date();
  if (period === "this_month") {
    return {
      start: ymd(new Date(now.getFullYear(), now.getMonth(), 1)),
      end: ymd(new Date(now.getFullYear(), now.getMonth() + 1, 0)),
      label: "This Month",
    };
  }
  if (period === "last_month") {
    return {
      start: ymd(new Date(now.getFullYear(), now.getMonth() - 1, 1)),
      end: ymd(new Date(now.getFullYear(), now.getMonth(), 0)),
      label: "Last Month",
    };
  }
  return {
    start: ymd(new Date(now.getFullYear(), 0, 1)),
    end: ymd(new Date(now.getFullYear(), 11, 31)),
    label: "This Year",
  };
}

const r2 = (n: number) => Math.round(n * 100) / 100;

function inRange(dateStr: string, start: string, end: string) {
  return dateStr >= start && dateStr <= end;
}

function buildChartData(sales: Invoice[], start: string, end: string) {
  const days: { date: string; amount: number }[] = [];
  const [y, m, d] = start.split("-").map(Number);
  const cur = new Date(y, m - 1, d);
  while (ymd(cur) <= end) {
    const key = ymd(cur);
    const amt = sales.filter((s) => s.date === key).reduce((acc, s) => acc + (s.total || 0), 0);
    days.push({ date: key, amount: amt });
    cur.setDate(cur.getDate() + 1);
  }
  return days;
}

/** Dashboard money, always to the paisa.
 *
 * Was maximumFractionDigits: 0, which silently dropped the decimals from
 * every headline figure — a receivable of 22,251.40 read as 22,251 here and
 * as 22,251.40 on the party statement, and the two looked like a discrepancy
 * rather than the same number shown twice. */
function fmt(n: number) {
  return new Intl.NumberFormat("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n || 0);
}

function Dashboard() {
  const _repoV = useRepoData();
  const navigate = useNavigate();
  const [period, setPeriod] = useState<Period>("this_month");
  const [showPeriodMenu, setShowPeriodMenu] = useState(false);
  const [partyListOpen, setPartyListOpen] = useState<"receivable" | "payable" | null>(null);
  const [data, setData] = useState<{
    sales: Invoice[];
    purchases: Invoice[];
    parties: Party[];
    items: Item[];
    expenses: Expense[];
    banks: BankAccount[];
    payments: Payment[];
    saleReturns: Return[];
    purchaseReturns: Return[];
    cashAdjustments: CashAdjustment[];
  }>({
    sales: [],
    purchases: [],
    parties: [],
    items: [],
    expenses: [],
    banks: [],
    payments: [],
    saleReturns: [],
    purchaseReturns: [],
    cashAdjustments: [],
  });

  useEffect(() => {
    setData({
      sales: SalesRepo.all(),
      purchases: PurchaseRepo.all(),
      parties: PartyRepo.all(),
      items: ItemRepo.all(),
      expenses: ExpenseRepo.all(),
      banks: BankRepo.all(),
      payments: PaymentRepo.all(),
      saleReturns: SaleReturnRepo.all(),
      purchaseReturns: PurchaseReturnRepo.all(),
      cashAdjustments: CashAdjustmentRepo.all(),
    });
  }, [_repoV]);

  // Memoize the range so it's a stable reference while `period` is unchanged —
  // otherwise every downstream useMemo keyed on start/end (chart, COGS) would
  // see fresh objects each render and never actually cache.
  const { start, end, label: periodLabel } = useMemo(() => getPeriodRange(period), [period]);

  const periodSales = data.sales.filter((s) => inRange(s.date, start, end));
  const periodPurchases = data.purchases.filter((s) => inRange(s.date, start, end));
  const periodExpenses = data.expenses.filter((s) => inRange(s.date, start, end));

  const totalSale = periodSales.reduce((a, s) => a + (s.total || 0), 0);
  const totalPurchase = periodPurchases.reduce((a, s) => a + (s.total || 0), 0);
  const totalExpense = periodExpenses.reduce((a, s) => a + (s.amount || 0), 0);

  const periodSaleReturns = data.saleReturns.filter((r) => inRange(r.date, start, end));
  const totalSaleReturn = periodSaleReturns.reduce((a, r) => a + (r.total || 0), 0);

  // Same per-party balance rules as the Customer/Supplier Ledger reports,
  // so the dashboard and reports always agree (returns and advances included)
  // These aggregates are all-time (not period-scoped) and scan every document,
  // so they're memoized on `data` — recomputing them on every unrelated render
  // (opening a dropdown, the party dialog) was the dashboard's perf cost at
  // scale. Values are identical to the inline version; only the frequency drops.
  // ONE net position per party, then split by its sign — see
  // netPartyPositions. Summing a customer side and a supplier side
  // separately put a party who owed money AND had been sold goods on BOTH
  // tiles at once, so the dashboard disagreed with that party's own
  // statement. A party now appears on exactly one side, or neither.
  const positions = useMemo(
    () =>
      netPartyPositions(data.parties, {
        sales: data.sales,
        purchases: data.purchases,
        saleReturns: data.saleReturns,
        purchaseReturns: data.purchaseReturns,
        payments: data.payments,
      }),
    [data],
  );
  const customerBalances = useMemo(
    () =>
      positions
        .filter((p) => p.net > 0.01)
        .map((p) => ({ partyId: p.partyId, name: p.name, balance: p.net })),
    [positions],
  );
  const supplierBalances = useMemo(
    () =>
      positions
        .filter((p) => p.net < -0.01)
        .map((p) => ({ partyId: p.partyId, name: p.name, balance: -p.net })),
    [positions],
  );
  const receivable = customerBalances.reduce((a, b) => a + b.balance, 0);
  const payable = supplierBalances.reduce((a, b) => a + b.balance, 0);
  const receivableParties = customerBalances.length;
  const payableParties = supplierBalances.length;

  /* The per-item figures the client works to (see lib/avgCost.ts):
       Average    — what the carats left must still fetch, per carat
       Stock      — the carats left
       Stock Value— Average x Stock, i.e. the money still to recover

     Stock Value used to be carats x the latest purchase price. That was only
     ever a proxy, and once the Average sat next to it the two visibly failed
     to multiply out. It is now the client's own basis, the same one their CVD
     sheet totals: 9.96 ct at 16,522.23 = 1,64,561, their "TOTAL RS".

     It can go NEGATIVE — a lot already sold for more than it cost has nothing
     left to recover — and that is shown rather than floored, in red. */
  const itemCosts = useItemCosts();
  const stockRows = useMemo(
    () =>
      data.items
        .map((i) => {
          const ac = itemCosts.get(i.id);
          return {
            id: i.id,
            name: i.name,
            unit: i.unit,
            /* The DERIVED carats — bought less sold, plus adjustments — not the
               stored Item.stock. The two are the same number whenever the
               stored total is right, and this is the one the other two columns
               are built from, so the row always multiplies out. Where they do
               differ, the stored total has drifted from the documents behind
               it and Settings → Fix Calculations is what puts it back. */
            stock: ac?.restQty ?? 0,
            // null, not 0, when there is nothing left to spread the money
            // over — the cell then prints a dash instead of dividing by zero.
            // A NEGATIVE rate is a real answer, not a missing one (the lot has
            // already sold for more than it cost), so it must not be lumped in
            // with "no answer" or the row stops multiplying out.
            avg: ac && ac.restQty > 0 ? ac.restRate : null,
            value: ac?.restValue ?? 0,
          };
        })
        .filter((r) => r.stock !== 0)
        .sort((a, b) => b.value - a.value),
    [data.items, itemCosts],
  );
  const stockValue = stockRows.reduce((a, r) => a + r.value, 0);
  const topStock = stockRows.slice(0, 6);
  const cashInHand = useMemo(
    () =>
      netFlow(
        cashFlows(data.sales, data.purchases, data.expenses, data.payments, data.cashAdjustments),
      ),
    [data],
  );
  // Stored account balances + all bank/UPI/cheque activity (sales, purchases, expenses, payments)
  const bankBalance = useMemo(
    () =>
      data.banks.reduce((a, b) => a + (b.balance ?? b.openingBalance ?? 0), 0) +
      netFlow(bankFlows(data.sales, data.purchases, data.expenses, data.payments)),
    [data],
  );

  // Profit like the P&L report: net revenue − cost of goods sold − expenses.
  // Deliberately NOT totalSale/totalSaleReturn: those are the headline
  // invoice values (what the KPI cards show, GST included, which is what a
  // shopkeeper means by "today's sales"), but GST collected is owed onward
  // and is not earnings — and COGS is tax-exclusive. Mixing them overstated
  // profit by exactly the period's output GST.
  const periodCogs = useMemo(
    () =>
      computeCogs(
        data.sales.filter((s) => inRange(s.date, start, end)),
        data.saleReturns.filter((r) => inRange(r.date, start, end)),
        data.items,
      ),
    [data, start, end],
  );
  // Matches the P&L report exactly, including amounts waived at settlement
  // (see totalSettlementDiscount) — those reduce profit even though no cash
  // ever moved for them.
  const periodPayments = data.payments.filter((p) => inRange(p.date, start, end));
  const netProfit = r2(
    valueExTax(periodSales) -
      valueExTax(periodSaleReturns) -
      periodCogs -
      totalExpense -
      totalSettlementDiscount(periodPayments.filter((p) => p.type === "in")) +
      totalSettlementDiscount(periodPayments.filter((p) => p.type === "out")),
  );

  const lowStock = data.items.filter(
    (i) => (i.minStock != null && i.stock <= i.minStock) || i.stock < 0,
  );

  const chartData = useMemo(() => buildChartData(data.sales, start, end), [data.sales, start, end]);

  const chartXLabels = useMemo(() => {
    const total = chartData.length;
    const step = Math.max(1, Math.floor(total / 8));
    return chartData.map((d, i) => {
      if (i % step !== 0 && i !== total - 1) return "";
      const dt = new Date(d.date);
      return `${dt.getDate()} ${dt.toLocaleString("en", { month: "short" })}`;
    });
  }, [chartData]);

  const PERIODS: { value: Period; label: string }[] = [
    { value: "this_month", label: "This Month" },
    { value: "last_month", label: "Last Month" },
    { value: "this_year", label: "This Year" },
  ];

  const reports = [
    {
      label: "Sale Report",
      icon: FileText,
      go: () => navigate({ to: "/reports", search: { r: "sales" } }),
    },
    { label: "Daybook", icon: BookOpen, go: () => navigate({ to: "/daybook" }) },
    {
      label: "Profit & Loss",
      icon: LayoutList,
      go: () => navigate({ to: "/reports", search: { r: "pl" } }),
    },
    { label: "Party Statement", icon: Users, go: () => navigate({ to: "/parties" }) },
  ];

  return (
    <div className="flex flex-col md:flex-row h-full overflow-auto md:overflow-hidden bg-[#f5f6fa]">
      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0 md:overflow-auto">
        {/* Receivable / Payable */}
        <div className="flex gap-0 border-b border-gray-200 bg-white">
          {/* Total Receivable */}
          <button
            onClick={() => setPartyListOpen("receivable")}
            className="flex-1 min-w-0 p-3 sm:p-5 border-r border-gray-200 text-left hover:bg-gray-50 transition"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-xs text-gray-500 font-medium uppercase tracking-wide mb-1 truncate">
                  Total Receivable
                </p>
                <p className="text-[20px] sm:text-[28px] font-bold text-gray-800 leading-tight truncate">
                  ₹ {fmt(receivable)}
                </p>
                <p className="text-xs text-gray-400 mt-1 truncate">
                  From {receivableParties} {receivableParties === 1 ? "Party" : "Parties"}
                </p>
              </div>
              <div className="h-8 w-8 sm:h-10 sm:w-10 shrink-0 rounded-full bg-emerald-50 border-2 border-emerald-200 flex items-center justify-center mt-1">
                <ArrowDownLeft className="h-4 w-4 sm:h-5 sm:w-5 text-emerald-500" />
              </div>
            </div>
          </button>

          {/* Total Payable */}
          <button
            onClick={() => setPartyListOpen("payable")}
            className="flex-1 min-w-0 p-3 sm:p-5 text-left hover:bg-gray-50 transition"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-xs text-gray-500 font-medium uppercase tracking-wide mb-1 truncate">
                  Total Payable
                </p>
                <p className="text-[20px] sm:text-[28px] font-bold text-gray-800 leading-tight truncate">
                  ₹ {fmt(payable)}
                </p>
                <p className="text-xs text-gray-400 mt-1 truncate">
                  From {payableParties} {payableParties === 1 ? "Party" : "Parties"}
                </p>
              </div>
              <div className="h-8 w-8 sm:h-10 sm:w-10 shrink-0 rounded-full bg-rose-50 border-2 border-rose-200 flex items-center justify-center mt-1">
                <ArrowUpRight className="h-4 w-4 sm:h-5 sm:w-5 text-rose-500" />
              </div>
            </div>
          </button>
        </div>

        <PartyBalanceListDialog
          open={partyListOpen !== null}
          onOpenChange={(v) => !v && setPartyListOpen(null)}
          title={partyListOpen === "receivable" ? "Total Receivable" : "Total Payable"}
          parties={(partyListOpen === "receivable" ? customerBalances : supplierBalances)
            .filter((b) => b.balance > 0.01)
            .sort((a, b) => b.balance - a.balance)}
          tone={partyListOpen === "receivable" ? "emerald" : "rose"}
          onOpenParty={(id) => {
            setPartyListOpen(null);
            navigate({ to: "/parties/$id", params: { id } });
          }}
        />

        {/* Sales chart */}
        <div className="bg-white border-b border-gray-200 px-5 pt-4 pb-2">
          <div className="flex items-center justify-between mb-1">
            <div>
              <p className="text-xs text-gray-500 font-medium uppercase tracking-wide">
                Total Sale
              </p>
              <p className="text-[22px] font-bold text-gray-800 leading-tight">
                ₹ {fmt(totalSale)}
                {totalSale === 0 && (
                  <span className="ml-3 text-xs font-normal text-gray-400">No sales yet</span>
                )}
              </p>
            </div>

            {/* Period selector */}
            <div className="relative">
              <button
                onClick={() => setShowPeriodMenu((v) => !v)}
                className="flex items-center gap-1.5 h-8 px-3 rounded-md border border-gray-200 text-xs font-semibold text-gray-600 bg-white hover:bg-gray-50 transition"
              >
                {periodLabel}
                <ChevronDown className="h-3.5 w-3.5 text-gray-400" />
              </button>
              {showPeriodMenu && (
                <div className="absolute right-0 top-full mt-1 bg-white border border-gray-200 rounded-md shadow-lg z-20 min-w-[140px]">
                  {PERIODS.map((p) => (
                    <button
                      key={p.value}
                      onClick={() => {
                        setPeriod(p.value);
                        setShowPeriodMenu(false);
                      }}
                      className={`w-full text-left px-3 py-2 text-xs hover:bg-blue-50 hover:text-blue-600 transition ${period === p.value ? "text-blue-600 font-semibold bg-blue-50" : "text-gray-700"}`}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="h-[180px] mt-2">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
                <defs>
                  <linearGradient id="saleGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.15} />
                    <stop offset="95%" stopColor="#3b82f6" stopOpacity={0.01} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" vertical={false} />
                <XAxis
                  dataKey="date"
                  tickLine={false}
                  axisLine={false}
                  tick={{ fontSize: 10, fill: "#9ca3af" }}
                  tickFormatter={(_, i) => chartXLabels[i] ?? ""}
                  interval={0}
                />
                <YAxis
                  tickLine={false}
                  axisLine={false}
                  tick={{ fontSize: 10, fill: "#9ca3af" }}
                  tickFormatter={(v) => (v === 0 ? "0" : `${(v / 1000).toFixed(0)}k`)}
                />
                <Tooltip
                  contentStyle={{
                    fontSize: 12,
                    border: "1px solid #e5e7eb",
                    borderRadius: 6,
                    padding: "6px 10px",
                  }}
                  labelFormatter={(label) => {
                    const d = new Date(label);
                    return `${d.getDate()} ${d.toLocaleString("en", { month: "short", year: "numeric" })}`;
                  }}
                  formatter={(v: number) => [`₹ ${fmt(v)}`, "Sale"]}
                />
                <Area
                  type="monotone"
                  dataKey="amount"
                  stroke="#3b82f6"
                  strokeWidth={2}
                  fill="url(#saleGrad)"
                  dot={false}
                  activeDot={{ r: 4, fill: "#3b82f6" }}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* ===== Stock on Hand =====
            A real table, because that is what the four figures are: one row
            per item, with Name, Average, Stock and Stock Value as columns that
            line up down the page. It was a stack of loose lines before, which
            gave the eye nothing to compare across items.

            The three numeric columns are right-aligned and tabular so the
            digits line up, and Average x Stock = Stock Value reads straight
            across — see the note on stockRows above for why the value moved
            onto the client's own basis. */}
        <div className="px-5 pt-5">
          <div className="bg-card border border-border rounded-xl shadow-card overflow-hidden">
            <div className="px-5 py-3.5 border-b border-border flex items-center justify-between gap-3">
              <div className="flex items-center gap-2.5 min-w-0">
                <div className="h-8 w-8 shrink-0 rounded-lg bg-primary-soft text-primary flex items-center justify-center ring-1 ring-primary/10">
                  <Package className="h-4 w-4" />
                </div>
                <div className="min-w-0">
                  <p className="text-[13px] font-semibold text-foreground leading-tight">
                    Stock on Hand
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    {stockRows.length} {stockRows.length === 1 ? "item" : "items"} · value still to
                    recover
                  </p>
                </div>
              </div>
              {stockRows.length > topStock.length && (
                <button
                  onClick={() => navigate({ to: "/inventory" })}
                  className="shrink-0 inline-flex items-center gap-1 text-[12px] font-semibold text-primary hover:underline"
                >
                  View all
                  <ChevronRight className="h-3.5 w-3.5" />
                </button>
              )}
            </div>

            {topStock.length === 0 ? (
              <p className="px-5 py-6 text-[13px] text-muted-foreground">
                No stock on hand yet — add a purchase to see it here.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-[13px] min-w-[520px]">
                  <thead>
                    <tr className="text-[10px] uppercase tracking-wider text-muted-foreground bg-muted/40">
                      <th className="text-left font-semibold px-5 py-2">Item Name</th>
                      <th className="text-right font-semibold px-3 py-2 w-[130px]">Average</th>
                      <th className="text-right font-semibold px-3 py-2 w-[110px]">Stock</th>
                      <th className="text-right font-semibold px-5 py-2 w-[150px]">Stock Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {topStock.map((r) => (
                      <tr
                        key={r.id}
                        onClick={() => navigate({ to: "/items/$id", params: { id: r.id } })}
                        className="border-t border-border hover:bg-accent/50 transition cursor-pointer"
                      >
                        <td className="px-5 py-2.5 font-semibold text-foreground">
                          <span className="block truncate max-w-[280px]">{r.name}</span>
                        </td>
                        <td
                          className={`px-3 py-2.5 text-right tabular-nums ${r.avg != null && r.avg < 0 ? "text-destructive" : "text-muted-foreground"}`}
                        >
                          {r.avg == null ? "—" : `₹ ${fmt(r.avg)}`}
                        </td>
                        <td
                          className={`px-3 py-2.5 text-right tabular-nums font-semibold ${r.stock < 0 ? "text-destructive" : "text-primary"}`}
                        >
                          {fmtQty(r.stock)}
                          {/* Not every item carries a unit; printing a bare
                              space after the number looked like a missing word. */}
                          {r.unit ? ` ${r.unit}` : ""}
                        </td>
                        <td
                          className={`px-5 py-2.5 text-right tabular-nums font-bold ${r.value < 0 ? "text-destructive" : "text-foreground"}`}
                        >
                          ₹ {fmt(r.value)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  {stockRows.length > 1 && (
                    <tfoot>
                      <tr className="border-t-2 border-border bg-muted/30">
                        {/* Totals EVERY item, not only the six on show — it is
                            the same figure as the Stock Value stat beside this
                            panel, and the two disagreeing would be read as a
                            bug. When the list is cut short the label says so,
                            rather than leaving a total that visibly doesn't
                            add up the column above it. */}
                        <td className="px-5 py-2.5 text-[11px] uppercase tracking-wider font-semibold text-muted-foreground">
                          Total
                          {stockRows.length > topStock.length && (
                            <span className="ml-1 normal-case tracking-normal font-normal">
                              (all {stockRows.length} items)
                            </span>
                          )}
                        </td>
                        <td />
                        <td />
                        <td
                          className={`px-5 py-2.5 text-right tabular-nums font-bold ${stockValue < 0 ? "text-destructive" : "text-foreground"}`}
                        >
                          ₹ {fmt(stockValue)}
                        </td>
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>
            )}
          </div>
        </div>

        {/* Most Used Reports */}
        <div className="p-5">
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm font-semibold text-gray-700">Most Used Reports</span>
            <button
              onClick={() => navigate({ to: "/reports" })}
              className="text-xs text-blue-600 hover:underline font-medium"
            >
              View All
            </button>
          </div>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {reports.map((r) => (
              <button
                key={r.label}
                onClick={r.go}
                className="flex items-center justify-between bg-white border border-gray-200 rounded-lg px-4 py-3 hover:border-blue-300 hover:bg-blue-50/40 transition group"
              >
                <div className="flex items-center gap-2.5">
                  <div className="h-7 w-7 rounded-md bg-blue-50 flex items-center justify-center">
                    <r.icon className="h-3.5 w-3.5 text-blue-600" />
                  </div>
                  <span className="text-xs font-medium text-gray-700">{r.label}</span>
                </div>
                <ChevronRight className="h-3.5 w-3.5 text-gray-300 group-hover:text-blue-400 transition" />
              </button>
            ))}
          </div>

          {/* Quick Actions row */}
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              onClick={() => navigate({ to: "/sales/new" })}
              className="inline-flex items-center gap-1.5 h-8 px-3 bg-blue-600 text-white rounded-md text-xs font-semibold hover:bg-blue-700 transition"
            >
              <Plus className="h-3.5 w-3.5" /> Add Sale
            </button>
            <button
              onClick={() => navigate({ to: "/purchase/new" })}
              className="inline-flex items-center gap-1.5 h-8 px-3 bg-white border border-gray-200 text-gray-700 rounded-md text-xs font-semibold hover:bg-gray-50 transition"
            >
              <Plus className="h-3.5 w-3.5" /> Add Purchase
            </button>
            <button
              onClick={() => navigate({ to: "/parties" })}
              className="inline-flex items-center gap-1.5 h-8 px-3 bg-white border border-gray-200 text-gray-700 rounded-md text-xs font-semibold hover:bg-gray-50 transition"
            >
              <Users className="h-3.5 w-3.5" /> Add Party
            </button>
            <button
              onClick={() => navigate({ to: "/items" })}
              className="inline-flex items-center gap-1.5 h-8 px-3 bg-white border border-gray-200 text-gray-700 rounded-md text-xs font-semibold hover:bg-gray-50 transition"
            >
              <Package className="h-3.5 w-3.5" /> Add Item
            </button>
          </div>

          {lowStock.length > 0 && (
            <div className="mt-4 bg-amber-50 border border-amber-200 rounded-lg p-3">
              <div className="flex items-center gap-2 mb-2">
                <Package className="h-3.5 w-3.5 text-amber-600" />
                <span className="text-xs font-semibold text-amber-700">
                  Low Stock Alerts ({lowStock.length})
                </span>
              </div>
              <div className="space-y-1">
                {lowStock.slice(0, 4).map((i) => (
                  <div key={i.id} className="flex justify-between text-xs text-amber-700">
                    <span className="truncate flex-1">{i.name}</span>
                    <span className="font-semibold ml-2">
                      Stock: {fmtQty(i.stock)} / Min: {fmtQty(i.minStock ?? 0)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Right Stats Panel */}
      <div className="w-full md:w-[240px] shrink-0 bg-white border-t md:border-t-0 md:border-l border-gray-200 flex flex-col md:overflow-auto">
        <StatRow label="Purchases" badge={periodLabel} value={`₹ ${fmt(totalPurchase)}`} />
        <StatRow label="Expenses" badge={periodLabel} value={`₹ ${fmt(totalExpense)}`} />
        <StatRow
          label="Stock Value"
          badge="As of Now"
          value={`₹ ${fmt(stockValue)}`}
          valueClass={stockValue < 0 ? "text-rose-600" : "text-gray-800"}
        />
        <StatRow
          label="Cash On Hand"
          badge="As of Now"
          value={`₹ ${fmt(cashInHand)}`}
          valueClass={cashInHand < 0 ? "text-rose-600" : "text-gray-800"}
        />
        <StatRow label="Total Bank Balance" badge="As of Now" value={`₹ ${fmt(bankBalance)}`} />
        <StatRow
          label="Net Profit"
          badge={periodLabel}
          value={`₹ ${fmt(netProfit)}`}
          valueClass={netProfit >= 0 ? "text-emerald-600" : "text-rose-600"}
        />

        <div className="border-t border-gray-200 p-4">
          <div className="flex items-center gap-2 mb-1">
            <TrendingUp className="h-4 w-4 text-blue-500" />
            <span className="text-xs font-semibold text-gray-700">Business Summary</span>
          </div>
          <p className="text-[11px] text-gray-400 leading-relaxed">
            Track your receivables, payables and profit at a glance. Add transactions to see live
            insights.
          </p>
        </div>

        <div className="border-t border-gray-200 p-4 mt-auto">
          <button
            onClick={() => navigate({ to: "/sales" })}
            className="w-full flex items-center justify-between px-3 py-2 bg-blue-50 border border-blue-100 rounded-lg text-xs font-semibold text-blue-700 hover:bg-blue-100 transition"
          >
            <span>Add Widget of Your Choice</span>
            <Plus className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}

function PartyBalanceListDialog({
  open,
  onOpenChange,
  title,
  parties,
  tone,
  onOpenParty,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: string;
  /** Only what this list renders — a name and the amount on this side. */
  parties: { partyId: string; name: string; balance: number }[];
  tone: "emerald" | "rose";
  onOpenParty: (partyId: string) => void;
}) {
  const toneClass = tone === "emerald" ? "text-emerald-600" : "text-rose-600";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        {parties.length === 0 ? (
          <p className="text-sm text-muted-foreground py-6 text-center">No outstanding parties</p>
        ) : (
          <div className="divide-y divide-gray-100 border rounded-md overflow-hidden">
            {parties.map((p) => (
              <button
                key={p.partyId}
                onClick={() => onOpenParty(p.partyId)}
                className="w-full flex items-center justify-between gap-3 px-3 py-2.5 text-left hover:bg-gray-50 transition"
              >
                <span className="font-medium text-gray-800 truncate">{p.name}</span>
                <span className={`font-bold tabular-nums shrink-0 ${toneClass}`}>
                  {fmtMoney(p.balance)}
                </span>
              </button>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function StatRow({
  label,
  badge,
  value,
  valueClass = "text-gray-800",
}: {
  label: string;
  badge: string;
  value: string;
  valueClass?: string;
}) {
  return (
    <div className="px-4 py-3.5 border-b border-gray-100">
      <div className="flex items-center justify-between mb-0.5">
        <span className="text-xs font-medium text-gray-600">{label}</span>
        <span className="text-[10px] text-gray-400 bg-gray-50 border border-gray-200 rounded px-1.5 py-0.5">
          {badge}
        </span>
      </div>
      <p className={`text-[16px] font-bold mt-0.5 ${valueClass}`}>{value}</p>
    </div>
  );
}
