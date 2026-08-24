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
import { Button, Chip, EmptyState, Field, Input, PageHeader, Panel, Select, Skeleton } from '../components/ui';
import { formatRelativeTime } from '../lib/format';

const NAME_RE = /^[a-z][a-z0-9_]{0,31}$/;
const TABLE_COLUMN_COUNT = 5;

const ENGINE_OPTIONS: { value: DbEngine; label: string }[] = [
  { value: 'mysql', label: 'MySQL' },
  { value: 'postgres', label: 'Postgres' },
];

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
        actions={
          !creating &&
          !createdCreds && (
            <Button onClick={() => setCreating(true)} className="px-2.5 py-1.5 text-xs">
              New database
            </Button>
          )
        }
      />

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
        <div className="mb-6">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-ink">Database created</h2>
            <button
              type="button"
              onClick={() => setCreatedCreds(null)}
              className="rounded text-xs font-medium text-ink-soft underline decoration-line underline-offset-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              Dismiss
            </button>
          </div>
          <CredentialsPanel
            databaseId={createdCreds.id}
            engine={createdCreds.engine}
            name={createdCreds.name}
            username={createdCreds.username}
            password={createdCreds.password}
            oneTime
          />
        </div>
      )}

      {databasesQuery.isPending ? (
        <TableSkeleton />
      ) : databasesQuery.isError ? (
        <p role="alert" className="text-sm text-stop">
          Could not load databases.
        </p>
      ) : databasesQuery.data.length === 0 && !creating ? (
        <EmptyState message="No databases yet. Provision one to get connection credentials." />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full min-w-[720px] border-collapse text-left text-sm">
            <thead className="bg-panel text-xs font-medium text-ink-soft">
              <tr>
                <th scope="col" className="px-4 py-2.5 font-medium">
                  Engine
                </th>
                <th scope="col" className="px-4 py-2.5 font-medium">
                  Name
                </th>
                <th scope="col" className="px-4 py-2.5 font-medium">
                  Linked project
                </th>
                <th scope="col" className="px-4 py-2.5 font-medium">
                  Created
                </th>
                <th scope="col" className="px-4 py-2.5"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {databasesQuery.data.map((database) => (
                <DatabaseRow key={database.id} database={database} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <ServicesInfoPanels />
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
    <form
      onSubmit={(event) => void handleSubmit(event)}
      className="mb-6 flex max-w-[560px] flex-col gap-4 rounded-lg border border-line bg-panel/40 p-4"
      noValidate
    >
      <div role="radiogroup" aria-label="Engine" className="flex gap-2">
        {ENGINE_OPTIONS.map((option) => (
          <label
            key={option.value}
            className={`flex flex-1 items-center justify-center gap-2 rounded-md border px-3 py-2 text-sm font-medium transition-colors duration-150 ease-out ${
              engine === option.value ? 'border-accent bg-accent-soft text-accent' : 'border-line bg-paper text-ink hover:bg-panel'
            }`}
          >
            <input
              type="radio"
              name="db-engine"
              value={option.value}
              checked={engine === option.value}
              onChange={() => setEngine(option.value)}
              className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              style={{ accentColor: 'var(--color-accent)' }}
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
        <p role="alert" className="text-sm text-stop">
          {formError}
        </p>
      )}

      <div className="flex items-center gap-2">
        <Button type="submit" loading={submitting} className="px-2.5 py-1 text-xs">
          Create database
        </Button>
        <Button type="button" variant="secondary" onClick={onCancel} disabled={submitting} className="px-2.5 py-1 text-xs">
          Cancel
        </Button>
      </div>
    </form>
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
    <>
      <tr className="h-11">
        <td className="px-4 py-3">
          <Chip>{database.engine}</Chip>
        </td>
        <td className="px-4 py-3 font-mono text-ink">{database.name}</td>
        <td className="px-4 py-3 text-ink-soft">{database.projectName ?? 'Not linked'}</td>
        <td className="px-4 py-3 text-ink-soft">{formatRelativeTime(database.createdAt)}</td>
        <td className="px-4 py-3 text-right">
          <div className="flex items-center justify-end gap-3">
            <button
              type="button"
              onClick={() => void toggleReveal()}
              className="rounded text-xs font-medium text-accent underline decoration-line underline-offset-2 hover:text-accent/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              {expanded === 'reveal' ? 'Hide credentials' : 'Reveal credentials'}
            </button>
            <button
              type="button"
              onClick={toggleDrop}
              className="rounded text-xs font-medium text-stop underline decoration-line underline-offset-2 hover:text-stop/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              Drop
            </button>
          </div>
        </td>
      </tr>

      {expanded === 'reveal' && (
        <tr>
          <td colSpan={TABLE_COLUMN_COUNT} className="border-t border-line bg-panel/60 px-4 py-3">
            {revealLoading ? (
              <Skeleton className="h-32 w-full max-w-[560px]" />
            ) : revealError ? (
              <p role="alert" className="text-sm text-stop">
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
          </td>
        </tr>
      )}

      {expanded === 'drop' && (
        <tr>
          <td colSpan={TABLE_COLUMN_COUNT} className="border-t border-line bg-stop/5 px-4 py-3">
            <DropConfirm database={database} onDropped={() => setExpanded(null)} />
          </td>
        </tr>
      )}
    </>
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
    <div>
      <p className="text-sm text-ink">
        This permanently deletes database <Chip>{database.name}</Chip> and its user. Type{' '}
        <Chip>{database.name}</Chip> to confirm.
      </p>
      <Input
        mono
        value={confirmText}
        onChange={(event) => setConfirmText(event.target.value)}
        aria-label="Type the database name to confirm dropping it"
        className="mt-2 max-w-xs"
      />
      {error && (
        <p role="alert" className="mt-2 text-sm text-stop">
          {error}
        </p>
      )}
      <div className="mt-3">
        <Button variant="destructive" disabled={!canDrop} loading={dropping} onClick={() => void handleDrop()} className="px-2.5 py-1 text-xs">
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
    <div className="max-w-[560px] rounded-lg border border-line bg-paper p-4">
      <p className="mb-3 text-sm text-ink">
        <Chip>{engine}</Chip> <span className="ml-1 font-mono">{name}</span>
      </p>
      <div className="flex flex-col gap-2">
        <CredentialRow label="Host" value="127.0.0.1" />
        <CredentialRow label="Port" value={String(portFor(engine))} />
        <CredentialRow label="Username" value={username} />
        <CredentialRow label="Password" value={password} />
      </div>

      {oneTime && <p className="mt-3 text-xs text-hold">Save these now. The password is shown once.</p>}

      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-4">
        <Select value={injectProjectId} onChange={(event) => setInjectProjectId(event.target.value)} className="w-56">
          <option value="">Add to project env…</option>
          {(projectsQuery.data ?? []).map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </Select>
        <Button
          variant="secondary"
          className="px-2.5 py-1 text-xs"
          disabled={injectProjectId === ''}
          loading={injecting}
          onClick={() => void handleInject()}
        >
          Add to project env
        </Button>
        {injectResult === 'ok' && <span className="text-xs text-go">Added to the project&rsquo;s environment.</span>}
        {injectResult === 'fail' && (
          <span role="alert" className="text-xs text-stop">
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
    <div className="flex items-center justify-between gap-3 rounded-md border border-line bg-panel/40 px-3 py-2">
      <div className="min-w-0">
        <p className="text-xs text-ink-soft">{label}</p>
        <p className="truncate font-mono text-sm text-ink">{value}</p>
      </div>
      <button
        type="button"
        onClick={() => void handleCopy()}
        className="shrink-0 rounded px-2 py-1 text-xs font-medium text-accent underline decoration-line underline-offset-2 hover:text-accent/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
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
    <div className="mt-8 grid gap-4 sm:grid-cols-2">
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

function RedisPanel({ host, port, password }: { host: string; port: number; password?: string }) {
  const [revealed, setRevealed] = useState(false);
  return (
    <Panel>
      <h2 className="mb-3 text-sm font-semibold text-ink">Redis</h2>
      <dl className="flex flex-col gap-2 text-sm">
        <div className="flex items-center justify-between">
          <dt className="text-ink-soft">Host</dt>
          <dd className="font-mono text-ink">{host}</dd>
        </div>
        <div className="flex items-center justify-between">
          <dt className="text-ink-soft">Port</dt>
          <dd className="font-mono text-ink">{port}</dd>
        </div>
        {password && (
          <div className="flex items-center justify-between">
            <dt className="text-ink-soft">Password</dt>
            <dd className="flex items-center gap-2">
              <span className="font-mono text-ink">{revealed ? password : '•'.repeat(8)}</span>
              <button
                type="button"
                onClick={() => setRevealed((v) => !v)}
                className="rounded text-xs font-medium text-accent underline decoration-line underline-offset-2 hover:text-accent/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                {revealed ? 'Hide' : 'Reveal'}
              </button>
            </dd>
          </div>
        )}
      </dl>
    </Panel>
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
    <Panel>
      <h2 className="mb-3 text-sm font-semibold text-ink">Mailpit</h2>
      <dl className="flex flex-col gap-2 text-sm">
        <div className="flex items-center justify-between">
          <dt className="text-ink-soft">SMTP host</dt>
          <dd className="font-mono text-ink">{smtpHost}</dd>
        </div>
        <div className="flex items-center justify-between">
          <dt className="text-ink-soft">SMTP port</dt>
          <dd className="font-mono text-ink">{smtpPort}</dd>
        </div>
        {username && (
          <div className="flex items-center justify-between">
            <dt className="text-ink-soft">Web UI username</dt>
            <dd className="font-mono text-ink">{username}</dd>
          </div>
        )}
        {webPassword && (
          <div className="flex items-center justify-between">
            <dt className="text-ink-soft">Web UI password</dt>
            <dd className="flex items-center gap-2">
              <span className="font-mono text-ink">{revealed ? webPassword : '•'.repeat(8)}</span>
              <button
                type="button"
                onClick={() => setRevealed((v) => !v)}
                className="rounded text-xs font-medium text-accent underline decoration-line underline-offset-2 hover:text-accent/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                {revealed ? 'Hide' : 'Reveal'}
              </button>
            </dd>
          </div>
        )}
      </dl>
      <a
        href={webUrl}
        target="_blank"
        rel="noreferrer noopener"
        className="mt-3 inline-block text-xs font-medium text-accent underline decoration-line underline-offset-2 hover:text-accent/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        Open Mailpit web UI
      </a>
    </Panel>
  );
}

function TableSkeleton() {
  return (
    <div className="overflow-hidden rounded-lg border border-line">
      <div className="bg-panel px-4 py-3">
        <Skeleton className="h-3 w-32" />
      </div>
      <div className="divide-y divide-line">
        {[0, 1, 2].map((row) => (
          <div key={row} className="flex h-11 items-center gap-6 px-4">
            <Skeleton className="h-4 w-16" />
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-4 flex-1" />
          </div>
        ))}
      </div>
    </div>
  );
}
