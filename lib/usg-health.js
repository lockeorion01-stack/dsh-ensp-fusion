// Parse only the documented fields present in the USG console evidence. Do not
// combine management, device and dynamic memory into a single utilization.
export function parseUsgResources({cpu,memory,sessions}){
 const percentage=value=>{const n=Number(value);return value!==undefined&&Number.isFinite(n)&&n>=0&&n<=100?n:null}
 const current=percentage(/^\s*CPU Usage\s*:\s*([\d.]+)%/mu.exec(cpu??'')?.[1])
 const maximum=percentage(/^\s*CPU Usage\s*:\s*[\d.]+%\s+Max:\s*([\d.]+)%/mu.exec(cpu??'')?.[1])
 const management=percentage(/System Total Memory Is:[\s\S]*?Memory Using Percentage Is:\s*([\d.]+)%/u.exec(memory??'')?.[1])
 const device=percentage(/Device Total Memory Is:[\s\S]*?Memory Using Percentage Is:\s*([\d.]+)%/u.exec(memory??'')?.[1])
 const dynamic=percentage(/Dynamic Memory Using Percentage Is:\s*([\d.]+)%/u.exec(memory??'')?.[1])
 const match=/Current Total Sessions\s*:\s*(\d+)/u.exec(sessions??''),count=match?Number(match[1]):null
 const total=count!==null&&Number.isSafeInteger(count)?count:null
 return {complete:[current,management,device,dynamic,total].every(v=>v!==null),cpu_percent:current,cpu_historical_max_percent:maximum,
  management_memory_percent:management,device_memory_percent:device,dynamic_memory_percent:dynamic,sessions:total}
}

export function evaluateUsgHealth({samples,limits}){
 if(!Array.isArray(samples)||!samples.length||!limits||!Number.isSafeInteger(limits.min_samples)||limits.min_samples<1
  ||!['cpu_percent','management_memory_percent','device_memory_percent','dynamic_memory_percent'].every(k=>Number.isFinite(limits[k])&&limits[k]>0&&limits[k]<=100))throw Error('USG health requires samples and explicit resource limits/min_samples')
 const parsed=samples.map(parseUsgResources),violations=[]
 parsed.forEach((s,index)=>{for(const key of ['cpu_percent','management_memory_percent','device_memory_percent','dynamic_memory_percent'])if(s[key]!==null&&s[key]>limits[key])violations.push({sample:index+1,metric:key,value:s[key],limit:limits[key]})})
 const status=violations.length?'FAIL':parsed.length<limits.min_samples||parsed.some(s=>!s.complete)?'INCONCLUSIVE':'PASS'
 return {ok:status==='PASS',status,scope:'Observed resource health only; no throughput, concurrency or maximum capacity claim.',performance_accepted:false,limits,samples:parsed,violations}
}
