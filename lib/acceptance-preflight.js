import {prepareCliEntries} from './cli-plan.js'

// Validate the public tool schema before any plan action. Runtime references are
// checked again after expansion; they may stand for a non-string JSON value.
export function validateToolArguments(value,schema,path='args',{references=false}={}) {
  if(references&&typeof value==='string'&&/^\$\{[^}]+\}$/u.test(value))return
  if(schema.anyOf){
    if(!schema.anyOf.some(s=>{try{validateToolArguments(value,s,path,{references});return true}catch{return false}}))throw Error(`${path}: no matching schema`)
    return
  }
  const type=schema.type
  const valid=type===undefined || (type==='object'?value!==null&&typeof value==='object'&&!Array.isArray(value):type==='array'?Array.isArray(value):type==='integer'?Number.isInteger(value):type==='number'?typeof value==='number'&&Number.isFinite(value):type==='null'?value===null:typeof value===type)
  if(!valid)throw Error(`${path}: expected ${type}`)
  const dynamic=references&&typeof value==='string'&&value.includes('${')
  if(schema.enum&&!dynamic&&!schema.enum.includes(value))throw Error(`${path}: invalid enum value`)
  if(type==='object'){
    for(const key of schema.required??[])if(!Object.hasOwn(value,key))throw Error(`${path}.${key}: required`)
    for(const [key,v] of Object.entries(value)){
      const child=schema.properties?.[key]
      if(child)validateToolArguments(v,child,`${path}.${key}`,{references})
      else if(schema.additionalProperties===false)throw Error(`${path}.${key}: unknown property`)
    }
  }
  if(type==='array'){
    if(schema.minItems!==undefined&&value.length<schema.minItems)throw Error(`${path}: too few items`)
    if(schema.maxItems!==undefined&&value.length>schema.maxItems)throw Error(`${path}: too many items`)
    if(schema.items)value.forEach((v,i)=>validateToolArguments(v,schema.items,`${path}[${i}]`,{references}))
  }
}
export function preflightAcceptance(plan,tools){
  const known=new Set()
  for(const step of plan.steps??[]){
    for(const action of [step,step.cleanup].filter(Boolean)){
      const tool=tools.find(t=>t.name===action.tool)
      if(!tool)throw Error(`Unknown tool: ${action.tool}`)
      validateToolArguments(action.args,tool.inputSchema,step.name,{references:true})
      const text=JSON.stringify(action.args)
      for(const match of text.matchAll(/\$\{([^}]+)\}/gu)){
        const ref=match[1].split('.')
        if(match[1]!=='run_dir'&&!(ref[0]==='steps'&&ref.length>=3&&(known.has(ref[1])||(action===step.cleanup&&ref[1]===step.name))))throw Error(`Invalid/forward reference: ${match[1]}`)
      }
      if(action.tool==='ensp_cli'&&!text.includes('${')&&!action.args.recover_from&&!action.args.list_changes&&!action.args.topology_path)prepareCliEntries(action.args)
    }
    known.add(step.name)
  }
}
