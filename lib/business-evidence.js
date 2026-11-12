// These evaluators assess recorded observations. They never configure devices,
// generate network traffic, or treat a configured rule as enforcement evidence.
export function evaluateStability({samples,criteria}) {
 if(!Array.isArray(samples)||!samples.length)throw Error('Nonempty stability samples required')
 if(criteria!==undefined&&(!criteria||typeof criteria!=='object'||Array.isArray(criteria)
  ||Object.keys(criteria).some(k=>!['rounds','packets_per_round'].includes(k))
  ||Object.values(criteria).some(v=>!Number.isSafeInteger(v)||v<1)))throw Error('Stability criteria require positive integer rounds/packets_per_round')
 let sent=0,received=0,invalid=0,failed=0
 for(const sample of samples){
  const {transmitted:n,received:r,loss_percent:loss}=sample??{}
  if(sample?.completed!==true||!Number.isSafeInteger(n)||n<1||!Number.isSafeInteger(r)||r<0||r>n
   ||!Number.isFinite(loss)||loss<0||loss>100||(r===n&&loss!==0)||Math.abs(loss-100*(n-r)/n)>0.011){invalid++;continue}
  sent+=n;received+=r;if(r!==n)failed++
 }
 const coverage_complete=(!criteria?.rounds||samples.length===criteria.rounds)&&(!criteria?.packets_per_round||samples.every(s=>s?.transmitted===criteria.packets_per_round))
 const status=failed?'FAIL':invalid||!coverage_complete?'INCONCLUSIVE':'PASS'
 return {ok:status==='PASS',status,rounds:samples.length,transmitted:sent,received,failed_rounds:failed,invalid_rounds:invalid,
  coverage_complete,criteria:criteria??null,
  scope:'All supplied rounds, including initial failures; does not establish unobserved duration or scenarios.'}
}

export function evaluateIsolation(evidence){
 const {flow,baseline,restricted,restored,denial}=evidence??{}
 if(!flow||!['http','tcp'].includes(flow.protocol)||typeof flow.source!=='string'||typeof flow.target!=='string'
  ||!Number.isInteger(flow.port)||flow.port<1||flow.port>65535)throw Error('Isolation flow requires source, target, protocol and port')
 const result=(status,reason)=>({ok:status==='PASS',status,reason,flow,scope:'Recorded flow only; configuration acceptance does not verify enforcement.'})
 const valid=s=>s?.completed===true&&typeof s.reached==='boolean'
 const sameFlow=s=>s?.source===flow.source&&s?.target===flow.target&&s?.protocol===flow.protocol&&s?.port===flow.port
 const groups=[baseline,restricted,restored]
 // An observed successful connection through the restricted flow is a failure,
 // even if configuration/counter evidence is absent or the final retry succeeds.
 if(Array.isArray(restricted)&&restricted.some(s=>valid(s)&&sameFlow(s)&&s.reached))return result('FAIL','Restricted flow remained reachable')
 if(groups.some(rows=>!Array.isArray(rows)||!rows.length))return result('INCONCLUSIVE','Missing baseline, restricted or restored observations')
 if(groups.some(rows=>rows.some(s=>!valid(s)||!sameFlow(s))))return result('INCONCLUSIVE','Incomplete or mismatched flow observations')
 if([...baseline,...restored].some(s=>!s.reached))return result('INCONCLUSIVE','Baseline or restored service was not healthy')
 for(const sample of restricted){
  const c=sample.control
  if(!valid(c)||!c.reached||c.target!==flow.target||c.protocol!==flow.protocol||c.port!==flow.port
   ||typeof c.source!=='string'||!c.source||c.source===flow.source||c.window!==sample.window||!sample.window)
   return result('INCONCLUSIVE','A distinct authorized source must reach the same service in every restricted observation window')
 }
 if(!denial||typeof denial.rule!=='string'||!denial.rule.trim()||!sameFlow(denial)
  ||!Array.isArray(denial.windows)||restricted.some(s=>!denial.windows.includes(s.window))
  ||!Number.isSafeInteger(denial.before)||denial.before<0||!Number.isSafeInteger(denial.after)||denial.after<=denial.before
  ||typeof denial.evidence!=='string'||!denial.evidence)
  return result('INCONCLUSIVE','Missing matching deny-rule hit evidence; timeout alone does not prove ACL enforcement')
 return result('PASS','Baseline and restored flow reachable; restricted flow denied with healthy authorized control and matching deny-rule evidence')
}

export function evaluateBusinessEvidence(evidence){
 if(evidence?.version!==1)throw Error('Business evidence requires version:1')
 if(evidence.kind==='stability')return evaluateStability(evidence)
 if(evidence.kind==='isolation')return evaluateIsolation(evidence)
 throw Error('Business evidence kind must be stability or isolation')
}
