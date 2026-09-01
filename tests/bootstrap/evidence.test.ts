import { describe, expect, it } from "vitest";

import { unavailablePostgreSqlRuntimeEvidence } from "../../packages/db/runtime-evidence";

describe("evidence axis separation", () => {
  it("does not promote source and parity checks to PostgreSQL runtime proof", () => {
    expect(unavailablePostgreSqlRuntimeEvidence()).toEqual({
      axis: "RUNTIME",
      state: "NOT_RUN_ENV_UNAVAILABLE",
      reasonCode: "DISPOSABLE_LOCAL_POSTGRESQL_NOT_SUPPLIED",
    });
  });
});
