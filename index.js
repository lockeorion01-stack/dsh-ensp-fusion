import { apply as applyBase, Config, inject } from './base.js'
import { createFusionTools } from './lib/fusion-tools.js'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { installOutcomeAdapter } from './lib/tool-outcome.js'
import { createReliabilityTools } from './lib/reliability-tools.js'

export { Config, inject }
export const name = 'ensp-fusion'
export function apply(ctx, config = Config({})) {
  applyBase(ctx, config)
  const extra = [...createFusionTools(config), ...createReliabilityTools(config)]
  for (const tool of extra) ctx.tools.register(tool)
  installOutcomeAdapter(ctx, ['ensp_status', 'ensp_gui', 'ensp_shot', 'ensp_capture', 'ensp_topo', 'ensp_cli', 'ensp_labtest', 'ensp_doc', 'ensp_ref', ...extra.map(tool => tool.name)])
  if (config.registerSkill && ctx.skills?.register) ctx.skills.register({
    name: 'ensp-fusion', description: 'Topology construction, 23 scenario briefs and convergence checks.',
    content: readFileSync(new URL('./skills/ensp-fusion/SKILL.md', import.meta.url), 'utf8').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/u, '').trim(),
    source: 'bundled', provider: 'dsh-ensp-fusion',
    resourceBase: { kind: 'directory', path: fileURLToPath(new URL('./skills/ensp-fusion/', import.meta.url)) },
  })
}
