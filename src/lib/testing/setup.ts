import { afterAll } from "vitest";
import { cleanupTestUsers } from "./db";

/**
 * Teardown for the database-backed suites, registered for every test file.
 *
 * A setup file runs inside each test file's module context, so `afterAll` here
 * fires once per file — the same instance whose `createTestUser` calls filled
 * the registry. That is what makes this reliable: cleanup cannot be forgotten
 * by a new suite, because no suite has to opt in.
 *
 * The suites are opt-in as a whole and skip without `RUN_DB_TESTS=1`, in which
 * case nothing was created and the call returns immediately.
 */
afterAll(async () => {
  await cleanupTestUsers();
});
