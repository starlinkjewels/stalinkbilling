/** The business name shown throughout the shell — sidebar, login, splash,
 * page title, logout prompt, backup messages. Defined ONCE here: the rename
 * away from "AIM" was previously done in the sidebar only, leaving the login
 * page, the browser tab, the backup errors and the home-screen icon label
 * all still saying the old name. Keep public/manifest.webmanifest in step by
 * hand — a static JSON file can't import this. */
export const APP_NAME = "STARLINK JEWELS";

/** Tagline under the name in the sidebar/login/splash brand lockup. */
export const APP_TAGLINE = "Diamonds · Billing";

/** Bump on every deploy — shown on the login page and Settings so we can
 * always tell which version a user is actually running. */
export const APP_VERSION = "12 Sep 2026 · v86";
