/**
 * GST helpers for the printed tax invoice.
 *
 * The one decision that actually moves money here is CGST+SGST vs IGST. Both
 * come to the same total tax, but putting the wrong one on a bill is a real
 * filing error for the buyer — they claim credit under the head the invoice
 * names — so it is derived from state codes rather than left as a setting
 * somebody has to remember to flip.
 */

/** GST state codes, as they appear in the first two digits of a GSTIN. */
export const GST_STATES: Record<string, string> = {
  "01": "JAMMU AND KASHMIR",
  "02": "HIMACHAL PRADESH",
  "03": "PUNJAB",
  "04": "CHANDIGARH",
  "05": "UTTARAKHAND",
  "06": "HARYANA",
  "07": "DELHI",
  "08": "RAJASTHAN",
  "09": "UTTAR PRADESH",
  "10": "BIHAR",
  "11": "SIKKIM",
  "12": "ARUNACHAL PRADESH",
  "13": "NAGALAND",
  "14": "MANIPUR",
  "15": "MIZORAM",
  "16": "TRIPURA",
  "17": "MEGHALAYA",
  "18": "ASSAM",
  "19": "WEST BENGAL",
  "20": "JHARKHAND",
  "21": "ODISHA",
  "22": "CHHATTISGARH",
  "23": "MADHYA PRADESH",
  "24": "GUJARAT",
  "26": "DADRA AND NAGAR HAVELI AND DAMAN AND DIU",
  "27": "MAHARASHTRA",
  "29": "KARNATAKA",
  "30": "GOA",
  "31": "LAKSHADWEEP",
  "32": "KERALA",
  "33": "TAMIL NADU",
  "34": "PUDUCHERRY",
  "35": "ANDAMAN AND NICOBAR ISLANDS",
  "36": "TELANGANA",
  "37": "ANDHRA PRADESH",
  "38": "LADAKH",
  "97": "OTHER TERRITORY",
  "99": "CENTRE JURISDICTION",
};

/** The two-digit state code carried by a GSTIN, or "" if there isn't one.
 * Only accepts a genuinely GSTIN-shaped string: a half-typed GSTIN would
 * otherwise silently decide the CGST/SGST-vs-IGST question on garbage. */
export function stateCodeOfGstin(gstin?: string): string {
  const g = (gstin ?? "").trim().toUpperCase();
  if (g.length < 15) return "";
  const code = g.slice(0, 2);
  return GST_STATES[code] ? code : "";
}

/** The state code inside a "NAME-code" place-of-supply string ("GUJARAT-24"
 * -> "24"). Also accepts a bare code, and a bare state name. */
export function stateCodeOfPlace(place?: string): string {
  const p = (place ?? "").trim().toUpperCase();
  if (!p) return "";
  const tail = p.match(/(\d{2})\s*$/);
  if (tail && GST_STATES[tail[1]]) return tail[1];
  const byName = Object.entries(GST_STATES).find(([, name]) => name === p.replace(/[-\s]*\d*$/, ""));
  return byName ? byName[0] : "";
}

/** "GUJARAT-24" for a code, for pre-filling Place of Supply. */
export function placeLabel(code: string): string {
  return GST_STATES[code] ? `${GST_STATES[code]}-${code}` : "";
}

/**
 * Is this an inter-state supply (IGST) rather than an intra-state one
 * (CGST+SGST)?
 *
 * The buyer's side is read from their GSTIN first and the bill's stated place
 * of supply only as a fallback — a GSTIN is structurally reliable where the
 * place-of-supply line is free text somebody typed. When the buyer's state
 * can't be determined AT ALL (an unregistered walk-in with nothing filled in),
 * this returns false: an intra-state CGST+SGST bill is both the overwhelmingly
 * common case and the safe default, since the alternative would silently move
 * every such bill's tax to IGST.
 */
