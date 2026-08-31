/**
 * Databases page: provisioned MySQL/Postgres instances, the connections they live on, and read-only
 * Redis/Mailpit info (server/src/routes/databases.ts). Creation and credential reveal share one
 * panel styling (task-25 controller ruling); the create response carries the plaintext password
 * exactly once (`POST /api/databases`'s doc comment), so that panel alone gets the "shown once"
 * note — a later reveal (`GET /:id/credentials`) can return the password again since it's decrypted
 * server-side, but isn't a one-time event the same way.
 *
 * Split across three tabs rather than stacked down one page. Stacked, the database list grows
 * without bound and pushes Connections and the service info off the bottom — at fifteen databases
 * they are a scroll away, at fifty they are lost. Tabs give the list the whole page to grow into
 * while keeping the other two a click away, and each section keeps full width for its own forms.
 * The active tab lives in the query string, so a section is linkable and survives a reload.
 */
import { type FormEvent, useEffect, useMemo, useState } from 'react';
import { useLocation, useSearch } from 'wouter';
import { useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Eye, EyeOff, Plus, Search, Server } from 'lucide-react';
import {
  ApiError,
  createDatabase,
  createDbConnection,
  deleteDatabase,
  deleteDbConnection,
  fetchDatabaseCredentials,
  injectDatabase,
  testDbConnection,
  updateDbConnection,
  type DatabaseCreated,
  type DatabaseListItem,
  type DbConnection,
  type DbEngine,
  type ProjectListItem,
} from '../api';
import { useDatabases, useDbConnections, useProjects, useServicesInfo, useSettings } from '../hooks';

/** Projects worth offering a database to. Filtering the picker rather than letting the attach fail
 * later keeps the wrong answer off the menu instead of explaining it afterwards. */
function dbCapableProjects(projects: ProjectListItem[] | undefined): ProjectListItem[] {
  return (projects ?? []).filter((project) => isDbCapable(project.type));
}
import {
  Badge,
  Button,
  buttonClasses,
  Card,
  CardHeader,
  Chip,
  CopyRow,
  EmptyState,
  Field,
  ICON_STROKE,
  Input,
  PageHeader,
  Select,
  Skeleton,
  Tabs,
} from '../components/ui';
import { MailpitIcon, RedisIcon } from '../components/BrandIcons';
import { ENGINE_LABEL, consoleTitle, consoleUrl, hasConsole, isDbCapable } from '../lib/database';
import { formatRelativeTime } from '../lib/format';

const NAME_RE = /^[a-z][a-z0-9_]{0,31}$/;

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

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

type TabId = 'databases' | 'connections' | 'services';

const TAB_IDS: TabId[] = ['databases', 'connections', 'services'];

function isTabId(value: string): value is TabId {
  return (TAB_IDS as string[]).includes(value);
}

