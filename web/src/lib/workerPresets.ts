/**
 * Ready-made worker configurations offered on the project Workers tab, chosen by the project's
 * stack. A background worker is mostly boilerplate a developer half-remembers — the exact
 * `queue:work` flags, how many processes, how long to let a job finish on shutdown — and getting the
 * shutdown timeout wrong silently loses jobs on every deploy. These encode the settings that go with
 * each command rather than only the command string.
 *
 * Presets are a STARTING POINT, not a constraint: every field stays editable afterwards, and the
 * "Custom worker" entry starts from blank.
 */
import type { WorkerRestartPolicy } from '../api';

export interface WorkerPreset {
  /** Stable key for the picker. */
  id: string;
  label: string;
  /** One line on what it's for and why the settings are what they are. */
  description: string;
  /** Prefilled worker name; deduplicated against existing workers by the form. */
  name: string;
  command: string;
  processes: number;
  autoStart: boolean;
  restartPolicy: WorkerRestartPolicy;
  restartSec: number;
  stopTimeoutSec: number;
}

/** The blank starting point, offered for every stack. */
export const CUSTOM_PRESET: WorkerPreset = {
  id: 'custom',
  label: 'Custom worker',
  description: 'Start from scratch.',
  name: '',
  command: '',
  processes: 1,
  autoStart: true,
  restartPolicy: 'always',
  restartSec: 3,
  stopTimeoutSec: 90,
};

/**
 * Laravel's queue worker wants a generous stop timeout: on SIGTERM it finishes the job in hand
 * before exiting, and killing it early is what turns a deploy into a lost job. `--max-time` recycles
 * the process hourly so a slow memory leak can't accumulate.
 */
const PHP_PRESETS: WorkerPreset[] = [
  {
    id: 'laravel-queue',
    label: 'Laravel queue worker',
    description: 'Processes queued jobs. Restarts hourly to keep memory flat, and finishes the job in hand before shutting down.',
    name: 'queue',
    command: 'php artisan queue:work --sleep=3 --tries=3 --max-time=3600',
    processes: 2,
    autoStart: true,
    restartPolicy: 'always',
    restartSec: 3,
    stopTimeoutSec: 120,
  },
  {
    id: 'laravel-queue-single',
    label: 'Laravel queue worker (single process)',
    description: 'The same worker on one process, for a queue where jobs must run strictly one at a time.',
    name: 'queue',
    command: 'php artisan queue:work --sleep=3 --tries=3 --max-time=3600',
    processes: 1,
    autoStart: true,
    restartPolicy: 'always',
    restartSec: 3,
    stopTimeoutSec: 120,
  },
  {
    id: 'laravel-horizon',
    label: 'Laravel Horizon',
    description: 'Horizon supervises its own worker pool, so it runs as a single process and manages concurrency itself.',
    name: 'horizon',
    command: 'php artisan horizon',
    processes: 1,
    autoStart: true,
    restartPolicy: 'always',
    restartSec: 3,
    stopTimeoutSec: 180,
  },
  {
    id: 'laravel-schedule-work',
    label: 'Laravel scheduler (long-running)',
    description: "Runs due scheduled tasks in-process. Use this instead of a cron entry if you'd rather not add one.",
    name: 'scheduler',
    command: 'php artisan schedule:work',
    processes: 1,
    autoStart: true,
    restartPolicy: 'always',
    restartSec: 5,
    stopTimeoutSec: 60,
  },
  {
    id: 'laravel-reverb',
    label: 'Laravel Reverb (websockets)',
    description: 'The Reverb websocket server. One process — clients hold long-lived connections to it.',
    name: 'reverb',
    command: 'php artisan reverb:start',
    processes: 1,
    autoStart: true,
    restartPolicy: 'always',
    restartSec: 3,
    stopTimeoutSec: 30,
  },
];

const NODE_PRESETS: WorkerPreset[] = [
  {
    id: 'node-npm-worker',
    label: 'npm script worker',
    description: "Runs the project's own `worker` script. The usual entry point for a BullMQ or Agenda consumer.",
    name: 'worker',
    command: 'npm run worker',
    processes: 2,
    autoStart: true,
    restartPolicy: 'always',
    restartSec: 3,
    stopTimeoutSec: 60,
  },
  {
    id: 'node-script',
    label: 'Node script',
    description: 'Runs a built worker file directly, skipping the npm wrapper process.',
    name: 'worker',
    command: 'node dist/worker.js',
    processes: 2,
    autoStart: true,
    restartPolicy: 'always',
    restartSec: 3,
    stopTimeoutSec: 60,
  },
  {
    id: 'node-scheduler',
    label: 'Scheduler / ticker',
    description: 'A single long-running scheduler. One process, since two would fire every scheduled job twice.',
    name: 'scheduler',
    command: 'node dist/scheduler.js',
    processes: 1,
    autoStart: true,
    restartPolicy: 'always',
    restartSec: 5,
    stopTimeoutSec: 30,
  },
];

const STATIC_PRESETS: WorkerPreset[] = [
  {
    id: 'shell-worker',
    label: 'Shell script worker',
    description: 'Runs a long-lived script from the release directory.',
    name: 'worker',
    command: './scripts/worker.sh',
    processes: 1,
    autoStart: true,
    restartPolicy: 'always',
    restartSec: 5,
    stopTimeoutSec: 30,
  },
];

/** Presets for a project type, most useful first, always ending with the blank custom option. */
export function presetsForType(type: string | undefined): WorkerPreset[] {
  switch (type) {
    case 'php':
      return [...PHP_PRESETS, CUSTOM_PRESET];
    case 'node':
    case 'nextjs':
      return [...NODE_PRESETS, CUSTOM_PRESET];
    case 'static':
      return [...STATIC_PRESETS, CUSTOM_PRESET];
    default:
      return [CUSTOM_PRESET];
  }
}

/**
 * `base`, or `base-2`, `base-3`… until it doesn't collide with `taken`. Worker names are unique per
 * project (the API returns 409 otherwise), and a preset's suggested name is the one most likely to
 * already be in use — hitting that 409 after filling in a form is a pointless way to learn it.
 */
export function uniqueWorkerName(base: string, taken: string[]): string {
  if (base === '' || !taken.includes(base)) return base;
  for (let suffix = 2; suffix < 100; suffix++) {
    const candidate = `${base}-${String(suffix)}`;
    if (!taken.includes(candidate)) return candidate;
  }
  return base;
}
