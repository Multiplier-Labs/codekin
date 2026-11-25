/**
 * Save data the page made as a file. In a browser this is a normal download;
 * the desktop app saves it to the Downloads folder (desktop/src-tauri:
 * `downloads::on_download`).
 */

export function saveFile(data: BlobPart, filename: string, mediaType: string): void {
  const url = URL.createObjectURL(new Blob([data], { type: mediaType }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Revoking at once can cancel the download in Safari.
  setTimeout(() => { URL.revokeObjectURL(url) }, 10_000)
}
