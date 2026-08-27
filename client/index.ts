import { Context, icons } from '@koishijs/client'
import page from './page.vue'
import AgentNexusIcon from './icons/agent-nexus.vue'

icons.register('activity:agent-nexus', AgentNexusIcon)

export default (ctx: Context) => {
    ctx.page({
        id: 'agent-nexus',
        name: 'Agent 中枢',
        path: '/agent-nexus',
        icon: 'activity:agent-nexus',
        order: 80,
        component: page
    })
}
