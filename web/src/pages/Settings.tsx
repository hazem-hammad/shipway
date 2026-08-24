/**
 * Settings shell (route `/settings/:section?`, see App.tsx): a side sub-nav over five sections,
 * each its own component under `./settings/*` (task-25 controller ruling). Unlike ProjectLayout's
 * horizontal tab bar, this uses a vertical side nav — Settings has more sections and each one's
 * content runs taller (tables, forms), so a side rail keeps the page title row stable while section
 * content scrolls.
 */
import { Link, useParams } from 'wouter';
import { EmptyState, PageHeader } from '../components/ui';
import GeneralSection from './settings/General';
import UsersSection from './settings/Users';
import CloudflareSection from './settings/Cloudflare';
import GithubSection from './settings/GitHub';
import NotificationsSection from './settings/Notifications';

interface SectionDef {
  key: string;
  href: string;
  label: string;
}

const SECTIONS: SectionDef[] = [
  { key: 'general', href: '/settings/general', label: 'General' },
  { key: 'users', href: '/settings/users', label: 'Users' },
  { key: 'cloudflare', href: '/settings/cloudflare', label: 'Cloudflare' },
  { key: 'github', href: '/settings/github', label: 'GitHub' },
  { key: 'notifications', href: '/settings/notifications', label: 'Notifications' },
];

export default function SettingsPage() {
  const { section } = useParams<{ section?: string }>();
  const active = section ?? 'general';
  const isKnown = SECTIONS.some((item) => item.key === active);

  return (
    <div>
      <PageHeader title="Settings" />

      <div className="flex flex-col gap-8 sm:flex-row">
        <nav className="flex shrink-0 flex-row gap-0.5 overflow-x-auto sm:w-44 sm:flex-col sm:overflow-visible" aria-label="Settings sections">
          {SECTIONS.map((item) => {
            const isActive = item.key === active;
            return (
              <Link
                key={item.key}
                href={item.href}
                className={`whitespace-nowrap rounded-md px-3 py-2 text-sm font-medium transition-colors duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                  isActive ? 'bg-accent-soft text-accent' : 'text-ink-soft hover:bg-panel hover:text-ink'
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="min-w-0 flex-1">
          {active === 'general' && <GeneralSection />}
          {active === 'users' && <UsersSection />}
          {active === 'cloudflare' && <CloudflareSection />}
          {active === 'github' && <GithubSection />}
          {active === 'notifications' && <NotificationsSection />}
          {!isKnown && <EmptyState message="Unknown settings section." action={{ label: 'General', href: '/settings/general' }} />}
        </div>
      </div>
    </div>
  );
}
