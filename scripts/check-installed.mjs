import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createContentManifest, checkInstalled } from '../lib/installation-integrity.js'
const args = process.argv.slice(2)
async function main() {
  if (args.includes('--help')) { console.log('node scripts/check-installed.mjs --create-manifest <new.json> --source-root <directory>\nnode scripts/check-installed.mjs --manifest <json> --installed-root <directory> [--runtime-status <status.json>] [--output <new.json>]'); return }
  const options = {}
  for (let i = 0; i < args.length; i += 2) {
    if (!['--create-manifest','--source-root','--manifest','--installed-root','--runtime-status','--output'].includes(args[i]) || !args[i+1] || args[i+1].startsWith('--') || options[args[i]]) throw Error('invalid option: ' + args[i])
    options[args[i]] = args[i+1]
  }
  let report
  if (options['--create-manifest']) {
    const manifest = await createContentManifest(resolve(options['--source-root'] ?? '.'))
    await writeFile(options['--create-manifest'], JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' })
    report = { ok: true, manifest: resolve(options['--create-manifest']), files: manifest.files.length, fingerprint: manifest.fingerprint }
  } else {
    if (!options['--manifest'] || !options['--installed-root']) throw Error('--manifest and --installed-root required')
    const read = async path => JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/u, ''))
    report = await checkInstalled({ manifest: await read(options['--manifest']), installedRoot: options['--installed-root'],
      runtimeStatus: options['--runtime-status'] ? await read(options['--runtime-status']) : undefined })
  }
  if (options['--output']) await writeFile(options['--output'], JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
  console.log(JSON.stringify(report, null, 2)); if (!report.ok) process.exitCode = 1
}
main().catch(error => { console.error(JSON.stringify({ ok: false, error: error.message })); process.exitCode = 1 })
