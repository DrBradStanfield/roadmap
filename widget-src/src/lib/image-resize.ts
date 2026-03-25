/**
 * Client-side image resize via canvas.
 * Bundled in health-upload.js (separate IIFE).
 */

/**
 * Resize an image file to fit within maxDim × maxDim, preserving aspect ratio.
 * Returns base64-encoded JPEG (without the data:image/jpeg;base64, prefix).
 */
export async function resizeImage(file: File, maxDim: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);

    img.onload = () => {
      URL.revokeObjectURL(url);

      let { width, height } = img;
      if (width > maxDim || height > maxDim) {
        const ratio = Math.min(maxDim / width, maxDim / height);
        width = Math.round(width * ratio);
        height = Math.round(height * ratio);
      }

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Failed to get canvas 2D context');
      ctx.drawImage(img, 0, 0, width, height);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
      resolve(dataUrl.split(',')[1]);
    };

    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(`Failed to load image: ${file.name}`));
    };

    img.src = url;
  });
}

/** Returns true if file is an image */
export function isImage(file: File): boolean {
  return /\.(jpe?g|png|heic)$/i.test(file.name) || file.type.startsWith('image/');
}
