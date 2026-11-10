import type { HealthUploadAPI } from '../upload-entry';

/** A loader for the upload bundle (upload-entry.ts), added lazily on first use.
 *  Each loader caches its promise, which prevents duplicate script injection. */
export function createUploadBundleLoader(): () => Promise<HealthUploadAPI> {
  let loadPromise: Promise<HealthUploadAPI> | null = null;
  return () => {
    if (window.HealthUpload) return Promise.resolve(window.HealthUpload);
    if (loadPromise) return loadPromise;

    const root = document.getElementById('health-tool-root');
    const src = root?.dataset.uploadUrl;
    if (!src) return Promise.reject(new Error('Upload bundle URL not found'));

    loadPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.onload = () => {
        const upload = window.HealthUpload;
        if (upload) {
          resolve(upload);
        } else {
          loadPromise = null;
          reject(new Error('Upload bundle loaded but HealthUpload not found'));
        }
      };
      script.onerror = () => {
        loadPromise = null;
        reject(new Error('Failed to load upload bundle'));
      };
      document.head.appendChild(script);
    });
    return loadPromise;
  };
}
