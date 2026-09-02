import styles from "./profile.module.css";

export default function Loading() {
  return (
    <main className={styles.loading} aria-live="polite" aria-label="Preparing the profile review workspace">
      <div className={styles.loadingHeader} />
      <div className={styles.loadingRow} />
      <div className={styles.loadingGrid}><div className={styles.loadingPanel} /><div className={styles.loadingPanel} /><div className={styles.loadingPanel} /></div>
    </main>
  );
}
