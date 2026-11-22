/** Standalone package tooling. Reads an existing DSH checkout, never writes it. */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { spawnSync } from 'node:child_process'
const root = resolve(import.meta.dirname, '..')
const workspace = process.env.DSH_WORKSPACE
if (!workspace) throw Error('Set DSH_WORKSPACE to the compatible DSH source checkout with its dependencies already installed')
const original = join(workspace, 'packages/bundle/wrapvm-isolate')
mkdirSync(join(root, '.dev'), {recursive:true})
for (const face of ['host','client']) {
  const conf = JSON.parse(readFileSync(join(root, `tsconfig.${face}.json`)))
  conf.extends = join(workspace, face === 'host' ? 'tsconfig.base.json' : 'tsconfig.base.client.json')
  conf.compilerOptions = {...conf.compilerOptions, rootDir:join(root,'src'),outDir:join(root,'lib/types'),tsBuildInfoFile:join(root,`.dev/${face}.tsbuildinfo`)}
  conf.include = conf.include.map(p=>join(root,p))
  conf.references = conf.references.map(r=>({path:resolve(original,r.path)}))
  writeFileSync(join(root,`.dev/${face}.json`), JSON.stringify(conf,null,2))
}
writeFileSync(join(root,'.dev/bundle.ts'), `import { clientBundle } from ${JSON.stringify(join(workspace,'packages/client/tsdown.client.ts'))}; export default clientBundle(${JSON.stringify(root)}, ['lib/types/index.js','lib/types/types.js'], {hostPhase:true})({}).map(config=>({...config,cwd:${JSON.stringify(root)},entry:Array.isArray(config.entry)?config.entry.map(e=>${JSON.stringify(root)}+'/'+e):Object.fromEntries(Object.entries(config.entry).map(([k,v])=>[k,${JSON.stringify(root)}+'/'+v])),outDir:${JSON.stringify(join(root,'lib'))}}));`)
writeFileSync(join(root,'.dev/vitest.ts'), `
import {defineConfig} from 'vitest/config';
import ts from 'typescript';
import {resolve} from 'node:path';
import {standardDecoratorPlugin, vitestExecArgv} from ${JSON.stringify(join(workspace,'vitest.shared.ts'))};
const workspace=${JSON.stringify(workspace)}, root=${JSON.stringify(root)};
const config=ts.readConfigFile(resolve(workspace,'tsconfig.base.json'),ts.sys.readFile).config;
const aliases=Object.entries(config.compilerOptions.paths).map(([find, paths])=>({find: new RegExp('^'+find.replace(/[.*+?^\x24{}()|[\\]\\\\]/g,'\\\\$&').replace('\\\\*','(.*)')+'$'),replacement:resolve(workspace,paths[0]).replace('*','$1')}));
export default defineConfig({oxc:{tsconfigFile:false},plugins:[{name:'legacy-test-imports',enforce:'pre',resolveId(source,importer){if(importer?.startsWith(root+'/tests/')&&source.startsWith('../../../')) return resolve(workspace,'packages',source.slice(9));}},standardDecoratorPlugin()],resolve:{alias:[{find:'@deepseek-ai/dsh-wrapvm-isolate/types',replacement:root+'/src/types.ts'},{find:'@deepseek-ai/dsh-wrapvm-isolate/remote',replacement:root+'/lib/typert.remote-client.js'},{find:'@deepseek-ai/dsh-wrapvm-isolate',replacement:root+'/src/index.ts'},...aliases]},test:{include:['tests/**/*.spec.ts','tests/**/*.spec.tsx'],execArgv:vitestExecArgv,environment:'node',maxWorkers:2}});
`)
const run=(tool,args)=>{ const r=spawnSync(process.execPath,[join(workspace,tool),...args],{cwd:root,stdio:'inherit',env:process.env}); if(r.status!==0)process.exit(r.status??1) }
const mode=process.argv[2]
const activeTests=['preparation','workspace-copy','agent-workspaces','generated-read-face','inventory','lifecycle','binding-telemetry','docker-backend','backend-review','manager-backend-review','backend-sol-regressions','mount-policy','v02-client.client','panel.client','registration.client']
if(mode==='test')run('node_modules/vitest/vitest.mjs',['run','--config','.dev/vitest.ts',...(process.argv.length>3?process.argv.slice(3):activeTests.map(name=>'tests/'+name+'.spec.'))])
else if(mode==='check')for(const face of ['host','client'])run('node_modules/typescript/bin/tsc',['-p',`.dev/${face}.json`,'--noEmit'])
else if(mode==='build'){for(const face of ['host','client'])run('node_modules/typescript/bin/tsc',['-p',`.dev/${face}.json`]);run('node_modules/tsdown/dist/run.mjs',['--config','.dev/bundle.ts'])}
else throw Error('Use test, check or build')
