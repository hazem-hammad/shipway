import { Link, useParams, useSearch } from 'wouter';
import { EmptyState, PageHeader } from '../components/ui';

interface Tab {
  key: string;
  href: string;
  label: string;
}

const TABS: Tab[] = [
  { key: 'general', href: '/settings/general', label: 'General' },
  { key: 'cloudflare', href: '/settings/cloudflare', label: 'Cloudflare' },
  { key: 'github', href: '/settings/github', label: 'GitHub App' },
  { key: 'users', href: '/settings/users', label: 'Users' },
];

export default function SettingsPage() {
  const { section } = useParams<{ section?: string }>();
  const search = useSearch();
  const active = section ?? 'general';

  return (
    <div>
      <PageHeader title="Settings" />

      <nav className="mb-6 flex gap-1 border-b border-line" aria-label="Settings sections">
        {TABS.map((tab) => {
          const isActive = tab.key === active;
          return (
            <Link
              key={tab.key}
              href={tab.href}
              className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                isActive ? 'border-accent text-accent' : 'border-transparent text-ink-soft hover:text-ink'
              }`}
            >
              {tab.label}
            </Link>
          );
        })}
      </nav>

      {active === 'general' && <EmptyState message="Server, domain, and ACME email settings will appear here." />}
      {active === 'cloudflare' && <EmptyState message="Cloudflare DNS credentials will appear here." />}
      {active === 'github' && <GithubSection search={search} />}
      {active === 'users' && <EmptyState message="Team members will appear here." />}
      {!TABS.some((tab) => tab.key === active) && <EmptyState message="Unknown settings section." action={{ label: 'General', href: '/settings/general' }} />}
    </div>
  );
}

function GithubSection({ search }: { search: string }) {
  const created = new URLSearchParams(search).get('created') === '1';
  return (
    <div className="flex flex-col gap-4">
      {created && <p className="text-sm text-go">GitHub App created. Repository access management will appear here.</p>}
      <EmptyState message="Connect a GitHub App to deploy from your repositories." />
    </div>
  );
}
