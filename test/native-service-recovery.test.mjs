import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,rm,symlink} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createHash} from 'node:crypto'
import {prepareNativeServices,recoverNativeServices} from '../lib/native-service-recovery.js'
async function fixture(t){
 const workspace=await mkdtemp(join(tmpdir(),'ensp-native-'));t.after(()=>rm(workspace,{recursive:true,force:true}))
 const hash=createHash('sha256').update('content').digest('hex');await writeFile(join(workspace,'probe.txt'),'content')
 const manifest={version:1,address:'10.77.0.100',server:'S',client:'C',dns:{name:'accept.lab',answer:'10.77.0.100'},http:{port:80,directory:'.',file:'probe.txt',sha256:hash},ftp:{port:21,directory:'.',file:'probe.txt',sha256:hash}}
 const topology={devices:[{name:'S',model:'Server',settings:'-ipaddr 10.77.0.100 -dnslist _accept.lab_10.77.0.100'},{name:'C',model:'Client',settings:'-ipv4dns 10.77.0.100'}]}
 return {workspace,manifest,topology}
}
test('native content tampering or DNS mismatch is rejected before activation',async t=>{
 const f=await fixture(t),activate=async()=>assert.fail('must not activate')
 f.manifest.dns.name='other.lab';await assert.rejects(recoverNativeServices({...f,activate,probe:async()=>{}}),/DNS settings/)
 f.manifest.dns.name='accept.lab';await writeFile(join(f.workspace,'probe.txt'),'changed')
 await assert.rejects(recoverNativeServices({...f,activate,probe:async()=>{}}),/hash mismatch/)
})
test('GUI activation alone or wrong FTP hash cannot pass service recovery',async t=>{
 const f=await fixture(t),activate=async()=>({ok:true}),hash=f.manifest.http.sha256
 assert.equal((await recoverNativeServices({...f,activate,probe:async()=>({ok:true})})).ok,false)
 const result={ok:true,vantage:'guest',source:'C',target:f.manifest.address,http:{ok:true,completed:true,status:200,sha256:hash},dns:{ok:true,completed:true,query:'accept.lab',answers:[f.manifest.address]},ftp:{ok:true,completed:true,code:226,sha256:'bad'}}
 assert.equal((await recoverNativeServices({...f,activate,probe:async()=>result})).status,'PROTOCOL_VERIFICATION_FAILED')
 result.ftp.sha256=hash;const r=await recoverNativeServices({...f,activate,probe:async()=>result})
 assert.equal(r.ok,true);assert.equal(r.automatic_native_persistence,false)
})
test('native service content outside workspace is rejected',async t=>{
 const f=await fixture(t),outside=await mkdtemp(join(tmpdir(),'ensp-outside-'));t.after(()=>rm(outside,{recursive:true,force:true}))
 await writeFile(join(outside,'probe.txt'),'content');f.manifest.http.directory=outside
 await assert.rejects(prepareNativeServices(f),/escapes workspace/)
})

test('duplicate identities and ambiguous native settings never activate services',async t=>{
 const f=await fixture(t)
 f.topology.devices.push({name:'S',model:'PC',settings:''})
 await assert.rejects(prepareNativeServices(f),/unique/)
 f.topology.devices.pop();f.topology.devices[0].settings+=' -ipaddr 10.77.0.101'
 await assert.rejects(prepareNativeServices(f),/duplicate/)
})

test('failed protocol metadata cannot be overridden by matching hashes',async t=>{
 const f=await fixture(t),hash=f.manifest.http.sha256
 const result={ok:false,vantage:'guest',source:'C',target:f.manifest.address,http:{ok:true,completed:true,status:200,sha256:hash},dns:{ok:true,completed:true,query:'accept.lab',answers:[f.manifest.address]},ftp:{ok:true,completed:true,code:226,sha256:hash}}
 const options={...f,activate:async()=>({ok:true}),probe:async()=>result}
 assert.equal((await recoverNativeServices(options)).ok,false)
 result.ok=true;result.ftp.ok=false;assert.equal((await recoverNativeServices(options)).ok,false)
 result.ftp.ok=true;assert.equal((await recoverNativeServices(options)).ok,true)
 delete result.ftp.completed;assert.equal((await recoverNativeServices(options)).ok,false)
})
