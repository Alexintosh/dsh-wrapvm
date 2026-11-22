import { appendFileSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
const root = dirname(process.argv[1])
const args = process.argv.slice(2)
appendFileSync(join(root, 'calls.jsonl'), JSON.stringify(args) + '\n')
const state = readFileSync(join(root, 'state'), 'utf8')
if (existsSync(join(root, 'managed'))) {
  const labels = { 'dsh.wrapvm.environment': '1', 'dsh.wrapvm.environment-id': 'env-1' }
  const network = 'dsh-wrapvm-env-1', volume = network + '-data'
  const ports = { '6080/tcp': [{ HostIp: '127.0.0.1', HostPort: '55000' }], '9223/tcp': [{ HostIp: '127.0.0.1', HostPort: '55001' }] }
  if (args[0] === 'ps') { process.stdout.write(args.includes('{{json .}}') ? JSON.stringify({ ID: 'container-1', State: state, Image: 'image' }) : 'container-1'); process.exit(0) }
  if (args[0] === 'inspect') { process.stdout.write(JSON.stringify({ Id: 'container-1', Image: 'sha256:aaaabbbbccccdddd', State: { Status: state }, Config: { Image: 'image', Labels: labels }, HostConfig: { Memory: 4294967296, NanoCpus: 2000000000, NetworkMode: network, PortBindings: ports }, NetworkSettings: { Networks: { [network]: { NetworkID: state === 'exited' ? '' : 'net-1' } }, Ports: state === 'exited' ? {} : ports }, Mounts: [{ Type: 'volume', Name: volume, Destination: '/home/user/workspace', RW: true }] })); process.exit(0) }
  if (args[0] === 'network' && args[1] === 'inspect') { process.stdout.write(JSON.stringify({ Name: network, Id: 'net-1', Labels: labels })); process.exit(0) }
  if (args[0] === 'volume' && args[1] === 'inspect') { process.stdout.write(JSON.stringify({ Name: volume, Driver: 'local', Labels: labels })); process.exit(0) }
  if (args[0] === 'exec' && args.at(-1)?.includes('/json/list')) { process.stdout.write(JSON.stringify([{ id: 'page-1', title: 'Fixture', url: 'about:blank' }])); process.exit(0) }
  if (args[0] === 'exec' && args.includes('wrap-desktop') && args.includes('/opt/wrap/bin/wrap-entrypoint')) { process.stdout.write(args.at(-1) + (existsSync(join(root, 'viewer-without-token')) ? '/' : '/?token=fixture-viewer-secret')); process.exit(0) }
  if (args[0] === 'exec') { process.stdout.write('guest output'); process.exit(0) }
  if (['start', 'stop', 'pause', 'unpause'].includes(args[0])) { writeFileSync(join(root, 'state'), ({ start: 'running', stop: 'exited', pause: 'paused', unpause: 'running' })[args[0]]); process.exit(0) }
  if (args[0] === 'stats') { process.exit(0) }
  throw new Error('unexpected managed fixture command: ' + args.join(' '))
}
if ((state === 'hold-status' && args[0] === 'ps') || args.includes('hold-shell') || args.includes('hold-desktop')) {
  writeFileSync(join(root, 'held-pid'), String(process.pid))
  await new Promise(resolve => setTimeout(resolve, 60_000))
}
if (state === 'unavailable') { process.stderr.write('engine unavailable'); process.exit(1) }
if (args[0] === 'ps') { process.stdout.write(state === 'missing' ? '' : state); process.exit(0) }
if (args[0] === 'run' || args[0] === 'start') { writeFileSync(join(root, 'state'), 'running'); process.exit(0) }
if (args[0] === 'stop') { writeFileSync(join(root, 'state'), 'exited'); process.exit(0) }
if (args[0] !== 'exec') throw new Error('unexpected command')
if (args.includes('agent-desktop')) { process.stdout.write('desktop applications'); process.exit(0) }
if (args.includes('sh')) {
  process.stdout.write('guest output\n')
  process.stderr.write('guest diagnostic\n')
  process.exit(7)
}
if (args.includes('wrap-desktop')) { process.stdout.write(args.at(-1) + '/?token=fixture-viewer-secret'); process.exit(0) }
const url = args.at(-1)
if (url.includes('/json/new?')) { process.stdout.write(JSON.stringify({ id: 'page-1' })); process.exit(0) }
if (url.includes('/json/close/')) { process.stdout.write('Target is closing'); process.exit(0) }
if (url.includes('/json/list')) { process.stdout.write(JSON.stringify([{ id: 'page-1', title: 'Test page', url: 'about:blank' }])); process.exit(0) }
if (url.includes('/json/version')) { process.stdout.write('{}'); process.exit(0) }
throw new Error('unexpected exec')
