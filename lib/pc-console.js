import { isIP } from 'node:net'

// Discover the command page from its visible terminal and prompt, rather than
// relying on tab order (which differs between eNSP builds).
export async function discoverPcTerminal({ hwnd, query }) {
  const run = async steps => {
    const result = await query(steps)
    if (!result?.ok || result.steps?.some(step => step.ok === false)) throw new Error('PC control discovery operation failed')
    return result.steps
  }
  const tree = (await run([{ op: 'children', hwnd, depth: 3 }]))[0].children ?? []
  const tabs = tree.filter(item => item.cls === 'SysTabControl32' && item.visible)
  if (tabs.length !== 1) throw new Error('PC tab control must resolve uniquely')
  const tab = tabs[0].hwnd
  let count = 1
  for (let index = 0; index < count; index++) {
    const selected = (await run([{ op: 'select_tab', hwnd: tab, index }]))[0]
    if (!selected.confirmed || selected.selected !== index || !Number.isInteger(selected.count) || selected.count < 1 || selected.count > 16) throw new Error('PC tab selection was not confirmed')
    count = selected.count
    const steps = await run([{ op: 'children', hwnd, depth: 3 }, { op: 'texts', hwnd, depth: 3, only: 'RichEdit20A' }])
    const visible = new Set((steps[0].children ?? []).filter(item => item.cls === 'RichEdit20A' && item.visible).map(item => item.hwnd))
    const terminals = (steps[1].texts ?? []).filter(item => visible.has(item.hwnd) && /(?:^|\n)PC>\s*$/u.test(item.txt.replace(/\r\n?/gu, '\n')))
    if (terminals.length > 1) throw new Error('PC command terminal is ambiguous')
    if (terminals.length === 1) return { hwnd, tab, index, terminal: terminals[0].hwnd, dpi_scale: selected.dpi_scale }
  }
  throw new Error('No visible idle PC command terminal found')
}

// Read a fresh, complete PC simulator result. Never reuse an earlier success
// from its cumulative RichEdit buffer, or submit a command while ping is busy.
export async function runPcPing({ address, read, send, timeoutMs = 45000, intervalMs = 300,
  now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  if (isIP(address) !== 4 || typeof read !== 'function' || typeof send !== 'function') throw new TypeError('IPv4 address, read and send callbacks required')
  if (![timeoutMs, intervalMs].every(n => Number.isInteger(n) && n > 0)) throw new TypeError('positive integer timing required')
  const clean = text => {
    if (typeof text !== 'string') throw new TypeError('PC read must return a string')
    return text.replace(/\r\n?/gu, '\n')
  }
  const before = clean(await read())
  if (!/PC>\s*$/u.test(before)) throw new Error('PC console is busy; command was not sent')
  const command = `ping ${address}`
  await send(`${command}\r`)
  const started = now()
  let transcript = ''
  while (now() - started < timeoutMs) {
    const text = clean(await read())
    if (now() - started >= timeoutMs) break
    if (!text.startsWith(before)) throw new Error('PC output changed or rolled over; fresh result cannot be established')
    transcript = text.slice(before.length).trimStart()
    if (transcript.startsWith(`${command}\n`) && /PC>\s*$/u.test(transcript)) {
      const transmitted = /(?:^|\n)\s*(\d+) packet\(s\) transmitted\s*(?:\n|$)/u.exec(transcript)
      const received = /(?:^|\n)\s*(\d+) packet\(s\) received\s*(?:\n|$)/u.exec(transcript)
      const loss = /(?:^|\n)\s*(\d+(?:\.\d+)?)% packet loss\s*(?:\n|$)/u.exec(transcript)
      if (transmitted && received && loss) {
        const sent = Number(transmitted[1]), got = Number(received[1]), percent = Number(loss[1])
        if (!Number.isSafeInteger(sent) || !Number.isSafeInteger(got) || sent <= 0 || got > sent || percent > 100 || (got===sent&&percent!==0) || Math.abs(percent - 100 * (sent-got)/sent) > 0.011) throw new Error('PC ping statistics are inconsistent')
        return { completed: true, ok: got === sent && percent === 0, transmitted: sent, received: got, loss_percent: percent, transcript }
      }
    }
    const remaining = timeoutMs - (now() - started)
    if (remaining > 0) await sleep(Math.min(intervalMs, remaining))
  }
  return { completed: false, ok: false, error: 'PC ping result deadline exceeded', transcript }
}
