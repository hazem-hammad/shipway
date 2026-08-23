/**
 * Project slugs: lowercase alphanumeric + hyphens, 1-40 chars, no leading/trailing hyphen. Copied
 * from `server/src/system/templates.ts`'s `SLUG_RE` — keep the two in sync if that ever changes.
 */
export const SLUG_RE = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/;

/**
 * Derives a slug candidate from a project name: lowercases, turns spaces/underscores into hyphens,
 * strips anything else invalid, collapses repeated hyphens, and trims leading/trailing hyphens.
 * Not guaranteed to satisfy {@link SLUG_RE} for every input (e.g. an all-symbol name yields `''`) —
 * always validate the result, since the field stays editable.
 */
export function slugify(name: string): string {
  const cleaned = name
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');

  return cleaned.slice(0, 40).replace(/-+$/g, '');
}
