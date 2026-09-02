import styles from "../../../components/harness-overview/overview.module.css";

export default function NotFound() {
  return <main className={styles.empty} id="main-content" tabIndex={-1}><p className={styles.eyebrow}>Not found</p><h1>The organization view is unavailable.</h1><p>No organization existence is disclosed without a separately audited operator authorization.</p><a className={styles.primaryLink} href="/organizations">Return to organizations</a></main>;
}
