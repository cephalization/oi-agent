/** `104857600` as `100.0 MB`. */
export const formatBytes = (bytes: number): string => {
  if (bytes < 1e6) return `${(bytes / 1e3).toFixed(1)} kB`

  return bytes < 1e9 ? `${(bytes / 1e6).toFixed(1)} MB` : `${(bytes / 1e9).toFixed(2)} GB`
}
