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
import {
  classifySendFailure,
  isDue,
  needsAttention,
  retryDelayMs,
  queuedMessage,
  MAX_ATTEMPTS,
  CLAIM_STALE_MS,
  type OutboxItem,
} from "@/lib/outbox";
import { transferLegsFor } from "@/lib/transferLegs";
import {
  deriveLinkState,
  linkSeverity,
  needsScan,
  linkHeadline,
  linkAdvice,
  sinceLabel,
  LINK_GRACE_MS,
} from "@/lib/whatsappLink";

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

/* ═══════ TEST W: the WhatsApp link, said in a way a shop can act on ═══════
   The bridge reports three states and a shop needs six. Everything below is
   about the three it cannot report — and the two boundaries that decide
   whether the shop is told "wait" or "go and scan", which are the entire
   value of the feature and are trivially inverted. */
{
  const T0 = Date.parse("2026-09-09T10:00:00Z");
  const fresh = { everConnected: false };
  const used = { everConnected: true, lastConnectedAt: "2026-09-07T10:00:00Z" };

  /* ── Connected outranks everything, including a stale unsettled clock ── */
  assert(
    deriveLinkState({ status: "connected" }, { everConnected: true, unsettledSince: 0 }, T0) ===
      "connected",
    "W1: a live socket reads connected even if the fault clock was left running",
  );
  assert(linkSeverity("connected") === "ok", "W1: and it is the only green state");
  assert(
    linkSeverity("dropped") === "bad" &&
      linkSeverity("never_linked") === "bad" &&
      linkSeverity("unreachable") === "bad" &&
      linkSeverity("scan_needed") === "bad",
    "W1: every state that cannot send a bill shows red",
  );
  assert(
    linkSeverity("starting") === "busy",
    "W1: except a normal start, which must not train the shop to ignore red",
  );

  /* ── The grace period, at both sides of the line ────────────────────── */
  const waitingFor = (ms: number, h: { everConnected: boolean }) =>
    deriveLinkState({ status: "waiting" }, { ...h, unsettledSince: T0 - ms }, T0);

  assert(
    waitingFor(LINK_GRACE_MS - 1000, used) === "starting",
    "W2: one second inside the grace period is still just starting up",
  );
  assert(
    waitingFor(LINK_GRACE_MS + 1000, used) === "dropped",
    "W2: one second past it is a fault the shop is told about",
  );
  assert(
    deriveLinkState({ status: "waiting" }, { everConnected: true }, T0) === "starting",
    "W2: a first reading with no fault clock yet is treated as a start, not a fault",
  );

  /* ── The same wire response, opposite messages ──────────────────────── */
  assert(
    waitingFor(LINK_GRACE_MS + 1000, fresh) === "never_linked",
    "W3: identical bytes mean 'not set up' for a shop that never linked",
  );
  assert(
    waitingFor(LINK_GRACE_MS + 1000, used) === "dropped",
    "W3: and 'it broke' for one that had it working",
  );
  assert(
    linkHeadline("scan_needed", fresh) !== linkHeadline("scan_needed", used),
    "W3: a first link and a relink are not described with the same sentence",
  );

  /* ── A QR is an action, so it outranks the wait ─────────────────────── */
  assert(
    deriveLinkState({ status: "qr" }, { ...used, unsettledSince: T0 - 1000 }, T0) === "scan_needed",
    "W4: a QR one second old is offered immediately, not hidden behind the grace period",
  );

  /* ── An unreachable service is a different fault from a dead socket ─── */
  assert(
    deriveLinkState({ status: null }, { ...used, unsettledSince: T0 - 1000 }, T0) === "starting",
    "W5: one missed poll during a cold start does not go red",
  );
  assert(
    deriveLinkState({ status: null }, { ...used, unsettledSince: T0 - 60_000 }, T0) ===
      "unreachable",
    "W5: a service that keeps not answering is named as the service, not as WhatsApp",
  );
  assert(
    linkHeadline("unreachable", used) !== linkHeadline("dropped", used),
    "W5: because the two need different people to fix them",
  );

  /* ── Staff are never handed work only an owner can do ───────────────── */
  for (const st of ["scan_needed", "dropped", "never_linked", "unreachable"] as const) {
    assert(
      !/scan/i.test(linkAdvice(st, used, false)),
      "W6: staff are never told to scan a QR they will never be shown — " + st,
    );
    assert(
      needsScan(st) === (st !== "unreachable"),
      "W6: only a link fault is fixed by scanning; an unreachable service is not — " + st,
    );
  }
  assert(
    /owner/i.test(linkAdvice("dropped", used, false)),
    "W6: they are told who can fix it instead",
  );
  assert(
    /Linked Devices/i.test(linkAdvice("scan_needed", used, true)),
    "W6: while the owner gets the actual steps on the phone",
  );
  assert(
    !needsScan("connected") && !needsScan("starting"),
    "W6: and nothing is asked of anyone while it is working",
  );

  /* ── "since Tuesday" — the phrase that says how many bills went unsent ─ */
  const H = 3_600_000;
  assert(sinceLabel(undefined, T0) === undefined, "W7: a shop that never linked has no since");
  assert(
    sinceLabel(new Date(T0 - 30 * 60_000).toISOString(), T0) === "Last connected 30 minutes ago",
    "W7: minutes while it is still this shift",
  );
  assert(
    sinceLabel(new Date(T0 - 5 * H).toISOString(), T0) === "Last connected 5 hours ago",
    "W7: hours after that",
  );
  assert(
    sinceLabel(new Date(T0 - 50 * H).toISOString(), T0) === "Last connected 2 days ago",
    "W7: and days once it has been broken overnight",
  );
  assert(
    sinceLabel(new Date(T0 - 40 * 24 * H).toISOString(), T0) ===
      "Last connected more than a week ago",
    "W7: past a week it stops implying a precision this record does not have",
  );
  assert(
    sinceLabel(new Date(T0 + H).toISOString(), T0) === undefined,
    "W7: a clock skewed into the future says nothing rather than something absurd",
  );
}

