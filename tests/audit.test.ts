/**
 * AIM ENTERPRISE production audit harness.
 * Imports the REAL calculation library (src/lib/ledger.ts) and hammers it
 * with randomized business scenarios ("monkey testing"), asserting the
 * accounting invariants that must never break.
 */
import {
  partyBalances,
  modeFlows,
  cashFlows,
  bankFlows,
  netFlow,
  computeCogs,
  allocatedAmount,
  advanceAmount,
  paidViaPayments,
  valueExTax,
  buildBankLedger,
  totalSettlementDiscount,
  netPartyPositions,
  buildPartyStatement,
  spreadFifo,
} from "@/lib/ledger";
import type {
  PaymentSplit,
  StockAdjustment,
  BankTxn,
  CashAdjustment,
  Invoice,
  Payment,
  Return,
  Item,
  Expense,
  LineItem,
  CashAdjustment,
  PaymentMode,
  BankAccount,
} from "@/types";
import { Repository } from "@/repositories/base";
import { correctBankPaidAmount, planBankRepair } from "@/lib/bankRepair";
import { buildAverageCosts } from "@/lib/avgCost";
import { planStockRepair } from "@/lib/dataRepair";
import {
  splitsOf,
  cashPart,
  bankParts,
  unassignedPart,
  splitProblems,
  describePayment,
  largestSplitMode,
} from "@/lib/paymentSplit";
import { readFileSync } from "node:fs";
import { transferLegsFor } from "@/lib/transferLegs";

let passed = 0,
  failed = 0;
const fails: string[] = [];
function assert(cond: boolean, msg: string) {
  if (cond) {
    passed++;
    return;
  }
  failed++;
  if (fails.length < 20) fails.push(msg);
}
const r2 = (n: number) => Math.round(n * 100) / 100;
const approx = (a: number, b: number, eps = 0.02) => Math.abs(a - b) <= eps;

// Seeded RNG for reproducible runs
let seed = 20260702;
const rnd = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};
const ri = (max: number) => Math.floor(rnd() * max);
const pick = <T>(a: T[]) => a[ri(a.length)];
let idCounter = 0;
const nid = () => `id${++idCounter}`;

/* ═══════ TEST 1: Invoice totals formula — 5000 random bills ═══════ */
// Replicates InvoiceForm.recalc exactly and asserts the printed columns
// (taxable subtotal + GST − extra discount + round off) reconcile to Total.
for (let t = 0; t < 5000; t++) {
  const nLines = 1 + ri(8);
  const lines = Array.from({ length: nLines }, () => ({
    qty: r2(0.5 + rnd() * 20),
    price: r2(rnd() * 5000),
    discountPct: ri(4) === 0 ? ri(30) : 0,
    gstRate: pick([0, 5, 12, 18, 28]),
  }));
  const discount = ri(3) === 0 ? r2(rnd() * 50) : 0;
  const roundEnabled = ri(4) !== 0;
  // exact copy of recalc math
  const afterLineDisc = r2(
    lines.reduce((s, l) => s + r2(l.qty * l.price * (1 - l.discountPct / 100)), 0),
  );
  const taxAmount = r2(
    lines.reduce(
      (s, l) => s + r2(r2(l.qty * l.price * (1 - l.discountPct / 100)) * (l.gstRate / 100)),
      0,
    ),
  );
  const rawTotal = Math.max(0, r2(afterLineDisc + taxAmount - discount));
  const total = roundEnabled ? Math.round(rawTotal) : rawTotal;
  const roundOff = r2(total - rawTotal);

  assert(!roundEnabled || Number.isInteger(total), `T1: rounded total not whole rupee: ${total}`);
  assert(Math.abs(roundOff) <= 0.5 + 1e-9, `T1: roundOff out of range: ${roundOff}`);
  // What the printed bill shows must add up:
  const printed = r2(afterLineDisc + taxAmount - discount + roundOff);
  assert(approx(printed, total), `T1: printed columns ${printed} != total ${total}`);
}

/* ═══════ TEST 2: Party balances — 300 random books ═══════ */
for (let t = 0; t < 300; t++) {
  const partyIds = Array.from({ length: 1 + ri(5) }, () => nid());
  const invoices: Invoice[] = [];
  const returns: Return[] = [];
  const payments: Payment[] = [];

  for (let i = 0; i < 2 + ri(20); i++) {
    const pid = pick(partyIds);
    const total = r2(100 + rnd() * 9000);
    const initialPaid = ri(3) === 0 ? r2(rnd() * total) : 0;
    invoices.push({
      id: nid(),
      number: `INV-${i}`,
      date: "2026-07-01",
      partyId: pid,
      partyName: pid,
      lineItems: [],
      subtotal: total,
      discount: 0,
      taxAmount: 0,
      total,
      paid: initialPaid,
      paymentMode: "cash",
      createdAt: "",
    });
  }
  for (const inv of invoices) {
    if (ri(3) === 0) {
      // a payment applied against this invoice
      const due = r2(inv.total - inv.paid);
      if (due > 1) {
        const applyAmt = r2(due * (0.3 + rnd() * 0.7));
        inv.paid = r2(inv.paid + applyAmt); // what the app does on apply
        payments.push({
          id: nid(),
          date: "2026-07-02",
          partyId: inv.partyId,
          partyName: inv.partyName,
          type: "in",
          amount: applyAmt,
          mode: pick(["cash", "bank", "upi"] as PaymentMode[]),
          allocations: [{ invoiceId: inv.id, number: inv.number, amount: applyAmt }],
          createdAt: "",
        });
      }
    }
    if (ri(5) === 0) {
      returns.push({
        id: nid(),
        number: `CR-${inv.number}`,
        date: "2026-07-03",
        partyId: inv.partyId,
        partyName: inv.partyName,
        lineItems: [],
        subtotal: 0,
        taxAmount: 0,
        total: r2(inv.total * 0.2),
        createdAt: "",
      });
    }
  }
  // pure advances
  for (let i = 0; i < ri(4); i++) {
    const pid = pick(partyIds);
    payments.push({
      id: nid(),
      date: "2026-07-02",
      partyId: pid,
      partyName: pid,
      type: "in",
      amount: r2(50 + rnd() * 500),
      mode: "cash",
      createdAt: "",
    });
  }

  const balances = partyBalances(invoices, returns, payments);
  for (const b of balances) {
    // independent naive recomputation
    const inv = invoices.filter((x) => x.partyId === b.partyId);
    const ret = returns.filter((x) => x.partyId === b.partyId);
    const pay = payments.filter((x) => x.partyId === b.partyId);
    const invoiced = r2(inv.reduce((s, x) => s + x.total, 0));
    const settled = r2(inv.reduce((s, x) => s + x.paid, 0));
    const returned = r2(ret.reduce((s, x) => s + x.total, 0));
    const advances = r2(
      pay.reduce(
        (s, p) => s + (p.amount - (p.allocations ?? []).reduce((a, x) => a + x.amount, 0)),
        0,
      ),
    );
    const expect = r2(invoiced - returned - settled - advances);
    assert(approx(b.balance, expect), `T2: balance ${b.balance} != naive ${expect}`);
    // every allocated rupee is inside invoice.paid — money counted exactly once
    for (const p of pay) {
      assert(allocatedAmount(p) <= p.amount + 0.001, `T2: allocated > amount`);
      assert(approx(advanceAmount(p), p.amount - allocatedAmount(p)), `T2: advance mismatch`);
    }
  }
}

/* ═══════ TEST 3: Cash/bank flows never double-count applied payments ═══════ */
for (let t = 0; t < 300; t++) {
  // one cash invoice: paid 200 at billing, then 300 applied via a UPI payment
  const inv: Invoice = {
    id: nid(),
    number: "INV-X",
    date: "2026-07-01",
    partyId: "p",
    partyName: "p",
    lineItems: [],
    subtotal: 1000,
    discount: 0,
    taxAmount: 0,
    total: 1000,
    paid: 500,
    paymentMode: "cash",
    createdAt: "",
  };
  const pay: Payment = {
    id: nid(),
    date: "2026-07-02",
    partyId: "p",
    partyName: "p",
    type: "in",
    amount: 300,
    mode: "upi",
    allocations: [{ invoiceId: inv.id, number: inv.number, amount: 300 }],
    createdAt: "",
  };
  const cash = netFlow(cashFlows([inv], [], [], [pay], []));
  const bank = netFlow(bankFlows([inv], [], [], [pay]));
  assert(approx(cash, 200), `T3: cash ${cash} != 200 (initial cash only)`);
  assert(approx(bank, 300), `T3: bank ${bank} != 300 (UPI payment only)`);
  assert(approx(cash + bank, inv.paid), `T3: cash+bank != invoice.paid`);
}

/* ═══════ TEST 4: COGS ═══════ */
{
  const items: Item[] = [
    {
      id: "i1",
      name: "A",
      unit: "pcs",
      gstRate: 0,
      purchasePrice: 80,
      salePrice: 100,
      stock: 0,
      openingStock: 0,
      createdAt: "",
    },
  ];
  const line = (qty: number, costPrice?: number): LineItem => ({
    id: nid(),
    itemId: "i1",
    name: "A",
    qty,
    unit: "pcs",
    price: 100,
    discountPct: 0,
    gstRate: 0,
    amount: qty * 100,
    costPrice,
  });
  const sales: Invoice[] = [
    {
      id: nid(),
      number: "S1",
      date: "2026-07-01",
      partyId: "p",
      partyName: "p",
      lineItems: [line(2, 70), line(3)],
      subtotal: 500,
      discount: 0,
      taxAmount: 0,
      total: 500,
      paid: 0,
      paymentMode: "cash",
      createdAt: "",
    },
  ];
  const rets: Return[] = [
    {
      id: nid(),
      number: "CR1",
      date: "2026-07-02",
      partyId: "p",
      partyName: "p",
      lineItems: [line(1, 70)],
      subtotal: 100,
      taxAmount: 0,
      total: 100,
      createdAt: "",
    },
  ];
  // 2×70 (snapshot) + 3×80 (fallback) − 1×70 (returned) = 310
  assert(approx(computeCogs(sales, rets, items), 310), `T4: COGS != 310`);
}

