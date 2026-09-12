import qrcode from "qrcode-generator";

/**
 * A QR code as an inline SVG `data:` URI, for the e-invoice block on the
 * printed tax invoice.
 *
 * SVG, not the library's own `createDataURL()` GIF: the bill is printed and
 * turned into a PDF at whatever DPI the printer runs at, and a raster QR
 * scaled up from its native module size prints soft enough that scanners
 * struggle. Vector stays crisp at every size.
 *
 * Type 0 lets the library pick the smallest symbol version that fits, and
 * error-correction level "M" is what the IRP's own printed QR specification
 * uses. Returns "" for empty input — the caller renders no QR at all rather
 * than a valid QR encoding an empty string.
 */
export function qrSvgDataUri(text: string, margin = 2): string {
  const data = (text ?? "").trim();
  if (!data) return "";
  try {
    const qr = qrcode(0, "M");
    qr.addData(data);
    qr.make();
    const count = qr.getModuleCount();
    const size = count + margin * 2;

    // One <path> of "move to, draw 1x1 square" segments for every dark
    // module, rather than thousands of <rect> elements — the same picture at
    // a fraction of the string length, which matters because this whole SVG
    // is inlined into the document as a data URI.
    let d = "";
    for (let row = 0; row < count; row++) {
      for (let col = 0; col < count; col++) {
        if (qr.isDark(row, col)) d += `M${col + margin} ${row + margin}h1v1h-1z`;
      }
    }

    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" ` +
      `shape-rendering="crispEdges">` +
      `<rect width="${size}" height="${size}" fill="#fff"/>` +
      `<path fill="#000" d="${d}"/>` +
      `</svg>`;
    // encodeURIComponent, not base64: it keeps the URI readable in devtools
    // and avoids pulling a base64 polyfill into the SSR pass, where btoa is
    // not guaranteed to exist.
    return `data:image/svg+xml,${encodeURIComponent(svg)}`;
  } catch {
    // An IRN too long for even the largest symbol, or a malformed one — the
    // bill still has to print, just without the QR.
    return "";
  }
}
