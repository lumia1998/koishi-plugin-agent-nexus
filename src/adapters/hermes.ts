import { CodeAgentAdapter, type DelegateOptions } from './base'

export class HermesAdapter extends CodeAgentAdapter {
    readonly kind = 'hermes' as const
    readonly binNames = ['hermes']

    skillDirs(home: string) {
        return [`${home}/.hermes/skills`]
    }

    buildInnerCommand(promptExpr: string, _options: DelegateOptions) {
        return `hermes -z ${promptExpr}`
    }
}
