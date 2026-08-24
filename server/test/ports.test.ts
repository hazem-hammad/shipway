import { describe, expect, it } from 'vitest';
import { allocatePort } from '../src/system/ports.js';

describe('allocatePort', () => {
  it('returns 3001 when no ports are used', () => {
    expect(allocatePort([])).toBe(3001);
  });

  it('returns the lowest free port when some are used', () => {
    expect(allocatePort([3001, 3002])).toBe(3003);
  });

  it('fills gaps in used ports', () => {
    expect(allocatePort([3001, 3003])).toBe(3002);
  });

  it('throws an error when all ports in range are used', () => {
    const allPorts = Array.from({ length: 999 }, (_, i) => 3001 + i);
    expect(() => allocatePort(allPorts)).toThrow();
  });
});
