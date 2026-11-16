/**
 * A `t.me/s/<channel>` preview page with the given posts, in the markup Telegram serves (see
 * `test/fixtures/telegram/*.html` for real pages): for tests that need posts at chosen times.
 */
export interface PreviewPost {
  id: number
  /** ISO, as in `<time datetime>` */
  at: string
  text: string
  edited?: boolean
}

const escape = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export function previewPage(channel: string, posts: readonly PreviewPost[]): string {
  const blocks = posts.map(
    (
      p,
    ) => `<div class="tgme_widget_message_wrap js-widget_message_wrap"><div class="tgme_widget_message text_not_supported_wrap js-widget_message" data-post="${channel}/${p.id}">
  <div class="tgme_widget_message_bubble">
    <div class="tgme_widget_message_text js-message_text" dir="auto">${escape(p.text).replace(/\n/g, '<br/>')}</div>
    <div class="tgme_widget_message_footer compact js-message_footer">
      <div class="tgme_widget_message_info short js-message_info">
        <span class="tgme_widget_message_views">1K</span><span class="tgme_widget_message_meta">${p.edited ? 'edited &nbsp;' : ''}<a class="tgme_widget_message_date" href="https://t.me/${channel}/${p.id}"><time datetime="${p.at}" class="time">00:00</time></a></span>
      </div>
    </div>
  </div>
</div></div>`,
  )
  return `<html><body><section class="tgme_channel_history js-message_history">${blocks.join('\n')}</section></body></html>`
}
