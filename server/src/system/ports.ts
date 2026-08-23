export function allocatePort(used: number[]): number {
  const usedSet = new Set(used);
  const min = 3001;
  const max = 3999;

  for (let port = min; port <= max; port++) {
    if (!usedSet.has(port)) {
      return port;
    }
  }

  throw new Error('All ports in range 3001-3999 are in use');
}
