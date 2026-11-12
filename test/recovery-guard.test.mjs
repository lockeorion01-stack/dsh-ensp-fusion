import test from 'node:test'
import assert from 'node:assert/strict'
import { makeRecoveryGuard, verifyRecoveryGuard } from '../lib/recovery-guard.js'
const config='sysname R1\n#\ninterface GE0/0/1\n password cipher secret-one\nreturn'
const version='VRP (R) software, Version 5.110 (S5700 V200R001C00)\nQuidway S5700-28C-HI Routing Switch uptime is 2 days'

test('USG display clock changes do not block recovery or hide real configuration drift',()=>{
 const before='2026-11-12 03:11:46.880\n'+config
 const guard=makeRecoveryGuard(before,version)
 const after='2026-11-12 03:12:47.120\n'+config
 assert.equal(verifyRecoveryGuard(guard,after,version).verified,true)
 assert.throws(()=>verifyRecoveryGuard(guard,after.replace('secret-one','secret-two'),version),/configuration drift/u)
 assert.throws(()=>verifyRecoveryGuard(guard,after+'\ndescription 2026-11-12 03:12:47.120',version),/configuration drift/u)
})
test('guard tolerates pager indentation, uptime and recognized syslog, preserving secret drift detection',()=>{
 const guard=makeRecoveryGuard(config,version)
 assert.doesNotMatch(JSON.stringify(guard),/secret-one/u)
 assert.equal(verifyRecoveryGuard(guard,config.replace('interface','    interface')+'\n%%01PHY/1/PHY(l)[7]: down',version.replace('2 days','3 days')).verified,true)
 assert.throws(()=>verifyRecoveryGuard(guard,config.replace('secret-one','secret-two'),version),/configuration drift/u)
 assert.throws(()=>verifyRecoveryGuard(guard,config.replace('R1','R2'),version),/identity/u)
 assert.throws(()=>verifyRecoveryGuard(guard,config,version.replace('5.110','5.170')),/identity/u)
})

test('native datasync log sharing a configuration line retains the actual configuration suffix',()=>{
 const native='Nov 12 2026 01:14:37-08:00 QA-SW2 DS/4/DATASYNC_CFGCHANGE:OID 1.3.6.1.4.1.2011.5.25.191.3.1 configurations have been changed. The current change number is 38, the change loop count is 0, and the maximum number of records is 4095.                                           '
 const before=config.replace('return','domain default_admin\nreturn'),guard=makeRecoveryGuard(before,version)
 assert.equal(verifyRecoveryGuard(guard,before.replace('domain default_admin',native+'domain default_admin'),version).verified,true)
 assert.throws(()=>verifyRecoveryGuard(guard,before.replace('domain default_admin',native+'domain changed_admin'),version),/configuration drift/u)
})

test('native LLDP log sharing the final return line does not change configuration identity',()=>{
 const log='Nov 12 2026 01:32:11-08:00 QA-SW1 LLDP/4/NBRCHGTRAP:OID: 1.0.8802.1.1.2.0.0.1 Neighbor information is changed. (LldpStatsRemTablesInserts=1, LldpStatsRemTablesDeletes=0, LldpStatsRemTablesDrops=0, LldpStatsRemTablesAgeouts=0)                                          '
 const guard=makeRecoveryGuard(config,version)
 assert.equal(verifyRecoveryGuard(guard,config.replace('return',log+'return'),version).verified,true)
 assert.throws(()=>verifyRecoveryGuard(guard,config.replace('return',log+'domain changed'),version),/configuration drift/u)
})

test('native PHY log sharing a separator preserves the separator and detects configuration suffix drift',()=>{
 const log='Nov 12 2026 01:42:03-08:00 QA-SW1 %%01PHY/1/PHY(l)[4]:    GigabitEthernet0/0/23: change status to down                                          '
 const guard=makeRecoveryGuard(config,version)
 assert.equal(verifyRecoveryGuard(guard,config.replace('\n#\n','\n'+log+'#\n'),version).verified,true)
 assert.throws(()=>verifyRecoveryGuard(guard,config.replace('\n#\n','\n'+log+'shutdown\n'),version),/configuration drift/u)
})
