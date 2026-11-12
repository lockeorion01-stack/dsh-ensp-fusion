import test from 'node:test'
import assert from 'node:assert/strict'
import {parseUsgResources,evaluateUsgHealth} from '../lib/usg-health.js'
const sample={cpu:'CPU Usage : 19.8% Max: 44.0%\nCPU utilization for ten seconds: 19.8%',memory:'System Total Memory Is: 241172480 bytes\nMemory Using Percentage Is: 63%\nDevice Total Memory Is: 806563840 bytes\nMemory Using Percentage Is: 70%\nDynamic Memory Using Percentage Is: 76%',sessions:'Current Total Sessions : 0'}
const limits={min_samples:2,cpu_percent:85,management_memory_percent:90,device_memory_percent:90,dynamic_memory_percent:90}
test('USG resource parsing distinguishes memory planes and zero sessions',()=>{
 const r=parseUsgResources(sample)
 assert.equal(r.complete,true);assert.equal(r.cpu_percent,19.8);assert.equal(r.cpu_historical_max_percent,44)
 assert.equal(r.management_memory_percent,63);assert.equal(r.device_memory_percent,70);assert.equal(r.dynamic_memory_percent,76);assert.equal(r.sessions,0)
 assert.equal(parseUsgResources({cpu:'CPU Usage : 0%'}).complete,false)
})
test('USG health requires coverage and keeps resource pass separate from capacity acceptance',()=>{
 assert.equal(evaluateUsgHealth({samples:[sample],limits}).status,'INCONCLUSIVE')
 const r=evaluateUsgHealth({samples:[sample,sample],limits});assert.equal(r.status,'PASS');assert.equal(r.performance_accepted,false)
 assert.equal(evaluateUsgHealth({samples:[sample,{...sample,cpu:'CPU Usage : 99%'}],limits}).status,'FAIL')
 assert.equal(evaluateUsgHealth({samples:[sample,{...sample,memory:''}],limits}).status,'INCONCLUSIVE')
})
