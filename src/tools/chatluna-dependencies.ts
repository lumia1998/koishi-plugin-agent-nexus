import { createRequire } from 'module'

const requireFromAgentNexus = createRequire(__filename)
const requireFromChatLuna = createRequire(
    requireFromAgentNexus.resolve('koishi-plugin-chatluna')
)
const langchainTools = requireFromChatLuna('@langchain/core/tools') as any
const zodModule = requireFromChatLuna('zod') as any

export const StructuredTool = langchainTools.StructuredTool
export const z = zodModule.default ?? zodModule.z
export default z
