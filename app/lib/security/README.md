# Security (Section 19)

Implemented in C6: origin checks, per-IP rate limits (memory-cache), honeypot

- min fill time, reCAPTCHA v3 verification, sanitize-html filters, CSRF tokens
  on session endpoints. Generated content stays isolated from app internals by
  convention + error capture (trust boundary documented in Section 19).
