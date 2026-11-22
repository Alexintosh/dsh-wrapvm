/** Opt-in isolated Docker acceptance. Never opens or installs into the desktop profile. */
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import Storage, { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '../../../storage/storage-domain/src/index.ts'
import { MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import { wrapvmInventoryDomainSpec } from '../src/inventory.ts'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import Wrapvm from '../lib/index.js'
let ctx:Context|undefined, root:string|undefined
const owned=new Set<string>()
const docker=(...args:string[])=>execFileSync('docker',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim()
afterEach(async()=>{
 // Include partially created intents owned by THIS isolated memory store only.
 if(ctx?.get('storageDomain')){
  const d=ctx.storageDomain.get(wrapvmInventoryDomainSpec.name)
  for(const op of Object.values(d?.table('snapshots').get('current')?.operations??{}))owned.add(op.environmentId)
 }
 await ctx?.fiber.dispose();ctx=undefined
 for(const id of owned){
  const filter=['--filter','label=dsh.wrapvm.environment=1','--filter',`label=dsh.wrapvm.environment-id=${id}`]
  for(const c of docker('ps','-aq','--no-trunc',...filter).split('\n').filter(Boolean))docker('rm','-f',c)
  for(const n of docker('network','ls','-q','--no-trunc',...filter).split('\n').filter(Boolean))docker('network','rm',n)
  for(const v of docker('volume','ls','-q',...filter).split('\n').filter(Boolean))docker('volume','rm',v)
 }
 owned.clear();if(root)await rm(root,{recursive:true,force:true});root=undefined
})
it.skipIf(process.env.WRAPVM_LIVE_ACCEPTANCE!=='1')('agent creates, copies, binds, resumes, imports/exports and opens Chrome without GUI setup',async()=>{
 await mkdir('.dev/projects',{recursive:true});root=await mkdtemp(join(process.cwd(),'.dev/projects/agent-live-'))
 await writeFile(join(root,'local.txt'),'uncommitted source')
 await writeFile(join(root,'.env'),'SECRET=not-for-vm')
 ctx=new Context()
 await ctx.plugin(Storage);const memory=new MemoryStorageBackend();ctx.storage.backend.register('memory',memory);ctx.provide(storageBackendServiceKey('memory'),memory)
 await ctx.plugin(StorageDomain,{backend:'memory'});await ctx.plugin(SessionProjectionRegistry);await ctx.plugin(SessionStore);await ctx.plugin(SystemPrompt);await ctx.plugin(Tools);await ctx.plugin(Subprocess)
 await ctx.plugin(Wrapvm,{backend:'docker',agentImage:'wrapvm-dsh:desktop',agentCpuMillis:1000,agentMemoryBytes:1073741824,agentInternetAccess:true,metricsCadenceMs:5000,metricsStalenessMs:15000})
 const session=ctx.sessions.create(SessionId('isolated-agent-live'),{meta:{cwd:root}})
 const execution={agent:{session},signal:new AbortController().signal,callId:ToolCallId('live-prepare')} as ToolRunContext
 const tool=(name:string,args:object)=>ctx!.tools.definitions().find(t=>t.name===name)!.execute(args,execution)
 await expect.poll(()=>tool('vm_status',{})).toMatchObject({state:'unassigned'})
 await expect(ctx.wrapvmIsolate.v02Bind('unrelated','any','key')).rejects.toThrow('owner')
 const prepared=await tool('vm_prepare',{description:'Prepare disposable acceptance project'}) as {environmentId:string;workspace:{guestPath:string};ready:boolean}
 expect(prepared.ready).toBe(true);expect(prepared.workspace).toMatchObject({mode:'copy'});owned.add(prepared.environmentId)
 const shell=async(command:string)=>(await tool('vm_shell',{command,description:'Acceptance check'})) as {output:string;exitCode:number}
 expect(await shell('cat local.txt; test ! -e .env')).toMatchObject({output:'uncommitted source',exitCode:0})
 await shell("printf 'guest edit' > local.txt")
 const retry=await tool('vm_prepare',{description:'Retry preparation'}) as typeof prepared
 expect(retry.environmentId).toBe(prepared.environmentId);expect((await shell('cat local.txt')).output).toBe('guest edit')
 const name=`dsh-wrapvm-${prepared.environmentId}`
 docker('pause',name);expect(await tool('vm_prepare',{description:'Resume the same environment'})).toMatchObject({action:'resumed',environmentId:prepared.environmentId})
 docker('stop',name);expect(await tool('vm_prepare',{description:'Start the same environment'})).toMatchObject({action:'started',environmentId:prepared.environmentId})
 await writeFile(join(root,'added.txt'),'new host file')
 expect(await tool('vm_workspace',{action:'import',paths:['added.txt','local.txt']})).toMatchObject({imported:['added.txt'],conflicts:['local.txt']})
 await writeFile(join(root,'local.txt'),'host edit after copy')
 const exported=await tool('vm_workspace',{action:'export',paths:['local.txt']}) as {directory:string;conflicts:string[]}
 expect(exported.conflicts).toEqual(['local.txt']);expect(await readFile(join(exported.directory,'local.txt'),'utf8')).toBe('guest edit');expect(await readFile(join(root,'local.txt'),'utf8')).toBe('host edit after copy')
 const page=await tool('vm_browser',{action:'open',url:'about:blank'}) as {target:string};expect(page.target).toBeTruthy()
 expect(await tool('vm_browser',{action:'close',targetId:page.target})).toMatchObject({action:'close'})
 expect(await tool('vm_environments',{})).toMatchObject({environments:[{id:prepared.environmentId,selected:true}]})
},120000)
