import { Markup } from 'telegraf'

export interface PaginationMeta {
  page: number
  totalPages: number
}

export function paginationButtons(meta: PaginationMeta, viewName: string) {
  const buttons: ReturnType<typeof Markup.button.callback>[] = []
  if (meta.page > 0) {
    buttons.push(Markup.button.callback('◀️ Prev', `page:${viewName}:prev`))
  }
  buttons.push(Markup.button.callback(`📄 ${meta.page + 1}/${meta.totalPages}`, 'noop'))
  if (meta.page < meta.totalPages - 1) {
    buttons.push(Markup.button.callback('Next ▶️', `page:${viewName}:next`))
  }
  return buttons
}

export function paginate<T>(items: T[], page: number, perPage: number) {
  const totalPages = Math.max(1, Math.ceil(items.length / perPage))
  const start = page * perPage
  return {
    pageItems: items.slice(start, start + perPage),
    totalPages,
  }
}
