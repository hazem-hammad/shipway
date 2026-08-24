/**
 * Databases page: provisioned MySQL/Postgres instances plus read-only Redis/Mailpit connection
 * info (server/src/routes/databases.ts). Creation and credential reveal share one panel styling
 * (task-25 controller ruling); the create response carries the plaintext password exactly once
 * (`POST /api/databases`'s doc comment), so that panel alone gets the "shown once" note — a later
 * reveal (`GET /:id/credentials`) can return the password again since it's decrypted server-side,
 * but isn't a one-time event the same way.
 */
import { type FormEvent, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Check, Copy, Database as DatabaseIcon, Eye, EyeOff, Mail, Plus } from 'lucide-react';
import {
  ApiError,
  createDatabase,
  deleteDatabase,
  fetchDatabaseCredentials,
  injectDatabase,
  type DatabaseCreated,
  type DatabaseListItem,
  type DbEngine,
} from '../api';
import { useDatabases, useProjects, useServicesInfo } from '../hooks';
import { Badge, Button, Card, CardHeader, Chip, EmptyState, Field, ICON_STROKE, Input, PageHeader, Select, Skeleton } from '../components/ui';
import { formatRelativeTime } from '../lib/format';

const NAME_RE = /^[a-z][a-z0-9_]{0,31}$/;

const ENGINE_OPTIONS: { value: DbEngine; label: string }[] = [
  { value: 'mysql', label: 'MySQL' },
  { value: 'postgres', label: 'Postgres' },
];

const ENGINE_LABEL: Record<DbEngine, string> = {
  mysql: 'MySQL',
  postgres: 'Postgres',
};

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

function portFor(engine: DbEngine): number {
  return engine === 'mysql' ? 3306 : 5432;
}

export default function DatabasesPage() {
  const databasesQuery = useDatabases();
  const [creating, setCreating] = useState(false);
  const [createdCreds, setCreatedCreds] = useState<DatabaseCreated | null>(null);

  return (
    <div>
      <PageHeader
        title="Databases"
        subtitle="MySQL and Postgres databases on this server"
        actions={
          !creating &&
          !createdCreds && (
            <Button onClick={() => setCreating(true)}>
              <Plus size={18} strokeWidth={2} aria-hidden />
              New database
            </Button>
          )
        }
      />

      <div className="flex flex-col gap-5">
        {creating && (
          <CreateDatabaseForm
            onCreated={(created) => {
              setCreating(false);
              setCreatedCreds(created);
            }}
            onCancel={() => setCreating(false)}
          />
        )}

        {createdCreds && (
          <Card>
            <div className="flex items-center justify-between gap-4">
              <h2 className="text-lg font-semibold text-ink">Database created</h2>
              <button
                type="button"
                onClick={() => setCreatedCreds(null)}
                className="rounded text-sm font-medium text-soft transition-colors duration-150 ease-out hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
              >
                Dismiss
              </button>
            </div>
            <div className="mt-4">
              <CredentialsPanel
                databaseId={createdCreds.id}
                engine={createdCreds.engine}
                name={createdCreds.name}
                username={createdCreds.username}
                password={createdCreds.password}
                oneTime
              />
            </div>
          </Card>
        )}

        {databasesQuery.isPending ? (
          <Card>
            <DatabasesSkeletonRows />
          </Card>
        ) : databasesQuery.isError ? (
          <p role="alert" className="text-sm text-danger">
            Could not load databases.
          </p>
        ) : databasesQuery.data.length === 0 ? (
          creating ? null : <EmptyState message="No databases yet. Provision one to get connection credentials." />
        ) : (
          <Card>
            <div className="divide-y divide-line">
              {databasesQuery.data.map((database) => (
                <DatabaseRow key={database.id} database={database} />
              ))}
            </div>
          </Card>
        )}

        <ServicesInfoPanels />
      </div>
    </div>
  );
}

