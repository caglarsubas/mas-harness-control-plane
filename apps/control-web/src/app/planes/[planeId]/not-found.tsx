import styles from "../../../components/harness-overview/overview.module.css";

export default function NotFound() {
  return <main className={styles.empty} id="main-content" tabIndex={-1}><p className={styles.eyebrow}>Not found</p><h1>The requested plane is unavailable.</h1><p>The response is intentionally indistinguishable from an unauthorized organization-scoped object.</p><a className={styles.primaryLink} href="/overview">Return to overview</a></main>;
}

