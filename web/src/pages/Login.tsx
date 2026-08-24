import { type FormEvent, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError, login } from '../api';
import { Button, Field, Input } from '../components/ui';

export default function Login() {
  const queryClient = useQueryClient();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const me = await login({ email, password });
      queryClient.setQueryData(['me'], me);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 401) {
          setError('Wrong email or password.');
        } else if (err.status === 429) {
          setError('Too many attempts. Try again in a few minutes.');
        } else {
          setError(err.message);
        }
      } else {
        setError('Something went wrong. Try again.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-paper px-4">
      <div className="w-full max-w-[320px]">
        <p className="mb-8 text-center text-lg font-semibold text-ink">Shipway</p>

        <form onSubmit={(event) => void handleSubmit(event)} className="flex flex-col gap-4" noValidate>
          <Field label="Email">
            <Input
              type="email"
              name="email"
              autoComplete="email"
              required
              autoFocus
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </Field>
          <Field label="Password">
            <Input
              type="password"
              name="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </Field>

          {error && (
            <p role="alert" className="text-sm text-stop">
              {error}
            </p>
          )}

          <Button type="submit" loading={submitting} className="mt-2 w-full">
            Sign in
          </Button>
        </form>
      </div>
    </div>
  );
}
