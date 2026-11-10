const MAX_FAILURES = 5;
const LOCK_MS = 60_000;

export interface Lockout {
  isLocked(address: string): boolean;
  fail(address: string): void;
  succeed(address: string): void;
}

/** Trava um endereço depois de várias tentativas erradas. Falhas antigas expiram, então o mapa não cresce sem fim. */
export function createLockout(now: () => number): Lockout {
  const failures = new Map<string, { count: number; expiresAt: number }>();

  const prune = (): void => {
    const current = now();
    failures.forEach((entry, address) => {
      if (current >= entry.expiresAt) failures.delete(address);
    });
  };

  return {
    isLocked: (address) => {
      prune();
      return (failures.get(address)?.count ?? 0) >= MAX_FAILURES;
    },
    fail: (address) => {
      prune();
      failures.set(address, { count: (failures.get(address)?.count ?? 0) + 1, expiresAt: now() + LOCK_MS });
    },
    succeed: (address) => void failures.delete(address),
  };
}
