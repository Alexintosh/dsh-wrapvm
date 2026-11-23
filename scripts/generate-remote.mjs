/** Generate only this bundle, using a private source snapshot (never mutates DSH). */
import { cpSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
const root=resolve(import.meta.dirname,'..'), source=process.env.DSH_WORKSPACE
if(!source)throw Error('Set DSH_WORKSPACE')
const stage=join(root,'.dev/typert-workspace')
mkdirSync(stage,{recursive:true})
for(const item of ['packages','vendor']) cpSync(join(source,item),join(stage,item),{recursive:true,filter:path=>!/(?:^|\/)(?:node_modules|lib|dist|\.git|tests)(?:\/|$)/.test(path)&&!path.endsWith('.tsbuildinfo')&&!/\.d\.ts$/.test(path)&&!path.endsWith('.js')})
for(const item of readdirSync(source))if(/^tsconfig.*\.json$/.test(item))cpSync(join(source,item),join(stage,item))
const ts=createRequire(join(source,'node_modules/typescript/package.json'))('typescript')
for(const face of ['host','client']){
 const aggregatePath=join(stage,face==='host'?'tsconfig.host.json':'tsconfig.client.json')
 const reference={path:`packages/bundle/wrapvm-isolate/tsconfig.${face}.json`}
 const aggregate=ts.readConfigFile(aggregatePath,ts.sys.readFile).config
 aggregate.references=aggregate.references??[]
 if(!aggregate.references.some(item=>item.path===reference.path))aggregate.references.push(reference)
 writeFileSync(aggregatePath,JSON.stringify(aggregate,null,2)+'\n')
}
if(!existsSync(join(stage,'node_modules')))symlinkSync(join(source,'node_modules'),join(stage,'node_modules'),'dir')
const bundle=join(stage,'packages/bundle/wrapvm-isolate')
cpSync(join(root,'src'),join(bundle,'src'),{recursive:true})
cpSync(join(root,'package.json'),join(bundle,'package.json'))
for(const face of ['host','client']){
 const config=JSON.parse(readFileSync(join(root,`tsconfig.${face}.json`)))
 config.extends=face==='host'?'../../../tsconfig.base.json':'../../../tsconfig.base.client.json'
 writeFileSync(join(bundle,`tsconfig.${face}.json`),JSON.stringify(config))
}
// External dependencies are read from their existing per-package installation.
for(const group of ['packages','vendor']) for(const category of readdirSync(join(source,group),{withFileTypes:true})) {
 if(!category.isDirectory())continue
 const parents=group==='vendor'?[join(source,group,category.name)]:readdirSync(join(source,group,category.name),{withFileTypes:true}).filter(x=>x.isDirectory()).map(x=>join(source,group,category.name,x.name))
 for(const parent of parents){const deps=join(parent,'node_modules'),dest=join(stage,parent.slice(source.length+1),'node_modules');if(existsSync(deps)&&!existsSync(dest))symlinkSync(deps,dest,'dir')}
}
const script=join(stage,'generate.ts')
writeFileSync(script,`import {WorkspaceAnalyzer} from ${JSON.stringify(join(source,'packages/typert/generator/src/analyzer.ts'))}; import {FaceModelEmitter} from ${JSON.stringify(join(source,'packages/typert/generator/src/emitter.ts'))}; import {writePackageArtifacts} from ${JSON.stringify(join(source,'packages/typert/generator/src/artifact-files.ts'))}; const model=new WorkspaceAnalyzer({root:${JSON.stringify(stage)},packages:['dsh-wrapvm-isolate'],faces:['host'],checkDiagnostics:false,rejectBuildOutputs:true}).analyze(); const artifacts=model.faces.map(face=>({...new FaceModelEmitter(face).emit('dsh-wrapvm-isolate'),packageRoot:'packages/bundle/wrapvm-isolate'})); if(artifacts.length!==1)throw Error('Unexpected artifact set'); writePackageArtifacts(${JSON.stringify(root)},artifacts); console.log('Generated bundle Remote only');`)

const result=spawnSync(process.execPath,['--import',join(source,'node_modules/tsx/dist/loader.mjs'),script],{cwd:stage,stdio:'inherit'})
process.exitCode=result.status??1
