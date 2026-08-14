import { CodeAgentAdapter } from './base'

export class OpenClawAdapter extends CodeAgentAdapter {
    readonly kind = 'openclaw' as const
    readonly binNames = ['openclaw']

    skillDirs(home: string) {
        return [`${home}/.openclaw/skills`, `${home}/.openclaw/workspace/skills`]
    }
}
