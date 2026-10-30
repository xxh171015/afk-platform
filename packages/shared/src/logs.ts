// What one upload of run log text may hold; the API refuses more, so a worker cuts what it sends into pieces of this size.
export const MAX_LOG_CHUNK_BYTES = 1024 * 1024;
