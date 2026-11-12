/** Bundled VM guidance. These strings never read paths supplied by a caller. */
const common = 'Do not fall back to Mac tools or change permissions yourself. Do not restart or delete an environment to troubleshoot. Runtime policy and current status take precedence over earlier conversation text.'

/** Fixed guidance distributed with the bundle. */
const vmSkills = Object.freeze({
  'use-vm': `Ask the user to select a VM environment for this conversation using the desktop panel. The selection routes vm_* tools only; ordinary host tools remain available. ${common}`,
  'vm-workspace': `Use vm_shell with {command, description, workdir?, timeoutMs?}; workdir is an absolute guest path and defaults to /home/user/workspace. Install dependencies and work with files in the guest. Host import/export requires an explicit user-approved operation; do not assume it is available. ${common}`,
  'vm-browser': `Use vm_browser with action open, tabs, navigate, eval, content, or close. open requires url; navigate requires targetId and url; eval requires targetId and expression; content and close require targetId. Use the target id returned by tabs or open. Inspect the page before interacting and allow time for it to load. ${common}`,
  'vm-desktop': `Use vm_desktop with {argv, timeoutMs?}; argv is passed literally to agent-desktop in the guest. Inspect the desktop and identify the intended application before input. ${common}`,
  'vm-development': `Run development commands with vm_shell in the guest. Open guest-local services in vm_browser. A persistent guest process facility is not available until vm_process is registered; do not substitute a host job or claim that a detached command is managed. ${common}`,
  'vm-recovery': `If the environment is stopped, paused, unavailable, or a request times out, report the observed state and ask the user to use the environment controls. Check the result before retrying an operation whose outcome is uncertain. ${common}`,
} as const)

/** Names accepted by the bundled skill loader. */
export const vmSkillNames: readonly (keyof typeof vmSkills)[] = Object.freeze(Object.keys(vmSkills) as (keyof typeof vmSkills)[])

/** Read a bundled skill by exact name, rejecting all other input. */
export function readVmSkill(name: string): string {
  if (!Object.hasOwn(vmSkills, name)) throw new Error('load_vm_skill: unknown bundled VM skill')
  return vmSkills[name as keyof typeof vmSkills]
}
