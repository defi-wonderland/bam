import { BatchDetailView } from '../../../components/BatchDetailView';

export default async function BatchDetailPage({
  params,
}: {
  params: Promise<{ txHash: string }>;
}) {
  const { txHash } = await params;
  return <BatchDetailView txHash={txHash} />;
}