function CreateDatabaseForm({ onCreated, onCancel }: { onCreated: (created: DatabaseCreated) => void; onCancel: () => void }) {
  const queryClient = useQueryClient();
  const projectsQuery = useProjects();
  const [engine, setEngine] = useState<DbEngine>('mysql');
  const [name, setName] = useState('');
  const [projectId, setProjectId] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setNameError(null);
    setFormError(null);

    if (!NAME_RE.test(name)) {
      setNameError('Lowercase letters, digits, underscores; must start with a letter.');
      return;
    }

    setSubmitting(true);
    try {
      const created = await createDatabase({
        engine,
        name,
        ...(projectId !== '' ? { projectId: Number(projectId) } : {}),
      });
      await queryClient.invalidateQueries({ queryKey: ['databases'] });
      onCreated(created);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setNameError('A database with this name already exists for this engine.');
      } else {
        setFormError(errorMessage(err, 'Could not create the database. Try again.'));
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <form onSubmit={(event) => void handleSubmit(event)} className="flex max-w-[560px] flex-col gap-4" noValidate>
        <div role="radiogroup" aria-label="Engine" className="flex gap-3">
          {ENGINE_OPTIONS.map((option) => (
            <label
              key={option.value}
              className={`flex flex-1 items-center justify-center gap-2 rounded-xl border px-4 py-3.5 text-base font-semibold transition-colors duration-150 ease-out ${
                engine === option.value ? 'border-focus bg-surface-2 text-ink' : 'border-line bg-surface text-ink hover:bg-surface-2'
              }`}
            >
              <input
                type="radio"
                name="db-engine"
                value={option.value}
                checked={engine === option.value}
                onChange={() => setEngine(option.value)}
                className="h-4 w-4 accent-[var(--primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
              />
              {option.label}
            </label>
          ))}
        </div>

        <Field label="Name" hint="Lowercase, digits, underscores; starts with a letter. Up to 32 chars." error={nameError ?? undefined}>
          <Input
            mono
            required
            autoFocus
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setNameError(null);
            }}
          />
        </Field>

        <Field label="Link to project" hint="Optional. You can also add the connection env later.">
          <Select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
            <option value="">None</option>
            {(projectsQuery.data ?? []).map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </Select>
        </Field>

        {formError && (
          <p role="alert" className="text-sm text-danger">
            {formError}
          </p>
        )}

        <div className="flex items-center gap-2">
          <Button type="submit" loading={submitting}>
            Create database
          </Button>
          <Button type="button" variant="outline" onClick={onCancel} disabled={submitting}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}

function DatabaseRow({ database }: { database: DatabaseListItem }) {
  const [expanded, setExpanded] = useState<'reveal' | 'drop' | null>(null);
  const [credentials, setCredentials] = useState<{ username: string; password: string } | null>(null);
  const [revealLoading, setRevealLoading] = useState(false);
  const [revealError, setRevealError] = useState<string | null>(null);

  async function toggleReveal() {
    if (expanded === 'reveal') {
      setExpanded(null);
      return;
    }
    setExpanded('reveal');
    if (credentials) return;
    setRevealLoading(true);
    setRevealError(null);
    try {
      const creds = await fetchDatabaseCredentials(database.id);
      setCredentials({ username: creds.username, password: creds.password });
    } catch (err) {
      setRevealError(errorMessage(err, 'Could not load credentials.'));
    } finally {
      setRevealLoading(false);
    }
  }

  function toggleDrop() {
    setExpanded((current) => (current === 'drop' ? null : 'drop'));
  }

  return (
    <div className="flex flex-col">
      <div className="flex h-14 items-center gap-4 px-2">
        <Badge className="shrink-0">{ENGINE_LABEL[database.engine]}</Badge>
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-base font-semibold text-ink">{database.name}</div>
          <div className="mt-0.5 truncate text-sm text-soft">{database.projectName ?? 'Not linked'}</div>
        </div>
        <span className="hidden shrink-0 text-sm text-soft sm:block">{formatRelativeTime(database.createdAt)}</span>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void toggleReveal()}>
            {expanded === 'reveal' ? 'Hide credentials' : 'Credentials'}
          </Button>
          <Button variant="danger" size="sm" onClick={toggleDrop}>
            Drop
          </Button>
        </div>
      </div>

      {expanded === 'reveal' && (
        <div className="mx-2 mb-3">
          {revealLoading ? (
            <Skeleton className="h-32 w-full max-w-[560px] rounded-xl" />
          ) : revealError ? (
            <p role="alert" className="text-sm text-danger">
              {revealError}
            </p>
          ) : credentials ? (
            <CredentialsPanel
              databaseId={database.id}
              engine={database.engine}
              name={database.name}
              username={credentials.username}
              password={credentials.password}
              oneTime={false}
            />
          ) : null}
        </div>
      )}

      {expanded === 'drop' && (
        <div className="mx-2 mb-3">
          <DropConfirm database={database} onDropped={() => setExpanded(null)} />
        </div>
      )}
    </div>
  );
}