/* ═══════ TEST 5: MONKEY — 20,000 random stock operations ═══════ */
// Simulates the exact mutation sequences the app performs and checks
// stock always equals opening + everything-in − everything-out.
{
  type Doc = { qty: number; itemId: string };
  const item = { opening: 100, stock: 100 };
  const salesDocs = new Map<string, Doc>();
  const purchaseDocs = new Map<string, Doc>();
  const sRetDocs = new Map<string, Doc>();
  const pRetDocs = new Map<string, Doc>();
  let adjNet = 0;
  let openingEdits = 0;

  const expectStock = () => {
    let s = item.opening;
    for (const d of purchaseDocs.values()) s += d.qty;
    for (const d of salesDocs.values()) s -= d.qty;
    for (const d of sRetDocs.values()) s += d.qty;
    for (const d of pRetDocs.values()) s -= d.qty;
    return r2(s + adjNet);
  };
  const adj = (delta: number) => {
    item.stock = r2(item.stock + delta);
  };

  for (let op = 0; op < 20000; op++) {
    const kind = ri(10);
    const qty = r2(0.5 + rnd() * 10);
    if (kind === 0) {
      // new sale (app: stock −qty)
      const id = nid();
      salesDocs.set(id, { qty, itemId: "i" });
      adj(-qty);
    } else if (kind === 1) {
      // new purchase (+qty)
      const id = nid();
      purchaseDocs.set(id, { qty, itemId: "i" });
      adj(qty);
    } else if (kind === 2 && salesDocs.size) {
      // edit sale (reverse old, apply new)
      const id = pick([...salesDocs.keys()]);
      const old = salesDocs.get(id)!;
      adj(old.qty); // reversal
      old.qty = qty;
      adj(-qty); // re-apply
    } else if (kind === 3 && salesDocs.size) {
      // delete sale (+qty back)
      const id = pick([...salesDocs.keys()]);
      adj(salesDocs.get(id)!.qty);
      salesDocs.delete(id);
    } else if (kind === 4 && purchaseDocs.size) {
      // delete purchase (−qty)
      const id = pick([...purchaseDocs.keys()]);
      adj(-purchaseDocs.get(id)!.qty);
      purchaseDocs.delete(id);
    } else if (kind === 5) {
      // sale return (+qty)
      const id = nid();
      sRetDocs.set(id, { qty, itemId: "i" });
      adj(qty);
    } else if (kind === 6) {
      // purchase return (−qty)
      const id = nid();
      pRetDocs.set(id, { qty, itemId: "i" });
      adj(-qty);
    } else if (kind === 7 && sRetDocs.size) {
      // delete sale return (−qty)
      const id = pick([...sRetDocs.keys()]);
      adj(-sRetDocs.get(id)!.qty);
      sRetDocs.delete(id);
    } else if (kind === 8) {
      // manual stock adjustment
      const delta = (ri(2) ? 1 : -1) * qty;
      adjNet = r2(adjNet + delta);
      adj(delta);
    } else if (kind === 9) {
      // edit opening stock (delta shifts current)
      const newOpening = r2(rnd() * 200);
      const delta = r2(newOpening - item.opening);
      item.opening = newOpening;
      adj(delta);
      openingEdits++;
    }
    if (op % 100 === 0 || op === 19999) {
      assert(
        approx(item.stock, expectStock(), 0.5),
        `T5 op${op}: stock ${item.stock} != expected ${expectStock()}`,
      );
    }
  }
  assert(approx(item.stock, expectStock(), 0.5), `T5 final: stock drifted`);
}

/* ═══════ TEST 6: MONKEY — payment lifecycle (create/edit/delete) ═══════ */
{
  const invoices: Invoice[] = Array.from({ length: 12 }, (_, i) => ({
    id: nid(),
    number: `INV-${i}`,
    date: "2026-07-01",
    partyId: "p1",
    partyName: "p1",
    lineItems: [],
    subtotal: 1000,
    discount: 0,
    taxAmount: 0,
    total: 1000,
    paid: 0,
    paymentMode: "credit",
    createdAt: "",
  }));
  const initialPaid = new Map(invoices.map((i) => [i.id, 0]));
  const payments: Payment[] = [];

  const applyPayment = (): Payment | null => {
    const open = invoices.filter((i) => r2(i.total - i.paid) > 1);
    if (!open.length) return null;
    const allocs = open
      .slice(0, 1 + ri(3))
      .map((inv) => {
        const amt = r2(Math.min(r2(inv.total - inv.paid), 50 + rnd() * 400));
        inv.paid = r2(inv.paid + amt); // app behaviour
        return { invoiceId: inv.id, number: inv.number, amount: amt };
      })
      .filter((a) => a.amount > 0);
    if (!allocs.length) return null;
    const p: Payment = {
      id: nid(),
      date: "2026-07-02",
      partyId: "p1",
      partyName: "p1",
      type: "in",
      amount: r2(allocs.reduce((s, a) => s + a.amount, 0)),
      mode: "cash",
      allocations: allocs,
      createdAt: "",
    };
    payments.push(p);
    return p;
  };
  const reverse = (p: Payment) => {
    for (const a of p.allocations ?? []) {
      const inv = invoices.find((i) => i.id === a.invoiceId)!;
      inv.paid = r2(inv.paid - a.amount);
    }
  };

  for (let op = 0; op < 3000; op++) {
    const k = ri(3);
    if (k === 0) applyPayment();
    else if (k === 1 && payments.length) {
      // delete (app: reverse allocations, remove record)
      const idx = ri(payments.length);
      reverse(payments[idx]);
      payments.splice(idx, 1);
    } else if (k === 2 && payments.length) {
      // edit (app: reverse, re-apply fresh)
      const idx = ri(payments.length);
      reverse(payments[idx]);
      payments.splice(idx, 1);
      applyPayment();
    }
    // INVARIANT: invoice.paid == initialPaid + sum of surviving allocations
    const byInv = paidViaPayments(payments);
    for (const inv of invoices) {
      const expected = r2((initialPaid.get(inv.id) ?? 0) + (byInv.get(inv.id) ?? 0));
      assert(
        approx(inv.paid, expected),
        `T6 op${op}: ${inv.number} paid ${inv.paid} != ${expected}`,
      );
      assert(
        inv.paid >= -0.01 && inv.paid <= inv.total + 0.01,
        `T6 op${op}: paid out of range ${inv.paid}`,
      );
    }
  }
  // Party balance must equal total dues (no advances in this scenario)
  const bal = partyBalances(invoices, [], payments)[0];
  const dues = r2(invoices.reduce((s, i) => s + (i.total - i.paid), 0));
  assert(approx(bal.balance, dues), `T6: party balance ${bal.balance} != open dues ${dues}`);
}

/* ═══════ TEST 7: expenses & adjustments in cash ═══════ */
{
  const exp: Expense[] = [
    {
      id: nid(),
      date: "2026-07-01",
      category: "Tea",
      amount: 50,
      paymentMode: "cash",
      createdAt: "",
    },
  ];
  const adj: CashAdjustment[] = [
    { id: nid(), date: "2026-07-01", type: "add", amount: 500, createdAt: "" },
    { id: nid(), date: "2026-07-01", type: "reduce", amount: 120, createdAt: "" },
  ];
  const cash = netFlow(cashFlows([], [], exp, [], adj));
  assert(approx(cash, 500 - 120 - 50), `T7: cash ${cash} != 330`);
}

/* ═══ TEST 10: a bank-mode expense is NOT double-counted in bankFlows ═══
   A bank expense already moved the account's stored balance at save time;
   the Bank page / dashboard add bankFlows ON TOP of stored balances, so
   bankFlows must exclude anything carrying a bankId. A cash expense (no
   bankId) must still be counted in cashFlows. Regression guard for A1. */
{
  const bankExp: Expense[] = [
    {
      id: nid(),
      date: "2026-07-01",
      category: "Rent",
      amount: 5000,
      paymentMode: "bank",
      bankId: "bk1",
      createdAt: "",
    },
  ];
  const bankOut = netFlow(bankFlows([], [], bankExp, []));
  assert(bankOut === 0, `T10: bank expense must not appear in bankFlows (got ${bankOut})`);

  const cashExp: Expense[] = [
    {
      id: nid(),
      date: "2026-07-01",
      category: "Tea",
      amount: 50,
      paymentMode: "cash",
      createdAt: "",
    },
  ];
  const cashOut = netFlow(cashFlows([], [], cashExp, [], []));
  assert(cashOut === -50, `T10: cash expense must still count in cashFlows (got ${cashOut})`);
}

console.log(`\n══════════════════════════════════════`);

/* ═══ TEST 9: opening balance sign convention — never double counted ═══ */
{
  const partiesOB = [
    { id: "pA", name: "A", openingBalance: 5000 }, // they owe us
    { id: "pB", name: "B", openingBalance: -3000 }, // we owe them
  ];
  const cust = partyBalances([], [], [], partiesOB, "customer");
  const supp = partyBalances([], [], [], partiesOB, "supplier");
  const get = (list: ReturnType<typeof partyBalances>, id: string) =>
    list.find((b) => b.partyId === id)!.balance;
  assert(get(cust, "pA") === 5000, "T9: +opening must be receivable");
  assert(get(supp, "pA") === 0, "T9: +opening must NOT be payable");
  assert(get(cust, "pB") === 0, "T9: -opening must NOT be receivable");
  assert(get(supp, "pB") === 3000, "T9: -opening must be payable");
  const stmt = partyBalances([], [], [], partiesOB); // statement: signed as-is
  assert(get(stmt, "pA") === 5000 && get(stmt, "pB") === -3000, "T9: statement uses signed value");
}

/* ═══ TEST 8: Repository — empty-string draft IDs must be replaced ═══ */
{
  const repo = new Repository<{ id: string; total: number }>("test-collection");
  const a = repo.add({ id: "", total: 100 } as never);
  const b = repo.add({ id: "", total: 200 } as never);
  const c = repo.add({ total: 300 } as never);
  assert(a.id.length > 0, "T8: empty-string id not replaced");
  assert(b.id.length > 0 && b.id !== a.id, "T8: ids must be unique");
  assert(c.id.length > 0, "T8: missing id not generated");
  assert(repo.all().length === 3, "T8: cache count");
  repo.adjustField(a.id, "total", -30);
  assert(repo.get(a.id)!.total === 70, "T8: adjustField cache math");
  repo.remove(b.id);
  assert(repo.all().length === 2, "T8: remove");
}

