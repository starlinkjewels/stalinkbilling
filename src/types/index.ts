export type ID = string;

export interface Party {
  id: ID;
  name: string;
  type: "customer" | "supplier" | "both";
  phone?: string;
  email?: string;
  gstin?: string;
  /** Income-tax PAN. Printed beside GSTIN on the tax invoice — the trade
   * expects both on a diamond bill, and for an unregistered buyer the PAN is
   * the only identifier there is. */
  pan?: string;
  /** Place of supply, as GST states it: name + state code, e.g.
   * "GUJARAT-24". Left free text rather than a picker because the printed
   * bill reproduces it verbatim; `stateCode` in lib/gst.ts is what the
   * CGST/SGST-vs-IGST decision actually reads, and that prefers the GSTIN. */
  state?: string;
  address?: string;
  shippingAddress?: string;
  openingBalance: number;
  creditLimit?: number;
  /** Soft-delete flag. An archived party is hidden from new-transaction
   * pickers and the active parties list, but its document is kept so every
   * existing invoice/payment/return, ledger, statement, report and dashboard
   * total that references it stays intact. Absence of the field means active
   * — so every party that predates this feature is active automatically. */
  archived?: boolean;
  createdAt: string;
}

export interface Item {
  id: ID;
  name: string;
  sku?: string;
  barcode?: string;
  category?: string;
  unit: string;
  hsn?: string;
  gstRate: number;
  purchasePrice: number;
  salePrice: number;
  wholesalePrice?: number;
  stock: number;
  minStock?: number;
  openingStock: number;
  description?: string;
  createdAt: string;
}

export interface LineItem {
  id: ID;
  itemId: ID;
  name: string;
  /** The billed quantity that `price` multiplies — carat weight on a diamond
   * bill, pieces/kg/metres on any other. Unchanged in meaning and in maths;
   * only the printed column heading differs (see `pcs`). */
  qty: number;
  unit: string;
  /** Loose piece count, printed as its own "Pcs" column alongside the carat
   * weight. Purely informational: the stone count never enters the amount,
   * which stays qty x price, so a bill that leaves it blank totals exactly as
   * it always did. Absent on every line saved before this existed. */
  pcs?: number;
  /** HSN/SAC snapshot taken from the item when the line was created. Snapshot
   * rather than a live ItemRepo lookup so a reprint of an old bill keeps the
   * code that was actually declared on it, even after the item's HSN is
   * corrected in the catalogue. */
  hsn?: string;
  price: number;
  discountPct: number;
  gstRate: number;
  amount: number;
  /** Snapshot of the item's purchase price when the line was created — used for stock-based COGS in P&L */
  costPrice?: number;
  /** Price in the foreign currency, before conversion — only set on
   * international purchases. `price` (INR) is auto-derived from this via
   * the parent Invoice's exchangeRate/carryCostPerUnit, but stays a normal
   * editable field so a cashier can still override the computed value. */
  foreignPrice?: number;
}

export type PaymentMode = "cash" | "bank" | "credit" | "upi" | "cheque";

/**
 * One part of a payment that was not all taken the same way.
 *
 * The shop settles a bill ₹4,000 cash and ₹6,000 into HDFC; that is two rows.
 * A document with no rows means what it has always meant — its own
 * paymentMode and amount — so nothing existing had to be rewritten to add
 * this. See docs/SPLIT-PAYMENT-PLAN.md and lib/paymentSplit.ts, which is the
 * only thing that should read these fields directly.
 */
export interface PaymentSplit {
  mode: PaymentMode;
  amount: number;
  /** Which account it landed in. Required for any mode that names one. */
  bankId?: ID;
}