function DropConfirm({ database, onDropped }: { database: DatabaseListItem; onDropped: () => void }) {
  const queryClient = useQueryClient();
  const [confirmText, setConfirmText] = useState('');
  const [dropping, setDropping] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canDrop = confirmText === database.name && !dropping;

  async function handleDrop() {
    setError(null);
    setDropping(true);
    try {
      await deleteDatabase(database.id, confirmText);
      await queryClient.invalidateQueries({ queryKey: ['databases'] });
      onDropped();
    } catch (err) {
      setError(errorMessage(err, 'Could not drop the database. Try again.'));
      setDropping(false);
    }
  }

  return (
    <div className="rounded-xl bg-surface-2 p-4">
      <p className="text-sm text-ink">
        This permanently deletes database <Chip>{database.name}</Chip> and its user. Type <Chip>{database.name}</Chip> to confirm.
      </p>
      <Input
        mono
        value={confirmText}
        onChange={(event) => setConfirmText(event.target.value)}
        aria-label="Type the database name to confirm dropping it"
        className="mt-2 max-w-xs"
      />
      {error && (
        <p role="alert" className="mt-2 text-sm text-danger">
          {error}
        </p>
      )}
      <div className="mt-3">
        <Button variant="danger" size="sm" disabled={!canDrop} loading={dropping} onClick={() => void handleDrop()}>
          Drop database
        </Button>
      </div>
    </div>
  );
}

/** Shared credentials display for both the one-time create response and a later reveal. */
function CredentialsPanel({
  databaseId,
  engine,
  name,
  username,
  password,
  oneTime,
}: {
  databaseId: number;
  engine: DbEngine;
  name: string;
  username: string;
  password: string;
  oneTime: boolean;
}) {
  const projectsQuery = useProjects();
  const [injectProjectId, setInjectProjectId] = useState('');
  const [injecting, setInjecting] = useState(false);
  const [injectResult, setInjectResult] = useState<'ok' | 'fail' | null>(null);
  const [injectMessage, setInjectMessage] = useState<string | null>(null);

  async function handleInject() {
    if (injectProjectId === '') return;
    setInjecting(true);
    setInjectResult(null);
    setInjectMessage(null);
    try {
      await injectDatabase(databaseId, Number(injectProjectId));
      setInjectResult('ok');
    } catch (err) {
      setInjectResult('fail');
      setInjectMessage(errorMessage(err, 'Could not add to the project environment.'));
    } finally {
      setInjecting(false);
    }
  }

  return (
    <div className="max-w-[560px] rounded-xl bg-surface-2 p-4">
      <p className="mb-3 flex items-center gap-2">
        <Badge>{ENGINE_LABEL[engine]}</Badge>
        <span className="font-mono text-sm font-semibold text-ink">{name}</span>
      </p>
      <div className="flex flex-col gap-2">
        <CredentialRow label="Host" value="127.0.0.1" />
        <CredentialRow label="Port" value={String(portFor(engine))} />
        <CredentialRow label="Username" value={username} />
        <CredentialRow label="Password" value={password} />
      </div>

      {oneTime && <p className="mt-3 text-sm text-warn">Save these now. The password is shown once.</p>}

      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-4">
        <Select value={injectProjectId} onChange={(event) => setInjectProjectId(event.target.value)} className="w-56">
          <option value="">Add to project env…</option>
          {(projectsQuery.data ?? []).map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </Select>
        <Button variant="secondary" size="sm" disabled={injectProjectId === ''} loading={injecting} onClick={() => void handleInject()}>
          Add to project env
        </Button>
        {injectResult === 'ok' && <Badge tone="ok">Added to the project&rsquo;s environment</Badge>}
        {injectResult === 'fail' && (
          <span role="alert" className="text-sm text-danger">
            {injectMessage}
          </span>
        )}
      </div>
    </div>
  );
}

function CredentialRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API unavailable or denied — the value is still visible to copy by hand.
    }
  }

  return (
    <div className="flex items-center justify-between gap-3 rounded-lg bg-surface px-3 py-2.5">
      <div className="min-w-0">
        <p className="text-xs text-soft">{label}</p>
        <p className="truncate font-mono text-sm text-ink">{value}</p>
      </div>
      <button
        type="button"
        onClick={() => void handleCopy()}
        className="inline-flex shrink-0 items-center gap-1.5 rounded px-2 py-1 text-xs font-medium text-soft transition-colors duration-150 ease-out hover:bg-surface-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        {copied ? <Check size={14} strokeWidth={ICON_STROKE} aria-hidden /> : <Copy size={14} strokeWidth={ICON_STROKE} aria-hidden />}
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

function ServicesInfoPanels() {
  const servicesQuery = useServicesInfo();
  if (!servicesQuery.data) return null;
  const { redis, mailpit } = servicesQuery.data;
  if (!redis && !mailpit) return null;

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {redis && <RedisPanel host={redis.host} port={redis.port} password={redis.password} />}
      {mailpit && (
        <MailpitPanel
          smtpHost={mailpit.smtpHost}
          smtpPort={mailpit.smtpPort}
          webUrl={mailpit.webUrl}
          username={mailpit.username}
          webPassword={mailpit.webPassword}
        />
      )}
    </div>
  );
}

