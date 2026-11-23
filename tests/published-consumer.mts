import Wrapvm from 'dsh-wrapvm-isolate'
import remote from 'dsh-wrapvm-isolate/remote'
import type { VmOperationView, VmRemovalPreview } from 'dsh-wrapvm-isolate/types'
const contribution = remote
const operation: VmOperationView | undefined = undefined
const preview: VmRemovalPreview | undefined = undefined
void [contribution, operation, preview]

const image: string | undefined = ({} as ConstructorParameters<typeof Wrapvm>[1]).agentImage
void image
