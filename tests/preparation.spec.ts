import { expect, it, vi } from 'vitest'
import { prepareEnvironment, SessionOperations, type Preparation, type PreparationPorts } from '../src/preparation.ts'
import { BindingRegistry } from '../src/binding.ts'
import { descriptorFor, env1 } from './fixtures/env-fixtures.ts'
const signal=new AbortController().signal
function fixture(){
 const records=new Map<string,Preparation>(); const bindings=new BindingRegistry({emit:async()=>{}});bindings.markComplete()
 let exists=false
 const ports:PreparationPorts={store:{get:k=>structuredClone(records.get(k)),put:async(k,v)=>{records.set(k,structuredClone(v))}},bindings,defaults:{image:'local',cpuMillis:1000,memoryBytes:100,internetAccess:true},get:id=>exists&&id===env1?descriptorFor(env1):undefined,
 create:vi.fn(async()=>{exists=true;return {id:'create',environmentId:env1,kind:'create',state:'completed'}}),running:vi.fn(async()=>descriptorFor(env1).containerId!),install:vi.fn(async()=>{}),approveMount:vi.fn(async()=>{throw Error('approval denied')})}
 return {ports,records,bindings}
}
it('concurrent calls converge to one durable create and one binding',async()=>{
 const {ports,bindings}=fixture();const queue=new SessionOperations()
 const [a,b]=await Promise.all([1,2].map(()=>queue.run('session',()=>prepareEnvironment(ports,'session',null,{},signal))))
 expect(a.environmentId).toBe(b.environmentId);expect(ports.create).toHaveBeenCalledOnce();expect(bindings.binding('session')?.generation).toBe(1)
 expect(a.phase).toBe('ready')
})
it('retries a failed workspace installation against the same created environment',async()=>{
 const {ports}=fixture();vi.mocked(ports.install).mockRejectedValueOnce(Error('transport lost'))
 await expect(prepareEnvironment(ports,'s',null,{},signal)).rejects.toThrow('transport lost')
 const record=await prepareEnvironment(ports,'s',null,{},signal)
 expect(record.phase).toBe('ready');expect(ports.create).toHaveBeenCalledOnce()
 expect(ports.install).toHaveBeenCalledTimes(2)
})
it('does not create on persistence failure or cancelled execution',async()=>{
 const {ports}=fixture();ports.store.put=async()=>{throw Error('disk failed')}
 await expect(prepareEnvironment(ports,'s',null,{},signal)).rejects.toThrow('disk failed');expect(ports.create).not.toHaveBeenCalled()
 await expect(prepareEnvironment(ports,'s',null,{},AbortSignal.abort())).rejects.toBeDefined()
})
it('refuses replacement when a prepared container disappears or changes identity',async()=>{
 const {ports}=fixture();await prepareEnvironment(ports,'s',null,{},signal)
 ports.get=()=>({...descriptorFor(env1),containerId:'replacement'})
 await expect(prepareEnvironment(ports,'s',null,{},signal)).rejects.toThrow('identity changed')
 ports.get=()=>undefined
 await expect(prepareEnvironment(ports,'s',null,{},signal)).rejects.toThrow('removed')
 expect(ports.create).toHaveBeenCalledOnce()
})
it('preserves explicit selection validation and checks workspace even on ready retry',async()=>{
 const {ports}=fixture()
 await expect(prepareEnvironment(ports,'s',null,{environmentId:'missing'},signal)).rejects.toThrow('missing')
 expect(ports.create).not.toHaveBeenCalled()
 await prepareEnvironment(ports,'s',null,{},signal)
 vi.mocked(ports.install).mockRejectedValueOnce(Error('workspace disappeared'))
 await expect(prepareEnvironment(ports,'s',null,{},signal)).rejects.toThrow('disappeared')
})
it('keeps queued work separate by session, and survives a rejected predecessor',async()=>{
 const queue=new SessionOperations(), pending=Promise.withResolvers<void>(),order:string[]=[]
 const first=queue.run('a',async()=>{await pending.promise;order.push('first');throw Error('first')})
 const rejected=expect(first).rejects.toThrow('first')
 const second=queue.run('a',async()=>{order.push('second')})
 await queue.run('b',async()=>{order.push('independent')})
 expect(order).toEqual(['independent']);pending.resolve();await rejected;await second
 expect(order).toEqual(['independent','first','second'])
})

it('explicitly selecting the already prepared environment reuses the same guest snapshot',async()=>{
 const {ports}=fixture();const first=await prepareEnvironment(ports,'s',null,{},signal)
 const explicit=await prepareEnvironment(ports,'s',null,{environmentId:env1},signal)
 const again=await prepareEnvironment(ports,'s',null,{},signal)
 expect(explicit.id).toBe(first.id);expect(again.id).toBe(first.id);expect(ports.create).toHaveBeenCalledOnce()
})
