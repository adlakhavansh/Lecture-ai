export const ANALYSER_FFT_SIZE = 512;

export interface OffscreenAudioGraph {
  recorderDestination: MediaStreamAudioDestinationNode;
  analyser: AnalyserNode;
  tabSource: MediaStreamAudioSourceNode;
}

/** Creates the Web Audio graph for tab audio capture.
 *  - Tab audio → analyser (for VAD) + recorder destination (for MediaRecorder)
 *  - Tab audio is NOT routed to context.destination (that would play it twice).
 *    The original tab audio continues playing normally via Chrome's own audio routing. */
export function createOffscreenAudioGraph(
  context: AudioContext,
  tabStream: MediaStream,
): OffscreenAudioGraph {
  const recorderDestination = context.createMediaStreamDestination();
  const analyser = context.createAnalyser();
  analyser.fftSize = ANALYSER_FFT_SIZE;

  const tabSource = context.createMediaStreamSource(tabStream);
  tabSource.connect(recorderDestination);
  tabSource.connect(analyser);
  // tabCapture can mute normal playback unless the stream is routed back out.
  tabSource.connect(context.destination);

  return { recorderDestination, analyser, tabSource };
}
