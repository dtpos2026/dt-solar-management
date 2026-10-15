/**
 * Browser-only image helper for the Settings page (logo, invoice signature, payment QR): reads a file, downscales
 * it on a canvas and returns a PNG / JPEG data URL small enough to be stored inline in Firestore (no Storage on Spark).
 */
import { dataUrlStoredBytes, fitWithin, formatBytes, MAX_IMAGE_BYTES } from './branding'

export interface CompressOptions {
  maxWidth: number
  maxHeight: number
  maxBytes?: number
  /** Try a (transparent) PNG first; the JPEG fallback gets a white background. Default true. */
  preferPng?: boolean
}

/**
 * Browser only: reads an image file, downscales it on a canvas and returns a data URL under maxBytes.
 * Tries PNG first (sharp QR codes / transparent logos), then JPEG (white background) at falling quality and size.
 * PNG / JPEG only, so every PDF and print path can embed the result.
 */
export async function compressImageFile(file: Blob, opts: CompressOptions): Promise<string> {
  const max = opts.maxBytes ?? MAX_IMAGE_BYTES
  if (!/^image\/(png|jpeg|webp|gif|bmp|svg\+xml)$/.test(file.type)) throw new Error('Choose a PNG, JPEG, WebP, GIF or SVG image.')
  if (file.size > 15 * 1024 * 1024) throw new Error('The image file is too large (over 15 MB).')
  const url = URL.createObjectURL(file)
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image()
      i.onload = () => resolve(i)
      i.onerror = () => reject(new Error('This file could not be read as an image.'))
      i.src = url
    })
    const w0 = img.naturalWidth || img.width || 512
    const h0 = img.naturalHeight || img.height || 512
    for (const scale of [1, 0.8, 0.6, 0.45, 0.33]) {
      const { width, height } = fitWithin(w0, h0, opts.maxWidth * scale, opts.maxHeight * scale)
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('Canvas is not available in this browser.')
      ctx.imageSmoothingQuality = 'high'
      if (opts.preferPng !== false) {
        ctx.clearRect(0, 0, width, height)
        ctx.drawImage(img, 0, 0, width, height)
        const png = canvas.toDataURL('image/png')
        if (dataUrlStoredBytes(png) <= max) return png
      }
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, width, height)
      ctx.drawImage(img, 0, 0, width, height)
      for (const q of [0.9, 0.82, 0.72, 0.6]) {
        const jpg = canvas.toDataURL('image/jpeg', q)
        if (dataUrlStoredBytes(jpg) <= max) return jpg
      }
    }
    throw new Error(`The image could not be compressed under ${formatBytes(max)}. Use a simpler or smaller image.`)
  } finally {
    URL.revokeObjectURL(url)
  }
}