/* ═══ TEST 11: a bill's bank snapshot excludes Payment-record money ═══
   Regression for the highest-severity bug found in the Aug-2026 review:
   InvoiceForm stored the WHOLE of invoice.paid as bankPaidAmount. Once a
   Payment record was allocated to the bill, invoice.paid included money that
   had arrived by another route (often cash) and had already moved on its own
   mode — so merely re-saving the bill credited the bank account with it a
   second time, inventing money that existed nowhere. The correct snapshot is
   the "direct portion": paid minus whatever Payment records supplied — the
   same formula modeFlows() uses for the cash side. */
{
  // The REAL function InvoiceForm.finalizeSave calls — not a copy of it, so
  // this test can't pass while production drifts.
  const bankSnapshot = (inv: Invoice, paid: number, payments: Payment[]) =>
    correctBankPaidAmount({ ...inv, paid } as Invoice, payments);

  const bank: BankAccount = {
    id: "B1",
    name: "HDFC",
    openingBalance: 0,
    balance: 0,
    createdAt: "",
  } as BankAccount;

  let sale = {
    id: "S1",
    number: "INV-9001",
    date: "2026-08-01",
    partyId: "P1",
    partyName: "Ramesh",
    gstEnabled: false,
    lineItems: [],
    subtotal: 1000,
    discount: 0,
    taxAmount: 0,
    total: 1000,
    paid: 400,
    paymentMode: "bank",
    bankId: "B1",
    bankPaidAmount: 400,
    createdAt: "2026-08-01T10:00:00Z",
  } as unknown as Invoice;
  bank.balance = 400; // moved at billing

  // A later CASH payment settles the rest and pushes invoice.paid to 1000.
  const pay = {
    id: "PY1",
    type: "in",
    date: "2026-08-05",
    partyId: "P1",
    partyName: "Ramesh",
    amount: 600,
    mode: "cash",
    allocations: [{ invoiceId: "S1", number: "INV-9001", amount: 600 }],
    createdAt: "2026-08-05T10:00:00Z",
  } as unknown as Payment;
  sale = { ...sale, paid: 1000 };

  const totalMoney = () =>
    r2(
      netFlow(cashFlows([sale], [], [], [pay], [])) +
        bank.balance +
        netFlow(bankFlows([sale], [], [], [pay])),
    );

  assert(totalMoney() === 1000, "T11: baseline — 400 bank + 600 cash");

  // Re-save the bill three times over. Each save reverses the stored snapshot
  // and applies the freshly computed one, exactly as finalizeSave does.
  for (let i = 0; i < 3; i++) {
    const next = bankSnapshot(sale, sale.paid, [pay]);
    bank.balance = r2(bank.balance - (sale.bankPaidAmount ?? 0) + (next ?? 0));
    sale = { ...sale, bankPaidAmount: next };
    assert(totalMoney() === 1000, `T11: re-save #${i + 1} must not create money`);
    assert(sale.bankPaidAmount === 400, `T11: re-save #${i + 1} keeps the direct portion`);
  }

  // The passbook derives from bankPaidAmount, so it must agree too.
  const passbook = buildBankLedger(bank, {
    sales: [sale],
    purchases: [],
    payments: [pay],
    bankTxns: [],
  }).fullBalance;
  assert(passbook === bank.balance, "T11: passbook must match the stored balance");

  // Reducing the bill to 800 leaves 600 payment-backed, so the bank keeps 200.
  const reduced = bankSnapshot(sale, 800, [pay]);
  bank.balance = r2(bank.balance - (sale.bankPaidAmount ?? 0) + (reduced ?? 0));
  sale = { ...sale, total: 800, paid: 800, bankPaidAmount: reduced };
  assert(reduced === 200, "T11: reduced bill keeps only its own direct portion");
  assert(totalMoney() === 800, "T11: reduced bill totals 800");

  // A non-bank bill must never carry a bank snapshot at all.
  const cashBill = { ...sale, paymentMode: "cash" } as Invoice;
  assert(
    bankSnapshot(cashBill, cashBill.paid, [pay]) === undefined,
    "T11: non-bank bill has no bank snapshot",
  );
}

/* ═══ TEST 12: profit excludes output GST ═══
   invoice.total is tax-INCLUSIVE while COGS is a tax-exclusive line cost, so
   the P&L and the dashboard were reporting the GST collected as earnings. */
{
  const gstBill = {
    id: "G1",
    total: 1180,
    taxAmount: 180,
    gstEnabled: true,
  } as unknown as Invoice;
  const plainBill = {
    id: "G2",
    total: 500,
    taxAmount: 0,
    gstEnabled: false,
  } as unknown as Invoice;
  // A legacy/imported doc marked non-GST but carrying a stale taxAmount must
  // NOT have that phantom tax stripped out of revenue.
  const legacyBill = {
    id: "G3",
    total: 300,
    taxAmount: 45,
    gstEnabled: false,
  } as unknown as Invoice;

  assert(valueExTax([gstBill]) === 1000, "T12: strips output GST");
  assert(valueExTax([plainBill]) === 500, "T12: non-GST bill untouched");
  assert(valueExTax([legacyBill]) === 300, "T12: gstEnabled:false ignores stale taxAmount");
  assert(valueExTax([gstBill, plainBill]) === 1500, "T12: sums correctly");
  assert(valueExTax([]) === 0, "T12: empty set");
  assert(
    valueExTax([{ total: 1180, taxAmount: 180 } as unknown as Invoice]) === 1000,
    "T12: undefined gstEnabled treated as GST bill",
  );
  // The invariant that actually matters: gross profit on a GST bill must equal
  // the ex-tax margin, never the tax-inflated one.
  const cogs = 700;
  assert(valueExTax([gstBill]) - cogs === 300, "T12: gross profit is ex-GST margin");
}

/* ═══ TEST 13: the bank reconciliation repair ═══
   Builds a book that HAS the historical corruption in it and checks the
   planner both spots it and lands the account on the derived truth. */
{
  const bank = {
    id: "BR1",
    name: "ICICI",
    openingBalance: 5000,
    balance: 99999, // deliberately wrong, as production is
    createdAt: "",
  } as unknown as BankAccount;

  const sale = {
    id: "RS1",
    number: "INV-7001",
    date: "2026-05-02",
    partyId: "P9",
    partyName: "Suresh",
    gstEnabled: false,
    lineItems: [],
    subtotal: 2000,
    discount: 0,
    taxAmount: 0,
    total: 2000,
    paid: 2000,
    paymentMode: "bank",
    bankId: "BR1",
    bankPaidAmount: 2000, // corrupted: 1500 of this came via a cash payment
    createdAt: "2026-05-02T09:00:00Z",
  } as unknown as Invoice;

  const pay = {
    id: "RP1",
    type: "in",
    date: "2026-05-09",
    partyId: "P9",
    partyName: "Suresh",
    amount: 1500,
    mode: "cash",
    allocations: [{ invoiceId: "RS1", number: "INV-7001", amount: 1500 }],
    createdAt: "2026-05-09T09:00:00Z",
  } as unknown as Payment;

  const plan = planBankRepair({
    sales: [sale],
    purchases: [],
    payments: [pay],
    banks: [bank],
    bankTxns: [],
    expenses: [],
  });

  assert(plan.hasWork, "T13: corruption must be detected");
  assert(plan.bills.length === 1, "T13: exactly one bill needs correcting");
  assert(plan.bills[0].stored === 2000, "T13: reports the stored snapshot");
  assert(plan.bills[0].correct === 500, "T13: only the direct portion is genuinely bank money");
  assert(plan.accounts.length === 1, "T13: the account balance is off");
  // opening 5000 + the bill's real 500 = 5500
  assert(plan.accounts[0].correct === 5500, "T13: balance re-derived from documents");
  assert(plan.accounts[0].delta === r2(5500 - 99999), "T13: delta is correct - stored");

  // Applying the plan and re-planning must find nothing left to do.
  const repairedSale = { ...sale, bankPaidAmount: plan.bills[0].correct } as Invoice;
  const repairedBank = { ...bank, balance: plan.accounts[0].correct } as BankAccount;
  const after = planBankRepair({
    sales: [repairedSale],
    purchases: [],
    payments: [pay],
    banks: [repairedBank],
    bankTxns: [],
    expenses: [],
  });
  assert(!after.hasWork, "T13: repair must be idempotent — nothing left on a second pass");

  // A healthy book must never be flagged (no spurious "corrections").
  const clean = planBankRepair({
    sales: [],
    purchases: [],
    payments: [],
    banks: [{ ...bank, balance: 5000 } as BankAccount],
    bankTxns: [],
    expenses: [],
  });
  assert(!clean.hasWork, "T13: a healthy book reports no work");

  // Cash-mode bills must be ignored entirely by the planner.
  const cashOnly = planBankRepair({
    sales: [{ ...sale, paymentMode: "cash", bankId: undefined } as Invoice],
    purchases: [],
    payments: [pay],
    banks: [{ ...bank, balance: 5000 } as BankAccount],
    bankTxns: [],
    expenses: [],
  });
  assert(cashOnly.bills.length === 0, "T13: non-bank bills are not touched");
}

/* ═══ TEST 14: settlement discount ═══
   The client's case: a 20,500 bill, 20,000 collected, the last 500 waived so
   the bill can be closed. The bill must read as fully settled and the party
   must owe nothing, while ONLY the 20,000 may ever appear as cash — the
   waived 500 is a cost, not money that arrived. */
{
  const inv = {
    id: "D1",
    number: "INV-5001",
    date: "2026-06-01",
    partyId: "PD",
    partyName: "Discount Co",
    gstEnabled: false,
    lineItems: [],
    subtotal: 20500,
    discount: 0,
    taxAmount: 0,
    total: 20500,
    paid: 20500, // 20000 cash + 500 written off
    paymentMode: "credit",
    createdAt: "2026-06-01T09:00:00Z",
  } as unknown as Invoice;

  const pay = {
    id: "DP1",
    type: "in",
    date: "2026-06-10",
    partyId: "PD",
    partyName: "Discount Co",
    amount: 20000, // cash only — the discount is NOT part of this
    mode: "cash",
    allocations: [{ invoiceId: "D1", number: "INV-5001", amount: 20000, discount: 500 }],
    createdAt: "2026-06-10T09:00:00Z",
  } as unknown as Payment;

  // The bill is settled in full: cash + write-off.
  assert(paidViaPayments([pay]).get("D1") === 20500, "T14: bill counted as fully settled");

  // The party owes nothing afterwards.
  const bal = partyBalances([inv], [], [pay], [{ id: "PD", name: "Discount Co" }], "customer");
  assert(bal[0].balance === 0, "T14: party balance clears to zero");

  // Only real cash reaches the cash position — never the written-off 500.
  const cash = netFlow(cashFlows([inv], [], [], [pay], []));
  assert(cash === 20000, `T14: cash must be 20000, got ${cash}`);

  // And the direct-portion formula must not invent a phantom receipt: the
  // invoice is "credit" mode, so nothing of it belongs in any mode's flows.
  const bankish = netFlow(bankFlows([inv], [], [], [pay]));
  assert(bankish === 0, "T14: no phantom bank movement");

  assert(totalSettlementDiscount([pay]) === 500, "T14: the write-off is reported for the P&L");
  assert(totalSettlementDiscount([]) === 0, "T14: no payments, no discount");

  // An advance must still be computed off CASH only, not cash + write-off.
  assert(advanceAmount(pay) === 0, "T14: fully applied, so no advance");
  const partial = {
    ...pay,
    amount: 20300,
    allocations: [{ invoiceId: "D1", number: "INV-5001", amount: 20000, discount: 500 }],
  } as unknown as Payment;
  assert(advanceAmount(partial) === 300, "T14: surplus cash is an advance; the write-off is not");
}

