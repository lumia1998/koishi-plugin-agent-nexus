export interface Context {
    page(options: {
        name: string
        id?: string
        path: string
        authority?: number
        order?: number
        component: unknown
    }): void
}

export const send: (name: string, ...args: any[]) => Promise<any>
