export const maxUploadBytes = 25 * 1024 * 1024;
export const maxPublicationBytes = 100 * 1024 * 1024;
export const maxUploadFiles = 500;
export const abandonedUploadMilliseconds = 24 * 60 * 60 * 1000;

export const uploadLimits = Object.freeze({
  maxUploadBytes,
  maxPublicationBytes,
  maxUploadFiles,
  abandonedUploadMilliseconds,
});
