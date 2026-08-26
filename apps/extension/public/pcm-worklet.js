// Downmixes to mono and posts 128-sample Float32 frames to the offscreen page.
class PcmCapture extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input.length > 0) {
      const ch0 = input[0];
      if (input.length === 1) {
        this.port.postMessage(ch0.slice(0));
      } else {
        const mixed = new Float32Array(ch0.length);
        for (let c = 0; c < input.length; c++) {
          const ch = input[c];
          for (let i = 0; i < ch.length; i++) mixed[i] += ch[i] / input.length;
        }
        this.port.postMessage(mixed);
      }
    }
    return true;
  }
}
registerProcessor('pcm-capture', PcmCapture);
