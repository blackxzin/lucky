/** Padrões óbvios de segredo. É uma rede de segurança, não um detector completo. */
const SECRET_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "chave de API (sk-...)", pattern: /\bsk-[A-Za-z0-9_-]{20,}/ },
  { label: "token do GitHub", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/ },
  { label: "chave privada", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { label: "chave de acesso da AWS", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: "token do Slack", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { label: "JWT", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  {
    label: "senha ou token em texto",
    pattern: /\b(?:password|passwd|senha|secret|token|api[_-]?key)\s*[:=]\s*\S{8,}/i,
  },
];

/** Devolve o tipo de segredo encontrado, ou `undefined` se o texto parece limpo. */
export function findSecret(text: string): string | undefined {
  return SECRET_PATTERNS.find(({ pattern }) => pattern.test(text))?.label;
}
