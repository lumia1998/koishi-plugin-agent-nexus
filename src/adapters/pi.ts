import { CodeAgentAdapter } from './base'

/** Adapter for the pi-mono coding agent CLI. */
export class PiAdapter extends CodeAgentAdapter {
    readonly kind = 'pi' as const
    readonly binNames = ['pi']

    skillDirs(home: string) {
        return [`${home}/.pi/agent/skills`, `${home}/.pi/skills`]
    }
}
