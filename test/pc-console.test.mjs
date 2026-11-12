import test from 'node:test'
import assert from 'node:assert/strict'
import { runPcPing, discoverPcTerminal } from '../lib/pc-console.js'
const stats = (got,loss) => `ping 198.51.100.10\n\n  5 packet(s) transmitted\n  ${got} packet(s) received\n  ${loss}% packet loss\n\nPC>`

test('PC terminal discovery verifies page visibility and prompt instead of fixed tab order', async () => {
  let selected = -1
  const selectedIndices = []
  const result = await discoverPcTerminal({ hwnd: 1, query: async steps => ({ ok: true, steps: steps.map(step => {
    if (step.op === 'select_tab') { selected = step.index; selectedIndices.push(selected); return { ok: true, selected, confirmed: true, count: 5, dpi_scale: 1.5 } }
    if (step.op === 'children') return { ok: true, children: [{ hwnd: 2, cls: 'SysTabControl32', visible: true }, { hwnd: 3, cls: 'RichEdit20A', visible: selected === 1 }] }
    return { ok: true, texts: [{ hwnd: 3, txt: 'Welcome!\r\nPC>' }] }
  }) }) })
  assert.equal(result.index, 1)
  assert.equal(result.terminal, 3)
  assert.deepEqual(selectedIndices, [0, 1])
})

test('PC terminal discovery stops on failed selection before using stale hidden console', async () => {
  await assert.rejects(discoverPcTerminal({ hwnd: 1, query: async steps => ({ ok: true, steps: steps.map(step => step.op === 'children'
    ? { ok: true, children: [{ hwnd: 2, cls: 'SysTabControl32', visible: true }] }
    : { ok: true, selected: 0, confirmed: false, count: 5 }) }) }), /not confirmed/)
})
test('PC poll ignores old success and waits for complete current timeout statistics', async () => {
  const before=`PC>${stats(5,0)}`
  const outputs=[before,before+'ping 198.51.100.10\nRequest timeout!',before+stats(0,100)]
  const sent=[];let time=0
  const r=await runPcPing({address:'198.51.100.10',read:async()=>outputs.shift(),send:async s=>sent.push(s),now:()=>time,sleep:async ms=>{time+=ms}})
  assert.equal(r.completed,true);assert.equal(r.ok,false);assert.equal(r.loss_percent,100)
  assert.deepEqual(sent,['ping 198.51.100.10\r'])
})
test('busy PC never receives a new command', async () => {
  await assert.rejects(runPcPing({address:'198.51.100.10',read:async()=> 'PC>ping 198.51.100.10\nRequest timeout!',send:()=>assert.fail('must not send')}),/busy/u)
})
test('PC partial result times out without asserting packet loss or connectivity', async () => {
  let time=0,reads=0
  const r=await runPcPing({address:'198.51.100.10',read:async()=>reads++?'PC>ping 198.51.100.10\nRequest timeout!':'PC>',send:async()=>{},timeoutMs:100,intervalMs:10,now:()=>time,sleep:async ms=>{time+=ms}})
  assert.equal(r.completed,false);assert.equal(r.loss_percent,undefined)
})

test('PC parser rejects nonzero loss with complete receive count instead of rounding it into success',async()=>{
 let read=0
 await assert.rejects(runPcPing({address:'198.51.100.10',read:async()=>read++?'PC>'+stats(5,0.01):'PC>',send:async()=>{}}),/inconsistent/)
})