export function isInterState(opts: {
  companyGstin?: string;
  companyState?: string;
  partyGstin?: string;
  placeOfSupply?: string;
}): boolean {
  const seller = stateCodeOfGstin(opts.companyGstin) || stateCodeOfPlace(opts.companyState);
  const buyer = stateCodeOfGstin(opts.partyGstin) || stateCodeOfPlace(opts.placeOfSupply);
  if (!seller || !buyer) return false;
  return seller !== buyer;
}

/**
 * Indian numbering (lakh/crore) in words, as the "Amount in Words" line wants
 * it — "Sixty Four Thousand Six Hundred Thirteen Only".
 *
 * Rounds to whole rupees rather than reciting paise: this line sits directly
 * under a Net Total that is itself rounded to the rupee (see enableRoundOff),
 * and a words line disagreeing with the figure beside it is worse than one
 * that omits paise.
 */
export function amountInWords(n: number): string {
  const ones = [
    "",
    "One",
    "Two",
    "Three",
    "Four",
    "Five",
    "Six",
    "Seven",
    "Eight",
    "Nine",
    "Ten",
    "Eleven",
    "Twelve",
    "Thirteen",
    "Fourteen",
    "Fifteen",
    "Sixteen",
    "Seventeen",
    "Eighteen",
    "Nineteen",
  ];
  const tens = [
    "",
    "",
    "Twenty",
    "Thirty",
    "Forty",
    "Fifty",
    "Sixty",
    "Seventy",
    "Eighty",
    "Ninety",
  ];
  const under1000 = (num: number): string => {
    if (num < 20) return ones[num];
    if (num < 100) return tens[Math.floor(num / 10)] + (num % 10 ? " " + ones[num % 10] : "");
    return (
      ones[Math.floor(num / 100)] + " Hundred" + (num % 100 ? " " + under1000(num % 100) : "")
    );
  };
  // Recursive rather than four fixed buckets, so the crore group can itself
  // be larger than 999 ("One Thousand Two Hundred Crore") instead of wrapping
  // into nonsense the way a bare under1000(crore) would.
  const inWords = (num: number): string => {
    if (num < 1000) return under1000(num);
    if (num < 100000)
      return (
        under1000(Math.floor(num / 1000)) +
        " Thousand" +
        (num % 1000 ? " " + under1000(num % 1000) : "")
      );
    if (num < 10000000)
      return (
        inWords(Math.floor(num / 100000)) +
        " Lakh" +
        (num % 100000 ? " " + inWords(num % 100000) : "")
      );
    return (
      inWords(Math.floor(num / 10000000)) +
      " Crore" +
      (num % 10000000 ? " " + inWords(num % 10000000) : "")
    );
  };

  const whole = Math.abs(Math.round(n || 0));
  if (whole === 0) return "Zero Only";
  return `${n < 0 ? "Minus " : ""}${inWords(whole)} Only`;
}

/** dd/mm/yyyy — how the printed bill writes an invoice date. */
export function fmtBillDate(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const p2 = (x: number) => String(x).padStart(2, "0");
  return `${p2(d.getDate())}/${p2(d.getMonth() + 1)}/${d.getFullYear()}`;
}

/** dd-mm-yyyy hh:mm:ss — how the IRP reports an acknowledgement timestamp. */
export function fmtAckDate(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const p2 = (x: number) => String(x).padStart(2, "0");
  return (
    `${p2(d.getDate())}-${p2(d.getMonth() + 1)}-${d.getFullYear()} ` +
    `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`
  );
}

/** Plain fixed-decimal number for the bill's money columns.
 *
 * NOT fmtMoney: the printed tax invoice puts the currency in the column
 * heading and its own totals block, and a "₹" repeated down every row of a
 * narrow Amount column costs width the carat/rate figures need. Always two
 * decimals, always grouped Indian-style. */
export function fmtNum(n: number, dp = 2): string {
  return (n || 0).toLocaleString("en-IN", {
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  });
}