function RevealToggle({ revealed, onToggle }: { revealed: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="inline-flex items-center gap-1 rounded text-xs font-medium text-soft transition-colors duration-150 ease-out hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
    >
      {revealed ? <EyeOff size={14} strokeWidth={ICON_STROKE} aria-hidden /> : <Eye size={14} strokeWidth={ICON_STROKE} aria-hidden />}
      {revealed ? 'Hide' : 'Reveal'}
    </button>
  );
}

function RedisPanel({ host, port, password }: { host: string; port: number; password?: string }) {
  const [revealed, setRevealed] = useState(false);
  return (
    <Card>
      <CardHeader icon={<DatabaseIcon size={20} strokeWidth={ICON_STROKE} />} title="Redis" description="Shared cache and queue broker." />
      <dl className="mt-4 flex flex-col gap-2 text-sm">
        <div className="flex items-center justify-between">
          <dt className="text-soft">Host</dt>
          <dd className="font-mono text-ink">{host}</dd>
        </div>
        <div className="flex items-center justify-between">
          <dt className="text-soft">Port</dt>
          <dd className="font-mono text-ink">{port}</dd>
        </div>
        {password && (
          <div className="flex items-center justify-between">
            <dt className="text-soft">Password</dt>
            <dd className="flex items-center gap-2">
              <span className="font-mono text-ink">{revealed ? password : '•'.repeat(8)}</span>
              <RevealToggle revealed={revealed} onToggle={() => setRevealed((v) => !v)} />
            </dd>
          </div>
        )}
      </dl>
    </Card>
  );
}

function MailpitPanel({
  smtpHost,
  smtpPort,
  webUrl,
  username,
  webPassword,
}: {
  smtpHost: string;
  smtpPort: number;
  webUrl: string;
  username?: string;
  webPassword?: string;
}) {
  const [revealed, setRevealed] = useState(false);
  return (
    <Card>
      <CardHeader icon={<Mail size={20} strokeWidth={ICON_STROKE} />} title="Mailpit" description="Local SMTP catch-all for outgoing mail." />
      <dl className="mt-4 flex flex-col gap-2 text-sm">
        <div className="flex items-center justify-between">
          <dt className="text-soft">SMTP host</dt>
          <dd className="font-mono text-ink">{smtpHost}</dd>
        </div>
        <div className="flex items-center justify-between">
          <dt className="text-soft">SMTP port</dt>
          <dd className="font-mono text-ink">{smtpPort}</dd>
        </div>
        {username && (
          <div className="flex items-center justify-between">
            <dt className="text-soft">Web UI username</dt>
            <dd className="font-mono text-ink">{username}</dd>
          </div>
        )}
        {webPassword && (
          <div className="flex items-center justify-between">
            <dt className="text-soft">Web UI password</dt>
            <dd className="flex items-center gap-2">
              <span className="font-mono text-ink">{revealed ? webPassword : '•'.repeat(8)}</span>
              <RevealToggle revealed={revealed} onToggle={() => setRevealed((v) => !v)} />
            </dd>
          </div>
        )}
      </dl>
      <a
        href={webUrl}
        target="_blank"
        rel="noreferrer noopener"
        className="mt-3 inline-block text-sm font-medium text-link hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        Open Mailpit web UI
      </a>
    </Card>
  );
}

function DatabasesSkeletonRows() {
  return (
    <div className="divide-y divide-line">
      {[0, 1, 2].map((row) => (
        <div key={row} className="flex h-14 items-center gap-4 px-2">
          <Skeleton className="h-6 w-16 rounded-full" />
          <div className="min-w-0 flex-1">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="mt-1.5 h-3 w-24" />
          </div>
          <Skeleton className="hidden h-4 w-16 sm:block" />
          <Skeleton className="h-8 w-24 rounded-xl" />
        </div>
      ))}
    </div>
  );
}
