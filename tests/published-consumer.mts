import Wrapvm from '@deepseek-ai/dsh-wrapvm-isolate'
import remote from '@deepseek-ai/dsh-wrapvm-isolate/remote'
import type { VmOperationView, VmRemovalPreview } from '@deepseek-ai/dsh-wrapvm-isolate/types'
const contribution = remote
const operation: VmOperationView | undefined = undefined
const preview: VmRemovalPreview | undefined = undefined
void [contribution, operation, preview]

const image: string | undefined = ({} as ConstructorParameters<typeof Wrapvm>[1]).agentImage
void image
