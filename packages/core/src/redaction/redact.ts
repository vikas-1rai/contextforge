/**
 * Light-weight secret scrubbing for captured prompts.
 *
 * Prompts are captured verbatim from developer conversations and may accidentally
 * contain passwords, API keys, tokens, or private keys. This module masks the most
 * common secret shapes BEFORE a prompt is stored or embedded, so secrets never
 * persist in plaintext locally or reach the centralized store.
 *
 * This is intentionally "light": it targets well-known, high-confidence patterns to
 * minimize false positives. It is not a substitute for proper secret management.
 */

const REDACTED = '[REDACTED]';

interface RedactionRule {
  name: string;
  pattern: RegExp;
  replacement: string | ((...args: string[]) => string);
}

/**
 * Ordered redaction rules. High-confidence, structural patterns run first.
 * All patterns use the global flag so every occurrence is masked.
 */
const RULES: RedactionRule[] = [
  // PEM private key blocks (RSA/EC/OPENSSH/etc.)
  {
    name: 'private-key',
    pattern: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g,
    replacement: '[REDACTED_PRIVATE_KEY]',
  },

  // Credentials embedded in connection strings/URLs: scheme://user:pass@host
  {
    name: 'url-credentials',
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):([^\s:/@]+)@/gi,
    replacement: (_m: string, prefix: string) => `${prefix}:${REDACTED}@`,
  },

  // key: value / key = value where the key name implies a secret.
  // Handles optional quotes around both the key (JSON style) and the value.
  {
    name: 'secret-assignment',
    pattern:
      /\b(password|passwd|pwd|secret|secret[_-]?key|client[_-]?secret|api[_-]?key|apikey|access[_-]?key|access[_-]?token|auth[_-]?token|token)\b(["']?\s*[:=]\s*)(["']?)([^\s"',;}]+)\3/gi,
    replacement: (_m: string, key: string, sep: string, quote: string) =>
      `${key}${sep}${quote}${REDACTED}${quote}`,
  },

  // Authorization: Bearer <token>
  {
    name: 'bearer-token',
    pattern: /\b(Bearer)\s+[A-Za-z0-9._~+/-]{10,}=*/gi,
    replacement: (_m: string, scheme: string) => `${scheme} ${REDACTED}`,
  },

  // JSON Web Tokens (header.payload.signature)
  {
    name: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
    replacement: '[REDACTED_JWT]',
  },

  // Provider-specific token prefixes (high confidence).
  { name: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, replacement: '[REDACTED_TOKEN]' },
  { name: 'openai-key', pattern: /\bsk-[A-Za-z0-9]{20,}\b/g, replacement: '[REDACTED_TOKEN]' },
  { name: 'aws-access-key-id', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, replacement: '[REDACTED_TOKEN]' },
  { name: 'slack-token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, replacement: '[REDACTED_TOKEN]' },
  { name: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g, replacement: '[REDACTED_TOKEN]' },
];

/**
 * Mask common secrets in a block of text. Returns the scrubbed text.
 * Returns the input unchanged when it is empty.
 */
export function redactSecrets(text: string): string {
  if (!text) return text;
  let out = text;
  for (const rule of RULES) {
    out = out.replace(rule.pattern, rule.replacement as never);
  }
  return out;
}

/**
 * Returns true if the text contains anything the scrubber would mask.
 * Useful for logging/metrics without exposing the secret.
 */
export function containsSecret(text: string): boolean {
  if (!text) return false;
  return redactSecrets(text) !== text;
}
