/** Negative boundaries around the automatic orchestration; no engine mutations. */
import { afterEach, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { currentProject, prepareForAgent, type WorkspaceRuntime } from '../src/agent-workspaces.ts'
import { BindingRegistry } from '../src/binding.ts'
import type { Preparation } from '../src/preparation.ts'
const roots:string[]=[]
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true})})
async function project(){await mkdir('.dev/projects',{recursive:true});const root=await mkdtemp(join(process.cwd(),'.dev/projects/boundary-'));roots.push(root);await writeFile(join(root,'work.txt'),'local work');return root}
function execution(cwd?:string):ToolRunContext{return {agent:{session:{id:'session',header:{...(cwd?{cwd}:{})}}},signal:new AbortController().signal,callId:'tool'} as unknown as ToolRunContext}
function runtime(){
 const records=new Map<string,Preparation>(),bindings=new BindingRegistry({emit:async()=>{}});bindings.markComplete()
 const create=vi.fn(async()=>{throw Error('unexpected create')}),approveMounts=vi.fn(),run=vi.fn(async()=>({exitCode:1,stdout:'',stderr:'missing image'}))
 const value={store:{get:(k:string)=>records.get(k),put:async(k:string,v:Preparation)=>{records.set(k,v)}},bindings,defaults:{image:'missing-local-image',cpuMillis:1000,memoryBytes:1073741824,internetAccess:true},manager:{get:()=>undefined,create},backend:{approveMounts},current:()=>undefined,select:vi.fn(),binary:'engine',run,lifetime:new AbortController().signal} as unknown as WorkspaceRuntime
 return {value,records,create,run,approveMounts}
}
it('never falls back to the plugin launch directory or accepts a project from model arguments',async()=>{
 const ctx=new Context(),e=execution()
 expect(currentProject(ctx,e)).toBeNull()
 ctx.provide('workingDirectory',{defaultDirectory:'/launch',get:()=>'/launch'} as never)
 expect(currentProject(ctx,e)).toBeNull()
 const r=runtime()
 await expect(prepareForAgent(ctx,r.value,{...e,agent:undefined} as never,{environmentId:'other-session'},)).rejects.toThrow('no conversation')
 expect(r.run).not.toHaveBeenCalled();expect(r.create).not.toHaveBeenCalled()
 await ctx.fiber.dispose()
})
it('refuses a missing local image before creating Docker resources; keeps the same retry identity',async()=>{
 const ctx=new Context(),r=runtime(),e=execution(await project())
 await expect(prepareForAgent(ctx,r.value,e,{})).rejects.toThrow('not available locally')
 const first=[...r.records.values()][0]!.id
 await expect(prepareForAgent(ctx,r.value,e,{})).rejects.toThrow('not available locally')
 expect([...r.records.values()]).toHaveLength(1);expect([...r.records.values()][0]!.id).toBe(first)
 expect(r.create).not.toHaveBeenCalled();expect(r.approveMounts).not.toHaveBeenCalled()
 await ctx.fiber.dispose()
})
it('rejects unsupported offline creation before storing intent or allocating resources',async()=>{
 const ctx=new Context(),r=runtime();r.value.defaults.internetAccess=false
 await expect(prepareForAgent(ctx,r.value,execution(),{})).rejects.toThrow('offline')
 expect(r.records.size).toBe(0);expect(r.run).not.toHaveBeenCalled()
 await ctx.fiber.dispose()
})
it.each(['bind-readonly','bind-readwrite'] as const)('requires actual native approval for %s and never self-approves',async mode=>{
 const ctx=new Context(),r=runtime(),root=await project(),e=execution(root)
 await expect(prepareForAgent(ctx,r.value,e,{workspaceMode:mode})).rejects.toThrow('approval is unavailable')
 expect(r.approveMounts).not.toHaveBeenCalled();expect(r.run).not.toHaveBeenCalled()
 const request=vi.fn(async()=> 'rejected' as const);ctx.provide('approval',{request} as never)
 await expect(prepareForAgent(ctx,r.value,e,{workspaceMode:mode})).rejects.toThrow('rejected')
 expect(request).toHaveBeenCalledWith(expect.objectContaining({agent:e.agent,toolName:'vm_prepare',reason:expect.stringContaining(root)}))
 expect(r.approveMounts).not.toHaveBeenCalled();expect(r.create).not.toHaveBeenCalled()
 await ctx.fiber.dispose()
})
it('host disposal cancels preparation before an engine action',async()=>{
 const ctx=new Context(),r=runtime();r.value.lifetime=AbortSignal.abort(Error('unloaded'))
 await expect(prepareForAgent(ctx,r.value,execution(),{})).rejects.toThrow('unloaded')
 expect(r.run).not.toHaveBeenCalled();expect(r.records.size).toBe(0)
 await ctx.fiber.dispose()
})
