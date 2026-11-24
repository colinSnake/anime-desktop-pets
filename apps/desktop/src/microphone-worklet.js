/* global AudioWorkletProcessor, registerProcessor */
// Fixed, silent worklet. Audio is transferred once, exclusively to its creating preload.
class PetMicrophone extends AudioWorkletProcessor {
  buffer = new Float32Array(480_000);
  size = 0;
  constructor() {
    super();
    this.port.onmessage = ({ data }) => {
      if (data !== 'stop' || !this.buffer) return;
      const samples = this.buffer.slice(0, this.size);
      this.buffer = undefined;
      this.port.postMessage(samples, [samples.buffer]);
    };
  }
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (this.buffer && channel?.length && this.size < this.buffer.length) {
      const count = Math.min(channel.length, this.buffer.length - this.size);
      this.buffer.set(channel.subarray(0, count), this.size);
      this.size += count;
      if (this.size === this.buffer.length) this.port.postMessage('limit');
    }
    return !!this.buffer;
  }
}
registerProcessor('pet-microphone', PetMicrophone);
