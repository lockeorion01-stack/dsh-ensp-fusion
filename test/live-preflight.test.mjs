import test from 'node:test';
import assert from 'node:assert/strict';
import {preflightFailure} from '../lib/live-preflight.js';
test('mutex busy is not misreported as locked desktop',()=>assert.equal(preflightFailure({ok:false,steps:[{op:'ping',error:'another GUI operation is active'}]}).code,'GUI_BUSY'));
test('desktop evidence, bridge failure, and missing window are distinct',()=>{
  assert.equal(preflightFailure({ok:true,steps:[{op:'ping',pong:true,desktop_available:false}]}).code,'DESKTOP_UNAVAILABLE');
  assert.equal(preflightFailure({ok:false,error:'transport timeout'}).code,'BRIDGE_FAILURE');
  assert.equal(preflightFailure({ok:true,steps:[{op:'ping',pong:true},{op:'ensp',windows:[]}]}).code,'WINDOW_SELECTION_REQUIRED');
  assert.equal(preflightFailure({ok:true,steps:[{op:'ping',pong:true},{op:'ensp',windows:[{}]}]}),null);
});