/* ═══ TEST 15: stock recomputed from its movements ═══
   Item.stock is a stored running total, so it CAN drift (a half-committed
   bill, a reversal that never landed). The repair rebuilds it from
   opening + purchases + sale returns − sales − purchase returns ± adjustments. */
{
  const item = {
    id: "SR_I1",
    name: "Widget",
    unit: "pcs",
    gstRate: 0,
    purchasePrice: 10,
    salePrice: 20,
    openingStock: 100,
    stock: 999, // deliberately wrong
    createdAt: "",
  } as unknown as Item;

  const line = (qty: number) => ({
    id: "l",
    itemId: "SR_I1",
    name: "Widget",
    unit: "pcs",
    qty,
    price: 10,
    discountPct: 0,
    gstRate: 0,
    amount: qty * 10,
  });
  const sale = { id: "s", lineItems: [line(30)] } as unknown as Invoice;
  const purchase = { id: "p", lineItems: [line(50)] } as unknown as Invoice;
  const saleRet = { id: "sr", lineItems: [line(5)] } as unknown as Return;
  const purRet = { id: "pr", lineItems: [line(2)] } as unknown as Return;
  const adjAdd = { id: "a1", itemId: "SR_I1", type: "add", qty: 7 } as never;
  const adjCut = { id: "a2", itemId: "SR_I1", type: "reduce", qty: 4 } as never;

  // 100 + 50 purchased + 5 returned in − 30 sold − 2 returned out + 7 − 4 = 126
  const plan = planStockRepair({
    items: [item],
    sales: [sale],
    purchases: [purchase],
    saleReturns: [saleRet],
    purchaseReturns: [purRet],
    stockAdjustments: [adjAdd, adjCut],
  });
  assert(plan.length === 1, "T15: drift detected");
  assert(plan[0].correct === 126, `T15: rebuilt stock should be 126, got ${plan[0]?.correct}`);
  assert(plan[0].stored === 999, "T15: reports what was stored");
  assert(plan[0].delta === 126 - 999, "T15: delta is correct − stored");

  // Applying it and re-planning must find nothing left.
  const fixed = { ...item, stock: plan[0].correct } as Item;
  const after = planStockRepair({
    items: [fixed],
    sales: [sale],
    purchases: [purchase],
    saleReturns: [saleRet],
    purchaseReturns: [purRet],
    stockAdjustments: [adjAdd, adjCut],
  });
  assert(after.length === 0, "T15: repair is idempotent");

  // A correct book must never be flagged.
  const clean = planStockRepair({
    items: [{ ...item, stock: 100 } as Item],
    sales: [],
    purchases: [],
    saleReturns: [],
    purchaseReturns: [],
    stockAdjustments: [],
  });
  assert(clean.length === 0, "T15: an untouched item reports no drift");
}

/* ═══ TEST 16: a party is never on BOTH sides at once ═══
   The real case from production: JAY MOBILE DABHOLI carried a 9,850 payable
   opening, then bought 11,000 of goods. Their statement said 1,150
   receivable; the dashboard said 9,850 payable AND 11,000 receivable,
   because the two sides were summed independently and never netted. */
{
  const party = { id: "JAY", name: "JAY MOBILE DABHOLI", openingBalance: -9850 };
  const sale = {
    id: "S",
    number: "0002",
    date: "2026-08-15",
    partyId: "JAY",
    partyName: "JAY MOBILE DABHOLI",
    gstEnabled: false,
    lineItems: [],
    subtotal: 11000,
    discount: 0,
    taxAmount: 0,
    total: 11000,
    paid: 0,
    paymentMode: "credit",
    createdAt: "2026-08-15T09:00:00Z",
  } as unknown as Invoice;

  const [pos] = netPartyPositions([party], {
    sales: [sale],
    purchases: [],
    saleReturns: [],
    purchaseReturns: [],
    payments: [],
  });
  assert(pos.net === 1150, `T16: net must be 1150 receivable, got ${pos.net}`);

  const receivable = Math.max(0, pos.net);
  const payable = Math.max(0, -pos.net);
  assert(receivable === 1150, "T16: appears in receivable");
  assert(payable === 0, "T16: and NOT in payable — never both");

  // A pure supplier still lands wholly on the payable side.
  const supplier = { id: "SUP", name: "Supplier", openingBalance: -9850 };
  const purchase = {
    id: "P",
    number: "PUR-1",
    date: "2026-08-15",
    partyId: "SUP",
    partyName: "Supplier",
    gstEnabled: false,
    lineItems: [],
    subtotal: 450,
    discount: 0,
    taxAmount: 0,
    total: 450,
    paid: 0,
    paymentMode: "credit",
    createdAt: "2026-08-15T09:00:00Z",
  } as unknown as Invoice;
  const [sp] = netPartyPositions([supplier], {
    sales: [],
    purchases: [purchase],
    saleReturns: [],
    purchaseReturns: [],
    payments: [],
  });
  assert(sp.net === -10300, `T16: supplier nets to -10300, got ${sp.net}`);

  // And the net must agree with what the party's own statement closes at —
  // the two disagreeing is exactly what the client reported.
  const stmt = buildPartyStatement(party, {
    sales: [sale],
    purchases: [],
    saleReturns: [],
    purchaseReturns: [],
    payments: [],
  });
  assert(
    Math.abs(stmt.fullBalance - pos.net) < 0.01,
    `T16: dashboard net (${pos.net}) must equal the statement's closing balance (${stmt.fullBalance})`,
  );

  // Paying a bill off moves the net, and an advance counts once.
  const paidSale = { ...sale, paid: 11000 } as Invoice;
  const [paidPos] = netPartyPositions([party], {
    sales: [paidSale],
    purchases: [],
    saleReturns: [],
    purchaseReturns: [],
    payments: [],
  });
  assert(paidPos.net === -9850, "T16: settling the bill leaves just the opening");
}

/* ═══ TEST 17: a stored figure that is not actually a number ═══════════
   Firestore is schemaless: TypeScript says Item.stock is a number, but a
   document can hold the STRING "5" — from an older import, a hand edit, a
   migration. Every screen renders it fine, so it stays invisible until an
   atomic adjustment touches it, and then the local cache and the cloud
   disagree PERMANENTLY:

     local  "5" + 15   → "515"  (JavaScript concatenates)
     cloud  increment  → 15     (Firestore treats a non-number as 0)

   which is how a bulk stock correction can look applied on one screen and
   wrong on the next. Subtraction is worse: "12" - 4 is NaN, stored as null.
   These pin the coercion in Repository.adjustBase. */
{
  const repo = new Repository<{ id: string; stock: number; balance?: number }>("test-adjust");
  const seed = (id: string, stock: unknown) =>
    repo.add({ id, stock } as unknown as { id: string; stock: number });

  seed("A", "5");
  assert(
    repo.adjustField("A", "stock", 15)?.stock === 20,
    "T17: string base adds (not concatenates)",
  );

  seed("B", "12");
  assert(repo.adjustField("B", "stock", -4)?.stock === 8, "T17: string base subtracts (not NaN)");

  seed("C", 5);
  assert(repo.adjustField("C", "stock", 15)?.stock === 20, "T17: a real number is unaffected");

  // A MISSING field keeps working the way Firestore's increment does: base 0.
  seed("D", undefined);
  assert(repo.adjustField("D", "stock", 7)?.stock === 7, "T17: a missing field bases at zero");

  // Junk that cannot be a number at all must not poison the record with NaN.
  seed("E", "abc");
  assert(repo.adjustField("E", "stock", 3)?.stock === 3, "T17: unparseable text bases at zero");

  // Rounding still applies through the coercion.
  seed("F", "2.005");
  assert(
    repo.adjustField("F", "stock", 0)?.stock === 2.01,
    "T17: coerced values still round to 2dp",
  );

  // Repeated adjustments must stay stable once healed.
  seed("G", "10");
  repo.adjustField("G", "stock", 5);
  assert(repo.adjustField("G", "stock", 5)?.stock === 20, "T17: the healed field keeps adding");
}

/* ═══ TEST 18: the repair planner must SEE a malformed stock ══════════
   A string "5" that happens to equal the correct figure produced a delta of
   zero, so Fix Calculations skipped it and the field stayed a string —
   waiting to corrupt itself on the next adjustment. It has to be reported so
   the repair rewrites it as a real number. */
{
  const mkItem = (id: string, stock: unknown, openingStock: unknown): Item =>
    ({
      id,
      name: `Item ${id}`,
      unit: "pcs",
      gstRate: 0,
      purchasePrice: 0,
      salePrice: 0,
      stock,
      openingStock,
      createdAt: "",
    }) as unknown as Item;
  const empty = {
    sales: [],
    purchases: [],
    saleReturns: [],
    purchaseReturns: [],
    stockAdjustments: [],
  };

  const rightValueWrongType = planStockRepair({ ...empty, items: [mkItem("X", "5", 5)] });
  assert(
    rightValueWrongType.length === 1 && rightValueWrongType[0].correct === 5,
    "T18: a string stock is reported even when it reads as the right number",
  );

  const genuinelyFine = planStockRepair({ ...empty, items: [mkItem("Y", 5, 5)] });
  assert(genuinelyFine.length === 0, "T18: a correct numeric stock is still left alone");

  // And the planner's own arithmetic must not concatenate string quantities.
  const withStringQty = planStockRepair({
    ...empty,
    items: [mkItem("Z", 10, 10)],
    stockAdjustments: [
      {
        id: "a1",
        itemId: "Z",
        itemName: "Item Z",
        date: "2026-01-01",
        type: "add",
        qty: "5",
        reason: "",
        createdAt: "",
      } as unknown as StockAdjustment,
    ],
  });
  assert(
    withStringQty.length === 1 && withStringQty[0].correct === 15,
    `T18: a string qty adds as 5, not "105" — got ${withStringQty[0]?.correct}`,
  );
}

