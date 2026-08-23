import { EmptyState, PageHeader } from '../components/ui';

export default function ServerPage() {
  return (
    <div>
      <PageHeader title="Server" />
      <EmptyState message="Server health and running services will appear here." />
    </div>
  );
}
