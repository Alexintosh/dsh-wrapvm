// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { allowAllAccess, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { WrapvmSection } from '../src/client/panel.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)
const unused = (): never => { throw new Error('unused') }
const standard: GlobalStandardProps = { ...allowAllAccess, usePanelInfo: unused, useSessions: selector => selector({ byId: {} } as never), useSessionStatus: unused, useSessionRetainInfo: unused, useWorkspaces: unused, useResource: unused, useContextMenu: unused }
it('shows when conversation access is unavailable', () => {
  render(<WrapvmSection {...standard} close={() => {}} t={makeTranslate(en)} readRemote={null} />)
  expect(screen.getByText(en.sessionUnavailable)).toBeTruthy()
})
