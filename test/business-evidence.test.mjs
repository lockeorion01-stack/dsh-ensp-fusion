import test from 'node:test'
import assert from 'node:assert/strict'
import {evaluateBusinessEvidence,evaluateStability,evaluateIsolation} from '../lib/business-evidence.js'
const flow={source:'10.77.0.10',target:'10.77.0.100',protocol:'http',port:80}
const observation={...flow,completed:true,reached:true}
function evidence(){return {flow,baseline:[observation],restored:[observation],restricted:[{...observation,reached:false,window:'test-1',control:{...observation,source:'10.77.0.11',window:'test-1'}}],denial:{...flow,windows:['test-1'],rule:'acl 3099 rule 5',before:0,after:1,evidence:'deny-counter.txt'}}}
test('restricted successful HTTP cannot pass even with accepted ACL and successful restoration',()=>{
 const e=evidence();e.restricted[0].reached=true
 assert.equal(evaluateIsolation(e).status,'FAIL')
 assert.equal(evaluateIsolation({flow,restricted:e.restricted}).status,'FAIL')
 assert.equal(evaluateIsolation({flow,configuration_ok:true}).status,'INCONCLUSIVE')
})
test('stopped service, unmatched control and bare timeout do not establish isolation',()=>{
 const e=evidence();e.restricted[0].control.reached=false;assert.equal(evaluateIsolation(e).status,'INCONCLUSIVE')
 const f=evidence();f.restricted[0].control.window='another-window';assert.equal(evaluateIsolation(f).status,'INCONCLUSIVE')
 const g=evidence();delete g.denial;assert.equal(evaluateIsolation(g).status,'INCONCLUSIVE')
 const h=evidence();h.denial.source='10.77.0.22';assert.equal(evaluateIsolation(h).status,'INCONCLUSIVE')
 const i=evidence();i.denial.windows=['old-test'];assert.equal(evaluateIsolation(i).status,'INCONCLUSIVE')
 assert.equal(evaluateIsolation(evidence()).status,'PASS')
})
test('stability preserves early failure, ignores claimed ok, and rejects inconsistent statistics',()=>{
 const good={completed:true,transmitted:5,received:5,loss_percent:0}
 const r=evaluateStability({samples:[{...good,received:4,loss_percent:20,ok:true},good]})
 assert.equal(r.status,'FAIL');assert.equal(r.received,9);assert.equal(r.failed_rounds,1)
 assert.equal(evaluateStability({samples:[{...good,received:0,loss_percent:0}]}).status,'INCONCLUSIVE')
 assert.equal(evaluateStability({samples:[{...good,loss_percent:0.01}]}).status,'INCONCLUSIVE')
 assert.equal(evaluateStability({samples:[good]}).status,'PASS')
 assert.throws(()=>evaluateBusinessEvidence({kind:'stability',samples:[good]}),/version/)
})

test('declared stability sample coverage cannot pass after dropping rounds or reducing packet count',()=>{
 const sample={completed:true,transmitted:5,received:5,loss_percent:0}
 assert.equal(evaluateStability({criteria:{rounds:3,packets_per_round:5},samples:[sample]}).status,'INCONCLUSIVE')
 assert.equal(evaluateStability({criteria:{rounds:1,packets_per_round:10},samples:[sample]}).coverage_complete,false)
 assert.equal(evaluateStability({criteria:{rounds:1,packets_per_round:5},samples:[sample]}).status,'PASS')
 assert.throws(()=>evaluateStability({criteria:{rounds:0},samples:[sample]}),/positive integer/)
})
