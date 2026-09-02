import styles from "../../../components/harness-overview/overview.module.css";

export default function NotFound() {
  return <main className={styles.empty} id="main-content" tabIndex={-1}><p className={styles.eyebrow}>Not found</p><h1>The requested harness is unavailable.</h1><p>The response does not reveal whether the object is absent or outside the caller's organization.</p><a className={styles.primaryLink} href="/overview">Return to overview</a></main>;
}

