/**
 * MiOpIIk's only extra delegation policy: require an explicit child route.
 * DSH's native tool remains responsible for route authorization and execution.
 */
export const name = 'dsh-miopiik-policy'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.guard((execution) => {
    if (execution.name !== 'subagent_execute') return undefined

    const args = execution.arguments
    if (
      args === null ||
      typeof args !== 'object' ||
      typeof args.provider !== 'string' ||
      args.provider.trim().length === 0 ||
      typeof args.model !== 'string' ||
      args.model.trim().length === 0
    ) {
      return 'MiOpIIk execution requires explicit non-empty provider and model values.'
    }

    return undefined
  })
}
