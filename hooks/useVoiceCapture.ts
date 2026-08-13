/**
 * Microphone capture for the command center.
 *
 * Mirrors the recording semantics of BB's own composer voice input — the same
 * mime preference order, the same one-second floor, the same filename shape
 * (the server forwards that name to the transcription backend, which infers the
 * audio format from its extension) — then hands the clip to a caller-supplied
 * uploader instead of talking to the API itself.
 */
import * as React from "react";

export type VoiceCaptureState =
  | "idle"
  | "recording"
  | "transcribing"
  | "error";

const MIN_RECORDING_DURATION_MS = 1_000;
const CHUNK_TIMESLICE_MS = 250;
/** Roughly 3 minutes of opus; well inside the transcription size ceiling. */
const MAX_RECORDING_MS = 180_000;

function preferredMimeType(): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  for (const candidate of ["audio/webm", "audio/mp4", "audio/ogg"]) {
    if (MediaRecorder.isTypeSupported(candidate)) return candidate;
  }
  return null;
}

function extensionFor(mimeType: string): string {
  if (mimeType.includes("ogg")) return "ogg";
  if (mimeType.includes("mp4")) return "mp4";
  return "webm";
}

function describeCaptureError(error: unknown): string {
  if (error instanceof DOMException) {
    switch (error.name) {
      case "NotAllowedError":
      case "SecurityError":
        return "Microphone permission denied";
      case "NotFoundError":
      case "DevicesNotFoundError":
        return "No microphone was found";
      case "NotReadableError":
      case "TrackStartError":
        return "Microphone is already in use";
      case "AbortError":
        return "Voice capture was aborted";
      default:
        return "Failed to start voice recording";
    }
  }
  if (error instanceof Error && error.message.trim() !== "") {
    return error.message.replace(/^HTTP\s+\d{3}:\s*/iu, "").trim();
  }
  return "Voice input failed";
}

export interface VoiceClip {
  base64: string;
  mimeType: string;
  filename: string;
}

async function toClip(blob: Blob, mimeType: string): Promise<VoiceClip> {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  // Chunked so a long clip cannot blow the argument limit of fromCharCode.
  for (let offset = 0; offset < bytes.length; offset += 8_192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8_192));
  }
  return {
    base64: btoa(binary),
    mimeType,
    filename: `recording.${extensionFor(mimeType)}`,
  };
}

interface UseVoiceCaptureOptions {
  /** Receives the finished clip; throw to surface an error to the user. */
  onClip: (clip: VoiceClip) => Promise<void>;
  onError?: (message: string) => void;
}

export function useVoiceCapture({ onClip, onError }: UseVoiceCaptureOptions) {
  const recorderRef = React.useRef<MediaRecorder | null>(null);
  const streamRef = React.useRef<MediaStream | null>(null);
  const chunksRef = React.useRef<Blob[]>([]);
  const startedAtRef = React.useRef<number | null>(null);
  const keepRef = React.useRef(true);
  const timeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const onClipRef = React.useRef(onClip);
  const onErrorRef = React.useRef(onError);

  React.useEffect(() => {
    onClipRef.current = onClip;
    onErrorRef.current = onError;
  }, [onClip, onError]);

  const [state, setState] = React.useState<VoiceCaptureState>("idle");

  const isSupported = React.useMemo(
    () =>
      typeof window !== "undefined" &&
      typeof window.MediaRecorder !== "undefined" &&
      typeof navigator !== "undefined" &&
      Boolean(navigator.mediaDevices?.getUserMedia),
    [],
  );

  const fail = React.useCallback((message: string) => {
    setState("error");
    onErrorRef.current?.(message);
  }, []);

  const releaseStream = React.useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  const clearTimer = React.useCallback(() => {
    if (timeoutRef.current !== null) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  React.useEffect(
    () => () => {
      clearTimer();
      const recorder = recorderRef.current;
      if (recorder !== null && recorder.state === "recording") {
        keepRef.current = false;
        try {
          recorder.stop();
        } catch {
          // The panel is going away; nothing to report.
        }
      }
      recorderRef.current = null;
      chunksRef.current = [];
      releaseStream();
    },
    [clearTimer, releaseStream],
  );

  const start = React.useCallback(async () => {
    if (!isSupported) {
      fail("Voice input is not supported here");
      return;
    }
    if (state === "recording" || state === "transcribing") return;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      chunksRef.current = [];
      startedAtRef.current = Date.now();
      keepRef.current = true;

      const mimeType = preferredMimeType();
      const recorder =
        mimeType !== null
          ? new MediaRecorder(stream, { mimeType })
          : new MediaRecorder(stream);
      recorderRef.current = recorder;

      recorder.onstart = () => setState("recording");
      recorder.ondataavailable = (event: BlobEvent) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onerror = () => fail("Voice recording failed");
      recorder.onstop = () => {
        clearTimer();
        releaseStream();
        const chunks = chunksRef.current;
        chunksRef.current = [];
        const startedAt = startedAtRef.current ?? Date.now();
        startedAtRef.current = null;

        if (!keepRef.current) {
          keepRef.current = true;
          setState("idle");
          return;
        }
        if (Date.now() - startedAt < MIN_RECORDING_DURATION_MS) {
          fail("Too short — hold the mic for at least a second");
          return;
        }
        if (chunks.length === 0) {
          fail("No audio was captured");
          return;
        }

        const recordedType = recorder.mimeType || mimeType || "audio/webm";
        setState("transcribing");
        void (async () => {
          try {
            await onClipRef.current(
              await toClip(new Blob(chunks, { type: recordedType }), recordedType),
            );
            setState("idle");
          } catch (error) {
            fail(describeCaptureError(error));
          }
        })();
      };

      recorder.start(CHUNK_TIMESLICE_MS);
      timeoutRef.current = setTimeout(() => {
        if (recorderRef.current?.state === "recording") {
          recorderRef.current.stop();
        }
      }, MAX_RECORDING_MS);
    } catch (error) {
      clearTimer();
      releaseStream();
      recorderRef.current = null;
      chunksRef.current = [];
      startedAtRef.current = null;
      fail(describeCaptureError(error));
    }
  }, [clearTimer, fail, isSupported, releaseStream, state]);

  const stop = React.useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder === null || recorder.state !== "recording") return;
    keepRef.current = true;
    try {
      recorder.stop();
    } catch (error) {
      fail(describeCaptureError(error));
    }
  }, [fail]);

  const cancel = React.useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder !== null && recorder.state === "recording") {
      keepRef.current = false;
      try {
        recorder.stop();
      } catch {
        // Already stopping.
      }
      return;
    }
    setState("idle");
  }, []);

  const toggle = React.useCallback(() => {
    if (state === "recording") stop();
    else if (state !== "transcribing") void start();
  }, [start, state, stop]);

  return {
    state,
    isSupported,
    isRecording: state === "recording",
    isTranscribing: state === "transcribing",
    start,
    stop,
    cancel,
    toggle,
  };
}
