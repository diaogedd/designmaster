globalThis.openCoworkExtension = {
  handlers: {
    async showTable() {
      const rows = [
        { name: 'Alpha', value: 3, status: 'ready' },
        { name: 'Beta', value: 7, status: 'running' },
        { name: 'Gamma', value: 2, status: 'queued' }
      ]

      return {
        text: 'Here is a table from a sandboxed extension handler.',
        data: rows,
        ui: {
          kind: 'table',
          columns: ['name', 'value', 'status'],
          rows
        }
      }
    },

    async showHtml(input) {
      const title =
        typeof input.title === 'string' && input.title.trim()
          ? input.title.trim()
          : 'Demo Extension'

      return {
        text: 'Rendered with a custom sandbox HTML renderer.',
        data: {
          generatedAt: new Date().toISOString()
        },
        ui: {
          kind: 'html',
          renderer: 'summary_card',
          props: {
            title,
            subtitle: 'This iframe receives props through postMessage.',
            rows: [
              { label: 'Runtime', value: 'sandbox iframe' },
              { label: 'Direct network', value: 'blocked' },
              { label: 'Host bridge', value: 'ctx.fetch / ctx.storage / ctx.config' }
            ]
          }
        }
      }
    }
  }
}
