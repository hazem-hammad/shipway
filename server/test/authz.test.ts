import { describe, expect, it } from 'vitest';
import { roleAtLeast, type Role } from '../src/lib/authz.js';

describe('roleAtLeast', () => {
  const ROLES: Role[] = ['member', 'admin', 'owner'];

  it('member does not satisfy admin or owner, but satisfies member', () => {
    expect(roleAtLeast('member', 'member')).toBe(true);
    expect(roleAtLeast('member', 'admin')).toBe(false);
    expect(roleAtLeast('member', 'owner')).toBe(false);
  });

  it('admin satisfies member and admin, but not owner', () => {
    expect(roleAtLeast('admin', 'member')).toBe(true);
    expect(roleAtLeast('admin', 'admin')).toBe(true);
    expect(roleAtLeast('admin', 'owner')).toBe(false);
  });

  it('owner satisfies every level', () => {
    for (const min of ROLES) {
      expect(roleAtLeast('owner', min)).toBe(true);
    }
  });
});
