import { apply as applyBase, Config, inject } from './base.js'
import { createFusionTools } from './lib/fusion-tools.js'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { installOutcomeAdapter } from './lib/tool-outcome.js'
import { createReliabilityTools } from './lib/reliability-tools.js'
import { instrumentTool } from './lib/operation-context.js'

export { Config, inject }
export const name = 'ensp-fusion'
export function apply(ctx, config = Config({})) {
  applyBase(ctx, config)
  const extra = [...createFusionTools(config), ...createReliabilityTools(config)]
  for (const tool of extra) ctx.tools.register(instrumentTool(tool, config))
  installOutcomeAdapter(ctx, ['ensp_status', 'ensp_gui', 'ensp_shot', 'ensp_capture', 'ensp_topo', 'ensp_cli', 'ensp_labtest', 'ensp_doc', 'ensp_ref', ...extra.map(tool => tool.name)])
  if (config.registerSkill && ctx.skills?.register) {
    for (const [name, description] of [
      ['ensp-fusion', 'Topology construction, 50 scenario briefs, addressing scaffolds and convergence checks.'],
      ['ensp-topology-drawing', 'eNSP 拓扑绘图与标签避让。检查和修正设备名、端口文字、编号及分层标注覆盖。'],
    ]) {
      const directory = new URL('./skills/' + name + '/', import.meta.url)
      const content = readFileSync(new URL('SKILL.md', directory), 'utf8')
      ctx.skills.register({ name, description, content: content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/u, '').trim(),
        source: 'bundled', provider: 'dsh-ensp-fusion', resourceBase: { kind: 'directory', path: fileURLToPath(directory) } })
    }
  }
}