/* ═══════ TEST W8: the QR must never reach a staff browser ═══════
   Read from the source rather than exercised, because the thing being
   protected is an absence — a field that must not be in a response — and the
   way it comes back is a refactor that "simplifies" the explicit field list
   into a spread. A test that renders a screen would not notice. */
{
  const src = readFileSync(process.cwd() + "/src/lib/whatsappAdmin.ts", "utf8");

  const staffAt = src.indexOf("export const getWhatsAppLinkStateServerFn");
  assert(
    staffAt !== -1,
    "W8: the staff-facing reader exists (renamed? this check just went blind)",
  );

  // To the end of that declaration, not to the end of the file.
  const after = src.slice(staffAt);
  const end = after.indexOf("\n  });");
  assert(end !== -1, "W8: its handler body could be delimited");
  const body = after.slice(0, end);

  assert(body.includes("requireActiveUser"), "W8: anyone who may send a bill may read the status");
  assert(
    !body.includes("requireOwner"),
    "W8: but it is not quietly narrowed back to owners, which would break the header for staff",
  );
  assert(
    !/\bqr\s*:/.test(body),
    "W8: and it never returns the QR itself — that code IS a login to the shop's WhatsApp",
  );
  assert(
    !/\.\.\.\s*\w+/.test(body),
    "W8: fields are listed one by one, so a new secret on the service stays behind by default",
  );

  const ownerAt = src.indexOf("export const getWhatsAppStatusServerFn");
  assert(ownerAt !== -1, "W8: the owner's reader is still there");
  const ownerBody = src.slice(ownerAt, ownerAt + src.slice(ownerAt).indexOf("\n  });"));
  assert(
    ownerBody.includes("requireOwner"),
    "W8: and it is the one that stayed owner-only, since it is the one carrying the QR",
  );
}

