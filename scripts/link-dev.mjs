/** Link an existing toolchain into this repository; no package installation or host writes. */
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, symlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
const root=resolve(import.meta.dirname,'..'), source=process.env.DSH_WORKSPACE
if(!source)throw Error('Set DSH_WORKSPACE to an already prepared compatible DSH checkout')
const modules=join(root,'node_modules')
mkdirSync(join(modules,'@deepseek-ai'),{recursive:true})
function link(from,to){try{lstatSync(to);return}catch(error){if(error.code!=='ENOENT')throw error}symlinkSync(from,to,'dir')}
for(const base of [join(source,'node_modules'),join(source,'node_modules/.pnpm/node_modules')]){
 if(!existsSync(base))continue
 for(const name of readdirSync(base)){if(name==='@deepseek-ai'||name==='.pnpm'||name.startsWith('.'))continue;link(join(base,name),join(modules,name))}
}
const register=dir=>{const file=join(dir,'package.json');if(!existsSync(file))return;const {name}=JSON.parse(readFileSync(file,'utf8'));if(name?.startsWith('@deepseek-ai/')&&name!=='@deepseek-ai/dsh-wrapvm-isolate')link(dir,join(modules,name))}
for(const group of readdirSync(join(source,'packages'),{withFileTypes:true}))if(group.isDirectory())for(const pkg of readdirSync(join(source,'packages',group.name),{withFileTypes:true}))if(pkg.isDirectory())register(join(source,'packages',group.name,pkg.name))
for(const pkg of readdirSync(join(source,'vendor'),{withFileTypes:true}))if(pkg.isDirectory())register(join(source,'vendor',pkg.name))
console.log('Linked existing development dependencies in this repository only; existing entries were preserved.')