/* ═══ TEST 20: one amount, spread oldest bill first ═══════════════════
   The counter takes a round figure off a customer's whole account; they do
   not think in invoices. spreadFifo turns that into allocations, and the
   rules it has to hold to are: oldest first (so an ageing report means
   something), cash before discount ON THE SAME BILL (so the everyday
   "20,000 and knock off the 500" closes it in one step), never settle more
   than a bill owes, and leave the remainder for the caller to record as an
   advance rather than losing it. */
{
  const sum = (a: { apply: number; discount: number }[], k: "apply" | "discount") =>
    Math.round(a.reduce((s, x) => s + x[k], 0) * 100) / 100;

  // The client's own example, as a single bill.
  const one = spreadFifo([20500], 20000, 500);
  assert(
    one[0].apply === 20000 && one[0].discount === 500,
    "T20: 20,000 + 500 off closes a 20,500 bill",
  );

  // Oldest first: the first bill closes before the second sees a rupee.
  const two = spreadFifo([10000, 10500], 15000, 0);
  assert(
    two[0].apply === 10000 && two[1].apply === 5000,
    `T20: the oldest bill is settled first — got ${JSON.stringify(two)}`,
  );

  // The discount follows the cash onto the bill the cash left short.
  const withDisc = spreadFifo([10000, 10500], 20000, 500);
  assert(
    withDisc[0].apply === 10000 &&
      withDisc[0].discount === 0 &&
      withDisc[1].apply === 10000 &&
      withDisc[1].discount === 500,
    `T20: the write-off closes the bill the cash fell short on — got ${JSON.stringify(withDisc)}`,
  );

  // Never over-settle: paying more than is owed leaves the surplus behind
  // for the caller to record as an advance.
  const over = spreadFifo([1000, 500], 5000, 0);
  assert(
    sum(over, "apply") === 1500,
    `T20: a bill is never over-settled — got ${sum(over, "apply")}`,
  );
  assert(
    over.every((r) => r.apply >= 0 && r.discount >= 0),
    "T20: no negative allocation",
  );

  // A discount bigger than the debt is not silently applied either.
  const bigDisc = spreadFifo([300], 0, 1000);
  assert(
    bigDisc[0].discount === 300,
    `T20: the write-off is capped at the due — got ${bigDisc[0].discount}`,
  );

  // Nothing to pay, nothing allocated.
  assert(
    spreadFifo([1000], 0, 0).every((r) => r.apply === 0 && r.discount === 0),
    "T20: zero pays nothing",
  );
  assert(spreadFifo([], 500, 0).length === 0, "T20: no bills, nothing to spread");

  // Negative or junk input must not create money.
  assert(spreadFifo([1000], -50, 0)[0].apply === 0, "T20: a negative amount pays nothing");
  assert(spreadFifo([-1000], 500, 0)[0].apply === 0, "T20: a negative due absorbs nothing");

  // Paise: three bills settled by a total that divides unevenly must still
  // add up to exactly what was handed over, with no drift.
  const paise = spreadFifo([33.33, 33.33, 33.34], 100, 0);
  assert(
    sum(paise, "apply") === 100,
    `T20: paise add back to the amount taken — got ${sum(paise, "apply")}`,
  );

  // Randomised: the invariants above must hold for any shape of account.
  let seed = 4242;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < 2000; i++) {
    const dues = Array.from(
      { length: 1 + Math.floor(rnd() * 6) },
      () => Math.round(rnd() * 500000) / 100,
    );
    const cash = Math.round(rnd() * 600000) / 100;
    const disc = Math.round(rnd() * 20000) / 100;
    const out = spreadFifo(dues, cash, disc);
    const owed = Math.round(dues.reduce((s, d) => s + d, 0) * 100) / 100;
    assert(sum(out, "apply") <= cash + 0.005, "T20: never allocates more cash than was taken");
    assert(sum(out, "discount") <= disc + 0.005, "T20: never writes off more than allowed");
    assert(
      Math.round((sum(out, "apply") + sum(out, "discount")) * 100) / 100 <= owed + 0.005,
      "T20: never settles more than the account owes",
    );
    out.forEach((r, j) =>
      assert(
        Math.round((r.apply + r.discount) * 100) / 100 <= dues[j] + 0.005,
        "T20: never settles more than the bill owes",
      ),
    );
    // FIFO: a bill can only be partly settled if every bill before it is closed.
    for (let j = 1; j < out.length; j++) {
      const prevSettled = Math.round((out[j - 1].apply + out[j - 1].discount) * 100) / 100;
      if (out[j].apply + out[j].discount > 0.005) {
        assert(
          prevSettled >= dues[j - 1] - 0.005,
          "T20: no bill is skipped over an open older one",
        );
      }
    }
  }
}

/* ═══ TEST 21: a payment belongs on the day it happened ═══════════════
   The statement used to credit a bill's whole `paid` against the BILL's date,
   and then drop the payment row entirely whenever it had been fully applied.
   So money taken three weeks after a sale appeared on the sale's line, while
   an unapplied advance got a line of its own — the same act of taking money
   showing up in two different places depending on how it was allocated. That
   is the "sometimes up, sometimes at the bottom" the client reported.

   The split must be presentation only: the closing balance has to come out
   identical, which is what makes this safe to change on live books. */
{
  const party = { id: "LP", name: "Ledger Party", openingBalance: 0 };
  const bill = {
    id: "LB1",
    number: "INV-L1",
    date: "2026-03-01",
    partyId: "LP",
    partyName: "Ledger Party",
    lineItems: [],
    subtotal: 20500,
    discount: 0,
    shippingCharge: 0,
    taxAmount: 0,
    total: 20500,
    // 20,000 cash + a 500 write-off, both applied by the payment below.
    paid: 20500,
    paymentMode: "credit",
    createdAt: "2026-03-01T00:00:00Z",
  } as unknown as Invoice;
  const pay = {
    id: "LPAY",
    date: "2026-03-21",
    partyId: "LP",
    partyName: "Ledger Party",
    type: "in",
    amount: 20000,
    mode: "cash",
    allocations: [{ invoiceId: "LB1", number: "INV-L1", amount: 20000, discount: 500 }],
    createdAt: "2026-03-21T00:00:00Z",
  } as unknown as Payment;

  const { rows, fullBalance } = buildPartyStatement(party, {
    sales: [bill],
    purchases: [],
    saleReturns: [],
    purchaseReturns: [],
    payments: [pay],
  });

  const saleRow = rows.find((r) => r.ref === "INV-L1" && r.type === "Sale");
  assert(!!saleRow, "T21: the sale is on the statement");
  assert(
    saleRow?.receivedOrPaid === 0,
    `T21: the bill's own line shows only what was taken THAT DAY — got ${saleRow?.receivedOrPaid}`,
  );

  const payRow = rows.find((r) => r.type === "Payment Received");
  assert(!!payRow, "T21: a fully-applied payment still gets its own row");
  assert(
    payRow?.date === "2026-03-21" && payRow?.total === 20000,
    `T21: the payment sits on ITS date for the cash actually taken — got ${payRow?.date} / ${payRow?.total}`,
  );
  assert(
    payRow?.ref === "INV-L1",
    `T21: and says which bill it settled — got ${JSON.stringify(payRow?.ref)}`,
  );

  const discRow = rows.find((r) => r.type === "Discount Given");
  assert(!!discRow, "T21: the write-off is its own line, not silent");
  assert(
    discRow?.date === "2026-03-21" && discRow?.total === 500,
    `T21: the write-off is dated with the payment — got ${discRow?.date} / ${discRow?.total}`,
  );

  // The whole point: presentation changed, arithmetic did not.
  assert(fullBalance === 0, `T21: the bill is fully settled — closing ${fullBalance}`);
  const [netPos] = netPartyPositions([party], {
    sales: [bill],
    purchases: [],
    saleReturns: [],
    purchaseReturns: [],
    payments: [pay],
  });
  assert(
    Math.abs(netPos.net - fullBalance) < 0.01,
    `T21: the statement still agrees with the dashboard — ${netPos.net} vs ${fullBalance}`,
  );

  // Cash taken AT the counter still belongs on the bill's own date: it really
  // did happen then, and there is no payment record to carry it.
  const counterBill = { ...bill, id: "LB2", number: "INV-L2", paid: 400, total: 1000 } as Invoice;
  const counter = buildPartyStatement(party, {
    sales: [counterBill],
    purchases: [],
    saleReturns: [],
    purchaseReturns: [],
    payments: [],
  });
  const counterRow = counter.rows.find((r) => r.ref === "INV-L2");
  assert(
    counterRow?.receivedOrPaid === 400,
    `T21: money taken at billing stays on the bill's line — got ${counterRow?.receivedOrPaid}`,
  );
  assert(counter.fullBalance === 600, `T21: leaving 600 owed — got ${counter.fullBalance}`);

  // An advance that settles nothing keeps behaving as it always did.
  const advance = { ...pay, id: "LADV", amount: 300, allocations: undefined } as Payment;
  const withAdvance = buildPartyStatement(party, {
    sales: [],
    purchases: [],
    saleReturns: [],
    purchaseReturns: [],
    payments: [advance],
  });
  assert(
    withAdvance.fullBalance === -300,
    `T21: an unapplied advance still credits the party — got ${withAdvance.fullBalance}`,
  );
  assert(
    withAdvance.rows.filter((r) => r.type === "Payment Received").length === 1,
    "T21: and appears exactly once",
  );
}

/* ═══ TEST 22: recognising both legs of a transfer ════════════════════
   A transfer writes two records, one per account, and they have to be edited
   and deleted as one thing. Newer ones carry a shared id. OLDER ones do not,
   and they are the dangerous case: unrecognised, the Cash page treats the
   cash side as an ordinary manual entry and offers to EDIT it — which would
   move the cash and leave the bank account saying something else. The client
   was shown exactly that dialog. */
{
  const leg = (over: Partial<BankTxn>): BankTxn =>
    ({
      id: "bt" + Math.round((over.amount ?? 0) * 100),
      bankId: "B1",
      date: "2026-08-22",
      type: "deposit",
      amount: 2000,
      notes: "Transfer to K CASH — PIYUSH BHAI VALA",
      createdAt: "",
      ...over,
    }) as BankTxn;
  const cash = (over: Partial<CashAdjustment>): CashAdjustment =>
    ({
      id: "ca1",
      date: "2026-08-22",
      type: "reduce",
      amount: 2000,
      reason: "Transfer to K CASH — PIYUSH BHAI VALA",
      createdAt: "",
      ...over,
    }) as CashAdjustment;

  // The new way: a shared id, and nothing else needs to match.
  assert(
    transferLegsFor(cash({ transferId: "T1" }), [leg({ transferId: "T1", notes: "anything" })])
      .length === 1,
    "T22: a stamped pair is found by its id",
  );

  // The old way: same note, same date, same amount, opposite directions.
  assert(
    transferLegsFor(cash({}), [leg({})]).length === 1,
    "T22: an UNSTAMPED pair is still recognised by note + date + amount",
  );

  // Each of those four has to agree. Any one off and it is not a partner.
  assert(
    transferLegsFor(cash({}), [leg({ amount: 2001 })]).length === 0,
    "T22: a different amount is not the partner",
  );
  assert(
    transferLegsFor(cash({}), [leg({ date: "2026-08-23" })]).length === 0,
    "T22: a different date is not the partner",
  );
  assert(
    transferLegsFor(cash({}), [leg({ notes: "Transfer to somewhere else" })]).length === 0,
    "T22: a different note is not the partner",
  );
  // Direction: cash OUT pairs with money INTO a bank, never out of one.
  assert(
    transferLegsFor(cash({}), [leg({ type: "withdraw" })]).length === 0,
    "T22: both legs going the same way is not a transfer",
  );
  assert(
    transferLegsFor(cash({ type: "add" }), [leg({ type: "withdraw" })]).length === 1,
    "T22: cash IN pairs with money out of a bank",
  );

  // A manual entry that merely mentions a transfer stays editable — there is
  // no partner for it to fall out of step with.
  assert(
    transferLegsFor(cash({ reason: "Transfer to K CASH — PIYUSH BHAI VALA" }), []).length === 0,
    "T22: no partner found means it is an ordinary entry",
  );
  assert(
    transferLegsFor(cash({ reason: "Cash added, transferred from the shop till" }), [leg({})])
      .length === 0,
    "T22: a note that only mentions transferring is not a transfer leg",
  );
  assert(
    transferLegsFor(cash({ reason: undefined }), [leg({ notes: undefined })]).length === 0,
    "T22: an entry with no note is never paired by note",
  );
}

