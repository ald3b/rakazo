import type { SecretStore } from "@rakazo/adapter-kit";
import { AgentSecretInputSchema } from "@rakazo/contracts";
import {
  DIGIT_SEPARATOR_UNIT,
  digitsRedactionPattern,
  redactionSpan,
  redactSecrets,
} from "@rakazo/core";

type EncryptedAgentSecret = {
  name: string;
  secret: { id: string; ciphertext: string };
};

export async function decryptAgentEnvironment(
  rows: EncryptedAgentSecret[],
  secrets: Pick<SecretStore, "load">,
): Promise<Record<string, string>> {
  return Object.fromEntries(
    await Promise.all(
      rows.map(async (row) => {
        AgentSecretInputSchema.shape.name.parse(row.name);
        return [row.name, await secrets.load(row.secret.ciphertext, row.secret.id)];
      }),
    ),
  );
}

export function formatAgentEnvironmentInstruction(
  environment: Record<string, string>,
): string | undefined {
  const names = Object.keys(environment).sort();
  if (names.length === 0) return undefined;
  return `Managed credentials are available to shell commands as these environment variables: ${names.join(", ")}. Use them without printing, logging, or embedding their values in files or messages.`;
}

export function redactShellStreams(
  snapshot: { stdout: string; stderr: string },
  secrets: string[],
  options?: { withholdPartial?: boolean },
): { stdout: string; stderr: string } {
  const values = secrets.filter((secret) => secret.length > 0);
  let stdout = redactSecrets(snapshot.stdout, values);
  let stderr = redactSecrets(snapshot.stderr, values);
  for (let pass = 0; pass < values.length; pass++) {
    let changed = false;
    for (const secret of values) {
      const next = redactSpanningSecret(stdout, stderr, secret);
      if (next.stdout !== stdout || next.stderr !== stderr) {
        stdout = next.stdout;
        stderr = next.stderr;
        changed = true;
      }
    }
    if (!changed) break;
  }
  if (!options?.withholdPartial) return { stdout, stderr };
  return withholdSecretPrefix(stdout, stderr, values);
}

export function redactAgentCommandResult(
  result: { stdout: string; stderr: string; code: number },
  secrets: string[],
) {
  return { ...result, ...redactShellStreams(result, secrets) };
}

function redactSpanningSecret(
  stdout: string,
  stderr: string,
  secret: string,
): { stdout: string; stderr: string } {
  const digits = digitsRedactionPattern(secret);
  if (digits) return redactSpanningDigits(stdout, stderr, secret, digits);
  if (secret.length < 2 || stdout.length === 0 || stderr.length === 0) return { stdout, stderr };
  const headLen = Math.min(secret.length - 1, stdout.length);
  const tailLen = Math.min(secret.length - 1, stderr.length);
  const head = stdout.slice(stdout.length - headLen);
  const boundary = head + stderr.slice(0, tailLen);
  const index = boundary.indexOf(secret);
  if (index < 0) return { stdout, stderr };
  const start = stdout.length - headLen + index;
  const end = start + secret.length;
  if (start >= stdout.length || end <= stdout.length) return { stdout, stderr };
  return {
    stdout: `${stdout.slice(0, start)}[redacted]`,
    stderr: stderr.slice(end - stdout.length),
  };
}

/** A number matched by its digits, cut by the boundary between the two streams. */
function redactSpanningDigits(
  stdout: string,
  stderr: string,
  secret: string,
  pattern: RegExp,
): { stdout: string; stderr: string } {
  const span = redactionSpan(secret);
  const head = stdout.slice(Math.max(0, stdout.length - span));
  const joined = head + stderr.slice(0, span);
  for (const match of joined.matchAll(pattern)) {
    const end = match.index + match[0].length;
    if (match.index >= head.length || end <= head.length) continue;
    return {
      stdout: `${stdout.slice(0, stdout.length - head.length + match.index)}[redacted]`,
      stderr: stderr.slice(end - head.length),
    };
  }
  return { stdout, stderr };
}

