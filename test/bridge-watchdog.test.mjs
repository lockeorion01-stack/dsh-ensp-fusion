import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {discoverPythonCandidates} from '../lib/bridge-client.js';
test('job watchdog records uncertainty and ends only the stalled job process',t=>{
 const python=discoverPythonCandidates()[0];if(!python)return t.skip('Python unavailable');
 const dir=mkdtempSync(join(tmpdir(),'ensp-watchdog-test-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const job=join(dir,'job.json'),result=join(dir,'result.json'),status=join(dir,'status.json');
 writeFileSync(job,JSON.stringify({steps:[{op:'sleep'}],timeout_ms:100,result,status}));
 const code=`import ast,json,os,threading,time,traceback,sys,contextlib\nfrom pathlib import Path\na=ast.parse(Path(sys.argv[1]).read_text(encoding='utf8'))\nf=next(n for n in a.body if isinstance(n,ast.FunctionDef) and n.name=='run_job')\nns=dict(globals(),gui_transaction=contextlib.nullcontext,dispatch=lambda op,args:time.sleep(10),is_elevated=lambda:False,DPI_MODE=None)\nexec(compile(ast.Module(body=[f],type_ignores=[]),'<watchdog-test>','exec'),ns)\nns['run_job'](sys.argv[2])`;
 const r=spawnSync(python,['-c',code,resolve('lib/bridge.py'),job],{timeout:5000,windowsHide:true,encoding:'utf8'});
 assert.equal(r.status,124,r.stderr);const evidence=JSON.parse(readFileSync(result,'utf8'));assert.equal(evidence.error_code,'GUI_JOB_TIMEOUT');assert.equal(evidence.uncertain,true);assert.equal(evidence.steps[0].op,'sleep');assert.equal(JSON.parse(readFileSync(status,'utf8')).state,'running');
});
