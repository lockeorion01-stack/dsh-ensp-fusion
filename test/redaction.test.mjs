import test from 'node:test'
import assert from 'node:assert/strict'
import { createRedactor, redactValue, scrubSensitiveText } from '../lib/redaction.js'

test('single-pass credential redaction handles overlapping secrets without corrupting markers', () => {
  const redact = createRedactor(['a', 'abc', 'quote"pass'], { configuration: false })
  assert.equal(redact('abc a quote"pass'), '[REDACTED] [REDACTED] [REDACTED]')
  assert.equal(redact('quote\\"pass'), '[REDACTED]')
})

test('configuration, authenticated URLs and headers redact values across nested artifacts', () => {
  const source = 'local-user admin password irreversible-cipher very-secret\nsnmp-agent community read lab-secret\npre-shared-key cipher vpn-secret\nAuthorization: Bearer hidden-token\nftp://admin:ftp-secret@192.0.2.1/file'
  const result = redactValue({ results: [{ output: source }], password: 'another-secret' })
  assert.doesNotMatch(JSON.stringify(result), /very-secret|lab-secret|vpn-secret|hidden-token|ftp-secret|another-secret/)
  assert.match(scrubSensitiveText('display current-configuration'), /display current-configuration/)
})
