/**
 * Where a project answers on the network.
 *
 * A project has two names that look alike and mean different things. `slug` is its INTERNAL
 * identity — `apps/<slug>`, `logs/<slug>`, `shipway-app-<slug>.service`, `shipway-<slug>.conf`, its
 * htpasswd file, its worker units — and never changes once created. `subdomain` is the host label it
 * is SERVED at, and can be moved (see `changeProjectSubdomain` in `services/provisioner.ts`). For
 * every project that has never been moved — which is every project created before the column
 * existed — `subdomain` is `NULL` and the two are the same string.
 *
 * These two helpers are the only place that fallback is written down. Anything that needs a
 * project's address (the DNS `A` record, the nginx `server_name`, the health-check URL, the links in
 * the dashboard) goes through them rather than interpolating `slug` itself, so a moved project is
 * addressed consistently everywhere instead of correctly in the places someone remembered to update.
 *
 * Imported by the web app as well as the server (see `web/src/pages/project/Settings.tsx`), so it
 * deliberately depends on nothing but its argument — no db handle, no settings lookup.
 */

/** The shape both helpers need: any project row, or any object carrying those two fields. */
export interface HostedProject {
  slug: string;
  subdomain?: string | null;
}

/**
 * The host label this project is served at: its `subdomain` when one is set, otherwise its `slug`.
 * A blank/whitespace-only `subdomain` is treated as unset — the API never stores one, but a
 * hand-edited database row should degrade to the slug rather than to `.<base-domain>`.
 */
export function projectHost(project: HostedProject): string {
  const subdomain = project.subdomain?.trim();
  return subdomain ? subdomain : project.slug;
}

/** The project's full domain, `<host>.<baseDomain>`. */
export function projectDomain(project: HostedProject, baseDomain: string): string {
  return `${projectHost(project)}.${baseDomain}`;
}
