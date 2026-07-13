import { Context, Schema } from 'koishi'
import { AgentNexusService } from './service'
import { Config as PluginConfig, Config as ConfigSchema, name as pluginName } from './config'
import * as webui from './webui'

export const name = pluginName
export const inject = {
    required: ['chatluna'],
    optional: ['console', 'server', 'chatluna_storage']
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
export { AgentNexusService }
