/**
 * Test stub for src/lib/firebase.
 *
 * The screen tests must NEVER be able to reach the client's live Firestore,
 * so this replaces the real module entirely (see the esbuild --alias in
 * package.json). `isBrowser: false` is the important part: every Repository
 * write path checks it and, when false, updates only the in-memory cache —
 * exactly the behaviour we want for seeded fixture data. `db`/`auth` are
 * never dereferenced on that path, so dummies are enough.
 */
export const DATABASE_ID = "test-only-never-a-real-database";
export const isBrowser = false;
export const db = {} as never;
export const auth = { currentUser: null } as never;
