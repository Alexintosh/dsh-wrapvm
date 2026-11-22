/** Fixed guest program. Payloads are JSON on stdin, never interpolated shell code. */
export const GUEST_WORKSPACE_PROGRAM = String.raw`
import os, sys, json, stat, hashlib, base64, tempfile, shutil
p=json.load(sys.stdin)
root=p['root']
if not root.startswith('/home/user/workspace/projects/') or any(x in ('','.', '..') for x in root.split('/')[1:]): raise ValueError('invalid workspace root')
def directory(path, create=False):
    current='/'
    for part in path.split('/')[1:]:
        current=os.path.join(current,part)
        if create:
            try: os.mkdir(current,0o700)
            except FileExistsError: pass
        if not stat.S_ISDIR(os.lstat(current).st_mode): raise ValueError('symlink or non-directory in workspace')
def path_for(base,name):
    if not name or name.startswith('/') or '\\' in name or any(x in ('','.', '..') for x in name.split('/')) or any(ord(x)<32 for x in name): raise ValueError('invalid relative path')
    return os.path.join(base,name)
def read(path):
    directory(os.path.dirname(path))
    fd=os.open(path, os.O_RDONLY|os.O_NOFOLLOW)
    with os.fdopen(fd,'rb') as f:
        info=os.fstat(f.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1 or info.st_size>2097152: raise ValueError('unsupported file')
        data=f.read(2097153)
        if len(data)>2097152: raise ValueError('file too large')
        return data, bool(info.st_mode & 0o111)
def write_new(base,item):
    path=path_for(base,item['path']); directory(os.path.dirname(path),True)
    data=base64.b64decode(item['data'],validate=True)
    if len(data)>2097152 or hashlib.sha256(data).hexdigest()!=item['hash']: raise ValueError('invalid file data')
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o700 if item['executable'] else 0o600)
    with os.fdopen(fd,'wb') as f: f.write(data)
action=p['action']
marker=os.path.join(root,'.wrapvm-snapshot.json')
if action=='probe':
    if not os.path.lexists(root): print(json.dumps({'ready':False}))
    else:
        directory(root)
        data,_=read(marker)
        if json.loads(data)['snapshot']!=p['snapshot']: raise ValueError('workspace belongs to another snapshot')
        print(json.dumps({'ready':True}))
elif action=='install':
    directory(os.path.dirname(root),True)
    if os.path.lexists(root): raise ValueError('workspace already exists; probe before retry')
    stage=tempfile.mkdtemp(prefix='.wrapvm-stage-',dir=os.path.dirname(root))
    try:
        for item in p['files']: write_new(stage,item)
        with open(os.path.join(stage,'.wrapvm-snapshot.json'),'x') as f: json.dump({'snapshot':p['snapshot']},f)
        if os.path.lexists(root): raise ValueError('workspace appeared during preparation')
        os.rename(stage,root)
        print(json.dumps({'ready':True}))
    finally:
        if os.path.isdir(stage) and not os.path.islink(stage): shutil.rmtree(stage)
elif action=='import':
    directory(root); imported=[]; unchanged=[]; conflicts=[]
    for item in p['files']:
        path=path_for(root,item['path'])
        if os.path.lexists(path):
            data,_=read(path)
            if hashlib.sha256(data).hexdigest()==item['hash']: unchanged.append(item['path'])
            else: conflicts.append(item['path'])
        else:
            try: write_new(root,item); imported.append(item['path'])
            except FileExistsError: conflicts.append(item['path'])
    print(json.dumps({'imported':imported,'unchanged':unchanged,'conflicts':conflicts}))
elif action=='read':
    directory(root); result=[]; total=0
    for name in p['paths']:
        data,executable=read(path_for(root,name)); total+=len(data)
        if len(result)>=100 or total>67108864: raise ValueError('export limit exceeded')
        result.append({'path':name,'hash':hashlib.sha256(data).hexdigest(),'size':len(data),'executable':executable,'data':base64.b64encode(data).decode()})
    print(json.dumps({'files':result}))
else: raise ValueError('unknown workspace operation')
`
