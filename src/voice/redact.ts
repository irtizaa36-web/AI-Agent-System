import { inspect } from "node:util";

/**
 * Code-like tokens: 4–8 digit runs (optionally split once by a space or
 * dash, as in "123 456") and prefixed forms such as "G-123456".
 * Longer digit runs (a phone number without punctuation, an order number)
 * are left alone, which is why the lookarounds reject adjacent digits.
 */
const CODE_TOKEN = /(?<![\d])(?:[A-Z]{1,3}-)?\d{3,4}[ -]?\d{1,4}(?![\d])/g;

function isCodeShaped(token: string): boolean {
  const digits = token.replace(/\D/g, "");
  return digits.length >= 4 && digits.length <= 8;
}

/** Replaces every code-shaped token with "[code]". Used on every piece of text this module stores or prints. */
export function redactCodes(text: string): string {
  return text.replace(CODE_TOKEN, (token) => (isCodeShaped(token) ? "[code]" : token));
}

/**
 * A verification code value. It prints as "[redacted]" through toString,
 * JSON.stringify, template literals and console.log, so it can't reach a
 * log or a state file by accident. `reveal()` is the one way to read it,
 * and the only caller is the CLI line that hands it to the flow that asked
 * for it.
 */
export class SecretCode {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }
  reveal(): string {
    return this.#value;
  }
  toString(): string {
    return "[redacted]";
  }
  toJSON(): string {
    return "[redacted]";
  }
  [inspect.custom](): string {
    return "SecretCode([redacted])";
  }
}
