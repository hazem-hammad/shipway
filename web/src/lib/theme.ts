/**
 * Theme mechanics (DESIGN.md): Tailwind `dark` class strategy on <html>, persisted
 * localStorage['shipway.theme'] = 'light' | 'dark' | null (system). `initTheme()` runs in
 * main.tsx before the first render so there is no flash, and keeps following the OS
 * preference live while no explicit choice is stored.
 */

const STORAGE_KEY = 'shipway.theme';

export type ThemeChoice = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

const media = window.matchMedia('(prefers-color-scheme: dark)');

/** The stored choice; 'system' when nothing (or garbage) is stored. */
export function getTheme(): ThemeChoice {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(STORAGE_KEY);
  } catch {
    // Storage unavailable (private mode, blocked): behave as system.
  }
  return stored === 'light' || stored === 'dark' ? stored : 'system';
}

/** What is actually on screen right now. */
export function resolvedTheme(): ResolvedTheme {
  const choice = getTheme();
  if (choice === 'system') return media.matches ? 'dark' : 'light';
  return choice;
}

/** Toggle the `dark` class to match the current choice (or OS preference). */
export function applyTheme(): void {
  document.documentElement.classList.toggle('dark', resolvedTheme() === 'dark');
}

/** Persist a choice ('system' clears the key) and apply it immediately. */
export function setTheme(choice: ThemeChoice): void {
  try {
    if (choice === 'system') {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, choice);
    }
  } catch {
    // Storage unavailable: the class still flips for this page load.
  }
  applyTheme();
}

/**
 * Apply the theme now and keep tracking the OS preference while the choice is 'system'.
 * Call once, before the first render.
 */
export function initTheme(): void {
  applyTheme();
  media.addEventListener('change', () => {
    if (getTheme() === 'system') applyTheme();
  });
}
