
export enum AppState {
  IDLE = 'IDLE',
  PREPARING = 'PREPARING',
  READY = 'READY',
  CONNECTING = 'CONNECTING',
  CONVERSING = 'CONVERSING',
  ERROR = 'ERROR'
}

export enum InteractionMode {
  VOICE = 'VOICE',
  CHAT = 'CHAT'
}

export interface WebsiteData {
  url: string;
  name: string;
  description: string;
  tone: string;
  keyFacts: string[];
}

export interface TranscriptionEntry {
  text: string;
  type: 'user' | 'model';
}