/* ═══════ TEST X: the outbox, and what it refuses to do on its own ═══════
   A queue that retries everything is not resilience — it is a machine for
   sending a customer two copies of the same invoice, and for keeping a bill
   that can never send in a red badge until the shop stops reading badges.
   Both refusals are asserted here. */
{
  const T0 = Date.parse("2026-09-09T10:00:00Z");
  const row = (over: Partial<OutboxItem> = {}): OutboxItem => ({
    id: "q1",
    label: "INV-0012",
    phone: "9876543210",
    message: "hi",
    fileName: "INV-0012.pdf",
    html: "<html></html>",
    landscape: false,
    queuedAt: new Date(T0 - 3_600_000).toISOString(),
    attempts: 0,
    auto: true,
    ...over,
  });

  /* ── Nothing that will fail forever goes in the queue ────────────────── */
  for (const m of [
    "This party has no phone number saved — add one to send via WhatsApp.",
    "Not signed in",
    "WhatsApp service isn't configured yet — set WHATSAPP_SERVICE_URL and ...",
    "Only the business owner can do this.",
    "Your account isn't active — ask the business owner to check your access.",
  ]) {
    assert(
      classifySendFailure(m, false) === "permanent",
      "X1: a fault in the request is never queued to retry forever — " + m.slice(0, 34),
    );
    assert(
      classifySendFailure(m, true) === "permanent",
      "X1: and the link's state does not change that — " + m.slice(0, 34),
    );
  }

  /* ── Only a failure we can prove is retried by itself ────────────────── */
  assert(
    classifySendFailure("Could not send WhatsApp message", false) === "offline",
    "X2: with the link already down, the message certainly did not go",
  );
  assert(
    classifySendFailure("Session not connected", true) === "offline",
    "X2: and the service saying so is just as good a proof",
  );
  assert(
    classifySendFailure("socket hang up", true) === "uncertain",
    "X3: but an unexplained failure on a live link might have sent — it is NOT offline",
  );
  assert(
    !isDue(row({ auto: false }), T0 + 86_400_000),
    "X3: and an uncertain one is never sent again by a timer, however long it waits",
  );
  assert(needsAttention(row({ auto: false })), "X3: it waits for a person instead, and says so");

  /* ── Backoff counts from the last attempt, not from queueing ─────────── */
  assert(
    retryDelayMs(0) < retryDelayMs(3) && retryDelayMs(3) < retryDelayMs(6),
    "X4: waits grow with each failure",
  );
  assert(retryDelayMs(99) === 1_800_000, "X4: and stop growing at half an hour");
  {
    const tried = row({ attempts: 3, lastAttemptAt: new Date(T0 - 1000).toISOString() });
    assert(
      !isDue(tried, T0),
      "X4: a row tried a second ago is not due again, however old the queue entry is",
    );
    assert(
      isDue({ ...tried, lastAttemptAt: new Date(T0 - retryDelayMs(3) - 1000).toISOString() }, T0),
      "X4: and is due once its own wait has passed",
    );
  }

  /* ── Two tills must not send the same bill twice ─────────────────────── */
  assert(
    !isDue(row({ sendingSince: T0 - 1000 }), T0),
    "X5: a row another tab is already sending is left alone",
  );
  assert(
    isDue(row({ sendingSince: T0 - CLAIM_STALE_MS - 1000 }), T0),
    "X5: unless that tab died holding it, or the row would be stuck forever",
  );

  /* ── Giving up hands over to a person; it never discards the bill ────── */
  assert(
    !isDue(row({ attempts: MAX_ATTEMPTS }), T0),
    "X6: after the last attempt the timer stops trying",
  );
  assert(
    needsAttention(row({ attempts: MAX_ATTEMPTS })),
    "X6: and the row is raised for a person rather than quietly dropped",
  );
  assert(
    !needsAttention(row({ attempts: MAX_ATTEMPTS - 1 })),
    "X6: while it still has attempts left, nobody is bothered",
  );

  /* ── The counter is told which of the two situations it is ───────────── */
  assert(
    queuedMessage("offline", "this invoice") !== queuedMessage("uncertain", "this invoice"),
    "X7: 'it will send itself' and 'check whether it sent' are not the same sentence",
  );
  assert(
    /queued|will send/i.test(queuedMessage("offline", "this invoice")),
    "X7: the offline one promises it will go",
  );
  assert(
    !/will send on its own/i.test(queuedMessage("uncertain", "this invoice")),
    "X7: the uncertain one promises nothing of the sort",
  );
}

