import { CodeAgentAdapter, type DelegateOptions } from './base'
import { quoteShell } from '../utils/shell'

export class ClaudeAdapter extends CodeAgentAdapter {
    readonly kind = 'claude' as const
    readonly binNames = ['claude']

    skillDirs(home: string) {
        return [`${home}/.claude/skills`]
    }

    buildInnerCommand(promptExpr: string, options: DelegateOptions) {
        const parts = [
            'claude',
            '-p',
            promptExpr,
            '--output-format',
            'json',
            '--no-session-persistence'
        ]
        if (options.model) {
            parts.push('--model', quoteShell(options.model))
        }
        parts.push('--dangerously-skip-permissions')
        return parts.join(' ')
    }
}
