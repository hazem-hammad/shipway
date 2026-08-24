/**
 * Public invite-accept page (route `/invite/:token`) — must render for a visitor with no session at
 * all, so it's wired into App.tsx's `AuthenticatedGate` right next to `/login`, not behind the
 * authenticated `<Layout>` switch. Mirrors Login's centered-card layout.
 *
 * `GET /api/invite/:token` decides which of two states renders: an invalid/expired/already-used
 * token gets one calm dead-end message (the server's `{email: '', valid: false}` response
 * deliberately doesn't distinguish "unknown" from "expired" from "already used" — this page doesn't
 * either); a valid one shows the read-only invited email plus name/password fields. Accepting logs
 * the new user in immediately (the server sets the session cookie on `POST /api/invite/:token`) —
 * this page just caches that response as the shared `['me']` query (exactly like Login/SetupWizard
 * do) and navigates to '/', which is enough for `AuthenticatedGate` to swap into the real app.
 */
import { type FormEvent, useState } from 'react';
import { Link, useLocation, useParams } from 'wouter';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError, acceptInvite } from '../api';
import { useInvitePreview } from '../hooks';
import { Button, Field, Input, Skeleton } from '../components/ui';

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

export default function InviteAccept() {
  const { token = '' } = useParams<{ token: string }>();
  const previewQuery = useInvitePreview(token);

  return (
    <div className="flex min-h-screen items-center justify-center bg-page px-4">
      <div className="w-full max-w-[400px]">
        <div className="mb-8 flex flex-col items-center gap-3">
          <span className="flex items-center gap-2.5">
            <img src="/logo.png" alt="" className="h-7 w-7" aria-hidden />
            <span className="text-2xl font-semibold text-ink">Shipway</span>
          </span>
          <p className="text-lg text-soft">Join Shipway</p>
        </div>

        <div className="rounded-2xl border border-line bg-surface p-8">
          {previewQuery.isPending ? (
            <div className="flex flex-col gap-4">
              <Skeleton className="h-11 w-full" />
              <Skeleton className="h-11 w-full" />
              <Skeleton className="h-11 w-full" />
            </div>
          ) : previewQuery.isError || !previewQuery.data || !previewQuery.data.valid ? (
            <InvalidInvite />
          ) : (
            <AcceptForm token={token} email={previewQuery.data.email} />
          )}
        </div>
      </div>
    </div>
  );
}

function InvalidInvite() {
  return (
    <div className="flex flex-col items-center gap-4 text-center">
      <p className="text-base text-soft">This invite link is invalid or has expired.</p>
      <Link href="/login" className="text-sm font-medium text-link hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
        Go to sign in
      </Link>
    </div>
  );
}

function AcceptForm({ token, email }: { token: string; email: string }) {
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const me = await acceptInvite(token, { name, password });
      queryClient.setQueryData(['me'], me);
      navigate('/');
    } catch (err) {
      setError(errorMessage(err, 'Could not create your account. Try again.'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={(event) => void handleSubmit(event)} className="flex flex-col gap-5" noValidate>
      <Field label="Email">
        <Input type="email" value={email} disabled />
      </Field>
      <Field label="Name">
        <Input required autoFocus value={name} onChange={(event) => setName(event.target.value)} />
      </Field>
      <Field label="Password" hint="At least 8 characters.">
        <Input type="password" autoComplete="new-password" required minLength={8} value={password} onChange={(event) => setPassword(event.target.value)} />
      </Field>

      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}

      <Button type="submit" loading={submitting} className="mt-1 w-full">
        Create account
      </Button>
    </form>
  );
}
