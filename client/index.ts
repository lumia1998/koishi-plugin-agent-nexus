import { Context } from '@koishijs/client'
import page from './page.vue'

export default (ctx: Context) => {
    ctx.page({
        id: 'agent-nexus',
        name: 'AgentNexus',
        path: '/agent-nexus',
        order: 80,
        component: page
    })
}
