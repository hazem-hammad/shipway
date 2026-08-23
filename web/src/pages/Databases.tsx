import { EmptyState, PageHeader } from '../components/ui';

export default function DatabasesPage() {
  return (
    <div>
      <PageHeader title="Databases" />
      <EmptyState message="No databases yet. Provision one from a project." action={{ label: 'View projects', href: '/projects' }} />
    </div>
  );
}
