/**
 * The v2 app shell (DESIGN.md, Layout anatomy): a floating sidebar card on the light-gray page —
 * wordmark row, MAIN / SETTINGS nav sections, the one loud gradient New Project pill, and the
 * account card with its Sign out menu. Collapses to a 76px icon rail (persisted), with tooltips.
 */
import { type ComponentType, type ReactNode, useState } from 'react';
import { Link, useLocation } from 'wouter';
import { useQueryClient } from '@tanstack/react-query';
import {
  ChevronsUpDown,
  ClipboardList,
  Database,
  FolderGit2,
  LayoutGrid,
  LogOut,
  MoonStar,
  PanelLeft,
  PanelLeftClose,
  Plus,
  Rocket,
  Settings,
  Sun,
} from 'lucide-react';
import { logout, type Me } from '../api';
import { resolvedTheme, setTheme, type ResolvedTheme } from '../lib/theme';
import { Avatar, ICON_STROKE, SectionLabel } from './ui';

const COLLAPSE_KEY = 'shipway.sidebar';

interface NavItem {
  href: string;
  label: string;
  icon: ComponentType<{ size?: number | string; strokeWidth?: number | string; className?: string }>;
}

const MAIN_ITEMS: NavItem[] = [
  { href: '/', label: 'Home', icon: LayoutGrid },
  { href: '/projects', label: 'Projects', icon: FolderGit2 },
  { href: '/databases', label: 'Databases', icon: Database },
  { href: '/deployments', label: 'Deployments', icon: Rocket },
];

const SETTINGS_ITEMS: NavItem[] = [
  { href: '/settings', label: 'Settings', icon: Settings },
  { href: '/audit', label: 'Audit log', icon: ClipboardList },
];

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === 'collapsed';
  } catch {
    return false;
  }
}

/** Inverted-bubble tooltip; `side` picks where it pops relative to its group parent. */
function Tooltip({ label, side = 'bottom' }: { label: string; side?: 'bottom' | 'right' }) {
  const position =
    side === 'right'
      ? 'left-full top-1/2 ml-2 -translate-y-1/2'
      : 'top-full left-1/2 mt-1.5 -translate-x-1/2';
  return (
    <span
      role="tooltip"
      className={`pointer-events-none absolute z-30 rounded-md bg-ink px-2 py-1 text-xs font-medium whitespace-nowrap text-page opacity-0 transition-opacity delay-100 duration-150 group-hover:opacity-100 ${position}`}
    >
      {label}
    </span>
  );
}

function SidebarIconButton({
  label,
  onClick,
  tooltipSide = 'bottom',
  children,
}: {
  label: string;
  onClick: () => void;
  tooltipSide?: 'bottom' | 'right';
  children: ReactNode;
}) {
  return (
    <span className="group relative inline-flex">
      <button
        type="button"
        aria-label={label}
        onClick={onClick}
        className="grid h-8 w-8 place-items-center rounded-lg text-icon transition-colors duration-150 ease-out hover:bg-surface-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        {children}
      </button>
      <Tooltip label={label} side={tooltipSide} />
    </span>
  );
}

function NavLink({ item, active, collapsed }: { item: NavItem; active: boolean; collapsed: boolean }) {
  const Icon = item.icon;
  return (
    <span className="group relative block">
      <Link
        href={item.href}
        aria-current={active ? 'page' : undefined}
        className={`flex h-10 items-center rounded-xl text-[14.5px] transition-colors duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ${
          collapsed ? 'justify-center' : 'gap-3 px-3'
        } ${active ? 'bg-surface-3 font-medium text-ink' : 'font-normal text-soft hover:bg-surface-2 hover:text-ink'}`}
      >
        <Icon size={20} strokeWidth={ICON_STROKE} className={active ? 'text-ink' : 'text-icon'} />
        {!collapsed && <span className="truncate">{item.label}</span>}
      </Link>
      {collapsed && <Tooltip label={item.label} side="right" />}
    </span>
  );
}

