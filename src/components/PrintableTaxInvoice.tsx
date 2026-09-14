import type { Invoice, Company, Party } from "@/types";
import { PartyRepo } from "@/repositories";
import {
  amountInWords,
  fmtAckDate,
  fmtBillDate,
  fmtNum,
  isInterState,
  placeLabel,
  stateCodeOfGstin,
  stateWithCode,
} from "@/lib/gst";
import { qrSvgDataUri } from "@/lib/qr";

interface Props {
  inv: Invoice;
  company: Company;
  mode: "sale" | "purchase";
  /** "print-area" (default) stays hidden until printed — used for the
   * always-mounted copy inside the create/edit form. Detail pages that show
   * this invoice on screen too should pass "print-visible" instead. */
  className?: string;
  /** Shrinks every font-size/padding/column-width proportionally — used to
   * fit two copies side by side on one landscape page. Deliberately NOT done
   * via CSS `zoom`: Chrome computes print page-breaks from the pre-zoom
   * layout size, so a zoomed block can get cut off mid-page even though it
   * visually looks like it fits — real layout-level scaling avoids that. */
  scale?: number;
  /**
   * How tall the bill's ruled frame should be, in FINAL rendered pixels (not
   * scaled by `scale` — it describes the paper, not the drawing).
   *
   * A professional bill occupies the whole sheet: the signature block belongs
   * at the foot of the page, not floating two-thirds of the way down with a
   * band of white under it. The line-item area stretches to make up whatever
   * the rest of the bill doesn't use, so a one-line bill and a ten-line bill
   * both end at the same place.
   *
   * A4 portrait at 96dpi is 1123px tall, less the 12mm print margin top and
   * bottom (see the @page rule in styles.css) — about 1032px of usable
   * height. This is a MINIMUM, so a bill with more lines than fit simply
   * grows and flows onto a second page as it always did.
   */
  pageHeight?: number;
}

/** A4 portrait at 96dpi (1123px) less the 12mm print margins top and bottom. */
const A4_CONTENT_HEIGHT = 1030;

const r2 = (n: number) => Math.round(n * 100) / 100;
const BD = "1px solid #000";

/**
 * The A4 GST tax invoice, laid out to match the trade's own printed bill:
 * ruled throughout, letterhead on top, buyer and bill/e-invoice meta side by
 * side, a Sr/Quality/HSN/Pcs/Carat/Rate/Amount line table that stretches to
 * fill the page, then a tax summary sitting beside the bank details, the
 * amount in words, the terms, and the two signature blocks.
 *
 * Everything is inline-styled with explicit black borders rather than Tailwind
 * classes, for the same reason the older PrintableInvoice was: this subtree is
 * handed straight to the server-side PDF renderer (lib/pdfServer.ts) and to
 * the browser's print path, and neither is a place to discover that a utility
 * class didn't make it into the stylesheet.
 */
