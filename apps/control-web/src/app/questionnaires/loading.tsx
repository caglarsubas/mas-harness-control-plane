import styles from "./questionnaire.module.css";

export default function QuestionnaireLoading() {
  return <main className={styles.main} id="main-content" tabIndex={-1} aria-busy="true" aria-live="polite">Preparing your guided setup…</main>;
}