export interface Invoice {
  id: ID;
  number: string;
  date: string;
  partyId: ID;
  partyName: string;
  partyPhone?: string;
  gstEnabled?: boolean;
  lineItems: LineItem[];
  subtotal: number;
  discount: number;
  /** Flat shipping/freight charge added to the total (sale bills only). */
  shippingCharge?: number;
  taxAmount: number;
  /** Rounding applied to reach a whole-rupee total (e.g. −0.37 or +0.45) */
  roundOff?: number;
  total: number;
  paid: number;
  paymentMode: PaymentMode;
  /** Which bank account `paid` was collected into/from — only set when paymentMode is "bank". */
  bankId?: ID;
  /** Snapshot of `paid` at the moment it was attributed to bankId, so an edit can
   * reverse exactly that amount even if `paid` later grows via Payment allocations. */
  bankPaidAmount?: number;
  /** Set only when the paid amount was NOT all taken one way. Absent on every
   *  document written before splits existed, and on every single-mode one
   *  since. Read it through lib/paymentSplit.ts, never directly. */
  paidSplits?: PaymentSplit[];
  /** Purchase bills only — each line's `foreignPrice` (in the supplier's
   * currency) gets converted to INR as `foreignPrice * exchangeRate +
   * carryCostPerUnit`, so the landed per-unit cost (currency conversion +
   * freight/customs, per piece) is baked into the same `price` field
   * everything else (GST, discount, stock costing) already works off. */
  isInternational?: boolean;
  /** 1 unit of the foreign currency, in INR. */
  exchangeRate?: number;
  /** Flat per-piece freight/customs/handling cost, in INR, added on top of
   * the converted price — distinct from `shippingCharge` (a whole-bill
   * flat charge) since this applies per unit, before qty is multiplied in. */
  carryCostPerUnit?: number;
  /** ---- Tax-invoice header fields ----
   * Everything the printed GST bill carries that isn't derivable from the
   * lines. All optional: a bill that leaves them blank simply prints that row
   * empty, exactly as the trade's own pre-printed stationery does, and every
   * invoice saved before this existed loads unchanged. */
  /** e.g. "10 Days", "Immediate" */
  termsOfPayment?: string;
  transportMode?: string;
  /** GST reverse charge. Absent/false both print "NO". */
  reverseCharge?: boolean;
  /** LUT/ARN for an export made without payment of tax. */
  lutArnNo?: string;
  /** Verbatim place of supply, e.g. "GUJARAT-24". Defaults from the party's
   * own `state` when the bill is created; overridable per bill because
   * ship-to can differ from the buyer's registered state. */
  placeOfSupply?: string;
  /** ---- e-invoice (IRP) fields ----
   * These are ISSUED BY the government e-invoice portal against an upload —
   * this app cannot compute them. They are typed in (or pasted) after the
   * bill is registered, and the whole IRN/ACK/QR block only prints once `irn`
   * is filled. The printed QR encodes `irn`. */
  irn?: string;
  ackNo?: string;
  /** ISO datetime-local string, as the portal reports it. */
  ackDate?: string;
  /** Tax collected at source, as a percentage of (taxable + GST). Kept as a
   * rate rather than an amount so the printed row can show both, matching the
   * trade's bill layout. 0/absent means no TCS and adds nothing to the total. */
  tcsPct?: number;
  notes?: string;
  createdAt: string;
}

/**
 * Who an expense was actually paid to (an employee, landlord, vendor...) —
 * separate from Category (what kind of expense it is), so "how much have I
 * paid Vikas, ever" is answerable without re-deriving it from free text.
 * Deliberately lightweight (no phone/GSTIN/balance like Party) — this is
 * just a name, grown organically as expenses are entered, not a form the
 * user fills out up front.
 */
export interface Payee {
  id: ID;
  name: string;
  /** Pre-fills Category when this payee is picked on a new expense — cuts
   * down on miscategorized entries for a payee that's (almost) always the
   * same kind of spend, e.g. picking "Vikas" always suggesting "Salary". */
  defaultCategory?: string;
  createdAt: string;
}

export interface Expense {
  id: ID;
  date: string;
  category: string;
  amount: number;
  paymentMode: PaymentMode;
  /** Which bank account this was paid from — only set when paymentMode is "bank". */
  bankId?: ID;
  /** Set only when this was not all taken one way. See PaymentSplit. */
  splits?: PaymentSplit[];
  /** Who this was actually paid to — see Payee. Optional on the type so
   * older records saved before this existed still load; the expense form
   * requires it going forward. */
  payeeId?: ID;
  payeeName?: string;
  notes?: string;
  createdAt: string;
}

export interface BankAccount {
  id: ID;
  name: string;
  accountNumber?: string;
  ifsc?: string;
  openingBalance: number;
  balance: number;
  createdAt: string;
}

/** Physical stock correction (damage, counting difference, samples…) */
export interface StockAdjustment {
  id: ID;
  itemId: ID;
  itemName: string;
  date: string;
  type: "add" | "reduce";
  qty: number;
  reason?: string;
  createdAt: string;
}

/** Manual cash-in-hand correction (counter counting, owner drawings…) */
export interface CashAdjustment {
  id: ID;
  date: string;
  type: "add" | "reduce";
  amount: number;
  reason?: string;
  /** Set when this row is one leg of a transfer between accounts. Deleting
   * either leg has to take the other with it, or the money is left half
   * moved — out of one account and never into the other. */
  transferId?: ID;
  createdAt: string;
}

export interface BankTxn {
  id: ID;
  bankId: ID;
  date: string;
  type: "deposit" | "withdraw" | "transfer";
  amount: number;
  notes?: string;
  /** See CashAdjustment.transferId — the same pairing, from the bank side. */
  transferId?: ID;
  createdAt: string;
}

/** How much of a payment was applied to which invoice — needed to reverse
 * invoice.paid when the payment is deleted, and to avoid double counting
 * in ledgers/cash reports. */
export interface PaymentAllocation {
  invoiceId: ID;
  number: string;
  /** Cash/bank actually applied to this invoice. */
  amount: number;
  /**
   * Amount written off on this invoice at the moment of settlement — a
   * "settlement discount". Collecting 20,000 against a 20,500 bill and
   * waiving the last 500 closes the bill without inventing 500 of cash:
   * the invoice's `paid` moves by amount + discount, while only `amount`
   * ever reaches the cash or bank position. The waived part is real cost to
   * the business, so the P&L subtracts it (see valueExTax/discountAllowed).
   */
  discount?: number;
}

