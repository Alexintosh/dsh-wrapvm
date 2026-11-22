/** Build an installable archive without installing or running package lifecycle scripts. */
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
const root=resolve(import.meta.dirname,'..')
const manifest=JSON.parse(readFileSync(join(root,'package.json'),'utf8'))
const target=manifest.engines.dsh
if(target!=='0.2.2-rc.5')throw Error('Review host compatibility before changing the DSH target')
const staging=mkdtempSync(join(root,'.release-pack-'))
try {
 for(const item of ['lib','locale','docs','icon.svg','cordis.patch.yml','README.md','LICENSE'])if(existsSync(join(root,item)))cpSync(join(root,item),join(staging,item),{recursive:true})
 for(const section of ['dependencies','peerDependencies','devDependencies'])for(const [name,version] of Object.entries(manifest[section]??{})){
  if(!version.startsWith('workspace:'))continue
  manifest[section][name]=name.startsWith('@deepseek-ai/dsh-')?target:JSON.parse(readFileSync(join(root,'node_modules',name,'package.json'),'utf8')).version
 }
 writeFileSync(join(staging,'package.json'),JSON.stringify(manifest,null,2)+'\n')
 const destination=join(root,'dist');mkdirSync(destination,{recursive:true})
 const result=execFileSync(join(dirname(process.execPath),'npm'),['pack','--json','--ignore-scripts','--workspaces=false','--pack-destination',destination],{cwd:staging,encoding:'utf8',env:{...process.env,npm_config_ignore_scripts:'true'}})
 const [{filename}]=JSON.parse(result)
 const archive=join(destination,filename), digest=createHash('sha256').update(readFileSync(archive)).digest('hex')
 writeFileSync(archive+'.sha256',`${digest}  ${filename}\n`)
 console.log(`${archive}\nSHA-256 ${digest}`)
}finally{rmSync(staging,{recursive:true,force:true})}
