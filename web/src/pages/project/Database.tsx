/**
 * Database tab: the databases provisioned for this project, with their connection details and the
 * password on deliberate reveal (PRODUCT.md — secrets are never displayed by accident). Reads the
 * same `GET /api/databases` list the Databases page uses, filtered to this project, so visiting
 * both pages costs one request; only the password needs the extra `/:id/credentials` round trip.
 *
 * Read-only on purpose: creating, dropping, and re-linking a database all live on the Databases
 * page, which is where the blast radius and the typed confirmations belong.
 */
import { useState } from 'react';
import { Database as DatabaseIcon, ExternalLink } from 'lucide-react';
import { ApiError, fetchDatabaseCredentials, type DatabaseListItem } from '../../api';
import { useDatabases, useSettings } from '../../hooks';
import { Badge, Button, buttonClasses, Card, CardHeader, CopyRow, EmptyState, ICON_STROKE, Skeleton } from '../../components/ui';
import { ENGINE_LABEL, consoleTitle, consoleUrl, hasConsole } from '../../lib/database';

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

export default function DatabaseTab({ projectId }: { projectId: number }) {
  const databasesQuery = useDatabases();
  // Only used to build the database-console URL; the Manage link is simply omitted until it loads,
  // rather than rendering a link to `ship.undefined`.
  const settingsQuery = useSettings();
  const baseDomain = settingsQuery.data?.base_domain ?? null;

  if (databasesQuery.isPending) {
    return <Skeleton className="h-72 w-full rounded-2xl" />;
  }
  if (databasesQuery.isError) {
    return (
      <p role="alert" className="text-sm text-danger">
        Could not load this project&rsquo;s databases.
      </p>
    );
  }

  const linked = databasesQuery.data.filter((database) => database.projectId === projectId);

  if (linked.length === 0) {
    return (
      <EmptyState
        icon={<DatabaseIcon size={28} strokeWidth={ICON_STROKE} aria-hidden />}
        title="No database linked"
        message="Create one on the Databases page and link it to this project, or add an existing database to this project's environment — either way it shows up here with its credentials."
        action={{ label: 'Databases', href: '~/databases' }}
      />
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {linked.map((database) => (
        <DatabaseCard key={database.id} database={database} baseDomain={baseDomain} />
      ))}
    </div>
  );
}

function DatabaseCard({ database, baseDomain }: { database: DatabaseListItem; baseDomain: string | null }) {
  const [credentials, setCredentials] = useState<{ password: string; env: Record<string, string> } | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleReveal() {
    if (revealed) {
      setRevealed(false);
      return;
    }
    setRevealed(true);
    if (credentials) return;
    setLoading(true);
    setError(null);
    try {
      const creds = await fetchDatabaseCredentials(database.id);
      setCredentials({ password: creds.password, env: creds.env });
    } catch (err) {
      setError(errorMessage(err, 'Could not load the password.'));
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card>
      <CardHeader
        icon={<DatabaseIcon size={20} strokeWidth={ICON_STROKE} />}
        title={database.name}
        description={`${ENGINE_LABEL[database.engine]} on ${database.connectionName ?? `${database.host}:${String(database.port)}`}`}
        action={
          baseDomain && hasConsole(database) ? (
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
          ) : undefined
        }
      />

      <div className="mt-5 rounded-xl bg-surface-2 p-4">
        <div className="flex flex-col gap-2">
          <CopyRow label="Host" value={database.host} />
          <CopyRow label="Port" value={String(database.port)} />
          <CopyRow label="Database" value={database.name} />
          <CopyRow label="Username" value={database.username} />
          {revealed && credentials && <CopyRow label="Password" value={credentials.password} />}
          {revealed && loading && <Skeleton className="h-14 w-full rounded-lg" />}
        </div>

        {revealed && error && (
          <p role="alert" className="mt-3 text-sm text-danger">
            {error}
          </p>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-4">
          <Button variant="outline" size="sm" onClick={() => void handleReveal()}>
            {revealed ? 'Hide password' : 'Reveal password'}
          </Button>
          {credentials && <CopyEnvButton env={credentials.env} />}
          {!database.connectionName && (
            <Badge tone="danger">Connection missing — host and port are this server&rsquo;s defaults</Badge>
          )}
        </div>
      </div>
    </Card>
  );
}

/**
 * Copies the whole `DB_*` block (the same keys `POST /api/databases/:id/inject` writes) so it can
 * be pasted straight into the Environment tab, rather than copying five values one at a time.
 */
function CopyEnvButton({ env }: { env: Record<string, string> }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    const text = Object.entries(env)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');
    try {
      await navigator.clipboard.writeText(`${text}\n`);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API unavailable or denied — every value is still visible above.
    }
  }

  return (
    <Button variant="secondary" size="sm" onClick={() => void handleCopy()}>
      {copied ? 'Copied' : 'Copy .env block'}
    </Button>
  );
}