export function PrintableTaxInvoice({
  inv,
  company,
  mode,
  className = "print-area",
  scale = 1,
  pageHeight = A4_CONTENT_HEIGHT,
}: Props) {
  const gstOn = inv.gstEnabled !== false;
  const isSale = mode === "sale";
  const party: Party | undefined = inv.partyId ? PartyRepo.get(inv.partyId) : undefined;

  // Every font-size / padding / column-width number below goes through this,
  // so `scale` genuinely shrinks the rendered layout instead of just the
  // visual appearance.
  const s = (n: number) => Math.round(n * scale * 10) / 10;

  // ---- Figures -----------------------------------------------------------
  // "Taxable Value" is NOT inv.subtotal: the stored subtotal is pre-line-
  // discount, while what a GST bill declares as taxable is post-discount.
  //
  // The per-line figure is rounded to paise BEFORE being summed, which is
  // exactly what InvoiceForm's recalc() does when it builds inv.total. Summing
  // raw and rounding once looks equivalent and isn't: on a multi-line bill the
  // two disagree by a paisa, and since Net Total comes from recalc's version,
  // the printed column would then visibly fail to add up.
  const lineTaxable = (l: Invoice["lineItems"][number]) =>
    r2(l.qty * l.price * (1 - l.discountPct / 100));

  let taxableTotal = 0;
  let totalPcs = 0;
  let totalQty = 0;
  inv.lineItems.forEach((l) => {
    taxableTotal += lineTaxable(l);
    totalPcs += l.pcs ?? 0;
    totalQty += l.qty;
  });
  taxableTotal = r2(taxableTotal);

  // The STORED tax, not a fresh recomputation — this is the figure that
  // actually produced inv.total, so taking it verbatim is what guarantees
  // Taxable Value + GST + TCS ± Round Off equals the Net Total printed below.
  const gstTotal = gstOn ? r2(inv.taxAmount || 0) : 0;

  // Whole-bill discount and shipping get their own declared rows so the
  // column still adds up to the Net Total — the trade's pre-printed layout has
  // no slot for them, but a bill that doesn't foot is worse than one carrying
  // an extra row.
  const discount = r2(inv.discount || 0);
  const shipping = r2(inv.shippingCharge || 0);

  // CGST+SGST vs IGST — see lib/gst.ts. Half each on an intra-state bill.
  const interState = isInterState({
    companyGstin: company.gstin,
    companyState: company.stateName,
    partyGstin: party?.gstin,
    placeOfSupply: inv.placeOfSupply ?? party?.state,
  });
  const halfGst = r2(gstTotal / 2);
  const cgst = interState ? 0 : halfGst;
  // The remainder, NOT a second halved-and-rounded figure: halving an odd-paise
  // total and rounding both halves the same way loses (or invents) a paisa, and
  // CGST + SGST then doesn't equal the tax actually charged.
  const sgst = interState ? 0 : r2(gstTotal - halfGst);
  const igst = interState ? gstTotal : 0;

  /** The single GST rate to name beside each head. A bill whose lines carry
   * different rates has no one rate to print, so the label falls back to the
   * head's name alone — the amount column stays exact either way. */
  const rates = Array.from(new Set(inv.lineItems.map((l) => l.gstRate)));
  const oneRate = gstOn && rates.length === 1 ? rates[0] : null;
  const halfRate = oneRate !== null ? ` ${(oneRate / 2).toFixed(3)} %` : "";
  const fullRate = oneRate !== null ? ` ${oneRate.toFixed(3)} %` : "";

  const tcsPct = inv.tcsPct ?? 0;
  const tcsAmount = r2((taxableTotal + gstTotal - discount + shipping) * (tcsPct / 100));
  const roundOff = r2(inv.roundOff || 0);

  /**
   * The rows between "Taxable Value" and "Net Total".
   *
   * SGST/CGST/IGST and TCS all print on a GST bill even at 0.000% — that is
   * what the trade's stationery shows, and a buyer's accounts clerk reads a
   * missing head as an omission rather than as a zero. Discount, Shipping and
   * Round Off are the opposite: they are this app's own rows, not the
   * stationery's, so each appears only when it actually carries a figure.
   *
   * Built once and reused for both the rendering AND the bank block's
   * rowSpan, so the two can never disagree about how tall this block is.
   */
  const taxRows: { label: string; value: number; blank?: boolean }[] = [];
  if (discount > 0) taxRows.push({ label: "Less: Discount", value: -discount });
  if (shipping > 0) taxRows.push({ label: "Shipping Charge", value: shipping });
  if (gstOn) {
    taxRows.push({ label: `SGST${interState ? " 0.000 %" : halfRate}`, value: sgst });
    taxRows.push({ label: `CGST${interState ? " 0.000 %" : halfRate}`, value: cgst });
    taxRows.push({ label: `IGST${interState ? fullRate : " 0.000 %"}`, value: igst });
  }
  if (gstOn || tcsPct > 0) {
    taxRows.push({ label: `TCS ${tcsPct.toFixed(3)} %`, value: tcsAmount });
  }
  if (Math.abs(roundOff) > 0.001) taxRows.push({ label: "Round Off +/-", value: roundOff });
  // A non-GST bill with nothing else on it would otherwise leave the left
  // block rowspanning across the Net Total row alone, which is legal but
  // squashes the bank details into one line. `blank` so the spacer prints as
  // empty ruling rather than as an unexplained "0.00" above the Net Total.
  if (!taxRows.length) taxRows.push({ label: "", value: 0, blank: true });

  const buyerState = stateWithCode(party?.state, party?.gstin);
  // Place of supply gets the same treatment, so the two lines can't disagree
  // about the code when one was typed by hand and the other derived.
  const placeOfSupply =
    stateWithCode(inv.placeOfSupply, party?.gstin) ||
    buyerState ||
    placeLabel(stateCodeOfGstin(party?.gstin)) ||
    "";

  const qr = inv.irn ? qrSvgDataUri(inv.irn) : "";
  const title = gstOn ? "Tax Invoice" : isSale ? "Bill of Supply" : "Purchase Bill";

  // ---- Shared cell styles ------------------------------------------------
  const cell: React.CSSProperties = {
    border: BD,
    padding: `${s(3)}px ${s(5)}px`,
    fontSize: s(10),
    verticalAlign: "top",
  };
  const th: React.CSSProperties = {
    ...cell,
    fontWeight: 700,
    textAlign: "center",
    verticalAlign: "middle",
    // A wrapped heading ("Sr / No", "Taxable / Value") makes one row of the
    // ruled grid taller than the rest and visibly breaks the alignment the
    // whole layout depends on. The columns are sized to fit these, so
    // forbidding the wrap here is what keeps that sizing honest — if a label
    // ever outgrows its column the overflow is obvious rather than silent.
    whiteSpace: "nowrap",
  };
  const num: React.CSSProperties = { textAlign: "right", fontVariantNumeric: "tabular-nums" };
  /** The tax-summary label/value cells — same no-wrap rule as the headings. */
  const taxCell: React.CSSProperties = { ...cell, whiteSpace: "nowrap" };
  const small: React.CSSProperties = { fontSize: s(9.5) };

  const addressLines = (text?: string) =>
    (text ?? "")
      .split(/\r?\n/)
      .map((t) => t.trim())
      .filter(Boolean);

  const terms =
    company.invoiceTerms && company.invoiceTerms.length
      ? company.invoiceTerms
      : ["Goods once sold will not be taken back."];

  /** One "Label : Value" line in the invoice-meta block. */
  const meta = (label: string, value: string) => (
    <tr key={label}>
      <td style={{ ...small, whiteSpace: "nowrap", paddingRight: s(4) }}>{label}</td>
      <td style={{ ...small, paddingRight: s(4) }}>:</td>
      <td style={{ ...small, fontWeight: 600, width: "100%" }}>{value}</td>
    </tr>
  );

  return (
    <div
      className={className}
      style={{ fontFamily: "Arial, Helvetica, sans-serif", color: "#000", lineHeight: 1.3 }}
    >
      {/* The bill's ruled frame, stretched to the full sheet.
          A flex column whose ONLY growing child is the line-item table: every
          other block (letterhead, buyer, totals, terms, signatures) is
          content-sized, so all the slack lands in the item area and the
          signature line always sits at the foot of the page. minHeight, not
          height, so a bill too long for one sheet still flows onto the next
          instead of being squashed. */}
      <div
        style={{
          border: BD,
          minHeight: pageHeight,
          display: "flex",
          flexDirection: "column",
        }}
      >
        {/* ================= Letterhead =================
            Given real vertical room rather than being sized tight to its
            text: this is the band a pre-printed letterhead or a rubber stamp
            lands on, and the company name is what the buyer identifies the
            bill by across a desk. The extra height is taken out of the
            line-item area, which stretches, so the page still ends exactly
            where it did. */}
        <div style={{ borderBottom: BD, padding: `${s(14)}px ${s(8)}px`, textAlign: "center" }}>
          <div style={{ fontSize: s(28), fontWeight: 800, letterSpacing: s(0.8) }}>
            {company.name || "Your Company"}
          </div>
          {addressLines(company.address).map((line, i) => (
            <div key={i} style={{ fontSize: s(10) }}>
              {line}
            </div>
          ))}
          {(company.email || company.phone) && (
            <div style={{ fontSize: s(10) }}>
              {company.email && <>EMail:- {company.email}</>}
              {company.email && company.phone && " · "}
              {company.phone && <>Ph: {company.phone}</>}
            </div>
          )}
        </div>

        {/* MSME / title / PAN + GSTIN strip */}
        <table style={{ width: "100%", borderCollapse: "collapse", borderBottom: BD }}>
          <tbody>
            <tr>
              <td
                style={{
                  width: "30%",
                  fontSize: s(10),
                  fontWeight: 600,
                  padding: `${s(4)}px ${s(8)}px`,
                  verticalAlign: "top",
                }}
              >
                MSME NO: {company.msmeNo ?? ""}
              </td>
              <td
                style={{
                  textAlign: "center",
                  fontSize: s(13),
                  fontWeight: 700,
                  padding: `${s(4)}px 0`,
                  verticalAlign: "top",
                }}
              >
                {title}
              </td>
              <td
                style={{
                  width: "30%",
                  textAlign: "right",
                  fontSize: s(10),
                  fontWeight: 600,
                  padding: `${s(4)}px ${s(8)}px`,
                  verticalAlign: "top",
                }}
              >
                {company.pan && <div>Pan No : {company.pan}</div>}
                {gstOn && company.gstin && <div>GSTIN: {company.gstin}</div>}
              </td>
            </tr>
          </tbody>
        </table>

        {/* ================= Buyer + bill meta ================= */}
        <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
          <tbody>
            <tr>
              {/* --- Buyer / ship-to --- */}
              <td style={{ ...cell, border: "none", borderRight: BD, width: "53%" }}>
                <div style={small}>Name &amp; Address Of {isSale ? "Customer" : "Supplier"}</div>
                <div style={{ fontSize: s(11), fontWeight: 700 }}>{inv.partyName || "—"}</div>
                {addressLines(party?.address).map((line, i) => (
                  <div key={i} style={small}>
                    {line}
                  </div>
                ))}
                {/* Name AND code — "GUJARAT-24". The code is what a buyer's
                    accounts clerk checks the tax heads against, so it is
                    filled in from their GSTIN when the party record only has
                    the name typed in. */}
                {buyerState && <div style={small}>State Name : {buyerState}</div>}
                {(party?.gstin || party?.pan) && (
                  <div style={{ ...small, fontWeight: 600 }}>
                    {party?.gstin && <>GSTIN: {party.gstin}</>}
                    {party?.gstin && party?.pan && "   "}
                    {party?.pan && <>Pan No : {party.pan}</>}
                  </div>
                )}
                {party?.phone && <div style={small}>Phone: {party.phone}</div>}

                <div style={{ marginTop: s(5), borderTop: "1px dotted #000", paddingTop: s(4) }}>
                  <div style={small}>
                    Ship To : <strong>{inv.partyName || "—"}</strong>
                  </div>
                  {addressLines(party?.shippingAddress || party?.address).map((line, i) => (
                    <div key={i} style={small}>
                      {line}
                    </div>
                  ))}
                  {placeOfSupply && <div style={small}>Place of Supply {placeOfSupply}</div>}
                </div>
              </td>

              {/* --- Invoice meta + e-invoice --- */}
              <td style={{ padding: 0, border: "none", verticalAlign: "top" }}>
                <div style={{ padding: `${s(3)}px ${s(6)}px` }}>
                  <table style={{ width: "100%", borderCollapse: "collapse" }}>
                    <tbody>
                      {meta("Invoice No.", inv.number)}
                      {meta("Invoice Date", fmtBillDate(inv.date))}
                      {meta("Terms of Payment", inv.termsOfPayment ?? "")}
                      {meta("Trasport mode", inv.transportMode ?? "")}
                      {meta("Tax is payable on Reverse", inv.reverseCharge ? "YES" : "NO")}
                      {meta("Lut Arn No", inv.lutArnNo ?? "")}
                    </tbody>
                  </table>
                </div>
                {/* The IRP block only exists once the bill has actually been
                    registered — an empty IRN/ACK/QR frame on an unregistered
                    bill reads as a failed e-invoice rather than as a bill that
                    never needed one. */}
                {inv.irn && (
                  <div style={{ borderTop: BD, padding: `${s(3)}px ${s(6)}px` }}>
                    <table style={{ width: "100%", borderCollapse: "collapse" }}>
                      <tbody>
                        <tr>
                          <td style={{ verticalAlign: "top" }}>
                            <div style={{ fontSize: s(8.5), wordBreak: "break-all" }}>
                              <span style={{ fontWeight: 600 }}>IRN:</span> {inv.irn}
                            </div>
                            {inv.ackNo && (
                              <div style={{ fontSize: s(8.5), marginTop: s(3) }}>
                                <span style={{ fontWeight: 600 }}>ACK No.:</span> {inv.ackNo}
                              </div>
                            )}
                            {inv.ackDate && (
                              <div style={{ fontSize: s(8.5) }}>
                                <span style={{ fontWeight: 600 }}>Date:</span>{" "}
                                {fmtAckDate(inv.ackDate)}
                              </div>
                            )}
                          </td>
                          {qr && (
                            <td style={{ width: s(76), paddingLeft: s(6), verticalAlign: "top" }}>
                              <img
                                src={qr}
                                alt="e-Invoice QR"
                                style={{ width: s(72), height: s(72), display: "block" }}
                              />
                            </td>
                          )}
                        </tr>
                      </tbody>
                    </table>
                  </div>
                )}
              </td>
            </tr>
          </tbody>
        </table>

        {/* ================= Line items + totals =================
            ONE table, so the Pcs/Carat totals land exactly under their own
            columns — which is the whole reason the trade's bill rules those
            columns all the way down the page. */}
        <table
          style={{
            width: "100%",
            borderCollapse: "collapse",
            tableLayout: "fixed",
            // The one block that grows. Everything else in the frame is
            // content-sized, so this absorbs the whole of the leftover page.
            flex: 1,
          }}
        >
          {/* Column widths are sized to the WIDEST thing each column has to
              hold, which is not always a number: the last two columns also
              carry the tax summary's labels and figures ("Taxable Value",
              "SGST 0.000 %", "1,200.00"), and the headings themselves
              ("Sr No", "HSN Code") are wider than the values under them.
              Sized off the numbers alone, those all wrapped onto a second
              line and the ruled block lost its alignment. Quality takes
              whatever is left, which is where a long stone description
              actually wants the room. */}
          <colgroup>
            <col style={{ width: s(46) }} />
            <col />
            <col style={{ width: s(68) }} />
            <col style={{ width: s(34) }} />
            <col style={{ width: s(52) }} />
            <col style={{ width: s(98) }} />
            <col style={{ width: s(98) }} />
          </colgroup>
          <thead>
            <tr>
              <th style={th}>Sr No</th>
              <th style={th}>Quality</th>
              <th style={th}>HSN Code</th>
              <th style={th}>Pcs</th>
              <th style={th}>Carat</th>
              <th style={th}>Rate</th>
              <th style={th}>Amount</th>
            </tr>
          </thead>
          <tbody>
            {/* No horizontal rule between line rows — the trade's bill leaves
                the item area as one open box with the column rules running
                unbroken down it, so `borderBottom: none` here and
                `borderTop: none` on the filler below keep it that way. */}
            {inv.lineItems.map((l, i) => {
              // Same rounded per-line figure the Taxable Value total is built
              // from, so the Amount column adds up to it on screen.
              const taxable = lineTaxable(l);
              const rowCell = { ...cell, borderBottom: "none", borderTop: "none" };
              return (
                <tr key={l.id}>
                  <td style={{ ...rowCell, textAlign: "center" }}>{i + 1}</td>
                  <td style={rowCell}>{l.name}</td>
                  <td style={{ ...rowCell, textAlign: "center" }}>{l.hsn ?? ""}</td>
                  <td style={{ ...rowCell, textAlign: "center" }}>
                    {l.pcs ? fmtNum(l.pcs, 0) : ""}
                  </td>
                  <td style={{ ...rowCell, ...num }}>{fmtNum(l.qty)}</td>
                  <td style={{ ...rowCell, ...num }}>{fmtNum(l.price)}</td>
                  <td style={{ ...rowCell, ...num }}>{fmtNum(taxable)}</td>
                </tr>
              );
            })}
            {/* The filler row. `height: 100%` on a row of a table that is
                taller than its content is what makes the browser hand THIS
                row all the spare height rather than sharing it out across
                every line, which would leave the item rows oddly tall and the
                grid looking stretched. */}
            <tr style={{ height: "100%" }}>
              {Array.from({ length: 7 }).map((_, c) => (
                <td key={c} style={{ ...cell, borderTop: "none", borderBottom: "none" }} />
              ))}
            </tr>

            {/* ---- Totals strip: Pcs/Carat under their columns ---- */}
            <tr>
              <td style={{ ...cell, borderRight: "none" }} colSpan={3} />
              <td style={{ ...th, fontWeight: 700 }}>{totalPcs ? fmtNum(totalPcs, 0) : ""}</td>
              <td style={{ ...cell, ...num, fontWeight: 700, verticalAlign: "middle" }}>
                {fmtNum(totalQty)}
              </td>
              <td style={{ ...taxCell, fontWeight: 600 }}>Taxable Value</td>
              <td style={{ ...taxCell, ...num, fontWeight: 600 }}>{fmtNum(taxableTotal)}</td>
            </tr>

            {/* ---- Net Rate / Remark / bank block beside the tax summary ----
                rowSpan covers every tax row after the first plus the Net Total
                row; it is derived from taxRows.length so adding or dropping a
                row can't leave the block short or overhanging. */}
            <tr>
              <td colSpan={5} rowSpan={taxRows.length + 1} style={cell}>
                {/* How the bill was settled, and any balance outstanding, used
                    to print here. Removed at the client's request: this is a
                    tax invoice handed to the buyer, and the trade's own
                    stationery carries no payment line — what is owed belongs
                    on the statement and the ledger, both of which still hold
                    it in full. Nothing about how payment is RECORDED changed;
                    the thermal receipt still prints it. */}
                {inv.notes && (
                  <div style={{ ...small, marginBottom: s(4) }}>
                    <span style={{ fontWeight: 700 }}>Remark:</span> {inv.notes}
                  </div>
                )}
                <BankBlock company={company} s={s} />
              </td>
              <td style={taxCell}>{taxRows[0].label}</td>
              <td style={{ ...taxCell, ...num }}>
                {taxRows[0].blank ? "" : fmtNum(taxRows[0].value)}
              </td>
            </tr>
            {taxRows.slice(1).map((row) => (
              <tr key={row.label}>
                <td style={taxCell}>{row.label}</td>
                <td style={{ ...taxCell, ...num }}>{row.blank ? "" : fmtNum(row.value)}</td>
              </tr>
            ))}
            <tr>
              <td style={{ ...taxCell, fontWeight: 700, fontSize: s(11) }}>Net Total</td>
              <td style={{ ...taxCell, ...num, fontWeight: 700, fontSize: s(11) }}>
                {fmtNum(inv.total)}
              </td>
            </tr>
          </tbody>
        </table>

        {/* ================= Amount in words ================= */}
        <div style={{ borderBottom: BD, padding: `${s(4)}px ${s(8)}px`, fontSize: s(10) }}>
          <span style={{ fontWeight: 700 }}>Amount In Words</span> :{" "}
          <span style={{ fontWeight: 700 }}>{amountInWords(inv.total)}</span>
        </div>

        {/* ================= Terms ================= */}
        <div style={{ padding: `${s(4)}px ${s(8)}px`, fontSize: s(8.5), borderBottom: BD }}>
          <div style={{ fontWeight: 700, fontSize: s(9.5) }}>Terms &amp; Conditions:</div>
          {terms.map((t, i) => (
            <div key={i}>
              {i + 1}) {t}
            </div>
          ))}
          {company.jurisdiction && (
            <div>
              {terms.length + 1}) Subject to {company.jurisdiction} Jurisdiction.
            </div>
          )}
        </div>

        {/* ================= Signatures =================
            Sized for a real rubber stamp, not just a pen stroke. A trade
            stamp is commonly 40-45mm across; at 96dpi that is ~160px, so
            each side gets a clear band of that order between the "FOR ..."
            line and the signature caption. Both sides are given the SAME
            height so the two captions sit on one line across the page. */}
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <tbody>
            <tr>
              <td style={{ width: "50%", padding: `${s(8)}px ${s(10)}px`, verticalAlign: "top" }}>
                <div style={{ fontSize: s(11), fontWeight: 700 }}>
                  FOR {(inv.partyName || (isSale ? "CUSTOMER" : "SUPPLIER")).toUpperCase()}
                </div>
                <div style={{ height: s(112) }} />
                <div style={small}>Receiver Signature</div>
              </td>
              <td
                style={{
                  width: "50%",
                  padding: `${s(8)}px ${s(10)}px`,
                  textAlign: "right",
                  verticalAlign: "top",
                }}
              >
                <div style={{ fontSize: s(11), fontWeight: 700 }}>
                  For, {company.name || "Company"}
                </div>
                <div style={{ height: s(112) }} />
                <div style={small}>Authorised Signature</div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Which account the buyer should actually pay into. Any blank field drops
 * its own row rather than printing a label with nothing after it. */
function BankBlock({ company, s }: { company: Company; s: (n: number) => number }) {
  const rows: [string, string | undefined][] = [
    ["BANK A/C. NAME", company.bankAccountName],
    ["BANK", company.bankDisplayName],
    ["A/C.NO", company.bankAccountNo],
    ["IFSC CODE", company.bankIfsc],
    ["BRANCH", company.bankBranch],
  ];
  const present = rows.filter(([, v]) => (v ?? "").trim());
  if (!present.length) return null;
  return (
    <table style={{ borderCollapse: "collapse", fontSize: s(9.5) }}>
      <tbody>
        {present.map(([label, value]) => (
          <tr key={label}>
            <td style={{ fontWeight: 600, whiteSpace: "nowrap", paddingRight: s(4) }}>{label}</td>
            <td style={{ paddingRight: s(4) }}>:</td>
            <td style={{ fontWeight: 600 }}>{value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
