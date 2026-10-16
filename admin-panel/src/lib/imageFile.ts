/**
 * Browser-only image helper for the Settings page (logo, invoice signature, payment QR): reads a file, downscales
 * it on a canvas and returns a PNG / WebP / JPEG data URL small enough to be stored inline in Firestore (no Storage
 * on Spark). Fast path: the file is decoded off the main thread (createImageBitmap) and encoded asynchronously
 * (canvas.toBlob), so a large photo no longer freezes the page; only the chosen result is turned into a data URL.
 */
import { dataUrlStoredBytes, fitWithin, formatBytes, MAX_IMAGE_BYTES } from './branding'

export interface CompressOptions {
  maxWidth: number
  maxHeight: number
  maxBytes?: number
  /** Try a (transparent) PNG first; WebP keeps transparency too; the JPEG fallback gets a white background. Default true. */
  preferPng?: boolean
}

/** Length of the data URL a blob of `size` bytes and MIME `type` becomes (base64). */
export function dataUrlLength(type: string, size: number): number {
  return `data:${type};base64,`.length + 4 * Math.ceil(size / 3)
}

interface Decoded {
  src: CanvasImageSource
  w: number
  h: number
  close: () => void
}

async function decode(file: Blob): Promise<Decoded> {
  if (typeof createImageBitmap === 'function' && file.type !== 'image/svg+xml') {
    try {
      const bmp = await createImageBitmap(file)
      return { src: bmp, w: bmp.width, h: bmp.height, close: () => bmp.close() }
    } catch {
      /* fall back to an <img> element (older browsers, unusual encodings) */
    }
  }
  const url = URL.createObjectURL(file)
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image()
      i.onload = () => resolve(i)
      i.onerror = () => reject(new Error('This file could not be read as an image.'))
      i.src = url
    })
    return { src: img, w: img.naturalWidth || img.width || 512, h: img.naturalHeight || img.height || 512, close: () => URL.revokeObjectURL(url) }
  } catch (e) {
    URL.revokeObjectURL(url)
    throw e
  }
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality))
}

function blobToDataUrl(b: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(new Error('The compressed image could not be read.'))
    r.readAsDataURL(b)
  })
}

/**
 * Browser only: reads an image file, downscales it on a canvas and returns a data URL under maxBytes.
 * Order per size step: PNG (sharp QR codes / transparent logos) → WebP (transparent, much smaller) → JPEG.
 */
export async function compressImageFile(file: Blob, opts: CompressOptions): Promise<string> {
  const max = opts.maxBytes ?? MAX_IMAGE_BYTES
  if (!/^image\/(png|jpeg|webp|gif|bmp|svg\+xml)$/.test(file.type)) throw new Error('Choose a PNG, JPEG, WebP, GIF or SVG image.')
  if (file.size > 15 * 1024 * 1024) throw new Error('The image file is too large (over 15 MB).')
  const img = await decode(file)
  try {
    const fits = (b: Blob | null, type: string): boolean => !!b && b.type === type && dataUrlLength(type, b.size) <= max
    let png: { size: number; scale: number } | null = null
    let webpOk = true
    for (const scale of [1, 0.8, 0.6, 0.45, 0.33]) {
      const { width, height } = fitWithin(img.w, img.h, opts.maxWidth * scale, opts.maxHeight * scale)
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('Canvas is not available in this browser.')
      ctx.imageSmoothingEnabled = true
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(img.src, 0, 0, width, height)
      // PNG is skipped when the previous size step shows it cannot fit (photos): saves a slow lossless encode.
      const pngWorth = opts.preferPng !== false && (!png || png.size * (scale / png.scale) ** 2 <= max * 1.4)
      if (pngWorth) {
        const b = await toBlob(canvas, 'image/png')
        if (b && fits(b, 'image/png')) return blobToDataUrl(b)
        if (b) png = { size: dataUrlLength('image/png', b.size), scale }
      }
      if (webpOk) {
        for (const q of [0.92, 0.85, 0.75]) {
          const b = await toBlob(canvas, 'image/webp', q)
          if (!b || b.type !== 'image/webp') {
            webpOk = false // this browser cannot encode WebP
            break
          }
          if (fits(b, 'image/webp')) return blobToDataUrl(b as Blob)
        }
      }
      ctx.globalCompositeOperation = 'destination-over'
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, width, height)
      ctx.globalCompositeOperation = 'source-over'
      for (const q of [0.9, 0.82, 0.72, 0.6]) {
        const b = await toBlob(canvas, 'image/jpeg', q)
        if (b && fits(b, 'image/jpeg')) return blobToDataUrl(b)
      }
    }
    throw new Error(`The image could not be compressed under ${formatBytes(max)}. Use a simpler or smaller image.`)
  } finally {
    img.close()
  }
}

/** Re-exported for callers that check a stored value. */
export { dataUrlStoredBytes }
