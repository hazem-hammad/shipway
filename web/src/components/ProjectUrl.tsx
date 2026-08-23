/**
 * A project's live URL, rendered as `<slug>.<base_domain>` in a mono link (DESIGN.md: "slug.
 * intcore.dev link (mono)"). Falls back to just the slug (no link) while `base_domain` hasn't
 * loaded/been configured yet. Shared by the Projects table and the project detail header.
 */
export function ProjectUrl({ slug, baseDomain }: { slug: string; baseDomain: string | null }) {
  if (!baseDomain) {
    return <span className="font-mono text-xs text-ink-soft">{slug}</span>;
  }

  const host = `${slug}.${baseDomain}`;
  return (
    <a
      href={`https://${host}`}
      target="_blank"
      rel="noreferrer noopener"
      className="font-mono text-xs text-accent underline decoration-line underline-offset-2 hover:text-accent/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      {host}
    </a>
  );
}
