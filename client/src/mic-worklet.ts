// Microphone capture: turns the browser's audio (usually 48 kHz float) into 16 kHz 16-bit PCM
// frames for Deepgram, and reports the input level for the on-screen meter.
// Runs in the browser's audio thread (an AudioWorklet), which has these globals:
declare const sampleRate: number;
declare function registerProcessor(name: string, processor: typeof MicCapture): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

interface MicOptions {
  processorOptions?: { targetRate?: number; frameMs?: number };
}

class MicCapture extends AudioWorkletProcessor {
  step: number;
  frame: Int16Array;
  filled = 0;
  sum = 0;
  count = 0;
  phase = 0;
  peak = 0;

  constructor(options: MicOptions) {
    super();
    const opts = options.processorOptions || {};
    const targetRate = opts.targetRate || 16000;
    this.step = sampleRate / targetRate; // input samples per output sample
    this.frame = new Int16Array(Math.round((targetRate * (opts.frameMs || 40)) / 1000));
  }

  process(inputs: Float32Array[][]) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    for (let i = 0; i < channel.length; i++) {
      // Average the input samples that fall into each output sample (a simple low-pass + decimate).
      this.sum += channel[i];
      this.count++;
      this.phase++;
      if (this.phase >= this.step) {
        this.phase -= this.step;
        const v = Math.max(-1, Math.min(1, this.sum / this.count));
        this.sum = 0;
        this.count = 0;
        this.peak = Math.max(this.peak, Math.abs(v));
        this.frame[this.filled++] = v < 0 ? v * 0x8000 : v * 0x7fff;
        if (this.filled === this.frame.length) {
          const pcm = this.frame.buffer.slice(0);
          this.port.postMessage({ pcm, level: this.peak }, [pcm]);
          this.filled = 0;
          this.peak = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor("mic-capture", MicCapture);

export {};
