import test from 'node:test'
import assert from 'node:assert/strict'
import {preflightAcceptance,validateToolArguments} from '../lib/acceptance-preflight.js'
import {createRegistry} from '../mcp/server.js'
const tools=createRegistry().tools
test('preflight rejects forward references and later static command regex errors',()=>{
 assert.throws(()=>preflightAcceptance({steps:[{name:'first',tool:'ensp_cli',args:{recover_from:'${steps.later.change_journal}'}},{name:'later',tool:'ensp_scenarios',args:{}}]},tools),/forward reference/u)
 assert.throws(()=>preflightAcceptance({steps:[{name:'first',tool:'ensp_cli',args:{port:2000,commands:['display version'],expect:['/[invalid/']}}]},tools),/regular expression/u)
 assert.throws(()=>preflightAcceptance({steps:[{name:'first',tool:'ensp_cli',args:{port:2000,commands:['display version'],recovery_guard:{}}}]},tools),/unknown property/u)
})
test('preflight permits self-recovery reference only in cleanup and validates expanded types',()=>{
 assert.doesNotThrow(()=>preflightAcceptance({steps:[{name:'change',tool:'ensp_cli',args:{port:2000,commands:['display version']},cleanup:{tool:'ensp_cli',args:{recover_from:'${steps.change.change_journal}'}}}]},tools))
 assert.throws(()=>preflightAcceptance({steps:[{name:'change',tool:'ensp_cli',args:{port:'${steps.change.port}',commands:['display version']}}]},tools),/forward reference/u)
 assert.doesNotThrow(()=>preflightAcceptance({steps:[{name:'inventory',tool:'ensp_cli',args:{list_changes:'changes'}}]},tools))
 assert.throws(()=>validateToolArguments({port:'2000'},tools.find(t=>t.name==='ensp_inspect').inputSchema),/integer/u)
})
