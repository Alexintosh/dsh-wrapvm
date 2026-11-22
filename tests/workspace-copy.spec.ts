import { afterEach, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, symlink, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { snapshotProject, exportReview, projectRoot, filePath } from '../src/workspace-copy.ts'
const dirs: string[] = []
const signal = new AbortController().signal
async function fixture() { await mkdir('.dev/projects',{recursive:true}); const path = await mkdtemp(join(process.cwd(), '.dev/projects/wrapvm-copy-')); dirs.push(path); return await projectRoot(path) }
afterEach(async () => { for (const path of dirs.splice(0)) await rm(path, { recursive: true, force: true }) })
it('includes uncommitted/untracked working files, omits dependencies, secrets, Git and symlinks', async () => {
 const root = await fixture()
 await writeFile(join(root,'tracked.txt'),'local edit')
 await writeFile(join(root,'new.txt'),'new file')
 for (const name of ['.env','.env.local','private.pem']) await writeFile(join(root,name),'do not copy')
 for (const name of ['.git','node_modules']) { await mkdir(join(root,name)); await writeFile(join(root,name,'data'),'excluded') }
 await symlink('/etc/passwd',join(root,'external'))
 const snapshot = await snapshotProject(root,signal)
 expect(snapshot.files.map(f=>f.path)).toEqual(['new.txt','tracked.txt'])
 expect(Buffer.from(snapshot.files[1]!.data,'base64').toString()).toBe('local edit')
 expect(snapshot.excludedCount).toBe(6)
})
it('rejects broad roots, traversal, credential paths and oversized files', async () => {
 await expect(projectRoot('/')).rejects.toThrow('unsafe workspace')
 for(const path of ['../secret','/tmp/secret','a/../../b','.ssh/key','nested/.env','a\\b']) expect(()=>filePath(path)).toThrow()
 const root=await fixture(); await writeFile(join(root,'big'),Buffer.alloc(2097153))
 await expect(snapshotProject(root,signal)).rejects.toThrow('oversized')
})
it('exports to a review copy and reports host changes without modifying originals', async () => {
 const root=await fixture(); await writeFile(join(root,'file'),'initial')
 const initial=await snapshotProject(root,signal)
 await writeFile(join(root,'file'),'guest change'); const guest=await snapshotProject(root,signal)
 await writeFile(join(root,'file'),'new host edit')
 const result=await exportReview(root,guest.files,initial.files,signal)
 expect(result.conflicts).toEqual(['file'])
 expect(await readFile(join(root,'file'),'utf8')).toBe('new host edit')
 expect(await readFile(join(result.directory,'file'),'utf8')).toBe('guest change')
 expect((await snapshotProject(root,signal)).files.map(f=>f.path)).toEqual(['file'])
})
it('refuses an export directory symlink and malformed guest payload', async()=>{
 const root=await fixture(); await writeFile(join(root,'file'),'initial')
 const initial=await snapshotProject(root,signal)
 await expect(exportReview(root,[{...initial.files[0]!,path:'../outside'}],[],signal)).rejects.toThrow('relative')
 await symlink(await fixture(),join(root,'.wrapvm-exports'))
 await expect(exportReview(root,initial.files,[],signal)).rejects.toThrow('unsafe export')
})
