import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const installed = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/'
const resolveInstalled = createRequire(`${installed}package.json`)

export async function resolve(specifier, context, nextResolve) {
  if (context.parentURL?.startsWith(new URL('../lib/', import.meta.url).href) && !specifier.startsWith('.') && !specifier.startsWith('node:')) {
    const path = resolveInstalled.resolve(specifier)
    return { url: pathToFileURL(path).href, shortCircuit: true }
  }
  return nextResolve(specifier, context)
}
