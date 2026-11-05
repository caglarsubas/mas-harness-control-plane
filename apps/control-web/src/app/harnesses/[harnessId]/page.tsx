import { notFound } from "next/navigation";
import { Suspense } from "react";

import { HarnessDetailPage } from "../../../components/harness-overview/DetailPages";
import { StatusLoading } from "../../../components/harness-overview/StatusBoundary";
import { resolveHarnessProjection } from "../../../lib/harness-status/page-resolution";

export default async function HarnessPage({ params }: { readonly params: Promise<{ readonly harnessId: string }> }) {
  const { harnessId } = await params;
  const projection = resolveHarnessProjection(harnessId);
  if (!projection) notFound();
  return <Suspense fallback={<StatusLoading label="Loading the harness projection" />}><HarnessDetailPage projection={projection} /></Suspense>;
}
