"use client";

import { StatusError } from "../../../components/harness-overview/StatusBoundary";

export default function ErrorPage({ reset }: { readonly reset: () => void }) {
  return <StatusError reset={reset} />;
}

