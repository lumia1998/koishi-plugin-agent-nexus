import 'koishi'
import type {} from '@koishijs/plugin-console'

declare module 'koishi' {
    interface Context {
        chatluna?: any
        server?: {
            selfUrl: string
            get(path: RegExp | string, callback: (ctx: any) => unknown): unknown
            post(path: RegExp | string, callback: (ctx: any) => unknown): unknown
            ws(
                path: RegExp | string,
                callback: (socket: any, request: any) => void
            ): { close(): void }
        }
    }
}
