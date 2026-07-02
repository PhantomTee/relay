const SECRET_PATTERNS = [
  /xox[baprs]-[A-Za-z0-9-]+/g,
  /sk-[A-Za-z0-9_-]{16,}/g,
  /gsk_[A-Za-z0-9_-]{16,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /(?<![A-Za-z0-9])(?:api[_-]?key|token|secret|password|passwd|pwd)\s*[:=]\s*[^\s`'\"]+/gi,
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
]

export function redactSensitiveText(text) {
  let redacted = String(text ?? '')
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, '[redacted]')
  }
  return redacted
}
