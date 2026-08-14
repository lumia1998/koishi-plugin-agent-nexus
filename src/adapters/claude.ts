import { CodeAgentAdapter } from './base'

export class ClaudeAdapter extends CodeAgentAdapter {
    readonly kind = 'claude' as const
    readonly binNames = ['claude']

    skillDirs(home: string) {
        return [`${home}/.claude/skills`]
    }
}