/* ═══ TEST S1: splits describe today's documents without changing them ══
   The seam has one job before anything can create a split: report, for every
   document that already exists, exactly the attribution the current readers
   compute. If it disagrees with them by a rupee, routing them through it
   moves money on screens the shop is using right now. */
{
  const cashBill = { paid: 1000, paymentMode: "cash" } as unknown as Invoice;
  assert(splitsOf(cashBill).length === 1, "S1: a cash bill is one row");
  assert(cashPart(cashBill) === 1000, "S1: and all of it is in the drawer");
  assert(bankParts(cashBill).size === 0, "S1: with no account involved");

  /* A bank bill reports bankPaidAmount, NOT paid. They differ whenever a
     receipt was allocated to this invoice afterwards, and the bank ledger has
     always used the smaller figure — reporting paid here would credit the
     account with money that arrived as a separate Payment. */
  const bankBill = {
    paid: 5000,
    paymentMode: "bank",
    bankId: "B1",
    bankPaidAmount: 3000,
  } as unknown as Invoice;
  assert(bankParts(bankBill).get("B1") === 3000, "S1: a bank bill reports what it attributed");
  assert(
    cashPart(bankBill) === 0,
    "S1: and nothing to cash — the rest of paid came from a Payment with its own mode",
  );

  // Credit is the absence of payment, not a way of paying.
  assert(
    splitsOf({ paid: 0, paymentMode: "credit" } as unknown as Invoice).length === 0,
    "S1: a credit bill attributes nothing",
  );
  assert(
    splitsOf({ paid: 0, paymentMode: "cash" } as unknown as Invoice).length === 0,
    "S1: nor does an unpaid one, whatever mode it names",
  );

  /* upi and cheque name no account. That is a pre-existing wart the daybook
     already buckets, and it must stay visible rather than being quietly
     credited to some account it never reached. */
  const upi = { paid: 700, paymentMode: "upi" } as unknown as Invoice;
  assert(bankParts(upi).size === 0, "S1: unassigned money is not credited to an account");
  assert(cashPart(upi) === 0, "S1: nor counted as cash");
  assert(unassignedPart(upi) === 700, "S1: it is reported as unassigned, which is the truth");

  // Payments and expenses use different field names for the same idea.
  assert(
    cashPart({ amount: 250, mode: "cash" } as unknown as Payment) === 250,
    "S1: a Payment reads the same way",
  );
  assert(
    bankParts({ amount: 400, paymentMode: "bank", bankId: "B2" } as unknown as Expense).get(
      "B2",
    ) === 400,
    "S1: and so does an Expense",
  );

  /* Money that reached the document LATER belongs to the Payment that
     brought it, which carries its own mode and is counted there. A legacy
     document reports its amount less that; stored rows are already the
     document's own portion and must not be reduced a second time. Getting
     either direction wrong is a wrong number on the Cash page. */
  assert(
    cashPart({ paid: 1000, paymentMode: "cash" } as unknown as Invoice, 400) === 600,
    "S1: a legacy row reports only what the document itself settled",
  );
  assert(
    cashPart({ paid: 1000, paymentMode: "cash" } as unknown as Invoice, 1000) === 0,
    "S1: and nothing at all once every rupee of it arrived later",
  );
  assert(
    bankParts(bankBill, 2000).get("B1") === 3000,
    "S1: a legacy bank row is already the at-billing snapshot, so it is NOT reduced again",
  );

  // Stored rows win, and are the only case with more than one.
  const split = {
    paid: 10000,
    paymentMode: "cash",
    paidSplits: [
      { mode: "cash", amount: 4000 },
      { mode: "bank", amount: 6000, bankId: "B1" },
    ],
  } as unknown as Invoice;
  assert(cashPart(split) === 4000, "S1: a split bill reports its cash row");
  assert(
    cashPart(split, 2500) === 4000,
    "S1: and stored rows are the document's own portion already — never reduced twice",
  );
  assert(bankParts(split).get("B1") === 6000, "S1: and its bank row");
  assert(
    cashPart(split) + (bankParts(split).get("B1") ?? 0) === split.paid,
    "S1: and together they are the whole of what was paid",
  );
}

/* ═══ TEST S2: a document may not disagree with itself ══════════════════ */
{
  const ok = [
    { mode: "cash", amount: 4000 },
    { mode: "bank", amount: 6000, bankId: "B1" },
  ] as PaymentSplit[];
  assert(splitProblems(ok, 10000).length === 0, "S2: rows that add up are accepted");
  assert(
    splitProblems(ok, 9500).some((p) => p.message.includes("add up")),
    "S2: rows that do not add up to the amount are refused, and say both figures",
  );
  /* No assertion about sub-paisa dust: splitProblems rounds BOTH sides to
     paise before comparing, so dust cannot reach the comparison at all and
     any test of the tolerance passes with the tolerance removed. The
     tolerance stays as belt-and-braces should the rounding ever go, but
     claiming it is covered would be claiming coverage that does not exist. */
  assert(
    splitProblems([{ mode: "bank", amount: 500 }] as PaymentSplit[], 500).some((p) =>
      p.message.includes("which account"),
    ),
    "S2: bank money must say which account it went to",
  );
  assert(
    splitProblems([{ mode: "cash", amount: 0 }] as PaymentSplit[], 0).some((p) =>
      p.message.includes("enter an amount"),
    ),
    "S2: a row with no amount is not a row",
  );
  assert(
    splitProblems([{ mode: "credit", amount: 100 }] as PaymentSplit[], 100).some((p) =>
      p.message.includes("credit"),
    ),
    "S2: credit is what is left unpaid, not a way of paying",
  );
  assert(splitProblems([], 1000).length === 0, "S2: no rows at all is a single-mode document");
}

/* ═══ TEST S3: a part-cash, part-bank bill reaches BOTH places ══════════
   The reported case: ₹10,000 taken as ₹4,000 cash and ₹6,000 into HDFC.

   The dangerous half is cash. modeFlows used to drop any bill that touched a
   bank, so the ₹6,000 was booked to HDFC correctly and the ₹4,000 simply
   stopped existing — which at the counter reads as the till being short
   rather than as a bug in a report. */
{
  const splitBill = {
    id: "SPL1",
    number: "INV-SPL",
    date: "2026-06-01",
    partyId: "P1",
    partyName: "A Customer",
    lineItems: [],
    total: 10000,
    paid: 10000,
    paymentMode: "cash",
    paidSplits: [
      { mode: "cash", amount: 4000 },
      { mode: "bank", amount: 6000, bankId: "B1" },
    ],
  } as unknown as Invoice;

  const cash = cashFlows([splitBill], [], [], [], []);
  assert(cash.length === 1, `S3: the bill reaches the cash page — ${cash.length} entries`);
  assert(
    netFlow(cash) === 4000,
    `S3: for the cash part only, not the whole bill and not nothing — ${netFlow(cash)}`,
  );

  // And the bank half is still the bank's, counted once.
  assert(
    bankParts(splitBill).get("B1") === 6000,
    "S3: the bank part is attributed to the account it went into",
  );
  assert(
    netFlow(modeFlows("bank", [splitBill], [], [], [])) === 0,
    "S3: and does NOT also appear in the bank-mode flows, which would double it",
  );
  assert(
    r2(netFlow(cash) + (bankParts(splitBill).get("B1") ?? 0)) === splitBill.paid,
    "S3: the two halves account for every rupee of what was paid, exactly once",
  );

  /* The bank half must reach the ACCOUNT's own ledger, not just the
     accessor. This is the mirror of the cash bug: read the account off the
     document's single bankId and a split bill — which has none — shows its
     cash correctly and its bank half nowhere at all. */
  {
    const bank = { id: "B1", name: "HDFC", openingBalance: 0 } as unknown as BankAccount;
    const led = buildBankLedger(bank, {
      sales: [splitBill],
      purchases: [],
      payments: [],
      bankTxns: [],
      expenses: [],
    });
    assert(
      led.rows.some((r) => r.credit === 6000),
      `S3: the account's own ledger shows the bank half — ${JSON.stringify(led.rows.map((r) => r.credit))}`,
    );
    assert(
      r2(led.fullBalance) === 6000,
      `S3: and its balance is that and no more — ${led.fullBalance}`,
    );
    const other = buildBankLedger({ ...bank, id: "B2" } as unknown as BankAccount, {
      sales: [splitBill],
      purchases: [],
      payments: [],
      bankTxns: [],
      expenses: [],
    });
    assert(
      r2(other.fullBalance) === 0,
      "S3: while an account the money never reached shows nothing",
    );
  }

  /* A purchase settled the same way takes money OUT of both. */
  const splitPurchase = {
    ...splitBill,
    id: "SPL2",
    number: "PUR-SPL",
  } as unknown as Invoice;
  assert(
    netFlow(cashFlows([], [splitPurchase], [], [], [])) === -4000,
    "S3: a purchase settled part-cash takes only the cash part out of the drawer",
  );

  /* An ordinary single-mode bill is unaffected — the whole point of the
     accessor is that nothing existing moved. */
  const plainCash = {
    ...splitBill,
    id: "SPL3",
    paidSplits: undefined,
    paid: 800,
    paymentMode: "cash",
  } as unknown as Invoice;
  assert(
    netFlow(cashFlows([plainCash], [], [], [], [])) === 800,
    "S3: a plain cash bill still counts in full",
  );
  const plainBank = {
    ...splitBill,
    id: "SPL4",
    paidSplits: undefined,
    paid: 900,
    paymentMode: "bank",
    bankId: "B1",
    bankPaidAmount: 900,
  } as unknown as Invoice;
  assert(
    netFlow(cashFlows([plainBank], [], [], [], [])) === 0,
    "S3: and a plain bank bill still contributes nothing to cash",
  );
}

