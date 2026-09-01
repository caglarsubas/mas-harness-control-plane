export interface PostgreSqlRuntimeEvidence {
  readonly axis: "RUNTIME";
  readonly state: "NOT_RUN_ENV_UNAVAILABLE";
  readonly reasonCode: "DISPOSABLE_LOCAL_POSTGRESQL_NOT_SUPPLIED";
}

export function unavailablePostgreSqlRuntimeEvidence(): PostgreSqlRuntimeEvidence {
  return Object.freeze({
    axis: "RUNTIME",
    state: "NOT_RUN_ENV_UNAVAILABLE",
    reasonCode: "DISPOSABLE_LOCAL_POSTGRESQL_NOT_SUPPLIED",
  });
}
