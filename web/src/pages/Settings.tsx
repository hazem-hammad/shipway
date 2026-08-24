/**
 * Settings shell (route `/settings/:section?`, DESIGN.md's Settings shell): a right-rail
 * sub-navigation over the server's configuration — identity card (Settings icon + session user
 * email) above a sub-nav card, with the active section rendered in the main column. Missing a
 * `:section` defaults to General without an actual URL redirect, matching how every other optional
 * route param in this app resolves (see ProjectLayout's tabs).
 *
 * Team and Notifications route to `/settings/team` and `/settings/notifications`, built in Task 11;
 * until then those keys (and any unknown section) fall through the switch below to a quiet
 * placeholder rather than an error — the sub-nav row itself is still live and correctly highlighted.
 */
import { Link, useParams } from 'wouter';
import { Bell, Cloud, GitBranch, Server, Settings as SettingsIcon, Users } from 'lucide-react';
import { useMe } from '../hooks';
import { Card, CardHeader, EmptyState, ICON_STROKE, PageHeader, PageWithRail } from '../components/ui';
import GeneralSection from './settings/General';
import GithubSection from './settings/GitHub';
import CloudflareSection from './settings/Cloudflare';
import InstanceSection from './settings/Instance';

interface SectionDef {
  key: string;
  href: string;
  label: string;
  icon: typeof SettingsIcon;
}

const SECTIONS: SectionDef[] = [
  { key: 'general', href: '/settings/general', label: 'General', icon: SettingsIcon },
  { key: 'github', href: '/settings/github', label: 'GitHub', icon: GitBranch },
  { key: 'cloudflare', href: '/settings/cloudflare', label: 'Cloudflare', icon: Cloud },
  { key: 'team', href: '/settings/team', label: 'Team', icon: Users },
  { key: 'notifications', href: '/settings/notifications', label: 'Notifications', icon: Bell },
  { key: 'instance', href: '/settings/instance', label: 'Instance', icon: Server },
];

export default function SettingsPage() {
  const { section } = useParams<{ section?: string }>();
  const active = section ?? 'general';
  const meQuery = useMe();

  return (
    <div>
      <PageHeader title="Settings" subtitle="Manage your preferences, team, and instance configuration" />

      <PageWithRail
        rail={
          <>
            <Card>
              <CardHeader
                icon={<SettingsIcon size={20} strokeWidth={ICON_STROKE} />}
                title="Settings"
                description={meQuery.data?.email}
              />
            </Card>

            <Card>
              <nav className="flex flex-col gap-0.5" aria-label="Settings sections">
                {SECTIONS.map((item) => {
                  const isActive = item.key === active;
                  const Icon = item.icon;
                  return (
                    <Link
                      key={item.key}
                      href={item.href}
                      aria-current={isActive ? 'page' : undefined}
                      className={`flex h-11 items-center gap-3 rounded-xl px-3 text-[14.5px] transition-colors duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ${
                        isActive ? 'bg-surface-3 font-medium text-ink' : 'font-normal text-soft hover:bg-surface-2 hover:text-ink'
                      }`}
                    >
                      <Icon size={20} strokeWidth={ICON_STROKE} aria-hidden className={isActive ? 'text-ink' : 'text-icon'} />
                      {item.label}
                    </Link>
                  );
                })}
              </nav>
            </Card>
          </>
        }
      >
        <SectionContent active={active} />
      </PageWithRail>
    </div>
  );
}

function SectionContent({ active }: { active: string }) {
  switch (active) {
    case 'general':
      return <GeneralSection />;
    case 'github':
      return <GithubSection />;
    case 'cloudflare':
      return <CloudflareSection />;
    case 'instance':
      return <InstanceSection />;
    default:
      return <EmptyState message="This section isn't set up yet." />;
  }
}
