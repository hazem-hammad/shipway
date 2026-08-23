import { EmptyState, PageHeader } from '../components/ui';

export default function ProjectsPage() {
  return (
    <div>
      <PageHeader title="Projects" />
      <EmptyState
        message="No projects yet. Connect GitHub and create your first project."
        action={{ label: 'Connect GitHub', href: '/settings/github' }}
      />
    </div>
  );
}
