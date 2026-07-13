import { CodeAgentAdapter, type DelegateOptions } from './base'
import { quoteShell } from '../utils/shell'

export class OpenClawAdapter extends CodeAgentAdapter {
    readonly kind = 'openclaw' as const
    readonly binNames = ['openclaw']

    skillDirs(home: string) {
        return [`${home}/.openclaw/skills`, `${home}/.openclaw/workspace/skills`]
    }

    buildInnerCommand(promptExpr: string, options: DelegateOptions) {
        const agent = options.openclawAgent || options.runtime.openclawAgent || 'default'
        // promptExpr is already quoted shell expression like "$PROMPT"
        // openclaw expects --query value
        return `openclaw agent --local --agent ${quoteShell(agent)} --query ${promptExpr}`
    }
}
