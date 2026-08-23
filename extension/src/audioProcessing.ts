/** Minimal audio processing utilities for Lecture AI. */

export interface VoiceActivityTrackerOptions {
  rmsThreshold: number;
}

/** Tracks whether any speech was observed since the last consume call. */
export class VoiceActivityTracker {
  private readonly rmsThreshold: number;
  private speechObserved = false;

  constructor(options: VoiceActivityTrackerOptions) {
    this.rmsThreshold = options.rmsThreshold;
  }

  observe(rms: number) {
    if (Number.isFinite(rms) && rms >= this.rmsThreshold) {
      this.speechObserved = true;
    }
  }

  consumeShouldFlush(): boolean {
    const shouldFlush = this.speechObserved;
    this.speechObserved = false;
    return shouldFlush;
  }
}

/** Returns true if the blob is large enough to be worth sending for transcription. */
export function isChunkViable(blob: Blob, minBytes = 5000): boolean {
  return !!blob && blob.size >= minBytes;
}

/** Converts a Blob to a base-64 string (data-URL prefix stripped). */
export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    const cleanup = () => {
      reader.onloadend = null;
      reader.onerror = null;
      reader.onabort = null;
    };

    reader.onloadend = () => {
      cleanup();
      const result = reader.result as string;
      const base64 = result.split(",")[1];
      if (base64) resolve(base64);
      else reject(new Error("blobToBase64: no base64 data in result"));
    };
    reader.onerror = () => {
      cleanup();
      reject(reader.error ?? new Error("FileReader failed"));
    };
    reader.onabort = () => {
      cleanup();
      reject(new Error("FileReader read was aborted"));
    };
    reader.readAsDataURL(blob);
  });
}