export default function DatabasesPage() {
  const databasesQuery = useDatabases();
  const connectionsQuery = useDbConnections();
  const [, navigate] = useLocation();
  const search = useSearch();

  const params = new URLSearchParams(search);
  const rawTab = params.get('tab') ?? '';
  const tab: TabId = isTabId(rawTab) ? rawTab : 'databases';

  const [creating, setCreating] = useState(false);
  const [createdCreds, setCreatedCreds] = useState<DatabaseCreated | null>(null);

  function goToTab(next: TabId): void {
    // `databases` is the default, so it stays out of the URL and an untouched page keeps a clean
    // `/databases`. `replace`, because switching tabs is not a place worth going Back to.
    navigate(next === 'databases' ? '/databases' : `/databases?tab=${next}`, { replace: true });
  }

  return (
    <div>
      <PageHeader
        title="Databases"
        subtitle="MySQL and Postgres databases, on this server or on a connection you register"
        actions={
          // Only on the tab it acts on: a "New database" button while reading Redis connection info
          // would be an action pointing somewhere other than what is on screen.
          tab === 'databases' &&
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
        <Tabs
          tabs={[
            { id: 'databases', label: 'Databases', count: databasesQuery.data?.length },
            { id: 'connections', label: 'Connections', count: connectionsQuery.data?.length },
            { id: 'services', label: 'Services' },
          ]}
          value={tab}
          onChange={(id) => {
            goToTab(id as TabId);
          }}
        />

        {tab === 'databases' && (
          <DatabasesTab
            creating={creating}
            createdCreds={createdCreds}
            onCreated={(created) => {
              setCreating(false);
              setCreatedCreds(created);
            }}
            onCancelCreate={() => {
              setCreating(false);
            }}
            onDismissCreds={() => {
              setCreatedCreds(null);
            }}
          />
        )}

        {tab === 'connections' && <ConnectionsCard />}

        {tab === 'services' && <ServicesInfoPanels />}
      </div>
    </div>
  );
}

/**
 * The database list, with the create form and the one-time credentials panel that belong to it.
 *
 * Search and the connection filter appear only once there is more than one database: a single row
 * behind a search box that can only ever find it is furniture, not help.
 */
function DatabasesTab({
  creating,
  createdCreds,
  onCreated,
  onCancelCreate,
  onDismissCreds,
}: {
  creating: boolean;
  createdCreds: DatabaseCreated | null;
  onCreated: (created: DatabaseCreated) => void;
  onCancelCreate: () => void;
  onDismissCreds: () => void;
}) {
  const databasesQuery = useDatabases();
  const connectionsQuery = useDbConnections();
  // Only used to build the database-console URLs; the Manage link is simply omitted until it loads,
  // rather than rendering a link to `ship.undefined`.
  const settingsQuery = useSettings();
  const baseDomain = settingsQuery.data?.base_domain ?? null;

  const [query, setQuery] = useState('');
  const [connectionKey, setConnectionKey] = useState('all');

  const databases = useMemo(() => databasesQuery.data ?? [], [databasesQuery.data]);
  const connections = connectionsQuery.data ?? [];

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return databases.filter((database) => {
      if (connectionKey !== 'all' && database.connectionKey !== connectionKey) return false;
      if (needle === '') return true;
      // Found by what it is called, who uses it, and where it lives — the three things someone
      // scanning a long list actually knows.
      return [database.name, database.username, database.projectName ?? '', database.connectionName ?? '']
        .join(' ')
        .toLowerCase()
        .includes(needle);
    });
  }, [databases, query, connectionKey]);

  const narrowed = query.trim() !== '' || connectionKey !== 'all';
  const showFilters = databases.length > 1;

  return (
    <>
      {creating && <CreateDatabaseForm onCreated={onCreated} onCancel={onCancelCreate} />}

      {createdCreds && (
        <Card>
          <div className="flex items-center justify-between gap-4">
            <h2 className="text-lg font-semibold text-ink">Database created</h2>
            <button
              type="button"
              onClick={onDismissCreds}
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
              host={createdCreds.host}
              port={createdCreds.port}
              connectionName={createdCreds.connectionName}
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
      ) : databases.length === 0 ? (
        creating ? null : <EmptyState message="No databases yet. Provision one to get connection credentials." />
      ) : (
        <>
          {showFilters && (
            <div className="flex items-center gap-2">
              <span className="relative block min-w-0 flex-1">
                <Search
                  size={16}
                  strokeWidth={ICON_STROKE}
                  aria-hidden
                  className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-icon"
                />
                <Input
                  type="search"
                  placeholder="Search databases, users, projects"
                  aria-label="Search databases by name, user, project, or connection"
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape' && query !== '') {
                      event.preventDefault();
                      setQuery('');
                    }
                  }}
                  className="pl-10"
                />
              </span>

              {connections.length > 1 && (
                <div className="w-48 shrink-0">
                  <Select
                    aria-label="Filter by connection"
                    value={connectionKey}
                    onChange={(event) => {
                      setConnectionKey(event.target.value);
                    }}
                  >
                    <option value="all">All connections</option>
                    {connections.map((connection) => (
                      <option key={connection.key} value={connection.key}>
                        {connection.name}
                      </option>
                    ))}
                  </Select>
                </div>
              )}
            </div>
          )}

          {narrowed && (
            <p role="status" className="-mt-2 flex items-center gap-2 text-sm text-soft">
              {visible.length} of {databases.length}
              <button
                type="button"
                onClick={() => {
                  setQuery('');
                  setConnectionKey('all');
                }}
                className="rounded font-medium text-link transition-colors duration-150 ease-out hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
              >
                Clear
              </button>
            </p>
          )}

          {visible.length === 0 ? (
            <EmptyState
              title="No matching databases"
              message="Nothing here matches the current search and filter."
              action={{
                label: 'Clear filters',
                onClick: () => {
                  setQuery('');
                  setConnectionKey('all');
                },
              }}
            />
          ) : (
            <Card>
              <div className="divide-y divide-line">
                {visible.map((database) => (
                  <DatabaseRow key={database.id} database={database} baseDomain={baseDomain} />
                ))}
              </div>
            </Card>
          )}
        </>
      )}
    </>
  );
}

