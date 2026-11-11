import { apply as applyBase, Config, inject } from './base.js'
import { createFusionTools } from './lib/fusion-tools.js'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'

export { Config, inject }
export const name = 'ensp-fusion'
export function apply(ctx, config = Config({})) {
  applyBase(ctx, config)
  for (const tool of createFusionTools(config)) ctx.tools.register(tool)
  if (config.registerSkill && ctx.skills?.register) ctx.skills.register({
    name: 'ensp-fusion', description: 'Topology construction, 23 scenario briefs and convergence checks.',
    content: readFileSync(new URL('./skills/ensp-fusion/SKILL.md', import.meta.url), 'utf8').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/u, '').trim(),
    source: 'bundled', provider: 'dsh-ensp-fusion',
    resourceBase: { kind: 'directory', path: fileURLToPath(new URL('./skills/ensp-fusion/', import.meta.url)) },
  })
}
