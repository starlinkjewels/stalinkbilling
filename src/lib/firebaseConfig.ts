/**
 * Identifiers shared by the browser SDK (src/lib/firebase.ts) AND the server
 * Admin SDK (src/lib/firebaseAdmin.ts).
 *
 * Kept in its own file with no imports, so the server can read it without
 * pulling the whole client Firebase SDK into every serverless function.
 *
 * This exists because the two used to carry their own copies. When this app
 * was set up for Starlink Jewels, the client was pointed at the new database
 * but the server copy still named the previous business's. The server then
 * looked up every signed-in user in the WRONG database, found nobody, and
 * refused the request — so Share PDF, Download PDF and Team management all
 * failed with nothing on screen saying why. One constant, imported by both,
 * makes that mismatch impossible. tests/audit.test.ts pins it.
 */

/** Named Firestore database (not the "(default)" one). */
export const DATABASE_ID = "starlinkbilling";