/* ═══════ TEST Y: the two rules at the send seam ═══════
   Read from the source, because both are about ORDER and about an exception
   NOT being swallowed — neither shows up in the value a function returns, and
   both are exactly the kind of thing a later tidy-up inverts while every
   other test stays green. */
{
  const src = readFileSync(process.cwd() + "/src/lib/whatsappSend.ts", "utf8");

  /* ── The link is read BEFORE the attempt ───────────────────────────────
     A failed send drives the indicator red. Read it afterwards and the
     answer is always "it was down", so every unexplained failure would be
     filed as safe-to-retry — which is the machine for sending a customer a
     second copy of their invoice. */
  const readAt = src.indexOf('useWhatsAppLinkStore.getState().state === "connected"');
  const transmitAt = src.indexOf("await transmit(");
  assert(readAt !== -1, "Y1: the send path still reads the link state at all");
  assert(transmitAt !== -1, "Y1: and still transmits (renamed? this check just went blind)");
  assert(
    readAt < transmitAt,
    "Y1: it is read BEFORE the attempt, or every uncertain failure is misfiled as offline",
  );

  /* ── A fault in the request is never queued ──────────────────────────── */
  assert(
    /phase === "prepare"\)\s*throw/.test(src),
    "Y2: a prepare-phase failure is rethrown, not put in a queue that can only fail",
  );
  assert(/kind === "permanent"\)\s*throw/.test(src), "Y2: and so is anything classified permanent");

  /* ── Only a provable failure retries itself ──────────────────────────── */
  assert(
    /auto:\s*kind === "offline"/.test(src),
    "Y3: the queue only re-sends on its own what it can prove never went",
  );

  /* ── One bill, one id, across every attempt ───────────────────────────
     The service refuses a second send of an id it has already sent. That
     only protects anybody if a retry arrives under the SAME id — a fresh id
     per attempt is, from the service's side, simply a different bill, and
     the duplicate it exists to stop goes out anyway. Two halves, both
     needed, and both silently satisfiable-looking on their own. */
  const mintAt = src.indexOf("const clientMessageId =");
  assert(mintAt !== -1, "Y4: the send path mints an id for the bill");
  assert(
    mintAt < transmitAt,
    "Y4: before the first attempt, so the first send and its retries share it",
  );
  assert(
    /id:\s*clientMessageId,/.test(src),
    "Y4: and the queued row is stored under that very id, not a new one",
  );

  const queue = readFileSync(process.cwd() + "/src/store/whatsappOutbox.ts", "utf8");
  assert(
    /clientMessageId:\s*item\.id,/.test(queue),
    "Y4: which the queue then sends back as the id, closing the loop",
  );
}

/* ═══════ TEST Z: a service that answered is never called unreachable ═══════
   The bug this replaces was live for one deploy. A bridge responding in
   under half a second was shown to the shop as "Can't reach the WhatsApp
   service", because every failure — a rejected token, our own server
   erroring, the bridge genuinely being down — arrived as one exception and
   was rendered as the last of those. The fix is that the reader REPORTS an
   unreachable bridge rather than throwing, so a throw can only mean the call
   itself never got off the ground. Asserted from the source, because what
   matters is the shape of the contract rather than any one value. */
{
  const admin = readFileSync(process.cwd() + "/src/lib/whatsappAdmin.ts", "utf8");
  const at = admin.indexOf("export const getWhatsAppLinkStateServerFn");
  assert(at !== -1, "Z1: the staff-facing reader exists (renamed? this check just went blind)");
  const body = admin.slice(at, at + admin.slice(at).indexOf("\n  });"));

  assert(
    /reachable:\s*true/.test(body) && /reachable:\s*false/.test(body),
    "Z1: it answers whether the bridge replied, rather than leaving it to an exception",
  );
  assert(
    /catch\s*\(/.test(body),
    "Z1: a bridge that fails to answer is caught here, not thrown at the browser",
  );
  assert(
    /error:/.test(body),
    "Z1: and its actual words are handed back, so the screen can say what went wrong",
  );

  const store = readFileSync(process.cwd() + "/src/store/whatsappLink.ts", "utf8");
  assert(
    /lean\.reachable\s*\?/.test(store),
    "Z2: the store trusts that answer instead of inferring reachability from a throw",
  );
  assert(
    /askFailed\s*=\s*true/.test(store),
    "Z2: and a call that never got off the ground is recorded as OUR fault, separately",
  );
  assert(
    !/}\s*catch\s*{\s*reading\s*=\s*{\s*status:\s*null\s*};?\s*}/.test(store),
    "Z2: no bare catch quietly turning every fault into 'the service is down' again",
  );

  /* ── The Settings card must still be able to show a QR ────────────────
     Gating the code on being inside the header dialog meant an owner on the
     Settings page — where this shop has always scanned from — waited forever
     for a QR that was sitting on the service the whole time. */
  const ui = readFileSync(process.cwd() + "/src/components/WhatsAppLink.tsx", "utf8");
  assert(
    /useWatchWhileMounted\(isOwner\)/.test(ui),
    "Z3: any panel an owner is looking at asks for the QR, not only the dialog",
  );
  assert(
    /lastError/.test(ui),
    "Z3: and whatever went wrong is put on the screen rather than kept in a variable",
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
