import { CodeAgentAdapter } from './base'

export class CodexAdapter extends CodeAgentAdapter {
    readonly kind = 'codex' as const
    readonly binNames = ['codex']

    skillDirs(home: string) {
        return [`${home}/.codex/skills`, `${home}/.agents/skills`]
    }
}