function CreateDatabaseForm({ onCreated, onCancel }: { onCreated: (created: DatabaseCreated) => void; onCancel: () => void }) {
  const queryClient = useQueryClient();
  const projectsQuery = useProjects();
  // Only connections that can actually take a database are listed — a host engine with no admin
  // credentials never appears (see /api/db-connections), so picking one can't turn into a 502.
  const connectionsQuery = useDbConnections();
  const connections = connectionsQuery.data ?? [];
  const [connectionKey, setConnectionKey] = useState('');
  const [name, setName] = useState('');
  const [projectId, setProjectId] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const connection = connections.find((row) => row.key === connectionKey) ?? null;

  // Selects the first connection once the list arrives, and re-selects if the chosen one is
  // unregistered in another tab. A form with no connection selected can't submit.
  useEffect(() => {
    if (connections.length > 0 && !connections.some((row) => row.key === connectionKey)) {
      setConnectionKey(connections[0]!.key);
    }
  }, [connections, connectionKey]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setNameError(null);
    setFormError(null);

    if (!NAME_RE.test(name)) {
      setNameError('Lowercase letters, digits, underscores; must start with a letter.');
      return;
    }
    if (connection === null) {
      setFormError('Pick a connection to create this database on.');
      return;
    }

    setSubmitting(true);
    try {
      const created = await createDatabase({
        connection: connection.key,
        name,
        ...(projectId !== '' ? { projectId: Number(projectId) } : {}),
      });
      await queryClient.invalidateQueries({ queryKey: ['databases'] });
      await queryClient.invalidateQueries({ queryKey: ['db-connections'] });
      onCreated(created);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setNameError(`A database with this name already exists on ${connection.name}.`);
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
        {connectionsQuery.isPending ? (
          <Skeleton className="h-11 w-full" />
        ) : connections.length === 0 ? (
          <p className="text-[13px] text-warn">
            No database server is configured on this host, and no external connection is registered — add one below first.
          </p>
        ) : (
          <Field label="Connection" hint={connection === null ? undefined : `${ENGINE_LABEL[connection.engine]} at ${connection.host}:${String(connection.port)}`}>
            <Select value={connectionKey} onChange={(event) => setConnectionKey(event.target.value)}>
              {connections.map((row) => (
                <option key={row.key} value={row.key}>
                  {row.name}
                </option>
              ))}
            </Select>
          </Field>
        )}

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
            {dbCapableProjects(projectsQuery.data).map((project) => (
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

function DatabaseRow({ database, baseDomain }: { database: DatabaseListItem; baseDomain: string | null }) {
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
          <div className="mt-0.5 truncate text-sm text-soft">
            {database.projectName ?? 'Not linked'}
            {' · '}
            {database.connectionName ?? `${database.host}:${String(database.port)}`}
          </div>
        </div>
        <span className="hidden shrink-0 text-sm text-soft sm:block">{formatRelativeTime(database.createdAt)}</span>
        <div className="flex shrink-0 items-center gap-2">
          {baseDomain && hasConsole(database) && (
            <a
              href={consoleUrl(baseDomain, database)}
              target="_blank"
              rel="noreferrer noopener"
              className={buttonClasses('secondary', 'sm')}
              title={consoleTitle(database.engine)}
            >
              Manage
              <ExternalLink size={14} strokeWidth={ICON_STROKE} aria-hidden />
            </a>
          )}
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
              host={database.host}
              port={database.port}
              connectionName={database.connectionName}
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
      await queryClient.invalidateQueries({ queryKey: ['db-connections'] });
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
  host,
  port,
  connectionName,
  oneTime,
}: {
  databaseId: number;
  engine: DbEngine;
  name: string;
  username: string;
  password: string;
  host: string;
  port: number;
  connectionName: string | null;
  oneTime: boolean;
}) {
  const projectsQuery = useProjects();
  const injectable = dbCapableProjects(projectsQuery.data);
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
        {connectionName && <span className="truncate text-sm text-soft">on {connectionName}</span>}
      </p>
      <div className="flex flex-col gap-2">
        <CopyRow label="Host" value={host} />
        <CopyRow label="Port" value={String(port)} />
        <CopyRow label="Username" value={username} />
        <CopyRow label="Password" value={password} />
      </div>

      {oneTime && <p className="mt-3 text-sm text-warn">Save these now. The password is shown once.</p>}

      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-4">
        <Select value={injectProjectId} onChange={(event) => setInjectProjectId(event.target.value)} className="w-56">
          <option value="">Add to project env…</option>
          {injectable.length === 0 ? (
            <option value="" disabled>
              No PHP or Node projects yet
            </option>
          ) : (
            injectable.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))
          )}
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


/**
 * The database servers Shipway can put a database on. The two engines running on this host are
 * always here and are not editable — their admin credentials came from `install.sh` and are not
 * something to re-type in a browser. Everything else is a connection someone registered: an RDS
 * instance, a managed Postgres, another box.
 *
 * Removing a connection only makes Shipway forget how to reach it; nothing on the remote server is
 * touched, and the API refuses while databases are still on it.
 */
function ConnectionsCard() {
  const connectionsQuery = useDbConnections();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<DbConnection | null>(null);

  const connections = connectionsQuery.data ?? [];

  return (
    <Card>
      <div className="flex items-start justify-between gap-4">
        <CardHeader
          icon={<Server size={20} strokeWidth={ICON_STROKE} />}
          title="Connections"
          description="Where databases can be created — this server's engines, plus any external server you register."
        />
        {!adding && editing === null && (
          <Button variant="secondary" size="sm" onClick={() => setAdding(true)}>
            <Plus size={16} strokeWidth={2} aria-hidden />
            Add connection
          </Button>
        )}
      </div>

      <div className="mt-4 flex flex-col gap-4">
        {(adding || editing !== null) && (
          <ConnectionForm
            existing={editing}
            onDone={() => {
              setAdding(false);
              setEditing(null);
            }}
          />
        )}

        {connectionsQuery.isPending ? (
          <Skeleton className="h-24 w-full rounded-xl" />
        ) : connectionsQuery.isError ? (
          <p role="alert" className="text-sm text-danger">
            Could not load connections.
          </p>
        ) : (
          <div className="divide-y divide-line">
            {connections.map((connection) => (
              <ConnectionRow key={connection.key} connection={connection} onEdit={() => setEditing(connection)} />
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}

function ConnectionRow({ connection, onEdit }: { connection: DbConnection; onEdit: () => void }) {
  const queryClient = useQueryClient();
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleRemove() {
    if (connection.id === null) return;
    setError(null);
    setRemoving(true);
    try {
      await deleteDbConnection(connection.id);
      await queryClient.invalidateQueries({ queryKey: ['db-connections'] });
    } catch (err) {
      // A 409 here is the "still has N databases on it" refusal, whose message is the whole point.
      setError(errorMessage(err, 'Could not remove the connection.'));
    } finally {
      setRemoving(false);
    }
  }

  return (
    <div className="flex flex-col gap-2 py-3">
      <div className="flex items-center gap-4">
        <Badge className="shrink-0">{ENGINE_LABEL[connection.engine]}</Badge>
        <div className="min-w-0 flex-1">
          <div className="truncate text-base font-semibold text-ink">{connection.name}</div>
          <div className="mt-0.5 truncate font-mono text-sm text-soft">
            {connection.host}:{connection.port}
            {connection.adminUsername !== null && ` · ${connection.adminUsername}`}
            {connection.tls && ' · TLS'}
          </div>
        </div>
        <span className="hidden shrink-0 text-sm text-soft sm:block">
          {connection.databaseCount} {connection.databaseCount === 1 ? 'database' : 'databases'}
        </span>
        <div className="flex shrink-0 items-center gap-2">
          {connection.kind === 'local' ? (
            <span className="text-sm text-soft" title="Configured by the Shipway installer on this host">
              This server
            </span>
          ) : (
            <>
              <Button variant="outline" size="sm" onClick={onEdit}>
                Edit
              </Button>
              <Button variant="danger" size="sm" loading={removing} onClick={() => void handleRemove()}>
                Remove
              </Button>
            </>
          )}
        </div>
      </div>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * Add/edit one external connection. The credentials are tried against the real server before
 * anything is stored — by the Test button on demand, and by the API itself on save — so a typo
 * surfaces here rather than as a failed deploy later.
 *
 * Editing never shows the stored password: leaving the field blank keeps it, which is also what
 * makes a rename or a host change a one-field edit.
 */
function ConnectionForm({ existing, onDone }: { existing: DbConnection | null; onDone: () => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(existing?.name ?? '');
  const [engine, setEngine] = useState<DbEngine>(existing?.engine ?? 'mysql');
  const [host, setHost] = useState(existing?.host ?? '');
  const [port, setPort] = useState(String(existing?.port ?? portFor(existing?.engine ?? 'mysql')));
  const [adminUsername, setAdminUsername] = useState(existing?.adminUsername ?? '');
  const [adminPassword, setAdminPassword] = useState('');
  const [tls, setTls] = useState(existing?.tls ?? false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; detail?: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The port follows the engine until it is edited away from that engine's default — so switching
  // engine on an untouched form does the obvious thing, and a deliberate 5433 is never overwritten.
  function handleEngineChange(next: DbEngine) {
    setEngine(next);
    setPort((current) => (current === String(portFor(engine)) ? String(portFor(next)) : current));
    setTestResult(null);
  }

  // On edit, the password field is empty and means "keep the stored one" — which the test endpoint
  // has no way to know, since it takes credentials rather than a connection id.
  const canTest = host.trim() !== '' && adminUsername.trim() !== '' && adminPassword !== '';
  const canSave = name.trim() !== '' && host.trim() !== '' && adminUsername.trim() !== '' && (existing !== null || adminPassword !== '');

  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await testDbConnection({ engine, host: host.trim(), port: Number(port), adminUsername: adminUsername.trim(), adminPassword, tls });
      setTestResult(result);
    } catch (err) {
      setTestResult({ ok: false, detail: errorMessage(err, 'Could not reach the server.') });
    } finally {
      setTesting(false);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSaving(true);
    try {
      if (existing?.id != null) {
        await updateDbConnection(existing.id, {
          name: name.trim(),
          host: host.trim(),
          port: Number(port),
          adminUsername: adminUsername.trim(),
          tls,
          ...(adminPassword !== '' ? { adminPassword } : {}),
        });
      } else {
        await createDbConnection({ name: name.trim(), engine, host: host.trim(), port: Number(port), adminUsername: adminUsername.trim(), adminPassword, tls });
      }
      await queryClient.invalidateQueries({ queryKey: ['db-connections'] });
      onDone();
    } catch (err) {
      // The API's 502 detail is the driver's own message ("password authentication failed",
      // "ENOTFOUND …") — far more useful than the status line, so it is what gets shown.
      const detail = err instanceof ApiError ? (err.body as { detail?: string } | undefined)?.detail : undefined;
      const base = errorMessage(err, 'Could not save the connection.');
      setError(detail ? `${base}: ${detail}` : base);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={(event) => void handleSubmit(event)} className="flex max-w-[560px] flex-col gap-4 rounded-xl bg-surface-2 p-4" noValidate>
      <Field label="Name" hint="How this server is shown when picking where a database goes.">
        <Input required autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="RDS production" />
      </Field>

      {existing === null ? (
        <Field label="Engine">
          <Select value={engine} onChange={(event) => handleEngineChange(event.target.value as DbEngine)}>
            {ENGINE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </Field>
      ) : (
        // Changing it would point the databases already on this connection at a server that has
        // never heard of them, so the API refuses it too.
        <p className="text-[13px] text-soft">
          Engine: {ENGINE_LABEL[engine]} — a connection&rsquo;s engine can&rsquo;t change. Register a second connection instead.
        </p>
      )}

      <div className="flex gap-3">
        <div className="flex-1">
          <Field label="Host" hint="Hostname or IP — no scheme, no path.">
            <Input mono required value={host} onChange={(event) => setHost(event.target.value)} placeholder="db.abc123.eu-west-1.rds.amazonaws.com" />
          </Field>
        </div>
        <div className="w-28">
          <Field label="Port">
            <Input mono required value={port} onChange={(event) => setPort(event.target.value)} inputMode="numeric" />
          </Field>
        </div>
      </div>

      <Field label="Admin user" hint="Needs to create databases and users/roles on that server.">
        <Input mono required value={adminUsername} onChange={(event) => setAdminUsername(event.target.value)} />
      </Field>

      <Field label="Admin password" hint={existing === null ? 'Stored encrypted; never shown again.' : 'Leave blank to keep the stored password.'}>
        <Input
          mono
          type="password"
          value={adminPassword}
          onChange={(event) => {
            setAdminPassword(event.target.value);
            setTestResult(null);
          }}
          autoComplete="new-password"
        />
      </Field>

      <label className="flex items-center gap-2 text-sm text-ink">
        <input
          type="checkbox"
          checked={tls}
          onChange={(event) => setTls(event.target.checked)}
          className="h-4 w-4 accent-[var(--primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        />
        Connect over TLS (required by most managed instances)
      </label>

      {testResult && (
        <p className={`text-sm ${testResult.ok ? 'text-ok' : 'text-danger'}`} role={testResult.ok ? undefined : 'alert'}>
          {testResult.ok ? 'Connected.' : (testResult.detail ?? 'Could not connect.')}
        </p>
      )}

      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}

      <div className="flex items-center gap-2">
        <Button type="submit" loading={saving} disabled={!canSave}>
          {existing === null ? 'Add connection' : 'Save changes'}
        </Button>
        <Button type="button" variant="secondary" loading={testing} disabled={!canTest} onClick={() => void handleTest()}>
          Test connection
        </Button>
        <Button type="button" variant="outline" onClick={onDone} disabled={saving}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/**
 * Redis and Mailpit connection info, read-only. Its own tab now, which means it has to account for
 * having nothing to show: stacked down the old page an absent panel simply wasn't there, but a tab
 * that renders nothing looks broken rather than empty.
 */
function ServicesInfoPanels() {
  const servicesQuery = useServicesInfo();

  if (servicesQuery.isPending) {
    return (
      <div className="grid gap-4 sm:grid-cols-2">
        <Skeleton className="h-48 w-full rounded-2xl" />
        <Skeleton className="h-48 w-full rounded-2xl" />
      </div>
    );
  }

  const redis = servicesQuery.data?.redis ?? null;
  const mailpit = servicesQuery.data?.mailpit ?? null;

  if (!redis && !mailpit) {
    return (
      <EmptyState
        title="No shared services"
        message="This host has neither Redis nor Mailpit configured, so there is no connection info to show."
      />
    );
  }

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
      <CardHeader icon={<RedisIcon size={20} />} title="Redis" description="Shared cache and queue broker." />
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
      <CardHeader icon={<MailpitIcon size={20} />} title="Mailpit" description="Local SMTP catch-all for outgoing mail." />
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
