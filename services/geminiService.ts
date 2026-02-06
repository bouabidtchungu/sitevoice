
import { GoogleGenAI, LiveServerMessage, Modality, Blob } from '@google/genai';

export class VoiceSessionManager {
  private ai: any;
  private session: any;
  private audioContext: AudioContext | null = null;
  private inputContext: AudioContext | null = null;
  private nextStartTime = 0;
  private sources = new Set<AudioBufferSourceNode>();
  private stream: MediaStream | null = null;
  private onMessageCallback: (message: LiveServerMessage) => void;
  private onErrorCallback: (error: any) => void;
  private apiKey: string;

  constructor(
    apiKey: string,
    onMessage: (message: LiveServerMessage) => void,
    onError: (error: any) => void
  ) {
    this.apiKey = apiKey;
    this.onMessageCallback = onMessage;
    this.onErrorCallback = onError;
  }

  async connect(systemInstruction: string) {
    try {
      // Re-initialize AI client right before use
      this.ai = new GoogleGenAI({ apiKey: this.apiKey });
      
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.inputContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });

      const sessionPromise = this.ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        callbacks: {
          onopen: () => {
            this.setupMicrophone(sessionPromise);
          },
          onmessage: async (message: LiveServerMessage) => {
            await this.handleServerMessage(message);
            this.onMessageCallback(message);
          },
          onerror: (e: any) => {
            console.error('Gemini Live Error:', e);
            this.onErrorCallback(e);
          },
          onclose: (e: any) => {
            console.log('Gemini Live Closed:', e);
          },
        },
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } },
          },
          systemInstruction,
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        },
      });

      this.session = await sessionPromise;
      return this.session;
    } catch (error) {
      this.onErrorCallback(error);
      throw error;
    }
  }

  private setupMicrophone(sessionPromise: Promise<any>) {
    if (!this.inputContext || !this.stream) return;

    const source = this.inputContext.createMediaStreamSource(this.stream);
    const scriptProcessor = this.inputContext.createScriptProcessor(4096, 1, 1);

    scriptProcessor.onaudioprocess = (event) => {
      const inputData = event.inputBuffer.getChannelData(0);
      const pcmBlob = this.createBlob(inputData);
      
      sessionPromise.then((session) => {
        session.sendRealtimeInput({ media: pcmBlob });
      });
    };

    source.connect(scriptProcessor);
    scriptProcessor.connect(this.inputContext.destination);
  }

  private async handleServerMessage(message: LiveServerMessage) {
    const base64Audio = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
    if (base64Audio && this.audioContext) {
      this.nextStartTime = Math.max(this.nextStartTime, this.audioContext.currentTime);
      const audioBuffer = await this.decodeAudioData(
        this.decode(base64Audio),
        this.audioContext,
        24000,
        1
      );

      const source = this.audioContext.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(this.audioContext.destination);
      source.addEventListener('ended', () => {
        this.sources.delete(source);
      });

      source.start(this.nextStartTime);
      this.nextStartTime += audioBuffer.duration;
      this.sources.add(source);
    }

    if (message.serverContent?.interrupted) {
      this.stopAllAudio();
    }
  }

  private stopAllAudio() {
    this.sources.forEach((s) => {
      try { s.stop(); } catch (e) {}
    });
    this.sources.clear();
    this.nextStartTime = 0;
  }

  private createBlob(data: Float32Array): Blob {
    const l = data.length;
    const int16 = new Int16Array(l);
    for (let i = 0; i < l; i++) {
      int16[i] = data[i] * 32768;
    }
    return {
      data: this.encode(new Uint8Array(int16.buffer)),
      mimeType: 'audio/pcm;rate=16000',
    };
  }

  private decode(base64: string) {
    const binaryString = atob(base64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes;
  }

  private encode(bytes: Uint8Array) {
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  private async decodeAudioData(data: Uint8Array, ctx: AudioContext, sampleRate: number, numChannels: number): Promise<AudioBuffer> {
    const dataInt16 = new Int16Array(data.buffer);
    const frameCount = dataInt16.length / numChannels;
    const buffer = ctx.createBuffer(numChannels, frameCount, sampleRate);

    for (let channel = 0; channel < numChannels; channel++) {
      const channelData = buffer.getChannelData(channel);
      for (let i = 0; i < frameCount; i++) {
        channelData[i] = dataInt16[i * numChannels + channel] / 32768.0;
      }
    }
    return buffer;
  }

  disconnect() {
    this.stopAllAudio();
    if (this.stream) {
      this.stream.getTracks().forEach(track => track.stop());
    }
    if (this.inputContext && this.inputContext.state !== 'closed') this.inputContext.close();
    if (this.audioContext && this.audioContext.state !== 'closed') this.audioContext.close();
  }
}