// A digits entry's start can be any digit, so a stream ending in digits and separators, some
// URL-encoded and the last perhaps cut short ("%E2%8"), may be the start of a number the next
// chunk completes. Separators are read one unambiguous unit at a time, so a long run of them
// before a letter fails in linear time.
const TRAILING_DIGITS = new RegExp(
  `\\p{N}(?:${DIGIT_SEPARATOR_UNIT}|\\p{N})*(?:%[0-9A-Fa-f])?$`,
  "u",
);
// The same from the start of a stream, which may begin inside an encoded separator ("80%91").
const LEADING_DIGITS = new RegExp(
  `^(?:[0-9A-Fa-f]{1,2}(?=%))?(?:${DIGIT_SEPARATOR_UNIT}|\\p{N})*`,
  "u",
);

function digitsTailLength(text: string, secret: string): number {
  const tail = TRAILING_DIGITS.exec(text.slice(Math.max(0, text.length - redactionSpan(secret))));
  return tail ? tail[0].length : 0;
}

/** Longest suffix of `text` that is a proper prefix of `secret`. */
function secretPrefixSuffixLength(text: string, secret: string): number {
  const max = Math.min(secret.length - 1, text.length);
  const regionStart = text.length - max;
  for (let index = regionStart; index < text.length; index++) {
    if (text.charCodeAt(index) !== secret.charCodeAt(0)) continue;
    const size = text.length - index;
    let matches = true;
    for (let offset = 1; offset < size; offset++) {
      if (text.charCodeAt(index + offset) !== secret.charCodeAt(offset)) {
        matches = false;
        break;
      }
    }
    if (matches) return size;
  }
  return 0;
}

/** How far `text` continues `secret` from `offset`, in UTF-16 code units. */
function secretContinuationLength(text: string, secret: string, offset: number): number {
  const limit = Math.min(text.length, secret.length - offset);
  let size = 0;
  while (size < limit && text.charCodeAt(size) === secret.charCodeAt(offset + size)) size += 1;
  return size;
}

function splitsSurrogatePair(text: string, index: number): boolean {
  if (index <= 0 || index >= text.length) return false;
  const before = text.charCodeAt(index - 1);
  const after = text.charCodeAt(index);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

function publishWithheld(text: string, holdStart: number, holdEnd: number): string {
  if (holdStart <= 0 && holdEnd <= 0) return text;
  let start = holdStart > 0 ? holdStart : 0;
  let end = holdEnd > 0 ? text.length - holdEnd : text.length;
  // Keep a surrogate pair out of the published view rather than splitting it.
  if (splitsSurrogatePair(text, start)) start += 1;
  if (splitsSurrogatePair(text, end)) end -= 1;
  if (end <= start) return "";
  return text.slice(start, end);
}

function withholdSecretPrefix(
  stdout: string,
  stderr: string,
  secrets: string[],
): { stdout: string; stderr: string } {
  let stdoutHold = 0;
  let stderrHoldEnd = 0;
  let stderrHoldStart = 0;
  for (const secret of secrets) {
    if (digitsRedactionPattern(secret)) {
      const stdoutTail = digitsTailLength(stdout, secret);
      stdoutHold = Math.max(stdoutHold, stdoutTail);
      stderrHoldEnd = Math.max(stderrHoldEnd, digitsTailLength(stderr, secret));
      // A number that ends stdout may go on at the start of stderr.
      if (stdoutTail > 0) {
        const start = LEADING_DIGITS.exec(stderr.slice(0, redactionSpan(secret)));
        stderrHoldStart = Math.max(stderrHoldStart, start ? start[0].length : 0);
      }
      continue;
    }
    if (secret.length < 2) continue;
    const stdoutPrefix = secretPrefixSuffixLength(stdout, secret);
    stdoutHold = Math.max(stdoutHold, stdoutPrefix);
    stderrHoldEnd = Math.max(stderrHoldEnd, secretPrefixSuffixLength(stderr, secret));
    // The live view joins the streams. A prefix that ends stdout and continues into
    // stderr is one secret fragment: holding only the stdout piece would publish the rest.
    if (stdoutPrefix > 0) {
      stderrHoldStart = Math.max(
        stderrHoldStart,
        secretContinuationLength(stderr, secret, stdoutPrefix),
      );
    }
  }
  return {
    stdout: publishWithheld(stdout, 0, stdoutHold),
    stderr: publishWithheld(stderr, stderrHoldStart, stderrHoldEnd),
  };
}
