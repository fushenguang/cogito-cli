import { describe, expect, it } from 'vitest'
import { parseSsListen } from '../serve.js'

// The #137 judgment: "something listens on :8080" was recorded as reachable
// while the listener was bound to 127.0.0.1 and the share URL said
// {"error":"share unavailable"} for an hour. These cases pin the
// classification so it cannot regress to "grep :8080".
describe('parseSsListen', () => {
  const header = 'State Recv-Q Send-Q Local Address:Port Peer Address:Port Process'

  it('classifies *:8080 as any (externally reachable)', () => {
    const probe = parseSsListen(`${header}\nLISTEN 0 511 *:8080 *:*`, 8080)
    expect(probe.listening).toBe(true)
    expect(probe.bindKind).toBe('any')
    expect(probe.pids).toEqual([])
  })

  it('classifies 0.0.0.0:8080 as any and extracts pid', () => {
    const probe = parseSsListen(
      `${header}\nLISTEN 0 511 0.0.0.0:8080 0.0.0.0:* users:(("node",pid=1234,fd=20))`,
      8080,
    )
    expect(probe.bindKind).toBe('any')
    expect(probe.pids).toEqual([1234])
  })

  it('🔴 classifies 127.0.0.1:8080 as loopback — the incident line', () => {
    const probe = parseSsListen(
      `${header}\nLISTEN 0 511 127.0.0.1:8080 0.0.0.0:* users:(("vite",pid=23785,fd=19))`,
      8080,
    )
    expect(probe.listening).toBe(true)
    expect(probe.bindKind).toBe('loopback')
    expect(probe.pids).toEqual([23785])
  })

  it('classifies [::]:8080 as any and ::1 as loopback', () => {
    expect(parseSsListen(`${header}\nLISTEN 0 511 [::]:8080 [::]:*`, 8080).bindKind).toBe('any')
    expect(parseSsListen(`${header}\nLISTEN 0 511 [::1]:8080 [::]:*`, 8080).bindKind).toBe('loopback')
  })

  it('ignores other ports even on the same line shape', () => {
    const probe = parseSsListen(`${header}\nLISTEN 0 511 0.0.0.0:3000 0.0.0.0:*`, 8080)
    expect(probe.listening).toBe(false)
    expect(probe.bindKind).toBeNull()
  })

  it('reports a specific NIC address as specific, not any', () => {
    const probe = parseSsListen(`${header}\nLISTEN 0 511 172.16.0.2:8080 0.0.0.0:*`, 8080)
    expect(probe.bindKind).toBe('specific')
  })
})