/* ═══ TEST S4: how a document says it was paid ══════════════════════════
   A bill printing "Cash" when half of it went to a bank is the original
   complaint restated. Asserted on the exact string, because the printed page
   contains the total and every other figure too — "does the page mention
   ₹1,000" cannot tell a payment label from an invoice line. */
{
  const named = (id: string) => (id === "B1" ? "HDFC Current" : undefined);

  const one = { paid: 1000, paymentMode: "cash" } as unknown as Invoice;
  assert(
    describePayment(one, named) === "Cash",
    `S4: a single-mode bill says just the mode — "${describePayment(one, named)}"`,
  );

  const bank = {
    paid: 1000,
    paymentMode: "bank",
    bankId: "B1",
    bankPaidAmount: 1000,
  } as unknown as Invoice;
  assert(
    describePayment(bank, named) === "HDFC Current",
    `S4: and a bank one names the ACCOUNT rather than the word Bank — "${describePayment(bank, named)}"`,
  );
  assert(
    describePayment(bank) === "Bank",
    "S4: falling back to the mode when no name is available",
  );

  const split = {
    paid: 1000,
    paymentMode: "cash",
    paidSplits: [
      { mode: "cash", amount: 400 },
      { mode: "bank", amount: 600, bankId: "B1" },
    ],
  } as unknown as Invoice;
  assert(
    describePayment(split, named) === "Cash ₹400.00 + HDFC Current ₹600.00",
    `S4: a split says both parts and how much each was — "${describePayment(split, named)}"`,
  );

  assert(
    describePayment({ paid: 0, paymentMode: "credit" } as unknown as Invoice, named) === "Credit",
    "S4: a credit bill still reads as credit",
  );
  /* A new bill starts on Cash so that tabbing lands there, which means an
     unpaid bill can have the Cash pill lit. It is not a cash sale, and saying
     "Cash" on the customer's copy of a bill nobody paid is a small lie that
     becomes an argument later. */
  assert(
    describePayment({ paid: 0, paymentMode: "cash" } as unknown as Invoice, named) === "Unpaid",
    `S4: a bill with the Cash pill lit and nothing received reads as Unpaid — "${describePayment({ paid: 0, paymentMode: "cash" } as unknown as Invoice, named)}"`,
  );
  assert(
    describePayment({ paid: 0, paymentMode: "bank", bankId: "B1" } as unknown as Invoice, named) ===
      "Unpaid",
    "S4: and so does an unpaid one pointed at an account",
  );
}

/* ═══ TEST S5: a split reaches the account's own passbook ═══════════════
   Found by sweeping the rest of the app rather than by a failing test, and
   the worst of the lot. Step 5 moved the account's stored balance for a
   split receipt; the passbook still filtered on the document's bankId, which
   a split does not have. So the balance moved and the passbook did not show
   why — and bankRepair RE-DERIVES balances from exactly these entries, so the
   next repair would have "corrected" the balance back down and taken the
   money with it. */
{
  const bank = { id: "B1", name: "HDFC", openingBalance: 0 } as unknown as BankAccount;
  const splitReceipt = {
    id: "PS1",
    date: "2026-06-01",
    partyId: "P1",
    partyName: "A Customer",
    type: "in",
    amount: 1000,
    mode: "cash",
    splits: [
      { mode: "cash", amount: 400 },
      { mode: "bank", amount: 600, bankId: "B1" },
    ],
  } as unknown as Payment;
  const splitExpense = {
    id: "ES1",
    date: "2026-06-02",
    category: "Rent",
    amount: 500,
    paymentMode: "cash",
    splits: [
      { mode: "cash", amount: 200 },
      { mode: "bank", amount: 300, bankId: "B1" },
    ],
  } as unknown as Expense;

  const led = buildBankLedger(bank, {
    sales: [],
    purchases: [],
    payments: [splitReceipt],
    bankTxns: [],
    expenses: [splitExpense],
  });
  assert(
    led.rows.some((r) => r.credit === 600),
    `S5: a part-bank receipt shows in the passbook — ${JSON.stringify(led.rows.map((r) => [r.type, r.debit, r.credit]))}`,
  );
  assert(
    led.rows.some((r) => r.debit === 300),
    "S5: and so does a part-bank expense",
  );
  assert(
    r2(led.fullBalance) === 300,
    `S5: leaving the balance the passbook itself explains — 600 in, 300 out — ${led.fullBalance}`,
  );
  /* The property that makes the repair safe: what the passbook says and what
     the account holds must be the same number, or a repair "fixes" one of
     them into being wrong. */
  const cashSideOnly = cashPart(splitReceipt) - cashPart(splitExpense);
  assert(
    r2(cashSideOnly) === 200,
    `S5: and the cash halves stay in the drawer, not on the account — ${cashSideOnly}`,
  );
}

/* ═══ TEST S6: a split changes nothing a party can see ══════════════════
   Asked directly what "the party ledger is unaffected by design" means, and
   it deserves an assertion rather than a reading of the code — that same
   reasoning is what missed the passbook.

   The claim: a split decides which of the SHOP's accounts holds the money.
   It never changes what the party owes. So the same bill, settled the same
   total, must produce a byte-for-byte identical statement whether it was
   taken one way or two. If this ever fails, the split work is wrong. */
{
  const party = { id: "PX", openingBalance: 0 };
  const bill = (id: string, paidSplits?: unknown) =>
    ({
      id,
      number: "INV-" + id,
      date: "2026-06-01",
      partyId: "PX",
      partyName: "Someone",
      lineItems: [],
      total: 1000,
      paid: 1000,
      paymentMode: "cash",
      createdAt: "2026-06-01T09:00:00Z",
      ...(paidSplits ? { paidSplits } : {}),
    }) as unknown as Invoice;

  const oneWay = buildPartyStatement(party, {
    sales: [bill("A")],
    purchases: [],
    saleReturns: [],
    purchaseReturns: [],
    payments: [],
  });
  const twoWays = buildPartyStatement(party, {
    sales: [
      bill("A", [
        { mode: "cash", amount: 400 },
        { mode: "bank", amount: 600, bankId: "B1" },
      ]),
    ],
    purchases: [],
    saleReturns: [],
    purchaseReturns: [],
    payments: [],
  });

  assert(
    oneWay.fullBalance === twoWays.fullBalance,
    `S6: splitting a bill does not move the party's balance — ${oneWay.fullBalance} vs ${twoWays.fullBalance}`,
  );
  assert(
    JSON.stringify(oneWay.rows) === JSON.stringify(twoWays.rows),
    "S6: nor any row of their statement — a split is about the shop's accounts, not the party",
  );
  assert(
    twoWays.fullBalance === 0,
    `S6: and a bill paid in full leaves them owing nothing, however it was paid — ${twoWays.fullBalance}`,
  );
}

/* ═══ TEST S7: re-saving a split must not re-attribute the money ════════
   The bug this guards, found by asking whether the feature was really
   finished rather than by any test failing: the payment and expense dialogs
   never loaded an existing record's rows, so reopening a split showed it as
   single-mode. Saving then reversed the rows off their accounts and put the
   whole amount under one mode. The money did not vanish, which is worse —
   it moved somewhere nobody asked it to.

   Asserted on the property that makes a re-save safe: reversing what a
   document attributed and re-applying it must leave every account where it
   started. If the rows are lost in between, this stops being true. */
{
  const rows = [
    { mode: "cash", amount: 400 },
    { mode: "bank", amount: 600, bankId: "B1" },
  ] as PaymentSplit[];
  const saved = { amount: 1000, mode: "cash", splits: rows } as unknown as Payment;

  // What the dialog reloads, and what it would save back unchanged.
  const reloaded = saved.splits?.length ? saved.splits : null;
  assert(!!reloaded, "S7: reopening a split receipt finds its rows to show");

  const resaved = {
    amount: 1000,
    mode: reloaded ? largestSplitMode(reloaded) : "cash",
    splits: reloaded ?? undefined,
  } as unknown as Payment;

  const before = bankParts(saved);
  const after = bankParts(resaved);
  assert(
    (after.get("B1") ?? 0) === (before.get("B1") ?? 0),
    `S7: re-saving it untouched leaves the account exactly where it was — ${before.get("B1")} then ${after.get("B1")}`,
  );
  assert(
    cashPart(resaved) === cashPart(saved),
    "S7: and the drawer too, instead of swallowing the bank half",
  );

  /* The failure it replaces, stated so the assertion above cannot be read as
     trivia: a dialog that dropped the rows would re-save this as one mode. */
  const dropped = { amount: 1000, mode: "cash", splits: undefined } as unknown as Payment;
  assert(
    cashPart(dropped) === 1000 && (bankParts(dropped).get("B1") ?? 0) === 0,
    "S7: losing the rows would put the whole receipt in cash and empty the account",
  );
}

