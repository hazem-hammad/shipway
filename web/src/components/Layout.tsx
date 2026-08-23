import { type ReactNode, useState } from 'react';
import { Link, useLocation } from 'wouter';
import { useQueryClient } from '@tanstack/react-query';
import { logout, type Me } from '../api';
import { useServerHealth } from '../hooks';
import { BerthLight } from './ui';

interface NavItem {
  href: string;
  label: string;
  /** Two-letter monogram shown when the sidebar is collapsed below 900px. */
  monogram: string;
}

const NAV_ITEMS: NavItem[] = [
  { href: '/projects', label: 'Projects', monogram: 'PR' },
  { href: '/databases', label: 'Databases', monogram: 'DB' },
  { href: '/server', label: 'Server', monogram: 'SV' },
  { href: '/settings', label: 'Settings', monogram: 'SE' },
];

export default function Layout({ user, children }: { user: Me; children: ReactNode }) {
  const [location] = useLocation();
  const health = useServerHealth();
  const [menuOpen, setMenuOpen] = useState(false);
  const queryClient = useQueryClient();

  const reachable = health.isPending ? 'unknown' : health.isError || health.data?.status !== 'ok' ? 'stop' : 'go';

  async function handleLogout() {
    await logout();
    queryClient.setQueryData(['me'], undefined);
    await queryClient.invalidateQueries({ queryKey: ['me'] });
  }

  return (
    <div className="flex min-h-screen bg-paper">
      <aside className="flex w-16 shrink-0 flex-col border-r border-line bg-panel min-[900px]:w-[220px]">
        <div className="flex items-center gap-2 px-4 py-4">
          <BerthLight status={reachable} label={`server ${reachable === 'go' ? 'reachable' : 'unreachable'}`} />
          <span className="hidden text-sm font-semibold text-ink min-[900px]:inline">Shipway</span>
        </div>

        <nav className="flex flex-1 flex-col gap-0.5 px-2" aria-label="Primary">
          {NAV_ITEMS.map((item) => {
            const active = location === item.href || location.startsWith(`${item.href}/`);
            return (
              <Link
                key={item.href}
                href={item.href}
                title={item.label}
                className={`flex items-center gap-2 rounded-md px-2.5 py-2 text-sm font-medium transition-colors duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                  active ? 'bg-accent-soft text-accent' : 'text-ink-soft hover:bg-paper hover:text-ink'
                }`}
              >
                <span
                  aria-hidden
                  className="grid h-5 w-5 shrink-0 place-items-center rounded bg-current/10 font-mono text-[10px] font-semibold min-[900px]:hidden"
                >
                  {item.monogram}
                </span>
                <span className="hidden truncate min-[900px]:inline">{item.label}</span>
              </Link>
            );
          })}
        </nav>

        <div className="border-t border-line p-2">
          <button
            type="button"
            onClick={() => setMenuOpen((open) => !open)}
            aria-expanded={menuOpen}
            title={user.name}
            className="flex w-full items-center justify-center gap-2 rounded-md px-2.5 py-2 text-left text-sm font-medium text-ink transition-colors duration-150 ease-out hover:bg-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent min-[900px]:justify-between"
          >
            <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-accent-soft font-mono text-[10px] font-semibold text-accent min-[900px]:hidden">
              {user.name.slice(0, 1).toUpperCase()}
            </span>
            <span className="hidden truncate min-[900px]:inline">{user.name}</span>
            <span aria-hidden className="hidden text-ink-soft min-[900px]:inline">
              {menuOpen ? '▴' : '▾'}
            </span>
          </button>
          {menuOpen && (
            <div className="mt-1 flex flex-col gap-0.5">
              <span className="hidden truncate px-2.5 py-1 font-mono text-xs text-ink-soft min-[900px]:block">{user.email}</span>
              <button
                type="button"
                onClick={() => void handleLogout()}
                className="rounded-md px-2.5 py-2 text-left text-sm text-stop transition-colors duration-150 ease-out hover:bg-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                Log out
              </button>
            </div>
          )}
        </div>
      </aside>

      <main className="min-w-0 flex-1 overflow-x-auto px-8 py-8">{children}</main>
    </div>
  );
}
