import { Context, Schema } from 'koishi'
import { AgentNexusService } from './service'
import { Config as PluginConfig, Config as ConfigSchema, name as pluginName } from './config'
import * as webui from './webui'

export const name = pluginName
export const inject = {
    required: ['chatluna', 'chatluna_storage'],
    optional: ['console', 'server']
}

export interface Config extends PluginConfig {}
export const Config: Schema<Config> = ConfigSchema

export function apply(ctx: Context, config: Config) {
    ctx.plugin(AgentNexusService, config)

    ctx.using(['console'], (ctx) => {
        ctx.plugin(webui)
    })
}

export * from './types'
export * from './sessions/types'
export * from './sessions/storage'
export * from './sessions/manager'
export * from './runtime/runner'
export { AgentNexusService }
