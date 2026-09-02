"use client";

import styles from "./questionnaire.module.css";

export default function QuestionnaireError({ reset }: { readonly reset: () => void }) {
  return (
    <main className={styles.main}>
      <section className={styles.error} role="alert">
        <h1>The questionnaire workspace could not be opened.</h1>
        <p>Your saved revisions were not changed.</p>
        <button className={styles.secondaryButton} type="button" onClick={reset}>Try again</button>
      </section>
    </main>
  );
}
