import { notFound } from "next/navigation";
import { Suspense } from "react";

import { PlaneDetailPage } from "../../../components/harness-overview/DetailPages";
import { StatusLoading } from "../../../components/harness-overview/StatusBoundary";
import { resolvePlaneProjection } from "../../../lib/harness-status/page-resolution";

export default async function PlanePage({ params }: { readonly params: Promise<{ readonly planeId: string }> }) {
  const { planeId } = await params;
  const projection = resolvePlaneProjection(planeId);
  if (!projection) notFound();
  return <Suspense fallback={<StatusLoading label="Loading the plane projection" />}><PlaneDetailPage projection={projection} /></Suspense>;
}