export interface Payment {
  id: ID;
  date: string;
  partyId: ID;
  partyName: string;
  type: "in" | "out";
  amount: number;
  mode: PaymentMode;
  /** Which bank account this moved money into/out of — only set when mode is "bank". */
  bankId?: ID;
  /** Set only when this was not all taken one way. See PaymentSplit. */
  splits?: PaymentSplit[];
  ref?: string;
  allocations?: PaymentAllocation[];
  createdAt: string;
}

export interface Return {
  id: ID;
  number: string;
  date: string;
  originalRef?: string;
  partyId: ID;
  partyName: string;
  partyPhone?: string;
  gstEnabled?: boolean;
  lineItems: LineItem[];
  subtotal: number;
  taxAmount: number;
  total: number;
  notes?: string;
  createdAt: string;
}

export type PrintFormat = "a4" | "a4-2up" | "thermal80" | "thermal58";

export interface Company {
  name: string;
  gstin?: string;
  /** Income-tax PAN, printed in the invoice letterhead beside the GSTIN. */
  pan?: string;
  /** Udyam/MSME registration number. Printed (blank-labelled, as the trade's
   * stationery does) at the top-left of the tax invoice. */
  msmeNo?: string;
  /** The seller's own state, "NAME-code" e.g. "GUJARAT-24". Only a fallback:
   * the CGST/SGST-vs-IGST decision reads the GSTIN's first two digits when
   * there is a GSTIN, since that can't drift out of step with reality. */
  stateName?: string;
  phone?: string;
  email?: string;
  address?: string;
  /** ---- Bank details block on the tax invoice ----
   * Which account the buyer should actually pay into. Printed as a labelled
   * block under the line items; any field left blank drops its own row. */
  bankAccountName?: string;
  bankDisplayName?: string;
  bankAccountNo?: string;
  bankIfsc?: string;
  bankBranch?: string;
  /** Terms & Conditions, one string per numbered line, printed in order at
   * the foot of the bill. Editable in Settings because a diamond bill's terms
   * are regulatory text (SRSP, WFDB, e-way-bill exemptions) that changes
   * without any code change being warranted. */
  invoiceTerms?: string[];
  /** City whose courts the bill is subject to — the closing terms line. */
  jurisdiction?: string;
  currency: string;
  invoicePrefix: string;
  purchasePrefix: string;
  enableGst?: boolean;
  /** Round invoice totals to the nearest rupee (default on) */
  enableRoundOff?: boolean;
  /** Allow a sale/purchase-return to push item stock below zero (default on,
   * matching Vyapar/Tally — counter billing shouldn't block on stock entry
   * lagging behind). When turned off, such saves are blocked with an error
   * instead of just a warning. */
  allowNegativeStock?: boolean;
  /** Preferred print format, remembered from the invoice page */
  printFormat?: PrintFormat;
  /** Set once the owner has finished checking existing opening balances
   * (Settings -> Opening Balance Review) and hidden that tool. Purely a UI
   * flag — it changes no number anywhere. */
  openingReviewDone?: boolean;
  /** The expense Category list — admin-managed from Settings, like a real
   * Chart of Accounts, rather than free text every user can invent on the
   * fly. Kept on Company (not its own repository) since it's a short,
   * stable list, unlike Payee which is meant to grow organically. */
  expenseCategories?: string[];
}

/** Matches the Sidebar's own groupings — permissions are granted per group,
 * not per individual page and not as fixed roles. Settings/Team management
 * is deliberately NOT a module here: it's owner-only everywhere, always,
 * so a staff member can never grant themselves broader access by editing
 * their own permissions. "reports" has no collection of its own (Reports/
 * Daybook/GST aggregate reads across the other modules, already protected
 * by their own rules) — it only gates the aggregated-view pages themselves. */
export type ModuleKey = "masterData" | "sales" | "purchaseExpenses" | "cashBank" | "reports";

export interface ModulePermission {
  view: boolean;
  edit: boolean;
  delete: boolean;
}

/** One doc per Firebase Auth UID. The account already using this app in
 * production becomes `isOwner: true` automatically the first time it loads
 * after this ships (see hydrateRepos) — existing behavior is unaffected. */
export interface TeamUser {
  id: string;
  email: string;
  name: string;
  /** Bypasses every permission check everywhere. Exactly one per business —
   * cannot be edited or deactivated by anyone, including another owner. */
  isOwner: boolean;
  /** false = fully locked out (deactivated, not deleted — see Settings/Team). */
  active: boolean;
  /** A module missing from this map means no access at all to it, not
   * "view only" — every level must be explicitly granted. */
  permissions: Partial<Record<ModuleKey, ModulePermission>>;
  createdAt: string;
}
