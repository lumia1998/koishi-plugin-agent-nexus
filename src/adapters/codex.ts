import { CodeAgentAdapter, type DelegateOptions } from './base'
import { quoteShell } from '../utils/shell'

export class CodexAdapter extends CodeAgentAdapter {
    readonly kind = 'codex' as const
    readonly binNames = ['codex']

    skillDirs(home: string) {
        return [`${home}/.codex/skills`, `${home}/.agents/skills`]
    }

    buildInnerCommand(promptExpr: string, options: DelegateOptions) {
        const parts = ['codex', 'exec', '--skip-git-repo-check']
        if (options.cwd) {
            parts.push('-C', quoteShell(options.cwd))
        }
        if (options.model) {
            parts.push('-m', quoteShell(options.model))
        }
        parts.push('--dangerously-bypass-approvals-and-sandbox')
        parts.push(promptExpr)
        return parts.join(' ')
    }
}
