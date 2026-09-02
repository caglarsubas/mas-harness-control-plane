import styles from "./demand.module.css";

export default function Loading() {
  return <main className={styles.loading} aria-live="polite">Preparing the demand workspace…</main>;
}

