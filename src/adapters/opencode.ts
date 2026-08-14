import { CodeAgentAdapter } from './base'

export class OpenCodeAdapter extends CodeAgentAdapter {
    readonly kind = 'opencode' as const
    readonly binNames = ['opencode']

    skillDirs(home: string) {
        return [
            `${home}/.config/opencode/skills`,
            `${home}/.opencode/skills`,
            `${home}/.claude/skills`
        ]
    }
}
