import { describe, expect, it } from 'vitest';
import { projectDomain, projectHost } from '../src/lib/domain.js';

describe('projectHost', () => {
  it('falls back to the slug when no subdomain is set — the state every project starts in', () => {
    expect(projectHost({ slug: 'shop', subdomain: null })).toBe('shop');
    expect(projectHost({ slug: 'shop' })).toBe('shop');
  });

  it('uses the subdomain once the project has been moved', () => {
    expect(projectHost({ slug: 'shop', subdomain: 'store' })).toBe('store');
  });

  it('treats a blank or whitespace-only subdomain as unset, rather than serving ".<base-domain>"', () => {
    expect(projectHost({ slug: 'shop', subdomain: '' })).toBe('shop');
    expect(projectHost({ slug: 'shop', subdomain: '   ' })).toBe('shop');
  });

  it('trims a stored subdomain', () => {
    expect(projectHost({ slug: 'shop', subdomain: ' store ' })).toBe('store');
  });
});

describe('projectDomain', () => {
  it('joins the host to the base domain', () => {
    expect(projectDomain({ slug: 'shop', subdomain: null }, 'apps.example.com')).toBe('shop.apps.example.com');
    expect(projectDomain({ slug: 'shop', subdomain: 'store' }, 'apps.example.com')).toBe('store.apps.example.com');
  });
});
