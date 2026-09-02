"use client";

import styles from "./profile.module.css";

export default function ErrorPage({ reset }: { readonly reset: () => void }) {
  return <main className={styles.loading} id="main-content" tabIndex={-1}><div><h1>The profile workspace could not be opened.</h1><button type="button" onClick={reset}>Try again</button></div></main>;
}
