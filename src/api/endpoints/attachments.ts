export type AttachmentMode = 'download' | 'inline'

/** 인증 쿠키가 적용되는 same-origin 비공개 첨부 경로다. */
export function attachmentUrl(
  attachmentId: string,
  mode: AttachmentMode = 'download',
): string {
  const path = `/api/attachments/${encodeURIComponent(attachmentId)}`
  return mode === 'inline' ? `${path}?mode=inline` : path
}
