"use client";

import styles from "./overview.module.css";

export function StatusError({ reset }: { readonly reset: () => void }) {
  return <main className={styles.empty} id="main-content" tabIndex={-1}><p className={styles.eyebrow}>Projection refused</p><h1>The harness status view could not be opened.</h1><p>No prior healthy state is fabricated. Retry the same authorized read or ask the projection owner to inspect the bounded reason code.</p><button type="button" onClick={reset}>Try again</button></main>;
}

export function StatusLoading({ label = "Loading the verified harness projection" }: { readonly label?: string }) {
  return <main className={styles.loading} id="main-content" tabIndex={-1} aria-live="polite" aria-busy="true"><p className={styles.eyebrow}>Status projection</p><h1>{label}</h1><div className={styles.loadingBar} aria-hidden="true" /></main>;
}
