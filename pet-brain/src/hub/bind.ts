import { isIPv4, isIPv6 } from "node:net";

const TAILSCALE_V6_PREFIX = "fd7a:115c:a1e0:";
const CGNAT_FIRST_OCTET = 100;
const CGNAT_SECOND_MIN = 64;
const CGNAT_SECOND_MAX = 127;
const LOOPBACK_FIRST_OCTET = 127;

function isPrivateChannel(host: string): boolean {
  const normalized = host.toLowerCase();
  if (normalized === "localhost" || normalized === "::1") return true;
  if (isIPv4(normalized)) {
    const [first = 0, second = 0] = normalized.split(".").map(Number);
    if (first === LOOPBACK_FIRST_OCTET) return true;
    return first === CGNAT_FIRST_OCTET && second >= CGNAT_SECOND_MIN && second <= CGNAT_SECOND_MAX;
  }
  return isIPv6(normalized) && normalized.startsWith(TAILSCALE_V6_PREFIX);
}

/** O hub só escuta em loopback ou num IP do Tailscale; qualquer outra interface exige opt-in explícito. */
export function assertBindHost(host: string, allowAny: boolean): void {
  if (allowAny || isPrivateChannel(host)) return;
  throw new Error(
    `PET_HUB_HOST="${host}" não é loopback nem IP do Tailscale (100.64.0.0/10). ` +
      "Use o IP de `tailscale ip -4`, ou defina PET_HUB_ALLOW_ANY_HOST=1 se souber o que está fazendo.",
  );
}