export default function Layout({ user, children }: { user: Me; children: ReactNode }) {
  const [location] = useLocation();
  const queryClient = useQueryClient();
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [theme, setThemeState] = useState<ResolvedTheme>(resolvedTheme);
  const [menuOpen, setMenuOpen] = useState(false);

  function toggleCollapsed() {
    const next = !collapsed;
    setCollapsed(next);
    try {
      if (next) {
        localStorage.setItem(COLLAPSE_KEY, 'collapsed');
      } else {
        localStorage.removeItem(COLLAPSE_KEY);
      }
    } catch {
      // Storage unavailable: the toggle still works for this page load.
    }
  }

  function toggleTheme() {
    const next: ResolvedTheme = resolvedTheme() === 'dark' ? 'light' : 'dark';
    setTheme(next);
    setThemeState(next);
  }

  async function handleSignOut() {
    setMenuOpen(false);
    await logout();
    queryClient.setQueryData(['me'], undefined);
    await queryClient.invalidateQueries({ queryKey: ['me'] });
  }

  function isActive(href: string): boolean {
    if (href === '/') return location === '/';
    return location === href || location.startsWith(`${href}/`);
  }

  return (
    <div className="flex min-h-screen bg-page">
      <aside
        className={`sticky top-3 m-3 flex h-[calc(100vh-24px)] shrink-0 flex-col rounded-[20px] border border-line bg-surface transition-[width] duration-200 ease-out ${
          collapsed ? 'w-[76px]' : 'w-[280px]'
        }`}
      >
        {/* Header row: wordmark, theme toggle, collapse. */}
        <div className={collapsed ? 'flex flex-col items-center gap-2 py-4' : 'flex items-center gap-2 px-4 py-4'}>
          <Link
            href="/"
            className="flex items-center gap-2.5 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            aria-label="Shipway home"
          >
            <img src="/logo-sidebar.png" alt="" className="h-6 w-6 shrink-0" />
            {!collapsed && <span className="text-[17px] font-semibold text-ink">Shipway</span>}
          </Link>
          {!collapsed && <span className="flex-1" />}
          <SidebarIconButton label="Toggle theme" onClick={toggleTheme} tooltipSide={collapsed ? 'right' : 'bottom'}>
            {theme === 'dark' ? (
              <MoonStar size={18} strokeWidth={ICON_STROKE} />
            ) : (
              <Sun size={18} strokeWidth={ICON_STROKE} />
            )}
          </SidebarIconButton>
          <SidebarIconButton
            label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            onClick={toggleCollapsed}
            tooltipSide={collapsed ? 'right' : 'bottom'}
          >
            {collapsed ? <PanelLeft size={18} strokeWidth={ICON_STROKE} /> : <PanelLeftClose size={18} strokeWidth={ICON_STROKE} />}
          </SidebarIconButton>
        </div>

        <div className="mx-4 border-t border-line" />

        {/* Nav sections. */}
        <nav aria-label="Primary" className="flex flex-1 flex-col overflow-y-auto px-3 py-4">
          {!collapsed && <SectionLabel className="px-3 pb-2">Main</SectionLabel>}
          <div className="flex flex-col gap-0.5">
            {MAIN_ITEMS.map((item) => (
              <NavLink key={item.href} item={item} active={isActive(item.href)} collapsed={collapsed} />
            ))}
          </div>

          {!collapsed && <SectionLabel className="px-3 pt-6 pb-2">Settings</SectionLabel>}
          {collapsed && <div className="mx-1 my-3 border-t border-line" />}
          <div className="flex flex-col gap-0.5">
            {SETTINGS_ITEMS.map((item) => (
              <NavLink key={item.href} item={item} active={isActive(item.href)} collapsed={collapsed} />
            ))}
          </div>

          <span className="flex-1" />

          {/* The one loud gradient CTA (solid lime in dark). */}
          <span className="group relative block">
            <Link
              href="/projects/new"
              className={`cta flex h-11 items-center justify-center gap-2 rounded-full text-lg font-semibold transition-opacity duration-150 ease-out hover:opacity-95 active:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ${
                collapsed ? 'mx-auto w-11' : 'w-full'
              }`}
            >
              <Plus size={20} strokeWidth={2} />
              {!collapsed && <span>New Project</span>}
            </Link>
            {collapsed && <Tooltip label="New Project" side="right" />}
          </span>
        </nav>

        <div className="mx-4 border-t border-line" />

        {/* Account card. */}
        <div className="relative p-3">
          {!collapsed && <SectionLabel className="px-3 pt-1 pb-2">Account</SectionLabel>}
          {menuOpen && (
            <>
              <button
                type="button"
                aria-label="Close menu"
                onClick={() => setMenuOpen(false)}
                className="fixed inset-0 z-10 cursor-default"
                tabIndex={-1}
              />
              {/* Expanded: in-flow above the account button, so the sidebar reflows (the nav
                  spacer absorbs the height) and the menu can never collide with the New Project
                  CTA. Collapsed: a flyout to the right of the rail. */}
              <div
                className={`z-20 rounded-xl border border-line bg-surface p-1.5 shadow-sm ${
                  collapsed ? 'absolute bottom-3 left-full ml-2 w-max' : 'relative mb-1.5'
                }`}
              >
                <button
                  type="button"
                  onClick={() => void handleSignOut()}
                  className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-base whitespace-nowrap text-ink transition-colors duration-150 ease-out hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                >
                  <LogOut size={18} strokeWidth={ICON_STROKE} className="text-icon" />
                  Sign out
                </button>
              </div>
            </>
          )}
          <button
            type="button"
            onClick={() => setMenuOpen((open) => !open)}
            aria-expanded={menuOpen}
            aria-haspopup="menu"
            title={collapsed ? user.name : undefined}
            className={`flex w-full items-center rounded-xl p-2 text-left transition-colors duration-150 ease-out hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ${
              collapsed ? 'justify-center' : 'gap-3'
            }`}
          >
            <Avatar name={user.name} size={36} />
            {!collapsed && (
              <>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-base font-semibold text-ink">{user.name}</span>
                  <span className="block truncate text-xs text-soft">{user.email}</span>
                </span>
                <ChevronsUpDown size={16} strokeWidth={ICON_STROKE} className="shrink-0 text-icon" />
              </>
            )}
          </button>
        </div>
      </aside>

      {/* Content column (DESIGN.md: max-width 1440px, padding 32px 40px). */}
      <main className="min-w-0 flex-1">
        <div className="mx-auto w-full max-w-[1440px] px-10 py-8">{children}</div>
      </main>
    </div>
  );
}