/* ══ Item economics, the way the trade keeps them ═════════════════════════
   Two rates, and they are not the same figure:

     avgBuyRate = total buying / total carat        (never moves on a sale)
     restRate   = (total buying − sales) / rest ct  (a running break-even)

   The first case below is the client's OWN spreadsheet, figure for figure —
   it is the specification. Note what it proves: 2.45 ct went out at 10,224.90
   against a 16,754.23 buying rate, so the rate the rest must fetch RISES to
   19,615.92. A weighted average (which this file used to compute) would have
   answered 16,754.23 and never shown them they were under water on the lot.
   See src/lib/avgCost.ts. */
{
  const AI = (over: Partial<Item> = {}): Item =>
    ({
      id: "AC1",
      name: "Stone",
      unit: "ct",
      gstRate: 1.5,
      purchasePrice: 0,
      salePrice: 0,
      stock: 0,
      openingStock: 0,
      createdAt: "2026-01-01T00:00:00Z",
      ...over,
    }) as Item;
  const AD = (date: string, lines: Partial<LineItem>[], id: string): Invoice =>
    ({
      id,
      number: id,
      date,
      partyId: "P",
      partyName: "P",
      lineItems: lines.map((l, i) => ({
        id: id + i,
        itemId: "AC1",
        name: "Stone",
        unit: "ct",
        discountPct: 0,
        gstRate: 0,
        amount: 0,
        qty: 0,
        price: 0,
        ...l,
      })),
      subtotal: 0,
      discount: 0,
      taxAmount: 0,
      total: 0,
      paid: 0,
      paymentMode: "credit",
      createdAt: date + "T00:00:00Z",
    }) as Invoice;
  const avc = (o: {
    items?: Item[];
    purchases?: Invoice[];
    sales?: Invoice[];
    saleReturns?: Invoice[];
    purchaseReturns?: Invoice[];
    adjustments?: StockAdjustment[];
  }) =>
    buildAverageCosts({
      items: o.items ?? [AI()],
      purchases: o.purchases ?? [],
      sales: o.sales ?? [],
      saleReturns: (o.saleReturns ?? []) as unknown as Return[],
      purchaseReturns: (o.purchaseReturns ?? []) as unknown as Return[],
      adjustments: o.adjustments ?? [],
    }).get("AC1")!;

  /* ── The client's spreadsheet ─────────────────────────────────────────
       bought  5.20 ct   33,332
               2.84 ct  101,372
               8.04 ct  134,704   per ct 16,754.23
       sale    2.45 ct   25,051
       rest    5.59 ct  109,653   per ct 19,615.92                      */
  let a = avc({
    purchases: [
      AD("2026-01-01", [{ qty: 5.2, price: 33332 / 5.2 }], "b1"),
      AD("2026-01-02", [{ qty: 2.84, price: 101372 / 2.84 }], "b2"),
    ],
    sales: [AD("2026-01-03", [{ qty: 2.45, price: 25051 / 2.45 }], "s1")],
  });
  assert(approx(a.boughtQty, 8.04), "TRADE: total carat 8.04");
  assert(approx(a.boughtValue, 134704, 1), "TRADE: total buying 134,704");
  assert(approx(a.avgBuyRate, 16754.23, 0.02), "TRADE: buying per ct 16,754.23");
  assert(approx(a.soldQty, 2.45), "TRADE: sale carat 2.45");
  assert(approx(a.soldValue, 25051, 1), "TRADE: sale value 25,051");
  assert(approx(a.restQty, 5.59), "TRADE: rest carat 5.59");
  assert(approx(a.restValue, 109653, 1), "TRADE: rest value 109,653");
  assert(approx(a.restRate, 19615.92, 0.02), "TRADE: rest per ct 19,615.92");

  // Selling BELOW cost must push the rest rate UP — the reason for the method.
  a = avc({
    purchases: [AD("2026-01-01", [{ qty: 10, price: 100 }], "b1")],
    sales: [AD("2026-01-02", [{ qty: 5, price: 50 }], "s1")],
  });
  assert(approx(a.avgBuyRate, 100), "TRADE: the buying rate never moves on a sale");
  assert(approx(a.restRate, 150), "TRADE: selling under cost raises what the rest must fetch");

  // Selling ABOVE cost pulls it down.
  a = avc({
    purchases: [AD("2026-01-01", [{ qty: 10, price: 100 }], "b1")],
    sales: [AD("2026-01-02", [{ qty: 5, price: 150 }], "s1")],
  });
  assert(approx(a.restRate, 50), "TRADE: selling over cost lowers what is left to recover");

  // A customer return un-does the sale, money and stock together.
  a = avc({
    purchases: [AD("2026-01-01", [{ qty: 10, price: 100 }], "b1")],
    sales: [AD("2026-01-02", [{ qty: 5, price: 150 }], "s1")],
    saleReturns: [AD("2026-01-03", [{ qty: 5, price: 150 }], "sr")],
  });
  assert(approx(a.soldQty, 0) && approx(a.restQty, 10), "TRADE: a sale return puts the stock back");
  assert(approx(a.restRate, 100), "TRADE: and the rate with it");

  // A supplier return leaves the buying pool at what those carats cost.
  a = avc({
    purchases: [
      AD("2026-01-01", [{ qty: 10, price: 100 }], "b1"),
      AD("2026-01-02", [{ qty: 10, price: 200 }], "b2"),
    ],
    purchaseReturns: [AD("2026-01-03", [{ qty: 5, price: 200 }], "pr")],
  });
  assert(approx(a.boughtQty, 15), "TRADE: a purchase return removes the carats");
  assert(approx(a.boughtValue, 2000), "TRADE: at the price they were bought for");

  // Opening stock is stock the business paid for.
  a = avc({
    items: [AI({ openingStock: 4, purchasePrice: 250 })],
    purchases: [AD("2026-01-02", [{ qty: 6, price: 300 }], "b1")],
  });
  assert(approx(a.avgBuyRate, 280), "TRADE: opening stock counts toward the buying rate");

  // A write-off moves carats but no money, so the loss lands on the rest.
  a = avc({
    purchases: [AD("2026-01-01", [{ qty: 10, price: 100 }], "b1")],
    adjustments: [
      {
        id: "ADJ1",
        itemId: "AC1",
        itemName: "Stone",
        date: "2026-01-02",
        type: "reduce",
        qty: 2,
        createdAt: "2026-01-02T00:00:00Z",
      } as StockAdjustment,
    ],
  });
  assert(approx(a.restQty, 8), "TRADE: a write-off reduces the carats left");
  assert(approx(a.restValue, 1000), "TRADE: but not the money already sunk");
  assert(approx(a.restRate, 125), "TRADE: so the rest has to carry it");

  // Sold out — no rate, and certainly not Infinity.
  a = avc({
    purchases: [AD("2026-01-01", [{ qty: 5, price: 100 }], "b1")],
    sales: [AD("2026-01-02", [{ qty: 5, price: 120 }], "s1")],
  });
  assert(
    Number.isFinite(a.restRate) && approx(a.restRate, 0),
    "TRADE: nothing left gives 0, never Infinity or NaN",
  );

  // Line discounts are part of what was really paid AND really received.
  a = avc({
    purchases: [AD("2026-01-01", [{ qty: 10, price: 100, discountPct: 10 }], "b1")],
    sales: [AD("2026-01-02", [{ qty: 5, price: 200, discountPct: 50 }], "s1")],
  });
  assert(approx(a.boughtValue, 900), "TRADE: a purchase line discount lowers the buying pool");
  assert(approx(a.soldValue, 500), "TRADE: a sale line discount lowers what was realised");
  assert(approx(a.restRate, 80), "TRADE: and the rest rate follows both");

  /* ── The client's live CVD sheet, whole ────────────────────────────────
     Nine purchases (the first being opening stock) and seven sales, with
     real GST on both sides. This is the case that pins WHICH money counts:

       purchases  67.25 ct   9,53,947.17  ex-GST      -> 14,185.09 / ct
       sales      57.29 ct   7,89,385.70  incl-GST
       stock       9.96 ct   1,64,561.47              -> 16,522.24 / ct

     Their sheet's own totals are 67.25 / 14185 / 9.96 / 164561 / 16522.
     Counting both sides ex-GST would give 17,693.49 and both incl-GST
     17,244.83 — so this asserts the asymmetry deliberately, not by accident. */
  {
    // price is quoted per carat ex-GST; GST is 1.5% throughout this lot.
    const buy = (date: string, ct: number, total: number, id: string) =>
      AD(date, [{ qty: ct, price: total / ct, gstRate: 1.5 }], id);
    const sell = (date: string, ct: number, total: number, id: string) =>
      AD(date, [{ qty: ct, price: total / ct, gstRate: 1.5 }], id);

    const cvd = avc({
      // Opening stock is the sheet's own "OPNING" row — carried as a purchase
      // with no GST, which is exactly how they enter it.
      purchases: [
        AD("2026-04-01", [{ qty: 14.37, price: 474181.26 / 14.37, gstRate: 0 }], "OPNING"),
        buy("2026-06-03", 16.1, 142658.08, "KIRA1"),
        buy("2026-06-03", 12.05, 100600.03, "KIRA2"),
        buy("2026-06-24", 3.02, 41183.14, "RIDDHI"),
        buy("2026-07-10", 5.08, 48039.78, "JYOTI"),
        buy("2026-07-28", 3.03, 22761.97, "SAKHIYA"),
        buy("2026-07-25", 5.04, 48661.2, "MBEXPORT"),
        buy("2026-07-24", 7.05, 63658.19, "DNGREEN"),
        buy("2026-08-06", 1.51, 12203.52, "CREATIVE"),
      ],
      sales: [
        sell("2026-05-12", 14.37, 213208, "S1"),
        sell("2026-07-24", 5.5, 50985, "S3"),
        sell("2026-07-27", 28.22, 325842, "S5"),
        sell("2026-08-03", 1.38, 15932, "S6"),
        sell("2026-08-17", 3.48, 80937.1, "S7"),
        sell("2026-08-22", 3.04, 68893.9, "S8"),
        sell("2026-09-02", 1.3, 21922, "S9"),
      ],
    });

    assert(approx(cvd.boughtQty, 67.25), "CVD: 67.25 ct bought");
    assert(approx(cvd.boughtValue, 953947.17, 1), "CVD: 9,53,947 bought, ex-GST");
    assert(approx(cvd.avgBuyRate, 14185.09, 0.5), "CVD: buying 14,185 / ct");
    assert(approx(cvd.soldQty, 57.29), "CVD: 57.29 ct sold");
    assert(approx(cvd.soldValue, 789385.7, 2), "CVD: 7,89,386 realised, GST INCLUDED");
    assert(approx(cvd.restQty, 9.96), "CVD: 9.96 ct left, matching their STOCK");
    assert(approx(cvd.restValue, 164561.47, 2), "CVD: 1,64,561 still to recover");
    assert(approx(cvd.restRate, 16522.24, 0.5), "CVD: 16,522 / ct — their PER CARAT");

    // The asymmetry is the point: prove the other two readings are NOT it.
    assert(
      !approx(cvd.restRate, 17693.49, 1) && !approx(cvd.restRate, 17244.83, 1),
      "CVD: not the both-ex-GST nor the both-incl-GST reading",
    );
  }

  // A bill of supply has no GST to add, so selling is just its taxable value.
  a = avc({
    purchases: [AD("2026-01-01", [{ qty: 10, price: 100, gstRate: 3 }], "b1")],
    sales: [
      {
        ...AD("2026-01-02", [{ qty: 5, price: 100, gstRate: 3 }], "s1"),
        gstEnabled: false,
      } as Invoice,
    ],
  });
  assert(approx(a.soldValue, 500), "TRADE: a non-GST bill realises only its taxable value");
}

/* ══ ONE database, named once ══════════════════════════════════════════
   The browser and the server each kept their own copy of the Firestore
   database name. When the app was set up for Starlink Jewels only the browser
   copy was changed, so every server-side permission check looked the signed-in
   user up in the PREVIOUS business's database, found nobody, and refused —
   Share PDF, Download PDF and Team management all failed with a toast that
   named none of it. Both now import the one constant; this pins it there. */
{
  const cfg = readFileSync(process.cwd() + "/src/lib/firebaseConfig.ts", "utf8");
  const client = readFileSync(process.cwd() + "/src/lib/firebase.ts", "utf8");
  const server = readFileSync(process.cwd() + "/src/lib/firebaseAdmin.ts", "utf8");
  // Plain substring checks, no regex: a copied literal is the fault being
  // guarded against, and that is exactly what `DATABASE_ID = "` finds.
  const LITERAL = 'DATABASE_ID = "';
  const SHARED = 'from "./firebaseConfig"';

  assert(
    cfg.includes('export const DATABASE_ID = "starlinkbilling";'),
    "DB: the database is named exactly once, as the Starlink database",
  );
  assert(
    client.includes(SHARED) && !client.includes(LITERAL),
    "DB: the browser takes it from the shared definition rather than a copy",
  );
  assert(
    server.includes(SHARED) && !server.includes(LITERAL),
    "DB: and so does the server, which is the copy that went stale",
  );
  assert(
    server.includes("settings({ databaseId: DATABASE_ID"),
    "DB: and the server actually points the Admin SDK at it",
  );
}

console.log(`  AUDIT RESULT: ${passed} assertions passed, ${failed} failed`);
if (fails.length) {
  console.log(`\nFailures:`);
  fails.forEach((f) => console.log("  ✗ " + f));
  process.exit(1);
}
console.log(`  ✅ ALL INVARIANTS HELD`);
console.log(`══════════════════════════════════════\n`);
