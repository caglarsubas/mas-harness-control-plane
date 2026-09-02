"use client";

import styles from "./demand.module.css";

export default function ErrorPage({ reset }: { readonly reset: () => void }) {
  return (
    <main className={styles.loading} id="main-content" tabIndex={-1}>
      <h1>The demand workspace could not be opened.</h1>
      <button className={styles.primaryButton} type="button" onClick={reset}>Try again</button>
    </main>
  );
}
